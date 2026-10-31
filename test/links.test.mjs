/**
 * 搜索框粘贴 Iwara 链接 → 内部路由。
 *
 * 场景：把 https://www.iwara.tv/video/xxx 粘进搜索框，直接跳到作品页，
 * 而不是拿整串去做关键词搜索（那样永远搜不到）。
 */

import { routeFromInput } from '../public/js/links.js';

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

console.log('\n[1] 作品 / 图库');
check('video 链接', routeFromInput('https://www.iwara.tv/video/abc123') === '/video/abc123');
check(
  '带 slug 与查询串也能取到 id',
  routeFromInput('https://www.iwara.tv/video/abc123/my-slug?utm_source=x') === '/video/abc123'
);
check('image 链接', routeFromInput('http://iwara.tv/image/xyz789') === '/image/xyz789');
check('省略协议', routeFromInput('www.iwara.tv/video/abc123') === '/video/abc123');
check('子域名', routeFromInput('https://m.iwara.tv/video/abc123') === '/video/abc123');
check('大小写不敏感的主机', routeFromInput('https://WWW.IWARA.TV/video/abc123') === '/video/abc123');

console.log('\n[2] 作者 / 列表 / 其它');
check('profile → user 路由', routeFromInput('https://www.iwara.tv/profile/someuser') === '/user/someuser');
check('playlist', routeFromInput('https://www.iwara.tv/playlist/pl123') === '/playlist/pl123');
check('tags → tag', routeFromInput('https://www.iwara.tv/tags/blender') === '/tag/blender');
check('forum 主题', routeFromInput('https://www.iwara.tv/forum/anime/12345') === '/forum/anime/12345');
check('forum 分类', routeFromInput('https://www.iwara.tv/forum/anime') === '/forum/anime');
check('videos 列表回首页', routeFromInput('https://www.iwara.tv/videos') === '/');

console.log('\n[3] iwara.ai 带 _site');
check('ai 视频', routeFromInput('https://www.iwara.ai/video/aiid') === '/video/aiid?_site=ai');
check('ai 图库', routeFromInput('https://www.iwara.ai/image/x1') === '/image/x1?_site=ai');
check('ai 首页', routeFromInput('https://www.iwara.ai/videos') === '/?_site=ai');

console.log('\n[4] 不该被当成链接');
check('普通关键词', routeFromInput('genshin impact') === null);
check('外站链接', routeFromInput('https://evil.test/video/abc') === null);
check('长得像但不是 iwara 域名', routeFromInput('https://iwara.tv.evil.test/video/a') === null);
check('空字符串', routeFromInput('') === null);
check('只有域名', routeFromInput('https://www.iwara.tv/') === null);
check('/user/uuid 认不出用户名 → 交给搜索', routeFromInput('https://www.iwara.tv/user/abc') === null);
check('未知路径', routeFromInput('https://www.iwara.tv/whatever/abc') === null);

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
