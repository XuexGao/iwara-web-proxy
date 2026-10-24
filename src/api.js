/**
 * Iwara 业务接口的反向代理。
 *
 * 设计：`/api/iwara/<上游路径>?<原样查询串>` 会被透明转发到 apiq.iwara.tv，
 * 响应原样返回。前端只需理解 Iwara 自己的数据结构，接口层不做二次变形，
 * 这样上游加字段时前端不需要跟着改代理。
 */

import { API_HOSTS, buildUpstreamHeaders, resolveSite, upstreamFetch } from './upstream.js';
import { json, withSecurityHeaders } from './util.js';

/** 允许转发的第一层路径。其余一律 403，避免变成任意站点代理。 */
const ALLOWED_ROOTS = new Set([
  'videos',
  'video',
  'images',
  'image',
  'search',
  'tags',
  'tag',
  'profile',
  'user',
  'playlists',
  'playlist',
  'forum',
  'post',
  'posts',
  'comment',
  'comments',
  'autocomplete',
  'notifications',
  'notification',
  'favorites',
  'favorite',
  'light',
  'page',
  'pages',
  'rules',
  'rule',
  'conversation',
  'message'
]);

/** 这些路径由本 Worker 自己实现，不允许透传。 */
const BLOCKED_PATHS = new Set(['user/login', 'user/token', 'user/register', 'user/password']);

/** 这些前缀的 GET 结果适合缓存，能显著节省每日请求数。 */
const CACHEABLE_PATTERNS = [
  /^\/videos/,
  /^\/video\/[^/]+$/,
  /^\/images/,
  /^\/image\/[^/]+$/,
  /^\/tags/,
  /^\/tag\//,
  /^\/profile\//,
  /^\/playlists/,
  /^\/playlist\//,
  /^\/forum/,
  /^\/posts/,
  /^\/light\//,
  /^\/rules$/,
  /^\/page\//
];

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function isAllowedApiPath(pathname) {
  if (!pathname.startsWith('/')) return false;

  // ① 编码形式的点段与分隔符一律拒绝。
  //
  // 光靠 includes('..') 抓不到 `%2e%2e`：`/videos/%2e%2e%2fuser/password`
  // 里没有字面量 `..`，却可能在**上游**被解码成 `/user/password`，
  // 从而绕过下面的 BLOCKED_PATHS。这类"编码咒语"没有任何正当用途
  // （用户名/标签里的中文是用 UTF-8 百分号编码，不会编码点与斜线）。
  if (/%2e|%2f|%5c|%25/i.test(pathname)) return false;

  if (pathname.includes('//')) return false;
  if (pathname.includes('..')) return false;
  if (pathname.includes('\\')) return false;
  // 控制字符一律拒绝；其余（含 percent-encoded 的 CJK 用户名/标签）放行。
  if (/[\u0000-\u001f\u007f]/.test(pathname)) return false;

  // ② 规范化后必须与原文完全一致。现在的实现里 pathname 已被 URL 解析器
  // 归一过，这一步是兜底：将来若改成从别处取路径，也不会悄悄放过点段。
  let normalized;
  try {
    normalized = new URL(pathname, 'https://upstream.invalid').pathname;
  } catch {
    return false;
  }
  if (normalized !== pathname) return false;

  const root = normalized.slice(1).split('/')[0].toLowerCase();
  if (!ALLOWED_ROOTS.has(root)) return false;
  if (BLOCKED_PATHS.has(normalized.slice(1).toLowerCase())) return false;
  return true;
}

function shouldCache(pathname) {
  return CACHEABLE_PATTERNS.some((pattern) => pattern.test(pathname));
}

/**
 * 处理 /api/iwara/*。
 * @param {Request} request
 * @param {object} env
 * @param {string} upstreamPath 形如 `/videos`
 * @param {URLSearchParams} params
 */
export async function handleIwaraApi(request, env, upstreamPath, params, auth) {
  if (!isAllowedApiPath(upstreamPath)) {
    return json({ error: '这个接口不允许通过代理访问。' }, 403);
  }

  const siteKey = params.get('_site') || env?.DEFAULT_SITE;
  const site = resolveSite(siteKey, env?.DEFAULT_SITE);
  params.delete('_site');

  const query = params.toString();
  const target = `https://${API_HOSTS[0]}${upstreamPath}${query ? `?${query}` : ''}`;

  const ttl = Math.max(0, Number.parseInt(env?.API_CACHE_TTL ?? '30', 10) || 0);

  // 只有「访客自带身份」才绕过缓存：
  //   - session / inline 的响应是按账号算的（订阅、收藏、点赞态），缓存会串号；
  //   - shared（站点级共享 Token）对所有人是同一个身份，缓存它是安全的，
  //     而且正是最需要省额度的场景。
  // 早期写成 !auth.token，导致一配共享 Token 就完全没缓存。
  const identityBound = auth.kind === 'session' || auth.kind === 'inline';
  const cacheAllowed =
    ttl > 0 &&
    SAFE_METHODS.has(request.method) &&
    !identityBound &&
    shouldCache(upstreamPath) &&
    request.headers.get('X-No-Cache') !== '1';

  // 缓存键必须带站点维度：_site 只影响请求头，不影响目标主机，
  // 而它在上一步已被 delete，不补回来的话 iwara.ai 与主站会串同一个缓存条目。
  const cacheKey = cacheAllowed
    ? new Request(`${target}${query ? '&' : '?'}__site=${encodeURIComponent(site.key)}`, {
        method: 'GET'
      })
    : null;
  if (cacheKey) {
    const hit = await safeCacheMatch(cacheKey);
    if (hit) return hit;
  }

  let upstream;
  try {
    upstream = await upstreamFetch(target, {
      method: request.method,
      headers: buildUpstreamHeaders({
        url: target,
        site: site.key,
        token: auth.token,
        extra: request.method === 'POST' ? { 'Content-Type': 'application/json' } : {}
      }),
      body: SAFE_METHODS.has(request.method) ? undefined : await readBody(request)
    });
  } catch {
    return json({ error: '连接 Iwara 接口失败，请稍后重试。' }, 504);
  }

  const headers = new Headers();
  const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
  headers.set('content-type', contentType);

  // 上游的挑战页会以 HTML 返回，这里翻译成可读的错误，避免前端拿到一坨 HTML。
  if (contentType.includes('text/html')) {
    return json(
      {
        error: 'Iwara 返回了人机校验页面，请稍后重试。',
        upstreamStatus: upstream.status
      },
      502
    );
  }

  const responseHeaders = withSecurityHeaders({
    'content-type': contentType,
    'cache-control': cacheAllowed ? `public, max-age=${ttl}` : 'no-store'
  });

  if (cacheAllowed && upstream.status === 200 && upstream.ok) {
    const response = new Response(upstream.body, { status: 200, headers: responseHeaders });
    safeCachePut(cacheKey, response.clone(), ttl);
    return response;
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

async function readBody(request) {
  try {
    return await request.arrayBuffer();
  } catch {
    return undefined;
  }
}

async function safeCacheMatch(request) {
  try {
    return (await caches.default.match(request)) || null;
  } catch {
    return null;
  }
}

function safeCachePut(request, response, ttl) {
  try {
    const cached = new Response(response.body, response);
    cached.headers.set('cache-control', `public, max-age=${ttl}`);
    // 失败不影响主流程（例如响应带 Set-Cookie 时 Cache API 会拒绝）。
    caches.default.put(request, cached).catch(() => {});
  } catch {
    /* 忽略 */
  }
}
