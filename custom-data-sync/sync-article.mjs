#!/usr/bin/env node
/**
 * Sync Blog article(s) from source → target.
 * Ensures the parent Blog exists on target (matched by blog handle).
 *
 * Usage:
 *   node sync-article.mjs [article-handle] [--dry-run]
 *   node sync-article.mjs test --dry-run
 *   node sync-article.mjs --all [--dry-run]
 *
 * Default article handle: test
 */

import { loadConfig } from './lib/config.mjs';
import { resolveStoreAccessToken } from './lib/auth.mjs';
import { ShopifyClient, isRestrictedNamespace } from './lib/shopify-client.mjs';

const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes('--dry-run');
const syncAll = rawArgs.includes('--all');
const args = rawArgs.filter((arg) => arg !== '--dry-run' && arg !== '--all');
const ARTICLE_HANDLE = (args[0] || 'test').trim().replace(/^\/+|\/+$/g, '');

const ARTICLE_FIELDS = `
  id
  handle
  title
  body
  summary
  tags
  isPublished
  publishedAt
  templateSuffix
  author {
    name
  }
  image {
    altText
    url
  }
  blog {
    id
    handle
    title
    templateSuffix
  }
  metafields(first: 250) {
    pageInfo { hasNextPage endCursor }
    nodes {
      namespace
      key
      type
      value
    }
  }
`;

const ARTICLE_METAFIELDS_PAGE = `
  query ArticleMetafieldsPage($id: ID!, $cursor: String) {
    article(id: $id) {
      metafields(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { namespace key type value }
      }
    }
  }
`;

const FIND_ARTICLE = `
  query FindArticle($query: String!) {
    articles(first: 5, query: $query) {
      nodes {
        ${ARTICLE_FIELDS}
      }
    }
  }
`;

const LIST_ARTICLES = `
  query ListArticles($cursor: String) {
    articles(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        ${ARTICLE_FIELDS}
      }
    }
  }
`;

const FIND_BLOG = `
  query FindBlog($query: String!) {
    blogs(first: 5, query: $query) {
      nodes {
        id
        handle
        title
        templateSuffix
      }
    }
  }
`;

const BLOG_CREATE = `
  mutation BlogCreate($blog: BlogCreateInput!) {
    blogCreate(blog: $blog) {
      blog { id handle title }
      userErrors { field message code }
    }
  }
`;

const ARTICLE_CREATE = `
  mutation ArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id handle title isPublished blog { handle } }
      userErrors { field message code }
    }
  }
`;

const ARTICLE_UPDATE = `
  mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id handle title isPublished blog { handle } }
      userErrors { field message code }
    }
  }
`;

const SET_METAFIELDS = `
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors { field message code }
    }
  }
`;

function log(message) {
  console.log(message);
}

function shouldSyncMetafield(mf) {
  if (!mf?.namespace || !mf?.key) return false;
  const ns = mf.namespace.trim();
  if (isRestrictedNamespace(ns)) return false;
  if (ns.startsWith('judgeme') || ns.startsWith('mc-facebook') || ns.startsWith('reviews')) {
    return false;
  }
  return true;
}

async function findArticleByHandle(client, handle) {
  const payload = await client.query(FIND_ARTICLE, { query: `handle:${handle}` });
  const nodes = payload.data?.articles?.nodes || [];
  return nodes.find((article) => article.handle === handle) || null;
}

async function hydrateArticleMetafields(client, article) {
  const nodes = [...(article.metafields?.nodes || [])];
  let cursor = article.metafields?.pageInfo?.hasNextPage
    ? article.metafields.pageInfo.endCursor
    : null;
  while (cursor) {
    const payload = await client.query(ARTICLE_METAFIELDS_PAGE, {
      id: article.id,
      cursor,
    });
    const connection = payload.data?.article?.metafields;
    if (!connection) break;
    nodes.push(...(connection.nodes || []));
    cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  }
  article.metafields.nodes = nodes;
  return article;
}

async function listAllSourceArticles(sourceClient) {
  const articles = [];
  let cursor = null;
  let page = 0;

  do {
    page += 1;
    const payload = await sourceClient.query(LIST_ARTICLES, { cursor });
    const connection = payload.data?.articles;
    const nodes = connection?.nodes || [];
    articles.push(...nodes);
    log(`[list] Page ${page}: +${nodes.length} (total ${articles.length})`);
    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  for (const article of articles) {
    await hydrateArticleMetafields(sourceClient, article);
  }
  return articles;
}

async function findBlogByHandle(client, handle) {
  const payload = await client.query(FIND_BLOG, { query: `handle:${handle}` });
  const nodes = payload.data?.blogs?.nodes || [];
  return nodes.find((blog) => blog.handle === handle) || null;
}

async function ensureTargetBlog(targetClient, sourceBlog, blogCache) {
  if (!sourceBlog?.handle) {
    throw new Error('Source article has no parent blog handle');
  }

  if (blogCache?.has(sourceBlog.handle)) {
    return blogCache.get(sourceBlog.handle);
  }

  const existing = await findBlogByHandle(targetClient, sourceBlog.handle);
  if (existing) {
    log(`Target blog exists: ${existing.handle} (${existing.id})`);
    blogCache?.set(sourceBlog.handle, existing);
    return existing;
  }

  if (dryRun) {
    log(`[dry-run] Would create blog "${sourceBlog.title}" handle=${sourceBlog.handle}`);
    const dryBlog = {
      id: 'gid://shopify/Blog/DRY_RUN',
      handle: sourceBlog.handle,
      title: sourceBlog.title,
    };
    blogCache?.set(sourceBlog.handle, dryBlog);
    return dryBlog;
  }

  log(`Creating target blog: ${sourceBlog.handle}`);
  const payload = await targetClient.query(
    BLOG_CREATE,
    {
      blog: {
        title: sourceBlog.title || sourceBlog.handle,
        handle: sourceBlog.handle,
        templateSuffix: sourceBlog.templateSuffix || null,
      },
    },
    { isMutation: true, allowErrors: true },
  );
  const result = payload.data?.blogCreate;
  if (result?.userErrors?.length) {
    throw new Error(result.userErrors.map((e) => e.message).join('; '));
  }
  log(`Created blog: ${result.blog.handle} (${result.blog.id})`);
  blogCache?.set(sourceBlog.handle, result.blog);
  return result.blog;
}

function buildArticleInput(sourceArticle, { includeBlogId = false, blogId = null } = {}) {
  const authorName = sourceArticle.author?.name || 'Admin';
  const input = {
    title: sourceArticle.title,
    handle: sourceArticle.handle,
    body: sourceArticle.body || '',
    summary: sourceArticle.summary || '',
    tags: sourceArticle.tags || [],
    isPublished: Boolean(sourceArticle.isPublished),
    templateSuffix: sourceArticle.templateSuffix || null,
    author: { name: authorName },
  };

  if (sourceArticle.publishedAt) {
    input.publishDate = sourceArticle.publishedAt;
  }

  if (sourceArticle.image?.url) {
    input.image = {
      url: sourceArticle.image.url,
      altText: sourceArticle.image.altText || sourceArticle.title || '',
    };
  }

  if (includeBlogId) {
    if (!blogId) throw new Error('blogId is required when creating an article');
    input.blogId = blogId;
  }

  return input;
}

async function syncArticleMetafields(targetClient, ownerId, metafields) {
  const inputs = (metafields || [])
    .filter(shouldSyncMetafield)
    .map((mf) => ({
      ownerId,
      namespace: mf.namespace.trim(),
      key: mf.key.trim(),
      type: mf.type,
      value: mf.value ?? '',
    }));

  if (!inputs.length) {
    log('[metafields] No syncable metafields');
    return;
  }

  if (dryRun) {
    log(`[dry-run] Would set ${inputs.length} metafield(s)`);
    inputs.forEach((mf) => log(`  - ${mf.namespace}.${mf.key} (${mf.type})`));
    return;
  }

  let setCount = 0;
  for (let index = 0; index < inputs.length; index += 25) {
    const payload = await targetClient.query(
      SET_METAFIELDS,
      { metafields: inputs.slice(index, index + 25) },
      { isMutation: true, allowErrors: true },
    );
    const result = payload.data?.metafieldsSet;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    setCount += result?.metafields?.length || 0;
  }
  log(`[metafields] Set ${setCount} metafield(s)`);
}

async function syncOneArticle(sourceClient, targetClient, sourceArticle, blogCache) {
  const handle = sourceArticle.handle;
  log(
    `\n--- Article: "${sourceArticle.title}" (${handle}) blog=${sourceArticle.blog?.handle || '?'} published=${sourceArticle.isPublished} ---`,
  );

  const targetBlog = await ensureTargetBlog(targetClient, sourceArticle.blog, blogCache);
  const existingTarget = await findArticleByHandle(targetClient, handle);
  const metafieldNodes = sourceArticle.metafields?.nodes || [];

  if (dryRun) {
    log(`[dry-run] Would ${existingTarget ? 'update' : 'create'} article on target blog=${targetBlog.handle}`);
    log(`[dry-run] title=${sourceArticle.title}`);
    log(`[dry-run] handle=${handle}`);
    log(`[dry-run] isPublished=${sourceArticle.isPublished}`);
    log(`[dry-run] tags=${(sourceArticle.tags || []).join(',') || '(none)'}`);
    log(`[dry-run] image=${sourceArticle.image?.url ? 'yes' : 'no'}`);
    await syncArticleMetafields(
      targetClient,
      existingTarget?.id || 'gid://shopify/Article/DRY_RUN',
      metafieldNodes,
    );
    return { handle, action: existingTarget ? 'update' : 'create', ok: true };
  }

  let targetArticleId;

  if (existingTarget) {
    log(`Updating existing target article: ${handle}`);
    const payload = await targetClient.query(
      ARTICLE_UPDATE,
      {
        id: existingTarget.id,
        article: buildArticleInput(sourceArticle),
      },
      { isMutation: true, allowErrors: true },
    );
    const result = payload.data?.articleUpdate;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    targetArticleId = result.article.id;
    log(`Updated article: ${result.article.handle} (${result.article.id})`);
  } else {
    log(`Creating target article: ${handle}`);
    const payload = await targetClient.query(
      ARTICLE_CREATE,
      {
        article: buildArticleInput(sourceArticle, {
          includeBlogId: true,
          blogId: targetBlog.id,
        }),
      },
      { isMutation: true, allowErrors: true },
    );
    const result = payload.data?.articleCreate;
    if (result?.userErrors?.length) {
      throw new Error(result.userErrors.map((e) => e.message).join('; '));
    }
    targetArticleId = result.article.id;
    log(`Created article: ${result.article.handle} (${result.article.id})`);
  }

  await syncArticleMetafields(targetClient, targetArticleId, metafieldNodes);
  log(`Storefront: https://${targetClient.shop}/blogs/${targetBlog.handle}/${handle}`);
  return { handle, action: existingTarget ? 'update' : 'create', ok: true };
}

async function main() {
  if (!syncAll && !ARTICLE_HANDLE) {
    throw new Error('Article handle is required (or pass --all)');
  }

  const config = loadConfig();
  const [sourceToken, targetToken] = await Promise.all([
    resolveStoreAccessToken(config.source),
    resolveStoreAccessToken(config.target),
  ]);

  const sourceClient = new ShopifyClient({
    shop: config.source.shop,
    accessToken: sourceToken,
    apiVersion: config.apiVersion,
    mutationDelayMs: config.mutationDelayMs,
  });
  const targetClient = new ShopifyClient({
    shop: config.target.shop,
    accessToken: targetToken,
    apiVersion: config.apiVersion,
    mutationDelayMs: config.mutationDelayMs,
  });

  log(syncAll ? 'Article sync: ALL articles' : `Article sync: ${ARTICLE_HANDLE}`);
  log(`Source: ${config.source.shop}`);
  log(`Target: ${config.target.shop}`);
  log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  const blogCache = new Map();
  let sourceArticles;

  if (syncAll) {
    log('Listing all source articles…');
    sourceArticles = await listAllSourceArticles(sourceClient);
    if (!sourceArticles.length) {
      log('No articles found on source. Nothing to sync.');
      return;
    }
    log(`Found ${sourceArticles.length} article(s) to sync.`);
  } else {
    let sourceArticle = await findArticleByHandle(sourceClient, ARTICLE_HANDLE);
    if (!sourceArticle) {
      throw new Error(`Source article not found for handle: ${ARTICLE_HANDLE}`);
    }
    sourceArticle = await hydrateArticleMetafields(sourceClient, sourceArticle);
    sourceArticles = [sourceArticle];
  }

  const results = [];
  for (let i = 0; i < sourceArticles.length; i += 1) {
    const article = sourceArticles[i];
    log(`\n[${i + 1}/${sourceArticles.length}]`);
    try {
      const result = await syncOneArticle(sourceClient, targetClient, article, blogCache);
      results.push(result);
    } catch (error) {
      const message = error?.message || String(error);
      log(`FAILED ${article.handle}: ${message}`);
      results.push({ handle: article.handle, ok: false, error: message });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  log(`\nDone. ${okCount} succeeded, ${failCount} failed (of ${results.length}).`);
  log(`Admin: https://${config.target.shop}/admin/articles`);

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nArticle sync failed: ${error.message}`);
  process.exitCode = 1;
});
