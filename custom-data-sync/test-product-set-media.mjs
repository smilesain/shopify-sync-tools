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
  mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product { id handle media(first: 3) { nodes { ... on MediaImage { image { url } } } } }
      userErrors { field message code }
    }
  }
`,
  {
    synchronous: true,
    input: {
      id: 'gid://shopify/Product/8465776804026',
      files: [{
        originalSource: 'https://cdn.shopify.com/s/files/1/0584/7508/6033/files/1-White_background.png?v=1773069813',
        alt: 'test image',
        contentType: 'IMAGE',
      }],
    },
  },
  { isMutation: true, allowErrors: true },
);

console.log(JSON.stringify(payload, null, 2));
