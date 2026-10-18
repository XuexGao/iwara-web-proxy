/**
 * 播放器：自建控件 + 进度条预览 + 清晰度切换 + 画中画 + 迷你播放器接力。
 *
 * 迷你播放器不是"另开一个播放器"，而是把同一个 <video> 元素搬到角落，
 * 所以切页面时缓冲和进度都不会丢。
 */

import { formatDuration } from './api.js';
import { getResume, getSetting, saveResume, setSetting } from './store.js';
import { icon, toast, tpl } from './ui.js';

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

  /* ---------------- 手势 ----------------
     桌面与移动的约定不同，必须分开：

     桌面  单击 = 暂停/继续   双击 = 全屏     长按 = 2 倍速
     移动  单击 = 显隐控制栏  双击 = 暂停/继续 长按 = 2 倍速

     移动端之所以单击不暂停：手指点一下就想暂停是最容易误触的设计，
     主流播放器（YouTube / B 站 / 抖音）都是单击唤起控件、双击才暂停。
     另外「双击退出视频」不是这里实现的——那是浏览器把双击当成了返回手势，
     所以移动端双击同时做 preventDefault，避免触发浏览器的翻页/返回。

     双击判定必须自己做延时窗口：原生 click 与 dblclick 一起绑定时，
     第一次点击会立刻触发单击动作，连点就变成「两次单击」。
  ---------------- */

  // 双击判定窗口。桌面用原生双击的手感（250ms 左右）；
  // 手机上两根手指落下的间隔普遍在 300–400ms，窗口太窄会把双击拆成两次单击，
  // 表现就是"双击没反应"。
  const DOUBLE_CLICK_DELAY = 300;
  const DOUBLE_CLICK_DELAY_TOUCH = 450;
  const LONG_PRESS_DELAY = 320;
  const MOVE_TOLERANCE = 12;

  let clickTimer = 0;
  let pressTimer = 0;
  let longPressing = false;
  let pressedAt = 0;
  let startPoint = null;
  let controlsPinned = false;
  let visibilityAtPress = true;
  // 用户主动点了隐藏：鼠标移动不该再唤醒控制栏。
  let userHiddenControls = false;
  // 用户第一次碰画面之前不自动隐藏：刚进页面控制栏就消失会让人以为播放器坏了。
  let userInteracted = false;

  const isTouchDevice = () =>
    window.matchMedia('(hover: none)').matches || navigator.maxTouchPoints > 0;

  function showGestureBadge(text) {
    let badge = element.querySelector('.player__gesture');
    if (!badge) {
      badge = tpl`<div class="player__gesture"></div>`;
      stage.append(badge);
    }
    badge.textContent = text;
    badge.classList.add('is-on');
    clearTimeout(badge.__timer);
    badge.__timer = setTimeout(() => badge.classList.remove('is-on'), 900);
  }

  function startBoost() {
    if (video.paused) return;
    longPressing = true;
    video.playbackRate = 2;
    element.classList.add('is-boosting');
    showGestureBadge('2× 快进中');
  }

  function stopBoost() {
    clearTimeout(pressTimer);
    if (!longPressing) return;
    longPressing = false;
    video.playbackRate = 1;
    element.classList.remove('is-boosting');
    showGestureBadge('恢复正常速度');
  }

  /**
   * 单击画面：切换控制栏显隐。
   *
   * 两端都用这一套（不只是移动端）：
   * - 显示 → 取消自动隐藏，并把用户"钉住"的意愿记下来；
   * - 隐藏 → 立刻淡出，并清掉自动隐藏定时器，避免 2.6 秒后又自己冒出来。
   *
   * 必须在 pointerdown 的 wake() 之后执行：wake 会无条件显示控制栏，
   * 所以这里要基于"切换后"的状态来决定，不能依赖点击前的状态。
   */
  function setControlsVisible(visible) {
    clearTimeout(hideTimer);
    element.classList.toggle('is-hidden-controls', !visible);
    element.classList.toggle('is-controls-pinned', visible);
    controlsPinned = visible;
    // 记录"这是用户主动隐藏的"，避免鼠标移动把它唤醒。
    userHiddenControls = !visible;
  }

  function toggleControls() {
    setControlsVisible(element.classList.contains('is-hidden-controls'));
  }

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('.player__controls, .quality')) return;

    pressedAt = Date.now();
    startPoint = { x: event.clientX, y: event.clientY };
    // 记下点击前的显隐状态：中间可能被自动隐藏或 wake 改动，
    // 到 pointerup 时再读就不准了。
    visibilityAtPress = !element.classList.contains('is-hidden-controls');
    userInteracted = true;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(startBoost, LONG_PRESS_DELAY);
  };

  const onPointerMove = (event) => {
    if (!startPoint) return;
    const moved =
      Math.abs(event.clientX - startPoint.x) > MOVE_TOLERANCE ||
      Math.abs(event.clientY - startPoint.y) > MOVE_TOLERANCE;
    // 手指滑动（想拖进度）时不该被当成"长按"
    if (moved) {
      clearTimeout(pressTimer);
      if (longPressing) stopBoost();
    }
  };

  const onPointerUp = (event) => {
    if (!startPoint) return;
    const heldLong = longPressing;
    const elapsed = Date.now() - pressedAt;
    startPoint = null;
    clearTimeout(pressTimer);

    if (heldLong) {
      stopBoost();
      return;
    }
    // 按住太久但没进入加速（刚好卡在阈值上），也不当作点击
    if (elapsed > LONG_PRESS_DELAY + 120) return;
    if (event.target instanceof Element && event.target.closest('.player__controls, .quality')) return;

    const touch = isTouchDevice();

    // 第二次点击 = 双击
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = 0;
      // 双击：移动端暂停/继续，桌面全屏。
      if (touch) {
        event.preventDefault();
        toggle();
      } else {
        toggleFullscreen();
      }
      return;
    }

    // 单击：两端都是显隐控制栏。暂停/继续交给双击与播放按钮。
    const target = !visibilityAtPress;
    clickTimer = setTimeout(
      () => {
        clickTimer = 0;
        setControlsVisible(target);
        // 手动显示后重新开始自动隐藏计时；手动隐藏则保持隐藏。
        if (target) scheduleHide();
      },
      touch ? DOUBLE_CLICK_DELAY_TOUCH : DOUBLE_CLICK_DELAY
    );
  };

  hit.addEventListener('pointerdown', onPointerDown);
  hit.addEventListener('pointermove', onPointerMove);
  hit.addEventListener('pointerup', onPointerUp);
  hit.addEventListener('pointercancel', () => {
    startPoint = null;
    clearTimeout(pressTimer);
    if (longPressing) stopBoost();
  });
  hit.addEventListener('pointerleave', () => {
    startPoint = null;
    clearTimeout(pressTimer);
    if (longPressing) stopBoost();
  });

  // 移动端点一下画面不该被当成"长按选文字"，双击也不该缩放/返回。
  hit.addEventListener('touchstart', (event) => {
    if (event.touches.length > 1) return;
  }, { passive: true });
  hit.addEventListener('dblclick', (event) => event.preventDefault());
  hit.addEventListener('contextmenu', (event) => event.preventDefault());

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
    // 拖动开始量一次，拖动过程中不再重复测量。
    scrubRect = scrub.getBoundingClientRect();
    scrub.setPointerCapture(event.pointerId);
    seekToRatio(ratioFromEvent(event));
  });
  /* 拖动时的性能要点：
     1. 不要在 pointermove 里反复 getBoundingClientRect（会强制同步布局，
        每秒几百次必然掉帧）。开始拖动时量一次，缓存起来。
     2. 用一个 rAF 合并多次 pointermove，一帧只改一次样式。 */
  let scrubRect = null;
  let pendingRatio = null;
  let rafId = 0;

  function flushScrub() {
    rafId = 0;
    if (pendingRatio === null) return;
    const ratio = pendingRatio;
    pendingRatio = null;
    if (scrubbing) seekToRatio(ratio);

    if (preview?.url && scrubRect) {
      const width = peek.offsetWidth || 168;
      const stageRect = stage.getBoundingClientRect();
      const x = Math.min(
        Math.max(scrubRect.left - stageRect.left + scrubRect.width * ratio - width / 2, 6),
        stageRect.width - width - 6
      );
      peek.style.transform = `translate3d(${Math.round(x)}px, 0, 0)`;
      peek.style.left = '0';
      peek.classList.add('is-on');
      peek.querySelector('span').textContent = formatDuration(ratio * (video.duration || 0));
      const peekVideo = peek.querySelector('video');
      if (peekVideo?.duration) {
        try {
          peekVideo.currentTime = ratio * peekVideo.duration;
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  scrub.addEventListener('pointermove', (event) => {
    if (!scrubRect) scrubRect = scrub.getBoundingClientRect();
    pendingRatio = Math.min(
      1,
      Math.max(0, (event.clientX - scrubRect.left) / (scrubRect.width || 1))
    );
    if (!rafId) rafId = requestAnimationFrame(flushScrub);
  });
  const endScrub = () => {
    scrubbing = false;
    scrubRect = null;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    pendingRatio = null;
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
    const supported = typeof video.requestPictureInPicture === 'function';
    if (!supported) {
      // 之前这里是静默失败，点了没反应最容易被当成 bug。
      // 明确说出原因：iOS Safari 就一直不支持网页画中画，只能用全屏。
      toast('这个浏览器不支持网页画中画，可以改用全屏（或点视频右上角）', 'error', 4200);
      return;
    }
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        // 画中画要求视频正在播放，且不能是静音占位状态
        if (video.readyState < 1) {
          toast('视频还没就绪，稍等一下再试', 'error');
          return;
        }
        await video.requestPictureInPicture();
      }
    } catch (error) {
      const reason = String(error?.message || '');
      toast(
        reason.toLowerCase().includes('not allowed') || error?.name === 'NotAllowedError'
          ? '浏览器拒绝了画中画，先点一下视频开始播放再试'
          : '画中画打开失败，可以改用全屏',
        'error',
        4200
      );
    }
  });

  /* ---------------- 播放器事件 ---------------- */

  video.addEventListener('play', () => {
    updateToggleIcon();
    playback.video = video;
    element.classList.remove('is-paused');
    if (userInteracted) scheduleHide();
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
    if (!userInteracted) return;
    hideTimer = setTimeout(() => {
      if (!video.paused && !controlsPinned) element.classList.add('is-hidden-controls');
    }, 2600);
  }

  // 鼠标移动时临时唤出控制栏。单击由 toggleControls 负责真显隐，
  // 这里不能无条件显示，否则"再次单击隐藏"会立刻被下一帧的 pointermove 推翻。
  /**
   * 鼠标在画面上移动时临时唤出控制栏。
   *
   * 关键：用户用单击主动隐藏之后（controlsPinned === false 且 userInteracted），
   * 不能再因为 mouseover 把它唤醒——否则"单击隐藏"会在下一帧被 pointermove
   * 推翻，表现为点了没反应。所以这里只处理"自动隐藏"状态下的唤醒，
   * 主动隐藏后必须再点一次才回来。
   */
  const wake = () => {
    if (userHiddenControls) return;
    element.classList.remove('is-hidden-controls');
    if (!video.paused) scheduleHide();
  };

  stage.addEventListener('pointermove', wake);
  stage.addEventListener('pointerdown', () => {
    // 点画面时清掉自动隐藏，把是否显示完全交给 toggleControls。
    clearTimeout(hideTimer);
  });
  element.addEventListener('focusin', () => clearTimeout(hideTimer));
  element.addEventListener('focusout', () => {
    if (!video.paused) scheduleHide();
  });

  /* ---------------- 全屏 ---------------- */

  // 全屏时元素本身是全屏的，控制栏必须仍在它内部（stage 是 .player 的子级），
  // 所以只需保证全屏切换后控制栏可交互、不被 is-hidden-controls 卡住。
  const onFullscreenChange = () => {
    const isFull = !!document.fullscreenElement;
    element.classList.toggle('is-fullscreen', isFull);
    if (isFull) {
      // 进全屏时先把控制栏亮出来，让用户知道可以点。
      element.classList.remove('is-hidden-controls');
      controlsPinned = false;
      element.classList.remove('is-controls-pinned');
      clearTimeout(hideTimer);
      scheduleHide();
    } else {
      element.classList.remove('is-hidden-controls');
      clearTimeout(hideTimer);
    }
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

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
      document.removeEventListener('fullscreenchange', onFullscreenChange);
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
