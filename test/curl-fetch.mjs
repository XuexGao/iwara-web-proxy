/**
 * 本地调试用的 fetch 替身。
 *
 * 为什么需要它：Node 的 undici 有自己的 TLS 指纹，配上浏览器 UA 会被 Cloudflare
 * 判定为可疑客户端，直接回「Just a moment...」挑战页（同一个请求 curl 就是 200）。
 * 而线上跑在 Cloudflare Workers 里，出口是 Cloudflare 自己的网络，不存在这个问题。
 *
 * 所以本地用 curl 作为传输层，让接口与媒体链路可以真实跑通。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EMPTY_BODY_STATUS = new Set([204, 205, 304]);

function parseHeaderFile(content) {
  const blocks = content.split(/\r?\n\r?\n/).filter((block) => /^HTTP\//.test(block.trim()));
  const block = blocks[blocks.length - 1] || '';
  const lines = block.split(/\r?\n/).filter(Boolean);
  const statusLine = lines.shift() || '';
  const status = Number.parseInt(statusLine.split(/\s+/)[1] || '0', 10) || 0;
  const headers = new Headers();
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index < 0) continue;
    headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return { status, headers };
}

async function runCurl(url, init) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'curlfetch-'));
  const headerFile = path.join(dir, 'headers');
  const bodyFile = path.join(dir, 'body');
  try {
    const method = String(init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const args = [
      '-sS',
      '-L',
      '--max-time',
      '120',
      '--max-redirs',
      '5',
      '-D',
      headerFile,
      '-o',
      bodyFile,
      '-X',
      method
    ];
    for (const [name, value] of headers.entries()) {
      if (name.toLowerCase() === 'host' || name.toLowerCase() === 'content-length') continue;
      args.push('-H', `${name}: ${value}`);
    }
    if (!headers.has('accept-encoding')) args.push('-H', 'Accept-Encoding: identity');

    let payload = null;
    if (init.body && method !== 'GET' && method !== 'HEAD') {
      payload = Buffer.isBuffer(init.body)
        ? init.body
        : init.body instanceof ArrayBuffer
          ? Buffer.from(init.body)
          : Buffer.from(String(init.body));
      args.push('--data-binary', '@-');
    }

    const { code, stderr } = await new Promise((resolve) => {
      const child = spawn('curl', [...args, url], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderrText = '';
      child.stderr.on('data', (chunk) => {
        stderrText += chunk.toString();
      });
      child.on('close', (exitCode) => resolve({ code: exitCode, stderr: stderrText }));
      child.on('error', (error) => resolve({ code: -1, stderr: String(error) }));
      if (payload) child.stdin.end(payload);
      else child.stdin.end();
    });

    if (code !== 0) throw new Error(`curl exited with ${code}: ${stderr.trim()}`);

    const headerText = await fs.promises.readFile(headerFile, 'utf8');
    const { status, headers: responseHeaders } = parseHeaderFile(headerText);
    const body = EMPTY_BODY_STATUS.has(status) ? null : await fs.promises.readFile(bodyFile);
    return new Response(body, { status, headers: responseHeaders });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

export function installCurlFetch() {
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const merged = { ...init };
    if (typeof input !== 'string') {
      merged.method = merged.method || input.method;
      if (!merged.headers && input.headers) merged.headers = input.headers;
    }
    return runCurl(url, merged);
  };
}
