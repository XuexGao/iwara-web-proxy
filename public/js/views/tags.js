/**
 * 标签：总览与单个标签下的作品。
 */

import { fetchTag, fetchTags, fetchVideos, formatCount, tagLabel } from '../api.js';
import { createFeed, lede } from '../cards.js';
import { getSetting, ratingParam, setSetting } from '../store.js';
import { SORT_LABELS, SORT_OPTIONS, icon, observeBottom, stateBlock, tpl } from '../ui.js';

const TYPE_LABELS = {
  general: '通用',
  category: '分类',
  source: '来源'
};

const TYPE_HINTS = {
  general: '内容特征，比如分辨率、时长、画风',
  category: '作品所属的大类，比如原作、创作工具',
  source: '原始出处与素材来源'
};

/* ------------------------------------------------------------------ *
 * 标签总览
 * ------------------------------------------------------------------ */

export async function renderTags(ctx) {
  const sort = ctx.query.get('sort') === 'date' ? 'date' : 'popularity';
  const filter = ['all', 'general', 'category', 'source'].includes(ctx.query.get('type'))
    ? ctx.query.get('type')
    : 'all';

  const head = lede({
    eyebrow: 'TAG INDEX',
    title: '标签索引',
    desc: 'Iwara 的每个作品都挂在若干标签下。挑一个标签，就能顺着它找到同一题材的所有作品。'
  });

  const countNode = tpl`<span class="lede__count"></span>`;
  head.append(countNode);

  const sortChips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of [
    { id: 'popularity', label: '最常用' },
    { id: 'date', label: '最新出现' }
  ]) {
    const params = new URLSearchParams();
    params.set('sort', option.id);
    if (filter !== 'all') params.set('type', filter);
    sortChips.append(
      tpl`<a class="chip ${option.id === sort ? 'is-on' : ''}" href="#/tags?${params.toString()}">${option.label}</a>`
    );
  }

  const typeChips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of [
    { id: 'all', label: '全部' },
    { id: 'general', label: TYPE_LABELS.general },
    { id: 'category', label: TYPE_LABELS.category },
    { id: 'source', label: TYPE_LABELS.source }
  ]) {
    const params = new URLSearchParams();
    params.set('sort', sort);
    if (option.id !== 'all') params.set('type', option.id);
    typeChips.append(
      tpl`<a class="chip ${option.id === filter ? 'is-on' : ''}" href="#/tags?${params.toString()}">${option.label}</a>`
    );
  }

  if (filter !== 'all') {
    typeChips.append(tpl`<span class="badge">${TYPE_HINTS[filter]}</span>`);
  }

  const wall = tpl`<div class="tagrow" style="gap:8px"></div>`;
  const footer = tpl`<div class="loadmore"></div>`;

  // 上游 limit 封顶 50，多要也是 50。
  const PAGE_SIZE = 50;
  let page = 0;
  let loading = false;
  let done = false;

  async function loadMore() {
    if (loading || done) return;
    loading = true;
    footer.replaceChildren(tpl`<div class="skeleton" style="aspect-ratio:auto;height:40px"></div>`);
    try {
      const data = await fetchTags({ page, limit: PAGE_SIZE, sort });
      if (ctx.signal.aborted) return;
      const results = Array.isArray(data?.results) ? data.results : [];
      const filtered = filter === 'all' ? results : results.filter((tag) => tag.type === filter);
      footer.replaceChildren();

      if (page === 0) {
        countNode.replaceChildren(tpl`<b>${formatCount(data?.count)}</b><br />个标签`);
      }

      for (const tag of filtered) {
        wall.append(
          tpl`<a class="tagchip" data-type="${tag.type || 'general'}" href="#/tag/${encodeURIComponent(tag.id)}" title="${tag.id}">${tagLabel(tag.id)}</a>`
        );
      }

      page += 1;
      if (results.length < PAGE_SIZE) {
        done = true;
        if (!wall.childElementCount) {
          footer.replaceChildren(
            stateBlock({
              title: '这一类暂时没有标签',
              message: '切回「全部」看看，或者直接搜索关键词。'
            })
          );
        }
        return;
      }
      const more = tpl`<button class="btn btn--sm" type="button">加载更多标签</button>`;
      more.addEventListener('click', loadMore);
      footer.append(more);
    } catch (error) {
      if (ctx.signal.aborted) return;
      footer.replaceChildren(
        stateBlock({
          title: '标签没取到',
          message: error?.message || '稍后再试。',
          error: true,
          action: { label: '重试', onClick: loadMore }
        })
      );
    } finally {
      loading = false;
    }
  }

  loadMore();

  // 滚到底自动续上，省得一直点。
  const sentinel = tpl`<div style="height:1px"></div>`;
  footer.after(sentinel);
  const stop = observeBottom(sentinel, loadMore);
  ctx.onCleanup(stop);

  return tpl`<div>${head}${sortChips}${typeChips}${wall}${footer}</div>`;
}

/* ------------------------------------------------------------------ *
 * 单个标签
 * ------------------------------------------------------------------ */

export async function renderTag(ctx, { id }) {
  let sort = ctx.query.get('sort') || getSetting('sort') || 'trending';
  if (!SORT_LABELS[sort]) sort = 'trending';

  const display = tagLabel(id);
  const countNode = tpl`<span class="lede__count"></span>`;

  const head = lede({
    eyebrow: 'TAG',
    title: display,
    desc: `标签 id 是 ${id}。下面是通过它索引到的作品。`
  });
  head.append(countNode);

  const metaLine = tpl`<div class="badges" style="margin-bottom:14px"></div>`;

  const sortChips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of SORT_OPTIONS) {
    const params = new URLSearchParams();
    params.set('sort', option.id);
    sortChips.append(
      tpl`<a class="chip ${option.id === sort ? 'is-on' : ''}" href="#/tag/${encodeURIComponent(id)}?${params.toString()}">${option.label}</a>`
    );
  }

  const ratingChip = tpl`
    <button class="chip ${getSetting('r18') ? 'is-on' : ''}" type="button" aria-pressed="${getSetting('r18')}">
      ${icon('shield')}<span>显示 R18 内容</span>
    </button>`;

  const toolbar = tpl`
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
      ${sortChips}
      ${ratingChip}
    </div>`;

  const feedHost = tpl`<div></div>`;

  function buildFeed() {
    return createFeed({
      kind: 'video',
      limit: 32,
      emptyTitle: `「${display}」下面还没有作品`,
      emptyMessage: '这个标签可能刚建立，或者作品还没被归到它下面。换一个标签试试。',
      fetchPage: async (page, limit) => {
        const data = await fetchVideos({ tags: id, page, limit, sort, rating: ratingParam() });
        if (page === 0) {
          countNode.replaceChildren(tpl`<b>${formatCount(data?.count)}</b><br />件作品`);
        }
        return data;
      }
    });
  }

  let feed = buildFeed();
  feedHost.replaceChildren(feed.element);
  ctx.onCleanup(() => feed.stop());

  toolbar.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('button.chip')) return;
    const enabled = !getSetting('r18');
    setSetting('r18', enabled);
    ratingChip.classList.toggle('is-on', enabled);
    ratingChip.setAttribute('aria-pressed', String(enabled));
    feed.stop();
    feed = buildFeed();
    feedHost.replaceChildren(feed.element);
  });

  // 标签本身的元信息（类型 / 是否敏感）由详情接口提供。
  (async () => {
    try {
      const tag = await fetchTag(id);
      if (ctx.signal.aborted || !tag) return;
      if (tag.type) metaLine.append(tpl`<span class="badge">${TYPE_LABELS[tag.type] || tag.type}</span>`);
      if (tag.sensitive) metaLine.append(tpl`<span class="badge badge--ecchi">敏感标签</span>`);
      if (tag.count) metaLine.append(tpl`<span class="badge">${formatCount(tag.count)} 件作品</span>`);
    } catch {
      /* 拿不到元信息不影响列表 */
    }
  })();

  return tpl`<div>${head}${metaLine}${toolbar}${feedHost}</div>`;
}
