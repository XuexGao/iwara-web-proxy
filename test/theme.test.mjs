/**
 * 主题持久化测试。
 *
 * 覆盖一个真实踩过的 bug：主题存的是裸字符串 'dark'，
 * 而读取用的是只接受对象的 readJson，导致保存过的主题在
 * 下次启动时被忽略、默默退回跟随系统。
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

const browser = await firefox.launch({ executablePath: EXECUTABLE, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
const page = await context.newPage();

async function passGate() {
  await page.goto(`${BASE}/`, { waitUntil: 'commit', timeout: 60000 });
  if ((await page.locator('#pw').count()) === 0) return;
  await page.locator('#pw').fill(PASSWORD);
  await page.locator('#go').click();
  await new Promise((r) => setTimeout(r, 5000));
}

await passGate();

console.log('\n[1] 切换并持久化');
await page.evaluate(() => localStorage.removeItem('iwara.theme.v1'));
await page.reload({ waitUntil: 'commit' });
await new Promise((r) => setTimeout(r, 3000));

// 先确定当前值，再切到相反的那个
const before = await page.evaluate(() => document.documentElement.dataset.theme);
await page.locator('#theme-button').click();
await new Promise((r) => setTimeout(r, 1200));
const after = await page.evaluate(() => document.documentElement.dataset.theme);
check('点击切换生效', before !== after, `${before} -> ${after}`);

const stored = await page.evaluate(() => localStorage.getItem('iwara.theme.v1'));
check('已写入存储', stored === after, `stored=${stored} expected=${after}`);
check('存的是裸字符串', stored && !stored.startsWith('"'), `stored=${stored}`);

console.log('\n[2] 刷新后保持（回归点）');
await page.reload({ waitUntil: 'commit' });
await new Promise((r) => setTimeout(r, 3500));
const afterReload = await page.evaluate(() => document.documentElement.dataset.theme);
check('刷新后仍是切换后的主题', afterReload === after, `afterReload=${afterReload} expected=${after}`);

console.log('\n[3] 首帧前就已应用（无闪烁）');
// commit 阶段脚本还没跑，所以这里紧跟着高频轮询，
// 记录 dataset 第一次出现值是什么——它应该直接就是保存的主题，
// 中间不能先出现另一个值（那才是闪屏）。
const fresh = await context.newPage();
await fresh.goto(`${BASE}/`, { waitUntil: 'commit', timeout: 60000 });
const seen = [];
for (let i = 0; i < 60; i += 1) {
  const value = await fresh.evaluate(() => document.documentElement.dataset.theme).catch(() => null);
  if (value && !seen.includes(value)) seen.push(value);
  if (seen.length && value) break;
  await new Promise((r) => setTimeout(r, 15));
}
check(
  '首帧即为保存的主题（没有先闪别的）',
  seen[0] === after,
  `第一次出现=${seen[0]} expected=${after}`
);
await fresh.close();

console.log('\n[4] 兼容历史写法（带引号）');
await page.evaluate((value) => localStorage.setItem('iwara.theme.v1', JSON.stringify(value)), after === 'light' ? 'dark' : 'light');
await page.reload({ waitUntil: 'commit' });
await new Promise((r) => setTimeout(r, 3000));
const compat = await page.evaluate(() => document.documentElement.dataset.theme);
check('带引号的历史值仍被识别', compat !== after, `compat=${compat}（应已切到另一个）`);

console.log('\n[5] 跟随系统');
await page.evaluate(() => localStorage.setItem('iwara.theme.v1', 'system'));
await page.reload({ waitUntil: 'commit' });
await new Promise((r) => setTimeout(r, 3000));
const system = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  prefersLight: window.matchMedia('(prefers-color-scheme: light)').matches
}));
check(
  'system 时按系统偏好解析',
  system.theme === (system.prefersLight ? 'light' : 'dark'),
  JSON.stringify(system)
);

await browser.close();
console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
