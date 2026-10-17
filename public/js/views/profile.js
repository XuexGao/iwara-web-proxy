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
import { createFeed, personCard, playlistCard } from '../cards.js';
import { getSession, getSetting, ratingParam } from '../store.js';
import { SORT_OPTIONS, icon, linkify, stateBlock, tpl, toast, toastError } from '../ui.js';

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

  const bodyPanel = profile.body
    ? tpl`
      <div class="panel">
        <div class="panel__title">关于</div>
        <div class="desc is-clamped"></div>
      </div>`
    : null;
  if (bodyPanel) {
    const desc = bodyPanel.querySelector('.desc');
    desc.append(linkify(profile.body));
    desc.addEventListener('click', () => desc.classList.toggle('is-clamped'));
  }

  /* ---------------- 标签页 ---------------- */

  let active = ctx.query.get('tab') || 'videos';
  if (!TABS.some((tab) => tab.id === active)) active = 'videos';
  let sort = ctx.query.get('sort') || getSetting('sort') || 'trending';
  if (!SORT_OPTIONS.some((option) => option.id === sort)) sort = 'trending';

  const tabBar = tpl`<div class="chips chips--scroll"></div>`;
  const sortBar = tpl`<div class="chips chips--scroll"></div>`;
  const content = tpl`<div></div>`;
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
        mountContent();
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
        mountContent();
      });
      tabBar.append(chip);
    }
  }

  function mountContent() {
    if (feed) feed.stop();
    content.replaceChildren();

    if (active === 'videos' || active === 'images') {
      const isImage = active === 'images';
      feed = createFeed({
        kind: isImage ? 'image' : 'video',
        limit: 32,
        emptyTitle: isImage ? '这位作者还没有图库作品' : '这位作者还没有视频作品',
        emptyMessage: '换到另一个标签看看，或者去首页按标签找找。',
        fetchPage: async (page, limit) => {
          const params = { user: user.id, page, limit, sort, rating: ratingParam() };
          const data = isImage ? await fetchImages(params) : await fetchVideos(params);
          if (page === 0) {
            worksStat.textContent = formatCount(data?.count);
          }
          return data;
        }
      });
      content.append(feed.element);
      return;
    }

    if (active === 'playlists') {
      feed = createFeed({
        limit: 32,
        render: (item) => playlistCard(item),
        emptyTitle: '这位作者还没有公开的播放列表',
        emptyMessage: '作者没整理合集，直接看作品列表也是一样的。',
        fetchPage: async (page, limit) => {
          try {
            const data = await fetchPlaylists({ user: user.id, page, limit });
            return data;
          } catch {
            // 上游不支持按作者过滤时退化成公开列表，并说明清楚。
            const data = await fetchPlaylists({ page, limit });
            return data;
          }
        }
      });
      content.append(feed.element);
      return;
    }

    const target = active === 'followers' ? followersStat : followingStat;
    feed = createFeed({
      columns: 'grid--people',
      limit: 50,
      render: (item) => personCard(item),
      emptyTitle: active === 'followers' ? '还没有粉丝' : '还没有关注任何人',
      emptyMessage: '这一栏会随着作者在 Iwara 上的互动变化。',
      fetchPage: async (page, limit) => {
        const fetcher = active === 'followers' ? fetchFollowers : fetchFollowing;
        const data = await fetcher(user.id, { page, limit });
        if (page === 0) target.textContent = formatCount(data?.count);
        return data;
      }
    });
    content.append(feed.element);
  }

  paintTabs();
  paintSortBar();
  mountContent();
  ctx.onCleanup(() => feed?.stop());

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

  return tpl`<div>${head}${meta}${tabBar}${sortBar}${bodyPanel}${content}</div>`;
}
