/**
 * 单个标签下的作品列表。
 */

import { fetchTag, fetchVideos, formatCount, tagLabel } from '../api.js';
import { lede, pageFromQuery, renderPagedFeed } from '../cards.js';
import { getSetting, ratingParam } from '../store.js';
import { SORT_LABELS, SORT_OPTIONS, stateBlock, tpl } from '../ui.js';

const TYPE_LABELS = {
  general: '通用',
  category: '分类',
  source: '来源'
};

export async function renderTag(ctx, { id }) {
  let sort = ctx.query.get('sort') || getSetting('sort') || 'trending';
  if (!SORT_LABELS[sort]) sort = 'trending';

  const page = pageFromQuery(ctx.query);
  const display = tagLabel(id);

  const head = lede({
    eyebrow: 'TAG',
    title: display,
    desc: `标签 id 是 ${id}。下面是通过它索引到的作品。`
  });

  const metaLine = tpl`<div class="badges" style="margin-bottom:14px"></div>`;

  const sortChips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of SORT_OPTIONS) {
    const params = new URLSearchParams();
    params.set('sort', option.id);
    sortChips.append(
      tpl`<a class="chip ${option.id === sort ? 'is-on' : ''}" href="#/tag/${encodeURIComponent(id)}?${params.toString()}">${option.label}</a>`
    );
  }

  const feed = await renderPagedFeed({
    page,
    kind: 'video',
    hrefFor: (target) =>
      `#/tag/${encodeURIComponent(id)}?sort=${sort}&page=${target + 1}`,
    emptyTitle: `「${display}」下面还没有作品`,
    emptyMessage: '这个标签可能刚建立，或者作品还没被归到它下面。换一个标签试试。',
    fetchPage: (target, limit) =>
      fetchVideos({ tags: id, page: target, limit, sort, rating: ratingParam() })
  });

  // 标签元信息由详情接口提供，拿不到不影响列表
  try {
    const tag = await fetchTag(id);
    if (tag) {
      if (tag.type) metaLine.append(tpl`<span class="badge">${TYPE_LABELS[tag.type] || tag.type}</span>`);
      if (tag.sensitive) metaLine.append(tpl`<span class="badge badge--ecchi">敏感标签</span>`);
      if (tag.count) metaLine.append(tpl`<span class="badge">${formatCount(tag.count)} 件作品</span>`);
    }
  } catch {
    /* 忽略 */
  }

  return tpl`<div>${head}${metaLine}${sortChips}<div style="margin-top:18px">${feed}</div></div>`;
}
