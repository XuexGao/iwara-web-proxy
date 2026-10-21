/**
 * DOM 小工具：安全模板、吐司、弹窗、骨架屏、无限滚动。
 *
 * 模板用标签函数 + 自动转义：`tpl` 里的插值默认按文本转义，
 * 只有显式 `raw()` 的内容才当 HTML。这样用户昵称、作品标题这些
 * 不可信字符串永远不会被当成标记解析。
 */

/* ------------------------------------------------------------------ *
 * 模板
 * ------------------------------------------------------------------ */

const RAW = Symbol('raw');

export function raw(value) {
  return { [RAW]: String(value ?? '') };
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collect(value, htmlParts, nodes) {
  if (value === null || value === undefined || value === false || value === true) return;
  if (value && typeof value === 'object' && RAW in value) {
    htmlParts.push(value[RAW]);
    return;
  }
  if (value instanceof Node) {
    htmlParts.push(`<!--slot:${nodes.length}-->`);
    nodes.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, htmlParts, nodes);
    return;
  }
  htmlParts.push(esc(value));
}

export function tpl(strings, ...values) {
  const parts = [];
  const nodes = [];
  strings.forEach((literal, index) => {
    parts.push(literal);
    if (index < values.length) collect(values[index], parts, nodes);
  });

  const template = document.createElement('template');
  template.innerHTML = parts.join('');

  if (nodes.length) {
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_COMMENT);
    const found = [];
    while (walker.nextNode()) found.push(walker.currentNode);
    for (const comment of found) {
      const match = /^slot:(\d+)$/.exec(comment.data || '');
      if (!match) continue;
      const node = nodes[Number(match[1])];
      if (node) comment.parentNode.replaceChild(node, comment);
      else comment.remove();
    }
  }

  const fragment = template.content;
  // 模板字面量里的换行缩进会产生纯空白文本节点。若只剩一个元素节点，
  // 直接返回它，否则调用方拿到的是 DocumentFragment，无法用 .classList 等
  // 元素属性——这正是「单个元素模板」最常见的写法，必须支持。
  const meaningful = [...fragment.childNodes].filter(
    (node) => node.nodeType !== Node.TEXT_NODE || node.textContent.trim() !== ''
  );
  if (meaningful.length === 1 && meaningful[0].nodeType === Node.ELEMENT_NODE) {
    const only = meaningful[0];
    fragment.replaceChildren(only);
    return only;
  }
  return fragment;
}

export function frag(...children) {
  const fragment = document.createDocumentFragment();
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    fragment.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return fragment;
}

/** 模板插值用的图标：返回 raw 包装，只能放进 tpl 里。 */
export function icon(name, className = 'icon') {
  return raw(`<svg class="${className}"><use href="#i-${name}"/></svg>`);
}

/**
 * 真实 DOM 节点版图标。
 * 凡是把结果交给 replaceChildren / append / insertBefore 的地方都必须用这个，
 * icon() 返回的是 raw 包装对象，直接塞进去会渲染成 "[object Object]"。
 */
export function iconNode(name, className = 'icon') {
  const template = document.createElement('template');
  template.innerHTML = `<svg class="${className}"><use href="#i-${name}"/></svg>`;
  return template.content.firstElementChild;
}

export function mount(parent, node) {
  parent.replaceChildren(node instanceof Node ? node : document.createTextNode(String(node)));
  return parent;
}

/* ------------------------------------------------------------------ *
 * DOM 便捷方法
 * ------------------------------------------------------------------ */

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/** 事件委托：在 container 上监听，命中 selector 时调用 handler。 */
export function on(container, type, selector, handler, options) {
  container.addEventListener(
    type,
    (event) => {
      const match = event.target instanceof Element ? event.target.closest(selector) : null;
      if (!match || !container.contains(match)) return;
      handler(event, match);
    },
    options
  );
}

export function debounce(fn, wait = 220) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 120) {
  let last = 0;
  let pending = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(pending);
      pending = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, wait - (now - last));
    }
  };
}

/* ------------------------------------------------------------------ *
 * 吐司
 * ------------------------------------------------------------------ */

export function toast(message, kind = 'info', timeout = 3200) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = tpl`<div class="toast ${kind === 'error' ? 'toast--err' : ''}">${message}</div>`;
  host.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .2s ease, transform .2s ease';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

export const toastError = (error, fallback = '操作失败') =>
  toast(error?.message || fallback, 'error', 4200);

/* ------------------------------------------------------------------ *
 * 弹窗
 * ------------------------------------------------------------------ */

let escHandler = null;

export function closeModal() {
  const host = document.getElementById('modal');
  if (!host) return;
  host.hidden = true;
  host.replaceChildren();
  if (escHandler) document.removeEventListener('keydown', escHandler);
  escHandler = null;
}

/**
 * 打开弹窗。
 * @param {{title?: string, hint?: string, body?: Node|string, actions?: Array}} options
 */
export function openModal({ title, hint, body, actions = [] }) {
  const host = document.getElementById('modal');
  if (!host) return;

  const foot = tpl`<div class="modal__foot"></div>`;
  for (const action of actions) {
    const button = tpl`<button class="btn ${action.variant === 'primary' ? 'btn--primary' : ''}" type="button">${action.label}</button>`;
    button.addEventListener('click', () => action.onClick?.({ close: closeModal }));
    foot.append(button);
  }

  const box = tpl`
    <div class="modal__box" role="dialog" aria-modal="true">
      ${title ? tpl`<h2 class="modal__title">${title}</h2>` : null}
      ${hint ? tpl`<p class="modal__hint">${hint}</p>` : null}
      ${body || null}
      ${actions.length ? foot : null}
    </div>`;

  host.replaceChildren(box);
  host.hidden = false;

  escHandler = (event) => {
    if (event.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', escHandler);
  host.onclick = (event) => {
    if (event.target === host) closeModal();
  };
  const focusable = box.querySelector('input, select, textarea, button');
  focusable?.focus();
}

export function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    openModal({
      title,
      body: tpl`<p class="modal__hint" style="margin:0">${message}</p>`,
      actions: [
        { label: '取消', onClick: () => finish(false) },
        {
          label: confirmText,
          variant: danger ? 'primary' : 'primary',
          onClick: () => finish(true)
        }
      ]
    });
    const host = document.getElementById('modal');
    const observer = new MutationObserver(() => {
      if (host.hidden) {
        observer.disconnect();
        finish(false);
      }
    });
    observer.observe(host, { attributes: true, attributeFilter: ['hidden'] });
  });
}

/* ------------------------------------------------------------------ *
 * 状态块
 * ------------------------------------------------------------------ */

export function skeletonGrid(count = 12) {
  const grid = tpl`<div class="grid"></div>`;
  for (let i = 0; i < count; i += 1) {
    grid.append(tpl`<div class="card"><div class="skeleton"></div><div class="skeleton" style="aspect-ratio:auto;height:14px;width:82%"></div></div>`);
  }
  return grid;
}

export function stateBlock({ title, message, action, error = false }) {
  const node = tpl`
    <div class="state">
      <div class="state__title">${title}</div>
      ${message ? tpl`<p>${message}</p>` : null}
    </div>`;
  if (action) {
    const button = tpl`<button class="btn btn--sm" type="button">${action.label}</button>`;
    button.addEventListener('click', action.onClick);
    node.append(button);
  }
  if (error) node.dataset.error = '1';
  return node;
}

/* ------------------------------------------------------------------ *
 * 无限滚动
 * ------------------------------------------------------------------ */

/**
 * 在容器末尾挂一个哨兵，滚到底部时回调。
 * @returns {() => void} 停止观察
 */
export function observeBottom(sentinel, callback, rootMargin = '700px') {
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) callback();
    },
    { rootMargin }
  );
  observer.observe(sentinel);
  return () => observer.disconnect();
}

/* ------------------------------------------------------------------ *
 * 共享展示常量
 * ------------------------------------------------------------------ */

export const SORT_OPTIONS = [
  { id: 'trending', label: '本周热门' },
  { id: 'date', label: '最新发布' },
  { id: 'popularity', label: '最受喜爱' },
  { id: 'likes', label: '点赞最多' },
  { id: 'views', label: '播放最多' }
];

export const SORT_LABELS = Object.fromEntries(SORT_OPTIONS.map((item) => [item.id, item.label]));

export const RATING_LABELS = {
  general: '一般',
  ecchi: 'R18'
};

/**
 * 把一段纯文本里的 URL 变成可点链接，返回 HTML 字符串包装（给 tpl 用）。
 * ⚠️ 不能直接 append 到 DOM：raw() 是包装对象，append 会渲染成 "[object Object]"。
 *   需要节点请用 linkifyNode()。
 */
/**
 * Iwara 的正文与评论用的是 Markdown 内联语法：
 *
 *   ![alt](https://...jpg)      图片
 *   [文字](https://...)          链接
 *   裸的 https://...             也当链接
 *
 * 真实例子（作品说明）：
 *   `4K 60FPS Link: [patreon](https://www.patreon.com/c/xxx) /[爱赞助](https://azz.ee/xxx)`
 *
 * 只认这三种，其余语法（标题、列表、代码块）按普通文本输出——
 * 这类内容里几乎不会出现，解析多了反而容易把正常文字吃掉。
 */
const INLINE_PATTERN =
  /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"')]+)/g;

/** 只允许 http(s) 链接，挡掉 javascript: / data: 之类的伪协议。 */
function safeHref(url) {
  const value = String(url || '').trim();
  return /^https?:\/\//i.test(value) ? value : '';
}

/** 把一段文本切成 text / link / image 三种 token。 */
function tokenizeInline(text) {
  const value = String(text || '');
  const tokens = [];
  let last = 0;
  let match;
  INLINE_PATTERN.lastIndex = 0;

  while ((match = INLINE_PATTERN.exec(value))) {
    if (match.index > last) {
      tokens.push({ type: 'text', value: value.slice(last, match.index) });
    }

    if (match[2] !== undefined) {
      const href = safeHref(match[2]);
      tokens.push(
        href
          ? { type: 'image', alt: match[1] || '', href }
          : { type: 'text', value: match[0] }
      );
    } else if (match[4] !== undefined) {
      const href = safeHref(match[4]);
      tokens.push(
        href ? { type: 'link', label: match[3], href } : { type: 'text', value: match[0] }
      );
    } else {
      tokens.push({ type: 'link', label: match[5], href: match[5] });
    }

    last = match.index + match[0].length;
  }

  if (last < value.length) tokens.push({ type: 'text', value: value.slice(last) });
  return tokens;
}

export function linkify(text) {
  const out = [];
  for (const token of tokenizeInline(text)) {
    if (token.type === 'text') {
      out.push(esc(token.value));
    } else if (token.type === 'link') {
      out.push(
        `<a href="${esc(token.href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(token.label)}</a>`
      );
    } else {
      out.push(
        `<a class="inline-img__link" href="${esc(token.href)}" target="_blank" rel="noopener noreferrer nofollow">` +
          `<img class="inline-img" src="${esc(token.href)}" alt="${esc(token.alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` +
          `</a>`
      );
    }
  }
  return raw(out.join(''));
}

/**
 * 与 linkify 相同的效果，但返回真实 DOM 节点，可直接 append。
 *
 * 之所以要两个版本：linkify() 返回的是 raw 包装，只适合放进 tpl 的插值里。
 * 论坛回复、作者简介这些是运行时才知道内容的地方，只能 append，
 * 用错就会出现 "[object Object]"。
 */
export function linkifyNode(text) {
  const fragment = document.createDocumentFragment();

  for (const token of tokenizeInline(text)) {
    if (token.type === 'text') {
      fragment.append(document.createTextNode(token.value));
      continue;
    }

    const anchor = document.createElement('a');
    anchor.href = token.href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer nofollow';

    if (token.type === 'link') {
      anchor.textContent = token.label;
    } else {
      // 图片：外链原图不一定能加载（图床挂了、防盗链），
      // 失败时退回成一个可点的链接，别留一块空白。
      anchor.className = 'inline-img__link';
      const img = document.createElement('img');
      img.className = 'inline-img';
      img.src = token.href;
      img.alt = token.alt || '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.className = 'inline-img__failed';
        fallback.textContent = `[图片加载失败：${token.href}]`;
        anchor.replaceWith(fallback);
      });
      anchor.append(img);
    }

    fragment.append(anchor);
  }

  return fragment;
}
