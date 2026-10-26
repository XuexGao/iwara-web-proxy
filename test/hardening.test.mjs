/**
 * 安全加固的回归测试。
 *
 * 覆盖审查报告里的 S-1 / S-7 / S-2 / S-3 / S-6 与 CSRF 同源判定。
 * 这些都是"能静默失效"的逻辑，必须用测试钉住。
 */

import { isAllowedApiPath } from '../src/api.js';
import { buildImageTarget, isSameSiteMediaRequest } from '../src/media.js';
import { handleGateLogin, gateResponse } from '../src/gate.js';
import { isSameOriginRequest } from '../src/util.js';

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

console.log('\n[S-1] API 路径白名单');
check('正常路径放行', isAllowedApiPath('/videos') === true);
check('未知根路径拒绝', isAllowedApiPath('/admin') === false);
check('登录路径拒绝', isAllowedApiPath('/user/login') === false);
check('改密路径拒绝', isAllowedApiPath('/user/password') === false);
for (const evil of [
  '/videos/%2e%2e%2fuser/login',
  '/videos/%2E%2E%2Fuser/password',
  '/videos/..%2fuser/login',
  '/videos/%2e%2e/user/login',
  '/videos/%252e%252e/user/login',
  '/videos/..\\user/login'
]) {
  check(`编码穿越被拒: ${evil}`, isAllowedApiPath(evil) === false);
}
check('中文标签仍放行', isAllowedApiPath('/tags/%E4%B8%AD%E6%96%87') === true);
check('普通作品 ID 放行', isAllowedApiPath('/video/abc123') === true);

console.log('\n[S-7] 图片路径白名单');
check('正常缩略图放行', !!buildImageTarget('/image/thumbnail/abc/thumbnail-00.jpg'));
check('正常头像放行', !!buildImageTarget('/image/avatar/abc/avatar.jpg'));
for (const evil of ['/image/large/%2e%2e/%2e%2e/etc', '/image/%2e%2e/secret', '/image/large/../../x']) {
  check(`编码穿越被拒: ${evil}`, buildImageTarget(evil) === null);
}

console.log('\n[S-2] 媒体来源校验');
function req(url, headers = {}) {
  return new Request(url, { headers });
}
check(
  '同源页面放行',
  isSameSiteMediaRequest(req('https://a.test/media/v?u=x', { 'Sec-Fetch-Site': 'same-origin' })) === true
);
check(
  '直接打开放行',
  isSameSiteMediaRequest(req('https://a.test/media/v?u=x', { 'Sec-Fetch-Site': 'none' })) === true
);
check(
  '跨站嵌套拒绝',
  isSameSiteMediaRequest(req('https://a.test/media/v?u=x', { 'Sec-Fetch-Site': 'cross-site' })) === false
);
check(
  '外站 Referer 拒绝',
  isSameSiteMediaRequest(req('https://a.test/media/v?u=x', { Referer: 'https://evil.test/' })) === false
);
check(
  '本站 Referer 放行',
  isSameSiteMediaRequest(req('https://a.test/media/v?u=x', { Referer: 'https://a.test/#/video/1' })) === true
);
check(
  '无任何头（下载器）放行',
  isSameSiteMediaRequest(req('https://a.test/media/v?u=x')) === true
);

console.log('\n[S-6] 登录页禁止被套壳');
const gateRes = gateResponse(
  new Request('https://a.test/', { headers: { Accept: 'text/html' } }),
  { siteName: 'test' }
);
check('有 X-Frame-Options', gateRes.headers.get('x-frame-options') === 'DENY');
check(
  'CSP 含 frame-ancestors none',
  (gateRes.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'")
);

console.log('\n[S-3] 站点密码频控');
const ENV = { SITE_PASSWORD: '@test123', SESSION_SECRET: 'test-secret-for-gate-limit' };
function loginReq() {
  return new Request('https://a.test/api/gate/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify({ password: 'wrong-password' })
  });
}
let lastStatus = 0;
// 阈值是 15 次 / 5 分钟，所以要多试几次才能触发
for (let i = 0; i < 20; i += 1) {
  const result = await handleGateLogin(loginReq(), ENV);
  lastStatus = result.status || (result.ok ? 200 : 401);
  if (lastStatus === 429) break;
}
check('连续失败后返回 429', lastStatus === 429, String(lastStatus));

const okResult = await handleGateLogin(
  new Request('https://a.test/api/gate/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
    body: JSON.stringify({ password: '@test123' })
  }),
  ENV
);
check('另一个 IP 仍能正常登录', okResult.ok === true && !!okResult.setCookie);

console.log('\n[CSRF] 同源判定比较协议/端口');
function originReq(origin) {
  return new Request('https://a.test/api/iwara/x', {
    method: 'POST',
    headers: origin ? { Origin: origin } : {}
  });
}
check('同源放行', isSameOriginRequest(originReq('https://a.test')) === true);
check('协议不同拒绝', isSameOriginRequest(originReq('http://a.test')) === false);
check('端口不同拒绝', isSameOriginRequest(originReq('https://a.test:8443')) === false);
check('外站拒绝', isSameOriginRequest(originReq('https://evil.test')) === false);

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
