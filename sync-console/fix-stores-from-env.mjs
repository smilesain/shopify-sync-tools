import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'sync-console/data');

function parseEnv(content) {
  const env = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[line.slice(0, i).trim()] = v;
  }
  return env;
}

function normalizeShop(value) {
  return String(value || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

const env = parseEnv(readFileSync(join(root, 'custom-data-sync/.env'), 'utf8'));
const storesPath = join(dataDir, 'stores.json');
const storesData = JSON.parse(readFileSync(storesPath, 'utf8'));

const sourceShop = normalizeShop(env.SOURCE_STORE);
const targetShop = normalizeShop(env.TARGET_STORE);
const sourceToken = env.SOURCE_ACCESS_TOKEN || env.SOURCE_TOKEN || '';
const targetToken = env.TARGET_ACCESS_TOKEN || env.TARGET_TOKEN || '';

let sourceId = null;
let targetId = null;

for (const store of storesData.stores) {
  if (store.shop === sourceShop) {
    store.accessToken = sourceToken;
    store.name = 'Source';
    store.updatedAt = new Date().toISOString();
    sourceId = store.id;
  }
  if (store.shop === targetShop) {
    store.accessToken = targetToken;
    store.name = 'Target';
    store.updatedAt = new Date().toISOString();
    targetId = store.id;
  }
}

if (!sourceId || !targetId) {
  throw new Error(`Could not match shops. source=${sourceShop} target=${targetShop}`);
}

writeFileSync(storesPath, `${JSON.stringify(storesData, null, 2)}\n`);
writeFileSync(
  join(dataDir, 'selection.json'),
  `${JSON.stringify({ sourceId, targetId, updatedAt: new Date().toISOString() }, null, 2)}\n`,
);

console.log(
  JSON.stringify(
    {
      fixed: true,
      sourceShop,
      targetShop,
      shops: storesData.stores.map((s) => ({
        name: s.name,
        shop: s.shop,
        tokenLen: (s.accessToken || '').length,
      })),
    },
    null,
    2,
  ),
);
