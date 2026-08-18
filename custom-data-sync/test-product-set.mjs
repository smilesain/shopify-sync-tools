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
      product { id handle title variants(first: 1) { nodes { id sku price barcode } } }
      userErrors { field message code }
    }
  }
`,
  {
    synchronous: true,
    input: {
      handle: 'sync-test-delete-me-3',
      title: 'Sync Test 3',
      descriptionHtml: '<p>Test</p>',
      vendor: 'Dreame Germany',
      productType: 'Beauty',
      status: 'ACTIVE',
      category: 'gid://shopify/TaxonomyCategory/hb-3-10-12',
      productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
      variants: [{
        sku: 'TESTSKU003',
        barcode: '1234567890123',
        price: '299.00',
        optionValues: [{ optionName: 'Title', name: 'Default Title' }],
        inventoryPolicy: 'DENY',
        taxable: true,
      }],
    },
  },
  { isMutation: true, allowErrors: true },
);

console.log(JSON.stringify(payload, null, 2));
