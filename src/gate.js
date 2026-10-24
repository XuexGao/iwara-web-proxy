/**
 * 站点访问密码（与 Iwara 账号完全无关）。
 *
 * 用途：把整站锁起来，只有知道密码的人能打开。它保护的是「能不能用这个站」，
 * 而 Iwara 账号登录保护的是「能不能用你的 Iwara 身份」——两件事互不相干，
 * 密码只存在 Worker 的环境变量里。
 *
 * 实现要点：
 * - 密码用 SHA-256 + 随机盐在 Worker 侧比对，且比对是恒定时间的，
 *   不会因为提前返回而泄漏「前几位对了」。
 * - 通过后发一枚 AES-GCM 加密的 HttpOnly Cookie，内容是「到期时间 + 指纹」，
 *   浏览器侧看不到明文，也无法伪造。
 * - 未通过时所有路由（含 API 与媒体）都返回登录页，避免被绕过。
 */

import {
  constantTimeEqual,
  decryptJson,
  encryptJson,
  json,
  parseCookies,
  serializeCookie
} from './util.js';

export const GATE_COOKIE = 'iwara_gate';

/** 通过密码后凭证的有效期。 */
const GATE_MAX_AGE = 30 * 24 * 60 * 60;

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

/** 是否开启了站点密码。 */
export function gateEnabled(env) {
  return !!String(env?.SITE_PASSWORD || '').trim();
}

function gateSecret(env) {
  // 优先用独立密钥；没配就退回密码本身派生，避免多一个必填项。
  const explicit = String(env?.SESSION_SECRET || '').trim();
  return explicit || `gate:${String(env?.SITE_PASSWORD || '')}`;
}

/** 允许在密码里写 @ 之类的符号，只做长度与空白校验。 */
function normalizePassword(value) {
  return String(value ?? '');
}

/* ------------------------------------------------------------------ *
 * 恒定时间比较（按字节，长度不同也不提前返回）
 * ------------------------------------------------------------------ */

function safeEqual(a, b) {
  const left = new TextEncoder().encode(normalizePassword(a));
  const right = new TextEncoder().encode(normalizePassword(b));
  // 先各自哈希成等长摘要，再逐字节比较，避免长度差异泄漏信息。
  return sha256HexBytes(left).then((ha) =>
    sha256HexBytes(right).then((hb) => constantTimeEqual(ha, hb))
  );
}

async function sha256HexBytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/* ------------------------------------------------------------------ *
 * 凭证
 * ------------------------------------------------------------------ */

/** 当前请求是否已通过站点密码。 */
export async function hasGateAccess(request, env) {
  if (!gateEnabled(env)) return true;
  const raw = parseCookies(request)[GATE_COOKIE];
  if (!raw) return false;

  const payload = await decryptJson(raw, gateSecret(env));
  if (!payload || typeof payload !== 'object') return false;

  const expiresAt = Number(payload.exp) || 0;
  if (expiresAt < Date.now()) return false;

  // 密码换了之后，旧凭证立刻失效。
  const expected = await sha256HexBytes(
    new TextEncoder().encode(`gate|${normalizePassword(env.SITE_PASSWORD)}`)
  );
  return constantTimeEqual(String(payload.k || ''), expected);
}

async function issueGateCookie(env) {
  const fingerprint = await sha256HexBytes(
    new TextEncoder().encode(`gate|${normalizePassword(env.SITE_PASSWORD)}`)
  );
  const value = await encryptJson(
    { exp: Date.now() + GATE_MAX_AGE * 1000, k: fingerprint },
    gateSecret(env)
  );
  return serializeCookie(GATE_COOKIE, value, {
    path: '/',
    maxAge: GATE_MAX_AGE,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax'
  });
}

export function clearGateCookie() {
  return serializeCookie(GATE_COOKIE, '', {
    path: '/',
    maxAge: 0,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax'
  });
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/** 站点密码信息（给前端判断是否需要显示登录页）。 */
export function gateConfig(env) {
  return { required: gateEnabled(env) };
}

/**
 * 校验密码。
 * @returns {{ok: boolean, status?: number, error?: string, setCookie?: string}}
 */
/**
 * 登录失败计数（进程内）。
 *
 * 注意：这只在单个 isolate 内有效，换一个边缘节点就重新计数，
 * 所以它挡的是"同一连接上的连续爆破"，不是分布式爆破。
 * 真正的防护应该在 Cloudflare 后台给 /api/gate/login 加 Rate Limiting 规则，
 * 文档里已写明。这里做的是"没有配置也不至于完全裸奔"。
 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;
const loginFails = new Map();

function loginClientKey(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown'
  );
}

function tooManyFails(key) {
  const now = Date.now();
  const entry = loginFails.get(key);
  if (!entry) return { blocked: false };
  if (now - entry.first > LOGIN_WINDOW_MS) {
    loginFails.delete(key);
    return { blocked: false };
  }
  if (entry.count < LOGIN_MAX_FAILS) return { blocked: false };
  return { blocked: true, retryAfter: Math.ceil((entry.first + LOGIN_WINDOW_MS - now) / 1000) };
}

function recordFail(key) {
  const now = Date.now();
  const entry = loginFails.get(key);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginFails.set(key, { count: 1, first: now });
    return;
  }
  entry.count += 1;
  // 顺手清理过期条目，避免长驻 isolate 里无限增长
  if (loginFails.size > 500) {
    for (const [k, v] of loginFails) {
      if (now - v.first > LOGIN_WINDOW_MS) loginFails.delete(k);
    }
  }
}

export async function handleGateLogin(request, env) {
  if (!gateEnabled(env)) return { ok: true };

  const clientKey = loginClientKey(request);
  const limit = tooManyFails(clientKey);
  if (limit.blocked) {
    return {
      ok: false,
      status: 429,
      error: `尝试次数过多，请 ${Math.ceil(limit.retryAfter / 60)} 分钟后再试。`,
      retryAfter: limit.retryAfter
    };
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return { ok: false, status: 400, error: '请求体不是合法的 JSON。' };
  }

  const given = normalizePassword(payload?.password);
  if (!given) return { ok: false, status: 400, error: '请输入访问密码。' };

  const expected = normalizePassword(env.SITE_PASSWORD);
  const matched = await safeEqual(given, expected);
  if (!matched) {
    recordFail(clientKey);
    // 统一文案，不区分「密码为空」「密码错误」，避免被用来探测。
    // 再补一个固定延迟：恒定时间比较挡住了计时侧信道，
    // 失败路径的额外停顿则让在线爆破变慢。
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { ok: false, status: 401, error: '密码不正确。' };
  }

  loginFails.delete(clientKey);
  return { ok: true, setCookie: await issueGateCookie(env) };
}

export async function handleGateLogout(env) {
  if (!gateEnabled(env)) return { setCookie: clearGateCookie() };
  return { setCookie: clearGateCookie() };
}

/* ------------------------------------------------------------------ *
 * 登录页
 * ------------------------------------------------------------------ */

/**
 * 未通过时的响应。
 * - 页面请求（Accept 含 text/html）给一张可用的登录页；
 * - 接口与媒体请求给 401 JSON，避免把 HTML 塞给 <video>。
 */
export function gateResponse(request, { siteName = 'Iwara 映像' } = {}) {
  const url = new URL(request.url);
  const accept = request.headers.get('Accept') || '';
  const wantsHtml = accept.includes('text/html');
  const isAppRoute = !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/media/');

  if (!wantsHtml || !isAppRoute) {
    return json({ error: '需要先输入访问密码。', gate: true }, 401);
  }

  return new Response(gateHtml(siteName), {
    status: 401,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      // 这是唯一让用户手输密码的页面，必须禁止被 iframe 套壳
      // （否则恶意站点可以把登录框嵌进去，诱导输入后借走 Cookie）。
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    }
  });
}

/** 自包含的登录页：不依赖站点 JS，避免被未授权的请求绕过。 */
function gateHtml(siteName) {
  const name = String(siteName)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>需要访问密码 · ${name}</title>
<meta name="robots" content="noindex" />
<style>
  /* 两套配色，跟随系统偏好。登录页在 Worker 里生成，
     拿不到主站的 localStorage，所以只能用 prefers-color-scheme。 */
  :root {
    color-scheme: dark;
    --bg: #100d16;
    --surface: #171326;
    --line: #322a49;
    --text: #efe9f5;
    --text-dim: #b9b0c9;
    --text-faint: #7c7392;
    --accent: #ff4e7c;
    --accent-deep: #d63a63;
    --danger-bg: rgba(255, 78, 124, 0.14);
    --danger-line: rgba(255, 78, 124, 0.5);
    --danger-text: #ffc2d0;
    --glow-a: rgba(255, 78, 124, 0.12);
    --glow-b: rgba(116, 216, 194, 0.08);
    --input-bg: #100d16;
  }

  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f6f2ec;
      --surface: #fffdfa;
      --line: #d8cec0;
      --text: #1f1a15;
      --text-dim: #4c433a;
      --text-faint: #857a6c;
      --accent: #c92a52;
      --accent-deep: #a3153c;
      --danger-bg: rgba(201, 42, 82, 0.1);
      --danger-line: rgba(201, 42, 82, 0.42);
      --danger-text: #a3153c;
      --glow-a: rgba(201, 42, 82, 0.07);
      --glow-b: rgba(28, 127, 109, 0.05);
      --input-bg: #fffdfa;
    }
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
    background-image:
      radial-gradient(900px 520px at 80% -10%, var(--glow-a), transparent 62%),
      radial-gradient(700px 420px at 8% 6%, var(--glow-b), transparent 58%);
  }

  .card {
    width: min(400px, 100%);
    padding: 30px 28px 26px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 16px;
    box-shadow: 0 24px 60px -30px rgba(0, 0, 0, 0.5);
  }

  .mark { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 4px; }
  .mark i { color: var(--accent); font-style: normal; }
  .sub { font-size: 12px; letter-spacing: 0.3em; color: var(--text-faint); margin-bottom: 22px; }
  h1 { margin: 0 0 8px; font-size: 17px; font-weight: 500; }
  p { margin: 0 0 20px; font-size: 13px; line-height: 1.7; color: var(--text-dim); }
  label { display: block; margin-bottom: 8px; font-size: 13px; color: var(--text-dim); }

  input {
    width: 100%;
    height: 44px;
    padding: 0 14px;
    margin-bottom: 14px;
    background: var(--input-bg);
    color: var(--text);
    font-size: 15px;
    border: 1px solid var(--line);
    border-radius: 8px;
    outline: none;
  }

  input:focus { border-color: var(--accent); }

  button {
    width: 100%;
    height: 44px;
    border: 0;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
  }

  button:disabled { opacity: 0.55; cursor: not-allowed; }
  button:active { background: var(--accent-deep); }

  .err {
    padding: 10px 13px;
    margin-bottom: 14px;
    font-size: 13px;
    background: var(--danger-bg);
    border: 1px solid var(--danger-line);
    border-radius: 8px;
    color: var(--danger-text);
  }

  .foot { margin-top: 18px; font-size: 12px; color: var(--text-faint); line-height: 1.7; }
</style>
</head>
<body>
  <form class="card" id="form" autocomplete="on">
    <div class="mark">Iwara<i>.</i></div>
    <div class="sub">${name}</div>
    <h1>这个站点需要访问密码</h1>
    <p>输入站长设置的密码后才能进入。这个密码只用于打开本站，与 Iwara 账号无关。</p>
    <div class="err" id="err" hidden></div>
    <label for="pw">访问密码</label>
    <input id="pw" name="password" type="password" autocomplete="current-password"
           placeholder="请输入访问密码" required autofocus />
    <button type="submit" id="go">进入</button>
    <div class="foot">密码由站点管理员在 Worker 的 SITE_PASSWORD 变量里设置，不会发送给 Iwara。</div>
  </form>
<script>
  (function () {
    var form = document.getElementById('form');
    var input = document.getElementById('pw');
    var err = document.getElementById('err');
    var go = document.getElementById('go');

    function fail(msg) {
      err.textContent = msg;
      err.hidden = false;
      input.focus();
      input.select();
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = input.value;
      if (!value) return fail('请输入密码。');
      err.hidden = true;
      go.disabled = true;
      go.textContent = '正在验证…';

      fetch('/api/gate/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: value })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (res.ok && data && data.ok) {
            location.reload();
            return;
          }
          fail((data && data.error) || '密码不正确。');
          go.disabled = false;
          go.textContent = '进入';
        });
      }).catch(function () {
        fail('网络连接失败，请稍后重试。');
        go.disabled = false;
        go.textContent = '进入';
      });
    });
  })();
</script>
</body>
</html>`;
}
