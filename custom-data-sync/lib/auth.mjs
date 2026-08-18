const tokenCache = new Map();

function normalizeShop(shop) {
  return shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export async function fetchAccessToken({ shop, clientId, clientSecret }) {
  const normalizedShop = normalizeShop(shop);
  const cacheKey = `${normalizedShop}:${clientId}`;
  const cached = tokenCache.get(cacheKey);

  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }

  const response = await fetch(`https://${normalizedShop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    const oauthError = body.match(/Oauth error ([^:<]+)(?:: ([^<]+))?/i);
    const hint =
      oauthError?.[1] === 'shop_not_permitted'
        ? ' Ensure the Dev Dashboard app is installed on this store and the store belongs to your organization.'
        : oauthError?.[1] === 'application_cannot_be_found'
          ? ' Check CLIENT_ID and CLIENT_SECRET for this store.'
          : '';
    const detail = oauthError
      ? `${oauthError[1]}${oauthError[2] ? `: ${oauthError[2].trim()}` : ''}${hint}`
      : body.slice(0, 240);
    throw new Error(`Token request failed for ${normalizedShop}: HTTP ${response.status} ${detail}`);
  }

  const payload = await response.json();

  if (!payload.access_token) {
    throw new Error(`Token request failed for ${normalizedShop}: missing access_token in response`);
  }

  tokenCache.set(cacheKey, {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in || 86_400) * 1000,
  });

  return payload.access_token;
}

export async function resolveStoreAccessToken(storeConfig) {
  if (storeConfig.accessToken) {
    return storeConfig.accessToken;
  }

  if (!storeConfig.clientId || !storeConfig.clientSecret) {
    throw new Error(
      `Missing credentials for ${storeConfig.shop}. Provide ${storeConfig.prefix}_CLIENT_ID + ${storeConfig.prefix}_CLIENT_SECRET, or ${storeConfig.prefix}_ACCESS_TOKEN.`,
    );
  }

  return fetchAccessToken({
    shop: storeConfig.shop,
    clientId: storeConfig.clientId,
    clientSecret: storeConfig.clientSecret,
  });
}
