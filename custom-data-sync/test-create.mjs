import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';

const config = loadConfig();
const targetToken = await resolveStoreAccessToken(config.target);
const targetClient = new ShopifyClient({
  shop: config.target.shop,
  accessToken: targetToken,
  apiVersion: config.apiVersion,
});

const payload = await targetClient.query(
  `
  mutation CreateProduct($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id handle title }
      userErrors { field message }
    }
  }
`,
  {
    product: {
      handle: 'sync-test-delete-me',
      title: 'Sync Test Delete Me',
      status: 'DRAFT',
    },
  },
  { isMutation: true, allowErrors: true },
);

console.log(JSON.stringify(payload, null, 2));
