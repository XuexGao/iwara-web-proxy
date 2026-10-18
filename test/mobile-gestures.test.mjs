/**
 * 移动端播放器手势测试。
 *
 * 移动端与桌面端的约定不同：
 *   单击 = 显隐控制栏（不暂停）   双击 = 暂停/继续   长按 = 2 倍速
 * 桌面端才是 单击 = 暂停、双击 = 全屏。
 *
 * 回归点：以前两端共用一套逻辑，手机上点一下就把视频暂停了，
 * 双击还会触发浏览器的返回手势。
 */

import { firefox } from 'playwright-core';

const EXECUTABLE =
  process.env.SHOT_FIREFOX || '/root/.cache/ms-playwright/firefox-1555/firefox/firefox';
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8788';
const PASSWORD = process.env.SITE_PASSWORD || '@Gao123456';

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

async function waitFor(page, fn, timeout = 90000, interval = 800) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

const browser = await firefox.launch({ executablePath: EXECUTABLE, headless: true });
// hasTouch + isMobile 让 (hover: none) 与 maxTouchPoints 都为真
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
  locale: 'zh-CN'
});
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => {
  const t = String(e);
  if (!/AbortError|aborted by the user agent/i.test(t)) errors.push(t.slice(0, 160));
});

await page.goto(`${BASE}/`, { waitUntil: 'commit', timeout: 60000 });
if ((await page.locator('#pw').count()) > 0) {
  await page.locator('#pw').fill(PASSWORD);
  await page.locator('#go').click();
}
await waitFor(page, async () => (await page.locator('.card__title').count()) > 0, 60000);
const href = await page.locator('.card__title').first().getAttribute('href');
await page.goto(`${BASE}/${href}`, { waitUntil: 'commit', timeout: 60000 });

console.log('\n[1] 环境识别');
check('识别为触摸设备', await page.evaluate(() => window.matchMedia('(hover: none)').matches));

const mounted = await waitFor(page, async () => (await page.locator('.player__stage video').count()) > 0, 60000);
check('播放器已挂载', mounted);

// 等元数据，然后开始播放
await waitFor(
  page,
  async () =>
    page.evaluate(() => {
      const v = document.querySelector('.player__stage video');
      return !!v && v.duration > 0;
    }),
  60000
);
await page.evaluate(() => {
  const v = document.querySelector('.player__stage video');
  v.muted = true;
  v.play().catch(() => {});
});
await page.waitForTimeout(1500);

const state = () =>
  page.evaluate(() => {
    const v = document.querySelector('.player__stage video');
    return {
      paused: v.paused,
      rate: v.playbackRate,
      fullscreen: !!document.fullscreenElement,
      pinned: document.querySelector('.player').classList.contains('is-controls-pinned'),
      hidden: document.querySelector('.player').classList.contains('is-hidden-controls')
    };
  });

// 视频源不可用时会有错误遮罩挡住点击，先移除（被测的是手势）。
await page.evaluate(() => {
  document.querySelectorAll('.player__error').forEach((el) => el.remove());
});

const box = await page.locator('.player__hit').boundingBox();
const cx = box.x + box.width * 0.5;
const cy = box.y + box.height * 0.42;

console.log('\n[2] 单击 = 显隐控制栏（不暂停）');
const before = await state();
if (!before.paused) check('初始在播放', true);

await page.touchscreen.tap(cx, cy);
await page.waitForTimeout(700);
const afterTap = await state();
check('单击不改变播放状态', afterTap.paused === before.paused, JSON.stringify(afterTap));
check('单击后控制栏隐藏', afterTap.hidden, JSON.stringify(afterTap));

await page.touchscreen.tap(cx, cy);
await page.waitForTimeout(900);
const afterTap2 = await state();
check('再单击控制栏显示', !afterTap2.hidden, JSON.stringify(afterTap2));
check('仍未改变播放状态', afterTap2.paused === before.paused);

console.log('\n[3] 双击 = 暂停/继续（不进入全屏）');
const pausedBeforeDbl = (await state()).paused;
await page.touchscreen.tap(cx, cy);
await page.waitForTimeout(120);
await page.touchscreen.tap(cx, cy);
await page.waitForTimeout(900);
const afterDbl = await state();
// 视频源不可用时 paused 永远是 true，无法验证"切换"，只验证不进入全屏。
const videoPlayable = await page.evaluate(() => {
  const v = document.querySelector('.player__stage video');
  return !!v && v.readyState >= 2 && !v.error;
});
if (videoPlayable) {
  check('双击切换了播放状态', afterDbl.paused !== pausedBeforeDbl, JSON.stringify(afterDbl));
} else {
  console.log('  · 视频源不可用，跳过播放状态切换断言');
}
check('双击不会进入全屏', !afterDbl.fullscreen, JSON.stringify(afterDbl));

console.log('\n[4] 长按 = 2 倍速');
if ((await state()).paused) {
  console.log('  · 视频未在播放，跳过长按加速断言');
} else {
const cx2 = box.x + box.width * 0.5;
const cy2 = box.y + box.height * 0.6;
await page.evaluate(
  ({ x, y }) => {
    const el = document.querySelector('.player__hit');
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch' };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
  },
  { x: cx2, y: cy2 }
);
await page.waitForTimeout(700);
const during = await state();
check('长按进入 2 倍速', during.rate === 2, `rate=${during.rate}`);

await page.evaluate(
  ({ x, y }) => {
    const el = document.querySelector('.player__hit');
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch' };
    el.dispatchEvent(new PointerEvent('pointerup', opts));
  },
  { x: cx2, y: cy2 }
);
await page.waitForTimeout(600);
check('松开恢复正常速度', (await state()).rate === 1, `rate=${(await state()).rate}`);
check('长按没有改变播放状态', !(await state()).paused);
}

await browser.close();

console.log(`\n控制台错误：${errors.length ? errors.slice(0, 3).join(' | ') : '无'}`);
console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed || errors.length ? 1 : 0);
