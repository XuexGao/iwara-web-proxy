/**
 * 分页测试：每页 30 个、页码写进地址、翻页回顶部、页码条可用。
 */

import { firefox } from 'playwright-core';

const EXECUTABLE =
  process.env.SHOT_FIREFOX || '/root/.cache/ms-playwright/firefox-1555/firefox/firefox';
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8788';
const PASSWORD = process.env.SITE_PASSWORD || '@Gao123456';
const PAGE_SIZE = 30;

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

async function waitFor(page, fn, timeout = 60000, interval = 700) {
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
  const t = String(e);
  if (!/AbortError|aborted by the user agent/i.test(t)) errors.push(t.slice(0, 160));
});

await page.goto(`${BASE}/`, { waitUntil: 'commit', timeout: 60000 });
if ((await page.locator('#pw').count()) > 0) {
  await page.locator('#pw').fill(PASSWORD);
  await page.locator('#go').click();
}
// 等真实卡片替换掉骨架屏（骨架也是 .card），否则会数到 12 个占位。
await waitFor(page, async () => (await page.locator('.card--skeleton').count()) === 0, 60000);
await waitFor(page, async () => (await page.locator('.card').count()) >= 20, 60000);

console.log('\n[1] 每页数量');
const count1 = await page.locator('.card').count();
check(`首页每页 ${PAGE_SIZE} 个`, count1 === PAGE_SIZE, `实际 ${count1}`);

console.log('\n[2] 页码条');
const pagerExists = (await page.locator('.pager').count()) > 0;
check('出现分页条', pagerExists);
check('当前页高亮', (await page.locator('.pager__num.is-on').count()) === 1);
const nums = await page.locator('.pager__num').allTextContents();
check('页码从 1 开始', nums[0] === '1', nums.join(','));
check('没有"下一页"失效', (await page.locator('.pager__btn[aria-disabled]').count()) === 1);

console.log('\n[3] 翻页');
await page.evaluate(() => window.scrollTo(0, 2500));
await page.waitForTimeout(600);
const beforeScroll = await page.evaluate(() => window.scrollY);
check('翻页前已滚动', beforeScroll > 500, `scrollY=${beforeScroll}`);

const firstTitleP1 = await page.locator('.card__title').first().textContent();
await page.locator('.pager__btn[rel="next"]').click();
await waitFor(page, async () => (await page.evaluate(() => location.hash)).includes('page=2'), 15000);
// 本地接口慢，必须等高亮页码真的变成 2 才算渲染完成
await waitFor(
  page,
  async () => (await page.locator('.pager__num.is-on').textContent().catch(() => '')) === '2',
  60000
);

const hash = await page.evaluate(() => location.hash);
check('地址栏带 page=2', hash.includes('page=2'), hash);

const afterScroll = await page.evaluate(() => window.scrollY);
check('翻页后回到顶部', afterScroll === 0, `scrollY=${afterScroll}`);

const firstTitleP2 = await page.locator('.card__title').first().textContent();
check('内容确实换页了', firstTitleP1 !== firstTitleP2, `${firstTitleP1} vs ${firstTitleP2}`);
check('第 2 页数量正确', (await page.locator('.card').count()) === PAGE_SIZE);
check('第 2 页高亮', (await page.locator('.pager__num.is-on').textContent()) === '2');

console.log('\n[4] 刷新后停在同一页');
await page.reload({ waitUntil: 'commit' });
await waitFor(page, async () => (await page.locator('.card--skeleton').count()) === 0, 60000);
await waitFor(page, async () => (await page.locator('.card').count()) >= 20, 60000);
await page.waitForTimeout(1500);
check(
  '刷新后仍是第 2 页',
  (await page.locator('.pager__num.is-on').textContent()) === '2',
  await page.locator('.pager__num.is-on').textContent()
);
check(
  '刷新后内容一致',
  (await page.locator('.card__title').first().textContent()) === firstTitleP2
);

console.log('\n[5] 上一页');
await page.locator('.pager__btn[rel="prev"]').click();
await waitFor(page, async () => (await page.evaluate(() => location.hash)).includes('page=1'), 15000);
await waitFor(
  page,
  async () => (await page.locator('.pager__num.is-on').textContent().catch(() => '')) === '1',
  60000
);
check('回到第 1 页', (await page.locator('.pager__num.is-on').textContent()) === '1');
check('第 1 页内容恢复', (await page.locator('.card__title').first().textContent()) === firstTitleP1);

console.log('\n[6] 图库也是每页 30');
await page.goto(`${BASE}/#/images`, { waitUntil: 'commit' });
await waitFor(page, async () => (await page.locator('.card--skeleton').count()) === 0, 60000);
await waitFor(page, async () => (await page.locator('.card').count()) >= 20, 60000);
await page.waitForTimeout(1500);
check('图库每页 30 个', (await page.locator('.card').count()) === PAGE_SIZE, `实际 ${await page.locator('.card').count()}`);
check('图库有分页条', (await page.locator('.pager').count()) > 0);

await browser.close();

console.log(`\n控制台错误：${errors.length ? errors.slice(0, 3).join(' | ') : '无'}`);
console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed || errors.length ? 1 : 0);
