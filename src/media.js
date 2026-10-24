/**
 * 媒体代理：视频流与图片。
 *
 * 两条路径：
 *   /media/i/<path>   -> https://i.iwara.tv/<path>            图片，可长缓存
 *   /media/v?u=<url>  -> https://<*.iwara.tv>/<...>           视频/下载，支持 Range 分片
 *
 * 视频源地址是带 hash + expires 的签名 URL，主机名是随机分片节点
 * （kafka / robin / zani / acheron …），所以第二条路径必须接受任意 *.iwara.tv 主机，
 * 但会校验主机名后缀，避免被当成任意网站代理。
 */

import { IMAGE_HOST, buildUpstreamHeaders, isAllowedMediaHost, resolveSite } from './upstream.js';
import { fail } from './util.js';

// 图片路径只允许指向 i.iwara.tv 上这几个目录。
// 视频帧缩略图是 /image/thumbnail/<fileId>/thumbnail-NN.jpg，
// 图库原图是 /image/<size>/<fileId>/<fileId>.<ext>，两者都要放行。
const IMAGE_PATH_PATTERN = /^\/image\/(thumbnail|large|original|avatar|profileHeader|preview)\//;

export function buildImageTarget(pathname) {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  // 与 api.js 的路径校验同样的问题：includes('..') 抓不到 `%2e%2e`，
  // 而它会在上游被解码成真正的点段，从而绕过下面的目录白名单。
  if (/%2e|%2f|%5c|%25/i.test(path)) return null;
  if (path.includes('..') || path.includes('//') || path.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  if (!IMAGE_PATH_PATTERN.test(path)) return null;
  return `https://${IMAGE_HOST}${path}`;
}

/**
 * 媒体请求是否来自本站页面。
 *
 * 目的不是鉴权（媒体请求本来就靠站点密码的 Cookie 放行），而是拦住
 * "第三方网页把我的域名当免费 CDN"：那种请求会带外站的 Referer / Sec-Fetch-Site。
 *
 * 判定宽松但够用：
 * - 有 Sec-Fetch-Site 且不是 same-origin / none → 拒绝；
 * - 没有 Sec-Fetch-Site（老浏览器、curl）则看 Referer，跨站才拒绝；
 * - 两者都没有（直接在地址栏打开、下载工具）→ 放行，否则会把正常下载挡掉。
 */
export function isSameSiteMediaRequest(request) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return false;

  const referer = request.headers.get('Referer');
  if (!referer) return true;
  try {
    return new URL(referer).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export function parseVideoTarget(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!isAllowedMediaHost(url.hostname)) return null;
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * 请求头
 * ------------------------------------------------------------------ */

const FORWARD_REQUEST_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since'];

function buildMediaRequestHeaders(request, targetUrl, kind, siteKey) {
  const extra = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) extra[name] = value;
  }
  // 图片走 <img>，不该带 Origin/Referer 的跨站语义；视频源节点则要求站点来源。
  const headers = buildUpstreamHeaders({
    url: targetUrl,
    site: siteKey,
    accept: kind === 'image' ? 'image/avif,image/webp,image/*,*/*;q=0.8' : '*/*',
    extra
  });
  if (kind === 'image') {
    delete headers.Origin;
    delete headers['x-site'];
    headers.Referer = 'https://www.iwara.tv/';
  }
  return headers;
}

/* ------------------------------------------------------------------ *
 * 主处理
 * ------------------------------------------------------------------ */

async function proxyMedia(request, env, targetUrl, kind) {
  const ttl =
    kind === 'image'
      ? Math.max(0, Number.parseInt(env?.IMAGE_CACHE_TTL ?? '604800', 10) || 0)
      : Math.max(0, Number.parseInt(env?.VIDEO_CACHE_TTL ?? '3600', 10) || 0);

  const cf = {};
  if (ttl > 0) {
    cf.cacheEverything = true;
    cf.cacheTtl = ttl;
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: buildMediaRequestHeaders(request, targetUrl, kind, env?.DEFAULT_SITE),
      redirect: 'follow',
      cf
    });
  } catch {
    return fail('拉取媒体失败，请稍后重试。', 504);
  }

  const headers = new Headers({
    // 媒体只服务本站页面：同源播放/看图并不需要 CORS，
    // 早期给的通配 ACAO + CORP: cross-origin 等于把自己变成免费 CDN，
    // 任何第三方网页都能直接 <video src="https://本站/media/v?u=…">。
    'cross-origin-resource-policy': 'same-origin',
    'cache-control':
      kind === 'image'
        ? `public, max-age=${ttl || 86400}, immutable`
        : 'public, max-age=3600',
    'x-content-type-options': 'nosniff'
  });

  const passthrough = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified'
  ];
  for (const name of passthrough) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  // 下载模式：给文件名，让浏览器直接存盘。
  const downloadName = new URL(request.url).searchParams.get('dl');
  if (downloadName) {
    headers.set('content-disposition', buildContentDisposition(downloadName));
  }

  const body = upstream.status === 204 || upstream.status === 304 ? null : upstream.body;
  return new Response(body, { status: upstream.status, headers });
}

/**
 * 构造 Content-Disposition。
 *
 * 中文标题必须同时给 ASCII 兜底名和 RFC 5987 的 filename*，
 * 否则部分浏览器（尤其是 Safari 与老版 Chrome）会把中文显示成乱码或直接丢弃文件名。
 */
function buildContentDisposition(filename) {
  const raw = String(filename || '').replace(/[\r\n]/g, ' ').slice(0, 180);
  const safe = raw.replace(/["\\]/g, '_');

  // ASCII 兜底：非 ASCII 字符换成下划线，避免整个头非法。
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_') || 'download';

  const encoded = encodeURIComponent(safe)
    // RFC 5987 允许的字符集比 encodeURIComponent 窄，这几个要手动放开
    .replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, '%2A');

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function handleMedia(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail('媒体接口只接受 GET / HEAD。', 405);
  }

  if (!isSameSiteMediaRequest(request)) {
    return fail('这个媒体地址只能在本站页面里使用。', 403);
  }

  const pathname = url.pathname;

  if (pathname.startsWith('/media/i/')) {
    const target = buildImageTarget(pathname.slice('/media/i'.length));
    if (!target) return fail('图片地址不合法。', 403);
    return proxyMedia(request, env, target, 'image');
  }

  if (pathname === '/media/v' || pathname === '/media/v/') {
    const target = parseVideoTarget(url.searchParams.get('u'));
    if (!target) return fail('视频地址不合法。', 403);
    return proxyMedia(request, env, target, 'video');
  }

  return fail('未知的媒体路径。', 404);
}

/** 供 /api/status 展示用：当前站点与图片主机。 */
export function mediaInfo(env) {
  return {
    imageHost: IMAGE_HOST,
    site: resolveSite(env?.DEFAULT_SITE).key
  };
}

