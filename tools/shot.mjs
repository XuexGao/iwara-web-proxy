/**
 * 生成 README 用的展示截图。
 *
 * 前置：node dev-server.mjs   （若开了站点密码，脚本会自动输入）
 * 用法：node tools/shot.mjs
 *
 * 注意：本地传输层是 curl，比线上慢得多，所以每张图都等到内容真的出来了再拍。
 */

import fs from 'node:fs';
import path from 'node:path';
import { firefox } from 'playwright-core';

const EXECUTABLE =
  process.env.SHOT_FIREFOX || '/root/.cache/ms-playwright/firefox-1555/firefox/firefox';
const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:8788';
const PASSWORD = process.env.SITE_PASSWORD || '@Gao123456';
const OUT_DIR = path.resolve('docs/screenshots');

fs.mkdirSync(OUT_DIR, { recursive: true });

async function waitFor(page, fn, timeout = 45000, interval = 700) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

const browser = await firefox.launch({ executablePath: EXECUTABLE, headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  locale: 'zh-CN'
});
const page = await context.newPage();

async function passGate() {
  await page.goto(`${BASE}/`, { waitUntil: 'commit', timeout: 60000 });
  if ((await page.locator('#pw').count()) === 0) return;
  await page.locator('#pw').fill(PASSWORD);
  await page.locator('#go').click();
  await waitFor(page, async () => (await page.locator('.card').count()) > 0, 40000);
}

async function shot(name, { hash = '/', wait = '.card', theme } = {}) {
  await page.goto(`${BASE}${hash}`, { waitUntil: 'commit', timeout: 60000 });
  if (theme) {
    await page.evaluate((value) => {
      localStorage.setItem('iwara.theme.v1', JSON.stringify(value));
      document.documentElement.dataset.theme = value;
    }, theme);
  }
  if (wait) await waitFor(page, async () => (await page.locator(wait).count()) > 0, 50000);
  // 图片是懒加载的，多等一会儿让首屏封面都出来。
  await page.waitForTimeout(7000);
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  → ${path.relative(process.cwd(), file)}`);
}

console.log('生成截图：');

await passGate();

await shot('home-dark', { theme: 'dark', wait: '.card' });
await shot('subscriptions', { hash: '/#/subscriptions', theme: 'dark', wait: '.state__title' });
await shot('settings', { hash: '/#/settings', theme: 'dark', wait: '.switch' });
await shot('gallery', { hash: '/#/images', theme: 'dark', wait: '.card' });
await shot('home-light', { hash: '/', theme: 'light', wait: '.card' });

/* 播放页：等视频真的解码出画面 */
await page.goto(`${BASE}/#/`, { waitUntil: 'commit' });
await waitFor(page, async () => (await page.locator('.card__title').count()) > 0, 40000);
const href = await page.locator('.card__title').first().getAttribute('href');

if (href) {
  for (const [name, theme] of [
    ['watch-dark', 'dark'],
    ['watch-light', 'light']
  ]) {
    await page.goto(`${BASE}/${href}`, { waitUntil: 'commit', timeout: 60000 });
    await page.evaluate((value) => {
      localStorage.setItem('iwara.theme.v1', JSON.stringify(value));
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.reload({ waitUntil: 'commit' });
    await waitFor(
      page,
      async () =>
        page.evaluate(() => {
          const v = document.querySelector('.player__stage video');
          return !!v && v.readyState >= 2 && v.videoWidth > 0;
        }),
      60000
    );
    await page.evaluate(() => {
      const v = document.querySelector('.player__stage video');
      if (v) {
        v.currentTime = Math.min(40, (v.duration || 60) * 0.25);
        v.pause();
      }
    });
    await page.waitForTimeout(4000);
    await page.locator('.player__stage').hover();
    await page.waitForTimeout(900);
    const file = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`  → ${path.relative(process.cwd(), file)}`);
  }
}

/* 图库详情 */
await page.goto(`${BASE}/#/images`, { waitUntil: 'commit' });
await page.evaluate(() => {
  localStorage.setItem('iwara.theme.v1', '"dark"');
});
const imgHref = await waitFor(
  page,
  async () => {
    const h = await page.locator('a.card__title[href^="#/image/"]').first().getAttribute('href').catch(() => null);
    return h || false;
  },
  45000
);
if (imgHref && typeof imgHref === 'string') {
  await shot('image-detail', { hash: imgHref, theme: 'dark', wait: '.gallery img' });
}

/* 作者页 */
await page.goto(`${BASE}/#/`, { waitUntil: 'commit' });
const userHref = await waitFor(
  page,
  async () => {
    const h = await page.locator('a.card__author').first().getAttribute('href').catch(() => null);
    return h || false;
  },
  45000
);
if (userHref && typeof userHref === 'string') {
  await shot('profile', { hash: userHref, theme: 'dark', wait: '.profilehead' });
}

/* 移动端 */
const mobile = await context.newPage();
await mobile.setViewportSize({ width: 400, height: 860 });
await mobile.goto(`${BASE}/`, { waitUntil: 'commit', timeout: 60000 });
if ((await mobile.locator('#pw').count()) > 0) {
  await mobile.locator('#pw').fill(PASSWORD);
  await mobile.locator('#go').click();
}
await waitFor(mobile, async () => (await mobile.locator('.card').count()) > 0, 50000);
await mobile.waitForTimeout(6000);
await mobile.evaluate(() => {
  localStorage.setItem('iwara.theme.v1', '"dark"');
  document.documentElement.dataset.theme = 'dark';
});
const mobileFile = path.join(OUT_DIR, 'mobile.png');
await mobile.screenshot({ path: mobileFile });
console.log(`  → ${path.relative(process.cwd(), mobileFile)}`);
await mobile.close();

await browser.close();
console.log('\n完成。');
