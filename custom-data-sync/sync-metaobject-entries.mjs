#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient, isRestrictedMetaobjectType } from './lib/shopify-client.mjs';
import { parseMetaobjectTypes } from './lib/definition-filters.mjs';
import {
  createFileCopyCache,
  ensureFileOnTarget,
  fileSourceUrl,
  isFileNode,
  loadFileNodes,
  parseFileGids,
} from './lib/copy-file.mjs';

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
function readFlag(flag) {
  const index = rawArgs.indexOf(flag);
  if (index < 0) return '';
  return String(rawArgs[index + 1] || '').trim();
}
const selectedTypes = parseMetaobjectTypes(readFlag('--types'));
const __dirname = dirname(fileURLToPath(import.meta.url));
const reportPath = readFlag('--report') || join(__dirname, 'reports', `entries-${Date.now()}.json`);

const LIST_DEFINITIONS = `
  query MetaobjectTypes($cursor: String) {
    metaobjectDefinitions(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { type name }
    }
  }
`;

const FILE_OR_METAOBJECT_REF = `
  __typename
  ... on Metaobject { id type handle }
  ... on MediaImage {
    id
    alt
    image { url }
  }
  ... on GenericFile {
    id
    alt
    url
    mimeType
  }
  ... on Video {
    id
    alt
    filename
    originalSource { url }
    sources { url mimeType }
    preview { image { url } }
  }
  ... on Model3d {
    id
    alt
    filename
    originalSource { url }
    preview { image { url } }
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
            ${FILE_OR_METAOBJECT_REF}
          }
          references(first: 250) {
            nodes {
              ${FILE_OR_METAOBJECT_REF}
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

function isFileReferenceType(type) {
  const normalized = String(type || '').toLowerCase();
  return normalized === 'file_reference' || normalized === 'list.file_reference';
}

function fieldFileGids(field) {
  const fromRefs = isListReference(field.type)
    ? (field.references?.nodes || []).filter(isFileNode).map((ref) => ref.id)
    : isFileNode(field.reference)
      ? [field.reference.id]
      : [];
  if (fromRefs.filter(Boolean).length) return fromRefs.filter(Boolean);
  return parseFileGids(field.value);
}

function collectFileGids(entries) {
  const ids = new Set();
  for (const entry of entries) {
    for (const field of entry.fields || []) {
      if (!isFileReferenceType(field.type)) continue;
      for (const id of fieldFileGids(field)) ids.add(id);
    }
  }
  return [...ids];
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

function buildFields(sourceEntry, targetEntry, targetByHandle, fileIdMap) {
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

    if (isFileReferenceType(field.type)) {
      const sourceIds = fieldFileGids(field);
      const emptyValue = !field.value || field.value === '[]';
      if (!sourceIds.length && emptyValue) {
        fields.push({
          key: field.key,
          value: isListReference(field.type) ? '[]' : '',
        });
        continue;
      }
      const ids = sourceIds.map((id) => fileIdMap.get(id)).filter(Boolean);
      if (sourceIds.length && ids.length === sourceIds.length) {
        fields.push({
          key: field.key,
          value: isListReference(field.type) ? JSON.stringify(ids) : ids[0],
        });
        continue;
      }
    } else if (isListReference(field.type)) {
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

function writeEntriesReport({ skipped, results }) {
  const failedItems = results.filter((item) => !item.ok);
  const report = {
    kind: 'metaobject-entries',
    dryRun,
    finishedAt: new Date().toISOString(),
    sourceCount: results.length + skipped.length,
    skipped: skipped.map((item) => ({
      type: item.type,
      handle: item.handle || '*',
      name: item.name || item.type,
      reason: item.reason || 'SKIPPED',
      message: item.message || '',
    })),
    failed: failedItems.map((item) => ({
      type: item.type,
      handle: item.handle,
      name: `${item.type}/${item.handle}`,
      reason: 'FAILED',
      message: item.error || '',
    })),
    succeeded: results.filter((item) => item.ok).map((item) => ({
      type: item.type,
      handle: item.handle,
      action: item.action,
    })),
  };

  try {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nReport written to ${reportPath}`);
  } catch (error) {
    console.warn(`WARN: failed to write entries report: ${error.message}`);
  }
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
  const skipped = [];
  for (const type of types) {
    if (isRestrictedMetaobjectType(type)) {
      console.log(`[skip] Restricted/app-owned type: ${type}`);
      skipped.push({
        type,
        handle: '*',
        name: type,
        reason: 'APP_OWNED_OR_RESERVED',
        message: 'Shopify / App-owned metaobject types are skipped.',
      });
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

  const fileGids = collectFileGids(sourceEntries);
  const sourceFiles = await loadFileNodes(sourceClient, fileGids);
  const fileIdMap = new Map();
  const fileCache = createFileCopyCache();
  console.log(`[files] ${fileGids.length} unique file reference(s), loaded ${sourceFiles.length}`);

  const loadedById = new Map(sourceFiles.map((ref) => [ref.id, ref]));
  for (const sourceId of fileGids) {
    const ref = loadedById.get(sourceId);
    const label = ref?.filename || fileSourceUrl(ref) || sourceId;
    if (!ref) {
      console.warn(`[files] missing on source: ${sourceId}`);
      continue;
    }
    try {
      const targetId = await ensureFileOnTarget(targetClient, ref, { dryRun, cache: fileCache });
      fileIdMap.set(sourceId, targetId);
      console.log(`[files] ${dryRun ? 'would copy' : 'ready'} ${label}`);
    } catch (error) {
      console.warn(`[files] failed ${label}: ${error.message}`);
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
      const built = buildFields(sourceEntry, existing, targetByHandle, fileIdMap);
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
  writeEntriesReport({ skipped, results });
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Metaobject entry sync failed: ${error.message}`);
  process.exitCode = 1;
});
