import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ERROR_RE = /error|failed|fatal|userErrors|access denied|invalid/i;

function durationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

function countByStatus(steps, status) {
  return steps.filter((step) => step.status === status).length;
}

export function jobReportFilename(job) {
  const stamp = String(job.startedAt || new Date().toISOString())
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const short = String(job.id || 'job').replace(/-/g, '').slice(0, 8);
  return `job-${stamp}-${short}.json`;
}

export function plannedSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map((step) => ({
    id: step.id,
    label: step.label,
    command: `node ${step.args.join(' ')}`,
    status: 'pending',
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  }));
}

export function pickJobInputs(payload = {}) {
  return {
    productIds: payload.productIds ?? payload.productId ?? '',
    collectionHandle: payload.collectionHandle || '',
    pageHandle: payload.pageHandle || '',
    pageSyncAll: Boolean(payload.pageSyncAll),
    articleHandle: payload.articleHandle || '',
    articleSyncAll: Boolean(payload.articleSyncAll),
    collectionSyncAll: Boolean(payload.collectionSyncAll),
    productSyncAll: Boolean(payload.productSyncAll),
    menuSyncAll: Boolean(payload.menuSyncAll),
    menuHandle: payload.menuHandle || '',
    metaobjectTypes: payload.metaobjectTypes || '',
    metafieldKeys: payload.metafieldKeys || '',
    templatesDir: payload.templatesDir || '',
    templates: Array.isArray(payload.templates) ? payload.templates : [],
    templatePaths: payload.templatePaths || '',
  };
}

export function buildJobReport(job) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const logs = Array.isArray(job.logs) ? job.logs : [];
  const summary = {
    total: steps.length,
    success: countByStatus(steps, 'success'),
    failed: countByStatus(steps, 'failed'),
    skipped: countByStatus(steps, 'skipped'),
    cancelled: countByStatus(steps, 'cancelled'),
    pending: countByStatus(steps, 'pending'),
  };

  return {
    kind: 'job',
    id: job.id,
    status: job.status,
    dryRun: Boolean(job.dryRun),
    modules: job.modules || [],
    sourceShop: job.sourceShop || null,
    targetShop: job.targetShop || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    durationMs: durationMs(job.startedAt, job.finishedAt || new Date().toISOString()),
    exitCode: job.exitCode ?? null,
    inputs: job.inputs || {},
    steps,
    summary,
    logCount: logs.length,
    logTail: logs.slice(-80),
    errors: logs.filter((line) => ERROR_RE.test(String(line))).slice(-40),
  };
}

export function writeJobReport(job, reportsDir) {
  mkdirSync(reportsDir, { recursive: true });
  const name = jobReportFilename(job);
  const full = join(reportsDir, name);
  const report = buildJobReport(job);
  report.file = name;
  writeFileSync(full, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { name, path: full, report };
}

export function reportListItem(name, st, parsed) {
  const base = {
    name,
    size: st.size,
    mtime: st.mtime.toISOString(),
    kind: 'file',
    status: null,
    dryRun: null,
    modules: [],
    sourceShop: null,
    targetShop: null,
    summary: null,
  };

  if (!parsed || typeof parsed !== 'object') return base;

  if (parsed.kind === 'job') {
    return {
      ...base,
      kind: 'job',
      status: parsed.status || null,
      dryRun: Boolean(parsed.dryRun),
      modules: Array.isArray(parsed.modules) ? parsed.modules : [],
      sourceShop: parsed.sourceShop || null,
      targetShop: parsed.targetShop || null,
      summary: parsed.summary || null,
    };
  }

  if (parsed.metaobjects || parsed.metafields) {
    const modules = [];
    if (parsed.only === 'all' || parsed.only === 'metaobjects') modules.push('metaobjects');
    if (parsed.only === 'all' || parsed.only === 'metafields') modules.push('metafields');
    return {
      ...base,
      kind: 'cli',
      status: null,
      dryRun: parsed.dryRun ?? null,
      modules: parsed.only && parsed.only !== 'all' ? [parsed.only] : modules,
      sourceShop: parsed.sourceShop || null,
      targetShop: parsed.targetShop || null,
      summary: null,
    };
  }

  return base;
}

export function readReportJson(fullPath) {
  try {
    return JSON.parse(readFileSync(fullPath, 'utf8'));
  } catch {
    return null;
  }
}
