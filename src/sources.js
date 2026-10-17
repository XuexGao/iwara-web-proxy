/**
 * 视频源解析 + X-Version 签名。
 *
 * Iwara 的播放链路：
 *   1. GET apiq.iwara.tv/video/{id}                      -> 拿到 fileUrl（带 hash + expires 的签名地址）
 *   2. GET fileUrl  +  X-Version: sha1(uuid_expires_盐)   -> 拿到清晰度清单
 *   3. 清单里每档 src.view 是协议相对地址（//kafka.iwara.tv/view?...）
 *
 * ⚠️ 盐值不对时上游**不报错**：照样 200，只是清单里只剩 360 / preview 两档。
 *    所以这里把「清单里没有 Source」当成盐值失效的信号，去官网前端重新取盐再试一次。
 */

import {
  API_HOSTS,
  SITE_ORIGIN,
  buildUpstreamHeaders,
  resolveSite,
  upstreamFetch
} from './upstream.js';
import { json } from './util.js';

/** 与官网 main.js 中一致的当前盐值。官网换盐后会自动从站点重新提取。 */
const DEFAULT_SALT = 'mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN';

const SALT_CACHE_KEY = 'https://iwara-salt.internal/current';
const SALT_MIN_INTERVAL_MS = 10 * 60 * 1000;
const SALT_CACHE_TTL_SECONDS = 6 * 60 * 60;

const MAIN_SCRIPT_PATTERN = /src=["'](\/main\.[0-9a-f]+\.js)["']/;
const SALT_PATTERN = /"_"\s*\+\s*[\w$.]+expires\s*\+\s*"_([A-Za-z0-9]{16,})"/;

/** 进程内缓存，避免每个请求都去读 Cache API。 */
let memorySalt = null;
let lastSaltCheckAt = 0;
let lastCheckedScript = null;

function isValidSalt(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{16,}$/.test(value);
}

/* ------------------------------------------------------------------ *
 * 盐值读写
 * ------------------------------------------------------------------ */

async function readCachedSalt() {
  if (memorySalt && isValidSalt(memorySalt.salt)) {
    if (Date.now() - memorySalt.savedAt < SALT_CACHE_TTL_SECONDS * 1000) return memorySalt;
  }
  try {
    const cached = await caches.default.match(new Request(SALT_CACHE_KEY));
    if (cached) {
      const data = await cached.json();
      if (isValidSalt(data?.salt)) {
        memorySalt = { salt: data.salt, script: data.script || null, savedAt: Date.now() };
        return memorySalt;
      }
    }
  } catch {
    /* Cache API 不可用时忽略 */
  }
  return null;
}

async function writeCachedSalt(salt, script) {
  memorySalt = { salt, script, savedAt: Date.now() };
  try {
    await caches.default.put(
      new Request(SALT_CACHE_KEY),
      new Response(JSON.stringify({ salt, script }), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${SALT_CACHE_TTL_SECONDS}`
        }
      })
    );
  } catch {
    /* 忽略 */
  }
}

export async function getSalt() {
  const cached = await readCachedSalt();
  return cached?.salt || DEFAULT_SALT;
}

/** 从官网首页 -> main.js 里提取盐值，成功则写入缓存并返回。 */
async function fetchSaltFromSite() {
  const siteHeaders = {
    ...buildUpstreamHeaders({ url: `${SITE_ORIGIN}/`, site: 'main' }),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  const home = await upstreamFetch(`${SITE_ORIGIN}/`, { headers: siteHeaders });
  if (!home.ok) return null;
  const html = await home.text();

  const scriptPath = MAIN_SCRIPT_PATTERN.exec(html)?.[1];
  if (!scriptPath) return null;
  // 前端没换版本就没必要再下载一遍 main.js。
  if (scriptPath === lastCheckedScript && memorySalt) return memorySalt;

  const script = await upstreamFetch(`${SITE_ORIGIN}${scriptPath}`, { headers: siteHeaders });
  if (!script.ok) return null;
  const source = await script.text();

  const salt = SALT_PATTERN.exec(source)?.[1];
  if (!isValidSalt(salt)) return null;

  lastCheckedScript = scriptPath;
  await writeCachedSalt(salt, scriptPath);
  return memorySalt;
}

/** 节流地刷新盐值；返回新盐值或 null。 */
async function refreshSalt() {
  const now = Date.now();
  if (now - lastSaltCheckAt < SALT_MIN_INTERVAL_MS) {
    const cached = await readCachedSalt();
    return cached?.salt && cached.salt !== DEFAULT_SALT ? cached.salt : null;
  }
  lastSaltCheckAt = now;
  try {
    const result = await fetchSaltFromSite();
    return result?.salt || null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * X-Version
 * ------------------------------------------------------------------ */

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function computeXVersion(fileUrl, salt) {
  let url;
  try {
    url = new URL(fileUrl);
  } catch {
    return null;
  }
  const expires = url.searchParams.get('expires');
  const segments = url.pathname.split('/').filter(Boolean);
  const uuid = segments[segments.length - 1];
  if (!expires || !uuid) return null;
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(`${uuid}_${expires}_${salt}`)
  );
  return toHex(digest);
}

/* ------------------------------------------------------------------ *
 * 清晰度
 * ------------------------------------------------------------------ */

const QUALITY_LABELS = {
  Source: '原画',
  preview: '预览',
  1080: '1080P',
  720: '720P',
  540: '540P',
  480: '480P',
  360: '360P',
  240: '240P'
};

function qualityRank(name) {
  if (name === 'Source') return 100000;
  if (name === 'preview') return -1;
  const numeric = Number.parseInt(name, 10);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeSourceUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  return value.startsWith('//') ? `https:${value}` : value;
}

function localMediaUrl(absoluteUrl, filename) {
  const params = new URLSearchParams({ u: absoluteUrl });
  if (filename) params.set('dl', filename);
  return `/media/v?${params.toString()}`;
}

/* ------------------------------------------------------------------ *
 * 上游调用
 * ------------------------------------------------------------------ */

async function fetchJson(url, headers) {
  try {
    const response = await upstreamFetch(url, { headers });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  }
}

async function fetchSourceList(fileUrl, salt, site, auth) {
  const xVersion = await computeXVersion(fileUrl, salt);
  if (!xVersion) return null;
  return fetchJson(
    fileUrl,
    buildUpstreamHeaders({
      url: fileUrl,
      site: site.key,
      token: auth.token,
      extra: { 'X-Version': xVersion }
    })
  );
}

function hasSource(list) {
  return Array.isArray(list) && list.some((item) => item?.name === 'Source');
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/**
 * GET /api/sources/{videoId}
 * 返回可直接喂给 <video> 的本站地址，前端不需要理解签名逻辑。
 */
export async function handleSources(request, env, videoId, auth) {
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(videoId)) {
    return json({ error: '视频 ID 不合法。' }, 400);
  }

  const site = resolveSite(env?.DEFAULT_SITE);
  const detailUrl = `https://${API_HOSTS[0]}/video/${videoId}`;
  const detail = await fetchJson(
    detailUrl,
    buildUpstreamHeaders({ url: detailUrl, site: site.key, token: auth.token })
  );

  if (!detail || !detail.id) {
    return json({ error: '读取这个作品的信息失败，可能已被删除或需要登录。' }, 404);
  }

  const fileUrl = String(detail.fileUrl || '').trim();
  if (!fileUrl) {
    return json(
      {
        error: '这个作品没有可播放的视频文件（可能是图库或外链作品）。',
        video: { id: detail.id, title: detail.title, type: 'image' }
      },
      409
    );
  }

  let salt = await getSalt();
  let list = await fetchSourceList(fileUrl, salt, site, auth);

  // 清单里没有 Source，说明盐值可能已经轮换，去官网取新盐重试一次。
  if (Array.isArray(list) && list.length > 0 && !hasSource(list)) {
    const refreshedSalt = await refreshSalt();
    if (refreshedSalt && refreshedSalt !== salt) {
      const retried = await fetchSourceList(fileUrl, refreshedSalt, site, auth);
      if (hasSource(retried)) {
        list = retried;
        salt = refreshedSalt;
      }
    }
  }

  if (!Array.isArray(list) || list.length === 0) {
    return json({ error: '视频清晰度清单为空，可能仍在转码中，稍后再试。' }, 409);
  }

  const fileName = String(detail?.file?.name || `${videoId}.mp4`);
  const sources = list
    .map((item) => {
      const name = String(item?.name || '');
      const view = normalizeSourceUrl(item?.src?.view);
      const download = normalizeSourceUrl(item?.src?.download);
      if (!view) return null;
      const isPreview = name === 'preview';
      const downloadName = isPreview
        ? fileName.replace(/(\.[a-z0-9]+)$/i, '_preview$1')
        : name === 'Source'
          ? fileName
          : fileName.replace(/(\.[a-z0-9]+)$/i, `_${name}$1`);
      return {
        name,
        label: QUALITY_LABELS[name] || name,
        type: item?.type || 'video/mp4',
        url: localMediaUrl(view, isPreview ? null : downloadName),
        downloadUrl: download ? localMediaUrl(download, downloadName) : '',
        rank: qualityRank(name)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.rank - a.rank);

  if (!sources.length) return json({ error: '没有可用的播放地址。' }, 409);

  const preview = sources.find((item) => item.name === 'preview') || null;

  return json(
    {
      id: videoId,
      saltSource: salt === DEFAULT_SALT ? 'builtin' : 'site',
      file: {
        duration: Number(detail?.file?.duration) || 0,
        width: Number(detail?.file?.width) || 0,
        height: Number(detail?.file?.height) || 0,
        size: Number(detail?.file?.size) || 0,
        animatedPreview: !!detail?.file?.animatedPreview,
        numThumbnails: Number(detail?.file?.numThumbnails) || 0
      },
      sources: sources.filter((item) => item.name !== 'preview'),
      preview: preview ? { url: preview.url, type: preview.type } : null
    },
    200,
    { 'cache-control': 'no-store' }
  );
}

export async function handleSaltStatus() {
  const salt = await getSalt();
  return json({
    salt,
    isDefault: salt === DEFAULT_SALT,
    lastCheckedAt: lastSaltCheckAt ? new Date(lastSaltCheckAt).toISOString() : null,
    script: lastCheckedScript
  });
}
