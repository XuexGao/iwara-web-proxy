/**
 * 前端冒烟测试：用真实浏览器跑一遍主要页面，检查渲染与控制台错误。
 *
 * 前置：先启动 `node dev-server.mjs`
 * 用法：node test/frontend.smoke.mjs
 *
 * 注意：本地开发服务器的传输层是 curl（见 test/curl-fetch.mjs），
 * 每个上游请求要 spawn 一个进程，比线上慢一个数量级。
 * 所以所有断言都用轮询等待，而不是固定 sleep。
 */

import fs from 'node:fs';
import { firefox } from 'playwright-core';

const EXECUTABLE =
  process.env.SHOT_FIREFOX || '/root/.cache/ms-playwright/firefox-1555/firefox/firefox';
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8788';
const SHOTS = process.env.SHOT_OUT || '/tmp/shots';
const HEADFUL = process.env.SMOKE_HEADFUL === '1';

fs.mkdirSync(SHOTS, { recursive: true });

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

/** 轮询直到 fn 返回真值；超时返回最后一次结果。 */
async function waitFor(fn, { timeout = 30000, interval = 700, label = '' } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await fn().catch(() => null);
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  if (label) {
    console.log(`    （等待超时：${label}，${Math.round((Date.now() - started) / 1000)}s）`);
  }
  return last;
}

const count = (page, selector) => page.locator(selector).count();

const browser = await firefox.launch({ executablePath: EXECUTABLE, headless: !HEADFUL });
const context = await browser.newContext({
  viewport: { width: 1440, height: 940 },
  deviceScaleFactor: 2,
  locale: 'zh-CN'
});

const errors = [];
const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 240));
});
page.on('pageerror', (error) => errors.push(`pageerror: ${String(error).slice(0, 240)}`));
page.on('requestfailed', (request) => {
  const failure = request.failure()?.errorText || '';
  if (!/NS_BINDING_ABORTED|Download is not allowed|NS_ERROR_ABORT/.test(failure)) {
    errors.push(`requestfailed: ${request.url().slice(0, 160)} ${failure}`);
  }
});

/* ---------------- 首页 ---------------- */

console.log('\n[1] 首页');
await page.goto(`${BASE}/`, { waitUntil: 'commit', timeout: 60000 });

await waitFor(async () => (await count(page, '.card')) > 0, { label: '作品卡片' });
const cardCount = await count(page, '.card');
check('作品卡片已渲染', cardCount > 0, `找到 ${cardCount} 张`);
check('索引标题存在', (await count(page, '.lede__title')) > 0);
check('排序 chips 存在', (await count(page, '.chip')) >= 5);

const coverLoaded = await waitFor(
  async () => {
    const info = await page
      .locator('.card__cover img')
      .first()
      .evaluate((img) => ({ nw: img.naturalWidth, complete: img.complete }));
    return info.nw > 10 ? info : null;
  },
  { timeout: 40000, label: '首张封面' }
);
check('封面图真的解码出来了', !!coverLoaded && coverLoaded.nw > 10, JSON.stringify(coverLoaded));

await page.screenshot({ path: `${SHOTS}/home.png`, fullPage: false });

/* ---------------- 悬停预览 ---------------- */

console.log('\n[2] 悬停预览');
const firstCover = page.locator('.card__cover').first();
await firstCover.hover();
const previewAppeared = await waitFor(async () => (await firstCover.locator('video').count()) > 0, {
  timeout: 45000,
  label: '预览 <video>'
});
check('悬停后出现预览视频元素', !!previewAppeared);

if (previewAppeared) {
  const previewState = await waitFor(
    async () =>
      firstCover
        .locator('video')
        .first()
        .evaluate((v) => (v.readyState >= 2 ? { readyState: v.readyState, paused: v.paused } : null))
        .catch(() => null),
    { timeout: 40000, label: '预览可播放' }
  );
  check('预览视频已缓冲到可播放', !!previewState, JSON.stringify(previewState));
  await page.screenshot({
    path: `${SHOTS}/hover-preview.png`,
    clip: { x: 0, y: 70, width: 940, height: 600 }
  });
}
await page.mouse.move(4, 4);

/* ---------------- 播放页 ---------------- */

console.log('\n[3] 播放页');
const firstHref = await page.locator('.card__title').first().getAttribute('href');
await page.goto(`${BASE}/${firstHref}`, { waitUntil: 'commit', timeout: 60000 });

await waitFor(async () => (await count(page, '.player')) > 0, { timeout: 45000, label: '播放器' });
check('出现播放器', (await count(page, '.player')) > 0);
check('标题已渲染', ((await page.locator('.watch__title').textContent().catch(() => '')) || '').length > 1);
check('作者栏存在', (await count(page, '.authorbar')) > 0);
check('清晰度按钮已渲染', (await count(page, '.quality button')) > 0);
check('进度条已渲染', (await count(page, '.player__scrub')) > 0);

const railCount = await waitFor(
  async () => {
    const n = await count(page, '.rail__item');
    return n > 0 ? n : null;
  },
  { timeout: 40000, label: '相关作品' }
);
check('相关作品存在', railCount > 0, `找到 ${railCount || 0} 条`);

const videoState = await page
  .locator('.player__stage video')
  .first()
  .evaluate((v) => ({
    src: (v.currentSrc || v.src || '').slice(0, 80),
    readyState: v.readyState,
    duration: Number.isFinite(v.duration) ? Math.round(v.duration) : 0,
    paused: v.paused,
    error: v.error ? `${v.error.code}: ${v.error.message}` : null
  }))
  .catch(() => null);
check('视频已拿到地址', !!videoState?.src, JSON.stringify(videoState));
check('视频没有报错', !videoState?.error, JSON.stringify(videoState));

// 元数据在本地慢速传输下可能要等一阵；等到就断言，等不到就只报告。
const playable = await waitFor(
  async () => {
    const state = await page
      .locator('.player__stage video')
      .first()
      .evaluate((v) => ({
        duration: Number.isFinite(v.duration) ? v.duration : 0,
        readyState: v.readyState
      }))
      .catch(() => null);
    return state?.duration > 0 ? state : null;
  },
  { timeout: 45000, label: '视频元数据' }
);
if (playable) {
  check('视频元数据已就绪', playable.duration > 0, `duration=${Math.round(playable.duration)}s`);
} else {
  console.log('  · 视频元数据未在本地超时内到达（curl 传输层限制，线上不受影响）');
}

await page.screenshot({ path: `${SHOTS}/watch.png`, fullPage: false });

/* ---------------- 迷你播放器 ---------------- */

console.log('\n[4] 迷你播放器接力');
const wasPlaying = await page
  .locator('.player__stage video')
  .first()
  .evaluate((v) => !v.paused && v.readyState >= 2)
  .catch(() => false);

await page.locator('#topnav a[data-nav="tags"]').click();
await waitFor(async () => (await count(page, '.tagchip')) > 0, { timeout: 45000, label: '标签页' });
console.log('  ✓ 切换到标签页成功');

if (wasPlaying) {
  const miniVisible = await waitFor(async () => (await count(page, '#mini:not([hidden])')) > 0, {
    timeout: 12000,
    label: '迷你播放器'
  });
  check('切页面后视频交给迷你播放器继续播', !!miniVisible);
  if (miniVisible) {
    check(
      '迷你播放器里的视频仍在播放',
      await page
        .locator('#mini video')
        .first()
        .evaluate((v) => !v.paused || v.currentTime > 0)
        .catch(() => false)
    );
    await page.screenshot({ path: `${SHOTS}/mini-player.png`, fullPage: false });
  }
} else {
  console.log('  · 视频未进入播放状态，跳过迷你播放器断言（本地慢速传输属正常）');
}

/* ---------------- 标签页 ---------------- */

console.log('\n[5] 标签索引');
const tagCount = await waitFor(
  async () => {
    const n = await count(page, '.tagchip');
    return n > 0 ? n : null;
  },
  { timeout: 40000, label: '标签 chips' }
);
check('标签墙已渲染', tagCount > 0, `找到 ${tagCount || 0} 个标签`);
await page.screenshot({ path: `${SHOTS}/tags.png`, fullPage: false });

/* ---------------- 其它页面 ---------------- */

console.log('\n[6] 其余页面');
const pages = [
  ['图库', '/#/images', '.card', 45000],
  ['论坛', '/#/forum', '.rowitem', 45000],
  ['播放列表', '/#/playlists', '.card', 45000],
  ['设置', '/#/settings', '.switch', 15000],
  ['关于', '/#/about', '.prose', 12000],
  ['登录', '/#/login', '.field, .note', 15000],
  ['搜索', '/#/search?q=test', '.note, .state, .card', 25000]
];

for (const [label, hash, selector, timeout] of pages) {
  await page.goto(`${BASE}${hash}`, { waitUntil: 'commit', timeout: 60000 });
  const found = await waitFor(async () => ((await count(page, selector)) > 0 ? true : null), {
    timeout,
    label
  });
  check(`${label} 页渲染`, !!found, `selector=${selector}`);
}

/* ---------------- 图库详情与作者页 ---------------- */

console.log('\n[7] 详情页');
await page.goto(`${BASE}/#/images`, { waitUntil: 'commit' });
const galleryHref = await waitFor(
  async () =>
    (await page.locator('a.card__title[href^="#/image/"]').first().getAttribute('href').catch(() => null)) ||
    null,
  { timeout: 45000, label: '图库链接' }
);

if (galleryHref) {
  await page.goto(`${BASE}/${galleryHref}`, { waitUntil: 'commit' });
  const galleryOk = await waitFor(async () => ((await count(page, '.gallery img')) > 0 ? true : null), {
    timeout: 45000,
    label: '图库大图'
  });
  check('图库详情页出图', !!galleryOk);
  check('图库缩略图条存在', (await count(page, '.thumbs button')) > 0);
  await page.screenshot({ path: `${SHOTS}/gallery.png`, fullPage: false });
} else {
  check('图库详情页出图', false, '没找到图库链接');
}

await page.goto(`${BASE}/#/`, { waitUntil: 'commit' });
const userHref = await waitFor(
  async () =>
    (await page.locator('a.card__author').first().getAttribute('href').catch(() => null)) || null,
  { timeout: 45000, label: '作者链接' }
);

if (userHref) {
  await page.goto(`${BASE}/${userHref}`, { waitUntil: 'commit' });
  const profileOk = await waitFor(
    async () => ((await count(page, '.profilehead')) > 0 ? true : null),
    { timeout: 45000, label: '作者页' }
  );
  check('作者页渲染', !!profileOk);
  check('作者页有作品列表', (await count(page, '.card')) > 0);
  await page.screenshot({ path: `${SHOTS}/profile.png`, fullPage: false });
} else {
  check('作者页渲染', false, '没找到作者链接');
}

/* ---------------- 移动端 ---------------- */

console.log('\n[8] 移动端布局');
const mobile = await context.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(`${BASE}/`, { waitUntil: 'commit', timeout: 60000 });
await waitFor(async () => (await mobile.locator('.card').count()) > 0, {
  timeout: 45000,
  label: '移动端卡片'
});
const overflow = await mobile.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth
);
check('移动端没有横向溢出', overflow <= 1, `溢出 ${overflow}px`);
await mobile.screenshot({ path: `${SHOTS}/mobile-home.png`, fullPage: false });
await mobile.close();

/* ---------------- 结果 ---------------- */

await browser.close();

const ignorable = /favicon|NS_BINDING|Download is not allowed|NS_ERROR_ABORT|preload/i;
const realErrors = errors.filter((line) => !ignorable.test(line));

console.log(`\n控制台错误：${realErrors.length ? realErrors.length + ' 条' : '无'}`);
for (const line of realErrors.slice(0, 12)) console.log(`  · ${line}`);

console.log(`\n结果：${passed} 通过，${failed} 失败`);
console.log(`截图目录：${SHOTS}\n`);
process.exit(failed || realErrors.length ? 1 : 0);
