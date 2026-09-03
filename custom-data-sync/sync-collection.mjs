#!/usr/bin/env node
/**
 * Sync a Collection from source → target by handle.
 * Syncs metadata, smart rules (if any), image, SEO, metafields,
 * and remaps manual product membership by product handle when possible.
 *
 * Usage:
 *   node sync-collection.mjs [handle] [--dry-run]
 *   node sync-collection.mjs robot-vacuums accessories --dry-run
 *   node sync-collection.mjs --all [--dry-run]
 *
 * Default handle (no args): robot-vacuums
 *
 * Requires: read_products on source; read_products + write_products on target
 * (and usually publication scopes to make collection visible on Online Store).
 */

import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient, isRestrictedNamespace } from './lib/shopify-client.mjs';
import { parseHandles } from './lib/definition-filters.mjs';

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const syncAll = rawArgs.includes('--all');
const args = rawArgs.filter((arg) => arg !== '--dry-run' && arg !== '--all');
const parsedHandles = parseHandles(args);
const COLLECTION_HANDLES = parsedHandles.length ? parsedHandles : syncAll ? [] : ['robot-vacuums'];

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
  products(first: 250) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      handle
    }
  }
  metafields(first: 250) {
    pageInfo { hasNextPage endCursor }
    nodes {
      namespace
      key
      type
      value
    }
  }
`;

const COLLECTION_PRODUCTS_PAGE = `
  query CollectionProductsPage($id: ID!, $cursor: String) {
    collection(id: $id) {
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id handle }
      }
    }
  }
`;

const COLLECTION_METAFIELDS_PAGE = `
  query CollectionMetafieldsPage($id: ID!, $cursor: String) {
    collection(id: $id) {
      metafields(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { namespace key type value }
      }
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

const LIST_PRODUCT_INDEX = `
  query ProductIndex($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle }
    }
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

async function loadCompleteConnection(client, collectionId, initial, document, pickConnection) {
  const nodes = [...(initial?.nodes || [])];
  let cursor = initial?.pageInfo?.hasNextPage ? initial.pageInfo.endCursor : null;

  while (cursor) {
    const payload = await client.query(document, { id: collectionId, cursor });
    const connection = pickConnection(payload.data?.collection);
    if (!connection) break;
    nodes.push(...(connection.nodes || []));
    cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  }

  return nodes;
}

async function hydrateCollectionConnections(client, collection) {
  const [products, metafields] = await Promise.all([
    loadCompleteConnection(
      client,
      collection.id,
      collection.products,
      COLLECTION_PRODUCTS_PAGE,
      (item) => item?.products,
    ),
    loadCompleteConnection(
      client,
      collection.id,
      collection.metafields,
      COLLECTION_METAFIELDS_PAGE,
      (item) => item?.metafields,
    ),
  ]);
  collection.products.nodes = products;
  collection.metafields.nodes = metafields;
  return collection;
}

async function buildTargetProductIndex(targetClient) {
  const products = await targetClient.paginate(
    'products',
    LIST_PRODUCT_INDEX,
    {},
    (data) => data.products,
  );
  return new Map(products.map((product) => [product.handle, product.id]));
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

  for (const collection of collections) {
    await hydrateCollectionConnections(sourceClient, collection);
  }
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

  let setCount = 0;
  for (let index = 0; index < inputs.length; index += 25) {
    const chunk = inputs.slice(index, index + 25);
    const payload = await targetClient.query(
      SET_METAFIELDS,
      { metafields: chunk },
      { isMutation: true, allowErrors: true },
    );
    const result = payload.data?.metafieldsSet;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    setCount += result?.metafields?.length || 0;
  }
  log(`[metafields] Set ${setCount} metafield(s)`);
}

function resolveTargetProductIds(productIndex, sourceProducts) {
  const mapped = [];
  const missing = [];

  for (const product of sourceProducts || []) {
    const targetId = productIndex.get(product.handle);
    if (targetId) mapped.push({ handle: product.handle, id: targetId });
    else missing.push(product.handle);
  }

  return { mapped, missing };
}

async function syncManualProducts(targetClient, collectionId, sourceProducts, productIndex) {
  if (!sourceProducts?.length) {
    log('[products] No source products to map');
    return;
  }

  const { mapped, missing } = resolveTargetProductIds(productIndex, sourceProducts);
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

async function resolveOnlineStorePublication(targetClient) {
  try {
    const payload = await targetClient.query(PUBLICATIONS);
    const pubs = payload.data?.publications?.nodes || [];
    return (
      pubs.find((p) => /online store/i.test(p.name || '')) ||
      pubs.find((p) => /online/i.test(p.name || '')) ||
      pubs[0] ||
      null
    );
  } catch (err) {
    const msg = err?.message || String(err);
    if (/access denied|read_publications|write_publications/i.test(msg)) {
      log(`[publish] Disabled (missing publication scopes): ${msg}`);
      return null;
    }
    throw err;
  }
}

async function publishToOnlineStore(targetClient, collectionId, online) {
  if (!online) {
    log('[publish] No publication available; skip publish');
    return;
  }
  try {
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

async function syncOneCollection(
  sourceClient,
  targetClient,
  source,
  productIndex,
  onlinePublication,
) {
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
      await syncManualProducts(
        targetClient,
        existing?.id || 'gid://shopify/Collection/DRY_RUN',
        products,
        productIndex,
      );
    }
    await syncMetafields(targetClient, existing?.id || 'gid://shopify/Collection/DRY_RUN', source.metafields?.nodes || []);
    await publishToOnlineStore(
      targetClient,
      existing?.id || 'gid://shopify/Collection/DRY_RUN',
      onlinePublication,
    );
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
    await syncManualProducts(targetClient, targetId, products, productIndex);
  }

  await syncMetafields(targetClient, targetId, source.metafields?.nodes || []);
  await publishToOnlineStore(targetClient, targetId, onlinePublication);

  log(`Storefront: https://${targetClient.shop}/collections/${handle}`);
  return { handle, action: existing ? 'update' : 'create', ok: true };
}

async function main() {
  if (!syncAll && !COLLECTION_HANDLES.length) {
    throw new Error('At least one collection handle is required (or pass --all)');
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

  log('Loading target product index…');
  const [productIndex, onlinePublication] = await Promise.all([
    buildTargetProductIndex(targetClient),
    resolveOnlineStorePublication(targetClient),
  ]);
  log(`Target product index: ${productIndex.size}`);

  log(
    syncAll ? 'Collection sync: ALL collections' : `Collection sync: ${COLLECTION_HANDLES.join(', ')}`,
  );
  log(`Source: ${config.source.shop}`);
  log(`Target: ${config.target.shop}`);
  log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  const results = [];
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
    sourceCollections = [];
    for (const handle of COLLECTION_HANDLES) {
      let source = await findCollectionByHandle(sourceClient, handle);
      if (!source) {
        log(`FAILED ${handle}: Source collection not found`);
        results.push({ handle, ok: false, error: `Source collection not found for handle: ${handle}` });
        continue;
      }
      source = await hydrateCollectionConnections(sourceClient, source);
      sourceCollections.push(source);
    }
  }
  for (let i = 0; i < sourceCollections.length; i += 1) {
    const collection = sourceCollections[i];
    log(`\n[${i + 1}/${sourceCollections.length}]`);
    try {
      const result = await syncOneCollection(
        sourceClient,
        targetClient,
        collection,
        productIndex,
        onlinePublication,
      );
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
