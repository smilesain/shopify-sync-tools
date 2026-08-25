#!/usr/bin/env node
/**
 * Sync Online Store Page(s) from source → target.
 *
 * Usage:
 *   node sync-page.mjs [handle] [--dry-run]
 *   node sync-page.mjs --all [--dry-run]
 *
 * Default handle: about-us
 */

import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient, isRestrictedNamespace } from './lib/shopify-client.mjs';

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const syncAll = rawArgs.includes('--all');
const args = rawArgs.filter((arg) => arg !== '--dry-run' && arg !== '--all');
const PAGE_HANDLE = (args[0] || 'about-us').trim().replace(/^\/+|\/+$/g, '');

const PAGE_FIELDS = `
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
`;

const FIND_PAGE = `
  query FindPage($query: String!) {
    pages(first: 5, query: $query) {
      nodes {
        ${PAGE_FIELDS}
      }
    }
  }
`;

const LIST_PAGES = `
  query ListPages($cursor: String) {
    pages(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ${PAGE_FIELDS}
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

async function listAllSourcePages(sourceClient) {
  const pages = [];
  let cursor = null;
  let page = 0;

  do {
    page += 1;
    const payload = await sourceClient.query(LIST_PAGES, { cursor });
    const connection = payload.data?.pages;
    const nodes = connection?.nodes || [];
    pages.push(...nodes);
    log(`[list] Page ${page}: +${nodes.length} (total ${pages.length})`);
    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  return pages;
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

async function syncOnePage(sourceClient, targetClient, sourcePage) {
  const handle = sourcePage.handle;
  log(
    `Source page: "${sourcePage.title}" (${handle}) published=${sourcePage.isPublished} bodyChars=${(sourcePage.body || '').length}`,
  );

  const existingTarget = await findPageByHandle(targetClient, handle);
  const pageInput = buildPageInput(sourcePage);
  const metafieldNodes = sourcePage.metafields?.nodes || [];

  if (dryRun) {
    log(`[dry-run] Would ${existingTarget ? 'update' : 'create'} page on target`);
    log(`[dry-run] title=${pageInput.title}`);
    log(`[dry-run] handle=${pageInput.handle}`);
    log(`[dry-run] isPublished=${pageInput.isPublished}`);
    log(`[dry-run] templateSuffix=${pageInput.templateSuffix || '(default)'}`);
    await syncPageMetafields(targetClient, existingTarget?.id || 'gid://shopify/Page/DRY_RUN', metafieldNodes);
    return { handle, action: existingTarget ? 'update' : 'create', ok: true };
  }

  let targetPageId;

  if (existingTarget) {
    log(`Updating existing target page: ${handle}`);
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
    log(`Creating target page: ${handle}`);
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
  log(`Storefront: https://${targetClient.shop}/pages/${handle}`);
  return { handle, action: existingTarget ? 'update' : 'create', ok: true };
}

async function main() {
  if (!syncAll && !PAGE_HANDLE) {
    throw new Error('Page handle is required (or pass --all)');
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

  log(syncAll ? 'Page sync: ALL pages' : `Page sync: ${PAGE_HANDLE}`);
  log(`Source: ${config.source.shop}`);
  log(`Target: ${config.target.shop}`);
  log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  let sourcePages;
  if (syncAll) {
    log('Listing all source pages…');
    sourcePages = await listAllSourcePages(sourceClient);
    if (!sourcePages.length) {
      log('No pages found on source. Nothing to sync.');
      return;
    }
    log(`Found ${sourcePages.length} page(s) to sync.`);
  } else {
    const sourcePage = await findPageByHandle(sourceClient, PAGE_HANDLE);
    if (!sourcePage) {
      throw new Error(`Source page not found for handle: ${PAGE_HANDLE}`);
    }
    sourcePages = [sourcePage];
  }

  const results = [];
  for (let i = 0; i < sourcePages.length; i += 1) {
    const page = sourcePages[i];
    log(`\n[${i + 1}/${sourcePages.length}]`);
    try {
      const result = await syncOnePage(sourceClient, targetClient, page);
      results.push(result);
    } catch (error) {
      const message = error?.message || String(error);
      log(`FAILED ${page.handle}: ${message}`);
      results.push({ handle: page.handle, ok: false, error: message });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  log(`\nDone. ${okCount} succeeded, ${failCount} failed (of ${results.length}).`);
  log(`Admin: https://${config.target.shop}/admin/pages`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nPage sync failed: ${error.message}`);
  process.exitCode = 1;
});
