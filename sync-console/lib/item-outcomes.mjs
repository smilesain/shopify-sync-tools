function errorText(errors) {
  if (!errors) return '';
  if (typeof errors === 'string') return errors;
  if (!Array.isArray(errors)) return String(errors.message || errors);
  return errors
    .map((item) => item?.message || item?.code || String(item))
    .filter(Boolean)
    .join('; ');
}

function outcome(module, name, reason, message) {
  return {
    module,
    name: String(name || '').trim() || '(unknown)',
    reason: reason || 'FAILED',
    message: String(message || '').trim(),
  };
}

function metafieldName(item) {
  const owner = item.ownerType || '';
  if (!item.namespace || item.namespace === '*') {
    return item.name || owner || 'metafield';
  }
  const key = [item.namespace, item.key].filter(Boolean).join('.');
  return [owner, key || item.name].filter(Boolean).join(' ').trim() || item.name || 'metafield';
}

export function extractOutcomesFromReport(parsed, fallbackModule = '') {
  const failed = [];
  const skipped = [];
  if (!parsed || typeof parsed !== 'object') return { failed, skipped };

  if (parsed.kind === 'metaobject-entries' || (parsed.entries && (parsed.failed || parsed.skipped))) {
    for (const item of parsed.failed || []) {
      failed.push(
        outcome(
          'metaobject-entries',
          item.name || `${item.type}/${item.handle}`,
          item.reason || 'FAILED',
          item.message || item.error || '',
        ),
      );
    }
    for (const item of parsed.skipped || []) {
      skipped.push(
        outcome(
          'metaobject-entries',
          item.name || item.type || `${item.type}/${item.handle || '*'}`,
          item.reason || 'SKIPPED',
          item.message || '',
        ),
      );
    }
    return { failed, skipped };
  }

  if (parsed.metaobjects || parsed.metafields) {
    for (const item of parsed.metaobjects?.failed || []) {
      failed.push(
        outcome('metaobjects', item.type || item.name, 'FAILED', errorText(item.errors) || item.message),
      );
    }
    for (const item of parsed.metaobjects?.skipped || []) {
      skipped.push(
        outcome('metaobjects', item.type || item.name, item.reason || 'SKIPPED', item.message || item.reason),
      );
    }
    for (const item of parsed.metafields?.failed || []) {
      failed.push(outcome('metafields', metafieldName(item), 'FAILED', errorText(item.errors) || item.message));
    }
    for (const item of parsed.metafields?.skipped || []) {
      skipped.push(
        outcome('metafields', metafieldName(item), item.reason || 'SKIPPED', item.message || item.reason),
      );
    }
    return { failed, skipped };
  }

  if (Array.isArray(parsed.failed) || Array.isArray(parsed.skipped)) {
    for (const item of parsed.failed || []) {
      failed.push(
        outcome(
          fallbackModule || item.module || 'sync',
          item.name || item.handle || item.type,
          item.reason || 'FAILED',
          item.message || item.error || errorText(item.errors),
        ),
      );
    }
    for (const item of parsed.skipped || []) {
      skipped.push(
        outcome(
          fallbackModule || item.module || 'sync',
          item.name || item.handle || item.type,
          item.reason || 'SKIPPED',
          item.message || item.reason,
        ),
      );
    }
  }

  return { failed, skipped };
}

export function parseFailedLogLines(lines, module) {
  const failed = [];
  for (const raw of lines || []) {
    const line = String(raw);
    let match = line.match(/\[failed\]\s+([^:]+):\s*(.*)$/i);
    if (match) {
      failed.push(outcome(module, match[1], 'FAILED', match[2]));
      continue;
    }
    match = line.match(/FAILED\s+(\S+):\s*(.*)$/i);
    if (match) {
      failed.push(outcome(module, match[1], 'FAILED', match[2]));
    }
  }
  return failed;
}

export function emptyOutcomes() {
  return { failed: [], skipped: [] };
}

export function mergeOutcomes(target, extra) {
  const next = target || emptyOutcomes();
  next.failed.push(...(extra?.failed || []));
  next.skipped.push(...(extra?.skipped || []));
  return next;
}
