const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ShopifyClient {
  constructor({ shop, accessToken, apiVersion, mutationDelayMs = 200 }) {
    this.shop = shop;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion;
    this.mutationDelayMs = mutationDelayMs;
    this.endpoint = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
  }

  async query(document, variables = {}, { isMutation = false, allowErrors = false } = {}) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.accessToken,
      },
      body: JSON.stringify({ query: document, variables }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status} from ${this.shop}: ${body}`);
    }

    const payload = await response.json();

    if (payload.errors?.length && !allowErrors) {
      const messages = payload.errors.map((error) => error.message).join('; ');
      throw new Error(`GraphQL error from ${this.shop}: ${messages}`);
    }

    if (isMutation && this.mutationDelayMs > 0) {
      await sleep(this.mutationDelayMs);
    }

    return payload;
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
