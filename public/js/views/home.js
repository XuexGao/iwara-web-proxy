/**
 * 首页：作品索引。排序切换 + 分级开关 + 无限滚动。
 */

import { fetchVideos, formatCount } from '../api.js';
import { createFeed, lede } from '../cards.js';
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

  const toolbar = sortChips;

  const feedHost = tpl`<div></div>`;

  function buildFeed() {
    const next = createFeed({
      kind: 'video',
      limit: 32,
      emptyTitle: '这一栏目前是空的',
      emptyMessage: '换一个排序看看，或者点开任意作品、顺着它下方的标签找同类。',
      fetchPage: async (page, limit) => {
        const data = await fetchVideos({ page, limit, sort, rating: ratingParam() });
        return data;
      }
    });
    feedHost.replaceChildren(next.element);
    return next;
  }

  const feed = buildFeed();
  ctx.onCleanup(() => feed.stop());

  const footer = tpl`
    <div style="margin-top:34px" class="note">
      想按题材找？点任意作品下方的标签，就能顺着它找到同类作品。
      顶部的搜索框也支持关键词，搜索需要登录 Iwara 账号。
    </div>`;

  return tpl`<div>${head}${toolbar}${feedHost}${footer}</div>`;
}
