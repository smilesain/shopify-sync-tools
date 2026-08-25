#!/usr/bin/env node
/**
 * Visual sync console for Shopify sub-store material sync.
 * Wraps ../custom-data-sync CLI scripts — secrets stay server-side.
 *
 * Usage (from repo root):
 *   node sync-console/server.mjs
 *   open http://127.0.0.1:8787
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  createReadStream,
} from 'node:fs';
import { basename, extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  DATA_DIR,
  STORES_PATH,
  buildJobEnv,
  deleteStore,
  getStoreById,
  importFromEnvFile,
  loadSelection,
  loadStores,
  saveSelection,
  toPublicStore,
  upsertStore,
} from './lib/stores.mjs';
import {
  pickJobInputs,
  plannedSteps,
  readReportJson,
  reportListItem,
  writeJobReport,
} from './lib/job-report.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SYNC_DIR = resolve(__dirname, '../custom-data-sync');
const PUBLIC_DIR = join(__dirname, 'public');
const DEFAULT_TEMPLATES_DIR = resolve(
  process.env.TEMPLATES_DIR || join(REPO_ROOT, 'templates'),
);
const REPORTS_DIR = join(SYNC_DIR, 'reports');
const ENV_PATH = join(SYNC_DIR, '.env');
const PORT = Number(process.env.SYNC_CONSOLE_PORT || 8787);
const HOST = process.env.SYNC_CONSOLE_HOST || '127.0.0.1';

/** @type {Map<string, Job>} */
const jobs = new Map();

/**
 * @typedef {{
 *   id: string,
 *   status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled',
 *   dryRun: boolean,
 *   modules: string[],
 *   sourceShop?: string,
 *   targetShop?: string,
 *   startedAt: string,
 *   finishedAt?: string,
 *   exitCode?: number | null,
 *   logs: string[],
 *   steps: object[],
 *   inputs?: object,
 *   reportName?: string,
 *   listeners: Set<(line: string) => void>,
 *   child?: import('node:child_process').ChildProcess,
 *   env?: Record<string, string | undefined>,
 * }} Job
 */

function parseEnvFile(content) {
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
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

function loadBaseEnv() {
  const env = { ...process.env };
  if (existsSync(ENV_PATH)) {
    Object.assign(env, parseEnvFile(readFileSync(ENV_PATH, 'utf8')));
  }
  // Prefer process.env overrides last
  return { ...env, ...process.env };
}

function getPublicConfig() {
  const stores = loadStores().map(toPublicStore);
  const selection = loadSelection();
  const source = selection.sourceId ? getStoreById(selection.sourceId) : null;
  const target = selection.targetId ? getStoreById(selection.targetId) : null;
  const base = loadBaseEnv();

  return {
    sourceStore: source?.shop || null,
    targetStore: target?.shop || null,
    sourceName: source?.name || null,
    targetName: target?.name || null,
    sourceId: selection.sourceId,
    targetId: selection.targetId,
    sourceAuth: Boolean(source && toPublicStore(source).authReady),
    targetAuth: Boolean(target && toPublicStore(target).authReady),
    apiVersion: base.SHOPIFY_API_VERSION || '2025-01',
    storesPath: STORES_PATH,
    dataDir: DATA_DIR,
    envPath: ENV_PATH,
    syncDir: SYNC_DIR,
    templatesDir: resolveTemplatesDir(loadSelection().templatesDir),
    defaultTemplatesDir: DEFAULT_TEMPLATES_DIR,
    storeCount: stores.length,
  };
}

function resolveTemplatesDir(raw) {
  const fallback = DEFAULT_TEMPLATES_DIR;
  const value = String(raw || '').trim();
  return resolve(value || fallback);
}

function listTemplates(dirInput) {
  const dir = resolveTemplatesDir(dirInput);
  if (!existsSync(dir)) {
    return { dir, exists: false, templates: [], error: `目录不存在: ${dir}` };
  }
  const st = statSync(dir);
  if (!st.isDirectory()) {
    return { dir, exists: false, templates: [], error: `不是目录: ${dir}` };
  }
  const templates = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const full = join(dir, name);
      const fileStat = statSync(full);
      return {
        name,
        path: full,
        size: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { dir, exists: true, templates, error: null };
}

function parseExtraTemplatePaths(raw) {
  return String(raw || '')
    .split(/[\r\n,;]+/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter((item) => item && item.toLowerCase().endsWith('.json'));
}

function collectTemplateArgs(payload) {
  const templatesDir = resolveTemplatesDir(payload.templatesDir);
  const selected = Array.isArray(payload.templates)
    ? payload.templates.map((t) => String(t).trim()).filter(Boolean)
    : [];
  const extras = parseExtraTemplatePaths(payload.templatePaths);

  /** @type {string[]} */
  const resolved = [];
  for (const item of [...selected, ...extras]) {
    const asPath = resolve(item);
    if (existsSync(asPath) && statSync(asPath).isFile()) {
      resolved.push(asPath);
      continue;
    }
    const inDir = join(templatesDir, basename(item));
    if (existsSync(inDir) && statSync(inDir).isFile()) {
      resolved.push(inDir);
      continue;
    }
    // Keep basename for CLI fallback / remote theme lookup
    resolved.push(basename(item));
  }

  const unique = [...new Set(resolved)];
  return { templatesDir, templates: unique };
}

function listReports() {
  if (!existsSync(REPORTS_DIR)) return [];
  return readdirSync(REPORTS_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const full = join(REPORTS_DIR, name);
      const st = statSync(full);
      return reportListItem(name, st, readReportJson(full));
    })
    .sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
    .slice(0, 40);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.split('?')[0];
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  res.writeHead(200, { 'Content-Type': contentType(filePath) });
  createReadStream(filePath).pipe(res);
}

function appendLog(job, line) {
  const text = String(line).replace(/\r/g, '');
  for (const part of text.split('\n')) {
    job.logs.push(part);
    if (job.logs.length > 4000) job.logs.shift();
    for (const listener of job.listeners) listener(part);
  }
}

function buildSteps(payload) {
  const dry = Boolean(payload.dryRun);
  const dryArgs = dry ? ['--dry-run'] : [];
  const modules = Array.isArray(payload.modules) ? payload.modules : [];
  const { templatesDir, templates } = collectTemplateArgs(payload);
  /** @type {{ id: string, label: string, command: string, args: string[] }[]} */
  const steps = [];

  if (modules.includes('metaobjects') && modules.includes('metafields')) {
    steps.push({
      id: 'custom-data',
      label: 'Metafield + Metaobject definitions',
      command: process.execPath,
      args: ['sync.mjs', ...dryArgs],
    });
  } else if (modules.includes('metaobjects')) {
    steps.push({
      id: 'metaobjects',
      label: 'Metaobject definitions',
      command: process.execPath,
      args: ['sync.mjs', '--only', 'metaobjects', ...dryArgs],
    });
  } else if (modules.includes('metafields')) {
    steps.push({
      id: 'metafields',
      label: 'Metafield definitions',
      command: process.execPath,
      args: ['sync.mjs', '--only', 'metafields', ...dryArgs],
    });
  }

  if (modules.includes('product')) {
    const syncAllProducts = Boolean(payload.productSyncAll);
    if (syncAllProducts) {
      steps.push({
        id: 'product-all',
        label: 'Products: ALL',
        command: process.execPath,
        args: ['sync-product.mjs', '--all', ...dryArgs],
      });
    } else {
      const raw =
        payload.productIds ??
        payload.productId ??
        '';
      const productIds = String(raw)
        .split(/[\s,;]+/)
        .map((id) => id.trim().replace(/^gid:\/\/shopify\/Product\//i, ''))
        .filter(Boolean);
      const uniqueIds = [...new Set(productIds)];
      if (!uniqueIds.length) {
        throw new Error('Enter at least one numeric Shopify product ID');
      }
      const invalid = uniqueIds.filter((id) => !/^\d+$/.test(id));
      if (invalid.length) {
        throw new Error(`Invalid product ID(s): ${invalid.join(', ')}`);
      }
      for (const productId of uniqueIds) {
        steps.push({
          id: `product-${productId}`,
          label: `Product: ${productId}`,
          command: process.execPath,
          args: ['sync-product.mjs', productId, ...dryArgs],
        });
      }
    }
  }

  if (modules.includes('collection')) {
    const syncAllCollections = Boolean(payload.collectionSyncAll);
    if (syncAllCollections) {
      steps.push({
        id: 'collection-all',
        label: 'Collections: ALL',
        command: process.execPath,
        args: ['sync-collection.mjs', '--all', ...dryArgs],
      });
    } else {
      const handle = String(payload.collectionHandle || 'robot-vacuums').trim() || 'robot-vacuums';
      steps.push({
        id: 'collection',
        label: `Collection: ${handle}`,
        command: process.execPath,
        args: ['sync-collection.mjs', handle, ...dryArgs],
      });
    }
  }

  if (modules.includes('page')) {
    const syncAllPages = Boolean(payload.pageSyncAll);
    if (syncAllPages) {
      steps.push({
        id: 'page-all',
        label: 'Pages: ALL',
        command: process.execPath,
        args: ['sync-page.mjs', '--all', ...dryArgs],
      });
    } else {
      const handle = String(payload.pageHandle || 'about-us').trim() || 'about-us';
      steps.push({
        id: 'page',
        label: `Page: ${handle}`,
        command: process.execPath,
        args: ['sync-page.mjs', handle, ...dryArgs],
      });
    }
  }

  if (modules.includes('article')) {
    const syncAllArticles = Boolean(payload.articleSyncAll);
    if (syncAllArticles) {
      steps.push({
        id: 'article-all',
        label: 'Blog articles: ALL',
        command: process.execPath,
        args: ['sync-article.mjs', '--all', ...dryArgs],
      });
    } else {
      const handle = String(payload.articleHandle || 'test').trim() || 'test';
      steps.push({
        id: 'article',
        label: `Blog article: ${handle}`,
        command: process.execPath,
        args: ['sync-article.mjs', handle, ...dryArgs],
      });
    }
  }

  if (modules.includes('menu')) {
    const syncAllMenus = Boolean(payload.menuSyncAll);
    if (syncAllMenus) {
      steps.push({
        id: 'menu-all',
        label: 'Menus: ALL',
        command: process.execPath,
        args: ['sync-menu.mjs', '--all', ...dryArgs],
      });
    } else {
      const handle = String(payload.menuHandle || '').trim();
      if (!handle) throw new Error('menuHandle is required when syncing menus');
      steps.push({
        id: 'menu',
        label: `Menu: ${handle}`,
        command: process.execPath,
        args: ['sync-menu.mjs', handle, ...dryArgs],
      });
    }
  }

  if (modules.includes('template-files')) {
    if (!templates.length) throw new Error('Select at least one template (or paste file paths) for template-files sync');
    steps.push({
      id: 'template-files',
      label: `Template images (${templates.length})`,
      command: process.execPath,
      args: ['sync-template-files.mjs', `--dir=${templatesDir}`, ...templates, ...dryArgs],
    });
  }

  if (modules.includes('template-videos')) {
    if (!templates.length) throw new Error('Select at least one template (or paste file paths) for template-videos sync');
    steps.push({
      id: 'template-videos',
      label: `Template videos (${templates.length})`,
      command: process.execPath,
      args: ['sync-template-videos.mjs', `--dir=${templatesDir}`, ...templates, ...dryArgs],
    });
  }

  if (!steps.length) throw new Error('Select at least one sync module');
  return steps;
}

function resolvePair(payload) {
  const selection = loadSelection();
  const sourceId = payload.sourceId || selection.sourceId;
  const targetId = payload.targetId || selection.targetId;
  if (!sourceId || !targetId) {
    throw new Error('请先选择源站和目标站');
  }
  if (sourceId === targetId) {
    throw new Error('源站和目标站不能相同');
  }
  const source = getStoreById(sourceId);
  const target = getStoreById(targetId);
  if (!source) throw new Error('源站配置不存在');
  if (!target) throw new Error('目标站配置不存在');
  if (!toPublicStore(source).authReady) throw new Error('源站凭证不完整');
  if (!toPublicStore(target).authReady) throw new Error('目标站凭证不完整');
  return { source, target, sourceId, targetId };
}

function findStepRecord(job, stepId) {
  return (job.steps || []).find((item) => item.id === stepId);
}

function markRemainingSteps(job, status) {
  for (const record of job.steps || []) {
    if (record.status === 'pending' || record.status === 'running') {
      record.status = status;
    }
  }
}

function persistJobReport(job) {
  try {
    const { name, path } = writeJobReport(job, REPORTS_DIR);
    job.reportName = name;
    appendLog(job, `Job report written to ${path}`);
  } catch (error) {
    appendLog(job, `WARN: failed to write job report: ${error.message}`);
  }
}

function runCommand(job, step) {
  return new Promise((resolvePromise) => {
    appendLog(job, `\n▶ ${step.label}`);
    appendLog(job, `$ node ${step.args.join(' ')}`);

    const child = spawn(step.command, step.args, {
      cwd: SYNC_DIR,
      env: job.env || loadBaseEnv(),
      shell: false,
      windowsHide: true,
    });
    job.child = child;

    child.stdout.on('data', (buf) => appendLog(job, buf.toString('utf8')));
    child.stderr.on('data', (buf) => appendLog(job, buf.toString('utf8')));
    child.on('error', (error) => {
      appendLog(job, `ERROR: ${error.message}`);
      resolvePromise(1);
    });
    child.on('close', (code) => {
      job.child = undefined;
      appendLog(job, `← exit ${code ?? 'null'}`);
      resolvePromise(code ?? 1);
    });
  });
}

async function runJob(job, steps) {
  job.status = 'running';
  let failed = false;

  for (const step of steps) {
    const record = findStepRecord(job, step.id);
    if (job.status === 'cancelled') {
      markRemainingSteps(job, 'cancelled');
      break;
    }
    if (record) {
      record.status = 'running';
      record.startedAt = new Date().toISOString();
    }
    const code = await runCommand(job, step);
    if (record) {
      record.finishedAt = new Date().toISOString();
      record.exitCode = code;
      const started = Date.parse(record.startedAt);
      const finished = Date.parse(record.finishedAt);
      record.durationMs =
        Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : null;
      if (job.status === 'cancelled') record.status = 'cancelled';
      else record.status = code === 0 ? 'success' : 'failed';
    }
    if (job.status === 'cancelled') {
      markRemainingSteps(job, 'cancelled');
      break;
    }
    if (code !== 0) {
      failed = true;
      markRemainingSteps(job, 'skipped');
      appendLog(job, `Step failed: ${step.id}`);
      break;
    }
  }

  job.finishedAt = new Date().toISOString();
  if (job.status === 'cancelled') {
    job.exitCode = job.exitCode ?? 1;
    appendLog(job, 'Job cancelled');
  } else if (failed) {
    job.status = 'failed';
    job.exitCode = 1;
    appendLog(job, 'Job failed');
  } else {
    job.status = 'success';
    job.exitCode = 0;
    appendLog(job, 'Job completed');
  }

  persistJobReport(job);
  for (const listener of job.listeners) listener('__DONE__');
}

function jobPublic(job) {
  return {
    id: job.id,
    status: job.status,
    dryRun: job.dryRun,
    modules: job.modules,
    sourceShop: job.sourceShop || null,
    targetShop: job.targetShop || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    exitCode: job.exitCode ?? null,
    logCount: job.logs.length,
    reportName: job.reportName || null,
  };
}

function storesPayload() {
  return {
    stores: loadStores().map(toPublicStore),
    selection: loadSelection(),
  };
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, getPublicConfig());
  }

  if (req.method === 'GET' && pathname === '/api/stores') {
    return sendJson(res, 200, storesPayload());
  }

  if (req.method === 'POST' && pathname === '/api/stores/import-env') {
    const result = importFromEnvFile(ENV_PATH);
    return sendJson(res, 200, { ...result, ...storesPayload() });
  }

  if (req.method === 'POST' && pathname === '/api/stores') {
    let payload;
    try {
      payload = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    try {
      const store = upsertStore(payload);
      return sendJson(res, 201, { store: toPublicStore(store), ...storesPayload() });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === 'PUT' && pathname.match(/^\/api\/stores\/[^/]+$/)) {
    const id = pathname.split('/').pop();
    let payload;
    try {
      payload = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    try {
      const store = upsertStore(payload, id);
      return sendJson(res, 200, { store: toPublicStore(store), ...storesPayload() });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === 'DELETE' && pathname.match(/^\/api\/stores\/[^/]+$/)) {
    const id = pathname.split('/').pop();
    try {
      deleteStore(id);
      return sendJson(res, 200, storesPayload());
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === 'PUT' && pathname === '/api/selection') {
    let payload;
    try {
      payload = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    const sourceId = payload.sourceId || null;
    const targetId = payload.targetId || null;
    if (sourceId && !getStoreById(sourceId)) {
      return sendJson(res, 400, { error: 'Invalid sourceId' });
    }
    if (targetId && !getStoreById(targetId)) {
      return sendJson(res, 400, { error: 'Invalid targetId' });
    }
    if (sourceId && targetId && sourceId === targetId) {
      return sendJson(res, 400, { error: '源站和目标站不能相同' });
    }
    saveSelection({
      sourceId,
      targetId,
      templatesDir: payload.templatesDir
        ? resolveTemplatesDir(payload.templatesDir)
        : loadSelection().templatesDir,
    });
    return sendJson(res, 200, { ...storesPayload(), config: getPublicConfig() });
  }

  if (req.method === 'GET' && pathname === '/api/templates') {
    const dir = url.searchParams.get('dir');
    const listed = listTemplates(dir || loadSelection().templatesDir);
    return sendJson(res, 200, listed);
  }

  if (req.method === 'PUT' && pathname === '/api/templates-dir') {
    let payload;
    try {
      payload = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    const dir = resolveTemplatesDir(payload.templatesDir);
    const listed = listTemplates(dir);
    const selection = loadSelection();
    saveSelection({ ...selection, templatesDir: dir });
    return sendJson(res, 200, {
      ...listed,
      config: getPublicConfig(),
    });
  }

  if (req.method === 'GET' && pathname === '/api/reports') {
    return sendJson(res, 200, { reports: listReports() });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/reports/')) {
    const name = basename(decodeURIComponent(pathname.slice('/api/reports/'.length)));
    const full = join(REPORTS_DIR, name);
    if (!full.startsWith(REPORTS_DIR) || !existsSync(full) || !name.endsWith('.json')) {
      return sendJson(res, 404, { error: 'Report not found' });
    }
    return sendJson(res, 200, JSON.parse(readFileSync(full, 'utf8')));
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    return sendJson(res, 200, {
      jobs: [...jobs.values()].map(jobPublic).reverse().slice(0, 30),
    });
  }

  if (req.method === 'GET' && pathname.match(/^\/api\/jobs\/[^/]+$/)) {
    const id = pathname.split('/').pop();
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: 'Job not found' });
    return sendJson(res, 200, { ...jobPublic(job), logs: job.logs });
  }

  if (req.method === 'GET' && pathname.match(/^\/api\/jobs\/[^/]+\/stream$/)) {
    const id = pathname.split('/')[3];
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: 'Job not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    send('status', jobPublic(job));
    for (const line of job.logs) send('log', { line });

    const onLine = (line) => {
      if (line === '__DONE__') {
        send('status', jobPublic(job));
        send('done', jobPublic(job));
        return;
      }
      send('log', { line });
    };
    job.listeners.add(onLine);

    if (job.status === 'success' || job.status === 'failed' || job.status === 'cancelled') {
      send('done', jobPublic(job));
    }

    req.on('close', () => {
      job.listeners.delete(onLine);
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/jobs') {
    const running = [...jobs.values()].find((j) => j.status === 'running' || j.status === 'queued');
    if (running) {
      return sendJson(res, 409, { error: 'Another job is already running', jobId: running.id });
    }

    let payload;
    try {
      payload = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }

    let steps;
    let pair;
    try {
      steps = buildSteps(payload);
      pair = resolvePair(payload);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }

    // Persist selection when job starts with explicit ids
    saveSelection({ sourceId: pair.sourceId, targetId: pair.targetId });

    const baseEnv = loadBaseEnv();
    const jobEnv = buildJobEnv(baseEnv, pair.source, pair.target, baseEnv.SHOPIFY_API_VERSION || '2025-01');

    const job = {
      id: randomUUID(),
      status: 'queued',
      dryRun: Boolean(payload.dryRun),
      modules: payload.modules || [],
      sourceShop: pair.source.shop,
      targetShop: pair.target.shop,
      startedAt: new Date().toISOString(),
      logs: [],
      steps: plannedSteps(steps),
      inputs: pickJobInputs(payload),
      listeners: new Set(),
      env: jobEnv,
    };
    jobs.set(job.id, job);
    appendLog(job, `Job ${job.id}`);
    appendLog(job, `Source → Target: ${pair.source.name} (${pair.source.shop}) → ${pair.target.name} (${pair.target.shop})`);
    appendLog(job, `Mode: ${job.dryRun ? 'DRY RUN' : 'LIVE'}`);
    appendLog(job, `Steps: ${steps.map((s) => s.id).join(', ')}`);

    setImmediate(() => {
      runJob(job, steps).catch((error) => {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.exitCode = 1;
        markRemainingSteps(job, 'skipped');
        appendLog(job, `FATAL: ${error.message}`);
        persistJobReport(job);
        for (const listener of job.listeners) listener('__DONE__');
      });
    });

    return sendJson(res, 201, jobPublic(job));
  }

  if (req.method === 'POST' && pathname.match(/^\/api\/jobs\/[^/]+\/cancel$/)) {
    const id = pathname.split('/')[3];
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: 'Job not found' });
    if (job.status !== 'running' && job.status !== 'queued') {
      return sendJson(res, 400, { error: 'Job is not running' });
    }
    job.status = 'cancelled';
    if (job.child) {
      try {
        job.child.kill();
      } catch {
        /* ignore */
      }
    }
    appendLog(job, 'Cancel requested');
    return sendJson(res, 200, jobPublic(job));
  }

  sendJson(res, 404, { error: 'Unknown API route' });
}

// Best-effort seed from .env on first boot when stores are empty.
try {
  if (loadStores().length === 0 && existsSync(ENV_PATH)) {
    const result = importFromEnvFile(ENV_PATH);
    if (result.imported > 0) {
      console.log(`[stores] ${result.message}`);
    }
  }
} catch (error) {
  console.warn(`[stores] import skipped: ${error.message}`);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Shopify Sync Console`);
  console.log(`Open http://${HOST}:${PORT}`);
  console.log(`Stores file: ${STORES_PATH}`);
  console.log(`Sync scripts: ${SYNC_DIR}`);
});
