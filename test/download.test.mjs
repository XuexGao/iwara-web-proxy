/**
 * 下载文件名测试。
 *
 * 回归点：以前用的是上游的 <uuid>_Source.mp4，下下来一串 UUID 认不出是什么。
 * 现在应该是作品标题，且中文能正确编码（RFC 5987）。
 */

import worker from '../src/index.js';
import { installCurlFetch } from './curl-fetch.mjs';

installCurlFetch();
globalThis.caches = {
  default: { async match() { return undefined; }, async put() {}, async delete() { return false; } }
};

const ENV = {
  SITE_NAME: 'Iwara 映像',
  DEFAULT_SITE: 'main',
  API_CACHE_TTL: '0',
  IMAGE_CACHE_TTL: '0',
  SESSION_SECRET: 'test-secret-for-download-tests',
  ASSETS: { fetch: () => new Response('asset') }
};

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

// 取一个真实作品
const listRes = await worker.fetch(
  new Request('https://iwara.test/api/iwara/videos?page=0&sort=trending&rating=all'),
  ENV
);
const list = await listRes.json();
const video = list?.results?.[0];

if (!video?.id) {
  console.log('拿不到测试作品，跳过（检查网络）');
  process.exit(0);
}

console.log('\n[1] 解析出的下载文件名');
const srcRes = await worker.fetch(
  new Request(`https://iwara.test/api/sources/${video.id}`),
  ENV
);
const data = await srcRes.json();
check('拿到清晰度列表', Array.isArray(data?.sources) && data.sources.length > 0);

const source = data.sources.find((s) => s.name === 'Source') || data.sources[0];
// downloadUrl 是本站相对路径，dl 参数已经在里面了。
const dl = new URL(`https://iwara.test${source.downloadUrl}`).searchParams.get('dl');
console.log(`  作品标题: ${video.title}`);
console.log(`  文件名:   ${dl}`);

check('文件名来自标题', dl && dl.includes(video.title.slice(0, 8)), String(dl));
check('文件名不以 UUID 开头', dl && !/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(dl), String(dl));
check('文件名带扩展名', /\.[a-z0-9]{2,5}$/i.test(dl || ''), String(dl));
check('不含路径分隔符', dl && !/[/\\]/.test(dl), String(dl));

const quality = data.sources.find((s) => s.name !== 'Source');
if (quality) {
  const qdl = new URL(`https://iwara.test${quality.downloadUrl}`).searchParams.get('dl');
  check('非原画档带清晰度后缀', qdl && qdl.includes(quality.name), String(qdl));
  console.log(`  ${quality.name} 档: ${qdl}`);
}

console.log('\n[2] Content-Disposition 头');
const head = await worker.fetch(
  new Request(`https://iwara.test${source.downloadUrl}`, { headers: { Range: 'bytes=0-99' } }),
  ENV
);
const cd = head.headers.get('content-disposition') || '';
console.log(`  ${cd.slice(0, 120)}...`);

check('是 attachment', cd.startsWith('attachment;'), cd.slice(0, 40));
check('有 ASCII 兜底 filename', /filename="[^"]+"/.test(cd), cd.slice(0, 80));
check('有 RFC 5987 的 filename*', /filename\*=UTF-8''/.test(cd), cd.slice(0, 120));

const encoded = /filename\*=UTF-8''([^;]+)/.exec(cd)?.[1];
if (encoded) {
  let decoded = '';
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    decoded = '';
  }
  check('filename* 能正确解码', decoded.length > 0, encoded.slice(0, 40));
  check('解码后是完整标题', decoded.includes(video.title.slice(0, 8)), decoded);
  check('解码后中文没有乱码', !decoded.includes('\uFFFD'), decoded);
  console.log(`  解码后: ${decoded}`);
}

if (head.body) await head.body.cancel();

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
