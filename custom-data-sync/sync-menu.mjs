import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';

const MENU_HANDLE = process.argv[2] || 'new-main-menu-2026-test';
const dryRun = process.argv.includes('--dry-run');

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

  log(`Fetching source menu: ${MENU_HANDLE} (${config.source.shop})`);
  const sourceMenu = await fetchMenuByHandle(sourceClient, MENU_HANDLE);
  if (!sourceMenu) {
    throw new Error(`Source menu not found: ${MENU_HANDLE}`);
  }

  const cache = new Map();
  const warnings = [];
  const items = await buildCreateItems(sourceMenu.items, targetClient, cache, warnings);

  const existingTarget = await findMenuByHandle(targetClient, MENU_HANDLE);

  if (dryRun) {
    log(`[dry-run] Would ${existingTarget ? 'update' : 'create'} menu "${sourceMenu.title}" with ${items.length} top-level items`);
    if (warnings.length) {
      log(`[dry-run] Warnings (${warnings.length}):`);
      warnings.forEach((w) => log(`  - ${w}`));
    }
    return;
  }

  if (existingTarget) {
    log(`Updating existing target menu: ${MENU_HANDLE}`);
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
    log(`Creating target menu: ${MENU_HANDLE}`);
    const payload = await targetClient.query(
      MENU_CREATE,
      {
        title: sourceMenu.title,
        handle: MENU_HANDLE,
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
    log(`\nWarnings (${warnings.length}):`);
    warnings.forEach((w) => log(`  - ${w}`));
  }

  log(`\nDone. Admin: https://${config.target.shop}/admin/menus`);
}

main().catch((error) => {
  console.error(`\nMenu sync failed: ${error.message}`);
  process.exitCode = 1;
});
