/**
 * 本地状态：设置、会话缓存、观看历史与续播位置。
 * 全部存在 localStorage，不上传；Token 只走服务端加密 Cookie。
 */

const KEY_SETTINGS = 'iwara.settings.v1';
const KEY_HISTORY = 'iwara.history.v1';
const KEY_RESUME = 'iwara.resume.v1';

const DEFAULT_SETTINGS = {
  /** 显示 R18/ecchi 内容；关闭后只请求 general。 */
  r18: true,
  /** 卡片悬停播放预览。 */
  hoverPreview: true,
  /** 打开播放页自动播放。 */
  autoplay: true,
  /** 播放结束自动连播相关作品。 */
  autonext: true,
  /** 记住的清晰度档位名，例如 Source / 540。 */
  quality: 'auto',
  /** 播放器音量与静音。 */
  volume: 1,
  muted: false,
  /** 首页默认排序。 */
  sort: 'trending',
  /** 高级：自带 Token，直接透传给上游。 */
  token: '',
  /** 列表每页数量。 */
  limit: 32,
  /** 配色：system 跟随系统，dark 深色，light 浅色。 */
  theme: 'system'
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 存储是否可用。隐私模式、被禁用的站点数据、配额用尽都会让它变成 false。
 * 历史"存不下来"最常见的原因就在这里，所以要把状态暴露出去，
 * 而不是静默吞掉。
 */
let storageState = { ok: true, reason: '' };

/**
 * 读一个标量字符串设置。
 *
 * 主题这类存的就是 'dark' 这种裸字符串：用 readJson 会因为"不是对象"
 * 被当成没有值。这里同时兼容历史上写成 JSON 字符串（带引号）的存法，
 * 老用户不会丢设置。
 */
function readScalar(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    if (raw.startsWith('"')) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string') return parsed;
      } catch {
        /* 落回原值 */
      }
    }
    return raw;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    storageState = { ok: true, reason: '' };
  } catch (error) {
    storageState = {
      ok: false,
      reason:
        error?.name === 'QuotaExceededError'
          ? '浏览器存储空间已满'
          : '浏览器不允许本站写入本地存储（可能处于无痕模式）'
    };
  }
}

/** 探测一次存储可用性。 */
export function getStorageState() {
  if (!storageState.ok) return storageState;
  try {
    const probe = '__iwara_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return { ok: true, reason: '' };
  } catch (error) {
    storageState = {
      ok: false,
      reason:
        error?.name === 'QuotaExceededError'
          ? '浏览器存储空间已满'
          : '浏览器不允许本站写入本地存储（可能处于无痕模式）'
    };
    return storageState;
  }
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

let settings = { ...DEFAULT_SETTINGS, ...readJson(KEY_SETTINGS, {}) };
const settingsListeners = new Set();

export function getSettings() {
  return { ...settings };
}

export function getSetting(key) {
  return settings[key];
}

export function setSetting(key, value) {
  settings = { ...settings, [key]: value };
  writeJson(KEY_SETTINGS, settings);
  for (const listener of settingsListeners) listener(key, value);
}

export function onSettingChange(listener) {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

/** 请求里该带的 rating 参数。 */
export function ratingParam() {
  return settings.r18 ? 'all' : 'general';
}

/** 高级用法：请求方自带 Token。 */
export function customToken() {
  return String(settings.token || '').trim();
}

/* ------------------------------------------------------------------ *
 * 主题
 * ------------------------------------------------------------------ */

const THEME_KEY = 'iwara.theme.v1';
const media = window.matchMedia('(prefers-color-scheme: light)');

/** 解析某条设置实际该用的配色（system 交给系统判断）。 */
function resolvedTheme(value) {
  if (value === 'light') return 'light';
  if (value === 'dark') return 'dark';
  return media.matches ? 'light' : 'dark';
}

export function applyTheme() {
  const value = settings.theme || 'system';
  const resolved = resolvedTheme(value);
  document.documentElement.dataset.theme = resolved;
  // 让地址栏/状态栏跟着变，移动端观感差别很大。
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#f6f2ec' : '#100d16');
  return resolved;
}

export function setTheme(value) {
  const next = ['system', 'dark', 'light'].includes(value) ? value : 'system';
  setSetting('theme', next);
  // 单独存一份裸字符串，给首帧前那个轻量脚本用（它不该依赖整个 store）。
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* 存不下就不存，settings 里那份还在 */
  }
  applyTheme();
  return next;
}

export function getTheme() {
  return settings.theme || 'system';
}

// 跟随系统时，用户切了系统主题要立刻响应。
media.addEventListener('change', () => {
  if ((settings.theme || 'system') === 'system') applyTheme();
});

/** 在首帧之前就跑一次，避免浅色主题下闪一下深色。 */
export function bootstrapTheme() {
  // ⚠️ 必须用 readScalar：主题存的是 'dark' 这种裸字符串，
  // 之前用 readJson 读会把非对象结果一律当成 null，
  // 于是保存过的主题在下次启动时被忽略、默默退回跟随系统。
  const saved = readScalar(THEME_KEY, null);
  if (saved === 'light' || saved === 'dark' || saved === 'system') {
    settings = { ...settings, theme: saved };
  }
  applyTheme();
}

/* ------------------------------------------------------------------ *
 * 会话
 * ------------------------------------------------------------------ */

let session = {
  ready: false,
  authenticated: false,
  user: null,
  loginEnabled: false,
  gateRequired: false
};
const sessionListeners = new Set();

export function getSession() {
  return session;
}

export function onSessionChange(listener) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function emitSession() {
  for (const listener of sessionListeners) listener(session);
}

async function authRequest(path, init) {
  const response = await fetch(path, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || `请求失败（${response.status}）`);
  }
  return data;
}

export async function refreshSession() {
  try {
    const data = await authRequest('/api/auth/me');
    session = {
      ready: true,
      authenticated: !!data.authenticated,
      user: data.user || null,
      loginEnabled: !!data.loginEnabled,
      tokenKind: data.tokenKind
    };
  } catch {
    session = { ready: true, authenticated: false, user: null, loginEnabled: session.loginEnabled };
  }
  emitSession();
  return session;
}

export async function loadAuthConfig() {
  const [auth, gate] = await Promise.all([
    fetch('/api/auth/config')
      .then((response) => response.json())
      .catch(() => null),
    fetch('/api/gate/status')
      .then((response) => response.json())
      .catch(() => null)
  ]);
  session = {
    ...session,
    loginEnabled: !!auth?.loginEnabled,
    sharedToken: !!auth?.sharedToken,
    gateRequired: !!gate?.required
  };
  emitSession();
}

/** 退出站点访问密码（下次访问需要重新输入）。 */
export async function gateLogout() {
  await authRequest('/api/gate/logout', { method: 'POST' }).catch(() => null);
  location.reload();
}

export async function login(email, password) {
  const data = await authRequest('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  await refreshSession();
  return data;
}

export async function loginWithToken(token) {
  const data = await authRequest('/api/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
  if (data.token) setSetting('token', data.token);
  await refreshSession();
  return data;
}

export async function logout() {
  try {
    await authRequest('/api/auth/logout', { method: 'POST' });
  } catch {
    /* 即使失败也把本地态清掉 */
  }
  setSetting('token', '');
  await refreshSession();
}

/* ------------------------------------------------------------------ *
 * 观看历史与续播
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 观看历史
 *
 * 写两份：localStorage（同步、读取快）和 IndexedDB（容量大、
 * 不容易被浏览器的存储清理策略连坐清掉）。读取时以 localStorage 为准，
 * 缺失则回落到 IndexedDB——隐私模式下 localStorage 可能直接抛异常，
 * 那时 IndexedDB 往往还能写。
 * ------------------------------------------------------------------ */

const IDB_NAME = 'iwara-web';
const IDB_STORE = 'history';
let idbPromise = null;

function openIdb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve) => {
    try {
      if (!('indexedDB' in window)) return resolve(null);
      const request = indexedDB.open(IDB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return idbPromise;
}

async function idbWrite(entry) {
  const db = await openIdb();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(entry);
  } catch {
    /* 写不进去也不影响 localStorage 那份 */
  }
}

async function idbReadAll() {
  const db = await openIdb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const request = tx.objectStore(IDB_STORE).getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function idbClear() {
  const db = await openIdb();
  if (!db) return;
  try {
    db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).clear();
  } catch {
    /* 忽略 */
  }
}

export function getHistory() {
  const list = readJson(KEY_HISTORY, []);
  return Array.isArray(list) ? list : [];
}

/**
 * 读历史。localStorage 为空时尝试从 IndexedDB 恢复——
 * 浏览器清理了 localStorage 也能把记录捞回来。
 */
export async function loadHistory() {
  const local = getHistory();
  if (local.length) return local;
  const restored = await idbReadAll();
  if (!restored.length) return [];
  const sorted = restored
    .filter((item) => item && item.id)
    .sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0))
    .slice(0, 240);
  writeJson(KEY_HISTORY, sorted);
  return sorted;
}

export function recordHistory(entry) {
  const record = { ...entry, watchedAt: Date.now() };
  const list = getHistory().filter((item) => item.id !== entry.id);
  list.unshift(record);
  writeJson(KEY_HISTORY, list.slice(0, 240));
  idbWrite(record);
}

export function clearHistory() {
  writeJson(KEY_HISTORY, []);
  idbClear();
}

async function idbDelete(id) {
  const db = await openIdb();
  if (!db) return;
  try {
    db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).delete(id);
  } catch {
    /* 忽略 */
  }
}

/** 删除单条历史。 */
export function removeHistory(id) {
  writeJson(
    KEY_HISTORY,
    getHistory().filter((item) => item.id !== id)
  );
  idbDelete(id);
}

function readResume() {
  const map = readJson(KEY_RESUME, {});
  return map && !Array.isArray(map) ? map : {};
}

export function getResume(videoId) {
  const value = readResume()[videoId];
  return Number(value) > 3 ? Number(value) : 0;
}

let resumeTimer = 0;
export function saveResume(videoId, seconds, duration) {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    const map = readResume();
    // 快看完了就当看完了，下次从头开始。
    if (duration > 0 && seconds / duration > 0.96) delete map[videoId];
    else map[videoId] = Math.floor(seconds);
    const keys = Object.keys(map);
    if (keys.length > 400) {
      for (const key of keys.slice(0, keys.length - 400)) delete map[key];
    }
    writeJson(KEY_RESUME, map);
  }, 1200);
}
