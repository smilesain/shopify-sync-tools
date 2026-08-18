#!/usr/bin/env node
/**
 * Sync an Online Store Page from source → target by handle.
 *
 * Usage:
 *   node sync-page.mjs [handle] [--dry-run]
 *
 * Default handle: about-us
 */

import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient, isRestrictedNamespace } from './lib/shopify-client.mjs';

const args = process.argv.slice(2).filter((arg) => arg !== '--dry-run');
const dryRun = process.argv.includes('--dry-run');
const PAGE_HANDLE = (args[0] || 'about-us').trim().replace(/^\/+|\/+$/g, '');

const FIND_PAGE = `
  query FindPage($query: String!) {
    pages(first: 5, query: $query) {
      nodes {
        id
        handle
        title
        body
        isPublished
        templateSuffix
        metafields(first: 50) {
          nodes {
            namespace
            key
            type
            value
          }
        }
      }
    }
  }
`;

const PAGE_CREATE = `
  mutation PageCreate($page: PageCreateInput!) {
    pageCreate(page: $page) {
      page { id handle title isPublished }
      userErrors { field message code }
    }
  }
`;

const PAGE_UPDATE = `
  mutation PageUpdate($id: ID!, $page: PageUpdateInput!) {
    pageUpdate(id: $id, page: $page) {
      page { id handle title isPublished }
      userErrors { field message code }
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

async function findPageByHandle(client, handle) {
  const payload = await client.query(FIND_PAGE, { query: `handle:${handle}` });
  const nodes = payload.data?.pages?.nodes || [];
  return nodes.find((page) => page.handle === handle) || null;
}

function buildPageInput(sourcePage) {
  return {
    title: sourcePage.title,
    handle: sourcePage.handle,
    body: sourcePage.body || '',
    isPublished: Boolean(sourcePage.isPublished),
    templateSuffix: sourcePage.templateSuffix || null,
  };
}

async function syncPageMetafields(targetClient, ownerId, metafields) {
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

async function main() {
  if (!PAGE_HANDLE) {
    throw new Error('Page handle is required');
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

  log(`Page sync: ${PAGE_HANDLE}`);
  log(`Source: ${config.source.shop}`);
  log(`Target: ${config.target.shop}`);
  log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  const sourcePage = await findPageByHandle(sourceClient, PAGE_HANDLE);
  if (!sourcePage) {
    throw new Error(`Source page not found for handle: ${PAGE_HANDLE}`);
  }

  log(
    `Source page: "${sourcePage.title}" (${sourcePage.handle}) published=${sourcePage.isPublished} bodyChars=${(sourcePage.body || '').length}`,
  );

  const existingTarget = await findPageByHandle(targetClient, PAGE_HANDLE);
  const pageInput = buildPageInput(sourcePage);
  const metafieldNodes = sourcePage.metafields?.nodes || [];

  if (dryRun) {
    log(`[dry-run] Would ${existingTarget ? 'update' : 'create'} page on target`);
    log(`[dry-run] title=${pageInput.title}`);
    log(`[dry-run] handle=${pageInput.handle}`);
    log(`[dry-run] isPublished=${pageInput.isPublished}`);
    log(`[dry-run] templateSuffix=${pageInput.templateSuffix || '(default)'}`);
    await syncPageMetafields(targetClient, existingTarget?.id || 'gid://shopify/Page/DRY_RUN', metafieldNodes);
    log('\nDry run complete.');
    return;
  }

  let targetPageId;

  if (existingTarget) {
    log(`Updating existing target page: ${PAGE_HANDLE}`);
    const payload = await targetClient.query(
      PAGE_UPDATE,
      { id: existingTarget.id, page: pageInput },
      { isMutation: true, allowErrors: true },
    );
    const result = payload.data?.pageUpdate;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    targetPageId = result.page.id;
    log(`Updated page: ${result.page.handle} (${result.page.id})`);
  } else {
    log(`Creating target page: ${PAGE_HANDLE}`);
    const payload = await targetClient.query(
      PAGE_CREATE,
      { page: pageInput },
      { isMutation: true, allowErrors: true },
    );
    const result = payload.data?.pageCreate;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    targetPageId = result.page.id;
    log(`Created page: ${result.page.handle} (${result.page.id})`);
  }

  await syncPageMetafields(targetClient, targetPageId, metafieldNodes);

  log(`\nDone. Admin: https://${config.target.shop}/admin/pages`);
  log(`Storefront: https://${config.target.shop}/pages/${PAGE_HANDLE}`);
}

main().catch((error) => {
  console.error(`\nPage sync failed: ${error.message}`);
  process.exitCode = 1;
});
