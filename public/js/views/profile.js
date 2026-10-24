/**
 * 作者页：资料头 + 作品 / 图库 / 播放列表 / 粉丝 / 关注。
 */

import {
  avatarUrl,
  fetchFollowers,
  fetchFollowing,
  fetchImages,
  fetchPlaylists,
  fetchProfile,
  fetchVideos,
  followUser,
  formatCount,
  formatDate,
  profileHeaderUrl
} from '../api.js';
import { pageFromQuery, personCard, playlistCard, renderPagedFeed } from '../cards.js';
import { getSession, getSetting, ratingParam } from '../store.js';
import { SORT_OPTIONS, icon, linkifyNode, stateBlock, tpl, toast, toastError } from '../ui.js';

const TABS = [
  { id: 'videos', label: '作品', icon: 'grid' },
  { id: 'images', label: '图库', icon: 'list' },
  { id: 'playlists', label: '播放列表', icon: 'star' },
  { id: 'followers', label: '粉丝', icon: 'user' },
  { id: 'following', label: '关注', icon: 'user' }
];

export async function renderProfile(ctx, { username }) {
  const profile = await fetchProfile(username);
  const user = profile?.user;
  if (!user?.id) {
    return stateBlock({
      title: '找不到这位作者',
      message: `Iwara 上没有名为 ${username} 的作者，检查一下拼写。`
    });
  }

  const name = user.name || user.username || username;
  const banner = profileHeaderUrl(user);

  const followersStat = tpl`<span class="stat__n" data-stat="followers">–</span>`;
  const followingStat = tpl`<span class="stat__n" data-stat="following">–</span>`;
  const worksStat = tpl`<span class="stat__n" data-stat="works">–</span>`;

  const followButton = tpl`
    <button class="btn ${user.following ? '' : 'btn--primary'}" type="button">
      ${user.following ? '已关注' : '关注'}
    </button>`;

  let following = !!user.following;
  followButton.addEventListener('click', async () => {
    if (!getSession().authenticated && !getSetting('token')) {
      toast('登录后才能关注作者', 'error');
      location.hash = '#/login';
      return;
    }
    followButton.disabled = true;
    const next = !following;
    try {
      await followUser(user.id, next);
      following = next;
      followButton.textContent = following ? '已关注' : '关注';
      followButton.classList.toggle('btn--primary', !following);
      toast(following ? `已关注 ${name}` : '已取消关注');
    } catch (error) {
      toastError(error, '操作失败');
    } finally {
      followButton.disabled = false;
    }
  });

  const head = tpl`
    <div class="profilehead">
      <div class="profilehead__banner">
        ${banner ? tpl`<img src="${banner}" alt="" />` : null}
      </div>
      <div class="profilehead__body">
        <img class="profilehead__avatar" src="${avatarUrl(user)}" alt="" />
        <div class="profilehead__text">
          <div class="profilehead__name">${name}</div>
          <div class="profilehead__handle">
            @${user.username || ''}${user.premium ? ' · 会员' : ''}${user.creatorProgram ? ' · 创作者计划' : ''}
          </div>
          <div class="profilehead__stats">
            <div><div class="stat__n" data-stat="works">–</div><div class="stat__k">作品</div></div>
            <div>${followersStat}<div class="stat__k">粉丝</div></div>
            <div>${followingStat}<div class="stat__k">关注</div></div>
          </div>
        </div>
        ${followButton}
      </div>
    </div>`;

  // 头部里的作品数是另一个节点，用同一个引用统一更新。
  head.querySelector('[data-stat="works"]').replaceWith(worksStat);

  // 关于简介放在资料头之后、标签栏之前：
  // 之前它夹在排序条和作品列表中间，和作品贴得太近，看着挤。
  const bodyPanel = profile.body
    ? tpl`
      <div class="profile__bio">
        <div class="profile__bio-title">关于</div>
        <div class="desc is-clamped"></div>
      </div>`
    : null;
  if (bodyPanel) {
    const desc = bodyPanel.querySelector('.desc');
    desc.append(linkifyNode(profile.body));
    desc.addEventListener('click', () => desc.classList.toggle('is-clamped'));
  }

  /* ---------------- 标签页 ---------------- */

  let active = ctx.query.get('tab') || 'videos';
  if (!TABS.some((tab) => tab.id === active)) active = 'videos';
  let sort = ctx.query.get('sort') || getSetting('sort') || 'trending';
  if (!SORT_OPTIONS.some((option) => option.id === sort)) sort = 'trending';

  const tabBar = tpl`<div class="chips chips--scroll"></div>`;
  const sortBar = tpl`<div class="chips chips--scroll"></div>`;
  const content = tpl`<div class="profile__content"></div>`;
  let feed = null;

  function paintSortBar() {
    sortBar.replaceChildren();
    const sortable = active === 'videos' || active === 'images';
    sortBar.hidden = !sortable;
    if (!sortable) return;
    for (const option of SORT_OPTIONS) {
      const chip = tpl`<button class="chip ${option.id === sort ? 'is-on' : ''}" type="button">${option.label}</button>`;
      chip.addEventListener('click', () => {
        sort = option.id;
        paintSortBar();
        history.replaceState(
          null,
          '',
          `#/user/${encodeURIComponent(user.username)}?tab=${active}&sort=${sort}`
        );
        // 换排序等于换了一份列表，页码必须归零
        mountContent(0);
      });
      sortBar.append(chip);
    }
  }

  function paintTabs() {
    tabBar.replaceChildren();
    for (const tab of TABS) {
      const chip = tpl`<button class="chip ${tab.id === active ? 'is-on' : ''}" type="button">${icon(tab.icon)}<span>${tab.label}</span></button>`;
      chip.addEventListener('click', () => {
        active = tab.id;
        paintTabs();
        paintSortBar();
        // 切标签时回到第 1 页：否则上一栏的页码会串到新的一栏。
        history.replaceState(null, '', `#/user/${encodeURIComponent(user.username)}?tab=${active}`);
        mountContent(0);
      });
      tabBar.append(chip);
    }
  }

  // 切标签会连续调用，用一个序号让旧的请求结果不再写 DOM。
  let mountSeq = 0;

  /**
   * 渲染当前标签的内容。
   *
   * `page` 显式传入：切标签/切排序时传 0，首次渲染时才从地址里读。
   * 早期版本在函数内部直接读 ctx.query，但切标签走的是 history.replaceState
   * （不重新走路由渲染），ctx.query 永远是旧的，于是"在视频第 3 页切到图库"
   * 会去要图库的第 3 页，通常就是空白。
   */
  function mountContent(page = pageFromQuery(ctx.query)) {
    const seq = ++mountSeq;
    content.replaceChildren();

    const tabPage = page;

    if (active === 'videos' || active === 'images') {
      const isImage = active === 'images';
      feed = renderPagedFeed({
        page: tabPage,
        kind: isImage ? 'image' : 'video',
        hrefFor: (target) =>
          `#/user/${encodeURIComponent(user.username)}?tab=${active}&sort=${sort}&page=${target + 1}`,
        emptyTitle: isImage ? '这位作者还没有图库作品' : '这位作者还没有视频作品',
        emptyMessage: '换到另一个标签看看，或者去首页按标签找找。',
        fetchPage: async (target, limit) => {
          const params = { user: user.id, page: target, limit, sort, rating: ratingParam() };
          const data = isImage ? await fetchImages(params) : await fetchVideos(params);
          if (target === 0 && seq === mountSeq) worksStat.textContent = formatCount(data?.count);
          return data;
        }
      });
      content.append(feed);
      return;
    }

    if (active === 'playlists') {
      feed = renderPagedFeed({
        page: tabPage,
        hrefFor: (target) =>
          `#/user/${encodeURIComponent(user.username)}?tab=playlists&page=${target + 1}`,
        render: (item) => playlistCard(item),
        emptyTitle: '这位作者还没有公开的播放列表',
        emptyMessage: '作者没整理合集，直接看作品列表也是一样的。',
        fetchPage: async (target, limit) => {
          try {
            return await fetchPlaylists({ user: user.id, page: target, limit });
          } catch {
            // 上游不支持按作者过滤时退化成公开列表。
            return fetchPlaylists({ page: target, limit });
          }
        }
      });
      content.append(feed);
      return;
    }

    const target = active === 'followers' ? followersStat : followingStat;
    feed = renderPagedFeed({
      page: tabPage,
      columns: 'grid--people',
      hrefFor: (page) =>
        `#/user/${encodeURIComponent(user.username)}?tab=${active}&page=${page + 1}`,
      // 上游的关系列表不是裸用户：粉丝是 { id, createdAt, follower: {...} }，
      // 关注是 { id, createdAt, user: {...} }。直接渲染外层就成了"匿名"。
      render: (item) => personCard(item.follower || item.user || item),
      emptyTitle: active === 'followers' ? '还没有粉丝' : '还没有关注任何人',
      emptyMessage: '这一栏会随着作者在 Iwara 上的互动变化。',
      limit: 30,
      fetchPage: async (page, limit) => {
        const fetcher = active === 'followers' ? fetchFollowers : fetchFollowing;
        const data = await fetcher(user.id, { page, limit });
        if (page === 0 && seq === mountSeq) target.textContent = formatCount(data?.count);
        return data;
      }
    });
    content.append(feed);
  }

  paintTabs();
  paintSortBar();
  mountContent();

  // 关注数单独拉一次，用来填头部统计（作品数由首个 feed 填充）。
  (async () => {
    try {
      const data = await fetchFollowing(user.id, { page: 0, limit: 1 });
      followingStat.textContent = formatCount(data?.count);
    } catch {
      followingStat.textContent = '—';
    }
  })();
  (async () => {
    try {
      const data = await fetchFollowers(user.id, { page: 0, limit: 1 });
      followersStat.textContent = formatCount(data?.count);
    } catch {
      followersStat.textContent = '—';
    }
  })();

  const meta = tpl`
    <p class="desc" style="margin-top:-6px">
      ${user.createdAt ? `加入于 ${formatDate(user.createdAt)} · ` : ''}主页：<a href="https://www.iwara.tv/profile/${encodeURIComponent(user.username || '')}" target="_blank" rel="noopener noreferrer">iwara.tv/profile/${user.username || ''}</a>
    </p>`;

  return tpl`<div>${head}${meta}${bodyPanel}${tabBar}${sortBar}${content}</div>`;
}
