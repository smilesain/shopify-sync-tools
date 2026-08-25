#!/usr/bin/env node
/**
 * Sync Product(s) from source → target.
 *
 * Usage:
 *   node sync-product.mjs [product-id] [--dry-run]
 *   node sync-product.mjs --all [--dry-run]
 */

import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient, isRestrictedNamespace } from './lib/shopify-client.mjs';

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const syncAll = rawArgs.includes('--all');
const args = rawArgs.filter((arg) => arg !== '--dry-run' && arg !== '--all');
const PRODUCT_ID = (args[0] || '7549570941137').trim().replace(/^gid:\/\/shopify\/Product\//i, '');

const FETCH_PRODUCT = `
  query FetchProduct($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      descriptionHtml
      vendor
      productType
      tags
      status
      templateSuffix
      category { id }
      seo { title description }
      options { name position values }
      media(first: 20) {
        nodes {
          ... on MediaImage {
            alt
            image { url }
          }
        }
      }
      variants(first: 100) {
        nodes {
          title
          sku
          barcode
          price
          compareAtPrice
          taxable
          inventoryPolicy
          selectedOptions { name value }
        }
      }
      metafields(first: 50) {
        nodes {
          namespace
          key
          type
          value
          reference {
            ... on Metaobject { handle type }
          }
        }
      }
    }
  }
`;

const LIST_PRODUCTS = `
  query ListProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        title
      }
    }
  }
`;

const FETCH_METAOBJECT = `
  query MetaobjectByHandle($type: String!, $handle: String!) {
    metaobjectByHandle(handle: { type: $type, handle: $handle }) {
      id
      handle
      type
      fields { key value type }
    }
  }
`;

const FIND_PRODUCT_BY_HANDLE = `
  query ProductByHandle($handle: String!) {
    productByHandle(handle: $handle) { id handle }
  }
`;

const FIND_TARGET_METAOBJECT = `
  query TargetMetaobject($type: String!, $handle: String!) {
    metaobjectByHandle(handle: { type: $type, handle: $handle }) {
      id
      handle
    }
    metaobjectDefinitionByType(type: $type) {
      fieldDefinitions { key type { name } }
    }
  }
`;

const CREATE_METAOBJECT = `
  mutation CreateMetaobject($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject { id handle type }
      userErrors { field message code }
    }
  }
`;

const PRODUCT_SET = `
  mutation ProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product { id handle title templateSuffix }
      userErrors { field message code }
    }
  }
`;

const CREATE_MEDIA = `
  mutation CreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id }
      mediaUserErrors { field message code }
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

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

function shouldSyncMetafield(mf) {
  if (isRestrictedNamespace(mf.namespace.trim())) return false;
  if (mf.namespace.startsWith('judgeme')) return false;
  if (mf.namespace.startsWith('mc-facebook')) return false;
  if (mf.namespace.startsWith('reviews')) return false;
  if (mf.namespace.trim() === 'custom ' && mf.key === 'after_description_content') return false;
  return mf.namespace.trim() === 'custom';
}

const METAOBJECT_FIELD_ALIASES = {
  compliance_profile: {
    category_name: 'model_number',
  },
};

function mapMetaobjectFields(sourceFields, targetFieldDefinitions, type) {
  const aliases = METAOBJECT_FIELD_ALIASES[type] || {};
  const targetKeys = new Set(targetFieldDefinitions.map((field) => field.key));
  const targetTypes = new Map(
    targetFieldDefinitions.map((field) => [field.key, field.type?.name]),
  );
  const mapped = [];

  for (const field of sourceFields) {
    if (field.value == null || field.value === '') continue;

    const targetKey = aliases[field.key] || field.key;
    if (!targetKeys.has(targetKey)) continue;

    const targetType = targetTypes.get(targetKey);
    if (
      targetType === 'file_reference' ||
      targetType === 'list.file_reference' ||
      field.type === 'list.file_reference' ||
      field.type === 'file_reference'
    ) {
      continue;
    }

    mapped.push({ key: targetKey, value: field.value });
  }

  return mapped;
}

async function ensureMetaobject(sourceClient, targetClient, { type, handle }) {
  const existing = await targetClient.query(FIND_TARGET_METAOBJECT, { type, handle });
  if (existing.data.metaobjectByHandle?.id) {
    log('metaobject', `Exists on target: ${type}/${handle}`);
    return existing.data.metaobjectByHandle.id;
  }

  const sourcePayload = await sourceClient.query(FETCH_METAOBJECT, { type, handle });
  const sourceMetaobject = sourcePayload.data.metaobjectByHandle;
  if (!sourceMetaobject) {
    throw new Error(`Source metaobject not found: ${type}/${handle}`);
  }

  const fields = mapMetaobjectFields(
    sourceMetaobject.fields,
    existing.data.metaobjectDefinitionByType?.fieldDefinitions || [],
    type,
  );

  if (dryRun) {
    log('metaobject', `[dry-run] Would create ${type}/${handle}`);
    return null;
  }

  const createPayload = await targetClient.query(
    CREATE_METAOBJECT,
    {
      metaobject: {
        type,
        handle,
        fields,
      },
    },
    { isMutation: true, allowErrors: true },
  );

  const result = createPayload.data.metaobjectCreate;
  if (result.userErrors?.length) {
    throw new Error(
      `Failed to create metaobject ${type}/${handle}: ${result.userErrors.map((e) => e.message).join('; ')}`,
    );
  }

  log('metaobject', `Created on target: ${type}/${handle}`);
  return result.metaobject.id;
}

function buildProductSetInput(product, existingProductId) {
  const input = {
    handle: product.handle,
    title: product.title,
    descriptionHtml: product.descriptionHtml,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    status: product.status,
    templateSuffix: product.templateSuffix || '',
    category: product.category?.id,
    seo: product.seo?.title || product.seo?.description ? product.seo : undefined,
    productOptions: product.options.map((option) => ({
      name: option.name,
      values: option.values.map((value) => ({ name: value })),
    })),
    variants: product.variants.nodes.map((item) => ({
      sku: item.sku,
      barcode: item.barcode,
      price: item.price,
      compareAtPrice: item.compareAtPrice,
      taxable: item.taxable,
      inventoryPolicy: item.inventoryPolicy,
      optionValues: item.selectedOptions.map((opt) => ({
        optionName: opt.name,
        name: opt.value,
      })),
    })),
  };

  if (existingProductId) {
    input.id = existingProductId;
  }

  return input;
}

function buildMetafieldInputs(productId, metafields, metaobjectIdMap) {
  return metafields
    .filter(shouldSyncMetafield)
    .map((mf) => {
      const namespace = mf.namespace.trim();
      const input = {
        ownerId: productId,
        namespace,
        key: mf.key,
        type: mf.type,
      };

      if (mf.type === 'metaobject_reference' && mf.reference) {
        const targetId = metaobjectIdMap.get(`${mf.reference.type}:${mf.reference.handle}`);
        if (!targetId) return null;
        input.value = targetId;
      } else {
        input.value = mf.value;
      }

      return input;
    })
    .filter(Boolean);
}

async function listAllSourceProducts(sourceClient) {
  const products = [];
  let cursor = null;
  let page = 0;

  do {
    page += 1;
    const payload = await sourceClient.query(LIST_PRODUCTS, { cursor });
    const connection = payload.data?.products;
    const nodes = connection?.nodes || [];
    products.push(...nodes);
    log('list', `Page ${page}: +${nodes.length} (total ${products.length})`);
    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  return products;
}

async function syncOneProduct(sourceClient, targetClient, productGid) {
  log('product', `Fetching source product ${productGid} from ${sourceClient.shop}`);
  const sourcePayload = await sourceClient.query(FETCH_PRODUCT, { id: productGid });
  const product = sourcePayload.data.product;
  if (!product) throw new Error(`Product not found: ${productGid}`);

  log('product', `Source: ${product.title} (${product.handle})`);

  const metaobjectRefs = product.metafields.nodes
    .filter((mf) => mf.type === 'metaobject_reference' && mf.reference)
    .map((mf) => mf.reference);

  const metaobjectIdMap = new Map();
  for (const ref of metaobjectRefs) {
    const targetId = await ensureMetaobject(sourceClient, targetClient, ref);
    if (targetId) metaobjectIdMap.set(`${ref.type}:${ref.handle}`, targetId);
  }

  const existingPayload = await targetClient.query(FIND_PRODUCT_BY_HANDLE, { handle: product.handle });
  const existingProduct = existingPayload.data.productByHandle;
  const productSetInput = buildProductSetInput(product, existingProduct?.id);

  if (dryRun) {
    log('product', `[dry-run] Would ${existingProduct ? 'update' : 'create'} product ${product.handle}`);
    log('product', `[dry-run] Images: ${product.media.nodes.length}`);
    log('product', `[dry-run] Metafields: ${buildMetafieldInputs('dry-run', product.metafields.nodes, metaobjectIdMap).length}`);
    return { handle: product.handle, action: existingProduct ? 'update' : 'create', ok: true };
  }

  log('product', `${existingProduct ? 'Updating' : 'Creating'} product on target...`);
  const setPayload = await targetClient.query(
    PRODUCT_SET,
    { input: productSetInput, synchronous: true },
    { isMutation: true, allowErrors: true },
  );
  const setResult = setPayload.data?.productSet;
  if (!setResult) {
    throw new Error(`productSet failed: ${JSON.stringify(setPayload.errors || setPayload)}`);
  }
  if (setResult.userErrors?.length) {
    throw new Error(setResult.userErrors.map((e) => e.message).join('; '));
  }

  const targetProductId = setResult.product.id;
  log('product', `${existingProduct ? 'Updated' : 'Created'}: ${setResult.product.title} (${setResult.product.handle})`);

  const media = product.media.nodes
    .filter((node) => node.image?.url)
    .map((node) => ({
      originalSource: node.image.url,
      alt: node.alt || product.title,
      mediaContentType: 'IMAGE',
    }));

  if (media.length) {
    log('media', `Uploading ${media.length} images...`);
    const mediaPayload = await targetClient.query(
      CREATE_MEDIA,
      { productId: targetProductId, media },
      { isMutation: true, allowErrors: true },
    );
    const mediaErrors = mediaPayload.data.productCreateMedia.mediaUserErrors || [];
    if (mediaErrors.length) {
      console.warn('[media] Warnings:', mediaErrors.map((e) => e.message).join('; '));
    }
  }

  const metafields = buildMetafieldInputs(
    targetProductId,
    product.metafields.nodes,
    metaobjectIdMap,
  );

  if (metafields.length) {
    log('metafields', `Setting ${metafields.length} metafields...`);
    const mfPayload = await targetClient.query(
      SET_METAFIELDS,
      { metafields },
      { isMutation: true, allowErrors: true },
    );
    const mfErrors = mfPayload.data.metafieldsSet.userErrors || [];
    if (mfErrors.length) {
      console.warn('[metafields] Warnings:', mfErrors.map((e) => e.message).join('; '));
    }
  }

  const finalPayload = await targetClient.query(FIND_PRODUCT_BY_HANDLE, { handle: product.handle });
  const finalProduct = finalPayload.data.productByHandle;
  log('product', `Admin: https://${targetClient.shop}/admin/products/${finalProduct.id.split('/').pop()}`);
  log('product', `Storefront: https://${targetClient.shop}/products/${product.handle}`);
  return { handle: product.handle, action: existingProduct ? 'update' : 'create', ok: true };
}

async function main() {
  if (!syncAll && !/^\d+$/.test(PRODUCT_ID)) {
    throw new Error('Numeric product ID is required (or pass --all)');
  }

  const config = loadConfig();
  log('auth', 'Authenticating stores...');
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

  log('product', syncAll ? 'Product sync: ALL products' : `Product sync: ${PRODUCT_ID}`);
  log('product', `Source: ${config.source.shop}`);
  log('product', `Target: ${config.target.shop}`);
  log('product', `Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  let sourceProducts;
  if (syncAll) {
    log('list', 'Listing all source products…');
    sourceProducts = await listAllSourceProducts(sourceClient);
    if (!sourceProducts.length) {
      log('product', 'No products found on source. Nothing to sync.');
      return;
    }
    log('list', `Found ${sourceProducts.length} product(s) to sync.`);
  } else {
    sourceProducts = [{ id: `gid://shopify/Product/${PRODUCT_ID}` }];
  }

  const results = [];
  for (let i = 0; i < sourceProducts.length; i += 1) {
    const item = sourceProducts[i];
    log('product', `\n[${i + 1}/${sourceProducts.length}]`);
    try {
      const result = await syncOneProduct(sourceClient, targetClient, item.id);
      results.push(result);
    } catch (error) {
      const message = error?.message || String(error);
      const handle = item.handle || item.id;
      log('product', `FAILED ${handle}: ${message}`);
      results.push({ handle, ok: false, error: message });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  log('product', `\nDone. ${okCount} succeeded, ${failCount} failed (of ${results.length}).`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nSync failed: ${error.message}`);
  process.exitCode = 1;
});
