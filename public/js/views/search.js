/**
 * 搜索页：关键词 + 类型切换。
 *
 * Iwara 的 /search 在上游要求认证：没有有效 Token 时固定返回 500。
 * 所以未登录（也没有自带 Token）时这里不发请求，直接给出登录引导；
 * 关键词为空时用热门标签当搜索建议。
 */

import { fetchTags, formatCount, formatDate, search, tagLabel } from '../api.js';
import { lede, pageFromQuery, personCard, renderPagedFeed, workCard } from '../cards.js';
import router from '../router.js';
import { getSetting, getSession } from '../store.js';
import { icon, stateBlock, tpl } from '../ui.js';

/**
 * 搜索类型。
 *
 * ⚠️ 上游的 type 是**复数**：videos / images / users / posts / forum。
 * 传单数（video、image…）不会报错说明原因，而是直接返回
 * 500 {"message":"errors.serverError"} —— 这就是搜索"用不了"的原因。
 *
 * 另外 forum 这个值上游目前同样返回 500（服务端故障），
 * 前端单独标注，避免让人以为是本站的问题。
 */
const TYPES = [
  { id: 'videos', label: '视频' },
  { id: 'images', label: '图库' },
  { id: 'users', label: '作者' },
  { id: 'posts', label: '帖子' },
  { id: 'forum', label: '论坛', unsupported: true }
];

// 地址栏沿用旧短名，避免已分享的链接失效。
const TYPE_ALIASES = {
  video: 'videos',
  image: 'images',
  user: 'users',
  post: 'posts',
  forum: 'forum'
};

/** 把地址里的 type 归一成上游要求的复数形式。 */
function normalizeType(value) {
  const raw = String(value || '').trim();
  return TYPE_ALIASES[raw] || (TYPES.some((t) => t.id === raw) ? raw : 'videos');
}

/**
 * 各搜索板块支持的排序方式。
 *
 * 取值与 Iwara 上游一致（对齐参考客户端的 FilterConfig）：
 * - 视频 / 图库：date（最新）、relevance（相关性）、views（观看次数）、likes（点赞数）
 * - 作者 / 帖子 / 论坛：只有 date 与 relevance
 * 传上游不认的值不会报错，只会静默按默认排序，所以这里按板块收窄。
 */
const SORT_BY_TYPE = {
  videos: [
    { id: 'date', label: '最新' },
    { id: 'relevance', label: '相关性' },
    { id: 'views', label: '观看次数' },
    { id: 'likes', label: '点赞数' }
  ],
  images: [
    { id: 'date', label: '最新' },
    { id: 'relevance', label: '相关性' },
    { id: 'views', label: '观看次数' },
    { id: 'likes', label: '点赞数' }
  ],
  users: [
    { id: 'date', label: '最新' },
    { id: 'relevance', label: '相关性' }
  ],
  posts: [
    { id: 'date', label: '最新' },
    { id: 'relevance', label: '相关性' }
  ],
  forum: [
    { id: 'date', label: '最新' },
    { id: 'relevance', label: '相关性' }
  ]
};

const DEFAULT_SORT = 'date';

function sortsFor(type) {
  return SORT_BY_TYPE[type] || SORT_BY_TYPE.videos;
}

/** 归一 sort 参数：不属于该板块就退回默认值。 */
function normalizeSort(value, type) {
  const raw = String(value || '').trim();
  return sortsFor(type).some((o) => o.id === raw) ? raw : DEFAULT_SORT;
}

// 键与 TYPES 的 id 一致（复数）
const EMPTY = {
  videos: {
    title: '没有搜到匹配的视频',
    message: '换个关键词，或者把类型切到「图库」「作者」再试一次。'
  },
  images: {
    title: '没有搜到匹配的图库',
    message: '图库标题常常和视频不同，试试系列名、作者名或更短的词。'
  },
  users: {
    title: '没有搜到这位作者',
    message: '检查用户名拼写，或者改用作品标题搜索。'
  },
  posts: {
    title: '没有匹配的帖子',
    message: '换更宽泛的词，或者直接去论坛主题列表翻一翻。'
  },
  forum: {
    title: '论坛里没有相关主题',
    message: '论坛内容比作品少很多，换更宽泛的词试试。'
  }
};

/** 结果可能把作品包在 video / image / user / thread 字段里，统一取出来。 */
/**
 * 把结果条目归一成「真正的那个对象」。
 *
 * ⚠️ 不能顺手写 item.user：作品对象自己就有 user 字段（作者），
 * 那样会把整个作品替换成作者，标题就变成「无标题」——这个 bug 踩过。
 * 只有帖子/论坛这类"包了一层"的结果才需要拆，判据是外层没有 id 之外的业务字段。
 */
function unwrap(item) {
  if (!item || typeof item !== 'object') return item;
  // 作品/图库/用户本身已经是目标对象，直接返回
  if (item.title || item.file || item.thumbnail || (item.id && !item.video && !item.thread)) {
    return item;
  }
  return item.video || item.image || item.thread || item;
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
  if (type === 'users') return personCard(value);
  if (type === 'forum') return forumNode(value);
  if (type === 'posts') return postNode(value);
  return workCard(value, type === 'images' ? 'image' : 'video');
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
        tpl`<a class="tagchip" href="#/search?q=${encodeURIComponent(label)}&type=videos">${label}${tag.count ? tpl`<span class="chip__n">${formatCount(tag.count)}</span>` : null}</a>`
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
  // 统一成上游要求的复数形式（videos / images / users / posts / forum）
  const type = normalizeType(ctx.query.get('type'));
  const typeMeta = TYPES.find((t) => t.id === type) || TYPES[0];
  const sort = normalizeSort(ctx.query.get('sort'), type);
  const sortLabel = sortsFor(type).find((o) => o.id === sort)?.label || '';

  const session = getSession();
  const inlineToken = String(getSetting('token') || '').trim();
  // 共享 Token（服务端 IWARA_AUTHORIZATION）也能搜，所以要把这个也算进去，
  // 否则配了共享身份前端还是会显示"请先登录"。
  const canSearch = session.authenticated || !!inlineToken || !!session.sharedToken;

  const countNode = tpl`<span class="lede__count"></span>`;
  const head = lede({
    eyebrow: 'SEARCH',
    title: query ? `“${query}”` : '搜索',
    desc: query
      ? `正在按${typeMeta.label}搜索${sortLabel ? `，按${sortLabel}排序` : ''}。`
      : '输入作品标题、作者名或标签。搜索接口在上游要求认证，未登录时用不了。'
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
    const params = new URLSearchParams({ q: value, type, sort });
    router.navigate(`/search?${params.toString()}`);
  };
  form.addEventListener('submit', onSubmit);
  ctx.onCleanup(() => form.removeEventListener('submit', onSubmit));

  const chips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of TYPES) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    params.set('type', option.id);
    // 切板块时带上当前排序；新板块不支持时 normalizeSort 会退回默认值
    params.set('sort', normalizeSort(sort, option.id));
    chips.append(
      tpl`<a class="chip ${option.id === type ? 'is-on' : ''}" href="#/search?${params.toString()}">${option.label}</a>`
    );
  }

  /* 排序 chips：只列当前板块支持的排序方式（上游对不支持的值会静默忽略） */
  const sortChips = tpl`<div class="chips chips--scroll search__sorts"></div>`;
  for (const option of sortsFor(type)) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    params.set('type', type);
    params.set('sort', option.id);
    sortChips.append(
      tpl`<a class="chip ${option.id === sort ? 'is-on' : ''}" href="#/search?${params.toString()}">${option.label}</a>`
    );
  }

  const body = tpl`<div></div>`;

  if (!canSearch) body.append(loginGuide());

  if (!query) {
    body.append(tagsPanel(ctx));
  } else if (typeMeta.unsupported) {
    // 上游的 forum 搜索目前固定 500，直接说明，别让它看起来像本站故障
    body.append(
      stateBlock({
        title: '论坛搜索暂时不可用',
        message:
          'Iwara 的论坛搜索接口目前在服务端报错，视频、图库、作者、帖子都能搜。可以先按关键词搜帖子，或直接浏览论坛列表。'
      })
    );
  } else if (canSearch) {
    const isRow = type === 'posts';
    const page = pageFromQuery(ctx.query);
    const feed = renderPagedFeed({
      page,
      columns: type === 'users' ? 'grid--people' : isRow ? 'rowlist' : '',
      hrefFor: (target) => {
        const params = new URLSearchParams({ q: query, type, sort, page: String(target + 1) });
        return `#/search?${params.toString()}`;
      },
      emptyTitle: EMPTY[type].title,
      emptyMessage: EMPTY[type].message,
      render: (item) => resultNode(item, type),
      fetchPage: async (target, limit) => {
        const data = await search({ query, type, sort, page: target, limit });
        if (target === 0) {
          const count = Number(data?.count);
          countNode.replaceChildren(
            Number.isFinite(count) ? tpl`<b>${formatCount(count)}</b><br />条结果` : document.createTextNode('')
          );
        }
        return data;
      }
    });
    body.append(feed);
  }

  return tpl`<div>${head}${form}${chips}${sortChips}${body}</div>`;
}
