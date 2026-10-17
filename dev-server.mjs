/**
 * 本地开发服务器（不需要 workerd）。
 *
 * 这个沙箱环境内存不足，workerd 起不来，所以这里用一个极薄的 Node 适配层
 * 直接调用 src/index.js 里的 Worker：静态资源从 public/ 读盘，
 * /api/* 与 /media/* 交给真正的 Worker 处理器。
 *
 * 用法：node dev-server.mjs [端口]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import worker from './src/index.js';
import { installCurlFetch } from './test/curl-fetch.mjs';

// workerd 在本机跑不起来，Node 的 TLS 指纹又会被上游挑战，
// 所以本地开发统一用 curl 作为上游传输层。
installCurlFetch();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.argv[2] || 8788);

/* ---------------- Cache API 桩 ---------------- */

const memoryCache = new Map();

globalThis.caches = {
  default: {
    async match(request) {
      const key = typeof request === 'string' ? request : request.url;
      const entry = memoryCache.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt && entry.expiresAt < Date.now()) {
        memoryCache.delete(key);
        return undefined;
      }
      return new Response(entry.body, { headers: entry.headers });
    },
    async put(request, response) {
      const key = typeof request === 'string' ? request : request.url;
      const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1];
      const body = await response.arrayBuffer();
      const headers = [...response.headers.entries()];
      memoryCache.set(key, {
        body,
        headers,
        expiresAt: maxAge ? Date.now() + Number(maxAge) * 1000 : 0
      });
    },
    async delete(request) {
      const key = typeof request === 'string' ? request : request.url;
      return memoryCache.delete(key);
    }
  }
};

/* ---------------- 环境变量 ---------------- */

const ENV = {
  SITE_NAME: 'Iwara 映像',
  DEFAULT_SITE: 'main',
  BASIC_AUTH_USER: '',
  BASIC_AUTH_PASS: '',
  IWARA_AUTHORIZATION: '',
  API_CACHE_TTL: '30',
  IMAGE_CACHE_TTL: '604800',
  VIDEO_CACHE_TTL: '3600',
  SESSION_SECRET: 'dev-only-session-secret-please-change-me',
  // 本地默认不开启密码，验证密码流程时用 SITE_PASSWORD=xxx node dev-server.mjs
  SITE_PASSWORD: process.env.SITE_PASSWORD || ''
};

/* ---------------- 静态资源 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let filePath = path.join(PUBLIC_DIR, decodeURIComponent(url.pathname));
    if (!filePath.startsWith(PUBLIC_DIR)) return new Response('forbidden', { status: 403 });

    if (url.pathname === '/' || !path.extname(filePath)) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }
    try {
      const data = await fs.promises.readFile(filePath);
      return new Response(data, {
        headers: { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' }
      });
    } catch {
      try {
        const html = await fs.promises.readFile(path.join(PUBLIC_DIR, 'index.html'));
        return new Response(html, { headers: { 'content-type': MIME['.html'] } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
  }
};

/* ---------------- HTTP 服务 ---------------- */

function toWebRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const request = toWebRequest(req);
    const response = await worker.fetch(request, { ...ENV, ASSETS }, {});
    res.statusCode = response.status;
    for (const [key, value] of response.headers.entries()) {
      if (key === 'set-cookie') continue;
      res.setHeader(key, value);
    }
    const cookies = response.headers.getSetCookie?.() || [];
    if (cookies.length) res.setHeader('set-cookie', cookies);

    if (!response.body) {
      res.end();
    } else {
      Readable.fromWeb(response.body).pipe(res);
    }
    const logLine = `${req.method} ${req.url} -> ${response.status} (${Date.now() - started}ms)`;
    if (response.status >= 400) console.log('\x1b[31m' + logLine + '\x1b[0m');
    else console.log(logLine);
  } catch (error) {
    console.error('dev_server_error', error);
    res.statusCode = 500;
    res.end('dev server error: ' + error.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev server: http://127.0.0.1:${PORT}`);
});
