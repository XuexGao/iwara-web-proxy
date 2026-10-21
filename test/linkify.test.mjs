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
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    // 真实元素都有；linkifyNode 给图片挂 error 兜底时会用到
    this.listeners = {};
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  /** 测试里手动触发事件 */
  fire(type) { for (const fn of this.listeners[type] || []) fn(); }
  replaceWith(node) {
    const parent = this.parentNode;
    if (parent) parent.children = parent.children.map((c) => (c === this ? node : c));
  }
  append(node) { node.parentNode = this; this.children.push(node); }
  set href(v) { this.attributes.href = v; }
  get href() { return this.attributes.href; }
  set src(v) { this.attributes.src = v; }
  get src() { return this.attributes.src; }
  set alt(v) { this.attributes.alt = v; }
  set loading(v) { this.attributes.loading = v; }
  get loading() { return this.attributes.loading; }
  set decoding(v) { this.attributes.decoding = v; }
  get decoding() { return this.attributes.decoding; }
  set referrerPolicy(v) { this.attributes.referrerPolicy = v; }
  get referrerPolicy() { return this.attributes.referrerPolicy; }
  set className(v) { this.attributes.class = v; }
  get className() { return this.attributes.class; }
  set alt(v) { this.attributes.alt = v; }
  get alt() { return this.attributes.alt; }
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

console.log('\n[5] Markdown 内联语法');
// 作品说明的真实形态：`4K 60FPS Link: [patreon](https://...) /[爱赞助](https://...)`
const mdLink = linkifyNode('4K 60FPS Link: [patreon](https://www.patreon.com/c/x) /[爱赞助](https://azz.ee/x)');
const anchors = [...mdLink.children].filter((c) => c.tagName === 'A');
check('解析出两个 Markdown 链接', anchors.length === 2, String(anchors.length));
check('链接文字取方括号里的内容', anchors[0]?.textContent === 'patreon', anchors[0]?.textContent);
check('第二个链接中文正常', anchors[1]?.textContent === '爱赞助', anchors[1]?.textContent);
check('链接地址正确', anchors[0]?.href === 'https://www.patreon.com/c/x', anchors[0]?.href);
check('不残留方括号原文', !mdLink.textContent.includes('[patreon]'), mdLink.textContent);

// 评论里的真实形态：emoji + 两张 ![](url)
const mdImg = linkifyNode('❤️👍\n![](https://img3.pixhost.cc/a.jpg)\n![](https://img3.pixhost.cc/b.jpg)');
const imgs = [...mdImg.children].filter((c) => c.tagName === 'A');
check('解析出两个图片链接', imgs.length === 2, String(imgs.length));
const inner = imgs[0]?.children?.find((c) => c.tagName === 'IMG');
check('生成 img 元素', !!inner);
check('img 地址正确', inner?.src === 'https://img3.pixhost.cc/a.jpg', inner?.src);
check('图片懒加载', inner?.loading === 'lazy', inner?.loading);
check('不残留 Markdown 原文', !mdImg.textContent.includes('![]'), mdImg.textContent);

console.log('\n[6] 伪协议不生成链接');
const js1 = linkifyNode('[点我](javascript:alert(1))');
check('javascript: 不变成链接', [...js1.children].every((c) => c.tagName !== 'A'), js1.textContent);
const js2 = linkifyNode('![](javascript:alert(1))');
check('图片伪协议不生成 img', [...js2.children].every((c) => c.tagName !== 'A' && c.tagName !== 'IMG'));

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
