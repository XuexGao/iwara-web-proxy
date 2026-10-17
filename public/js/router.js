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
    node = errorNode(error, () => render());
  }

  if (token !== renderToken) {
    controller.abort();
    return;
  }

  if (node instanceof Node) mount.replaceChildren(node);
  else mount.replaceChildren(document.createTextNode(String(node ?? '')));

  mount.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  onAfterRender?.(ctx);
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
    if (!location.hash) history.replaceState(null, '', '#/');
    return render();
  },
  reload: render
};

export default api;
