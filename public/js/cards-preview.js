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

/**
 * 回收预览资源。
 *
 * ⚠️ 这里**不能**把 entry 标记成"永久作废"：鼠标移开只是暂时收起预览，
 * 再悬停同一张卡片时应该能重新加载。早期用一个 destroyed 标志同时表示
 * "资源已回收"和"视图已销毁"，结果每张卡片的预览只有一次寿命。
 * 视图真的被销毁时用 abort()，那才是不可恢复的。
 */
function retire(entry) {
  clearTimeout(entry.timer);
  entry.timer = 0;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = 0;
  entry.video?.remove();
  entry.video = null;
  entry.ready = false;
  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
    entry.objectUrl = null;
  }
  live.delete(entry);
}

/** 视图销毁：与 retire 的区别是此后不再重建。 */
function abort(entry) {
  entry.aborted = true;
  retire(entry);
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
    aborted: false,
    ready: false,
    scrubbing: false,
    objectUrl: null
  };

  const ensureVideo = async () => {
    if (entry.aborted || entry.video || !cover.isConnected) return;
    const url = await getPreviewSource(videoId);
    if (!url || entry.aborted || !cover.isConnected) return;

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
    if (!canPreview() || entry.aborted || !cover.isConnected) return;
    if (entry.video || entry.timer) return;
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
      if (entry.video) entry.video.play().catch(() => {});
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
  // 只处理还活着的条目：那些已经 retire 过的卡片，其元素随视图一起被丢弃，
  // 事件也不会再触发，无需逐个标记。
  for (const entry of [...live]) abort(entry);
}
