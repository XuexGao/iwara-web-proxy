/**
 * 收藏 / 观看历史 / 设置 / 关于。
 *
 * 收藏走 Iwara 账号接口（需要有效 Token）；观看历史是纯本机记录，
 * 存在 localStorage，不上传。设置页只改本机行为。
 */

import { coverUrl, fetchFavorites, formatCount, formatDate } from '../api.js';
import { lede, pageFromQuery, renderPagedFeed, workCard } from '../cards.js';
import router from '../router.js';
import {
  clearHistory,
  getHistory,
  getResume,
  getStorageState,
  getSession,
  getSetting,
  loadHistory,
  logout,
  onSessionChange,
  removeHistory,
  setSetting,
  setTheme
} from '../store.js';
import {
  SORT_LABELS,
  SORT_OPTIONS,
  confirmDialog,
  icon,
  skeletonGrid,
  stateBlock,
  toast,
  tpl
} from '../ui.js';

const RESUME_KEY = 'iwara.resume.v1';

/* ------------------------------------------------------------------ *
 * 公共片段
 * ------------------------------------------------------------------ */

/** 需要登录时的引导卡片（收藏等账号数据）。 */
function loginPrompt({ title, message }) {
  const enabled = getSession().loginEnabled;
  const node = tpl`
    <div class="state">
      <div class="state__title">${title}</div>
      <p>${message}</p>
    </div>`;
  const actions = tpl`<div style="display:flex;gap:9px;flex-wrap:wrap;justify-content:center"></div>`;
  if (enabled) {
    actions.append(tpl`<a class="btn btn--primary btn--sm" href="#/login">登录 Iwara 账号</a>`);
    actions.append(tpl`<a class="btn btn--sm" href="#/settings">改用自带 Token</a>`);
  } else {
    actions.append(tpl`<a class="btn btn--primary btn--sm" href="#/settings">去设置页填 Token</a>`);
  }
  node.append(actions);
  if (!enabled) {
    node.append(
      tpl`<div class="note" style="max-width:560px;text-align:left;margin-top:4px">这个实例没有配置 SESSION_SECRET，不开放账号密码登录；填一个自带的 access token 也能读收藏。</div>`
    );
  }
  return node;
}

function countLabel(node, count, unit) {
  node.replaceChildren(tpl`<b>${formatCount(count)}</b><br />${unit}`);
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export async function renderLibrary(ctx, params = {}) {
  return params.kind === 'history' ? await historyView(ctx) : favoritesView(ctx);
}

/* ------------------------------------------------------------------ *
 * 收藏
 * ------------------------------------------------------------------ */

const MEDIA = [
  { id: 'videos', label: '收藏的视频', type: 'video' },
  { id: 'images', label: '收藏的图库', type: 'image' }
];

/** 兼容 {results:[...]} 与直接数组，并剥掉 {video:{...}} / {image:{...}} 这层包装。 */
function favoriteItems(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
  return list
    .map((item) => (item && typeof item === 'object' ? item.video || item.image || item : item))
    .filter(Boolean);
}

function favoriteCount(data, fallback) {
  const count = Number(data?.count);
  return Number.isFinite(count) && count > 0 ? count : fallback;
}

function favoritesView(ctx) {
  const media = MEDIA.find((item) => item.id === ctx.query.get('media')) || MEDIA[0];
  const session = getSession();
  const inlineToken = String(getSetting('token') || '').trim();

  const countNode = tpl`<span class="lede__count"></span>`;
  const head = lede({
    eyebrow: 'LIBRARY · 我的收藏',
    title: media.label,
    desc: '列表直接来自 Iwara 账号，按收藏时间倒序。这里只读，不会改动你的收藏。'
  });
  head.append(countNode);

  const chips = tpl`<div class="chips"></div>`;
  for (const option of MEDIA) {
    chips.append(
      tpl`<a class="chip ${option.id === media.id ? 'is-on' : ''}" href="#/library/favorites${option.id === 'images' ? '?media=images' : ''}">${icon(option.type === 'image' ? 'grid' : 'play')}<span>${option.label}</span></a>`
    );
  }

  const host = tpl`<div></div>`;
  const root = tpl`<div>${head}${chips}${host}</div>`;

  if (!session.authenticated && !inlineToken) {
    host.replaceChildren(
      loginPrompt({
        title: '收藏需要登录 Iwara 账号',
        message: '收藏是账号数据，没有有效 Token 时上游会直接拒绝请求。登录后这里会显示你在 iwara.tv 上收藏的作品。'
      })
    );
    return root;
  }

  let feed = null;
  let stopped = false;
  ctx.onCleanup(() => {
    stopped = true;
    feed?.stop();
  });

  async function boot() {
    host.replaceChildren(skeletonGrid(8));

    let first;
    try {
      first = await fetchFavorites(media.id, { page: 0, limit: 32 });
    } catch (error) {
      if (stopped || ctx.signal.aborted) return;
      if (error?.status === 403 || error?.status === 401) {
        host.replaceChildren(
          loginPrompt({
            title: 'Iwara 拒绝了这次收藏请求',
            message: '读取收藏需要有效的登录状态。重新登录一次，或者到设置页换一个可用的自带 Token。'
          })
        );
        return;
      }
      host.replaceChildren(
        stateBlock({
          title: '收藏没取到',
          message: error?.message || '稍后再试。',
          error: true,
          action: { label: '重试', onClick: () => boot() }
        })
      );
      return;
    }
    if (stopped || ctx.signal.aborted) return;

    // 首屏已经拿到的这一页缓存下来，交给 createFeed 渲染，避免重复请求。
    const items = favoriteItems(first);
    const total = favoriteCount(first, items.length);
    countLabel(countNode, total, '件作品');

    if (!items.length) {
      host.replaceChildren(
        stateBlock({
          title: media.id === 'images' ? '收藏夹里还没有图库' : '收藏夹里还没有视频',
          message: '在作品页点一下收藏，这里就会出现；也可以切到上面另一个标签看看。'
        })
      );
      return;
    }

    const feed = renderPagedFeed({
      page: pageFromQuery(ctx.query),
      kind: media.type,
      hrefFor: (target) => `#/library/favorites?kind=${media.id}&page=${target + 1}`,
      emptyTitle: '收藏夹空了',
      emptyMessage: '在作品页点一下收藏，这里就会出现。',
      render: (item) => workCard(item, media.type),
      fetchPage: async (target, limit) => {
        if (target === 0) return { results: items, count: total, limit };
        const data = await fetchFavorites(media.id, { page: target, limit });
        return { results: favoriteItems(data), count: favoriteCount(data, total) };
      }
    });
    host.replaceChildren(feed);
  }

  boot();
  return root;
}

/* ------------------------------------------------------------------ *
 * 观看历史
 * ------------------------------------------------------------------ */

function historyCover(entry) {
  if (typeof entry?.cover === 'string' && entry.cover) return entry.cover;
  return coverUrl(entry?.cover || entry, entry?.kind === 'image' ? 'image' : 'video');
}

function historyRow(entry, { onRemove } = {}) {
  const isImage = entry.kind === 'image';
  const href = entry.id ? `#/${isImage ? 'image' : 'video'}/${encodeURIComponent(entry.id)}` : '#/';

  // 续播进度：有记录就把看到哪儿显示出来，比只写"看过"有用得多。
  const resume = !isImage && entry.id ? getResume(entry.id) : 0;
  const duration = Number(entry.duration) || 0;
  const percent = resume && duration ? Math.min(100, Math.round((resume / duration) * 100)) : 0;
  const resumeText = resume
    ? percent >= 96
      ? '已看完'
      : `看到 ${Math.floor(resume / 60)}:${String(Math.floor(resume % 60)).padStart(2, '0')}${percent ? ` · ${percent}%` : ''}`
    : '';

  const row = tpl`
    <article class="rowitem">
      <a class="rail__thumb" href="${href}">
        <img src="${historyCover(entry)}" alt="" loading="lazy" decoding="async" />
        ${resumeText ? tpl`<span class="card__dur">${resumeText}</span>` : null}
      </a>
      <div class="rowitem__main">
        <a class="rowitem__title" href="${href}">${entry.title || '未记录标题'}</a>
        <div class="rowitem__meta">
          <span>${entry.watchedAt ? formatDate(entry.watchedAt) : ''}</span>
          ${entry.author ? tpl`<span>${entry.author}</span>` : null}
          ${entry.rating === 'ecchi' ? tpl`<span class="badge badge--ecchi">R18</span>` : null}
        </div>
        ${percent ? tpl`<div class="historybar"><i style="width:${percent}%"></i></div>` : null}
      </div>
      <span class="rowitem__tag">${isImage ? '图库' : '视频'}</span>
      <button class="iconbtn" type="button" title="从历史中删除" aria-label="从历史中删除">
        ${icon('close')}
      </button>
    </article>`;

  row.querySelector('.iconbtn')?.addEventListener('click', (event) => {
    event.preventDefault();
    removeHistory(entry.id);
    if (onRemove) onRemove(row);
  });

  return row;
}

async function historyView(ctx) {
  const entries = await loadHistory();

  const countNode = tpl`<span class="lede__count"></span>`;
  countLabel(countNode, entries.length, '条记录');
  const head = lede({
    eyebrow: 'LIBRARY · 观看历史',
    title: '观看历史',
    desc: '只记录在这台设备上打开过的作品，不上传。数据存在浏览器本地，换设备或清理浏览器数据后不会再出现。'
  });
  head.append(countNode);

  const list = tpl`<div class="rowlist"></div>`;

  // 存储被禁时，历史必然一直是空的——直接说明原因，别让人反复刷新。
  const storage = getStorageState();
  if (!storage.ok) {
    const warn = tpl`
      <div class="note" style="border-left-color:var(--rose);margin-bottom:18px">
        <strong>这台浏览器不允许本站保存数据</strong><br />
        ${storage.reason}。所以观看历史会一直是空的，收藏以外的本机数据（续播位置、设置）也不会保留。
        退出无痕模式，或在浏览器设置里允许本站使用站点数据后再试。
      </div>`;
    head.after(warn);
  }

  if (!entries.length) {
    const empty = stateBlock({
      title: '还没有观看记录',
      message:
        '打开任意一个视频或图库，这里就会记下来，并保留你看到哪儿。记录只存在这台设备上，换设备或清理浏览器数据后不会再出现。'
    });
    const actions = tpl`
      <div style="display:flex;gap:9px;flex-wrap:wrap;justify-content:center;margin-top:4px">
        <a class="btn btn--primary btn--sm" href="#/">去首页挑一个</a>
        <a class="btn btn--sm" href="#/library/favorites">看我的收藏</a>
      </div>`;
    empty.append(actions);
    list.replaceChildren(empty);
    return tpl`<div>${head}${list}</div>`;
  }

  let visible = entries.length;
  const updateCount = () => {
    countLabel(countNode, visible, '条记录');
  };
  for (const entry of entries) {
    list.append(
      historyRow(entry, {
        onRemove: (row) => {
          row.remove();
          visible -= 1;
          updateCount();
          if (!visible) router.reload();
        }
      })
    );
  }

  const clearButton = tpl`<button class="btn btn--sm" type="button">${icon('close')}<span>清空历史</span></button>`;
  clearButton.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '清空观看历史？',
      message: '会删掉本机记录的全部观看条目。作品的收藏和续播位置都不受影响。',
      confirmText: '清空'
    });
    if (!ok) return;
    clearHistory();
    toast('观看历史已清空');
    router.reload();
  });

  const toolbar = tpl`<div style="display:flex;justify-content:flex-end;margin-bottom:4px">${clearButton}</div>`;
  return tpl`<div>${head}${toolbar}${list}</div>`;
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

const SWITCHES = [
  {
    key: 'r18',
    title: '显示 R18 内容',
    desc: '打开后列表请求会带上 rating=all，索引里会出现 ecchi 分级的作品；关掉只请求 general。'
  },
  {
    key: 'hoverPreview',
    title: '卡片悬停预览',
    desc: '鼠标停在视频封面上时，拉取 Iwara 的预览片段并静音播放。关掉后不会向 /api/sources 发这些额外请求，能省流量。'
  },
  {
    key: 'autoplay',
    title: '打开播放页自动播放',
    desc: '进入播放页立刻开始播放。浏览器仍可能拦截带声音的自动播放，那种情况下播放器会先静音再播。'
  },
  {
    key: 'autonext',
    title: '播完自动连播',
    desc: '当前视频播完后，自动切到相关作品列表里的下一个，接着往下看。'
  }
];

const QUALITY_OPTIONS = [
  { value: 'auto', label: '自动（按网络与设备）' },
  { value: 'Source', label: 'Source（原画）' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '540', label: '540p' },
  { value: '360', label: '360p' }
];

function switchRow({ key, title, desc }) {
  const toggle = tpl`<button class="toggle" type="button" role="switch" aria-label="${title}" aria-pressed="${String(!!getSetting(key))}"></button>`;
  toggle.addEventListener('click', () => {
    const next = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(next));
    setSetting(key, next);
  });
  return tpl`
    <div class="switch">
      <div class="switch__text">
        <strong>${title}</strong>
        <span>${desc}</span>
      </div>
      ${toggle}
    </div>`;
}

function selectRow({ label, hint, value, options, onChange }) {
  const select = tpl`<select class="input"></select>`;
  for (const option of options) {
    select.append(tpl`<option value="${option.value}">${option.label}</option>`);
  }
  select.value = value;
  if (!select.value) select.value = options[0].value;
  select.addEventListener('change', () => onChange(select.value));
  return tpl`
    <label class="field">
      <span>${label}</span>
      ${select}
      ${hint ? tpl`<span style="font-size:12.5px;color:var(--paper-3)">${hint}</span>` : null}
    </label>`;
}

function settingsPanel(title) {
  return tpl`<div class="panel"><div class="panel__title">${title}</div></div>`;
}

export async function renderSettings(ctx) {
  const head = lede({
    eyebrow: 'SETTINGS',
    title: '设置',
    desc: '这些开关只改这台设备上的行为，存在 localStorage，不会同步到 Iwara 账号。'
  });
  const root = tpl`<div>${head}</div>`;

  /* 浏览与播放 */
  const browsePanel = settingsPanel('浏览与播放');
  for (const item of SWITCHES) browsePanel.append(switchRow(item));
  root.append(browsePanel);

  /* 默认值 */
  const defaultsPanel = settingsPanel('默认值');
  const themeValue = ['system', 'dark', 'light'].includes(getSetting('theme'))
    ? getSetting('theme')
    : 'system';
  defaultsPanel.append(
    selectRow({
      label: '配色',
      hint: '选「跟随系统」时，系统切到浅色或深色会自动跟着变。顶部工具栏的按钮显示当前配色，点一下就切到另一种。',
      value: themeValue,
      options: [
        { value: 'system', label: '跟随系统' },
        { value: 'dark', label: '深色' },
        { value: 'light', label: '浅色' }
      ],
      onChange: (value) => {
        setTheme(value);
        // 顶部按钮的图标由 app.js 监听设置变更后刷新，这里不直接碰 DOM。
        const resolved = document.documentElement.dataset.theme;
        toast(
          value === 'system'
            ? `已改为跟随系统（当前${resolved === 'light' ? '浅色' : '深色'}）`
            : value === 'light'
              ? '已切换到浅色'
              : '已切换到深色'
        );
      }
    })
  );
  const sortValue = SORT_LABELS[getSetting('sort')] ? getSetting('sort') : SORT_OPTIONS[0].id;
  defaultsPanel.append(
    selectRow({
      label: '默认排序',
      hint: '首页和索引页没有带 sort 参数时用这一档；在页面上点排序会临时覆盖它。',
      value: sortValue,
      options: SORT_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
      onChange: (value) => {
        setSetting('sort', value);
        toast(`默认排序已改为「${SORT_LABELS[value] || value}」`);
      }
    })
  );
  const qualityValue = QUALITY_OPTIONS.some((option) => option.value === getSetting('quality'))
    ? getSetting('quality')
    : 'auto';
  defaultsPanel.append(
    selectRow({
      label: '默认清晰度',
      hint: '播放器优先选这一档；上游没有这一档时自动降级到最接近的清晰度。',
      value: qualityValue,
      options: QUALITY_OPTIONS,
      onChange: (value) => {
        setSetting('quality', value);
        toast(value === 'auto' ? '清晰度已改为自动' : `清晰度已固定为 ${value}`);
      }
    })
  );
  root.append(defaultsPanel);

  /* 自带 Token */
  const tokenPanel = settingsPanel('自带 Token（高级）');
  tokenPanel.append(
    tpl`<p class="desc" style="margin-bottom:12px">通常不需要填：用邮箱密码登录后，Token 由 Worker 加密保存在 HttpOnly Cookie 里，前端读不到。这一项留给两种情况——实例没有配置 SESSION_SECRET，或者你手上已经有一个可用的 access token。它只保存在本机 localStorage，请求时作为 X-Iwara-Token 头发给上游，删掉即失效。</p>`
  );

  const tokenStatus = tpl`<div class="desc" style="margin-bottom:12px"></div>`;
  function paintTokenStatus() {
    const saved = String(getSetting('token') || '').trim();
    tokenStatus.replaceChildren(
      saved
        ? tpl`当前已保存一个 Token（…${saved.length > 4 ? saved.slice(-4) : saved}，共 ${saved.length} 个字符），请求会带上它。`
        : tpl`当前没有保存 Token。`
    );
  }
  paintTokenStatus();
  tokenPanel.append(tokenStatus);

  const tokenInput = tpl`<input class="input" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴 access token（形如 eyJ… 的 JWT）" />`;
  tokenPanel.append(tpl`<label class="field"><span>Access Token</span>${tokenInput}</label>`);

  const saveToken = tpl`<button class="btn btn--primary btn--sm" type="button">保存 Token</button>`;
  const clearToken = tpl`<button class="btn btn--sm" type="button">清除 Token</button>`;
  tokenPanel.append(tpl`<div style="display:flex;gap:9px;flex-wrap:wrap">${saveToken}${clearToken}</div>`);
  tokenPanel.append(
    tpl`<p class="desc" style="margin-top:12px;font-size:13px;color:var(--paper-3)">格式：Iwara 的 access token，一般是一个 JWT——以 eyJ 开头的三段 base64，用 . 分隔。在浏览器里登录 iwara.tv 后，可以从开发者工具保存的 Cookie / 本地存储里找到它。Token 过期或被撤销后上游会返回 401 或 500，这时需要重新获取一个。</p>`
  );

  saveToken.addEventListener('click', () => {
    const value = tokenInput.value.trim();
    if (!value) {
      toast('先粘贴一个 Token', 'error');
      tokenInput.focus();
      return;
    }
    if (/\s/.test(value)) {
      toast('Token 里不应该有空格，检查复制是否完整', 'error');
      return;
    }
    setSetting('token', value);
    tokenInput.value = '';
    paintTokenStatus();
    toast('Token 已保存到本机');
  });

  clearToken.addEventListener('click', async () => {
    if (!String(getSetting('token') || '').trim()) {
      toast('当前没有保存 Token');
      return;
    }
    const ok = await confirmDialog({
      title: '清除自带 Token？',
      message: '清除后请求不再携带 X-Iwara-Token。用邮箱密码登录的会话不受影响。',
      confirmText: '清除'
    });
    if (!ok) return;
    setSetting('token', '');
    paintTokenStatus();
    toast('Token 已清除');
  });
  root.append(tokenPanel);

  /* 会话 */
  const sessionPanel = settingsPanel('会话');
  const sessionHost = tpl`<div></div>`;
  sessionPanel.append(sessionHost);

  function paintSession() {
    const session = getSession();
    if (session.authenticated && session.user) {
      const user = session.user;
      const row = tpl`
        <div class="switch">
          <div class="switch__text">
            <strong>${user.name || user.username || '已登录'}</strong>
            <span>@${user.username || ''} · 账号登录，Token 由服务端加密存在 HttpOnly Cookie 里</span>
          </div>
        </div>`;
      const quit = tpl`<button class="btn btn--sm" type="button">${icon('logout')}<span>退出登录</span></button>`;
      quit.addEventListener('click', async () => {
        quit.disabled = true;
        quit.querySelector('span').textContent = '正在退出…';
        await logout();
        toast('已退出登录');
      });
      row.append(quit);
      sessionHost.replaceChildren(row);
      return;
    }
    if (session.authenticated) {
      sessionHost.replaceChildren(
        tpl`<div class="switch"><div class="switch__text"><strong>已登录</strong><span>服务端有可用的会话，但没拿到账号信息；刷新页面再试一次。</span></div></div>`
      );
      return;
    }
    if (session.loginEnabled) {
      sessionHost.replaceChildren(
        tpl`
        <div class="switch">
          <div class="switch__text"><strong>未登录</strong><span>登录后可以搜索、看收藏与评论。</span></div>
          <a class="btn btn--primary btn--sm" href="#/login">登录 Iwara</a>
        </div>`
      );
      return;
    }
    sessionHost.replaceChildren(
      tpl`
      <div class="switch">
        <div class="switch__text"><strong>未登录</strong><span>这个实例没有配置 SESSION_SECRET，不开放账号密码登录；需要登录的功能请用上面的自带 Token。</span></div>
      </div>`
    );
  }
  paintSession();
  const offSession = onSessionChange(paintSession);
  ctx.onCleanup(offSession);
  root.append(sessionPanel);

  /* 存储 */
  const storagePanel = settingsPanel('存储');

  const historyRowNode = tpl`
    <div class="switch">
      <div class="switch__text">
        <strong>观看历史</strong>
        <span>本机现在记录了 ${formatCount(getHistory().length)} 条。清空后历史页会变空，收藏和续播位置不受影响。</span>
      </div>
    </div>`;
  const clearHistoryButton = tpl`<button class="btn btn--sm" type="button">清空历史</button>`;
  clearHistoryButton.addEventListener('click', async () => {
    if (!getHistory().length) {
      toast('本机还没有观看记录');
      return;
    }
    const ok = await confirmDialog({
      title: '清空观看历史？',
      message: '会删掉本机记录的全部观看条目。',
      confirmText: '清空'
    });
    if (!ok) return;
    clearHistory();
    toast('观看历史已清空');
    historyRowNode.querySelector('span').textContent = '本机现在记录了 0 条。清空后历史页会变空，收藏和续播位置不受影响。';
  });
  historyRowNode.append(clearHistoryButton);
  storagePanel.append(historyRowNode);

  const resumeRow = tpl`
    <div class="switch">
      <div class="switch__text">
        <strong>续播位置</strong>
        <span>记录每个视频看到第几秒，重新打开时会从那里接着播。清空后所有视频都从头开始。</span>
      </div>
    </div>`;
  const clearResumeButton = tpl`<button class="btn btn--sm" type="button">清空续播位置</button>`;
  clearResumeButton.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '清空续播位置？',
      message: '所有视频下次打开都会从头播放。观看历史不受影响。',
      confirmText: '清空'
    });
    if (!ok) return;
    // 续播位置没有单独的读写接口，直接删掉那个 key。
    localStorage.removeItem(RESUME_KEY);
    toast('续播位置已清空');
  });
  resumeRow.append(clearResumeButton);
  storagePanel.append(resumeRow);
  root.append(storagePanel);

  root.append(
    tpl`<div class="note" style="margin-top:22px">这些设置都存在这台设备的 localStorage 里。换浏览器或清掉站点数据后会回到默认值；自带 Token 在 localStorage 里是明文的，公用设备上不要保存。</div>`
  );

  return root;
}

/* ------------------------------------------------------------------ *
 * 关于
 * ------------------------------------------------------------------ */

export async function renderAbout(ctx) {
  const head = lede({
    eyebrow: 'ABOUT',
    title: '关于与部署',
    desc: '一个第三方只读前端：把 Iwara 的公开内容通过 Cloudflare Workers 转发，自己不留副本。'
  });

  const linkStyle = 'color:var(--celadon);text-decoration:underline';

  const prose = tpl`
    <div class="prose">
      <h3>这是什么</h3>
      <p>本站是 iwara.tv 的第三方只读前端，跑在 Cloudflare Workers 上。页面本身是浏览器直接加载的原生 ES 模块：没有构建步骤，也没有第三方前端依赖。</p>
      <p>视频、图库、作者、标签、论坛等内容都通过本站的 Worker 反向代理上游获得：接口走 <code>apiq.iwara.tv</code>，媒体文件走 <code>*.iwara.tv</code>。Worker 只做转发和短期缓存，不落盘保存任何作品，也不重新编码。</p>

      <h3>登录与凭据</h3>
      <ul>
        <li>用邮箱密码登录时，凭据由本站服务端直接发给 Iwara 换取 Token；Token 用 <code>SESSION_SECRET</code> 加密后写进 HttpOnly Cookie，页面脚本读不到它，也读不到你的密码。</li>
        <li>没有配置 <code>SESSION_SECRET</code> 的实例不会开放账号登录。这时可以在设置页填一个自带的 access token：它只存在你本机 localStorage，请求时以 <code>X-Iwara-Token</code> 头透传给上游。</li>
        <li>设置、观看历史和续播位置都只存在本机浏览器，不上传；本站也没有做用户画像或统计上报。</li>
      </ul>

      <h3>播放链路</h3>
      <ul>
        <li>打开播放页先请求 <code>/api/sources/&lt;id&gt;</code>：Worker 带上 <code>X-Version</code> 签名去问上游要播放清单，解析出各档清晰度的直链。</li>
        <li>播放器按你选的档位（默认自动）把 <code>&lt;video&gt;</code> 指向本站的 <code>/media/...</code> 地址，由 Worker 以 Range 分片的形式转发上游——拖动进度条时只会请求需要的那一段。</li>
        <li>清晰度清单会在 Worker 侧缓存几分钟，避免每次进页面都重新签名。</li>
      </ul>

      <h3>已知限制</h3>
      <ul>
        <li>Iwara 改版或轮换签名盐值后，<code>X-Version</code> 的计算可能失效，表现是取不到播放清单；这类问题只能等 Worker 侧更新后恢复。</li>
        <li>免费版 Cloudflare Workers 每天有请求数上限，访问量大的时候可能被限流。</li>
        <li>搜索接口在上游要求认证：没有有效 Token 时会直接返回 500，所以未登录就无法搜索。</li>
        <li>本站是只读前端，除了评论、收藏这类 Iwara 自己的接口之外，不提供上传或修改内容的能力。</li>
      </ul>

      <h3>版权</h3>
      <p>页面上的所有作品版权归原作者与 iwara.tv 所有。本站不主张任何权利，也不提供下载或再分发。如果某个内容有问题，请到 iwara.tv 上联系作者或站方处理。</p>

      <h3>参考项目</h3>
      <p>反代与签名方案的实现参考了下面两个项目，本站是独立部署的第三方项目，与它们以及与 iwara.tv 都没有隶属关系：</p>
      <ul>
        <li><a href="https://github.com/Iskongkongyo/iwaraVideoProxy" target="_blank" rel="noopener noreferrer" style="${linkStyle}">Iskongkongyo/iwaraVideoProxy</a></li>
        <li><a href="https://github.com/FoxSensei001/LoveIwara" target="_blank" rel="noopener noreferrer" style="${linkStyle}">FoxSensei001/LoveIwara</a></li>
      </ul>

      <p>碰到问题可以先看「设置」页：多数取不到内容的情况，要么是 Token 失效，要么是上游临时抖动。</p>
    </div>`;

  return tpl`<div>${head}${prose}</div>`;
}
