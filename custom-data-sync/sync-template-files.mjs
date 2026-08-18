import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient } from './lib/shopify-client.mjs';
import {
  normalizeTemplateName,
  parseTemplateCliArgs,
  resolveLocalTemplateFile,
} from './lib/template-paths.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_TEMPLATES_DIR = resolve(__dirname, '../../templates');
const EXTRA_TEMPLATE_DIRS = [
  resolve(__dirname, '_tech-theme/templates'),
];

const parsed = parseTemplateCliArgs(process.argv.slice(2), {
  defaultDir: process.env.TEMPLATES_DIR || DEFAULT_TEMPLATES_DIR,
});
const dryRun = parsed.dryRun;
const TEMPLATES_DIR = parsed.templatesDir || DEFAULT_TEMPLATES_DIR;

const DEFAULT_TEMPLATES = ['product.x60-pro-ultra-matrix.json'];
const templateNames = parsed.entries.length ? parsed.entries : DEFAULT_TEMPLATES;

/** Local fallback when technology store filename differs from repo */
const TEMPLATE_ALIASES = {
  'product.glory-combo-purple.json': 'product.hair-glory-combo-purple.json',
};

const SHOPIFY_IMAGE_RE = /shopify:\/\/shop_images\/([^"\\]+)/g;

const MAIN_THEME = `
  query MainTheme {
    themes(first: 1, roles: [MAIN]) {
      nodes { id name }
    }
  }
`;

const THEME_FILE = `
  query ThemeFile($id: ID!, $filenames: [String!]!) {
    theme(id: $id) {
      files(filenames: $filenames) {
        nodes {
          filename
          body {
            ... on OnlineStoreThemeFileBodyText { content }
            ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
          }
        }
      }
    }
  }
`;

const FIND_FILE = `
  query FindFile($query: String!) {
    files(first: 5, query: $query) {
      nodes {
        __typename
        id
        alt
        ... on MediaImage {
          image { url }
        }
        preview {
          image { url }
        }
      }
    }
  }
`;

const FILE_CREATE = `
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        __typename
        id
        alt
        ... on MediaImage {
          image { url }
        }
      }
      userErrors { field message code }
    }
  }
`;

function log(message) {
  console.log(message);
}

function decodeThemeBody(body) {
  if (!body) return '';
  if (body.content) return body.content;
  if (body.contentBase64) return Buffer.from(body.contentBase64, 'base64').toString('utf8');
  return '';
}

async function fetchThemeTemplate(sourceClient, themeFilename) {
  const themePayload = await sourceClient.query(MAIN_THEME);
  const theme = themePayload.data?.themes?.nodes?.[0];
  if (!theme) throw new Error('Main theme not found on source store');

  const filePayload = await sourceClient.query(THEME_FILE, {
    id: theme.id,
    filenames: [`templates/${themeFilename}`],
  });
  const node = filePayload.data?.theme?.files?.nodes?.[0];
  if (!node) return null;
  return decodeThemeBody(node.body);
}

async function loadTemplateContent(name, sourceClient) {
  const localPath = resolveLocalTemplateFile(name, {
    templatesDir: TEMPLATES_DIR,
    extraDirs: EXTRA_TEMPLATE_DIRS,
  });
  if (localPath) {
    return { content: readFileSync(localPath, 'utf8'), source: localPath, name: basename(localPath) };
  }

  const themeFilename = normalizeTemplateName(name);
  const alias = TEMPLATE_ALIASES[themeFilename];
  if (alias) {
    const aliasPath = resolveLocalTemplateFile(alias, {
      templatesDir: TEMPLATES_DIR,
      extraDirs: EXTRA_TEMPLATE_DIRS,
    });
    if (aliasPath) {
      return { content: readFileSync(aliasPath, 'utf8'), source: aliasPath, name: basename(aliasPath) };
    }
  }

  try {
    const remoteContent = await fetchThemeTemplate(sourceClient, themeFilename);
    if (remoteContent) {
      return { content: remoteContent, source: `theme:${themeFilename}`, name: themeFilename };
    }
  } catch (error) {
    if (!/read_themes/i.test(error.message)) throw error;
    log(`  ! Theme API unavailable for ${themeFilename}: ${error.message}`);
  }

  return null;
}

function extractImageFilenames(content) {
  const filenames = new Set();
  for (const match of content.matchAll(SHOPIFY_IMAGE_RE)) {
    filenames.add(match[1].trim());
  }
  return filenames;
}

async function findFileByFilename(client, filename) {
  const payload = await client.query(FIND_FILE, { query: `filename:${filename}` });
  const nodes = payload.data?.files?.nodes || [];
  return nodes.find((node) => {
    const url = node.image?.url || node.preview?.image?.url || '';
    return url.includes(`/${filename}`) || url.endsWith(filename);
  }) || nodes[0] || null;
}

function getFileUrl(node) {
  return node?.image?.url || node?.preview?.image?.url || null;
}

async function createFileOnTarget(targetClient, { filename, sourceUrl, alt }) {
  const payload = await targetClient.query(
    FILE_CREATE,
    {
      files: [
        {
          alt: alt || '',
          contentType: 'IMAGE',
          duplicateResolutionMode: 'REPLACE',
          filename,
          originalSource: sourceUrl,
        },
      ],
    },
    { isMutation: true, allowErrors: true },
  );

  const result = payload.data?.fileCreate;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((e) => e.message).join('; '));
  }
  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join('; '));
  }
  return result.files[0];
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
    const loaded = await loadTemplateContent(name, sourceClient);
    if (!loaded) {
      log(`✗ Template not found: ${name}`);
      continue;
    }

    const filenames = extractImageFilenames(loaded.content);
    loadedTemplates.push({ name: loaded.name || normalizeTemplateName(name), source: loaded.source, count: filenames.size });
    filenames.forEach((filename) => allFilenames.add(filename));
  }

  const filenames = [...allFilenames].sort();
  if (!filenames.length) {
    throw new Error('No shopify://shop_images/ references found in provided templates');
  }

  log(`Templates loaded: ${loadedTemplates.length}`);
  loadedTemplates.forEach((item) => log(`  - ${item.name} (${item.count} refs) from ${item.source}`));
  log(`Unique images total: ${filenames.length}`);
  log(`Source: ${config.source.shop}`);
  log(`Target: ${config.target.shop}`);
  log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  const results = [];

  for (const filename of filenames) {
    const sourceFile = await findFileByFilename(sourceClient, filename);
    const sourceUrl = getFileUrl(sourceFile);

    if (!sourceUrl) {
      results.push({ filename, status: 'failed', error: 'Not found on source store' });
      continue;
    }

    const targetFile = await findFileByFilename(targetClient, filename);
    if (getFileUrl(targetFile)) {
      results.push({ filename, status: 'skipped' });
      continue;
    }

    if (dryRun) {
      results.push({ filename, status: 'planned' });
      continue;
    }

    try {
      await createFileOnTarget(targetClient, {
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
  console.error(`\nTemplate file sync failed: ${error.message}`);
  process.exitCode = 1;
});
