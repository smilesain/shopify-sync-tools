import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

/**
 * Parse CLI args shared by sync-template-files / sync-template-videos.
 * Supports:
 *   --dir=C:\theme\templates
 *   --dir C:\theme\templates
 *   absolute/relative .json paths
 *   bare filenames (resolved against --dir / fallback dirs)
 */
export function parseTemplateCliArgs(argv, { defaultDir } = {}) {
  const dryRun = argv.includes('--dry-run');
  const raw = argv.filter((arg) => arg !== '--dry-run');
  let templatesDir = defaultDir ? resolve(defaultDir) : null;
  const entries = [];

  for (let i = 0; i < raw.length; i += 1) {
    const arg = raw[i];
    if (arg === '--dir' || arg === '--templates-dir') {
      const next = raw[i + 1];
      if (!next) throw new Error(`${arg} requires a path value`);
      templatesDir = resolve(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--dir=')) {
      templatesDir = resolve(arg.slice('--dir='.length));
      continue;
    }
    if (arg.startsWith('--templates-dir=')) {
      templatesDir = resolve(arg.slice('--templates-dir='.length));
      continue;
    }
    entries.push(arg);
  }

  return { dryRun, templatesDir, entries };
}

export function normalizeTemplateName(name) {
  const base = basename(String(name || '').trim());
  if (!base) return base;
  return base.startsWith('product.') ? base : `product.${base}`;
}

/**
 * Resolve a template entry to an existing local file path, if possible.
 * @param {string} entry filename, relative path, or absolute path
 * @param {{ templatesDir?: string | null, extraDirs?: string[] }} options
 */
export function resolveLocalTemplateFile(entry, { templatesDir = null, extraDirs = [] } = {}) {
  const trimmed = String(entry || '').trim();
  if (!trimmed) return null;

  const direct = resolve(trimmed);
  if (existsSync(direct) && statSync(direct).isFile()) {
    return direct;
  }

  const base = basename(trimmed);
  const candidates = new Set([base]);
  if (base.endsWith('.json')) {
    candidates.add(normalizeTemplateName(base));
  }

  const searchDirs = [];
  if (templatesDir) searchDirs.push(resolve(templatesDir));
  for (const dir of extraDirs || []) {
    if (dir) searchDirs.push(resolve(dir));
  }

  for (const dir of searchDirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (existsSync(full) && statSync(full).isFile()) {
        return full;
      }
    }
  }

  return null;
}

export function isJsonPath(value) {
  return String(value || '').toLowerCase().endsWith('.json');
}

export function looksLikeFilesystemPath(value) {
  const v = String(value || '');
  return isAbsolute(v) || v.includes('/') || v.includes('\\') || /^[A-Za-z]:[\\/]/.test(v);
}
