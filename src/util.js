/**
 * 通用工具：编码、加密、Cookie、响应构造。
 * 这里不依赖任何外部包，全部使用 Workers 运行时自带的 Web 标准 API。
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/* ------------------------------------------------------------------ *
 * Base64 / Base64URL
 * ------------------------------------------------------------------ */

export function bytesToBase64Url(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64UrlEncodeString(value) {
  return bytesToBase64Url(textEncoder.encode(value));
}

export function base64UrlDecodeString(value) {
  return textDecoder.decode(base64UrlToBytes(value));
}

/* ------------------------------------------------------------------ *
 * AES-GCM：用于把会话 Token 加密后放进 HttpOnly Cookie
 * ------------------------------------------------------------------ */

const keyCache = new Map();

async function deriveKey(secret) {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(secret));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt'
  ]);
  keyCache.set(secret, key);
  return key;
}

export async function encryptJson(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret);
  const plaintext = textEncoder.encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const payload = new Uint8Array(iv.length + cipher.byteLength);
  payload.set(iv, 0);
  payload.set(new Uint8Array(cipher), iv.length);
  return bytesToBase64Url(payload);
}

export async function decryptJson(token, secret) {
  try {
    const payload = base64UrlToBytes(token);
    if (payload.length < 13) return null;
    const iv = payload.subarray(0, 12);
    const cipher = payload.subarray(12);
    const key = await deriveKey(secret);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return JSON.parse(textDecoder.decode(plain));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * JWT
 * ------------------------------------------------------------------ */

export function decodeJwtPayload(token) {
  try {
    const raw = String(token || '').trim().replace(/^Bearer\s+/i, '');
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const json = base64UrlDecodeString(parts[1]);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 取出 Token 的过期时间（秒），取不到时返回 null。 */
export function getTokenExpiry(token) {
  const payload = decodeJwtPayload(token);
  return payload && typeof payload.exp === 'number' ? payload.exp : null;
}

/* ------------------------------------------------------------------ *
 * Cookie
 * ------------------------------------------------------------------ */

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    out[name] = part.slice(index + 1).trim();
  }
  return out;
}

export function serializeCookie(name, value, options = {}) {
  const segments = [`${name}=${value}`];
  if (options.path) segments.push(`Path=${options.path}`);
  if (options.maxAge !== undefined) segments.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly !== false) segments.push('HttpOnly');
  if (options.secure !== false) segments.push('Secure');
  segments.push(`SameSite=${options.sameSite || 'Lax'}`);
  return segments.join('; ');
}

/* ------------------------------------------------------------------ *
 * 请求判定
 * ------------------------------------------------------------------ */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutating(method) {
  return MUTATING_METHODS.has(String(method || '').toUpperCase());
}

/**
 * 同源校验：Cookie 会话下的写操作必须来自本站页面，
 * 防止第三方站点借浏览器 Cookie 发起 CSRF。
 */
export function isSameOriginRequest(request) {
  const origin = request.headers.get('Origin');
  if (!origin) {
    // 同源的普通表单/导航可能不带 Origin，用 Referer 兜底。
    const referer = request.headers.get('Referer');
    if (!referer) return true;
    try {
      return new URL(referer).host === new URL(request.url).host;
    } catch {
      return false;
    }
  }
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 响应
 * ------------------------------------------------------------------ */

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'SAMEORIGIN'
};

export function withSecurityHeaders(headers = {}) {
  return Object.assign({}, SECURITY_HEADERS, headers);
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withSecurityHeaders({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    })
  });
}

export function fail(message, status = 400, extra = {}) {
  return json({ error: message, ...extra }, status);
}

export function text(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: withSecurityHeaders({
      'content-type': 'text/plain; charset=utf-8',
      ...headers
    })
  });
}

/** 从上游响应挑选需要透传给浏览器的头。 */
export function pickUpstreamHeaders(upstream, extra = {}) {
  const headers = new Headers(extra);
  const passthrough = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control',
    'expires',
    'content-disposition'
  ];
  for (const name of passthrough) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
