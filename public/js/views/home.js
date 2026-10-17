/**
 * 首页：作品索引。排序切换 + 分级开关 + 无限滚动。
 */

import { fetchVideos, formatCount } from '../api.js';
import { createFeed, lede } from '../cards.js';
import { getSetting, ratingParam, setSetting } from '../store.js';
import { SORT_LABELS, SORT_OPTIONS, icon, on, raw, tpl } from '../ui.js';

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

  const countNode = tpl`<span class="lede__count"></span>`;
  let feed;

  const sortChips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of SORT_OPTIONS) {
    const chip = tpl`<a class="chip ${option.id === sort ? 'is-on' : ''}" href="#/?sort=${option.id}">${option.label}</a>`;
    sortChips.append(chip);
  }

  const ratingChip = tpl`
    <button class="chip" type="button" aria-pressed="${getSetting('r18')}">
      ${icon('shield')}<span>显示 R18 内容</span>
    </button>`;

  const head = lede({
    eyebrow: 'INDEX · 作品索引',
    title: SORT_LABELS[sort],
    desc: INTRO[sort] || ''
  });
  head.append(countNode);

  const toolbar = tpl`
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
      ${sortChips}
      ${ratingChip}
    </div>`;

  const feedHost = tpl`<div></div>`;

  function buildFeed() {
    const next = createFeed({
      kind: 'video',
      limit: 32,
      emptyTitle: '这一栏目前是空的',
      emptyMessage: '换一个排序看看，或者去标签索引里挑一个题材。',
      fetchPage: async (page, limit) => {
        const data = await fetchVideos({ page, limit, sort, rating: ratingParam() });
        if (page === 0) {
          countNode.replaceChildren(
            tpl`<b>${formatCount(data?.count)}</b><br />件作品`
          );
        }
        return data;
      }
    });
    feedHost.replaceChildren(next.element);
    return next;
  }

  feed = buildFeed();
  ctx.onCleanup(() => feed.stop());

  on(toolbar, 'click', 'button.chip', () => {
    const enabled = !getSetting('r18');
    setSetting('r18', enabled);
    ratingChip.setAttribute('aria-pressed', String(enabled));
    ratingChip.classList.toggle('is-on', enabled);
    feed.stop();
    feed = buildFeed();
  });
  ratingChip.classList.toggle('is-on', getSetting('r18'));

  const footer = tpl`
    <div style="margin-top:34px" class="note">
      想按题材找？去 ${raw('<a href="#/tags" style="color:var(--celadon)">标签索引</a>')}，
      或者用顶部的搜索框。搜索需要登录 Iwara 账号。
    </div>`;

  return tpl`<div>${head}${toolbar}${feedHost}${footer}</div>`;
}
