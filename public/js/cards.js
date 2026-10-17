/**
 * 作品卡片、人物卡片与分页信息流。
 */

import {
  avatarUrl,
  coverUrl,
  formatCount,
  formatDuration,
  formatDate,
  imageUrl,
  playlistCoverUrl,
  tagLabel
} from './api.js';
import { attachPreview } from './cards-preview.js';
import { icon, observeBottom, raw, skeletonGrid, stateBlock, tpl } from './ui.js';

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
  return tpl`<span class="card__stat">${icon(iconName)}${formatCount(value)}</span>`;
}

/**
 * 作品卡片。视频带悬停预览，图库显示张数。
 * @param {object} item
 * @param {'video'|'image'} kind
 * @param {{row?: boolean}} options
 */
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

  const badge =
    kind === 'image'
      ? item.numImages
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

/** 播放页右侧的相关作品条目。 */
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
 * 索引标题
 * ------------------------------------------------------------------ */

export function lede({ eyebrow, title, count, desc, actions }) {
  return tpl`
    <div class="lede">
      <div>
        ${eyebrow ? tpl`<div class="lede__eyebrow">${eyebrow}</div>` : null}
        <h1 class="lede__title">${title}</h1>
      </div>
      ${count !== undefined && count !== null && count !== ''
        ? tpl`<div class="lede__count"><b>${formatCount(count)}</b><br />件作品</div>`
        : null}
      ${actions || null}
      ${desc ? tpl`<div class="lede__desc">${desc}</div>` : null}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * 分页信息流
 * ------------------------------------------------------------------ */

/**
 * 建立一个自动加载下一页的网格。
 *
 * @param {object} options
 * @param {(page:number, limit:number) => Promise<{results:any[], count:number}>} options.fetchPage
 * @param {'video'|'image'} [options.kind]
 * @param {(item:any) => Node} [options.render] 自定义渲染，默认 workCard
 * @param {string} [options.columns] 额外网格类名
 * @param {string} [options.emptyTitle]
 * @param {string} [options.emptyMessage]
 * @param {number} [options.limit]
 */
export function createFeed(options) {
  const {
    fetchPage,
    kind = 'video',
    render,
    columns = '',
    emptyTitle = '这里还没有内容',
    emptyMessage = '换个排序或标签再看看。',
    limit = 32,
    minResults = 0
  } = options;

  const grid = tpl`<div class="grid ${columns}"></div>`;
  const footer = tpl`<div class="loadmore"></div>`;
  const root = tpl`<div class="feed"></div>`;
  root.append(grid, footer);

  let page = -1;
  let total = 0;
  let loaded = 0;
  let done = false;
  let loading = false;
  let stopped = false;
  let stopObserve = null;
  let firstLoad = true;

  const renderItem = render || ((item) => (kind === 'image' ? workCard(item, 'image') : workCard(item, kind)));

  function showSkeleton() {
    footer.replaceChildren(skeletonGrid(limit > 12 ? 12 : limit));
  }

  function setFooter(node) {
    footer.replaceChildren(node || document.createTextNode(''));
  }

  async function loadMore() {
    if (loading || done || stopped) return;
    loading = true;
    if (firstLoad) showSkeleton();

    try {
      const nextPage = page + 1;
      const data = await fetchPage(nextPage, limit);
      if (stopped) return;

      const results = Array.isArray(data?.results) ? data.results : [];
      page = nextPage;
      total = Number(data?.count) || total;
      setFooter(null);
      firstLoad = false;

      // 上游会把 limit 封顶在 50，判定"到底了"要用它实际给的页大小，
      // 否则请求 96 只回 50 时会被误判成最后一页。
      const effectiveLimit = Number(data?.limit) > 0 ? Number(data.limit) : limit;

      if (results.length === 0) {
        done = true;
      } else {
        const batch = document.createDocumentFragment();
        for (const item of results) batch.append(renderItem(item));
        grid.append(batch);
        loaded += results.length;
        if (results.length < effectiveLimit || (total && loaded >= total)) done = true;
      }

      if (grid.childElementCount === 0) {
        setFooter(stateBlock({ title: emptyTitle, message: emptyMessage }));
        done = true;
      } else if (done) {
        setFooter(tpl`<div class="lede__eyebrow" style="padding:26px 0">— 已到末尾 —</div>`);
      }
      if (!done) startObserving();
    } catch (error) {
      if (stopped) return;
      firstLoad = false;
      setFooter(
        stateBlock({
          title: '加载失败',
          message: error?.message || '请稍后重试。',
          error: true,
          action: {
            label: '重试',
            onClick: () => {
              setFooter(null);
              loadMore();
            }
          }
        })
      );
    } finally {
      loading = false;
    }
  }

  function startObserving() {
    if (stopObserve) stopObserve();
    const sentinel = tpl`<div style="height:1px"></div>`;
    footer.append(sentinel);
    stopObserve = observeBottom(sentinel, loadMore);
  }

  loadMore();

  return {
    element: root,
    grid,
    reload() {
      stopped = false;
      done = false;
      page = -1;
      total = 0;
      loaded = 0;
      firstLoad = true;
      grid.replaceChildren();
      setFooter(null);
      if (stopObserve) stopObserve();
      loadMore();
    },
    stop() {
      stopped = true;
      if (stopObserve) stopObserve();
    },
    get count() {
      return total;
    }
  };
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
  node.querySelector('.comment__text').textContent = comment.body || '';
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
