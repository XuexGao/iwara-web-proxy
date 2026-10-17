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

export function icon(name, className = 'icon') {
  return raw(`<svg class="${className}"><use href="#i-${name}"/></svg>`);
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

/** 把一段纯文本里的 URL 变成可点链接（已转义，安全）。 */
export function linkify(text) {
  const value = String(text || '');
  const parts = [];
  const pattern = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(value))) {
    if (match.index > last) parts.push(esc(value.slice(last, match.index)));
    const href = match[0];
    parts.push(
      `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(href)}</a>`
    );
    last = match.index + href.length;
  }
  if (last < value.length) parts.push(esc(value.slice(last)));
  return raw(parts.join(''));
}
