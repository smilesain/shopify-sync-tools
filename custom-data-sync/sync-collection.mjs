#!/usr/bin/env node
/**
 * Sync a Collection from source → target by handle.
 * Syncs metadata, smart rules (if any), image, SEO, metafields,
 * and remaps manual product membership by product handle when possible.
 *
 * Usage:
 *   node sync-collection.mjs [collection-handle] [--dry-run]
 *   node sync-collection.mjs robot-vacuums --dry-run
 *   node sync-collection.mjs --all [--dry-run]
 *
 * Default handle: robot-vacuums
 *
 * Requires: read_products on source; read_products + write_products on target
 * (and usually publication scopes to make collection visible on Online Store).
 */

import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient, isRestrictedNamespace } from './lib/shopify-client.mjs';

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const syncAll = rawArgs.includes('--all');
const args = rawArgs.filter((arg) => arg !== '--dry-run' && arg !== '--all');
const COLLECTION_HANDLE = (args[0] || 'robot-vacuums').trim().replace(/^\/+|\/+$/g, '');

const COLLECTION_FIELDS = `
  id
  handle
  title
  descriptionHtml
  sortOrder
  templateSuffix
  seo {
    title
    description
  }
  image {
    altText
    url
  }
  ruleSet {
    appliedDisjunctively
    rules {
      column
      relation
      condition
    }
  }
  products(first: 100) {
    nodes {
      id
      handle
    }
  }
  metafields(first: 50) {
    nodes {
      namespace
      key
      type
      value
    }
  }
`;

const FIND_COLLECTION = `
  query FindCollection($handle: String!) {
    collectionByHandle(handle: $handle) {
      ${COLLECTION_FIELDS}
    }
  }
`;

const LIST_COLLECTIONS = `
  query ListCollections($cursor: String) {
    collections(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ${COLLECTION_FIELDS}
      }
    }
  }
`;

const COLLECTION_CREATE = `
  mutation CollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id handle title }
      userErrors { field message }
    }
  }
`;

const COLLECTION_UPDATE = `
  mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id handle title }
      userErrors { field message }
    }
  }
`;

const COLLECTION_ADD_PRODUCTS = `
  mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id }
      userErrors { field message }
    }
  }
`;

const FIND_PRODUCT = `
  query ProductByHandle($handle: String!) {
    productByHandle(handle: $handle) { id handle }
  }
`;

const PUBLICATIONS = `
  query Publications {
    publications(first: 20) {
      nodes { id name }
    }
  }
`;

const PUBLISH = `
  mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

const SET_METAFIELDS = `
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors { field message code }
    }
  }
`;

function log(message) {
  console.log(message);
}

function shouldSyncMetafield(mf) {
  if (!mf?.namespace || !mf?.key) return false;
  const ns = mf.namespace.trim();
  if (isRestrictedNamespace(ns)) return false;
  if (ns.startsWith('judgeme') || ns.startsWith('mc-facebook') || ns.startsWith('reviews')) {
    return false;
  }
  return true;
}

async function findCollectionByHandle(client, handle) {
  const payload = await client.query(FIND_COLLECTION, { handle });
  return payload.data?.collectionByHandle || null;
}

async function listAllSourceCollections(sourceClient) {
  const collections = [];
  let cursor = null;
  let page = 0;

  do {
    page += 1;
    const payload = await sourceClient.query(LIST_COLLECTIONS, { cursor });
    const connection = payload.data?.collections;
    const nodes = connection?.nodes || [];
    collections.push(...nodes);
    log(`[list] Page ${page}: +${nodes.length} (total ${collections.length})`);
    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  return collections;
}

function buildCollectionInput(source, { id = null } = {}) {
  const input = {
    title: source.title,
    handle: source.handle,
    descriptionHtml: source.descriptionHtml || '',
    sortOrder: source.sortOrder || undefined,
    templateSuffix: source.templateSuffix || null,
  };

  if (id) input.id = id;

  if (source.seo && (source.seo.title || source.seo.description)) {
    input.seo = {
      title: source.seo.title || null,
      description: source.seo.description || null,
    };
  }

  if (source.image?.url) {
    input.image = {
      src: source.image.url,
      altText: source.image.altText || source.title || '',
    };
  }

  const rules = source.ruleSet?.rules || [];
  if (rules.length) {
    input.ruleSet = {
      appliedDisjunctively: Boolean(source.ruleSet.appliedDisjunctively),
      rules: rules.map((rule) => ({
        column: rule.column,
        relation: rule.relation,
        condition: rule.condition,
      })),
    };
  }

  return input;
}

async function syncMetafields(targetClient, ownerId, metafields) {
  const inputs = (metafields || [])
    .filter(shouldSyncMetafield)
    .map((mf) => ({
      ownerId,
      namespace: mf.namespace.trim(),
      key: mf.key.trim(),
      type: mf.type,
      value: mf.value ?? '',
    }));

  if (!inputs.length) {
    log('[metafields] No syncable metafields');
    return;
  }

  if (dryRun) {
    log(`[dry-run] Would set ${inputs.length} metafield(s)`);
    inputs.forEach((mf) => log(`  - ${mf.namespace}.${mf.key} (${mf.type})`));
    return;
  }

  const payload = await targetClient.query(
    SET_METAFIELDS,
    { metafields: inputs },
    { isMutation: true, allowErrors: true },
  );
  const result = payload.data?.metafieldsSet;
  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join('; '));
  }
  log(`[metafields] Set ${result?.metafields?.length || 0} metafield(s)`);
}

async function resolveTargetProductIds(targetClient, sourceProducts) {
  const mapped = [];
  const missing = [];

  for (const product of sourceProducts || []) {
    const payload = await targetClient.query(FIND_PRODUCT, { handle: product.handle });
    const target = payload.data?.productByHandle;
    if (target?.id) mapped.push({ handle: product.handle, id: target.id });
    else missing.push(product.handle);
  }

  return { mapped, missing };
}

async function syncManualProducts(targetClient, collectionId, sourceProducts) {
  if (!sourceProducts?.length) {
    log('[products] No source products to map');
    return;
  }

  const { mapped, missing } = await resolveTargetProductIds(targetClient, sourceProducts);
  log(`[products] Mapped ${mapped.length}/${sourceProducts.length} by handle`);
  if (missing.length) {
    log(`[products] Missing on target (${missing.length}): ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}`);
  }

  if (!mapped.length) return;

  if (dryRun) {
    log(`[dry-run] Would add ${mapped.length} product(s) to collection`);
    return;
  }

  // batch in chunks of 50
  for (let i = 0; i < mapped.length; i += 50) {
    const chunk = mapped.slice(i, i + 50).map((item) => item.id);
    const payload = await targetClient.query(
      COLLECTION_ADD_PRODUCTS,
      { id: collectionId, productIds: chunk },
      { isMutation: true, allowErrors: true },
    );
    const result = payload.data?.collectionAddProducts;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
  }
  log(`[products] Added ${mapped.length} product(s)`);
}

async function publishToOnlineStore(targetClient, collectionId) {
  try {
    const payload = await targetClient.query(PUBLICATIONS);
    const pubs = payload.data?.publications?.nodes || [];
    const online =
      pubs.find((p) => /online store/i.test(p.name || '')) ||
      pubs.find((p) => /online/i.test(p.name || '')) ||
      pubs[0];

    if (!online) {
      log('[publish] No publication found; skip publish');
      return;
    }

    if (dryRun) {
      log(`[dry-run] Would publish collection to "${online.name}" (${online.id})`);
      return;
    }

    const publishPayload = await targetClient.query(
      PUBLISH,
      { id: collectionId, input: [{ publicationId: online.id }] },
      { isMutation: true, allowErrors: true },
    );
    const result = publishPayload.data?.publishablePublish;
    if (result?.userErrors?.length) {
      log(`[publish] Warning: ${result.userErrors.map((e) => e.message).join('; ')}`);
      return;
    }
    log(`[publish] Published to ${online.name}`);
  } catch (err) {
    const msg = err?.message || String(err);
    if (/access denied|read_publications|write_publications/i.test(msg)) {
      log(`[publish] Skipped (missing publication scopes): ${msg}`);
      return;
    }
    throw err;
  }
}

async function syncOneCollection(sourceClient, targetClient, source) {
  const handle = source.handle;
  const rules = source.ruleSet?.rules || [];
  const products = source.products?.nodes || [];
  const isSmart = rules.length > 0;

  log(
    `Source collection: "${source.title}" (${handle}) type=${isSmart ? 'smart' : 'manual'} products=${products.length} rules=${rules.length} descChars=${(source.descriptionHtml || '').length}`,
  );

  const existing = await findCollectionByHandle(targetClient, handle);

  if (dryRun) {
    log(`[dry-run] Would ${existing ? 'update' : 'create'} collection on target`);
    log(`[dry-run] title=${source.title}`);
    log(`[dry-run] handle=${handle}`);
    log(`[dry-run] sortOrder=${source.sortOrder || '(default)'}`);
    log(`[dry-run] templateSuffix=${source.templateSuffix || '(default)'}`);
    log(`[dry-run] image=${source.image?.url ? 'yes' : 'no'}`);
    if (isSmart) {
      log(`[dry-run] smart rules=${rules.length} appliedDisjunctively=${source.ruleSet.appliedDisjunctively}`);
    } else {
      await syncManualProducts(targetClient, existing?.id || 'gid://shopify/Collection/DRY_RUN', products);
    }
    await syncMetafields(targetClient, existing?.id || 'gid://shopify/Collection/DRY_RUN', source.metafields?.nodes || []);
    await publishToOnlineStore(targetClient, existing?.id || 'gid://shopify/Collection/DRY_RUN');
    return { handle, action: existing ? 'update' : 'create', ok: true };
  }

  let targetId;

  if (existing) {
    log(`Updating existing target collection: ${handle}`);
    const payload = await targetClient.query(
      COLLECTION_UPDATE,
      { input: buildCollectionInput(source, { id: existing.id }) },
      { isMutation: true, allowErrors: true },
    );
    const result = payload.data?.collectionUpdate;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    targetId = result.collection.id;
    log(`Updated collection: ${result.collection.handle} (${result.collection.id})`);
  } else {
    log(`Creating target collection: ${handle}`);
    const payload = await targetClient.query(
      COLLECTION_CREATE,
      { input: buildCollectionInput(source) },
      { isMutation: true, allowErrors: true },
    );
    const result = payload.data?.collectionCreate;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    targetId = result.collection.id;
    log(`Created collection: ${result.collection.handle} (${result.collection.id})`);
  }

  if (!isSmart) {
    await syncManualProducts(targetClient, targetId, products);
  }

  await syncMetafields(targetClient, targetId, source.metafields?.nodes || []);
  await publishToOnlineStore(targetClient, targetId);

  log(`Storefront: https://${targetClient.shop}/collections/${handle}`);
  return { handle, action: existing ? 'update' : 'create', ok: true };
}

async function main() {
  if (!syncAll && !COLLECTION_HANDLE) {
    throw new Error('Collection handle is required (or pass --all)');
  }

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

  log(syncAll ? 'Collection sync: ALL collections' : `Collection sync: ${COLLECTION_HANDLE}`);
  log(`Source: ${config.source.shop}`);
  log(`Target: ${config.target.shop}`);
  log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  let sourceCollections;
  if (syncAll) {
    log('Listing all source collections…');
    sourceCollections = await listAllSourceCollections(sourceClient);
    if (!sourceCollections.length) {
      log('No collections found on source. Nothing to sync.');
      return;
    }
    log(`Found ${sourceCollections.length} collection(s) to sync.`);
  } else {
    const source = await findCollectionByHandle(sourceClient, COLLECTION_HANDLE);
    if (!source) {
      throw new Error(`Source collection not found for handle: ${COLLECTION_HANDLE}`);
    }
    sourceCollections = [source];
  }

  const results = [];
  for (let i = 0; i < sourceCollections.length; i += 1) {
    const collection = sourceCollections[i];
    log(`\n[${i + 1}/${sourceCollections.length}]`);
    try {
      const result = await syncOneCollection(sourceClient, targetClient, collection);
      results.push(result);
    } catch (error) {
      const message = error?.message || String(error);
      log(`FAILED ${collection.handle}: ${message}`);
      results.push({ handle: collection.handle, ok: false, error: message });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  log(`\nDone. ${okCount} succeeded, ${failCount} failed (of ${results.length}).`);
  log(`Admin: https://${config.target.shop}/admin/collections`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nCollection sync failed: ${error.message}`);
  process.exitCode = 1;
});
