const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIND_FILE = `
  query FindFile($query: String!) {
    files(first: 10, query: $query) {
      nodes {
        __typename
        id
        alt
        fileStatus
        ... on MediaImage {
          image { url }
        }
        ... on GenericFile {
          url
          mimeType
        }
        ... on Video {
          filename
          originalSource { url }
          sources { url mimeType }
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
        fileStatus
        ... on MediaImage { image { url } }
        ... on GenericFile { url }
        ... on Video { filename }
      }
      userErrors { field message code }
    }
  }
`;

const FILE_STATUS = `
  query FileStatus($id: ID!) {
    node(id: $id) {
      ... on File {
        id
        fileStatus
      }
    }
  }
`;

export function filenameFromUrl(url) {
  if (!url) return '';
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    return pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return String(url).split('?')[0].split('/').pop() || '';
  }
}

export function fileSourceUrl(node) {
  if (!node) return null;
  if (node.image?.url) return node.image.url;
  if (node.originalSource?.url) return node.originalSource.url;
  const mp4 = (node.sources || []).find((source) => source.mimeType === 'video/mp4');
  if (mp4?.url) return mp4.url;
  if (node.sources?.[0]?.url) return node.sources[0].url;
  if (node.url) return node.url;
  return node.preview?.image?.url || null;
}

export function typenameFromFileGid(id) {
  const match = String(id || '').match(/^gid:\/\/shopify\/([^/]+)\//i);
  return match ? match[1] : '';
}

export function isFileGid(value) {
  return /gid:\/\/shopify\/(MediaImage|GenericFile|Video|Model3d)\//i.test(String(value || ''));
}

export function parseFileGids(value) {
  if (value == null || value === '') return [];
  const trimmed = String(value).trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return (Array.isArray(parsed) ? parsed : []).map(String).filter(isFileGid);
    } catch {
      return [];
    }
  }
  return isFileGid(trimmed) ? [trimmed] : [];
}

export function normalizeFileNode(node) {
  if (!node?.id) return null;
  const typename = node.__typename || typenameFromFileGid(node.id);
  if (!['MediaImage', 'GenericFile', 'Video', 'Model3d'].includes(typename)) return null;
  return { ...node, __typename: typename };
}

export function fileContentType(node) {
  switch (node?.__typename || typenameFromFileGid(node?.id)) {
    case 'MediaImage':
      return 'IMAGE';
    case 'Video':
      return 'VIDEO';
    case 'Model3d':
      return 'MODEL_3D';
    default:
      return 'FILE';
  }
}

export function isFileNode(node) {
  return Boolean(normalizeFileNode(node) || (node && fileSourceUrl(node)));
}

const FILE_NODE_FIELDS = `
  __typename
  ... on MediaImage {
    id
    alt
    image { url }
  }
  ... on GenericFile {
    id
    alt
    url
    mimeType
  }
  ... on Video {
    id
    alt
    filename
    originalSource { url }
    sources { url mimeType }
    preview { image { url } }
  }
  ... on Model3d {
    id
    alt
    filename
    originalSource { url }
    preview { image { url } }
  }
`;

const FILE_NODES = `
  query FileNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      ${FILE_NODE_FIELDS}
    }
  }
`;

export async function loadFileNodes(client, ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  const nodes = [];

  for (let index = 0; index < uniqueIds.length; index += 50) {
    const chunk = uniqueIds.slice(index, index + 50);
    const payload = await client.query(FILE_NODES, { ids: chunk }, { allowErrors: true });
    for (const node of payload.data?.nodes || []) {
      const normalized = normalizeFileNode(node);
      if (normalized) nodes.push(normalized);
    }
  }

  return nodes;
}

export async function findFileByFilename(client, filename) {
  const payload = await client.query(FIND_FILE, { query: `filename:${filename}` });
  const nodes = payload.data?.files?.nodes || [];
  return (
    nodes.find((node) => {
      const url = fileSourceUrl(node) || '';
      const name = node.filename || filenameFromUrl(url);
      return name === filename || url.includes(`/${filename}`) || url.endsWith(filename);
    }) ||
    nodes[0] ||
    null
  );
}

export async function waitForFileReady(client, fileId, { timeoutMs = 45_000, intervalMs = 1_500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const payload = await client.query(FILE_STATUS, { id: fileId });
    const status = payload.data?.node?.fileStatus;
    if (status === 'READY') return payload.data.node;
    if (status === 'FAILED') throw new Error(`File processing failed: ${fileId}`);
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for file READY: ${fileId}`);
}

export async function createFileFromUrl(client, { filename, sourceUrl, alt = '', contentType = 'IMAGE' }) {
  const payload = await client.query(
    FILE_CREATE,
    {
      files: [
        {
          alt: alt || '',
          contentType,
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
    throw new Error(payload.errors.map((error) => error.message).join('; '));
  }
  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message).join('; '));
  }
  const file = result?.files?.[0];
  if (!file?.id) throw new Error(`fileCreate returned no file for ${filename}`);
  return file;
}

export function createFileCopyCache() {
  return {
    bySourceId: new Map(),
    byFilename: new Map(),
  };
}

export async function ensureFileOnTarget(targetClient, sourceRef, { dryRun = false, cache }) {
  if (cache.bySourceId.has(sourceRef.id)) return cache.bySourceId.get(sourceRef.id);

  const sourceUrl = fileSourceUrl(sourceRef);
  const filename = sourceRef.filename || filenameFromUrl(sourceUrl);
  if (!sourceUrl || !filename) {
    throw new Error('Missing file URL or filename');
  }

  if (cache.byFilename.has(filename)) {
    const existingId = cache.byFilename.get(filename);
    cache.bySourceId.set(sourceRef.id, existingId);
    return existingId;
  }

  const existing = await findFileByFilename(targetClient, filename);
  if (existing?.id) {
    cache.byFilename.set(filename, existing.id);
    cache.bySourceId.set(sourceRef.id, existing.id);
    return existing.id;
  }

  if (dryRun) {
    const placeholder = `gid://shopify/File/DRY_RUN/${encodeURIComponent(filename)}`;
    cache.byFilename.set(filename, placeholder);
    cache.bySourceId.set(sourceRef.id, placeholder);
    return placeholder;
  }

  const created = await createFileFromUrl(targetClient, {
    filename,
    sourceUrl,
    alt: sourceRef.alt || '',
    contentType: fileContentType(sourceRef),
  });

  try {
    await waitForFileReady(targetClient, created.id);
  } catch (error) {
    console.warn(`[files] ${filename}: ${error.message}; using file id anyway`);
  }

  cache.byFilename.set(filename, created.id);
  cache.bySourceId.set(sourceRef.id, created.id);
  return created.id;
}
