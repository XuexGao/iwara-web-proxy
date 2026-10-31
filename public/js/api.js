/**
 * 接口客户端与媒体地址构造。
 *
 * 上游数据结构原样透传，这里只做三件事：
 *   1. 拼 `/api/iwara/...` 并把错误翻译成可展示的中文；
 *   2. 把 Iwara 的 file 对象（id + name）翻译成本站 /media 地址；
 *   3. 提供带缓存的视频源查询（hover 预览与播放器共用）。
 */

const BASE = '/api/iwara';

import { customToken } from './store.js';

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

function messageFrom(status, payload) {
  const upstream = String(payload?.message || '');
  if (status === 401) return '需要登录后才能使用这个功能。';
  if (status === 403) return 'Iwara 拒绝了这次请求，稍后再试。';
  if (status === 404) return '没有找到这个内容，可能已被删除。';
  if (status === 429) return '请求过于频繁，请稍后再试。';
  if (upstream === 'errors.serverError') return 'Iwara 服务端返回错误。';
  if (upstream) return upstream;
  return payload?.error || `请求失败（${status}）`;
}

/**
 * 调用 Iwara 接口。
 * @param {string} path 例如 '/videos'
 * @param {{params?: object, method?: string, body?: any, site?: string, fresh?: boolean}} options
 */
/** 当前 hash 路由里的 _site 参数（没有就返回空串）。 */
function siteFromLocation() {
  const hash = typeof location === 'undefined' ? '' : location.hash || '';
  const index = hash.indexOf('?');
  if (index < 0) return '';
  return new URLSearchParams(hash.slice(index + 1)).get('_site') || '';
}

export async function iwara(path, options = {}) {
  const { params, method = 'GET', body, site, fresh } = options;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  // 站点选择：调用方没显式指定时，看当前路由的 _site 参数。
  // 这样从 iwara.ai 链接跳进来的页面（/video/xxx?_site=ai）后续请求都对得上，
  // 不需要每个视图都传一遍。
  const resolvedSite = site || siteFromLocation();
  if (resolvedSite) search.set('_site', resolvedSite);
  const query = search.toString();

  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (fresh) headers['X-No-Cache'] = '1';
  // 高级用法：用户自带 Token 时直接透传，不使用服务端会话。
  const inlineToken = customToken();
  if (inlineToken) headers['X-Iwara-Token'] = inlineToken;

  let response;
  try {
    response = await fetch(`${BASE}${path}${query ? `?${query}` : ''}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError('网络连接失败，请检查网络后重试。', 0, null);
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text.slice(0, 200) };
  }

  if (!response.ok) throw new ApiError(messageFrom(response.status, payload), response.status, payload);
  return payload;
}

/* ------------------------------------------------------------------ *
 * 常用接口
 * ------------------------------------------------------------------ */

export const fetchVideos = (params) => iwara('/videos', { params });
export const fetchVideo = (id) => iwara(`/video/${encodeURIComponent(id)}`);
export const fetchRelated = (id, params) => iwara(`/video/${encodeURIComponent(id)}/related`, { params });
export const fetchComments = (type, id, params) => iwara(`/${type}/${encodeURIComponent(id)}/comments`, { params });
export const fetchImages = (params) => iwara('/images', { params });
export const fetchImage = (id) => iwara(`/image/${encodeURIComponent(id)}`);
export const fetchTags = (params) => iwara('/tags', { params });
export const fetchTag = (id) => iwara(`/tags/${encodeURIComponent(id)}`);
export const fetchProfile = (username) => iwara(`/profile/${encodeURIComponent(username)}`);
export const fetchFollowers = (userId, params) => iwara(`/user/${userId}/followers`, { params });
export const fetchFollowing = (userId, params) => iwara(`/user/${userId}/following`, { params });
export const fetchPlaylists = (params) => iwara('/playlists', { params });
export const fetchPlaylist = (id, params) => iwara(`/playlist/${encodeURIComponent(id)}`, { params });
export const fetchForumThreads = (params) => iwara('/forum/threads', { params });
export const fetchForumThread = (categoryId, threadId) =>
  iwara(`/forum/${encodeURIComponent(categoryId)}/${encodeURIComponent(threadId)}`);
export const fetchPosts = (params) => iwara('/posts', { params });
export const search = (params) => iwara('/search', { params });
export const fetchFavorites = (kind, params) => iwara(`/favorites/${kind}`, { params });
export const fetchNotificationCounts = () => iwara('/user/counts');
export const autocompleteUsers = (query) => iwara('/autocomplete/users', { params: { query } });
export const likeVideo = (id, on) => iwara(`/video/${id}/like`, { method: on ? 'POST' : 'DELETE' });
export const likeImage = (id, on) => iwara(`/image/${id}/like`, { method: on ? 'POST' : 'DELETE' });
export const followUser = (userId, on) =>
  iwara(`/user/${userId}/followers`, { method: on ? 'POST' : 'DELETE' });
export const postComment = (type, id, bodytext) =>
  iwara(`/${type}/${id}/comments`, { method: 'POST', body: { body: bodytext } });
export const deleteComment = (id) => iwara(`/comment/${id}`, { method: 'DELETE' });

/* ------------------------------------------------------------------ *
 * 视频源（带缓存，hover 预览会大量复用）
 * ------------------------------------------------------------------ */

const sourcesCache = new Map();
const SOURCES_TTL = 5 * 60 * 1000;
const inflight = new Map();

export function getSources(videoId, { fresh = false } = {}) {
  const cached = sourcesCache.get(videoId);
  if (!fresh && cached && Date.now() - cached.at < SOURCES_TTL) return Promise.resolve(cached.data);

  if (!fresh && inflight.has(videoId)) return inflight.get(videoId);

  const promise = (async () => {
    const response = await fetch(`/api/sources/${encodeURIComponent(videoId)}`);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(messageFrom(response.status, data), response.status, data);
    }
    sourcesCache.set(videoId, { at: Date.now(), data });
    return data;
  })().finally(() => inflight.delete(videoId));

  inflight.set(videoId, promise);
  return promise;
}

/** 只取 hover 预览用的那一档，失败时静默返回 null。 */
export async function getPreviewSource(videoId) {
  try {
    const data = await getSources(videoId);
    return data?.preview?.url || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 媒体地址
 * ------------------------------------------------------------------ */

/** 图片文件对象 -> 本站代理地址。 */
export function imageUrl(file, size = 'thumbnail') {
  if (!file?.id || !file?.name) return '';
  return `/media/i/image/${size}/${encodeURIComponent(file.id)}/${encodeURIComponent(file.name)}`;
}

const PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#1e1930"/><g fill="none" stroke="#322a49" stroke-width="1.4"><path d="M0 62l34-24 30 20 26-17 40 27"/></g><circle cx="126" cy="24" r="8" fill="#2a2242"/></svg>`
  );

export const placeholderUrl = PLACEHOLDER;

const AVATAR_FALLBACK =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#2a2242"/><circle cx="32" cy="25" r="11" fill="#4a3f6b"/><path d="M10 60c4-13 12-19 22-19s18 6 22 19z" fill="#4a3f6b"/></svg>`
  );

export const avatarFallback = AVATAR_FALLBACK;

/** 作者头像。 */
export function avatarUrl(user) {
  const avatar = user?.avatar;
  if (!avatar?.id || !avatar?.name) return AVATAR_FALLBACK;
  const name = /\.[a-z0-9]{2,5}$/i.test(avatar.name) ? avatar.name : `${avatar.name}.jpg`;
  return `/media/i/image/avatar/${encodeURIComponent(avatar.id)}/${encodeURIComponent(name)}`;
}

/** 作者页顶部横幅。 */
export function profileHeaderUrl(user) {
  const header = user?.header;
  if (!header?.id) return '';
  const name = /\.[a-z0-9]{2,5}$/i.test(header.name || '') ? header.name : `${header.id}.jpg`;
  return `/media/i/image/profileHeader/${encodeURIComponent(header.id)}/${encodeURIComponent(name)}`;
}

/**
 * 作品封面。
 *
 * 视频的封面帧地址不是 `<id>.mp4`——那是「文件本身」的路径，i.iwara.tv 对它
 * 只会返回 Iwara 的占位图（灰底胶卷）。真正的帧缩略图是：
 *
 *   /image/thumbnail/<fileId>/thumbnail-<NN>.jpg     NN 必须两位补零
 *
 * `NN` 来自列表项的 `thumbnail` 字段（0 起）。不补零（thumbnail-3.jpg）同样
 * 返回占位图，这个坑实测过，所以这里强制 padStart(2, '0')。
 * 付费作者的自定义封面优先。
 */
export function videoThumbnailUrl(item) {
  if (item?.customThumbnail?.id && item?.customThumbnail?.name) {
    return imageUrl(item.customThumbnail, 'thumbnail');
  }
  const file = item?.file;
  if (!file?.id) return PLACEHOLDER;
  const frame = String(Math.max(0, Number(item.thumbnail) || 0)).padStart(2, '0');
  return `/media/i/image/thumbnail/${encodeURIComponent(file.id)}/thumbnail-${frame}.jpg`;
}

/** 图库封面：thumbnail 本身就是作品原图，用 large 省流量。 */
export function imageGalleryCoverUrl(item) {
  if (item?.customThumbnail?.id && item?.customThumbnail?.name) {
    return imageUrl(item.customThumbnail, 'large');
  }
  if (item?.thumbnail?.id && item?.thumbnail?.name) return galleryStillUrl(item.thumbnail);
  return PLACEHOLDER;
}

/**
 * 通用封面：按作品类型分派。
 * kind = 'video' 时走帧缩略图，'image' 时走原图。
 */
export function coverUrl(item, kind = 'video') {
  if (!item) return PLACEHOLDER;
  if (kind === 'image') return imageGalleryCoverUrl(item);
  // 没有 file 但有 thumbnail 对象时（例如播放列表条目），退到图库逻辑。
  if (!item.file?.id) return imageGalleryCoverUrl(item);
  return videoThumbnailUrl(item);
}

/** 播放列表封面：thumbnail.file + 帧号。 */
export function playlistCoverUrl(playlist) {
  const file = playlist?.thumbnail?.file;
  if (file?.id && file?.name) {
    const frame = String(Math.max(0, Number(playlist.thumbnail.thumbnail) || 0)).padStart(2, '0');
    return `/media/i/image/thumbnail/${encodeURIComponent(file.id)}/thumbnail-${frame}.jpg`;
  }
  if (playlist?.thumbnail?.id && playlist.thumbnail?.name) {
    return imageUrl(playlist.thumbnail, 'large');
  }
  return PLACEHOLDER;
}

/**
 * 这个文件是不是视频。
 *
 * 图库作品里可能混着动图：Iwara 把动图存成 .webm，
 * 用 <img> 渲染必然失败（而且缩略图端点对 .webm 回的是 video/webm，不是静态图）。
 */
export function isVideoFile(file) {
  const mime = String(file?.mime || '').toLowerCase();
  if (mime.startsWith('video/')) return true;
  if (mime.startsWith('image/')) return false;
  return /\.(webm|mp4|mov|m4v)$/i.test(String(file?.name || ''));
}

/** 图库内单张原图/原视频的地址。 */
export function galleryImageUrl(file) {
  return imageUrl(file, 'original');
}

/**
 * 图库条目的静态封面。
 *
 * 缩略图是视频时，`/image/large/<id>/<name>.webm` 回的是 video/webm，塞进
 * <img> 就是坏图。这种情况改用 `thumbnail-00.jpg` —— 上游对视频文件会把它
 * 渲染成真正的 jpeg 静帧。
 */
export function galleryStillUrl(file) {
  if (!file?.id) return PLACEHOLDER;
  if (isVideoFile(file)) {
    return `/media/i/image/thumbnail/${encodeURIComponent(file.id)}/thumbnail-00.jpg`;
  }
  return imageUrl(file, 'large');
}

/* ------------------------------------------------------------------ *
 * 展示用格式化
 * ------------------------------------------------------------------ */

export function formatCount(value) {
  const number = Number(value) || 0;
  if (number < 10000) return number.toLocaleString('zh-CN');
  if (number < 100000000) {
    const wan = number / 10000;
    return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1).replace(/\.0$/, '')}万`;
  }
  return `${(number / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diff = Date.now() - date.getTime();
  const minute = 60000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** 标签 id -> 更好读的显示名。 */
export function tagLabel(id) {
  return String(id || '').replace(/_/g, ' ');
}
