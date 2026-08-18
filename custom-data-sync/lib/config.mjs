import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');

function parseEnvFile(content) {
  const env = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function loadDotEnv() {
  if (!existsSync(ENV_PATH)) return;

  const fileEnv = parseEnvFile(readFileSync(ENV_PATH, 'utf8'));
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function readEnv(name) {
  return process.env[name]?.trim() || '';
}

function normalizeShop(value) {
  return value.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function loadStoreConfig(prefix) {
  const shop =
    readEnv(`${prefix}_STORE`) ||
    readEnv(`${prefix}_SHOP`);

  if (!shop) {
    throw new Error(`Missing required environment variable: ${prefix}_STORE`);
  }

  const clientId = readEnv(`${prefix}_CLIENT_ID`);
  const clientSecret = readEnv(`${prefix}_CLIENT_SECRET`);
  const directAccessToken = readEnv(`${prefix}_ACCESS_TOKEN`);
  const legacyTokenAlias = readEnv(`${prefix}_TOKEN`);
  const legacyAccessToken = directAccessToken || legacyTokenAlias;

  let accessToken = '';
  let resolvedClientSecret = clientSecret;

  if (legacyAccessToken && !legacyAccessToken.startsWith('shpss_')) {
    accessToken = legacyAccessToken;
  } else if (legacyAccessToken.startsWith('shpss_') && !resolvedClientSecret) {
    resolvedClientSecret = legacyAccessToken;
  }

  return {
    prefix,
    shop: normalizeShop(shop),
    clientId,
    clientSecret: resolvedClientSecret,
    accessToken,
  };
}

export function loadConfig() {
  return {
    source: loadStoreConfig('SOURCE'),
    target: loadStoreConfig('TARGET'),
    apiVersion: readEnv('SHOPIFY_API_VERSION') || '2025-01',
    mutationDelayMs: Number(readEnv('MUTATION_DELAY_MS') || 200),
  };
}

export const METAFIELD_OWNER_TYPES = [
  'PRODUCT',
  'PRODUCTVARIANT',
  'COLLECTION',
  'CUSTOMER',
  'ORDER',
  'DRAFTORDER',
  'PAGE',
  'SHOP',
  'ARTICLE',
  'BLOG',
  'LOCATION',
  'MARKET',
  'COMPANY',
  'COMPANY_LOCATION',
  'DISCOUNT',
  'SELLING_PLAN',
];

export function parseCliArgs(argv) {
  const args = {
    dryRun: false,
    only: 'all',
    ownerTypes: null,
    reportPath: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--only':
        args.only = argv[index + 1];
        index += 1;
        break;
      case '--owner-types':
        args.ownerTypes = argv[index + 1]
          .split(',')
          .map((value) => value.trim().toUpperCase())
          .filter(Boolean);
        index += 1;
        break;
      case '--report':
        args.reportPath = argv[index + 1];
        index += 1;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.only && !['all', 'metaobjects', 'metafields'].includes(args.only)) {
    throw new Error(`Invalid --only value: ${args.only}`);
  }

  return args;
}

export function printHelp() {
  console.log(`
Shopify Custom Data Sync

Usage:
  node sync.mjs [options]

Options:
  --dry-run                 Preview changes without creating definitions
  --only metaobjects        Sync metaobject definitions only
  --only metafields         Sync metafield definitions only
  --owner-types PRODUCT,... Limit metafield owner types
  --report ./report.json    Write sync report to a JSON file
  --help, -h                Show this help

Environment (.env):
  SOURCE_STORE / TARGET_STORE     Shop domain
  SOURCE_ACCESS_TOKEN             Admin API access token (shpat_ / shpca_ / shpua_…)
  TARGET_ACCESS_TOKEN             Admin API access token

  Legacy aliases SOURCE_TOKEN / TARGET_TOKEN are still accepted.
  Prefer *_ACCESS_TOKEN going forward.

Other:
  SHOPIFY_API_VERSION       Optional, default 2025-01
  MUTATION_DELAY_MS         Optional, default 200
`.trim());
}
