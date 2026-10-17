/**
 * 站点访问密码的测试。
 *
 * 覆盖：开启后拦一切、错误密码拒绝、正确密码放行、
 * 换密码后旧凭证失效、登出后回到登录页。
 */

import worker from '../src/index.js';
import { installCurlFetch } from './curl-fetch.mjs';

installCurlFetch();

globalThis.caches = {
  default: { async match() { return undefined; }, async put() {}, async delete() { return false; } }
};

const BASE = 'https://iwara.test';
const PASSWORD = '@Gao123456';

function envWith(overrides = {}) {
  return {
    SITE_NAME: 'Iwara 映像',
    DEFAULT_SITE: 'main',
    API_CACHE_TTL: '0',
    IMAGE_CACHE_TTL: '0',
    SESSION_SECRET: 'test-secret-for-gate-tests',
    ASSETS: { fetch: () => new Response('asset', { headers: { 'content-type': 'text/html' } }) },
    ...overrides
  };
}

async function call(path, env, init = {}) {
  return worker.fetch(new Request(`${BASE}${path}`, init), env, {});
}

function cookiesFrom(response) {
  const raw = response.headers.getSetCookie?.() || [];
  return raw.map((line) => line.split(';')[0]).filter(Boolean);
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${detail}`);
  }
}

/* ------------------------------------------------------------------ */

console.log('\n[1] 未开启密码时一切正常');
{
  const env = envWith();
  const res = await call('/api/status', env);
  check('/api/status 直接可用', res.status === 200, String(res.status));
  const page = await call('/', env, { headers: { Accept: 'text/html' } });
  check('页面直接可用', page.status === 200, String(page.status));
}

console.log('\n[2] 开启密码后拦截');
{
  const env = envWith({ SITE_PASSWORD: PASSWORD });

  const page = await call('/', env, { headers: { Accept: 'text/html' } });
  const html = await page.text();
  check('页面请求返回 401', page.status === 401, String(page.status));
  check('返回的是密码登录页', html.includes('需要访问密码') && html.includes('id="pw"'));
  check('登录页不泄露密码', !html.includes(PASSWORD));

  const api = await call('/api/status', env);
  check('接口请求返回 401', api.status === 401, String(api.status));
  const apiBody = await api.json();
  check('接口返回 JSON 而非 HTML', apiBody.gate === true, JSON.stringify(apiBody));

  const media = await call('/media/i/image/thumbnail/x/thumbnail-03.jpg', env);
  check('媒体请求被拦截', media.status === 401, String(media.status));

  const iwaraApi = await call('/api/iwara/videos', env);
  check('业务接口被拦截', iwaraApi.status === 401, String(iwaraApi.status));

  const status = await call('/api/gate/status', env);
  const statusBody = await status.json();
  check('状态接口报告需要密码且未通过', statusBody.required === true && statusBody.authorised === false, JSON.stringify(statusBody));
}

console.log('\n[3] 密码校验');
{
  const env = envWith({ SITE_PASSWORD: PASSWORD });
  const post = (body) =>
    call('/api/gate/login', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  const wrong = await post({ password: 'wrong-password' });
  check('错误密码 401', wrong.status === 401, String(wrong.status));
  check('错误密码不下发凭证', cookiesFrom(wrong).length === 0);

  const empty = await post({ password: '' });
  check('空密码 400', empty.status === 400, String(empty.status));

  const nearMiss = await post({ password: PASSWORD.slice(0, -1) });
  check('少一位也不行', nearMiss.status === 401, String(nearMiss.status));

  const right = await post({ password: PASSWORD });
  check('正确密码 200', right.status === 200, String(right.status));
  const cookies = cookiesFrom(right);
  check('下发了凭证 Cookie', cookies.some((c) => c.startsWith('iwara_gate=')), cookies.join('|'));
  const raw = right.headers.get('set-cookie') || '';
  check('Cookie 是 HttpOnly', raw.includes('HttpOnly'));
  check('Cookie 是 Secure', raw.includes('Secure'));
  check('Cookie 是 SameSite', raw.includes('SameSite='));

  // 带凭证访问
  const cookieHeader = cookies.join('; ');
  const page = await call('/', env, { headers: { Accept: 'text/html', Cookie: cookieHeader } });
  check('带凭证可访问页面', page.status === 200, String(page.status));
  const api = await call('/api/gate/status', env, { headers: { Cookie: cookieHeader } });
  const body = await api.json();
  check('状态接口报告已通过', body.authorised === true, JSON.stringify(body));

  console.log('\n[4] 伪造与失效');
  const forged = await call('/', env, { headers: { Accept: 'text/html', Cookie: 'iwara_gate=forged' } });
  check('伪造凭证被拒', forged.status === 401, String(forged.status));

  // 换密码后旧凭证必须失效
  const env2 = envWith({ SITE_PASSWORD: 'another-password-xyz' });
  const stale = await call('/', env2, { headers: { Accept: 'text/html', Cookie: cookieHeader } });
  check('换密码后旧凭证失效', stale.status === 401, String(stale.status));

  // 登出
  const out = await call('/api/gate/logout', env, {
    method: 'POST',
    headers: { Cookie: cookieHeader }
  });
  check('登出成功', out.status === 200, String(out.status));
  const cleared = out.headers.get('set-cookie') || '';
  check('登出清掉 Cookie', cleared.includes('iwara_gate=') && cleared.includes('Max-Age=0'), cleared);
}

console.log('\n[5] 跨站保护');
{
  const env = envWith({ SITE_PASSWORD: PASSWORD });
  const cross = await call('/api/gate/login', env, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ password: PASSWORD })
  });
  check('跨站提交被拒', cross.status === 403, String(cross.status));
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
