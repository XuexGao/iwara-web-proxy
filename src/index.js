/**
 * Worker 入口与路由。
 *
 * 请求分流：
 *   /api/auth/*    登录、登出、会话查询
 *   /api/sources/* 视频源解析（含 X-Version 签名与盐值自愈）
 *   /api/iwara/*   业务接口反向代理 -> apiq.iwara.tv
 *   /media/*       视频流 / 图片代理
 *   /api/status    运维信息
 *   其余            静态资源（由 Cloudflare 直接返回，不消耗 Worker 请求数）
 */

import { handleIwaraApi } from './api.js';
import { handleMedia } from './media.js';
import {
  handleAuthConfig,
  handleLogin,
  handleLogout,
  handleMe,
  handleTokenLogin,
  loginEnabled,
  resolveAuth
} from './session.js';
import { handleSaltStatus, handleSources } from './sources.js';
import { isMutating, isSameOriginRequest, json } from './util.js';
import { verifyBasicAuth } from './upstream.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 0. 站点级 Basic Auth（未配置时直接放行）。
    const denied = verifyBasicAuth(request, env);
    if (denied) return denied;

    try {
      if (url.pathname.startsWith('/api/')) return await routeApi(request, env, url);
      if (url.pathname.startsWith('/media/')) return await handleMedia(request, env, url);
    } catch (error) {
      console.error('request_failed', url.pathname, error?.stack || String(error));
      return json({ error: '服务器内部错误。' }, 500);
    }

    // 静态资源 / SPA 回退。
    return env.ASSETS.fetch(request);
  }
};

/* ------------------------------------------------------------------ *
 * 写操作的 CSRF 防护
 * ------------------------------------------------------------------ */

function guardMutation(request) {
  if (!isMutating(request.method)) return null;
  if (isSameOriginRequest(request)) return null;
  return json({ error: '请求来源不合法。' }, 403);
}

function applyCookies(headers, ...cookies) {
  for (const cookie of cookies) {
    if (cookie) headers.append('set-cookie', cookie);
  }
  return headers;
}

function respond(result) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  applyCookies(headers, result.setCookie);
  return new Response(JSON.stringify(result.body), { status: result.status || 200, headers });
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

async function routeApi(request, env, url) {
  const path = url.pathname;

  /* ---------------- 认证 ---------------- */

  if (path === '/api/auth/config') {
    if (request.method !== 'GET') return json({ error: '方法不允许。' }, 405);
    return json(handleAuthConfig(env));
  }

  if (path === '/api/auth/login') {
    if (request.method !== 'POST') return json({ error: '方法不允许。' }, 405);
    const guard = guardMutation(request);
    if (guard) return guard;
    return respond(await handleLogin(request, env));
  }

  if (path === '/api/auth/token') {
    if (request.method !== 'POST') return json({ error: '方法不允许。' }, 405);
    const guard = guardMutation(request);
    if (guard) return guard;
    return respond(await handleTokenLogin(request, env));
  }

  if (path === '/api/auth/logout') {
    if (request.method !== 'POST') return json({ error: '方法不允许。' }, 405);
    const guard = guardMutation(request);
    if (guard) return guard;
    return respond(handleLogout());
  }

  if (path === '/api/auth/me') {
    if (request.method !== 'GET') return json({ error: '方法不允许。' }, 405);
    return respond(await handleMe(request, env));
  }

  /* ---------------- 运维 ---------------- */

  if (path === '/api/status') {
    const salt = await handleSaltStatus(env);
    const saltBody = await salt.json();
    return json({
      ok: true,
      time: new Date().toISOString(),
      loginEnabled: loginEnabled(env),
      basicAuth: !!(String(env?.BASIC_AUTH_USER || '').trim() || String(env?.BASIC_AUTH_PASS || '').trim()),
      sharedToken: !!String(env?.IWARA_AUTHORIZATION || '').trim(),
      apiCacheTtl: Number(env?.API_CACHE_TTL ?? 30) || 0,
      salt: saltBody
    });
  }

  /* ---------------- 视频源 ---------------- */

  if (path.startsWith('/api/sources/')) {
    if (request.method !== 'GET') return json({ error: '方法不允许。' }, 405);
    const videoId = decodeURIComponent(path.slice('/api/sources/'.length)).replace(/\/+$/, '');
    const auth = await resolveAuth(request, env);
    const response = await handleSources(request, env, videoId, auth);
    if (auth.setCookie) response.headers.append('set-cookie', auth.setCookie);
    return response;
  }

  /* ---------------- 业务接口代理 ---------------- */

  if (path === '/api/iwara' || path === '/api/iwara/') {
    return json({ error: '缺少上游路径，例如 /api/iwara/videos?page=0' }, 400);
  }

  if (path.startsWith('/api/iwara/')) {
    if (isMutating(request.method)) {
      const guard = guardMutation(request);
      if (guard) return guard;
    }
    const upstreamPath = path.slice('/api/iwara'.length);
    const auth = await resolveAuth(request, env, url.searchParams.get('_site'));
    const response = await handleIwaraApi(request, env, upstreamPath, url.searchParams, auth);
    if (auth.setCookie) response.headers.append('set-cookie', auth.setCookie);
    return response;
  }

  return json({ error: '接口不存在。' }, 404);
}
