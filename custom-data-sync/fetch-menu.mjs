import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';

const handle = process.argv[2] || 'new-main-menu-2026-test';
const store = process.argv[3] || 'source';

const config = loadConfig();
const storeConfig = store === 'target' ? config.target : config.source;
const token = await resolveStoreAccessToken(storeConfig);
const client = new ShopifyClient({
  shop: storeConfig.shop,
  accessToken: token,
  apiVersion: config.apiVersion,
});

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
      nodes {
        id
        handle
        title
      }
    }
  }
`;

const QUERY = `
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

const listPayload = await client.query(LIST_MENUS, { query: `handle:${handle}` });
const menuSummary = listPayload.data?.menus?.nodes?.find((m) => m.handle === handle);
if (!menuSummary) {
  console.error(`Menu not found: ${handle}`);
  process.exit(1);
}

const payload = await client.query(QUERY, { id: menuSummary.id });
console.log(JSON.stringify(payload.data?.menu, null, 2));
