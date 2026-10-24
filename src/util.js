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

/**
 * 从口令派生 AES-GCM 密钥。
 *
 * 用 PBKDF2 而不是单次 SHA-256：Cookie 是发给浏览器的，攻击者能拿到密文，
 * 单次哈希对短口令几乎等于明文（离线爆破很快）。PBKDF2 抬高每次尝试的成本。
 *
 * 代价是首次派生要跑 21 万轮，所以结果按 secret 缓存在模块作用域里——
 * 每个 isolate 只算一次，后续请求直接命中缓存。
 */
const KDF_ITERATIONS = 210000;
const KDF_SALT = 'iwara-web-proxy:v1';

async function deriveKey(secret) {
  const cached = keyCache.get(secret);
  if (cached) return cached;

  const material = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: textEncoder.encode(KDF_SALT),
      iterations: KDF_ITERATIONS,
      hash: 'SHA-256'
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
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
  const self = new URL(request.url);
  // 比 origin 而不是 host：协议与端口也是隔离边界，
  // 只比 host 会让 http:// 与 https://、:8788 与 :443 互相认作同源。
  const sameOrigin = (value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === self.protocol &&
        parsed.hostname === self.hostname &&
        (parsed.port || '') === (self.port || '')
      );
    } catch {
      return false;
    }
  };

  const origin = request.headers.get('Origin');
  if (origin) return sameOrigin(origin);

  // 同源的普通表单/导航可能不带 Origin，用 Referer 兜底。
  const referer = request.headers.get('Referer');
  if (!referer) return true;
  return sameOrigin(referer);
}

/**
 * 恒定时间字符串比较：逐字符异或累加，长度不同也走完全程，
 * 不会因为提前 return 而泄漏「前几位是对的」。
 */
export function constantTimeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) {
    // 长度不同直接返回 false 也安全：长度本身不是秘密。
    return false;
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
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
