/**
 * 悬停预览：鼠标停在封面上时播放 Iwara 自带的 preview 片段，
 * 左右移动鼠标可以擦拭进度。这是 Iwara 数据模型独有的能力
 * （file.numThumbnails / animatedPreview / preview 档），也是本站的招牌交互。
 */

import { getPreviewSource } from './api.js';
import { getSetting } from './store.js';

const HOVER_DELAY = 300;
const MAX_LIVE = 2;
const IDLE_RESUME = 180;

const live = new Set();
let pointerFine = null;

function canPreview() {
  if (pointerFine === null) {
    pointerFine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  }
  return pointerFine && getSetting('hoverPreview');
}

function retire(entry) {
  entry.destroyed = true;
  clearTimeout(entry.timer);
  clearTimeout(entry.idleTimer);
  entry.video?.remove();
  entry.video = null;
  live.delete(entry);
}

function enforceLimit() {
  while (live.size > MAX_LIVE) {
    const oldest = [...live][0];
    retire(oldest);
  }
}

/**
 * 给封面元素接上预览能力。
 * @param {HTMLElement} cover .card__cover
 * @param {string} videoId
 */
export function attachPreview(cover, videoId) {
  if (!videoId) return;

  const entry = {
    video: null,
    timer: 0,
    idleTimer: 0,
    destroyed: false,
    ready: false,
    scrubbing: false,
    objectUrl: null
  };

  const ensureVideo = async () => {
    if (entry.destroyed || entry.video) return;
    const url = await getPreviewSource(videoId);
    if (!url || entry.destroyed || !cover.isConnected) return;

    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('aria-hidden', 'true');
    video.addEventListener('loadeddata', () => {
      entry.ready = true;
      video.classList.add('is-on');
    });
    video.addEventListener('error', () => retire(entry));
    cover.append(video);
    entry.video = video;
    live.add(entry);
    enforceLimit();

    try {
      await video.play();
    } catch {
      /* 自动播放被拒绝时保持静默，封面仍然可见 */
    }
  };

  const onEnter = () => {
    if (!canPreview() || entry.video || entry.timer) return;
    entry.timer = setTimeout(ensureVideo, HOVER_DELAY);
  };

  const onMove = (event) => {
    const video = entry.video;
    if (!video || !entry.ready || !video.duration) return;
    const rect = cover.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const target = ratio * video.duration;

    // 擦拭：暂停并跳到指针位置，指针停下后再继续播放。
    if (!video.paused) video.pause();
    if (Math.abs(video.currentTime - target) > 0.08) {
      try {
        video.currentTime = target;
      } catch {
        /* 元数据还没到位，忽略 */
      }
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (!entry.destroyed && entry.video) entry.video.play().catch(() => {});
    }, IDLE_RESUME);
  };

  const onLeave = () => {
    clearTimeout(entry.timer);
    entry.timer = 0;
    clearTimeout(entry.idleTimer);
    if (entry.video) retire(entry);
  };

  cover.addEventListener('pointerenter', onEnter);
  cover.addEventListener('pointermove', onMove);
  cover.addEventListener('pointerleave', onLeave);
  cover.addEventListener('pointercancel', onLeave);
}

/** 页面切换时统一收尾。 */
export function stopAllPreviews() {
  for (const entry of [...live]) retire(entry);
}
