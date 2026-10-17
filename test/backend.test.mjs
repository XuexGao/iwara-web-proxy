/**
 * 后端集成测试：直接调用 Worker 处理器，打真实的 Iwara 上游。
 *
 * 运行：node test/backend.test.mjs
 */

import worker from '../src/index.js';
import { installCurlFetch } from './curl-fetch.mjs';

// Node 的 TLS 指纹会被 Cloudflare 挑战，本地改用 curl 作为传输层。
installCurlFetch();

const memoryCache = new Map();
globalThis.caches = {
  default: {
    async match(request) {
      const key = typeof request === 'string' ? request : request.url;
      const entry = memoryCache.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt && entry.expiresAt < Date.now()) return undefined;
      return new Response(entry.body, { headers: entry.headers });
    },
    async put(request, response) {
      const key = typeof request === 'string' ? request : request.url;
      const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1];
      memoryCache.set(key, {
        body: await response.arrayBuffer(),
        headers: [...response.headers.entries()],
        expiresAt: maxAge ? Date.now() + Number(maxAge) * 1000 : 0
      });
    }
  }
};

const ENV = {
  SITE_NAME: 'Iwara 映像',
  DEFAULT_SITE: 'main',
  API_CACHE_TTL: '30',
  IMAGE_CACHE_TTL: '604800',
  VIDEO_CACHE_TTL: '3600',
  SESSION_SECRET: 'test-secret-for-local-integration'
};

const BASE = 'https://iwara.test';

async function call(path, init = {}) {
  const request = new Request(`${BASE}${path}`, init);
  const response = await worker.fetch(request, { ...ENV, ASSETS: { fetch: () => new Response('asset') } }, {});
  return response;
}

async function jsonCall(path, init) {
  const response = await call(path, init);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 200);
  }
  return { status: response.status, data, response };
}

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name} ${detail}`);
  }
}

/* ------------------------------------------------------------------ */

console.log('\n[1] 运维接口');
const status = await jsonCall('/api/status');
check('/api/status 返回 200', status.status === 200, JSON.stringify(status.data).slice(0, 200));
check('salt 已就绪', !!status.data?.salt?.salt, JSON.stringify(status.data?.salt));

console.log('\n[2] 业务接口代理');
const list = await jsonCall('/api/iwara/videos?page=0&sort=trending&rating=all');
check('视频列表 200', list.status === 200);
check('列表含 results', Array.isArray(list.data?.results) && list.data.results.length > 0);
check('列表字段完整', !!list.data?.results?.[0]?.file?.id && !!list.data?.results?.[0]?.file?.name);

console.log('\n[3] 代理白名单');
const blocked1 = await jsonCall('/api/iwara/etc/passwd');
check('非白名单根路径 403', blocked1.status === 403, String(blocked1.status));
const blocked2 = await jsonCall('/api/iwara/user/login', { method: 'POST', body: '{}' });
check('user/login 被拦截', blocked2.status === 403, String(blocked2.status));
const blocked3 = await jsonCall('/api/iwara/..%2f..%2fetc');
check('路径穿越被拦截', blocked3.status === 403, String(blocked3.status));

console.log('\n[4] 视频源与 X-Version 签名');
const videoId = list.data.results[0].id;
const sources = await jsonCall(`/api/sources/${videoId}`);
check('源接口 200', sources.status === 200, JSON.stringify(sources.data).slice(0, 240));
check('签名字盐值来自内置或站点', ['builtin', 'site'].includes(sources.data?.saltSource));
check('含原画 Source 档', sources.data?.sources?.some((s) => s.name === 'Source'), JSON.stringify(sources.data?.sources?.map((s) => s.name)));
check('含 hover 预览档', !!sources.data?.preview?.url);
check('播放地址已本地化', sources.data?.sources?.every((s) => s.url.startsWith('/media/v?u=')));

console.log('\n[5] 媒体代理');
const thumbFile = list.data.results[0].file;
const img = await call(`/media/i/image/thumbnail/${thumbFile.id}/${thumbFile.name}`);
check('缩略图 200', img.status === 200, String(img.status));
check('缩略图是图片', (img.headers.get('content-type') || '').startsWith('image/'), img.headers.get('content-type'));
check('缩略图可长缓存', (img.headers.get('cache-control') || '').includes('max-age='));

const badImg = await call('/media/i/image/original/../../secret');
check('图片路径穿越 403', badImg.status === 403, String(badImg.status));

const rawVideoUrl = sources.data.sources[0].url;
const range = await call(rawVideoUrl, { headers: { Range: 'bytes=0-2047' } });
check('视频分片请求 206', range.status === 206, String(range.status));
check('返回 content-range', !!range.headers.get('content-range'), range.headers.get('content-range'));
check('返回 content-type', !!range.headers.get('content-type'));
if (range.body) await range.body.cancel();

const badHost = await call('/media/v?u=' + encodeURIComponent('https://evil.example.com/steal'));
check('站外媒体主机 403', badHost.status === 403, String(badHost.status));

const noHost = await call('/media/v');
check('缺少 u 参数 403', noHost.status === 403, String(noHost.status));

console.log('\n[6] 认证接口');
const me = await jsonCall('/api/auth/me');
check('未登录时 authenticated=false', me.status === 200 && me.data?.authenticated === false, JSON.stringify(me.data));
const config = await jsonCall('/api/auth/config');
check('登录已启用（本地有 secret）', config.data?.loginEnabled === true);
const csrf = await jsonCall('/api/auth/logout', {
  method: 'POST',
  headers: { Origin: 'https://attacker.example.com' }
});
check('跨站写操作被拒绝', csrf.status === 403, String(csrf.status));
const logout = await jsonCall('/api/auth/logout', { method: 'POST' });
check('本站登出 200', logout.status === 200 && logout.data?.authenticated === false);
const badLogin = await jsonCall('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'nobody@example.com', password: 'definitely-wrong' })
});
check('错误凭据返回 401', badLogin.status === 401, `${badLogin.status} ${JSON.stringify(badLogin.data)}`);

console.log('\n[7] 图库与其它接口');
const images = await jsonCall('/api/iwara/images?page=0&sort=trending&rating=all');
check('图库列表 200', images.status === 200 && Array.isArray(images.data?.results));
const tags = await jsonCall('/api/iwara/tags?sort=popularity');
check('标签列表 200', tags.status === 200 && Array.isArray(tags.data?.results));
const detail = await jsonCall(`/api/iwara/video/${videoId}`);
check('视频详情 200', detail.status === 200 && detail.data?.id === videoId);
const comments = await jsonCall(`/api/iwara/video/${videoId}/comments`);
check('评论列表 200', comments.status === 200);

/* ------------------------------------------------------------------ */

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
