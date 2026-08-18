import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';
import { downloadVideoBuffer, uploadVideoViaStagedTarget } from './lib/video-upload.mjs';
import {
  normalizeTemplateName,
  parseTemplateCliArgs,
  resolveLocalTemplateFile,
} from './lib/template-paths.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_TEMPLATES_DIR = resolve(__dirname, '../../templates');
const EXTRA_TEMPLATE_DIRS = [resolve(__dirname, '_tech-theme/templates')];

const parsed = parseTemplateCliArgs(process.argv.slice(2), {
  defaultDir: process.env.TEMPLATES_DIR || DEFAULT_TEMPLATES_DIR,
});
const dryRun = parsed.dryRun;
const TEMPLATES_DIR = parsed.templatesDir || DEFAULT_TEMPLATES_DIR;

const DEFAULT_TEMPLATES = ['product.d30-ultra.json'];
const templateNames = parsed.entries.length ? parsed.entries : DEFAULT_TEMPLATES;

const SHOPIFY_VIDEO_RE = /shopify:\/\/files\/videos\/([^"\\]+)/g;

const FIND_FILE = `
  query FindFile($query: String!) {
    files(first: 10, query: $query) {
      nodes {
        __typename
        id
        alt
        ... on Video {
          filename
          originalSource { url }
          sources { url mimeType }
        }
        ... on GenericFile {
          url
        }
      }
    }
  }
`;

function log(message) {
  console.log(message);
}

function extractVideoFilenames(content) {
  const filenames = new Set();
  for (const match of content.matchAll(SHOPIFY_VIDEO_RE)) {
    filenames.add(match[1].trim());
  }
  return filenames;
}

async function loadTemplateContent(name) {
  const localPath = resolveLocalTemplateFile(name, {
    templatesDir: TEMPLATES_DIR,
    extraDirs: EXTRA_TEMPLATE_DIRS,
  });
  if (localPath) {
    return { content: readFileSync(localPath, 'utf8'), source: localPath, name: basename(localPath) };
  }
  return null;
}

function getVideoUrl(node) {
  if (!node) return null;
  if (node.originalSource?.url) return node.originalSource.url;
  const mp4 = node.sources?.find((source) => source.mimeType === 'video/mp4');
  return mp4?.url || node.sources?.[0]?.url || node.url || null;
}

async function findVideoByFilename(client, filename) {
  const payload = await client.query(FIND_FILE, { query: `filename:${filename}` });
  const nodes = payload.data?.files?.nodes || [];
  return nodes.find((node) => node.filename === filename) || null;
}

async function createVideoOnTarget(targetClient, { filename, sourceUrl, alt }) {
  log(`  ↓ Downloading ${filename}...`);
  const buffer = await downloadVideoBuffer(sourceUrl);
  log(`  ↑ Uploading ${filename} (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB)...`);
  return uploadVideoViaStagedTarget(targetClient, { filename, buffer, alt });
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
    mutationDelayMs: config.mutationDelayMs,
  });
  const targetClient = new ShopifyClient({
    shop: config.target.shop,
    accessToken: targetToken,
    apiVersion: config.apiVersion,
    mutationDelayMs: config.mutationDelayMs,
  });

  const allFilenames = new Set();
  const loadedTemplates = [];

  log(`Templates dir: ${TEMPLATES_DIR}`);
  for (const name of templateNames) {
    const loaded = await loadTemplateContent(name);
    if (!loaded) {
      log(`✗ Template not found: ${name}`);
      continue;
    }

    const filenames = extractVideoFilenames(loaded.content);
    loadedTemplates.push({
      name: loaded.name || normalizeTemplateName(name),
      source: loaded.source,
      count: filenames.size,
    });
    filenames.forEach((filename) => allFilenames.add(filename));
  }

  const filenames = [...allFilenames].sort();
  if (!filenames.length) {
    throw new Error('No shopify://files/videos/ references found in provided templates');
  }

  log(`Templates loaded: ${loadedTemplates.length}`);
  loadedTemplates.forEach((item) => log(`  - ${item.name} (${item.count} refs) from ${item.source}`));
  log(`Unique videos total: ${filenames.length}`);
  log(`Source: ${config.source.shop}`);
  log(`Target: ${config.target.shop}`);
  log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  const results = [];

  for (const filename of filenames) {
    const sourceFile = await findVideoByFilename(sourceClient, filename);
    const sourceUrl = getVideoUrl(sourceFile);

    if (!sourceUrl) {
      results.push({ filename, status: 'failed', error: 'Not found on source store' });
      continue;
    }

    const targetFile = await findVideoByFilename(targetClient, filename);
    if (getVideoUrl(targetFile)) {
      results.push({ filename, status: 'skipped' });
      continue;
    }

    if (dryRun) {
      results.push({ filename, status: 'planned' });
      continue;
    }

    try {
      await createVideoOnTarget(targetClient, {
        filename,
        sourceUrl,
        alt: sourceFile.alt,
      });
      results.push({ filename, status: 'created' });
    } catch (error) {
      results.push({ filename, status: 'failed', error: error.message });
    }
  }

  const created = results.filter((r) => r.status === 'created').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const planned = results.filter((r) => r.status === 'planned').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  console.log(
    `\nDone: created ${created}, skipped ${skipped}, planned ${planned}, failed ${failed}, total ${filenames.length}`,
  );

  if (failed) {
    console.log('\nFailed files:');
    results.filter((r) => r.status === 'failed').forEach((r) => log(`  ✗ ${r.filename}: ${r.error}`));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nTemplate video sync failed: ${error.message}`);
  process.exitCode = 1;
});
