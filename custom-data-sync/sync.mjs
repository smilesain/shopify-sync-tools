#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  METAFIELD_OWNER_TYPES,
  parseCliArgs,
  printHelp,
} from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { syncMetafieldDefinitions } from './lib/metafields.mjs';
import {
  buildSourceMetaobjectIdMap,
  exportMetaobjectDefinitions,
  syncMetaobjectDefinitions,
} from './lib/metaobjects.mjs';
import { metaobjectTypeKey } from './lib/shopify-client.mjs';
import {
  createEmptyReport,
  finalizeReport,
  printSummary,
  writeReport,
} from './lib/report.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultReportPath = join(__dirname, 'reports', `sync-${Date.now()}.json`);

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const ownerTypes = args.ownerTypes || METAFIELD_OWNER_TYPES;
  let report;

  try {
  console.log('Shopify Custom Data Sync');
  console.log(`Source: ${config.source.shop}`);
  console.log(`Target: ${config.target.shop}`);
  console.log(`API version: ${config.apiVersion}`);
  console.log(`Mode: ${args.dryRun ? 'DRY RUN' : 'LIVE'}`);

  console.log('\nAuthenticating stores...');
  const [sourceAccessToken, targetAccessToken] = await Promise.all([
    resolveStoreAccessToken(config.source),
    resolveStoreAccessToken(config.target),
  ]);
  console.log('Authentication OK');

  const sourceClient = new ShopifyClient({
    shop: config.source.shop,
    accessToken: sourceAccessToken,
    apiVersion: config.apiVersion,
    mutationDelayMs: config.mutationDelayMs,
  });

  const targetClient = new ShopifyClient({
    shop: config.target.shop,
    accessToken: targetAccessToken,
    apiVersion: config.apiVersion,
    mutationDelayMs: config.mutationDelayMs,
  });

  report = createEmptyReport({
    sourceShop: config.source.shop,
    targetShop: config.target.shop,
    dryRun: args.dryRun,
    only: args.only,
  });

  let typeToTargetId = new Map();
  let sourceTypeToId = new Map();

  if (args.only === 'all' || args.only === 'metaobjects') {
    const metaobjectResult = await syncMetaobjectDefinitions({
      sourceClient,
      targetClient,
      dryRun: args.dryRun,
      report,
    });

    typeToTargetId = metaobjectResult.typeToTargetId;
    sourceTypeToId = buildSourceMetaobjectIdMap(metaobjectResult.sourceDefinitions);
  } else if (args.only === 'metafields') {
    console.log('\n[metaobjects] Loading definition maps for validation remapping...');
    const [targetDefinitions, sourceDefinitions] = await Promise.all([
      exportMetaobjectDefinitions(targetClient),
      exportMetaobjectDefinitions(sourceClient),
    ]);

    typeToTargetId = new Map(
      targetDefinitions.map((definition) => [metaobjectTypeKey(definition.type), definition.id]),
    );
    sourceTypeToId = buildSourceMetaobjectIdMap(sourceDefinitions);
  }

  if (args.only === 'all' || args.only === 'metafields') {
    await syncMetafieldDefinitions({
      sourceClient,
      targetClient,
      ownerTypes,
      dryRun: args.dryRun,
      report,
      typeToTargetId,
      sourceTypeToId,
    });
  }

  finalizeReport(report);
  printSummary(report);
  writeReport(report, args.reportPath || defaultReportPath);

  const totalFailed = report.metaobjects.failed.length + report.metafields.failed.length;
  if (totalFailed > 0) {
    process.exitCode = 1;
  }
  } catch (error) {
    if (report) {
      finalizeReport(report);
      writeReport(report, args.reportPath || defaultReportPath);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`\nSync failed: ${error.message}`);
  process.exitCode = 1;
});
