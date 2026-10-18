/**
 * linkify / linkifyNode 的测试。
 *
 * 回归点：linkify() 返回 raw 包装（只适合放进 tpl），
 * 直接 append 到 DOM 会渲染成 "[object Object]"。
 * 论坛回复就是这么坏掉的。
 */

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

// 极简 DOM 桩，够 linkifyNode 用
class FakeNode {
  constructor() { this.children = []; }
  append(node) { this.children.push(node); }
  get textContent() {
    return this.children.map((c) => c.textContent ?? String(c)).join('');
  }
}
class FakeText extends FakeNode {
  constructor(text) { super(); this._t = text; }
  get textContent() { return this._t; }
}
class FakeElement extends FakeNode {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.attributes = {}; }
  set href(v) { this.attributes.href = v; }
  get href() { return this.attributes.href; }
  set target(v) { this.attributes.target = v; }
  set rel(v) { this.attributes.rel = v; }
  set textContent(v) { this.children = [new FakeText(v)]; }
  get textContent() {
    return this.children.map((c) => c.textContent ?? String(c)).join('');
  }
}

globalThis.document = {
  createDocumentFragment: () => new FakeNode(),
  createTextNode: (t) => new FakeText(t),
  createElement: (tag) => new FakeElement(tag)
};

const { linkify, linkifyNode } = await import('../public/js/ui.js');

console.log('\n[1] linkify 返回包装对象');
const wrapped = linkify('看 https://example.com 这个');
check('返回对象带 raw 标记', wrapped && typeof wrapped === 'object');
check('不是 DOM 节点', typeof wrapped.nodeType === 'undefined');

console.log('\n[2] linkifyNode 返回可用节点');
const node = linkifyNode('看 https://example.com 这个');
check('有 append 方法（是节点容器）', typeof node.append === 'function');
check('文本完整', node.textContent === '看 https://example.com 这个', node.textContent);
const anchor = node.children.find((c) => c.tagName === 'A');
check('生成了链接', !!anchor);
check('链接地址正确', anchor?.href === 'https://example.com');
check('带 noopener', (anchor?.attributes?.rel || '').includes('noopener'));

console.log('\n[3] 边界');
check('空字符串不报错', linkifyNode('').textContent === '');
check('null 不报错', linkifyNode(null).textContent === '');
const multi = linkifyNode('a https://x.com b https://y.com c');
check('多个链接', multi.children.filter((c) => c.tagName === 'A').length === 2);
check('纯文本无链接', linkifyNode('没有网址').children.every((c) => c.tagName !== 'A'));

console.log('\n[4] 转义（XSS 防护）');
const evil = linkifyNode('<img src=x onerror=alert(1)>');
check('尖括号原样保留为文本', evil.textContent === '<img src=x onerror=alert(1)>', evil.textContent);
check('没有生成 img 元素', evil.children.every((c) => c.tagName !== 'IMG'));

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
