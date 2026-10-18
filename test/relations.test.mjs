/**
 * 粉丝 / 关注列表的测试。
 *
 * 回归点：上游的关系列表不是裸用户对象——
 *   粉丝：{ id, createdAt, follower: {...} }
 *   关注：{ id, createdAt, user: {...} }
 * 直接渲染外层会得到一堆"匿名"（软件端显示正常，因为客户端取的是内层）。
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
  SESSION_SECRET: 'test-secret-for-relations',
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

// 找一个有粉丝的作者
const listRes = await worker.fetch(
  new Request('https://iwara.test/api/iwara/videos?page=0&sort=trending&rating=all'),
  ENV
);
const list = await listRes.json();
const userId = list?.results?.[0]?.user?.id;

if (!userId) {
  console.log('拿不到测试作者，跳过');
  process.exit(0);
}

console.log('\n[1] 粉丝列表结构');
const fwRes = await worker.fetch(
  new Request(`https://iwara.test/api/iwara/user/${userId}/followers?page=0&limit=3`),
  ENV
);
const fw = await fwRes.json();
check('接口返回 200 结构', !!fw && Array.isArray(fw.results), JSON.stringify(fw).slice(0, 80));

const followerItem = fw?.results?.[0];
if (followerItem) {
  check('条目有 follower 字段', !!followerItem.follower, Object.keys(followerItem).join(','));
  check('follower 里有 username', !!followerItem.follower?.username, JSON.stringify(followerItem.follower).slice(0, 80));
  check('条目外层没有 username（所以不能直接渲染）', !followerItem.username, JSON.stringify(followerItem.username));
  console.log(`  第一个粉丝: ${followerItem.follower?.name} (@${followerItem.follower?.username})`);

  // 模拟前端取值
  const user = followerItem.follower || followerItem.user || followerItem;
  check('按前端逻辑能取到名字', !!user?.name || !!user?.username, JSON.stringify(user).slice(0, 80));
}

console.log('\n[2] 关注列表结构');
const fgRes = await worker.fetch(
  new Request(`https://iwara.test/api/iwara/user/${userId}/following?page=0&limit=3`),
  ENV
);
const fg = await fgRes.json();
check('接口返回 200 结构', !!fg && Array.isArray(fg.results), JSON.stringify(fg).slice(0, 80));

const followingItem = fg?.results?.[0];
if (followingItem) {
  check('条目有 user 字段', !!followingItem.user, Object.keys(followingItem).join(','));
  check('user 里有 username', !!followingItem.user?.username);
  console.log(`  第一个关注: ${followingItem.user?.name} (@${followingItem.user?.username})`);
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
