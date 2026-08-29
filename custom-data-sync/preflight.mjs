#!/usr/bin/env node

import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';

const rawArgs = process.argv.slice(2);
const modulesArg = rawArgs.find((arg) => arg.startsWith('--modules='));
const modules = new Set(
  String(modulesArg?.slice('--modules='.length) || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const PREFLIGHT_QUERY = `
  query SyncPreflight {
    shop {
      name
      myshopifyDomain
    }
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

const REQUIREMENTS = [
  {
    modules: ['product', 'collection'],
    source: ['read_products'],
    target: ['read_products', 'write_products'],
  },
  {
    modules: ['page', 'article'],
    source: ['read_content'],
    target: ['read_content', 'write_content'],
  },
  {
    modules: ['menu'],
    source: ['read_online_store_navigation'],
    target: ['read_online_store_navigation', 'write_online_store_navigation'],
  },
  {
    modules: ['template-files', 'template-videos'],
    source: ['read_files'],
    target: ['read_files', 'write_files'],
  },
  {
    modules: ['metaobjects'],
    source: ['read_metaobject_definitions'],
    target: ['read_metaobject_definitions', 'write_metaobject_definitions'],
  },
  {
    modules: ['metaobject-entries'],
    source: ['read_metaobjects'],
    target: ['read_metaobjects', 'write_metaobjects', 'read_files', 'write_files'],
  },
];

function requiredScopes(side) {
  return [
    ...new Set(
      REQUIREMENTS.filter((item) => item.modules.some((module) => modules.has(module)))
        .flatMap((item) => item[side]),
    ),
  ];
}

async function inspect(client) {
  const payload = await client.query(PREFLIGHT_QUERY);
  const shop = payload.data?.shop;
  const scopes = new Set(
    (payload.data?.currentAppInstallation?.accessScopes || []).map((item) => item.handle),
  );
  if (!shop?.myshopifyDomain) {
    throw new Error(`Could not identify shop ${client.shop}`);
  }
  return { shop, scopes };
}

function missingScopes(actual, required) {
  return required.filter((scope) => !actual.has(scope));
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
  });
  const targetClient = new ShopifyClient({
    shop: config.target.shop,
    accessToken: targetToken,
    apiVersion: config.apiVersion,
  });

  const [source, target] = await Promise.all([
    inspect(sourceClient),
    inspect(targetClient),
  ]);

  console.log(`Source: ${source.shop.name} (${source.shop.myshopifyDomain})`);
  console.log(`Target: ${target.shop.name} (${target.shop.myshopifyDomain})`);
  if (source.shop.myshopifyDomain === target.shop.myshopifyDomain) {
    throw new Error('Source and target resolve to the same Shopify store');
  }

  const sourceMissing = missingScopes(source.scopes, requiredScopes('source'));
  const targetMissing = missingScopes(target.scopes, requiredScopes('target'));
  if (sourceMissing.length) {
    console.error(`Source missing scopes: ${sourceMissing.join(', ')}`);
  }
  if (targetMissing.length) {
    console.error(`Target missing scopes: ${targetMissing.join(', ')}`);
  }
  if (sourceMissing.length || targetMissing.length) {
    throw new Error('Preflight failed: required API scopes are missing');
  }

  console.log(`Modules: ${[...modules].join(', ') || '(none)'}`);
  console.log('Preflight OK');
}

main().catch((error) => {
  console.error(`Preflight failed: ${error.message}`);
  process.exitCode = 1;
});
