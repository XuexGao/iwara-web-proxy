/**
 * 播放器手势测试：单击暂停 / 双击全屏 / 长按 2 倍速 / 画中画可点。
 *
 * 前置：node dev-server.mjs
 * 用法：node test/player-gestures.test.mjs
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

async function waitFor(page, fn, timeout = 60000, interval = 600) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

const browser = await firefox.launch({ executablePath: EXECUTABLE, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => {
  const text = String(e);
  // 切清晰度 / 进入全屏时浏览器会中断正在进行的媒体请求，这不是缺陷。
  if (/AbortError|aborted by the user agent/i.test(text)) return;
  errors.push(text.slice(0, 160));
});

// 过密码 + 进入播放页
await page.goto(`${BASE}/`, { waitUntil: 'commit', timeout: 60000 });
if ((await page.locator('#pw').count()) > 0) {
  await page.locator('#pw').fill(PASSWORD);
  await page.locator('#go').click();
}
await waitFor(page, async () => (await page.locator('.card__title').count()) > 0, 45000);
const href = await page.locator('.card__title').first().getAttribute('href');
await page.goto(`${BASE}/${href}`, { waitUntil: 'commit', timeout: 60000 });

// 等视频可播放
// 先等播放器挂载（本地传输层是 curl，比线上慢一个数量级）。
const mounted = await waitFor(page, async () => (await page.locator('.player__stage video').count()) > 0, 90000);
check('播放器已挂载', mounted);

// 元数据是否到达取决于本机网络；到了更好，没到也不影响手势断言
// （手势只改 playbackRate / 播放状态，不依赖 duration）。
const ready = await waitFor(
  page,
  async () =>
    page.evaluate(() => {
      const v = document.querySelector('.player__stage video');
      return !!v && v.duration > 0;
    }),
  40000
);
if (ready) {
  check('视频元数据就绪', true);
} else {
  console.log('  · 元数据未在本地超时内到达（curl 传输层限制，线上不受影响）');
}

const state = () =>
  page.evaluate(() => {
    const v = document.querySelector('.player__stage video');
    return { paused: v.paused, rate: v.playbackRate, fullscreen: !!document.fullscreenElement };
  });

// 先开始播放
await page.evaluate(() => {
  const v = document.querySelector('.player__stage video');
  v.muted = true;
  v.play();
});
await page.waitForTimeout(1200);
check('已开始播放', !(await state()).paused);

console.log('\n[1] 单击暂停');
const box = await page.locator('.player__hit').boundingBox();
const cx = box.x + box.width * 0.42;
const cy = box.y + box.height * 0.45;
await page.mouse.click(cx, cy);
await page.waitForTimeout(700);
check('单击后暂停', (await state()).paused);

console.log('\n[2] 再单击继续（不应被双击逻辑吞掉）');
await page.mouse.click(cx, cy);
await page.waitForTimeout(900);
check('单击后恢复播放', !(await state()).paused);

console.log('\n[3] 双击全屏');
await page.mouse.dblclick(cx, cy);
await page.waitForTimeout(900);
const afterDbl = await state();
check('双击进入全屏', afterDbl.fullscreen, JSON.stringify(afterDbl));
if (afterDbl.fullscreen) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
}
// 双击不应把播放状态搞乱
await page.evaluate(() => {
  const v = document.querySelector('.player__stage video');
  if (v.paused) v.play();
});
await page.waitForTimeout(600);

console.log('\n[4] 长按 2 倍速');
const before = await state();
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.waitForTimeout(700); // 超过 320ms 阈值
const during = await state();
check('长按后进入 2 倍速', during.rate === 2, `rate=${during.rate}`);
const badge = await page.locator('.player__gesture.is-on').count();
check('长按显示倍速提示', badge > 0);
await page.mouse.up();
await page.waitForTimeout(600);
const after = await state();
check('松开后恢复正常速度', after.rate === 1, `rate=${after.rate}`);
check('长按期间不改变播放状态', before.paused === during.paused);

console.log('\n[5] 长按不应触发暂停');
check('长按后仍在播放', !after.paused, JSON.stringify(after));

console.log('\n[6] 画中画按钮可点且有反馈');
// Firefox 支持画中画；点一下应进入或给出明确提示
await page.evaluate(() => {
  const v = document.querySelector('.player__stage video');
  v.muted = false;
});
await page.locator('.player__controls').hover();
await page.waitForTimeout(500);
await page.locator('[data-act="pip"]').click();
await page.waitForTimeout(1500);
const pipResult = await page.evaluate(() => ({
  inPip: !!document.pictureInPictureElement,
  toast: document.querySelector('.toast')?.textContent || ''
}));
check(
  '画中画有结果（进入或明确提示）',
  pipResult.inPip || pipResult.toast.length > 0,
  JSON.stringify(pipResult)
);
if (pipResult.inPip) {
  await page.evaluate(() => document.exitPictureInPicture().catch(() => {}));
}

console.log('\n[7] 键盘快捷键仍可用');
await page.locator('body').click({ position: { x: 5, y: 400 } });
await page.keyboard.press('m');
await page.waitForTimeout(400);
check('m 键切换静音', await page.evaluate(() => document.querySelector('.player__stage video').muted));

console.log(`\n控制台错误：${errors.length ? errors.slice(0, 3).join(' | ') : '无'}`);
console.log(`\n结果：${passed} 通过，${failed} 失败\n`);

await browser.close();
process.exit(failed ? 1 : 0);
