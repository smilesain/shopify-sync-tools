import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';

const config = loadConfig();
const targetToken = await resolveStoreAccessToken(config.target);
const client = new ShopifyClient({
  shop: config.target.shop,
  accessToken: targetToken,
  apiVersion: config.apiVersion,
});

const payload = await client.query(
  `
  query {
    productByHandle(handle: "dreame-airstyle-pro") {
      id handle title status
      variants(first: 1) { nodes { sku price barcode } }
      media(first: 10) { nodes { ... on MediaImage { image { url } } } }
      metafields(first: 20) {
        nodes { namespace key type value reference { ... on Metaobject { handle type } } }
      }
    }
  }
`,
);

console.log(JSON.stringify(payload.data.productByHandle, null, 2));
