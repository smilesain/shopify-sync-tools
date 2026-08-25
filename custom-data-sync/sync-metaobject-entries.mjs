#!/usr/bin/env node

import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient, isRestrictedMetaobjectType } from './lib/shopify-client.mjs';
import { parseMetaobjectTypes } from './lib/definition-filters.mjs';

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const typesArgIndex = rawArgs.indexOf('--types');
const selectedTypes =
  typesArgIndex >= 0 ? parseMetaobjectTypes(rawArgs[typesArgIndex + 1] || '') : [];

const LIST_DEFINITIONS = `
  query MetaobjectTypes($cursor: String) {
    metaobjectDefinitions(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { type name }
    }
  }
`;

const LIST_ENTRIES = `
  query MetaobjectEntries($type: String!, $cursor: String) {
    metaobjects(type: $type, first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        type
        fields {
          key
          type
          value
          reference {
            ... on Metaobject { id type handle }
          }
          references(first: 250) {
            nodes {
              ... on Metaobject { id type handle }
            }
          }
        }
      }
    }
  }
`;

const UPSERT_METAOBJECT = `
  mutation UpsertMetaobject(
    $handle: MetaobjectHandleInput!
    $metaobject: MetaobjectUpsertInput!
  ) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle type }
      userErrors { field message code }
    }
  }
`;

function entryKey(type, handle) {
  return `${String(type).trim().toLowerCase()}:${String(handle).trim().toLowerCase()}`;
}

function isReferenceType(type) {
  return /reference/i.test(type || '');
}

function isListReference(type) {
  return /^list\./i.test(type || '');
}

async function listTypes(client) {
  const definitions = await client.paginate(
    'metaobjectDefinitions',
    LIST_DEFINITIONS,
    {},
    (data) => data.metaobjectDefinitions,
  );
  return definitions
    .map((definition) => definition.type)
    .filter((type) => !isRestrictedMetaobjectType(type));
}

async function listEntries(client, type) {
  return client.paginate(
    `metaobjects.${type}`,
    LIST_ENTRIES,
    { type },
    (data) => data.metaobjects,
  );
}

function buildFields(sourceEntry, targetEntry, targetByHandle) {
  const targetFields = new Map(
    (targetEntry?.fields || []).map((field) => [field.key, field.value]),
  );
  const fields = [];
  const unresolved = [];
  const preserved = [];

  for (const field of sourceEntry.fields || []) {
    if (!isReferenceType(field.type)) {
      fields.push({ key: field.key, value: field.value ?? '' });
      continue;
    }

    if (isListReference(field.type)) {
      const refs = field.references?.nodes || [];
      if (!refs.length && (!field.value || field.value === '[]')) {
        fields.push({ key: field.key, value: '[]' });
        continue;
      }
      const ids = refs
        .map((ref) => targetByHandle.get(entryKey(ref.type, ref.handle))?.id)
        .filter(Boolean);
      if (refs.length && ids.length === refs.length) {
        fields.push({ key: field.key, value: JSON.stringify(ids) });
        continue;
      }
    } else if (field.reference?.type && field.reference?.handle) {
      const target = targetByHandle.get(
        entryKey(field.reference.type, field.reference.handle),
      );
      if (target?.id) {
        fields.push({ key: field.key, value: target.id });
        continue;
      }
    }

    if (targetFields.has(field.key)) {
      fields.push({ key: field.key, value: targetFields.get(field.key) });
      preserved.push(field.key);
    } else {
      unresolved.push(field.key);
    }
  }

  return { fields, unresolved, preserved };
}

async function upsertEntry(targetClient, sourceEntry, fields) {
  if (dryRun) {
    return {
      id: `gid://shopify/Metaobject/DRY_RUN/${sourceEntry.type}/${sourceEntry.handle}`,
      type: sourceEntry.type,
      handle: sourceEntry.handle,
    };
  }
  const payload = await targetClient.query(
    UPSERT_METAOBJECT,
    {
      handle: { type: sourceEntry.type, handle: sourceEntry.handle },
      metaobject: { fields },
    },
    { isMutation: true, allowErrors: true },
  );
  const result = payload.data?.metaobjectUpsert;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }
  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join('; '));
  }
  return result.metaobject;
}

async function main() {
  const config = loadConfig();
  const [sourceToken, targetToken] = await Promise.all([
    resolveStoreAccessToken(config.source),
    resolveStoreAccessToken(config.target),
  ]);
  const sourceClient = new ShopifyClient({
    shop: config.source.shop,
    accessToken: sourceToken,
    apiVersion: config.apiVersion,
    mutationDelayMs: config.mutationDelayMs,
  });
  const targetClient = new ShopifyClient({
    shop: config.target.shop,
    accessToken: targetToken,
    apiVersion: config.apiVersion,
    mutationDelayMs: config.mutationDelayMs,
  });

  const types = selectedTypes.length ? selectedTypes : await listTypes(sourceClient);
  console.log(`Metaobject entry types: ${types.join(', ') || '(none)'}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  const sourceEntries = [];
  const targetByHandle = new Map();
  for (const type of types) {
    if (isRestrictedMetaobjectType(type)) {
      console.log(`[skip] Restricted/app-owned type: ${type}`);
      continue;
    }
    const [source, target] = await Promise.all([
      listEntries(sourceClient, type),
      listEntries(targetClient, type),
    ]);
    console.log(`[${type}] source=${source.length}, target=${target.length}`);
    sourceEntries.push(...source);
    for (const entry of target) {
      targetByHandle.set(entryKey(entry.type, entry.handle), entry);
    }
  }

  let pending = [...sourceEntries];
  const results = [];
  while (pending.length) {
    const deferred = [];
    let progress = 0;

    for (const sourceEntry of pending) {
      const key = entryKey(sourceEntry.type, sourceEntry.handle);
      const existing = targetByHandle.get(key);
      const built = buildFields(sourceEntry, existing, targetByHandle);
      if (built.unresolved.length) {
        deferred.push({ sourceEntry, unresolved: built.unresolved });
        continue;
      }
      try {
        const target = await upsertEntry(targetClient, sourceEntry, built.fields);
        targetByHandle.set(key, {
          ...target,
          fields: built.fields,
        });
        results.push({
          type: sourceEntry.type,
          handle: sourceEntry.handle,
          ok: true,
          action: existing ? 'update' : 'create',
          preservedReferences: built.preserved,
        });
        progress += 1;
        console.log(
          `[ok] ${sourceEntry.type}/${sourceEntry.handle} (${existing ? 'update' : 'create'})`,
        );
      } catch (error) {
        results.push({
          type: sourceEntry.type,
          handle: sourceEntry.handle,
          ok: false,
          error: error.message,
        });
        console.log(`[failed] ${sourceEntry.type}/${sourceEntry.handle}: ${error.message}`);
      }
    }

    if (!deferred.length) break;
    if (!progress) {
      for (const item of deferred) {
        results.push({
          type: item.sourceEntry.type,
          handle: item.sourceEntry.handle,
          ok: false,
          error: `Unresolved reference fields: ${item.unresolved.join(', ')}`,
        });
        console.log(
          `[failed] ${item.sourceEntry.type}/${item.sourceEntry.handle}: unresolved ${item.unresolved.join(', ')}`,
        );
      }
      break;
    }
    pending = deferred.map((item) => item.sourceEntry);
  }

  const succeeded = results.filter((item) => item.ok).length;
  const failed = results.length - succeeded;
  console.log(`Done. ${succeeded} succeeded, ${failed} failed (of ${results.length}).`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Metaobject entry sync failed: ${error.message}`);
  process.exitCode = 1;
});
