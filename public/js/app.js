/**
 * 应用引导：路由注册、顶栏交互、会话状态。
 */

import { avatarUrl } from './api.js';
import { stopAllPreviews } from './cards-preview.js';
import { playback } from './player.js';
import { routeFromInput } from './links.js';
import router from './router.js';
import {
  bootstrapTheme,
  getSetting,
  getSession,
  getTheme,
  gateLogout,
  loadAuthConfig,
  logout,
  onSessionChange,
  onSettingChange,
  refreshSession,
  setSetting,
  setTheme
} from './store.js';
import { icon, iconNode, toast, tpl } from './ui.js';

import { renderHome } from './views/home.js';
import { renderWatch } from './views/watch.js';
import { renderSearch } from './views/search.js';
import { renderTag } from './views/tags.js';
import { renderGallery, renderImages, renderPlaylist, renderPlaylists } from './views/gallery.js';
import { renderProfile } from './views/profile.js';
import { renderSubscriptions } from './views/subscriptions.js';
import { renderFollowing } from './views/following.js';
import { renderForum, renderForumCategory, renderForumThread, renderPosts } from './views/forum.js';
import { renderAbout, renderLibrary, renderSettings } from './views/library.js';
import { renderLogin } from './views/login.js';

/* ------------------------------------------------------------------ *
 * 路由表
 * ------------------------------------------------------------------ */

router
  .route('/', renderHome)
  .route('/search', renderSearch)
  .route('/tag/:id', renderTag)
  .route('/subscriptions', renderSubscriptions)
  .route('/library/following', renderFollowing)
  .route('/images', renderImages)
  .route('/image/:id', renderGallery)
  .route('/playlists', renderPlaylists)
  .route('/playlist/:id', renderPlaylist)
  .route('/video/:id', renderWatch)
  .route('/user/:username', renderProfile)
  .route('/forum', renderForum)
  .route('/forum/:category', renderForumCategory)
  .route('/forum/:category/:threadId', renderForumThread)
  .route('/posts', renderPosts)
  .route('/library/:kind', renderLibrary)
  .route('/settings', renderSettings)
  .route('/about', renderAbout)
  .route('/login', renderLogin)
  .setFallback((ctx) =>
    tpl`
      <div class="state">
        <div class="state__title">这个地址不存在</div>
        <p>检查一下链接，或者回到首页重新找。</p>
        <a class="btn btn--sm" href="#/">回到首页</a>
      </div>`
  )
  .setBeforeEach(() => {
    stopAllPreviews();
  });

/* ------------------------------------------------------------------ *
 * 顶栏
 * ------------------------------------------------------------------ */

const searchForm = document.getElementById('global-search');
const searchInput = document.getElementById('global-search-input');

searchForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;

  // 粘的是 Iwara 链接就直接跳到对应页面，而不是拿整串去搜索——
  // 那种关键词永远搜不到东西。
  const route = routeFromInput(query);
  if (route) {
    searchInput.value = '';
    router.navigate(route);
    toast('已打开链接对应的页面');
    return;
  }

  router.navigate(`/search?q=${encodeURIComponent(query)}`);
});

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  if (event.key === '/' && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    searchInput?.focus();
  }
});

const accountButton = document.getElementById('account-button');
const accountPanel = document.getElementById('account-panel');

accountButton?.addEventListener('click', (event) => {
  event.stopPropagation();
  const open = accountPanel.hidden;
  accountPanel.hidden = !open;
  accountButton.setAttribute('aria-expanded', String(open));
});

document.addEventListener('click', () => {
  if (accountPanel && !accountPanel.hidden) {
    accountPanel.hidden = true;
    accountButton?.setAttribute('aria-expanded', 'false');
  }
});

accountPanel?.addEventListener('click', (event) => event.stopPropagation());

document.getElementById('logout-button')?.addEventListener('click', async () => {
  await logout();
  accountPanel.hidden = true;
  router.navigate('/');
  router.reload();
});

/* ------------------------------------------------------------------ *
 * 主题切换
 * ------------------------------------------------------------------ */

const themeButton = document.getElementById('theme-button');

function paintThemeButton() {
  if (!themeButton) return;
  const mode = getTheme();
  const resolved = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

  // 跟随系统时用一个「自动」图标（太阳月亮同时出现），明确区分于手动锁定。
  const iconName = mode === 'system' ? 'contrast' : resolved === 'light' ? 'sun' : 'moon';
  themeButton.innerHTML = `<svg class="icon"><use href="#i-${iconName}"/></svg>`;

  const label =
    mode === 'system'
      ? `跟随系统（当前${resolved === 'light' ? '浅色' : '深色'}），点击锁定为深色`
      : mode === 'dark'
        ? '已锁定深色，点击切到浅色'
        : '已锁定浅色，点击改为跟随系统';
  themeButton.title = label;
  themeButton.setAttribute('aria-label', label);
  // 只在跟随系统时给一点视觉提示
  themeButton.classList.toggle('is-auto', mode === 'system');
}

// 三态循环：跟随系统 → 深色 → 浅色 → 跟随系统。
// 两态循环的问题是：用户点过一次就再也回不到"跟随系统"了。
const THEME_CYCLE = ['system', 'dark', 'light'];

themeButton?.addEventListener('click', () => {
  const current = getTheme();
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
  setTheme(next);
  paintThemeButton();
  if (next === 'system') {
    const resolved = document.documentElement.dataset.theme === 'light' ? '浅色' : '深色';
    toast(`已改为跟随系统（当前${resolved}）`);
  } else {
    toast(next === 'dark' ? '已锁定深色' : '已锁定浅色');
  }
});

// 设置页改动配色时同步按钮图标，避免两处各写一套 DOM 操作。
onSettingChange((key) => {
  if (key === 'theme') paintThemeButton();
});

// 系统主题变化时（theme=system）同步按钮图标。
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', paintThemeButton);

/* ------------------------------------------------------------------ *
 * 会话渲染
 * ------------------------------------------------------------------ */

function renderAccount(session) {
  const nameNode = document.getElementById('account-name');
  const avatarNode = document.getElementById('account-avatar');
  const head = document.getElementById('account-head');
  const logoutButton = document.getElementById('logout-button');
  const loginLink = document.getElementById('login-link');

  if (session.authenticated && session.user) {
    nameNode.textContent = session.user.name || session.user.username || '已登录';
    avatarNode.replaceChildren(
      tpl`<img src="${avatarUrl(session.user)}" alt="" />`
    );
    head.replaceChildren(
      tpl`<strong>${session.user.name || session.user.username}</strong><span>@${session.user.username || ''}</span>`
    );
    logoutButton.hidden = false;
    loginLink.hidden = true;
  } else {
    nameNode.textContent = '未登录';
    avatarNode.replaceChildren(iconNode('user'));
    // 配置还没回来时（首屏第一帧）不要说"本实例未开放登录"——
    // 那句话是错的，会在每次加载时闪一下。先给中性文案。
    const sub = !session.ready
      ? '正在读取站点配置…'
      : session.loginEnabled
        ? '登录后可搜索、收藏与评论'
        : '本实例未开放登录';
    head.replaceChildren(
      tpl`<strong>未登录</strong><span>${sub}</span>`
    );
    logoutButton.hidden = true;
    loginLink.hidden = !session.loginEnabled;
  }

  // 站点密码开启时，菜单里给一个明确的「退出站点」入口。
  let gateButton = document.getElementById('gate-logout-button');
  if (!gateButton && session.gateRequired) {
    gateButton = tpl`<button role="menuitem" id="gate-logout-button" type="button">
      ${icon('logout')}退出站点
    </button>`;
    gateButton.addEventListener('click', () => gateLogout());
    document.getElementById('account-panel')?.append(gateButton);
  } else if (gateButton) {
    gateButton.hidden = !session.gateRequired;
  }
}

onSessionChange(renderAccount);

/* ------------------------------------------------------------------ *
 * 离开页面前：把正在播放的视频交给迷你播放器
 * ------------------------------------------------------------------ */

window.addEventListener('beforeunload', () => {
  if (playback.video && !playback.video.paused) {
    // 浏览器会阻止后台播放，这里只记录进度。
    setSetting('volume', playback.video.volume);
  }
});

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

(async function boot() {
  bootstrapTheme();
  paintThemeButton();
  renderAccount(getSession());
  // 先拿站点配置（登录是否可用、有没有共享 Token），再取会话。
  // 两者都改同一个 session 对象，顺序执行最不容易出意外；
  // 并发虽然现在也安全（合并写入），但没必要留隐患。
  await loadAuthConfig();
  await refreshSession();
  await router.start();
})();

export { playback };
