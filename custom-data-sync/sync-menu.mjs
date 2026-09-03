#!/usr/bin/env node
/**
 * Sync Menu(s) from source → target.
 *
 * Usage:
 *   node sync-menu.mjs [menu-handle] [--dry-run]
 *   node sync-menu.mjs main-menu footer --dry-run
 *   node sync-menu.mjs --all [--dry-run]
 *
 * Default handle (no args): new-main-menu-2026-test
 */

import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';
import { parseHandles } from './lib/definition-filters.mjs';

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const syncAll = rawArgs.includes('--all');
const args = rawArgs.filter((arg) => arg !== '--dry-run' && arg !== '--all');
const parsedHandles = parseHandles(args);
const MENU_HANDLES = parsedHandles.length ? parsedHandles : syncAll ? [] : ['new-main-menu-2026-test'];

const MENU_ITEM_FRAGMENT = `
  fragment MenuItemFields on MenuItem {
    id
    title
    type
    url
    tags
    resourceId
    items {
      id
      title
      type
      url
      tags
      resourceId
      items {
        id
        title
        type
        url
        tags
        resourceId
        items {
          id
          title
          type
          url
          tags
          resourceId
        }
      }
    }
  }
`;

const LIST_MENUS = `
  query ListMenus($query: String) {
    menus(first: 20, query: $query) {
      nodes { id handle title }
    }
  }
`;

const LIST_ALL_MENUS = `
  query ListAllMenus($cursor: String) {
    menus(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes { id handle title }
    }
  }
`;

const FETCH_MENU = `
  ${MENU_ITEM_FRAGMENT}
  query FetchMenu($id: ID!) {
    menu(id: $id) {
      id
      handle
      title
      items { ...MenuItemFields }
    }
  }
`;

const MENU_CREATE = `
  mutation MenuCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu { id handle title }
      userErrors { field message code }
    }
  }
`;

const MENU_UPDATE = `
  mutation MenuUpdate($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, items: $items) {
      menu { id handle title }
      userErrors { field message code }
    }
  }
`;

const RESOURCE_QUERIES = {
  COLLECTION: {
    query: `query($handle: String!) { collectionByHandle(handle: $handle) { id } }`,
    pick: (data) => data?.collectionByHandle?.id,
  },
  PRODUCT: {
    query: `query($handle: String!) { productByHandle(handle: $handle) { id } }`,
    pick: (data) => data?.productByHandle?.id,
  },
  PAGE: {
    query: `query($query: String!) { pages(first: 1, query: $query) { nodes { id handle } } }`,
    pick: (data, handle) => data?.pages?.nodes?.find((p) => p.handle === handle)?.id,
  },
};

function log(message) {
  console.log(message);
}

function parseHandleFromUrl(url, type) {
  if (!url) return null;
  const path = url.startsWith('http') ? new URL(url).pathname : url;
  const patterns = {
    COLLECTION: /^\/collections\/([^/?#]+)/,
    PRODUCT: /^\/products\/([^/?#]+)/,
    PAGE: /^\/pages\/([^/?#]+)/,
  };
  return path.match(patterns[type])?.[1] || null;
}

function normalizeUrl(url) {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return url;
    }
  }
  return url;
}

async function findMenuByHandle(client, handle) {
  const payload = await client.query(LIST_MENUS, { query: `handle:${handle}` });
  return payload.data?.menus?.nodes?.find((menu) => menu.handle === handle) || null;
}

async function fetchMenuByHandle(client, handle) {
  const summary = await findMenuByHandle(client, handle);
  if (!summary) return null;
  const payload = await client.query(FETCH_MENU, { id: summary.id });
  return payload.data?.menu || null;
}

async function fetchMenuById(client, id) {
  const payload = await client.query(FETCH_MENU, { id });
  return payload.data?.menu || null;
}

async function listAllSourceMenus(sourceClient) {
  const menus = [];
  let cursor = null;
  let page = 0;

  do {
    page += 1;
    const payload = await sourceClient.query(LIST_ALL_MENUS, { cursor });
    const connection = payload.data?.menus;
    const nodes = connection?.nodes || [];
    menus.push(...nodes);
    log(`[list] Page ${page}: +${nodes.length} (total ${menus.length})`);
    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  return menus;
}

async function resolveTargetResourceId(targetClient, type, url, cache) {
  if (!RESOURCE_QUERIES[type]) return null;
  const handle = parseHandleFromUrl(url, type);
  if (!handle) return null;

  const cacheKey = `${type}:${handle}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const payload = await targetClient.query(RESOURCE_QUERIES[type].query, {
    handle,
    query: `handle:${handle}`,
  });
  const id = RESOURCE_QUERIES[type].pick(payload.data, handle) || null;

  cache.set(cacheKey, id);
  return id;
}

async function buildMenuItems(sourceItems, targetClient, cache, warnings, forUpdate = false) {
  const output = [];

  for (const item of sourceItems || []) {
    let type = item.type;
    let url = normalizeUrl(item.url);
    let resourceId = null;

    if (['COLLECTION', 'PRODUCT', 'PAGE'].includes(type)) {
      resourceId = await resolveTargetResourceId(targetClient, type, item.url, cache);
      if (!resourceId) {
        warnings.push(`Missing ${type} on target for "${item.title}" (${url}) -> fallback HTTP`);
        type = 'HTTP';
        resourceId = null;
      }
    }

    const built = {
      title: item.title,
      type,
      tags: item.tags?.length ? item.tags : undefined,
    };

    if (type === 'HTTP') {
      built.url = url || '#';
    } else {
      built.resourceId = resourceId;
      built.url = url || undefined;
    }

    if (forUpdate) {
      built.id = item.id;
    }

    if (item.items?.length) {
      built.items = await buildMenuItems(item.items, targetClient, cache, warnings, forUpdate);
    }

    output.push(built);
  }

  return output;
}

async function buildCreateItems(sourceItems, targetClient, cache, warnings) {
  return buildMenuItems(sourceItems, targetClient, cache, warnings, false);
}

async function syncOneMenu(sourceClient, targetClient, sourceMenu) {
  const handle = sourceMenu.handle;
  const cache = new Map();
  const warnings = [];
  const items = await buildCreateItems(sourceMenu.items, targetClient, cache, warnings);
  const existingTarget = await findMenuByHandle(targetClient, handle);

  if (dryRun) {
    log(`[dry-run] Would ${existingTarget ? 'update' : 'create'} menu "${sourceMenu.title}" (${handle}) with ${items.length} top-level items`);
    if (warnings.length) {
      log(`[dry-run] Warnings (${warnings.length}):`);
      warnings.forEach((w) => log(`  - ${w}`));
    }
    return { handle, action: existingTarget ? 'update' : 'create', ok: true };
  }

  if (existingTarget) {
    log(`Updating existing target menu: ${handle}`);
    const payload = await targetClient.query(
      MENU_UPDATE,
      {
        id: existingTarget.id,
        title: sourceMenu.title,
        items,
      },
      { isMutation: true, allowErrors: true },
    );
    const result = payload.data?.menuUpdate;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    log(`Updated menu: ${result.menu.handle}`);
  } else {
    log(`Creating target menu: ${handle}`);
    const payload = await targetClient.query(
      MENU_CREATE,
      {
        title: sourceMenu.title,
        handle,
        items,
      },
      { isMutation: true, allowErrors: true },
    );
    const result = payload.data?.menuCreate;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    log(`Created menu: ${result.menu.handle}`);
  }

  if (warnings.length) {
    log(`Warnings (${warnings.length}):`);
    warnings.forEach((w) => log(`  - ${w}`));
  }

  return { handle, action: existingTarget ? 'update' : 'create', ok: true };
}

async function main() {
  if (!syncAll && !MENU_HANDLES.length) {
    throw new Error('At least one menu handle is required (or pass --all)');
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

  log(syncAll ? 'Menu sync: ALL menus' : `Menu sync: ${MENU_HANDLES.join(', ')}`);
  log(`Source: ${config.source.shop}`);
  log(`Target: ${config.target.shop}`);
  log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  const results = [];
  let sourceMenus;
  if (syncAll) {
    log('Listing all source menus…');
    const summaries = await listAllSourceMenus(sourceClient);
    if (!summaries.length) {
      log('No menus found on source. Nothing to sync.');
      return;
    }
    sourceMenus = [];
    for (const summary of summaries) {
      const full = await fetchMenuById(sourceClient, summary.id);
      if (full) sourceMenus.push(full);
    }
    log(`Found ${sourceMenus.length} menu(s) to sync.`);
  } else {
    sourceMenus = [];
    for (const handle of MENU_HANDLES) {
      log(`Fetching source menu: ${handle} (${config.source.shop})`);
      const sourceMenu = await fetchMenuByHandle(sourceClient, handle);
      if (!sourceMenu) {
        log(`FAILED ${handle}: Source menu not found`);
        results.push({ handle, ok: false, error: `Source menu not found: ${handle}` });
        continue;
      }
      sourceMenus.push(sourceMenu);
    }
  }
  for (let i = 0; i < sourceMenus.length; i += 1) {
    const menu = sourceMenus[i];
    log(`\n[${i + 1}/${sourceMenus.length}]`);
    try {
      const result = await syncOneMenu(sourceClient, targetClient, menu);
      results.push(result);
    } catch (error) {
      const message = error?.message || String(error);
      log(`FAILED ${menu.handle}: ${message}`);
      results.push({ handle: menu.handle, ok: false, error: message });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  log(`\nDone. ${okCount} succeeded, ${failCount} failed (of ${results.length}).`);
  log(`Admin: https://${config.target.shop}/admin/menus`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nMenu sync failed: ${error.message}`);
  process.exitCode = 1;
});
