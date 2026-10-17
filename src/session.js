/**
 * 会话：登录、Token 交换与自动续期。
 *
 * Iwara 的认证模型（与官方前端一致）：
 *   POST /user/login  {email, password}          -> { token: <refresh token，约 30 天> }
 *   POST /user/token  Authorization: Bearer <rt> -> { accessToken: <短期 token> }
 *   业务接口          Authorization: Bearer <access token>
 *
 * 浏览器侧只保存一枚 HttpOnly + AES-GCM 加密的 Cookie，
 * 明文 Token 不会进入前端 JS，也不会落到 localStorage。
 */

import {
  encryptJson,
  decryptJson,
  parseCookies,
  serializeCookie,
  decodeJwtPayload,
  getTokenExpiry
} from './util.js';
import { API_HOSTS, buildUpstreamHeaders, resolveSite, upstreamFetch } from './upstream.js';

export const SESSION_COOKIE = 'iwara_session';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
/** 提前 120 秒续期，避免请求在途中过期。 */
const REFRESH_SKEW_SECONDS = 120;

const LOGIN_URL = `https://${API_HOSTS[0]}/user/login`;
const TOKEN_URL = `https://${API_HOSTS[0]}/user/token`;

export function sessionSecret(env) {
  return String(env?.SESSION_SECRET || '').trim();
}

export function loginEnabled(env) {
  return sessionSecret(env).length >= 16;
}

/* ------------------------------------------------------------------ *
 * 读写 Cookie 会话
 * ------------------------------------------------------------------ */

export async function readSession(request, env) {
  const secret = sessionSecret(env);
  if (!secret) return null;
  const raw = parseCookies(request)[SESSION_COOKIE];
  if (!raw) return null;
  const payload = await decryptJson(raw, secret);
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.rt && !payload.at) return null;
  return payload;
}

export async function writeSessionCookie(session, env) {
  const secret = sessionSecret(env);
  if (!secret) return '';
  const value = await encryptJson(session, secret);
  return serializeCookie(SESSION_COOKIE, value, {
    path: '/',
    maxAge: SESSION_MAX_AGE,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax'
  });
}

export function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', {
    path: '/',
    maxAge: 0,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax'
  });
}

/* ------------------------------------------------------------------ *
 * 上游认证调用
 * ------------------------------------------------------------------ */

function authHeaders(site, token) {
  return buildUpstreamHeaders({
    url: LOGIN_URL,
    site,
    token,
    extra: { 'Content-Type': 'application/json' }
  });
}

/** 用 refresh token 换 access token。 */
async function exchangeAccessToken(refreshToken, site) {
  const response = await upstreamFetch(TOKEN_URL, {
    method: 'POST',
    headers: authHeaders(site, refreshToken)
  });
  if (!response.ok) {
    const error = new Error(`token_exchange_failed_${response.status}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json().catch(() => null);
  const accessToken = data && typeof data.accessToken === 'string' ? data.accessToken : '';
  if (!accessToken) {
    const error = new Error('token_exchange_empty');
    error.status = 502;
    throw error;
  }
  return accessToken;
}

async function fetchProfile(accessToken, site) {
  const response = await upstreamFetch(`https://${API_HOSTS[0]}/user`, {
    headers: buildUpstreamHeaders({ url: LOGIN_URL, site, token: accessToken })
  });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  const user = data && data.user;
  if (!user || !user.id) return null;
  return {
    id: user.id,
    username: user.username || '',
    name: user.name || user.username || '',
    role: user.role || 'user',
    avatar: user.avatar || null,
    header: user.header || null
  };
}

/* ------------------------------------------------------------------ *
 * 解析本次请求可用的 Token
 * ------------------------------------------------------------------ */

/**
 * 返回 { token, kind, session, setCookie }。
 * - token 为该请求应该带给上游的 Authorization（可能为空）。
 * - setCookie 有值时必须附加到响应上（会话续期或失效清理）。
 */
export async function resolveAuth(request, env, siteKey) {
  const site = resolveSite(siteKey, env?.DEFAULT_SITE);

  // 1. 高级用法：请求方自带 Token，直接透传，不落 Cookie。
  const inlineToken = (request.headers.get('X-Iwara-Token') || '').trim();
  if (inlineToken) {
    return { token: inlineToken, kind: 'inline', session: null, setCookie: '' };
  }

  const session = await readSession(request, env);

  // 2. 会话中的 access token 还新鲜，直接用。
  if (session) {
    const expiry = typeof session.exp === 'number' ? session.exp : getTokenExpiry(session.at);
    const now = Math.floor(Date.now() / 1000);
    if (session.at && expiry && expiry > now + REFRESH_SKEW_SECONDS) {
      return { token: session.at, kind: 'session', session, setCookie: '' };
    }

    // 3. 续期。
    if (session.rt) {
      try {
        const accessToken = await exchangeAccessToken(session.rt, site);
        const next = { ...session, at: accessToken, exp: getTokenExpiry(accessToken) };
        if (!next.u) next.u = await fetchProfile(accessToken, site);
        const setCookie = await writeSessionCookie(next, env);
        return { token: accessToken, kind: 'session', session: next, setCookie };
      } catch (error) {
        const status = Number(error?.status) || 0;
        if (status === 401 || status === 403) {
          // refresh token 已失效：清掉会话，让前端回到访客态。
          return { token: '', kind: 'expired', session: null, setCookie: clearSessionCookie() };
        }
        // 上游抖动：先让本次请求以访客身份走完，会话保留。
        return { token: '', kind: 'degraded', session, setCookie: '' };
      }
    }
  }

  // 4. 访客共享 Token。
  const shared = String(env?.IWARA_AUTHORIZATION || '').trim();
  if (shared) {
    const payload = decodeJwtPayload(shared);
    const now = Math.floor(Date.now() / 1000);
    if (!payload || typeof payload.exp !== 'number' || payload.exp > now) {
      return { token: shared, kind: 'shared', session: null, setCookie: '' };
    }
  }

  return { token: '', kind: 'anonymous', session: session || null, setCookie: session ? '' : '' };
}

/* ------------------------------------------------------------------ *
 * 路由处理
 * ------------------------------------------------------------------ */

export function handleAuthConfig(env) {
  return {
    loginEnabled: loginEnabled(env),
    sharedToken: !!String(env?.IWARA_AUTHORIZATION || '').trim(),
    site: resolveSite(env?.DEFAULT_SITE).key,
    siteName: String(env?.SITE_NAME || 'Iwara 映像')
  };
}

export async function handleLogin(request, env) {
  if (!loginEnabled(env)) {
    return {
      status: 503,
      body: {
        error: '未配置 SESSION_SECRET，登录功能不可用。请先执行 wrangler secret put SESSION_SECRET。'
      }
    };
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return { status: 400, body: { error: '请求体不是合法的 JSON。' } };
  }

  const email = String(payload?.email || '').trim();
  const password = typeof payload?.password === 'string' ? payload.password : '';
  const site = resolveSite(payload?.site, env?.DEFAULT_SITE).key;
  if (!email || !password) {
    return { status: 400, body: { error: '请填写邮箱与密码。' } };
  }

  let loginResponse;
  try {
    loginResponse = await upstreamFetch(LOGIN_URL, {
      method: 'POST',
      headers: authHeaders(site, null),
      body: JSON.stringify({ email, password })
    });
  } catch {
    return { status: 502, body: { error: '连接 Iwara 登录接口失败，请稍后重试。' } };
  }

  const data = await loginResponse.json().catch(() => null);

  if (!loginResponse.ok) {
    const message = String(data?.message || '');
    if (loginResponse.status === 400 || /invalidLogin/i.test(message)) {
      return { status: 401, body: { error: '邮箱或密码不正确。' } };
    }
    if (loginResponse.status === 403) {
      return {
        status: 403,
        body: { error: 'Iwara 要求人机校验，请稍后重试，或在设置中直接粘贴 Token。' }
      };
    }
    if (loginResponse.status === 429) {
      return { status: 429, body: { error: '尝试过于频繁，请等待几分钟后重试。' } };
    }
    return {
      status: 502,
      body: { error: `Iwara 登录接口返回 ${loginResponse.status}。` }
    };
  }

  const refreshToken = typeof data?.token === 'string' ? data.token.trim() : '';
  if (!refreshToken) {
    return { status: 502, body: { error: 'Iwara 登录响应中没有 Token。' } };
  }

  let accessToken;
  try {
    accessToken = await exchangeAccessToken(refreshToken, site);
  } catch (error) {
    return {
      status: 502,
      body: { error: `换取访问令牌失败（${Number(error?.status) || '网络错误'}）。` }
    };
  }

  const profile = await fetchProfile(accessToken, site);
  if (!profile) {
    return { status: 502, body: { error: '登录成功但读取账号资料失败，请重试。' } };
  }

  const session = {
    v: 1,
    rt: refreshToken,
    at: accessToken,
    exp: getTokenExpiry(accessToken),
    u: profile,
    site,
    createdAt: Date.now()
  };

  return {
    status: 200,
    body: { authenticated: true, user: profile },
    setCookie: await writeSessionCookie(session, env)
  };
}

export function handleLogout() {
  return {
    status: 200,
    body: { authenticated: false },
    setCookie: clearSessionCookie()
  };
}

export async function handleMe(request, env) {
  const auth = await resolveAuth(request, env);
  const user = auth.session?.u || null;
  return {
    status: 200,
    body: {
      authenticated: !!(user && user.id) || auth.kind === 'inline',
      user,
      tokenKind: auth.kind,
      loginEnabled: loginEnabled(env)
    },
    setCookie: auth.setCookie
  };
}

/** 用 access token 直接验证并读取账号信息（“粘贴 Token”登录）。 */
export async function handleTokenLogin(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return { status: 400, body: { error: '请求体不是合法的 JSON。' } };
  }

  const site = resolveSite(payload?.site, env?.DEFAULT_SITE).key;
  const raw = String(payload?.token || '').trim();
  if (!raw) return { status: 400, body: { error: '请填写 Token。' } };

  const profile = await fetchProfile(raw, site);
  if (profile) {
    if (!loginEnabled(env)) {
      return {
        status: 200,
        body: { authenticated: true, user: profile, persisted: false, token: raw },
        setCookie: ''
      };
    }
    const session = {
      v: 1,
      at: raw,
      exp: getTokenExpiry(raw),
      u: profile,
      site,
      createdAt: Date.now()
    };
    return {
      status: 200,
      body: { authenticated: true, user: profile, persisted: true },
      setCookie: await writeSessionCookie(session, env)
    };
  }

  // 不是 access token，那就当 refresh token 再试一次。
  try {
    const accessToken = await exchangeAccessToken(raw, site);
    const profileFromRefresh = await fetchProfile(accessToken, site);
    if (!profileFromRefresh) {
      return { status: 401, body: { error: 'Token 无效或已过期。' } };
    }
    if (!loginEnabled(env)) {
      return {
        status: 200,
        body: { authenticated: true, user: profileFromRefresh, persisted: false, token: accessToken },
        setCookie: ''
      };
    }
    const session = {
      v: 1,
      rt: raw,
      at: accessToken,
      exp: getTokenExpiry(accessToken),
      u: profileFromRefresh,
      site,
      createdAt: Date.now()
    };
    return {
      status: 200,
      body: { authenticated: true, user: profileFromRefresh, persisted: true },
      setCookie: await writeSessionCookie(session, env)
    };
  } catch {
    return { status: 401, body: { error: 'Token 无效或已过期。' } };
  }
}
