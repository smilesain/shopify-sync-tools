import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';

const config = loadConfig();
const [sourceToken, targetToken] = await Promise.all([
  resolveStoreAccessToken(config.source),
  resolveStoreAccessToken(config.target),
]);
const sourceClient = new ShopifyClient({
  shop: config.source.shop,
  accessToken: sourceToken,
  apiVersion: config.apiVersion,
});
const targetClient = new ShopifyClient({
  shop: config.target.shop,
  accessToken: targetToken,
  apiVersion: config.apiVersion,
});

const QUERY = `
  query($type: String!, $handle: String!) {
    metaobjectByHandle(handle: { type: $type, handle: $handle }) {
      handle type
      fields { key value type }
    }
    metaobjectDefinitionByType(type: $type) {
      type name
      fieldDefinitions { key name type { name } required validations { name value } }
    }
  }
`;

for (const type of ['compliance_manufacturer', 'compliance_profile']) {
  console.log('\n=== SOURCE', type, '===');
  const s = await sourceClient.query(QUERY, { type, handle: type === 'compliance_manufacturer' ? 'dreame-trading-tianjin-co-ltd' : 'amf-18-a' });
  console.log(JSON.stringify(s.data, null, 2));
  console.log('\n=== TARGET DEF', type, '===');
  const t = await targetClient.query(`query($type: String!) { metaobjectDefinitionByType(type: $type) { type name fieldDefinitions { key name type { name } required } } }`, { type });
  console.log(JSON.stringify(t.data, null, 2));
}
