/**
 * 极简哈希路由。
 *
 * 视图契约：每个路由处理器是 `async (ctx, params) => Node`，
 * ctx = { query: URLSearchParams, params, navigate, onCleanup, signal }。
 * 处理器可以用 ctx.onCleanup(fn) 注册离开时的收尾逻辑（例如把视频交给迷你播放器）。
 */

const routes = [];
let currentCleanups = [];
let currentController = null;
let renderToken = 0;
let fallbackHandler = null;
let beforeEach = null;
let onAfterRender = null;
// popstate 时要把记录下来的滚动位置带进下一次 render
let pendingScrollRestore = null;
// 上一次真正渲染的 hash：popstate 时用来判断是否需要在原地重渲染
let lastRenderedHash = '';

function compile(pattern) {
  const names = [];
  const source = pattern
    .replace(/\/$/, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
  return { regex: new RegExp(`^${source || '/'}/?$`), names };
}

export function route(pattern, handler) {
  routes.push({ ...compile(pattern), pattern, handler });
  return api;
}

export function setFallback(handler) {
  fallbackHandler = handler;
  return api;
}

export function setBeforeEach(fn) {
  beforeEach = fn;
  return api;
}

export function setAfterRender(fn) {
  onAfterRender = fn;
  return api;
}

export function parseHash(hash = location.hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/';
  const [path, queryString] = raw.split('?');
  return {
    path: path || '/',
    query: new URLSearchParams(queryString || '')
  };
}

export function navigate(to, { replace = false } = {}) {
  const target = to.startsWith('#') ? to : `#${to}`;
  if (location.hash === target) return;
  // 离开当前视图前先把滚动位置记到当前 history 条目上，
  // 这样用户点"返回"能回到原来的位置。
  if (!replace) rememberScroll();
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
}

function match(path) {
  for (const entry of routes) {
    const result = entry.regex.exec(path);
    if (!result) continue;
    const params = {};
    entry.names.forEach((name, index) => {
      params[name] = decodeURIComponent(result[index + 1]);
    });
    return { entry, params };
  }
  return null;
}

async function render() {
  const token = ++renderToken;
  const { path, query } = parseHash();

  // 上一屏作废：先中止它的异步任务，再跑收尾逻辑
  //（否则「加载中就被切走」的视图会在后台继续建播放器）。
  if (currentController) currentController.abort();
  for (const cleanup of currentCleanups.splice(0)) {
    try {
      cleanup();
    } catch (error) {
      console.error('cleanup failed', error);
    }
  }

  const matched = match(path);
  const mount = document.getElementById('view');
  const controller = new AbortController();
  currentController = controller;
  const cleanups = [];
  const ctx = {
    query,
    path,
    navigate,
    signal: controller.signal,
    onCleanup: (fn) => {
      if (typeof fn === 'function') cleanups.push(fn);
    }
  };
  currentCleanups = cleanups;

  if (beforeEach) await beforeEach(ctx, matched?.params || {});

  // 渲染是异步的（要等接口），先给个明确的"正在切换"状态，
  // 否则点了翻页之后界面纹丝不动，看起来像没反应。
  mount.classList.add('is-loading');
  document.documentElement.dataset.route = matched?.entry.pattern || '404';
  updateNavHighlight(path);

  let node;
  try {
    if (!matched) {
      node = fallbackHandler ? await fallbackHandler(ctx, {}) : document.createTextNode('404');
    } else {
      node = await matched.entry.handler(ctx, matched.params);
    }
  } catch (error) {
    console.error('render failed', error);
    mount.classList.remove('is-loading');
    node = errorNode(error, () => render());
  }

  if (token !== renderToken) {
    controller.abort();
    return;
  }

  mount.classList.remove('is-loading');
  if (node instanceof Node) mount.replaceChildren(node);
  else mount.replaceChildren(document.createTextNode(String(node ?? '')));

  mount.focus({ preventScroll: true });

  // 返回上一页时恢复原来的滚动位置，其余情况回到顶部。
  // 这个站的核心用法是「刷列表 → 点进去看 → 返回继续刷」，
  // 每次返回都跳回顶部会让人找不到刚才看到哪。
  const restoreTo = pendingScrollRestore;
  pendingScrollRestore = null;
  if (restoreTo !== null) {
    restoreScroll(restoreTo);
  } else {
    scrollToTop();
  }

  lastRenderedHash = location.hash;
  onAfterRender?.(ctx);
}

/**
 * 回到页面顶部。
 *
 * 只调一次 scrollTo(0,0) 不够：翻页时浏览器会尝试恢复它记住的滚动位置，
 * 而且新内容还没布局完，滚动会被后续的 reflow 抵消。
 * 所以这里连做三次（立刻 + 下一帧 + 稍后），并用 instant 避免平滑滚动打断。
 */
/**
 * 记录当前滚动位置并挂到 history 条目上。
 *
 * 每次导航前调用：这样点"返回"时 popstate 读到的就是离开时的位置。
 */
function rememberScroll() {
  const y = window.scrollY || 0;
  const state = { ...(history.state || {}), scrollY: y };
  try {
    history.replaceState(state, '', location.href);
  } catch {
    /* 某些浏览器在受限状态下会抛错，忽略即可 */
  }
}

/** 还原滚动位置。要等布局稳定，否则页面还没长到那个高度，scrollTo 会被夹断。 */
function restoreScroll(y) {
  const apply = () => window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
  // 列表图片陆续撑开高度后可能又不够高，稍后再补一次
  setTimeout(apply, 120);
}

function scrollToTop() {
  const toTop = () => window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  toTop();
  requestAnimationFrame(() => {
    toTop();
    requestAnimationFrame(toTop);
  });
  setTimeout(toTop, 60);
}

function updateNavHighlight(path) {
  const root = path === '/' ? 'home' : path.split('/')[1];
  for (const link of document.querySelectorAll('#topnav a')) {
    const key = link.dataset.nav;
    const active =
      key === root ||
      (key === 'images' && (root === 'images' || root === 'image')) ||
      (key === 'forum' && (root === 'forum' || root === 'posts'));
    link.classList.toggle('is-active', active);
  }
}

function errorNode(error, retry) {
  const wrapper = document.createElement('div');
  wrapper.className = 'state';
  const title = document.createElement('div');
  title.className = 'state__title';
  title.textContent = '页面加载失败';
  const message = document.createElement('p');
  message.textContent = error?.message || '请稍后重试。';
  const button = document.createElement('button');
  button.className = 'btn btn--sm';
  button.type = 'button';
  button.textContent = '重试';
  button.addEventListener('click', retry);
  wrapper.append(title, message, button);
  return wrapper;
}

const api = {
  route,
  setFallback,
  setBeforeEach,
  setAfterRender,
  navigate,
  parseHash,
  start() {
    window.addEventListener('hashchange', render);

    // 浏览器前进/后退：取回该条目记录的滚动位置，render 完成后还原。
    window.addEventListener('popstate', () => {
      const y = history.state?.scrollY;
      pendingScrollRestore = typeof y === 'number' ? y : null;
      // popstate 之后浏览器自己也会触发 hashchange（hash 路由），渲染在那里发生。
      // 若 hash 没变（同一视图内），主动渲染一次。
      if (!location.hash || location.hash === lastRenderedHash) render();
    });

    if (!location.hash) history.replaceState(null, '', '#/');
    return render();
  },
  reload: render
};

export default api;
