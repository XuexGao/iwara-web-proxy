/**
 * 搜索页：关键词 + 类型切换。
 *
 * Iwara 的 /search 在上游要求认证：没有有效 Token 时固定返回 500。
 * 所以未登录（也没有自带 Token）时这里不发请求，直接给出登录引导；
 * 关键词为空时用热门标签当搜索建议。
 */

import { fetchTags, formatCount, formatDate, search, tagLabel } from '../api.js';
import { createFeed, lede, personCard, workCard } from '../cards.js';
import router from '../router.js';
import { getSetting, getSession } from '../store.js';
import { icon, stateBlock, tpl } from '../ui.js';

const TYPES = [
  { id: 'video', label: '视频' },
  { id: 'image', label: '图库' },
  { id: 'user', label: '作者' },
  { id: 'forum', label: '论坛' },
  { id: 'post', label: '帖子' }
];

const TYPE_LABELS = Object.fromEntries(TYPES.map((item) => [item.id, item.label]));

const EMPTY = {
  video: {
    title: '没有搜到匹配的视频',
    message: '换个关键词，或者把类型切到「图库」「作者」再试一次。'
  },
  image: {
    title: '没有搜到匹配的图库',
    message: '图库标题常常和视频不同，试试系列名、作者名或更短的词。'
  },
  user: {
    title: '没有搜到这位作者',
    message: '检查用户名拼写，或者改用作品标题搜索。'
  },
  forum: {
    title: '论坛里没有相关主题',
    message: '论坛内容比作品少很多，换更宽泛的词试试。'
  },
  post: {
    title: '没有匹配的帖子',
    message: '换更宽泛的词，或者直接去论坛主题列表翻一翻。'
  }
};

/** 结果可能把作品包在 video / image / user / thread 字段里，统一取出来。 */
function unwrap(item) {
  if (!item || typeof item !== 'object') return item;
  return item.video || item.image || item.user || item.thread || item;
}

/* ------------------------------------------------------------------ *
 * 行式结果（论坛主题 / 帖子）
 * ------------------------------------------------------------------ */

function rowNode({ href, title, meta, tag }) {
  const parts = (meta || []).filter(Boolean);
  return tpl`
    <article class="rowitem">
      <div class="rowitem__main">
        ${href
          ? tpl`<a class="rowitem__title" href="${href}">${title}</a>`
          : tpl`<span class="rowitem__title">${title}</span>`}
        <div class="rowitem__meta">
          ${parts.map((text) => tpl`<span>${text}</span>`)}
        </div>
      </div>
      ${tag ? tpl`<span class="rowitem__tag">${tag}</span>` : null}
    </article>`;
}

function forumNode(item) {
  const id = item.id || item.threadId;
  const category = item.categoryId || item.category?.id || (typeof item.category === 'string' ? item.category : '');
  const href = id && category ? `#/forum/${encodeURIComponent(category)}/${encodeURIComponent(id)}` : '#/forum';
  return rowNode({
    href,
    title: item.title || '（无标题主题）',
    meta: [item.user?.name || item.user?.username || '', item.createdAt ? formatDate(item.createdAt) : ''],
    tag: '论坛主题'
  });
}

function postNode(item) {
  const thread = item.thread || {};
  const threadId = item.threadId || thread.id;
  const category =
    item.categoryId || thread.categoryId || thread.category?.id || (typeof thread.category === 'string' ? thread.category : '');
  const href = threadId && category ? `#/forum/${encodeURIComponent(category)}/${encodeURIComponent(threadId)}` : '#/posts';
  const body = String(item.body || item.content || '')
    .replace(/\s+/g, ' ')
    .trim();
  const snippet = body.length > 120 ? `${body.slice(0, 120)}…` : body;
  return rowNode({
    href,
    title: item.title || snippet || '（无标题帖子）',
    meta: [
      item.user?.name || item.user?.username || '',
      item.createdAt ? formatDate(item.createdAt) : '',
      item.title ? snippet : ''
    ],
    tag: '帖子'
  });
}

function resultNode(item, type) {
  const value = unwrap(item);
  if (!value || typeof value !== 'object') return rowNode({ title: '无法识别的结果条目', meta: [] });
  if (type === 'user') return personCard(value);
  if (type === 'forum') return forumNode(value);
  if (type === 'post') return postNode(value);
  return workCard(value, type === 'image' ? 'image' : 'video');
}

/* ------------------------------------------------------------------ *
 * 登录引导
 * ------------------------------------------------------------------ */

function loginGuide() {
  const enabled = getSession().loginEnabled;
  const node = tpl`
    <div class="state">
      <div class="state__title">搜索需要登录 Iwara 账号</div>
      <p>Iwara 的搜索接口要求认证：上游在没有有效 Token 时会直接返回 500，这不是本站的故障。登录后搜索会以你的账号身份发出。</p>
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
      tpl`<div class="note" style="max-width:560px;text-align:left;margin-top:4px">这个实例没有配置 SESSION_SECRET，不开放账号密码登录。你可以在设置页填入自带的 access token：它只保存在本机浏览器，请求时作为 X-Iwara-Token 透传给上游。</div>`
    );
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * 热门标签（搜索建议）
 * ------------------------------------------------------------------ */

function tagsPanel(ctx) {
  const body = tpl`<div></div>`;
  const panel = tpl`
    <div class="panel">
      <div class="panel__title">热门标签</div>
      ${body}
    </div>`;

  async function load() {
    body.replaceChildren(stateBlock({ title: '正在读取热门标签', message: '标签来自 Iwara 的公开接口，不需要登录。' }));
    let data;
    try {
      data = await fetchTags({ sort: 'popularity', limit: 30 });
    } catch (error) {
      if (ctx.signal.aborted) return;
      body.replaceChildren(
        stateBlock({
          title: '热门标签没取到',
          message: error?.message || '稍后再试。',
          error: true,
          action: { label: '重试', onClick: load }
        })
      );
      return;
    }
    if (ctx.signal.aborted) return;

    const list = (Array.isArray(data) ? data : data?.results || []).filter((tag) => tag?.id);
    if (!list.length) {
      body.replaceChildren(
        stateBlock({ title: '暂时没有拿到标签', message: '可以直接在上面的输入框里搜关键词。' })
      );
      return;
    }

    const row = tpl`<div class="chips"></div>`;
    for (const tag of list) {
      const label = tagLabel(tag.id);
      row.append(
        tpl`<a class="tagchip" href="#/search?q=${encodeURIComponent(label)}&type=video">${label}${tag.count ? tpl`<span class="chip__n">${formatCount(tag.count)}</span>` : null}</a>`
      );
    }
    body.replaceChildren(row);
  }

  load();
  return panel;
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

export async function renderSearch(ctx) {
  const query = (ctx.query.get('q') || '').trim();
  let type = ctx.query.get('type') || 'video';
  if (!TYPE_LABELS[type]) type = 'video';

  const session = getSession();
  const inlineToken = String(getSetting('token') || '').trim();
  const canSearch = session.authenticated || !!inlineToken;

  const countNode = tpl`<span class="lede__count"></span>`;
  const head = lede({
    eyebrow: 'SEARCH',
    title: query ? `“${query}”` : '搜索',
    desc: query
      ? `正在按${TYPE_LABELS[type]}搜索。请求由 Worker 带你的 Token 发给 Iwara 上游。`
      : '输入作品标题、作者名或标签。搜索接口在上游要求认证，所以未登录时用不了。'
  });
  head.append(countNode);

  const input = tpl`<input class="input" type="search" name="q" value="${query}" placeholder="作品标题、作者名或标签…" autocomplete="off" enterkeyhint="search" aria-label="搜索关键词" />`;
  const form = tpl`
    <form role="search" style="display:flex;gap:10px;align-items:center;margin-bottom:16px">
      ${input}
      <button class="btn btn--primary" type="submit">${icon('search')}<span>搜索</span></button>
    </form>`;

  const onSubmit = (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) {
      router.navigate('/search');
      return;
    }
    router.navigate(`/search?q=${encodeURIComponent(value)}&type=${type}`);
  };
  form.addEventListener('submit', onSubmit);
  ctx.onCleanup(() => form.removeEventListener('submit', onSubmit));

  const chips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of TYPES) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    params.set('type', option.id);
    chips.append(
      tpl`<a class="chip ${option.id === type ? 'is-on' : ''}" href="#/search?${params.toString()}">${option.label}</a>`
    );
  }

  const body = tpl`<div></div>`;

  if (!canSearch) body.append(loginGuide());

  if (!query) {
    body.append(tagsPanel(ctx));
  } else if (canSearch) {
    const isRow = type === 'forum' || type === 'post';
    const feed = createFeed({
      columns: type === 'user' ? 'grid--people' : isRow ? 'rowlist' : '',
      limit: 32,
      emptyTitle: EMPTY[type].title,
      emptyMessage: EMPTY[type].message,
      render: (item) => resultNode(item, type),
      fetchPage: async (page, limit) => {
        const data = await search({ query, type, page, limit });
        if (page === 0) {
          const count = Number(data?.count);
          countNode.replaceChildren(
            Number.isFinite(count) ? tpl`<b>${formatCount(count)}</b><br />条结果` : document.createTextNode('')
          );
        }
        return data;
      }
    });
    // createFeed 的容器默认是 .grid；论坛/帖子要单列列表，复用已有的 .rowlist
    //（它在 app.css 里排在 .grid 之后，display: flex 会覆盖掉 grid）。
    if (isRow) feed.grid.style.gap = '0';
    body.append(feed.element);
    ctx.onCleanup(() => feed.stop());
  }

  return tpl`<div>${head}${form}${chips}${body}</div>`;
}
