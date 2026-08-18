import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';

const PRODUCT_ID = process.argv[2] || '7549570941137';
const gid = `gid://shopify/Product/${PRODUCT_ID}`;

const QUERY = `
  query FetchProduct($id: ID!) {
    product(id: $id) {
      id
      handle
      title
      descriptionHtml
      vendor
      productType
      tags
      status
      category { id name fullName }
      seo { title description }
      options { name position values }
      media(first: 20) {
        nodes {
          ... on MediaImage {
            id
            alt
            image { url }
          }
        }
      }
      variants(first: 100) {
        nodes {
          id
          title
          sku
          barcode
          price
          compareAtPrice
          taxable
          inventoryPolicy
          selectedOptions { name value }
          metafields(first: 50) {
            nodes { namespace key type value }
          }
        }
      }
      metafields(first: 50) {
        nodes {
          namespace
          key
          type
          value
          reference {
            ... on Metaobject {
              id
              handle
              type
            }
          }
        }
      }
    }
  }
`;

const config = loadConfig();
const token = await resolveStoreAccessToken(config.source);
const client = new ShopifyClient({
  shop: config.source.shop,
  accessToken: token,
  apiVersion: config.apiVersion,
});

const payload = await client.query(QUERY, { id: gid });
console.log(JSON.stringify(payload.data?.product, null, 2));
