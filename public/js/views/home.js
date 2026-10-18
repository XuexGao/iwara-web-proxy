/**
 * 首页：作品索引。分页展示，页码写进地址栏。
 */

import { fetchVideos } from '../api.js';
import { lede, pageFromQuery, renderPagedFeed } from '../cards.js';
import { getSetting, ratingParam, setSetting } from '../store.js';
import { SORT_LABELS, SORT_OPTIONS, tpl } from '../ui.js';

const INTRO = {
  trending: '过去一周里被反复打开的作品。适合不知道看什么的时候随便翻。',
  date: '刚刚发布的东西，按上传时间倒序。',
  popularity: '收藏与评分综合最高的作品，都是经过时间筛过的。',
  likes: '点赞最多的作品。',
  views: '播放次数最多的作品。'
};

export async function renderHome(ctx) {
  let sort = ctx.query.get('sort') || getSetting('sort') || 'trending';
  if (!SORT_LABELS[sort]) sort = 'trending';
  setSetting('sort', sort);

  const page = pageFromQuery(ctx.query);

  const sortChips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of SORT_OPTIONS) {
    const chip = tpl`<a class="chip ${option.id === sort ? 'is-on' : ''}" href="#/?sort=${option.id}">${option.label}</a>`;
    sortChips.append(chip);
  }

  const head = lede({
    eyebrow: 'INDEX · 作品索引',
    title: SORT_LABELS[sort],
    desc: INTRO[sort] || ''
  });

  const feed = renderPagedFeed({
    page,
    kind: 'video',
    hrefFor: (target) => `#/?sort=${sort}&page=${target + 1}`,
    emptyTitle: '这一栏目前是空的',
    emptyMessage: '换一个排序看看，或者点开任意作品、顺着它下方的标签找同类。',
    fetchPage: (target, limit) =>
      fetchVideos({ page: target, limit, sort, rating: ratingParam() })
  });

  return tpl`<div>${head}${sortChips}<div style="margin-top:18px">${feed}</div></div>`;
}
