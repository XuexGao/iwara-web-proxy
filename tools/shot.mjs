/**
 * 本地视觉检查：用 playwright 的 firefox 打开本地开发服务器并截图。
 *
 * 用法：node tools/shot.mjs [路径...] 
 * 例如：node tools/shot.mjs "/" "/#/tags" "/#/video/xxxx"
 */

import fs from 'node:fs';
import path from 'node:path';
import { firefox } from 'playwright-core';

const EXECUTABLE = process.env.SHOT_FIREFOX || '/root/.cache/ms-playwright/firefox-1555/firefox/firefox';
const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:8788';
const OUT_DIR = process.env.SHOT_OUT || '/tmp/shots';
const WIDTH = Number(process.env.SHOT_W || 1440);
const HEIGHT = Number(process.env.SHOT_H || 940);

const targets = process.argv.slice(2);
if (!targets.length) targets.push('/');

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await firefox.launch({ executablePath: EXECUTABLE, headless: true });
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
  locale: 'zh-CN'
});

const errors = [];
for (const [index, target] of targets.entries()) {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`));

  const url = target.startsWith('http') ? target : `${BASE}${target}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(Number(process.env.SHOT_WAIT || 3200));
  } catch (error) {
    console.log(`! ${target} 导航失败: ${error.message}`);
  }

  const name = (target.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'root').slice(0, 60);
  const file = path.join(OUT_DIR, `${String(index).padStart(2, '0')}-${name || 'root'}.png`);
  await page.screenshot({ path: file, fullPage: process.env.SHOT_FULL !== '0' });
  console.log(`${file}  ${url}`);
  if (consoleErrors.length) {
    errors.push({ target, list: consoleErrors.slice(0, 6) });
  }
  await page.close();
}

await browser.close();

if (errors.length) {
  console.log('\n--- 控制台错误 ---');
  for (const entry of errors) {
    console.log(`\n${entry.target}`);
    for (const line of entry.list) console.log(`  ${line}`);
  }
  process.exitCode = 2;
} else {
  console.log('\n没有控制台错误。');
}
