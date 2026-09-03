export function splitTokens(raw) {
  return String(raw || '')
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseMetaobjectTypes(raw) {
  return [...new Set(splitTokens(raw).map((item) => item.replace(/^\/+|\/+$/g, '')))];
}

export function parseHandles(raw) {
  const parts = Array.isArray(raw) ? raw : [raw];
  return [
    ...new Set(
      parts
        .flatMap((item) => splitTokens(item))
        .map((item) => String(item).replace(/^\/+|\/+$/g, ''))
        .filter(Boolean),
    ),
  ];
}

export function parseMetafieldSelectors(raw) {
  return splitTokens(raw).map(parseMetafieldSelector);
}

export function parseMetafieldSelector(token) {
  const value = String(token || '').trim();
  let ownerType = null;
  let rest = value;
  const colon = value.indexOf(':');

  if (colon > 0) {
    const maybeOwner = value.slice(0, colon).trim();
    const maybeRest = value.slice(colon + 1).trim();
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(maybeOwner) && maybeRest.includes('.')) {
      ownerType = maybeOwner.toUpperCase();
      rest = maybeRest;
    }
  }

  const dot = rest.indexOf('.');
  if (dot <= 0 || dot === rest.length - 1) {
    throw new Error(
      `Invalid metafield selector "${value}". Use namespace.key or OWNER:namespace.key (e.g. custom.color or PRODUCT:custom.color)`,
    );
  }

  return {
    ownerType,
    namespace: rest.slice(0, dot),
    key: rest.slice(dot + 1),
    raw: value,
  };
}

export function metafieldDefinitionMatches(definition, selectors) {
  return selectors.some((selector) => {
    if (selector.ownerType && selector.ownerType !== definition.ownerType) return false;
    return selector.namespace === definition.namespace && selector.key === definition.key;
  });
}

export function ownerTypesFromSelectors(selectors, fallback) {
  const listed = [...new Set(selectors.map((item) => item.ownerType).filter(Boolean))];
  if (listed.length && selectors.every((item) => item.ownerType)) return listed;
  return fallback;
}
