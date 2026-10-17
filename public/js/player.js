/**
 * 播放器：自建控件 + 进度条预览 + 清晰度切换 + 画中画 + 迷你播放器接力。
 *
 * 迷你播放器不是"另开一个播放器"，而是把同一个 <video> 元素搬到角落，
 * 所以切页面时缓冲和进度都不会丢。
 */

import { formatDuration } from './api.js';
import { getResume, getSetting, saveResume, setSetting } from './store.js';
import { icon, raw, tpl } from './ui.js';

/** 当前正在播放的元素；跨路由复用，避免切页面重载。 */
export const playback = {
  videoId: null,
  video: null,
  meta: null,
  detached: false
};

const ICONS = { play: 'play', pause: 'pause' };

/** 进度条上的悬停预览。 */
function createPeek(previewUrl, previewType) {
  const node = tpl`
    <div class="player__peek">
      <video muted playsinline preload="metadata"></video>
      <span>0:00</span>
    </div>`;
  if (previewUrl) {
    const video = node.querySelector('video');
    video.src = previewUrl;
    video.addEventListener('loadedmetadata', () => {
      video.play().catch(() => {});
    });
  }
  return node;
}

/**
 * 创建播放器。
 * @param {object} options
 */
export function createPlayer(options) {
  const {
    sources = [],
    preview = null,
    meta = {},
    startAt = 0,
    autoplay = true,
    poster = '',
    onEnded,
    onRequestRefresh,
    videoElement = null
  } = options;

  let currentIndex = pickInitialIndex(sources);
  let lastVolume = getSetting('volume') ?? 1;
  let lastMuted = !!getSetting('muted');

  // 从迷你播放器接回来的视频元素：保留它的缓冲与进度，不重新加载。
  const adopted = videoElement || null;
  const video = adopted || document.createElement('video');
  video.playsInline = true;
  video.preload = 'metadata';
  if (!adopted) {
    video.poster = poster;
    if (currentIndex >= 0) video.src = sources[currentIndex].url;
  }
  video.volume = adopted ? video.volume : lastVolume;
  video.muted = adopted ? video.muted : lastMuted;

  // 声明必须早于任何可能触发 play 事件的监听器（TDZ）。
  let hideTimer = 0;

  const toggleButton = tpl`<button type="button" data-act="toggle" aria-label="播放/暂停">${icon('play')}</button>`;
  const muteButton = tpl`<button type="button" data-act="mute" aria-label="静音">${icon('volume')}</button>`;
  const elapsed = tpl`<span class="player__time">0:00</span>`;
  const durationLabel = tpl`<span class="player__time">0:00</span>`;
  const played = tpl`<div class="player__played"></div>`;
  const buffered = tpl`<div class="player__buf"></div>`;
  const knob = tpl`<div class="player__knob"></div>`;
  const track = tpl`<div class="player__track"></div>`;
  track.append(buffered, played, knob);
  const scrub = tpl`<div class="player__scrub" role="slider" tabindex="0" aria-label="播放进度">${track}</div>`;
  const peek = createPeek(preview?.url, preview?.type);
  const volumeInput = tpl`<input type="range" min="0" max="1" step="0.02" value="${lastVolume}" aria-label="音量" />`;

  const qualityButton = tpl`<button type="button" data-act="quality" aria-haspopup="true">${sources[currentIndex]?.label || '清晰度'}</button>`;
  const qualityPanel = tpl`<div class="quality__panel" hidden></div>`;
  for (const [index, source] of sources.entries()) {
    const button = tpl`<button type="button" role="menuitemradio" aria-checked="${index === currentIndex}">${source.label}</button>`;
    button.addEventListener('click', () => {
      switchQuality(index);
      qualityPanel.hidden = true;
    });
    qualityPanel.append(button);
  }
  const qualityWrap = tpl`<div class="quality">${qualityButton}${qualityPanel}</div>`;
  qualityButton.addEventListener('click', (event) => {
    event.stopPropagation();
    qualityPanel.hidden = !qualityPanel.hidden;
  });

  const controls = tpl`
    <div class="player__controls">
      ${toggleButton}
      ${elapsed}
      ${scrub}
      ${durationLabel}
      <div class="player__volume">${muteButton}${volumeInput}</div>
      ${qualityWrap}
      <button type="button" data-act="pip" aria-label="画中画">${icon('pip')}</button>
      <button type="button" data-act="fullscreen" aria-label="全屏">${icon('expand')}</button>
    </div>`;

  const spinner = tpl`<div class="player__spinner"><i></i></div>`;
  const hit = tpl`<div class="player__hit"></div>`;
  const stage = tpl`<div class="player__stage"></div>`;
  stage.append(video, hit, spinner, peek, controls);
  const element = tpl`<div class="player"></div>`;
  element.append(stage);

  /* ---------------- 状态 ---------------- */

  function setSpinner(on) {
    spinner.classList.toggle('is-on', on);
  }

  function updateToggleIcon() {
    toggleButton.innerHTML = `<svg class="icon"><use href="#i-${video.paused ? 'play' : 'pause'}"/></svg>`;
  }

  function updateProgress() {
    const total = video.duration || 0;
    const ratio = total ? video.currentTime / total : 0;
    played.style.width = `${(ratio * 100).toFixed(3)}%`;
    knob.style.left = `${(ratio * 100).toFixed(3)}%`;
    elapsed.textContent = formatDuration(video.currentTime);
    if (!total) durationLabel.textContent = '--:--';
    else durationLabel.textContent = formatDuration(total);

    let bufferEnd = 0;
    try {
      if (video.buffered.length) bufferEnd = video.buffered.end(video.buffered.length - 1);
    } catch {
      /* 忽略 */
    }
    buffered.style.width = total ? `${((bufferEnd / total) * 100).toFixed(2)}%` : '0%';

    if (meta.id) saveResume(meta.id, video.currentTime, total);
  }

  function switchQuality(index) {
    if (index === currentIndex || !sources[index]) return;
    const wasPlaying = !video.paused;
    const time = video.currentTime;
    currentIndex = index;
    qualityButton.textContent = sources[index].label;
    for (const [i, button] of [...qualityPanel.children].entries()) {
      button.setAttribute('aria-checked', String(i === index));
    }
    video.src = sources[index].url;
    const restore = () => {
      try {
        video.currentTime = time;
      } catch {
        /* 忽略 */
      }
      if (wasPlaying) video.play().catch(() => {});
      video.removeEventListener('loadedmetadata', restore);
    };
    video.addEventListener('loadedmetadata', restore);
    video.load();
    setSetting('quality', sources[index].name);
  }

  /* ---------------- 交互 ---------------- */

  const toggle = () => {
    if (video.paused) video.play().catch(() => toastPlaybackBlocked());
    else video.pause();
  };

  toggleButton.addEventListener('click', toggle);
  hit.addEventListener('click', toggle);
  hit.addEventListener('dblclick', () => toggleFullscreen());

  muteButton.addEventListener('click', () => {
    video.muted = !video.muted;
    applyVolumeUi();
  });

  volumeInput.addEventListener('input', () => {
    video.volume = Number(volumeInput.value);
    video.muted = video.volume === 0;
    applyVolumeUi();
  });

  function applyVolumeUi() {
    lastVolume = video.volume;
    lastMuted = video.muted;
    setSetting('volume', video.volume);
    setSetting('muted', video.muted);
    volumeInput.value = String(video.muted ? 0 : video.volume);
    muteButton.innerHTML = `<svg class="icon"><use href="#i-${video.muted || video.volume === 0 ? 'mute' : 'volume'}"/></svg>`;
  }

  function seekToRatio(ratio) {
    if (!video.duration) return;
    video.currentTime = Math.min(video.duration - 0.05, Math.max(0, ratio * video.duration));
    updateProgress();
  }

  let scrubbing = false;
  const ratioFromEvent = (event) => {
    const rect = scrub.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  };

  scrub.addEventListener('pointerdown', (event) => {
    scrubbing = true;
    scrub.setPointerCapture(event.pointerId);
    seekToRatio(ratioFromEvent(event));
  });
  scrub.addEventListener('pointermove', (event) => {
    const ratio = ratioFromEvent(event);
    if (scrubbing) seekToRatio(ratio);
    // 悬停预览
    if (preview?.url) {
      const width = peek.offsetWidth || 168;
      const rect = scrub.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const x = Math.min(Math.max(event.clientX - stageRect.left - width / 2, 6), stageRect.width - width - 6);
      peek.style.left = `${x}px`;
      peek.classList.add('is-on');
      peek.querySelector('span').textContent = formatDuration(ratio * (video.duration || 0));
      const peekVideo = peek.querySelector('video');
      if (peekVideo?.duration) {
        // 预览片段与正片时长不同，按比例映射，只作画面参考。
        try {
          peekVideo.currentTime = ratio * peekVideo.duration;
        } catch {
          /* 忽略 */
        }
      }
    }
  });
  const endScrub = () => {
    scrubbing = false;
  };
  scrub.addEventListener('pointerup', endScrub);
  scrub.addEventListener('pointercancel', endScrub);
  scrub.addEventListener('pointerleave', () => {
    endScrub();
    peek.classList.remove('is-on');
  });

  scrub.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5);
    if (event.key === 'ArrowRight') video.currentTime = video.currentTime + 5;
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else element.requestFullscreen?.().catch(() => {});
  }

  element.querySelector('[data-act="fullscreen"]').addEventListener('click', toggleFullscreen);
  element.querySelector('[data-act="pip"]').addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      /* 浏览器不支持时忽略 */
    }
  });

  /* ---------------- 播放器事件 ---------------- */

  video.addEventListener('play', () => {
    updateToggleIcon();
    playback.video = video;
    element.classList.remove('is-paused');
    scheduleHide();
  });
  video.addEventListener('pause', () => {
    updateToggleIcon();
    element.classList.add('is-paused');
    element.classList.remove('is-hidden-controls');
    clearTimeout(hideTimer);
  });
  video.addEventListener('timeupdate', updateProgress);
  video.addEventListener('progress', updateProgress);
  video.addEventListener('durationchange', updateProgress);
  video.addEventListener('waiting', () => setSpinner(true));
  video.addEventListener('playing', () => setSpinner(false));
  video.addEventListener('canplay', () => setSpinner(false));
  video.addEventListener('volumechange', () => {
    lastVolume = video.volume;
    lastMuted = video.muted;
  });

  let refreshing = false;
  video.addEventListener('error', async () => {
    if (!video.src || refreshing) return;
    refreshing = true;
    setSpinner(false);
    const message = tpl`
      <div class="player__error">
        <div class="state__title">播放中断</div>
        <p style="color:var(--paper-3);font-size:13px;max-width:40ch">
          视频地址可能已过期。刷新播放地址后可以继续观看。
        </p>
      </div>`;
    const retry = tpl`<button class="btn btn--primary btn--sm" type="button">刷新播放地址</button>`;
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      retry.textContent = '正在刷新…';
      const time = video.currentTime;
      const ok = await onRequestRefresh?.(time);
      retry.disabled = false;
      if (ok) message.remove();
      else {
        retry.textContent = '刷新失败，再试一次';
        refreshing = false;
      }
    });
    message.append(retry);
    stage.append(message);
  });

  video.addEventListener('ended', () => {
    updateToggleIcon();
    onEnded?.();
  });

  if (startAt > 0) {
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (video.duration && startAt < video.duration - 5) video.currentTime = startAt;
      },
      { once: true }
    );
  }

  if (autoplay && !adopted) video.play().catch(() => {});
  if (adopted && video.paused) video.play().catch(() => {});

  setSpinner(true);
  element.classList.add('is-paused');
  applyVolumeUi();
  updateToggleIcon();
  if (currentIndex >= 0) setSetting('quality', sources[currentIndex].name);

  /* ---------------- 控制栏自动隐藏 ---------------- */

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!video.paused) element.classList.add('is-hidden-controls');
    }, 2600);
  }

  const wake = () => {
    element.classList.remove('is-hidden-controls');
    if (!video.paused) scheduleHide();
  };

  stage.addEventListener('pointermove', wake);
  stage.addEventListener('pointerdown', wake);
  element.addEventListener('focusin', () => clearTimeout(hideTimer));
  element.addEventListener('focusout', () => {
    if (!video.paused) scheduleHide();
  });

  /* ---------------- 键盘 ---------------- */

  const onKeydown = (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const step = event.shiftKey ? 30 : 5;
    switch (event.key) {
      case ' ':
      case 'k':
        event.preventDefault();
        toggle();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - step);
        break;
      case 'ArrowRight':
        event.preventDefault();
        video.currentTime = video.currentTime + step;
        break;
      case 'j':
        video.currentTime = Math.max(0, video.currentTime - 10);
        break;
      case 'l':
        video.currentTime = video.currentTime + 10;
        break;
      case 'ArrowUp':
        event.preventDefault();
        video.muted = false;
        video.volume = Math.min(1, video.volume + 0.08);
        applyVolumeUi();
        break;
      case 'ArrowDown':
        event.preventDefault();
        video.volume = Math.max(0, video.volume - 0.08);
        applyVolumeUi();
        break;
      case 'm':
        video.muted = !video.muted;
        applyVolumeUi();
        break;
      case 'f':
        toggleFullscreen();
        break;
      default:
        if (/^[0-9]$/.test(event.key) && video.duration) {
          video.currentTime = (Number(event.key) / 10) * video.duration;
        }
    }
  };
  document.addEventListener('keydown', onKeydown);

  element.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('.quality')) return;
    qualityPanel.hidden = true;
  });

  return {
    element,
    video,
    meta,
    destroy({ keepVideo = false } = {}) {
      clearTimeout(hideTimer);
      document.removeEventListener('keydown', onKeydown);
      if (!keepVideo) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    },
    /** 把视频元素交出去（移到迷你播放器），保留播放状态。 */
    detachVideo() {
      video.remove();
      setSpinner(false);
      return video;
    },
    attachVideo(external) {
      stage.prepend(external);
    },
    get currentTime() {
      return video.currentTime;
    },
    get currentSource() {
      return sources[currentIndex] || null;
    },
    get sources() {
      return sources;
    }
  };
}

function pickInitialIndex(sources) {
  if (!sources.length) return -1;
  const preferred = getSetting('quality');
  if (preferred && preferred !== 'auto') {
    const index = sources.findIndex((source) => source.name === preferred);
    if (index >= 0) return index;
  }
  // 默认原画；列表已按清晰度降序排列。
  return sources.findIndex((source) => source.name === 'Source') >= 0
    ? sources.findIndex((source) => source.name === 'Source')
    : 0;
}

function toastPlaybackBlocked() {
  // 自动播放被浏览器拦截时，用户点一下就能播，不需要打扰。
}

/* ------------------------------------------------------------------ *
 * 迷你播放器
 * ------------------------------------------------------------------ */

const miniRoot = () => document.getElementById('mini');

export const mini = {
  active: false,

  /** 把视频元素搬进角落继续播放。 */
  adopt(video, meta) {
    const root = miniRoot();
    if (!root) return;
    playback.detached = true;
    this.active = true;
    playback.videoId = meta.id;
    playback.meta = meta;

    this.restorePlaceholder();
    video.classList.remove('is-on');
    root.querySelector('.mini__bar').before(video);
    root.hidden = false;

    document.getElementById('mini-title').textContent = meta.title || '正在播放';
    document.getElementById('mini-title').href = `#/video/${meta.id}`;
    document.getElementById('mini-author').textContent = meta.author || '';

    const progress = document.getElementById('mini-progress');
    // 同一个视频元素可能被多次交接，用标记避免叠加监听器。
    if (video.__miniSync) {
      video.removeEventListener('timeupdate', video.__miniSync);
      video.removeEventListener('play', video.__miniSync);
      video.removeEventListener('pause', video.__miniSync);
    }
    const sync = () => {
      const total = video.duration || 0;
      progress.style.width = total ? `${((video.currentTime / total) * 100).toFixed(2)}%` : '0%';
      const button = root.querySelector('[data-mini="toggle"]');
      button.innerHTML = `<svg class="icon"><use href="#i-${video.paused ? 'play' : 'pause'}"/></svg>`;
    };
    video.__miniSync = sync;
    video.addEventListener('timeupdate', sync);
    video.addEventListener('play', sync);
    video.addEventListener('pause', sync);
    sync();
  },

  /** 把视频元素从迷你播放器取回，交给播放页复用。 */
  release() {
    const root = miniRoot();
    if (!root) return null;
    const video = root.querySelector('video');
    if (video) video.remove();
    root.hidden = true;
    this.active = false;
    playback.detached = false;
    this.restorePlaceholder();
    return video;
  },

  /** 恢复迷你播放器里的占位 <video>。 */
  restorePlaceholder() {
    const root = miniRoot();
    if (!root) return;
    if (root.querySelector('#mini-video')) return;
    if (root.querySelector('video')) return;
    const placeholder = document.createElement('video');
    placeholder.id = 'mini-video';
    placeholder.playsInline = true;
    root.querySelector('.mini__bar').before(placeholder);
  }
};


function initMiniControls() {
  const root = miniRoot();
  if (!root) return;
  root.addEventListener('click', (event) => {
    const action = event.target instanceof Element ? event.target.closest('[data-mini]')?.dataset.mini : null;
    if (!action) return;
    const video = root.querySelector('video');
    if (!video) return;
    if (action === 'toggle') {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    } else if (action === 'expand') {
      location.hash = `#/video/${playback.videoId}`;
    } else if (action === 'close') {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      root.hidden = true;
      mini.active = false;
      playback.videoId = null;
      playback.video = null;
      playback.detached = false;
      mini.restorePlaceholder();
    }
  });
}

initMiniControls();
