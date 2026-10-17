/**
 * 标签：总览与单个标签下的作品。
 */

import { fetchTag, fetchVideos, formatCount, tagLabel } from '../api.js';
import { createFeed, lede } from '../cards.js';
import { getSetting, ratingParam, setSetting } from '../store.js';
import { SORT_LABELS, SORT_OPTIONS, icon, stateBlock, tpl } from '../ui.js';

const TYPE_LABELS = {
  general: '通用',
  category: '分类',
  source: '来源'
};

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
