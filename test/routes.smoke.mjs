/**
 * 路由全量冒烟：逐个打开所有页面，确认没有一个抛出「页面加载失败」。
 *
 * 这类错误（漏 import、字段改名）在静态检查里很难发现，
 * 但一定会表现为某个页面白屏，所以用真实浏览器扫一遍最省事。
 *
 * 前置：node dev-server.mjs
 * 用法：node test/routes.smoke.mjs
 */

import { firefox } from 'playwright-core';

const EXECUTABLE =
  process.env.SHOT_FIREFOX || '/root/.cache/ms-playwright/firefox-1555/firefox/firefox';
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8788';

/** 这些路由需要真实内容 ID，先抓一个再拼。 */
const DYNAMIC = ['video', 'image', 'user', 'tag', 'playlist'];

const STATIC_ROUTES = [
  ['/', '首页'],
  ['/#/subscriptions', '订阅'],
  ['/#/subscriptions?kind=images', '订阅·图库'],
  ['/#/images', '图库列表'],
  ['/#/playlists', '播放列表'],
  ['/#/forum', '论坛'],
  ['/#/posts', '帖子'],
  ['/#/library/favorites', '收藏'],
  ['/#/library/history', '观看历史'],
  ['/#/settings', '设置'],
  ['/#/about', '关于'],
  ['/#/login', '登录'],
  ['/#/search?q=test', '搜索'],
  ['/#/search?q=&type=video', '搜索（空词）'],
  ['/#/not-a-real-page', '404']
];

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

async function waitFor(fn, timeout = 40000, interval = 800) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await fn().catch(() => null);
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return last;
}

const browser = await firefox.launch({ executablePath: EXECUTABLE, headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 940 },
  locale: 'zh-CN'
});
const page = await context.newPage();

/** 站点开了访问密码时，先过一遍，后续断言才有页面可测。 */
async function passGate() {
  const password = process.env.SITE_PASSWORD || '@Gao123456';
  await page.goto(`${BASE}/`, { waitUntil: 'commit', timeout: 60000 });
  if ((await page.locator('#pw').count()) === 0) return false;
  await page.locator('#pw').fill(password);
  await page.locator('#go').click();
  await new Promise((resolve) => setTimeout(resolve, 4000));
  return true;
}
await passGate();

const errors = [];
page.on('pageerror', (error) => errors.push(String(error).slice(0, 200)));
page.on('console', (message) => {
  if (message.type() === 'error' && !/render failed/.test(message.text())) {
    errors.push(message.text().slice(0, 200));
  }
});

/** 打开一个路由，返回是否渲染成功。 */
async function visit(hash, label) {
  await page.goto(`${BASE}${hash}`, { waitUntil: 'commit', timeout: 60000 });
  // 至少等到 #view 里有元素，再等一小会儿让异步内容落位。
  await waitFor(async () => (await page.locator('#view').count()) > 0 && (await page.locator('#view').innerHTML()).length > 40, 30000);
  await page.waitForTimeout(1400);

  // 作品页要等播放器挂上才算渲染完成；其余页面文案够长即可。
  await waitFor(
    async () => {
      const t = await page.locator('#view').innerText().catch(() => '');
      if (t.includes('页面加载失败')) return true;
      if (hash.startsWith('#/video/')) return (await page.locator('.watch__title').count()) > 0;
      return t.trim().length > 0;
    },
    30000
  );

  const text = await page.locator('#view').innerText().catch(() => '');
  const crashed = text.includes('页面加载失败');
  const detail = crashed ? text.replace(/\n+/g, ' ').slice(0, 160) : text.slice(0, 60).replace(/\n+/g, ' ');
  check(`${label} (${hash})`, !crashed && text.trim().length > 0, detail);
  return { text, crashed };
}

console.log('\n[1] 静态路由');
for (const [hash, label] of STATIC_ROUTES) {
  await visit(hash, label);
}

console.log('\n[2] 动态路由（需要真实 ID）');
// 首页拿一个视频
await page.goto(`${BASE}/`, { waitUntil: 'commit' });
const videoHref = await waitFor(async () => {
  const href = await page.locator('a.card__title[href^="#/video/"]').first().getAttribute('href').catch(() => null);
  return href || null;
});

if (videoHref) {
  const { text } = await visit(videoHref, '作品页');
  if (!text.includes('页面加载失败')) {
    // 从作品页拿作者与标签链接
    const userHref = await page.locator('a.card__author, a.authorbar__name').first().getAttribute('href').catch(() => null);
    const tagHref = await page.locator('a.tagchip').first().getAttribute('href').catch(() => null);
    if (userHref) await visit(userHref, '作者页');
    if (tagHref) await visit(tagHref, '标签页');
  }
} else {
  check('作品页', false, '首页没拿到作品链接');
}

await page.goto(`${BASE}/#/images`, { waitUntil: 'commit' });
const imageHref = await waitFor(async () => {
  const href = await page.locator('a.card__title[href^="#/image/"]').first().getAttribute('href').catch(() => null);
  return href || null;
});
if (imageHref) await visit(imageHref, '图库详情');

await page.goto(`${BASE}/#/playlists`, { waitUntil: 'commit' });
const playlistHref = await waitFor(async () => {
  const href = await page.locator('a.card__title[href^="#/playlist/"]').first().getAttribute('href').catch(() => null);
  return href || null;
});
if (playlistHref) await visit(playlistHref, '播放列表详情');

console.log('\n[3] 已移除的路由');
await page.goto(`${BASE}/#/tags`, { waitUntil: 'commit' });
await page.waitForTimeout(1500);
const tagsText = await page.locator('#view').innerText();
check('标签索引页已移除（显示 404）', tagsText.includes('这个地址不存在'), tagsText.slice(0, 60));

console.log('\n[4] 主题切换');
await page.goto(`${BASE}/`, { waitUntil: 'commit' });
await page.waitForTimeout(2000);
const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
await page.locator('#theme-button').click();
await page.waitForTimeout(1200);
const themeAfter = await page.evaluate(() => document.documentElement.dataset.theme);
check('点击可切换配色', themeBefore !== themeAfter, `${themeBefore} -> ${themeAfter}`);
const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
check('浅色主题底色已切换', themeAfter !== 'light' || bodyBg.includes('246'), bodyBg);

await browser.close();

const ignorable = /favicon|NS_BINDING|Download is not allowed|NS_ERROR_ABORT|preload/i;
const realErrors = errors.filter((line) => !ignorable.test(line));

console.log(`\n控制台错误：${realErrors.length ? realErrors.length + ' 条' : '无'}`);
for (const line of realErrors.slice(0, 10)) console.log(`  · ${line}`);

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed || realErrors.length ? 1 : 0);
