import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, '..', 'data');
export const STORES_PATH = join(DATA_DIR, 'stores.json');
export const SELECTION_PATH = join(DATA_DIR, 'selection.json');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function normalizeShop(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function storeAuthReady(store) {
  // Primary auth model: Admin API access token.
  // Legacy client credentials remain valid if already saved locally.
  if (store.accessToken) return true;
  return Boolean(store.clientId && store.clientSecret);
}

export function toPublicStore(store) {
  return {
    id: store.id,
    name: store.name,
    shop: store.shop,
    hasAccessToken: Boolean(store.accessToken),
    hasClientId: Boolean(store.clientId),
    hasClientSecret: Boolean(store.clientSecret),
    authReady: storeAuthReady(store),
    createdAt: store.createdAt,
    updatedAt: store.updatedAt,
  };
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  ensureDataDir();
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function loadStores() {
  const data = readJson(STORES_PATH, { stores: [] });
  return Array.isArray(data.stores) ? data.stores : [];
}

export function saveStores(stores) {
  writeJson(STORES_PATH, { version: 1, updatedAt: new Date().toISOString(), stores });
}

export function loadSelection() {
  const data = readJson(SELECTION_PATH, { sourceId: null, targetId: null, templatesDir: null });
  return {
    sourceId: data.sourceId || null,
    targetId: data.targetId || null,
    templatesDir: data.templatesDir || null,
  };
}

export function saveSelection(selection) {
  writeJson(SELECTION_PATH, {
    sourceId: selection.sourceId || null,
    targetId: selection.targetId || null,
    templatesDir: selection.templatesDir || null,
    updatedAt: new Date().toISOString(),
  });
}

export function getStoreById(id) {
  return loadStores().find((store) => store.id === id) || null;
}

export function upsertStore(input, existingId = null) {
  const stores = loadStores();
  const shop = normalizeShop(input.shop);
  if (!shop) throw new Error('shop is required (e.g. example.myshopify.com)');
  if (!shop.includes('.')) throw new Error('shop must be a domain like example.myshopify.com');

  const name = String(input.name || '').trim() || shop.split('.')[0];
  const now = new Date().toISOString();

  if (existingId) {
    const index = stores.findIndex((store) => store.id === existingId);
    if (index === -1) throw new Error('Store not found');
    const prev = stores[index];
    const next = {
      ...prev,
      name,
      shop,
      updatedAt: now,
    };

    if (Object.prototype.hasOwnProperty.call(input, 'accessToken')) {
      const token = String(input.accessToken || '').trim();
      if (token && token !== '__KEEP__') next.accessToken = token;
      if (input.accessToken === '') next.accessToken = '';
    }
    if (Object.prototype.hasOwnProperty.call(input, 'clientId')) {
      const clientId = String(input.clientId || '').trim();
      if (clientId && clientId !== '__KEEP__') next.clientId = clientId;
      if (input.clientId === '') next.clientId = '';
    }
    if (Object.prototype.hasOwnProperty.call(input, 'clientSecret')) {
      const secret = String(input.clientSecret || '').trim();
      if (secret && secret !== '__KEEP__') next.clientSecret = secret;
      if (input.clientSecret === '') next.clientSecret = '';
    }

    if (!storeAuthReady(next)) {
      throw new Error('Store needs an Admin API access token (accessToken)');
    }

    stores[index] = next;
    saveStores(stores);
    return next;
  }

  const duplicate = stores.find((store) => store.shop === shop);
  if (duplicate) throw new Error(`Store already exists: ${shop}`);

  const accessToken = String(input.accessToken || '').trim();
  const clientId = String(input.clientId || '').trim();
  const clientSecret = String(input.clientSecret || '').trim();
  const store = {
    id: randomUUID(),
    name,
    shop,
    accessToken,
    clientId,
    clientSecret,
    createdAt: now,
    updatedAt: now,
  };
  if (!accessToken && !(clientId && clientSecret)) {
    throw new Error('Admin API access token is required');
  }
  if (!storeAuthReady(store)) {
    throw new Error('Admin API access token is required');
  }
  stores.push(store);
  saveStores(stores);
  return store;
}

export function deleteStore(id) {
  const stores = loadStores();
  const next = stores.filter((store) => store.id !== id);
  if (next.length === stores.length) throw new Error('Store not found');
  saveStores(next);

  const selection = loadSelection();
  let changed = false;
  if (selection.sourceId === id) {
    selection.sourceId = null;
    changed = true;
  }
  if (selection.targetId === id) {
    selection.targetId = null;
    changed = true;
  }
  if (changed) saveSelection(selection);
}

/**
 * Seed stores.json from custom-data-sync/.env when empty.
 */
export function importFromEnvFile(envPath) {
  if (!existsSync(envPath)) {
    return { imported: 0, message: `.env not found at ${envPath}` };
  }

  const env = {};
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[line.slice(0, i).trim()] = value;
  }

  const existing = loadStores();
  const byShop = new Map(existing.map((store) => [store.shop, store]));
  const created = [];
  const selection = loadSelection();

  const pairs = [
    {
      name: 'Source (from .env)',
      shop: env.SOURCE_STORE || env.SOURCE_SHOP,
      accessToken: env.SOURCE_ACCESS_TOKEN || env.SOURCE_TOKEN || '',
      clientId: env.SOURCE_CLIENT_ID || '',
      clientSecret: env.SOURCE_CLIENT_SECRET || '',
      role: 'source',
    },
    {
      name: 'Target (from .env)',
      shop: env.TARGET_STORE || env.TARGET_SHOP,
      accessToken: env.TARGET_ACCESS_TOKEN || env.TARGET_TOKEN || '',
      clientId: env.TARGET_CLIENT_ID || '',
      clientSecret: env.TARGET_CLIENT_SECRET || '',
      role: 'target',
    },
  ];

  for (const item of pairs) {
    const shop = normalizeShop(item.shop);
    if (!shop) continue;

    const found = byShop.get(shop);
    if (found) {
      if (item.role === 'source' && !selection.sourceId) selection.sourceId = found.id;
      if (item.role === 'target' && !selection.targetId) selection.targetId = found.id;
      continue;
    }

    try {
      const store = upsertStore({
        name: item.name,
        shop,
        accessToken: item.accessToken,
        clientId: item.clientId,
        clientSecret: item.clientSecret,
      });
      created.push(store);
      byShop.set(shop, store);
      if (item.role === 'source') selection.sourceId = store.id;
      if (item.role === 'target') selection.targetId = store.id;
    } catch {
      /* skip incomplete pair */
    }
  }

  saveSelection(selection);
  return {
    imported: created.length,
    message: created.length
      ? `Imported ${created.length} store(s) from .env`
      : 'No new stores imported (already present or credentials incomplete)',
  };
}

export function buildJobEnv(baseEnv, source, target, apiVersion = '2025-01') {
  const env = { ...baseEnv };

  // Clear previous pair so leftover .env values cannot leak into the wrong shop.
  for (const key of [
    'SOURCE_STORE',
    'SOURCE_SHOP',
    'SOURCE_ACCESS_TOKEN',
    'SOURCE_TOKEN',
    'SOURCE_CLIENT_ID',
    'SOURCE_CLIENT_SECRET',
    'TARGET_STORE',
    'TARGET_SHOP',
    'TARGET_ACCESS_TOKEN',
    'TARGET_TOKEN',
    'TARGET_CLIENT_ID',
    'TARGET_CLIENT_SECRET',
  ]) {
    delete env[key];
  }

  env.SOURCE_STORE = source.shop;
  env.TARGET_STORE = target.shop;
  env.SHOPIFY_API_VERSION = env.SHOPIFY_API_VERSION || apiVersion;

  if (source.accessToken) env.SOURCE_ACCESS_TOKEN = source.accessToken;
  if (source.clientId) env.SOURCE_CLIENT_ID = source.clientId;
  if (source.clientSecret) env.SOURCE_CLIENT_SECRET = source.clientSecret;

  if (target.accessToken) env.TARGET_ACCESS_TOKEN = target.accessToken;
  if (target.clientId) env.TARGET_CLIENT_ID = target.clientId;
  if (target.clientSecret) env.TARGET_CLIENT_SECRET = target.clientSecret;

  return env;
}
