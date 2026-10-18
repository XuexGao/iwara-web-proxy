/**
 * 搜索测试。
 *
 * 三个真实的坑（都修过）：
 * 1. 上游 /search 的 type 必须是复数（videos/images/users/posts），
 *    传单数会直接 500，看起来像"搜索坏了"。
 * 2. 前端 unwrap 曾经把 item.user（作者字段）当成包裹层，
 *    结果整个作品被替换成作者，标题全变"无标题"。
 * 3. refreshSession 整体重建 session 对象，把并发取回的 sharedToken 抹掉，
 *    导致服务端配了共享 Token、前端仍然显示"需要登录"。
 */

import worker from '../src/index.js';
import { installCurlFetch } from './curl-fetch.mjs';

installCurlFetch();
globalThis.caches = {
  default: { async match() { return undefined; }, async put() {}, async delete() { return false; } }
};

const SHARED = process.env.TEST_IWARA_TOKEN || '';
const ENV = {
  SITE_NAME: 'Iwara 映像',
  DEFAULT_SITE: 'main',
  API_CACHE_TTL: '0',
  IMAGE_CACHE_TTL: '0',
  SESSION_SECRET: 'test-secret-for-search',
  IWARA_AUTHORIZATION: SHARED,
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

if (!SHARED) {
  console.log('未提供 TEST_IWARA_TOKEN，跳过（搜索需要有效 token）');
  process.exit(0);
}

console.log('\n[1] 复数 type 才有效');
for (const type of ['videos', 'images', 'users', 'posts']) {
  const res = await worker.fetch(
    new Request(`https://iwara.test/api/iwara/search?query=genshin&type=${type}&page=0&limit=3`),
    ENV
  );
  const data = await res.json().catch(() => null);
  check(`type=${type} 返回 200`, res.status === 200, String(res.status));
  check(`type=${type} 有结果`, Array.isArray(data?.results) && data.results.length > 0,
        `count=${data?.count}`);
}

console.log('\n[2] 单数 type 会被上游拒绝（记录这个坑）');
const singular = await worker.fetch(
  new Request('https://iwara.test/api/iwara/search?query=genshin&type=video&page=0&limit=3'),
  ENV
);
check('type=video 返回 500', singular.status === 500, String(singular.status));

console.log('\n[3] 结果结构：作品对象自带 user 字段');
const res = await worker.fetch(
  new Request('https://iwara.test/api/iwara/search?query=genshin&type=videos&page=0&limit=1'),
  ENV
);
const data = await res.json();
const item = data?.results?.[0];
check('有 title', !!item?.title, JSON.stringify(item).slice(0, 60));
check('有 user（作者字段，不能当包裹层）', !!item?.user);
check('title 不是作者名', item?.title !== item?.user?.name, `${item?.title} vs ${item?.user?.name}`);

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
