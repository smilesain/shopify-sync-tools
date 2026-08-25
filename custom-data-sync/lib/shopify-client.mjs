const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response) {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function isThrottled(payload) {
  return (payload?.errors || []).some((error) => {
    const code = String(error?.extensions?.code || '').toUpperCase();
    return code === 'THROTTLED' || /throttl/i.test(error?.message || '');
  });
}

function backoffMs(attempt) {
  const exponential = Math.min(30_000, 750 * (2 ** attempt));
  return exponential + Math.floor(Math.random() * 350);
}

export class ShopifyClient {
  constructor({
    shop,
    accessToken,
    apiVersion,
    mutationDelayMs = 0,
    requestTimeoutMs = 45_000,
    maxRetries = 5,
  }) {
    this.shop = shop;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
    this.mutationDelayMs = mutationDelayMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxRetries = maxRetries;
    this.endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  }

  async query(document, variables = {}, { isMutation = false, allowErrors = false } = {}) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': this.accessToken,
          },
          body: JSON.stringify({ query: document, variables }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text();
          const retriable = response.status === 429 || response.status >= 500;
          if (retriable && attempt < this.maxRetries) {
            await sleep(retryAfterMs(response) ?? backoffMs(attempt));
            continue;
          }
          throw new Error(`HTTP ${response.status} from ${this.shop}: ${body}`);
        }

        const payload = await response.json();
        if (isThrottled(payload)) {
          if (attempt < this.maxRetries) {
            await sleep(this.throttleDelayMs(payload) || backoffMs(attempt));
            continue;
          }
          throw new Error(`GraphQL throttled after ${this.maxRetries + 1} attempts for ${this.shop}`);
        }

        if (payload.errors?.length && !allowErrors) {
          const messages = payload.errors.map((error) => error.message).join('; ');
          throw new Error(`GraphQL error from ${this.shop}: ${messages}`);
        }

        const adaptiveDelay = this.throttleDelayMs(payload);
        const configuredDelay = isMutation ? this.mutationDelayMs : 0;
        const delay = Math.max(adaptiveDelay, configuredDelay);
        if (delay > 0) await sleep(delay);

        return payload;
      } catch (error) {
        const networkError =
          error?.name === 'AbortError' ||
          error instanceof TypeError ||
          /fetch failed|network|socket|timed out/i.test(error?.message || '');
        if (networkError && attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        if (error?.name === 'AbortError') {
          throw new Error(`Request timed out after ${this.requestTimeoutMs}ms for ${this.shop}`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error(`Request retries exhausted for ${this.shop}`);
  }

  throttleDelayMs(payload) {
    const cost = payload?.extensions?.cost;
    const throttle = cost?.throttleStatus;
    const available = Number(throttle?.currentlyAvailable);
    const restoreRate = Number(throttle?.restoreRate);
    const actualCost = Number(cost?.actualQueryCost || cost?.requestedQueryCost || 0);
    if (!Number.isFinite(available) || !Number.isFinite(restoreRate) || restoreRate <= 0) {
      return 0;
    }

    const reserve = Math.max(50, actualCost * 2);
    if (available >= reserve) return 0;
    return Math.ceil(((reserve - available) / restoreRate) * 1000);
  }

  async paginate(connectionPath, document, variables, extractConnection) {
    const items = [];
    let cursor = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const payload = await this.query(document, { ...variables, cursor });
      const connection = extractConnection(payload.data);

      if (!connection) {
        throw new Error(`Could not find connection at ${connectionPath}`);
      }

      items.push(...(connection.nodes || []));
      hasNextPage = connection.pageInfo?.hasNextPage ?? false;
      cursor = connection.pageInfo?.endCursor ?? null;
    }

    return items;
  }
}

export function isAppOwnedNamespace(namespace) {
  return namespace.startsWith('$app') || namespace.startsWith('app--');
}

export function isRestrictedNamespace(namespace) {
  return (
    isAppOwnedNamespace(namespace) ||
    namespace === 'shopify' ||
    namespace.startsWith('shopify--')
  );
}

export function isAppOwnedMetaobjectType(type) {
  return type.startsWith('$app:') || type.startsWith('app--');
}

export function isRestrictedMetaobjectType(type) {
  return isAppOwnedMetaobjectType(type) || type.startsWith('shopify--');
}

export function definitionKey(ownerType, namespace, key) {
  return `${ownerType}:${namespace}:${key}`;
}

export function metaobjectTypeKey(type) {
  return type.trim().toLowerCase();
}
