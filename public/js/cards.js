/**
 * 分页信息流。
 *
 * 默认是「分页」而不是无限滚动：页码在地址栏里（?page=2），刷新和分享都能回到同一页，
 * 切换页面时自动回到顶部。无限滚动看起来更省事，但翻到很深之后既回不去也分享不出去。
 */

import {
  avatarUrl,
  coverUrl,
  formatCount,
  formatDate,
  formatDuration,
  imageUrl,
  playlistCoverUrl,
  tagLabel
} from './api.js';
import { attachPreview } from './cards-preview.js';
import { icon, linkifyNode, raw, stateBlock, tpl } from './ui.js';

export const PAGE_SIZE = 30;

/* ------------------------------------------------------------------ *
 * 链接
 * ------------------------------------------------------------------ */

export function workLink(item, kind = 'video') {
  return kind === 'image' ? `#/image/${item.id}` : `#/video/${item.id}`;
}

export function userLink(user) {
  const handle = user?.username || user?.name;
  return handle ? `#/user/${encodeURIComponent(handle)}` : null;
}

/* ------------------------------------------------------------------ *
 * 卡片
 * ------------------------------------------------------------------ */

function metaStat(iconName, value) {
  if (!value) return null;
  return tpl`<span class="card__stat" data-stat="${iconName}">${icon(iconName)}${formatCount(value)}</span>`;
}

export function workCard(item, kind = 'video', options = {}) {
  const href = workLink(item, kind);
  const cover = tpl`
    <a class="card__cover" href="${href}" aria-label="${item.title || '作品'}">
      <img src="${coverUrl(item, kind)}" alt="" loading="lazy" decoding="async" />
    </a>`;

  const marks = [];
  if (item.rating === 'ecchi') marks.push(raw('<i data-rating="ecchi" title="R18"></i>'));
  if (kind === 'image') marks.push(raw('<i data-kind="image" title="图库"></i>'));
  if (marks.length) cover.append(tpl`<span class="card__mark">${marks}</span>`);

  // 单张图库标「1 张」是噪音，只在多于一张时标出来。
  const badge =
    kind === 'image'
      ? item.numImages > 1
        ? `${item.numImages} 张`
        : ''
      : item.file?.duration
        ? formatDuration(item.file.duration)
        : '';
  if (badge) cover.append(tpl`<span class="card__dur">${badge}</span>`);

  if (kind === 'video') attachPreview(cover, item.id);

  const authorHref = userLink(item.user);
  const author = authorHref
    ? tpl`<a class="card__author" href="${authorHref}">${item.user?.name || item.user?.username || '匿名'}</a>`
    : null;

  return tpl`
    <article class="card ${options.row ? 'card--row' : ''}">
      ${cover}
      <div class="card__body">
        <a class="card__title" href="${href}">${item.title || '无标题'}</a>
        <div class="card__meta">
          ${author}
          ${metaStat('eye', item.numViews)}
          ${metaStat('heart', item.numLikes)}
          ${kind === 'image' ? null : metaStat('comment', item.numComments)}
        </div>
      </div>
    </article>`;
}

export function personCard(user) {
  const href = userLink(user) || '#/';
  return tpl`
    <a class="person" href="${href}">
      <img class="person__avatar" src="${avatarUrl(user)}" alt="" loading="lazy" />
      <div class="person__name">${user.name || user.username || '匿名'}</div>
      <div class="person__handle">@${user.username || ''}</div>
    </a>`;
}

export function playlistCard(playlist) {
  const href = `#/playlist/${playlist.id}`;
  return tpl`
    <article class="card">
      <a class="card__cover" href="${href}">
        <img src="${playlistCoverUrl(playlist)}" alt="" loading="lazy" decoding="async" />
        <span class="card__dur">${playlist.numVideos || 0} 个作品</span>
      </a>
      <div class="card__body">
        <a class="card__title" href="${href}">${playlist.title || '未命名播放列表'}</a>
        <div class="card__meta">
          ${userLink(playlist.user) ? tpl`<a class="card__author" href="${userLink(playlist.user)}">${playlist.user?.name || ''}</a>` : null}
        </div>
      </div>
    </article>`;
}

export function railItem(item, kind = 'video') {
  const href = workLink(item, kind);
  return tpl`
    <article class="rail__item">
      <a class="rail__thumb" href="${href}">
        <img src="${coverUrl(item, kind)}" alt="" loading="lazy" />
      </a>
      <div class="rail__text">
        <a class="rail__title" href="${href}">${item.title || '无标题'}</a>
        <div class="rail__meta">
          ${item.user?.name || ''} · ${formatCount(item.numViews)} 次播放
        </div>
      </div>
    </article>`;
}

/* ------------------------------------------------------------------ *
 * 索引标题与分页条
 * ------------------------------------------------------------------ */

export function lede({ eyebrow, title, count, desc, actions }) {
  return tpl`
    <div class="lede">
      <div>
        ${eyebrow ? tpl`<div class="lede__eyebrow">${eyebrow}</div>` : null}
        <h1 class="lede__title">${title}</h1>
      </div>
      ${actions || null}
      ${desc ? tpl`<div class="lede__desc">${desc}</div>` : null}
    </div>`;
}

/**
 * 生成页码列表：首页、末页、当前页左右各一页，其余用省略号。
 * 返回 '…' 表示省略。
 */
function pageWindow(current, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i);
  }
  const pages = new Set([0, totalPages - 1, current]);
  for (let d = 1; d <= 1; d += 1) {
    if (current - d >= 0) pages.add(current - d);
    if (current + d < totalPages) pages.add(current + d);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out = [];
  let prev = -2;
  for (const page of sorted) {
    if (page - prev > 1) out.push('…');
    out.push(page);
    prev = page;
  }
  return out;
}

/**
 * 分页条。
 *
 * 两种模式：
 * - 传 `hrefFor`：渲染成 <a>，用于列表页（页码进地址栏，可刷新可分享）
 * - 传 `onNavigate`：渲染成 <button>，用于评论区这类「就地翻页」，
 *   避免改地址导致整个播放页（含视频）重新加载
 *
 * @param {object} options
 * @param {number} options.page 当前页（0 基）
 * @param {number} options.totalPages
 * @param {(page:number) => string} [options.hrefFor]
 * @param {(page:number) => void} [options.onNavigate]
 * @param {string} [options.noun] 名词，用于无障碍标签
 */
export function pager({ page, totalPages, hrefFor, onNavigate, noun = '页' }) {
  if (totalPages <= 1) return tpl`<div class="pager"></div>`;

  const bar = tpl`<nav class="pager" aria-label="分页"></nav>`;

  /** 生成一个可点的页码/前后页控件。 */
  function control({ target, label, className, disabled, isCurrent, iconName, iconFirst }) {
    const glyph = iconName ? icon(iconName) : null;
    const text = label ? tpl`<span>${label}</span>` : null;

    if (disabled || isCurrent) {
      const tag = isCurrent ? 'span' : 'span';
      return tpl`<${raw(tag)} class="${className} ${disabled ? 'is-off' : ''} ${
        isCurrent ? 'is-on' : ''
      }"${isCurrent ? raw(' aria-current="page"') : raw(' aria-disabled="true"')}>${
        iconFirst ? glyph : null
      }${text}${iconFirst ? null : glyph}</${raw(tag)}>`;
    }

    if (onNavigate) {
      const button = tpl`<button class="${className}" type="button">${
        iconFirst ? glyph : null
      }${text}${iconFirst ? null : glyph}</button>`;
      button.addEventListener('click', () => onNavigate(target));
      return button;
    }

    return tpl`<a class="${className}" href="${hrefFor(target)}"${
      className.includes('pager__btn') ? raw(target < page ? ' rel="prev"' : ' rel="next"') : null
    }>${iconFirst ? glyph : null}${text}${iconFirst ? null : glyph}</a>`;
  }

  const atStart = page <= 0;
  const atEnd = page >= totalPages - 1;

  bar.append(
    control({
      target: page - 1,
      label: `上一${noun}`,
      className: 'pager__btn',
      disabled: atStart,
      iconName: 'back',
      iconFirst: true
    })
  );

  const numbers = tpl`<div class="pager__nums"></div>`;
  for (const entry of pageWindow(page, totalPages)) {
    if (entry === '…') {
      numbers.append(tpl`<span class="pager__gap">…</span>`);
      continue;
    }
    numbers.append(
      control({
        target: entry,
        label: String(entry + 1),
        className: 'pager__num',
        isCurrent: entry === page
      })
    );
  }
  bar.append(numbers);

  bar.append(
    control({
      target: page + 1,
      label: `下一${noun}`,
      className: 'pager__btn',
      disabled: atEnd,
      iconName: 'next'
    })
  );

  return bar;
}

/* ------------------------------------------------------------------ *
 * 分页信息流
 * ------------------------------------------------------------------ */

/**
 * 渲染一页内容并给出分页条。
 *
 * ⚠️ 这个函数是**同步**返回的，数据在后台加载。
 *
 * 之前它是 async 且内部 await 了接口，于是调用方 `await renderPagedFeed(...)`
 * 拿到的是「已经填好内容」的节点——骨架屏虽然建出来了，却从来没被插进页面，
 * 表现为「骨架屏彻底不见了」。现在先把带骨架的节点交出去，数据回来再填充。
 *
 * @param {object} options
 * @param {(page:number, limit:number) => Promise<{results:any[], count:number, limit?:number}>} options.fetchPage
 * @param {number} [options.page] 当前页（0 基）
 * @param {(page:number) => string} options.hrefFor 生成某页地址
 * @param {'video'|'image'} [options.kind]
 * @param {(item:any) => Node} [options.render]
 * @param {string} [options.columns]
 * @param {string} [options.emptyTitle]
 * @param {string} [options.emptyMessage]
 * @param {number} [options.limit]
 * @returns {HTMLElement} 立刻可用的节点（内含骨架屏）
 */
export function renderPagedFeed(options) {
  const {
    fetchPage,
    page = 0,
    hrefFor,
    kind = 'video',
    render,
    columns = '',
    emptyTitle = '这里还没有内容',
    emptyMessage = '换个排序或标签再看看。',
    limit = PAGE_SIZE
  } = options;

  const root = tpl`<div class="feed"></div>`;
  const grid = tpl`<div class="grid ${columns}"></div>`;
  const tail = tpl`<div class="loadmore"></div>`;
  root.append(grid, tail);

  // 骨架数量按每页条数来，但不超过 12 个，避免一次铺太多节点。
  const skeletonCount = Math.min(limit, 12);

  function showSkeleton() {
    grid.replaceChildren();
    for (let i = 0; i < skeletonCount; i += 1) {
      grid.append(
        tpl`<div class="card card--skeleton" aria-hidden="true">
          <div class="skeleton"></div>
          <div class="skeleton" style="aspect-ratio:auto;height:14px;width:82%"></div>
          <div class="skeleton" style="aspect-ratio:auto;height:11px;width:46%"></div>
        </div>`
      );
    }
  }

  showSkeleton();

  (async () => {
    let data;
    try {
      data = await fetchPage(page, limit);
    } catch (error) {
      grid.replaceChildren();
      tail.replaceChildren(
        stateBlock({
          title: '加载失败',
          message: error?.message || '请稍后重试。',
          error: true,
          action: { label: '重试', onClick: () => location.reload() }
        })
      );
      return;
    }

    // 节点可能已被导航丢弃
    if (!root.isConnected && root.parentNode === null && tail.childElementCount === 0) {
      /* 首次加载时 root 尚未挂载是正常的，不能据此丢弃 */
    }

    const results = Array.isArray(data?.results) ? data.results : [];
    const total = Number(data?.count) || 0;
    const effectiveLimit = Number(data?.limit) > 0 ? Number(data.limit) : limit;
    const totalPages = Math.max(1, Math.ceil(total / effectiveLimit));

    grid.replaceChildren();
    tail.replaceChildren();

    if (!results.length) {
      grid.append(
        stateBlock({
          title: page > 0 ? '这一页是空的' : emptyTitle,
          message: page > 0 ? '这已经是最后一页附近了，回上一页看看。' : emptyMessage,
          action:
            page > 0
              ? {
                  label: '回上一页',
                  onClick: () => (location.hash = hrefFor(page - 1).replace(/^#/, ''))
                }
              : undefined
        })
      );
      tail.append(pager({ page, totalPages, hrefFor }));
      return;
    }

    const renderItem = render || ((item) => workCard(item, kind));
    const batch = document.createDocumentFragment();
    for (const item of results) batch.append(renderItem(item));
    grid.append(batch);

    tail.append(pager({ page, totalPages, hrefFor }));

    if (total > effectiveLimit) {
      const from = page * effectiveLimit + 1;
      const to = Math.min(total, page * effectiveLimit + results.length);
      tail.append(
        tpl`<p class="pager__hint">第 ${from}–${to} 件，共 ${formatCount(total)} 件 · 第 ${page + 1} / ${totalPages} 页</p>`
      );
    }
  })();

  return root;
}

/* ------------------------------------------------------------------ *
 * 从地址里解析页码
 * ------------------------------------------------------------------ */

/**
 * 读取 ?page=，转成 0 基页码并做上限保护。
 * 页码写进 URL 才能刷新/分享后回到同一页。
 */
export function pageFromQuery(query, maxPage = 10000) {
  const raw = Number.parseInt(query?.get('page') ?? '1', 10);
  if (!Number.isFinite(raw) || raw < 1) return 0;
  return Math.min(raw - 1, maxPage);
}

/* ------------------------------------------------------------------ *
 * 评论
 * ------------------------------------------------------------------ */

export function commentNode(comment, { canDelete = false } = {}) {
  const href = userLink(comment.user);
  const name = comment.user?.name || comment.user?.username || '匿名';
  const node = tpl`
    <article class="comment">
      <img class="comment__avatar" src="${avatarUrl(comment.user)}" alt="" loading="lazy" />
      <div class="comment__body">
        <div class="comment__head">
          ${href ? tpl`<a class="comment__name" href="${href}">${name}</a>` : tpl`<span class="comment__name">${name}</span>`}
          <span class="comment__time">${formatDate(comment.createdAt)}</span>
        </div>
        <p class="comment__text"></p>
      </div>
    </article>`;
  // 评论正文是 Markdown（含 ![](url) 图片），不能直接 textContent
  node.querySelector('.comment__text').append(linkifyNode(comment.body || ''));
  if (canDelete) {
    const button = tpl`<button class="chip" type="button" style="height:24px;padding:0 9px;font-size:12px">删除</button>`;
    button.addEventListener('click', () => comment.onDelete?.(comment));
    node.querySelector('.comment__body').append(button);
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * 标签行
 * ------------------------------------------------------------------ */

export function tagRow(tags, limit = 10) {
  const list = (tags || []).slice(0, limit);
  if (!list.length) return null;
  return tpl`
    <div class="tagrow">
      ${list.map(
        (tag) =>
          tpl`<a class="tagchip" data-type="${tag.type || 'general'}" href="#/tag/${encodeURIComponent(tag.id)}" title="${tag.id}">${tagLabel(tag.id)}</a>`
      )}
    </div>`;
}

export { imageUrl };
