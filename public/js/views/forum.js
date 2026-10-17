/**
 * 论坛与帖子（只读）。
 *
 * 说明：Iwara 的论坛接口返回结构在不同版本里变过，这里对回复列表做了兼容：
 * 依次尝试 thread.posts / results / posts，取不到就明确说明，而不是白屏。
 */

import {
  fetchForumThread,
  fetchForumThreads,
  fetchPosts,
  formatCount,
  formatDate,
  iwara
} from '../api.js';
import { createFeed, lede, userLink } from '../cards.js';
import { linkify, raw, stateBlock, tpl } from '../ui.js';

/* ------------------------------------------------------------------ *
 * 公共行式列表
 * ------------------------------------------------------------------ */

function rowNode({ href, title, meta = [], tag, external = false }) {
  const parts = meta.filter((value) => value !== null && value !== undefined && value !== '');
  return tpl`
    <article class="rowitem">
      <div class="rowitem__main">
        ${href
          ? tpl`<a class="rowitem__title" href="${href}"${external ? raw(' target="_blank" rel="noopener noreferrer"') : ''}>${title}</a>`
          : tpl`<span class="rowitem__title">${title}</span>`}
        <div class="rowitem__meta">${parts.map((text) => tpl`<span>${text}</span>`)}</div>
      </div>
      ${tag ? tpl`<span class="rowitem__tag">${tag}</span>` : null}
    </article>`;
}

function threadNode(thread) {
  const id = thread.id || thread._id;
  const section = thread.section || thread.categoryId || thread.category?.id || 'general';
  const href = id ? `#/forum/${encodeURIComponent(section)}/${encodeURIComponent(id)}` : null;
  const author = thread.user?.name || thread.user?.username || '匿名';
  return rowNode({
    href,
    title: thread.title || '（无标题主题）',
    tag: thread.sticky ? '置顶' : thread.locked ? '已锁定' : section,
    meta: [
      author,
      thread.numPosts !== undefined ? `${formatCount(thread.numPosts)} 条回复` : '',
      thread.numViews !== undefined ? `${formatCount(thread.numViews)} 次浏览` : '',
      formatDate(thread.updatedAt || thread.createdAt)
    ]
  });
}

/* ------------------------------------------------------------------ *
 * 论坛列表
 * ------------------------------------------------------------------ */

export async function renderForum(ctx) {
  const head = lede({
    eyebrow: 'FORUM',
    title: '论坛',
    desc: 'Iwara 的社区讨论区。只读浏览，发言请到官网。'
  });
  const countNode = tpl`<span class="lede__count"></span>`;
  head.append(countNode);

  let sort = ctx.query.get('sort') === 'popular' ? 'popular' : 'latest';
  const chips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of [
    { id: 'latest', label: '最新回复' },
    { id: 'popular', label: '最多浏览' }
  ]) {
    chips.append(
      tpl`<a class="chip ${option.id === sort ? 'is-on' : ''}" href="#/forum?sort=${option.id}">${option.label}</a>`
    );
  }

  const feed = createFeed({
    columns: 'rowlist',
    limit: 32,
    render: (thread) => threadNode(thread),
    emptyTitle: '论坛暂时没有主题',
    emptyMessage: '过一会儿再来看看，或者去帖子列表转转。',
    fetchPage: async (page, limit) => {
      const data = await fetchForumThreads({ page, limit });
      if (page === 0) countNode.replaceChildren(tpl`<b>${formatCount(data?.count)}</b><br />个主题`);
      return data;
    }
  });
  if (feed.grid) feed.grid.style.gap = '0';
  ctx.onCleanup(() => feed.stop());

  const footer = tpl`
    <p class="desc" style="margin-top:22px">
      也可以看看 <a href="#/posts" style="color:var(--celadon)">帖子</a>——那是另一套更短的内容。
    </p>`;

  return tpl`<div>${head}${chips}${feed.element}${footer}</div>`;
}

/* ------------------------------------------------------------------ *
 * 分区
 * ------------------------------------------------------------------ */

export async function renderForumCategory(ctx, { category }) {
  const head = lede({
    eyebrow: 'FORUM',
    title: category,
    desc: '这个分区下的主题。'
  });
  const countNode = tpl`<span class="lede__count"></span>`;
  head.append(countNode);

  const feed = createFeed({
    columns: 'rowlist',
    limit: 32,
    render: (thread) => threadNode(thread),
    emptyTitle: '这个分区还没有主题',
    emptyMessage: '换个分区，或者回到论坛总表。',
    fetchPage: async (page, limit) => {
      const data = await fetchForumThreads({ page, limit, category });
      if (page === 0) countNode.replaceChildren(tpl`<b>${formatCount(data?.count)}</b><br />个主题`);
      return data;
    }
  });
  if (feed.grid) feed.grid.style.gap = '0';
  ctx.onCleanup(() => feed.stop());

  return tpl`<div>${head}${tpl`<p class="desc"><a href="#/forum" style="color:var(--celadon)">← 回到论坛总表</a></p>`}${feed.element}</div>`;
}

/* ------------------------------------------------------------------ *
 * 主题详情
 * ------------------------------------------------------------------ */

export async function renderForumThread(ctx, { category, threadId }) {
  let payload = null;
  let error = null;
  try {
    payload = await fetchForumThread(category, threadId);
  } catch (caught) {
    error = caught;
  }

  if (error && error.status !== 404) {
    return stateBlock({
      title: '主题打不开',
      message: error.message || '上游没有返回这个主题的内容。',
      error: true,
      action: { label: '重试', onClick: () => location.reload() }
    });
  }

  const thread = payload?.thread || payload?.post || payload || {};
  const replies = pickReplies(payload);

  const title = thread.title || '主题';
  const author = thread.user?.name || thread.user?.username || '匿名';
  const href = userLink(thread.user);

  const head = lede({
    eyebrow: 'THREAD',
    title,
    desc: `${author}${thread.createdAt ? ` · ${formatDate(thread.createdAt)}` : ''}${thread.numViews !== undefined ? ` · ${formatCount(thread.numViews)} 次浏览` : ''}`
  });

  const bodySource = thread.body || thread.content || thread.description || '';
  const bodyPanel = bodySource
    ? tpl`<div class="panel"><div class="panel__title">正文</div><div class="desc"></div></div>`
    : null;
  if (bodyPanel) bodyPanel.querySelector('.desc').append(linkify(stripHtml(bodySource)));

  const replyPanel = tpl`
    <div class="panel">
      <div class="panel__title">回复${replies.length ? ` · ${replies.length}` : ''}</div>
    </div>`;

  if (replies.length) {
    for (const reply of replies) {
      const replyAuthor = reply.user?.name || reply.user?.username || '匿名';
      const replyHref = userLink(reply.user);
      const node = tpl`
        <article class="comment">
          <div class="comment__body">
            <div class="comment__head">
              ${replyHref ? tpl`<a class="comment__name" href="${replyHref}">${replyAuthor}</a>` : tpl`<span class="comment__name">${replyAuthor}</span>`}
              <span class="comment__time">${formatDate(reply.createdAt)}</span>
            </div>
            <p class="comment__text"></p>
          </div>
        </article>`;
      node.querySelector('.comment__text').append(linkify(stripHtml(reply.body || reply.content || '')));
      replyPanel.append(node);
    }
  } else {
    replyPanel.append(
      tpl`<p class="desc">没有读到回复${
        payload ? '（上游这次返回的结构里没有回复列表）' : ''
      }。可以到 <a href="https://www.iwara.tv/forum/${encodeURIComponent(category)}/${encodeURIComponent(threadId)}" target="_blank" rel="noopener noreferrer" style="color:var(--celadon)">官网页面上看这一帖</a>。</p>`
    );
  }

  const back = tpl`<p class="desc"><a href="#/forum/${encodeURIComponent(category)}" style="color:var(--celadon)">← 回到 ${category}</a></p>`;

  return tpl`<div>${head}${back}${bodyPanel}${replyPanel}</div>`;
}

/** 从各种可能的结构里取出回复数组。 */
function pickReplies(payload) {
  if (!payload) return [];
  const candidates = [payload.results, payload.posts, payload.replies, payload.thread?.posts, payload.thread?.replies];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate;
  }
  return [];
}

/** 论坛正文可能带 HTML，粗剥一下标签再交给 linkify。 */
function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ *
 * 帖子
 * ------------------------------------------------------------------ */

export async function renderPosts(ctx) {
  const head = lede({
    eyebrow: 'POSTS',
    title: '帖子',
    desc: '比论坛主题更短的内容，通常是作者公告或随手分享。'
  });
  const countNode = tpl`<span class="lede__count"></span>`;
  head.append(countNode);

  const feed = createFeed({
    columns: 'rowlist',
    limit: 32,
    render: (post) => postNode(post),
    emptyTitle: '还没有帖子',
    emptyMessage: '过一会儿再来看看。',
    fetchPage: async (page, limit) => {
      const data = await fetchPosts({ page, limit });
      if (page === 0) countNode.replaceChildren(tpl`<b>${formatCount(data?.count)}</b><br />条帖子`);
      return data;
    }
  });
  if (feed.grid) feed.grid.style.gap = '0';
  ctx.onCleanup(() => feed.stop());

  return tpl`<div>${head}${feed.element}</div>`;
}

function postNode(post) {
  const href = userLink(post.user);
  const author = post.user?.name || post.user?.username || '匿名';
  const snippet = stripHtml(post.body || post.content || '').replace(/\s+/g, ' ').slice(0, 160);
  const node = tpl`
    <article class="rowitem">
      <div class="rowitem__main">
        <div class="rowitem__title">${post.title || '（无标题）'}</div>
        <div class="rowitem__meta">
          ${href ? tpl`<a href="${href}" style="color:var(--celadon)">${author}</a>` : tpl`<span>${author}</span>`}
          <span>${formatDate(post.createdAt)}</span>
          ${post.numViews !== undefined ? tpl`<span>${formatCount(post.numViews)} 次浏览</span>` : null}
        </div>
        ${snippet ? tpl`<p class="desc" style="margin:8px 0 0;font-size:13.5px">${snippet}${snippet.length >= 160 ? '…' : ''}</p>` : null}
      </div>
      <button class="btn btn--sm" type="button">展开</button>
    </article>`;

  const button = node.querySelector('button');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = '读取中…';
    try {
      const full = await iwara(`/post/${encodeURIComponent(post.id)}`);
      const body = stripHtml(full?.body || full?.content || full?.post?.body || '');
      const detail = tpl`<div class="desc"></div>`;
      detail.append(linkify(body || '这条帖子没有正文。'));
      node.querySelector('.rowitem__main').append(detail);
      button.remove();
    } catch (error) {
      button.disabled = false;
      button.textContent = '展开';
      node.querySelector('.rowitem__main').append(
        tpl`<p class="desc" style="color:var(--rose)">${error.message || '读取失败'}</p>`
      );
    }
  });

  return node;
}
