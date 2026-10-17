/**
 * 上游（Iwara）请求构造。
 *
 * 关键点：
 * 1. 用真实浏览器的 UA 与配套的 Sec-Fetch / Accept 头，否则 apiq 会回 Cloudflare 挑战页。
 * 2. 绝不把浏览器带来的 Cookie 转发给上游，只转发 Authorization。
 * 3. `x-site` 决定拿主站还是 AI 站的内容。
 */

/* ------------------------------------------------------------------ *
 * 站点
 * ------------------------------------------------------------------ */

export const SITES = {
  main: {
    key: 'main',
    host: 'www.iwara.tv',
    origin: 'https://www.iwara.tv',
    label: 'Iwara'
  },
  ai: {
    key: 'ai',
    host: 'www.iwara.ai',
    origin: 'https://www.iwara.ai',
    label: 'Iwara AI'
  }
};

export function normalizeSiteKey(value, fallback = 'main') {
  const key = String(value || '').trim().toLowerCase();
  return key === 'ai' || key === 'main' ? key : fallback;
}

export function resolveSite(value, fallback = 'main') {
  return SITES[normalizeSiteKey(value, fallback)];
}

/* ------------------------------------------------------------------ *
 * 上游主机
 * ------------------------------------------------------------------ */

export const API_HOSTS = ['apiq.iwara.tv', 'api.iwara.tv'];
export const IMAGE_HOST = 'i.iwara.tv';
export const FILE_HOST = 'filesq.iwara.tv';
export const SITE_ORIGIN = 'https://www.iwara.tv';

/** 允许代理的媒体主机：filesq / i / 各分片节点（kafka、robin、zani…）都在 *.iwara.tv 下。 */
const MEDIA_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.iwara\.(?:tv|ai)$/i;

export function isAllowedMediaHost(hostname) {
  return MEDIA_HOST_PATTERN.test(String(hostname || '').toLowerCase());
}

/* ------------------------------------------------------------------ *
 * 请求头
 * ------------------------------------------------------------------ */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
];

/** 同一批 URL 固定用同一个 UA，避免同一资源在上游被当成不同客户端。 */
function pickUserAgent(seed) {
  let hash = 0;
  const value = String(seed || '');
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return USER_AGENTS[Math.abs(hash) % USER_AGENTS.length];
}

export function buildUpstreamHeaders({ url, site, token, accept = 'application/json', extra = {} }) {
  const resolved = resolveSite(site);
  const headers = {
    'User-Agent': pickUserAgent(url || resolved.host),
    Accept: accept,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: `${resolved.origin}/`,
    Origin: resolved.origin,
    'x-site': resolved.host,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
    ...extra
  };
  if (token) headers.Authorization = `Bearer ${String(token).replace(/^Bearer\s+/i, '')}`;
  return headers;
}

/** 统一的 fetch 包装：统一超时，并保证 redirect 跟随。 */
export async function upstreamFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs || 25000);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 站点级 Basic Auth（可选）
 * ------------------------------------------------------------------ */

function constantTimeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/**
 * 校验站点 Basic Auth。未配置账号密码时返回 null（放行）。
 * 校验通过返回 null，失败返回 401 响应。
 */
export function verifyBasicAuth(request, env) {
  const user = String(env?.BASIC_AUTH_USER || '').trim();
  const pass = String(env?.BASIC_AUTH_PASS || '').trim();
  if (!user && !pass) return null;

  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) {
    return new Response('需要登录后才能访问本站。', {
      status: 401,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'WWW-Authenticate': 'Basic realm="Iwara", charset="UTF-8"',
        'cache-control': 'no-store'
      }
    });
  }

  let decoded = '';
  try {
    decoded = atob(header.slice(6));
  } catch {
    decoded = '';
  }
  const index = decoded.indexOf(':');
  const givenUser = index >= 0 ? decoded.slice(0, index) : '';
  const givenPass = index >= 0 ? decoded.slice(index + 1) : '';

  const userOk = user ? constantTimeEqual(givenUser, user) : true;
  const passOk = pass ? constantTimeEqual(givenPass, pass) : true;
  if (userOk && passOk) return null;

  return new Response('账号或密码不正确。', {
    status: 401,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'WWW-Authenticate': 'Basic realm="Iwara", charset="UTF-8"',
      'cache-control': 'no-store'
    }
  });
}
