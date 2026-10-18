/**
 * 生成 README 用的展示截图。
 *
 * 前置：SITE_PASSWORD=... node dev-server.mjs
 * 用法：node tools/shot.mjs
 *
 * 本地传输层是 curl，比线上慢一个数量级，所以这里的原则是：
 * 「等到画面真的完整了再拍」——骨架屏消失、首屏图片全部解码成功、
 * 滚动位置归零。之前出现过截图里图片只加载了一半的情况。
 */

import fs from 'node:fs';
import path from 'node:path';
import { firefox } from 'playwright-core';

const EXECUTABLE =
  process.env.SHOT_FIREFOX || '/root/.cache/ms-playwright/firefox-1555/firefox/firefox';
const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:8788';
const PASSWORD = process.env.SITE_PASSWORD || '@Gao123456';
const OUT_DIR = path.resolve('docs/screenshots');
const WATCH_VIDEO = process.env.SHOT_VIDEO || '8h9advbso9KH3A';

fs.mkdirSync(OUT_DIR, { recursive: true });

async function waitFor(fn, { timeout = 60000, interval = 500, label = '' } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await fn().catch(() => null);
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  if (label) console.log(`    （等待超时：${label}）`);
  return last;
}

const browser = await firefox.launch({ executablePath: EXECUTABLE, headless: true });

async function makePage(vp, mobile = false) {
  const ctx = await browser.newContext({
    viewport: vp,
    deviceScaleFactor: 2,
    hasTouch: mobile,
    isMobile: mobile,
    locale: 'zh-CN'
  });
  return { ctx, page: await ctx.newPage() };
}

async function passGate(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  if ((await page.locator('#pw').count()) > 0) {
    await page.locator('#pw').fill(PASSWORD);
    await page.locator('#go').click();
  }

  // 必须等页面真正稳定再返回：否则后面的 evaluate 会撞上仍在进行的导航，
  // 报 "Execution context was destroyed"。
  await waitFor(async () => (await page.locator('.lede__title').count()) > 0, {
    timeout: 60000,
    label: '首页就绪'
  });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

/**
 * 等到页面真的画完：
 * 1. 骨架屏全部消失
 * 2. 视口内（含首屏下方一点）的封面图 naturalWidth > 0
 * 3. 滚动回顶部
 */
async function settleImages(page, { timeout = 90000 } = {}) {
  await waitFor(async () => (await page.locator('.card--skeleton').count()) === 0, {
    timeout,
    label: '骨架屏消失'
  });

  // 不断言「全部都加载成功」：上游有少量封面本来就取不到，
  // 死等只会超时。改为等待「已加载比例够高且连续两次不再变化」。
  let previousLoaded = -1;
  let stableRounds = 0;
  await waitFor(
    async () => {
      const stat = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('img')].filter((img) => {
          const r = img.getBoundingClientRect();
          return r.width > 8 && r.height > 8 && r.top < window.innerHeight * 2;
        });
        const loaded = imgs.filter((img) => img.complete && img.naturalWidth > 0).length;
        return { total: imgs.length, loaded };
      });
      // 页面上没有图片（订阅页、设置页）时直接算就绪，
      // 否则会白等到超时。
      if (!stat.total) return { total: 0, loaded: 0 };
      const ratio = stat.loaded / stat.total;
      if (stat.loaded === previousLoaded) stableRounds += 1;
      else stableRounds = 0;
      previousLoaded = stat.loaded;
      return ratio >= 0.75 && stableRounds >= 2 ? stat : null;
    },
    { timeout, interval: 800, label: '首屏图片解码' }
  );

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
}

/**
 * 导航到某个 hash 路由。
 *
 * 注意：只改 hash 的话浏览器认为是同文档跳转，页面不会重新加载，
 * 之前的截图脚本因此拍到了上一页。加一个 query 参数强制真实导航。
 */
async function gotoRoute(page, hash) {
  const url = hash.startsWith('#') ? `${BASE}/?nav=${Date.now()}${hash}` : `${BASE}${hash}`;
  await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
}

async function setTheme(page, theme) {
  await page.evaluate((value) => {
    localStorage.setItem('iwara.theme.v1', value);
    document.documentElement.dataset.theme = value;
  }, theme);
}

async function shot(name, hash, { theme = 'dark', vp = { width: 1440, height: 900 }, mobile = false } = {}) {
  const { ctx, page } = await makePage(vp, mobile);
  await passGate(page);

  // 主题先写好再导航：theme-init.js 会在首帧读取它，避免拍到中途切换的样式。
  await setTheme(page, theme);
  await gotoRoute(page, hash);
  await waitFor(async () => (await page.locator('#view').count()) > 0, { timeout: 30000 });

  await settleImages(page);

  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  → ${name}.png`);
  await ctx.close();
}

/**
 * 挑一个当前真的能播的作品。
 *
 * 上游的清晰度清单有时是空的（还在转码），固定用某个 ID 会拍到
 * 「暂时无法播放」的空状态，截图就废了。
 */
async function pickPlayableVideo(page) {
  const candidates = [];
  try {
    const list = await page.evaluate(async () => {
      const res = await fetch('/api/iwara/videos?page=0&sort=popularity&rating=all&limit=10');
      const data = await res.json();
      return (data?.results || []).map((v) => v.id);
    });
    candidates.push(...list);
  } catch {
    /* 用默认的 */
  }
  candidates.push(WATCH_VIDEO);

  for (const id of candidates) {
    try {
      const ok = await page.evaluate(async (videoId) => {
        const res = await fetch(`/api/sources/${videoId}`, { cache: 'no-store' });
        const data = await res.json();
        return Array.isArray(data?.sources) && data.sources.length > 0;
      }, id);
      if (ok) return id;
    } catch {
      /* 试下一个 */
    }
  }
  return WATCH_VIDEO;
}

console.log('生成截图：');

/* 首页：深色 / 浅色 */
await shot('home-dark', '/#/', { theme: 'dark' });
await shot('home-light', '/#/', { theme: 'light' });

/* 图库 */
await shot('gallery', '/#/images', { theme: 'dark' });

/* 订阅 */
await shot('subscriptions', '/#/subscriptions', { theme: 'dark' });

/* 设置 */
await shot('settings', '/#/settings', { theme: 'dark' });

/* 播放页：桌面深色 / 浅色
   上游的清晰度清单会偶发为空（转码中），所以逐个候选试到真的解码出画面为止。 */
async function shootWatch(theme, candidates) {
  for (const id of candidates) {
    const { ctx, page } = await makePage({ width: 1440, height: 900 });
    await passGate(page);
    await setTheme(page, theme);
    await gotoRoute(page, `#/video/${id}`);

    const hasStructure = await waitFor(
      async () => (await page.locator('.watch__head-block').count()) > 0,
      { timeout: 60000 }
    );
    if (!hasStructure) {
      await ctx.close();
      continue;
    }

    // 关键：等播放器真的解码出画面；等不到就换下一个作品
    const hasFrame = await waitFor(
      async () =>
        page.evaluate(() => {
          const v = document.querySelector('.player__stage video');
          return !!v && v.readyState >= 2 && v.videoWidth > 0 && !document.querySelector('.player__error');
        }),
      { timeout: 45000 }
    );

    if (!hasFrame) {
      console.log(`    · 作品 ${id} 取不到画面，换一个`);
      await ctx.close();
      continue;
    }

    await waitFor(async () => (await page.locator('.rail__item').count()) > 0, { timeout: 45000 });
    await settleImages(page);

    // 跳到中段并暂停：
    // - 避免拍到纯黑首帧
    // - 暂停时控制栏常驻，不必悬停（悬停会带出 Firefox 自带的画中画浮层，
    //   那个按钮出现在截图里很干扰）
    await page.evaluate(() => {
      const v = document.querySelector('.player__stage video');
      if (!v) return;
      if (Number.isFinite(v.duration) && v.duration > 0) {
        v.currentTime = Math.min(40, v.duration * 0.25);
      }
      v.pause();
    });
    await page.waitForTimeout(2500);
    // 鼠标挪到角落，确保没有任何浏览器浮层
    await page.mouse.move(4, 4);
    await page.waitForTimeout(600);

    await page.screenshot({ path: path.join(OUT_DIR, `watch-${theme}.png`) });
    console.log(`  → watch-${theme}.png（作品 ${id}）`);
    await ctx.close();
    return id;
  }

  console.log(`    ✗ watch-${theme} 没有可播的作品，跳过`);
  return null;
}

const VIDEO_ID = await (async () => {
  const { ctx, page } = await makePage({ width: 1440, height: 900 });
  await passGate(page);
  const id = await pickPlayableVideo(page);
  await ctx.close();
  console.log(`  首选作品 ${id}`);
  return id;
})();

// 候选：首选 + 再挑几个热门，提高一次成功的概率
const watchCandidates = [VIDEO_ID];
{
  const { ctx, page } = await makePage({ width: 1440, height: 900 });
  await passGate(page);
  try {
    const more = await page.evaluate(async () => {
      const res = await fetch('/api/iwara/videos?page=0&sort=trending&rating=all&limit=10');
      const data = await res.json();
      return (data?.results || []).map((v) => v.id);
    });
    watchCandidates.push(...more);
  } catch {
    /* 忽略 */
  }
  await ctx.close();
}

const usedId = await shootWatch('dark', watchCandidates.slice(0, 3));
await shootWatch('light', [usedId, ...watchCandidates].filter(Boolean));

/* 手机首页 + 手机播放页（新版式：视频→标题→作者→详情→评论→相关） */
{
  const { ctx, page } = await makePage({ width: 390, height: 844 }, true);
  await passGate(page);
  await setTheme(page, 'dark');
  await gotoRoute(page, '#/');
  await settleImages(page);
  await page.screenshot({ path: path.join(OUT_DIR, 'mobile.png') });
  console.log('  → mobile.png');
  await ctx.close();
}

{
  const { ctx, page } = await makePage({ width: 390, height: 844 }, true);
  await passGate(page);
  await setTheme(page, 'dark');
  await gotoRoute(page, `#/video/${VIDEO_ID}`);
  await waitFor(async () => (await page.locator('.watch__head-block').count()) > 0, {
    timeout: 60000,
    label: '播放页结构'
  });
  await settleImages(page);
  await page.waitForTimeout(2000);
  // 从头开始截，展示「视频 → 标题 → 作者 → 详情」这段
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, 'mobile-watch.png') });
  console.log('  → mobile-watch.png');
  await ctx.close();
}

await browser.close();
console.log('\n完成。接着用 magick 转 webp：见 package.json 的 shots 脚本。');
