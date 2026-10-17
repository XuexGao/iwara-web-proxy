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
  limit: 32
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

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式下写不进去，忽略 */
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
 * 会话
 * ------------------------------------------------------------------ */

let session = { ready: false, authenticated: false, user: null, loginEnabled: false };
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
  try {
    const response = await fetch('/api/auth/config');
    const data = await response.json();
    session = { ...session, loginEnabled: !!data.loginEnabled, sharedToken: !!data.sharedToken };
    emitSession();
  } catch {
    /* 忽略 */
  }
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

export function getHistory() {
  const list = readJson(KEY_HISTORY, []);
  return Array.isArray(list) ? list : [];
}

export function recordHistory(entry) {
  const list = getHistory().filter((item) => item.id !== entry.id);
  list.unshift({ ...entry, watchedAt: Date.now() });
  writeJson(KEY_HISTORY, list.slice(0, 240));
}

export function clearHistory() {
  writeJson(KEY_HISTORY, []);
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
