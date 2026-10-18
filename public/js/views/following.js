/**
 * 我的关注：当前账号关注的所有作者。
 *
 * 上游的 /user/{id}/following 返回的是 { id, createdAt, user: {...} }，
 * 用户信息在 user 字段里；粉丝列表则用 follower 字段。
 * 直接渲染外层会得到一堆"匿名"。
 */

import { fetchFollowing, formatCount } from '../api.js';
import { lede, pageFromQuery, personCard, renderPagedFeed } from '../cards.js';
import { getSession, getSetting } from '../store.js';
import { icon, stateBlock, tpl } from '../ui.js';

export async function renderFollowing(ctx) {
  const session = getSession();
  const inlineToken = String(getSetting('token') || '').trim();
  const userId = session.user?.id;
  const signedIn = session.authenticated || !!inlineToken;

  if (!signedIn || !userId) {
    const head = lede({
      eyebrow: 'FOLLOWING',
      title: '我的关注',
      desc: '这里列出你关注的作者。'
    });
    const guide = tpl`
      <div class="state">
        <div class="state__title">登录后才能看你的关注列表</div>
        <p>关注关系存在 Iwara 账号里，需要以你的身份去取，未登录时拿不到。</p>
      </div>`;
    const actions = tpl`<div style="display:flex;gap:9px;flex-wrap:wrap;justify-content:center"></div>`;
    if (session.loginEnabled) {
      actions.append(tpl`<a class="btn btn--primary" href="#/login">${icon('shield')}<span>登录 Iwara 账号</span></a>`);
    }
    actions.append(tpl`<a class="btn" href="#/settings">用 Token 登录</a>`);
    guide.append(actions);
    return tpl`<div>${head}${guide}</div>`;
  }

  const page = pageFromQuery(ctx.query);

  const head = lede({
    eyebrow: 'FOLLOWING',
    title: '我的关注',
    desc: '你关注的作者。点头像进入他们的主页，能看到最近发布的作品。'
  });

  const feed = await renderPagedFeed({
    page,
    columns: 'grid--people',
    hrefFor: (target) => `#/library/following?page=${target + 1}`,
    // 见文件头：用户信息在 user 字段里。
    render: (item) => personCard(item.user || item.follower || item),
    emptyTitle: '还没有关注任何人',
    emptyMessage:
      '在作品页点作者名进入主页，右上角有关注按钮。关注之后，他们的新作品会出现在「订阅」里。',
    fetchPage: async (target, limit) => {
      const data = await fetchFollowing(userId, { page: target, limit });
      return { results: Array.isArray(data?.results) ? data.results : [], count: data?.count, limit: data?.limit };
    }
  });

  return tpl`<div>${head}<div style="margin-top:18px">${feed}</div></div>`;
}
