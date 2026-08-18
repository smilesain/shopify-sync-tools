import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';

const dryRun = process.argv.includes('--dry-run');
const productIds = process.argv
  .slice(2)
  .filter((arg) => arg !== '--dry-run' && /^\d+$/.test(arg));

if (!productIds.length) {
  console.error('Usage: node sync-template-suffix.mjs <sourceProductId> [moreIds...] [--dry-run]');
  process.exit(1);
}

const FETCH_SOURCE = `
  query FetchSourceTemplate($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      templateSuffix
    }
  }
`;

const FIND_TARGET = `
  query FindTarget($handle: String!) {
    productByHandle(handle: $handle) {
      id
      handle
      templateSuffix
    }
  }
`;

const PRODUCT_SET = `
  mutation ProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product { id handle templateSuffix }
      userErrors { field message code }
    }
  }
`;

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

  const results = [];

  for (const productId of productIds) {
    const sourceGid = `gid://shopify/Product/${productId}`;
    const sourcePayload = await sourceClient.query(FETCH_SOURCE, { id: sourceGid });
    const source = sourcePayload.data?.product;

    if (!source) {
      results.push({ productId, status: 'failed', error: 'Source product not found' });
      continue;
    }

    const targetPayload = await targetClient.query(FIND_TARGET, { handle: source.handle });
    const target = targetPayload.data?.productByHandle;

    if (!target) {
      results.push({
        productId,
        handle: source.handle,
        status: 'failed',
        error: 'Target product not found (sync product first)',
      });
      continue;
    }

    const sourceSuffix = source.templateSuffix || '';
    const targetSuffix = target.templateSuffix || '';

    if (sourceSuffix === targetSuffix) {
      results.push({
        productId,
        handle: source.handle,
        title: source.title,
        status: 'skipped',
        templateSuffix: sourceSuffix || '(default)',
      });
      continue;
    }

    if (dryRun) {
      results.push({
        productId,
        handle: source.handle,
        title: source.title,
        status: 'planned',
        from: targetSuffix || '(default)',
        to: sourceSuffix || '(default)',
      });
      continue;
    }

    const setPayload = await targetClient.query(
      PRODUCT_SET,
      {
        synchronous: true,
        input: {
          id: target.id,
          templateSuffix: sourceSuffix,
        },
      },
      { isMutation: true, allowErrors: true },
    );

    const setResult = setPayload.data?.productSet;
    if (!setResult || setResult.userErrors?.length) {
      results.push({
        productId,
        handle: source.handle,
        status: 'failed',
        error: setResult?.userErrors?.map((e) => e.message).join('; ') || 'productSet failed',
      });
      continue;
    }

    results.push({
      productId,
      handle: source.handle,
      title: source.title,
      status: 'updated',
      templateSuffix: setResult.product.templateSuffix || '(default)',
    });
  }

  console.log('\nTemplate suffix sync results:\n');
  for (const row of results) {
    if (row.status === 'updated') {
      console.log(`✓ ${row.productId} ${row.handle} -> ${row.templateSuffix}`);
    } else if (row.status === 'skipped') {
      console.log(`- ${row.productId} ${row.handle} already ${row.templateSuffix}`);
    } else if (row.status === 'planned') {
      console.log(`~ ${row.productId} ${row.handle}: ${row.from} -> ${row.to}`);
    } else {
      console.log(`✗ ${row.productId} ${row.handle || ''} ${row.error}`);
    }
  }

  const updated = results.filter((r) => r.status === 'updated').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  console.log(`\nDone: updated ${updated}, skipped ${results.length - updated - failed}, failed ${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nSync failed: ${error.message}`);
  process.exitCode = 1;
});
