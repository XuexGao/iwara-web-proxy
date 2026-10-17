/**
 * 订阅页：只看你关注的作者发布的作品。
 *
 * ⚠️ 这里有个必须防的上游陷阱：`/videos?subscribed=true` 在**没有有效 token**
 * 时会被服务端**静默忽略**，一样返回 200 和全站内容——不会报错。
 * 如果不做鉴权检查，未登录访客会看到"订阅页"里塞满陌生人的作品，
 * 而且完全看不出哪里不对。所以这里把登录状态作为硬前置条件。
 */

import { fetchImages, fetchVideos, formatCount } from '../api.js';
import { createFeed, lede, userLink } from '../cards.js';
import router from '../router.js';
import { getSession, getSetting, ratingParam } from '../store.js';
import { SORT_OPTIONS, icon, stateBlock, tpl } from '../ui.js';

const SORTS = SORT_OPTIONS.filter((option) => option.id !== 'trending');

export async function renderSubscriptions(ctx) {
  const session = getSession();
  const inlineToken = String(getSetting('token') || '').trim();
  const signedIn = session.authenticated || !!inlineToken;

  /* ---------------- 未登录：直接给引导，不发请求 ---------------- */

  if (!signedIn) {
    const head = lede({
      eyebrow: 'SUBSCRIPTIONS',
      title: '订阅',
      desc: '这里汇总你关注的作者最近发布的作品。'
    });

    const guide = tpl`
      <div class="state">
        <div class="state__title">先登录才能看自己的订阅</div>
        <p>
          订阅需要以你的账号身份向 Iwara 请求。未登录时上游会忽略「只看订阅」这个条件、
          直接返回全站内容，看起来像是订阅页，其实不是你的订阅——所以这里不做假装的填充。
        </p>
      </div>`;

    const actions = tpl`<div style="display:flex;gap:9px;flex-wrap:wrap;justify-content:center"></div>`;
    if (session.loginEnabled) {
      actions.append(tpl`<a class="btn btn--primary" href="#/login">${icon('shield')}<span>登录 Iwara 账号</span></a>`);
    }
    actions.append(tpl`<a class="btn" href="#/settings">用 Token 登录</a>`);
    guide.append(actions);

    const tip = tpl`
      <div class="note" style="max-width:620px;margin:20px auto 0">
        不看订阅也可以正常浏览：首页有热门与最新，作品页底部有关联推荐。
        订阅只是把「你关注的人」单独挑出来。
      </div>`;

    return tpl`<div>${head}${guide}${tip}</div>`;
  }

  /* ---------------- 已登录 ---------------- */

  let kind = ctx.query.get('kind') === 'images' ? 'images' : 'videos';
  let sort = ctx.query.get('sort') || 'date';
  if (!SORTS.some((option) => option.id === sort)) sort = 'date';

  const head = lede({
    eyebrow: 'SUBSCRIPTIONS',
    title: '订阅',
    desc: `你关注的作者最近发布的${kind === 'images' ? '图库' : '视频'}，按${SORTS.find((s) => s.id === sort)?.label || '最新'}排序。`
  });
  const countNode = tpl`<span class="lede__count"></span>`;
  head.append(countNode);

  const kindChips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of [
    { id: 'videos', label: '视频', icon: 'grid' },
    { id: 'images', label: '图库', icon: 'list' }
  ]) {
    const params = new URLSearchParams();
    params.set('kind', option.id);
    params.set('sort', sort);
    kindChips.append(
      tpl`<a class="chip ${option.id === kind ? 'is-on' : ''}" href="#/subscriptions?${params.toString()}">${icon(option.icon)}<span>${option.label}</span></a>`
    );
  }

  const sortChips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of SORTS) {
    const params = new URLSearchParams();
    params.set('kind', kind);
    params.set('sort', option.id);
    sortChips.append(
      tpl`<a class="chip ${option.id === sort ? 'is-on' : ''}" href="#/subscriptions?${params.toString()}">${option.label}</a>`
    );
  }

  const feedHost = tpl`<div></div>`;

  function buildFeed() {
    return createFeed({
      kind: kind === 'images' ? 'image' : 'video',
      limit: 32,
      emptyTitle: '订阅里还什么都没有',
      emptyMessage:
        '可能你还没有关注任何作者，或者关注的作者最近没发新东西。去作品页点作者头像，进主页就能关注。',
      fetchPage: async (page, limit) => {
        const params = {
          subscribed: 'true',
          page,
          limit,
          sort,
          rating: ratingParam()
        };
        const data =
          kind === 'images' ? await fetchImages(params) : await fetchVideos(params);
        if (page === 0) {
          countNode.replaceChildren(
            tpl`<b>${formatCount(data?.count)}</b><br />件新作品`
          );
        }
        return data;
      }
    });
  }

  let feed = buildFeed();
  feedHost.replaceChildren(feed.element);
  ctx.onCleanup(() => feed.stop());

  // 订阅为空时顺手列出你关注的人，方便直接点进去
  const followingStrip = tpl`<div></div>`;
  loadFollowingStrip(followingStrip, ctx);

  const footer = tpl`
    <p class="desc" style="margin-top:24px">
      想调整关注列表？在作品页点作者名进入主页，那里有关注按钮。
      <a href="#/" style="color:var(--celadon)">回首页看看</a>
    </p>`;

  return tpl`<div>${head}${kindChips}${sortChips}${feedHost}${followingStrip}${footer}</div>`;
}

/** 底部横条：你关注的作者，点进去可直接看其主页。 */
async function loadFollowingStrip(host, ctx) {
  const session = getSession();
  const userId = session.user?.id;
  if (!userId) return;

  try {
    const { fetchFollowing } = await import('../api.js');
    const data = await fetchFollowing(userId, { page: 0, limit: 18 });
    if (ctx.signal.aborted) return;
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) return;

    const strip = tpl`
      <div class="panel">
        <div class="panel__title">你关注的作者</div>
      </div>`;
    const row = tpl`<div class="chips chips--scroll"></div>`;
    for (const user of results) {
      const href = userLink(user);
      if (!href) continue;
      row.append(
        tpl`<a class="chip" href="${href}">${icon('user')}<span>${user.name || user.username}</span></a>`
      );
    }
    strip.append(row);
    host.replaceChildren(strip);
  } catch {
    /* 关注列表拿不到不影响主列表 */
  }
}
