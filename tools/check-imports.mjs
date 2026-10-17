/**
 * 静态检查：所有 import 的具名导出是否真的存在。
 *
 * 用法：node tools/check-imports.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.m?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'public', 'js'))];

/** 收集一个模块导出的名字。 */
function exportsOf(source) {
  const names = new Set();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    /export\s+class\s+([A-Za-z0-9_$]+)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) names.add(match[1]);
  }
  const brace = /export\s*\{([^}]*)\}/g;
  let match;
  while ((match = brace.exec(source))) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(source)) names.add('default');
  return names;
}

const exportCache = new Map();
function exportsFor(file) {
  if (!exportCache.has(file)) {
    exportCache.set(file, exportsOf(fs.readFileSync(file, 'utf8')));
  }
  return exportCache.get(file);
}

let problems = 0;
let checked = 0;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const importPattern = /import\s+(?:([A-Za-z0-9_$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = importPattern.exec(source))) {
    const [, defaultName, named, specifier] = match;
    if (!specifier.startsWith('.')) continue;
    const target = path.resolve(path.dirname(file), specifier);
    if (!fs.existsSync(target)) {
      console.log(`✗ ${path.relative(ROOT, file)} 找不到模块 ${specifier}`);
      problems += 1;
      continue;
    }
    const available = exportsFor(target);
    checked += 1;
    if (defaultName && !available.has('default')) {
      console.log(`✗ ${path.relative(ROOT, file)} 默认导出不存在于 ${specifier}`);
      problems += 1;
    }
    if (named) {
      for (const part of named.split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (!name) continue;
        if (!available.has(name)) {
          console.log(`✗ ${path.relative(ROOT, file)} 导入了不存在的 ${name}（来自 ${specifier}）`);
          problems += 1;
        }
      }
    }
  }
}

console.log(
  problems
    ? `\n${problems} 个问题（检查了 ${checked} 条 import）`
    : `\n全部通过：${files.length} 个文件，${checked} 条 import。`
);
process.exit(problems ? 1 : 0);
