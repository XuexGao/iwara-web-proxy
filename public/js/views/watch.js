/**
 * 播放页，版式参照 B 站：
 *
 *   左栏：播放器 → 标题 → 数据与操作 → 作品说明 → 标签 → 评论
 *   右栏：作者（头像 + 关注 + 简介）→ 相关作品
 *
 * 离开页面即停止播放（早期版本会把视频交给右下角小窗继续播，
 * 返回后还能听到声音，已移除）。
 */

import {
  avatarUrl,
  coverUrl,
  fetchComments,
  fetchProfile,
  fetchRelated,
  fetchVideo,
  followUser,
  formatCount,
  formatDate,
  formatSize,
  getSources,
  likeVideo,
  postComment
} from '../api.js';
import { commentNode, pager, railItem, tagRow, userLink } from '../cards.js';
import { createPlayer, playback } from '../player.js';
import { getResume, getSession, getSetting, recordHistory } from '../store.js';
import { icon, linkifyNode, openModal, stateBlock, toast, toastError, tpl } from '../ui.js';

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export async function renderWatch(ctx, { id }) {
  const holder = { player: null, meta: { id, title: '', author: '' }, finished: false, disposed: false };
  const root = tpl`<div></div>`;

  ctx.onCleanup(() => {
    holder.disposed = true;
    // 离开播放页就停止播放：之前会把视频交给右下角的小窗继续播，
    // 返回上一页还能听到声音，体验很糟。这里直接销毁。
    holder.player?.destroy();
    playback.videoId = null;
    playback.video = null;
    playback.detached = false;
  });

  load(ctx, id, root, holder).catch((error) => {
    if (holder.disposed) return;
    root.replaceChildren(
      stateBlock({
        title: '打不开这个作品',
        message: error?.message || '请稍后重试。',
        error: true,
        action: { label: '重试', onClick: () => location.reload() }
      })
    );
  });

  return root;
}

/* ------------------------------------------------------------------ *
 * 主体
 * ------------------------------------------------------------------ */

async function load(ctx, id, root, holder) {
  root.replaceChildren(loadingShell());

  const detailPromise = fetchVideo(id);
  const sourcesPromise = getSources(id).catch((error) => ({ error }));

  const detail = await detailPromise;
  const sourceData = await sourcesPromise;

  if (ctx.signal.aborted || holder.disposed) return;

  const title = detail.title || '无标题作品';
  const authorName = detail.user?.name || detail.user?.username || '匿名';
  holder.meta.title = title;
  holder.meta.author = authorName;

  // 打开就算看过：放到这里而不是播放器创建之后，
  // 这样即使取流失败、用户马上离开，历史里也会留下这条。
  recordHistory({
    id,
    title,
    kind: 'video',
    author: authorName,
    rating: detail.rating,
    duration: Number(detail.file?.duration) || 0,
    cover: {
      file: detail.file,
      thumbnail: detail.thumbnail,
      customThumbnail: detail.customThumbnail
    }
  });

  /* ---------------- 播放器 ---------------- */

  const resume = getResume(id);
  let player = null;

  const playerHost = tpl`<div></div>`;

  if (sourceData?.error) {
    playerHost.append(
      stateBlock({
        title: '暂时无法播放',
        message: sourceData.error.message || '没有取到可用的播放地址。',
        error: true,
        action: {
          label: '重新获取',
          onClick: async () => {
            playerHost.replaceChildren(tpl`<div class="skeleton" style="aspect-ratio:16/9"></div>`);
            try {
              const fresh = await getSources(id, { fresh: true });
              playerHost.replaceChildren(buildPlayerHost(fresh));
            } catch (error) {
              playerHost.replaceChildren(
                stateBlock({ title: '还是不行', message: error.message, error: true })
              );
            }
          }
        }
      })
    );
  } else {
    playerHost.replaceChildren(buildPlayerHost(sourceData));
  }

  function buildPlayerHost(data) {
    if (ctx.signal.aborted || holder.disposed) return tpl`<div></div>`;
    player = createPlayer({
      sources: data.sources || [],
      preview: data.preview,
      meta: { id, title, author: authorName },
      poster: coverUrl(detail, 'video'),
      startAt: resume,
      autoplay: getSetting('autoplay'),
      onEnded: () => {
        holder.finished = true;
        if (!getSetting('autonext')) return;
        const first = relatedItems[0];
        if (first) {
          toast('自动播放下一部');
          location.hash = `#/video/${first.id}`;
        }
      },
      onRequestRefresh: async (time) => {
        try {
          const fresh = await getSources(id, { fresh: true });
          const wanted = player.currentSource?.name;
          const target =
            fresh.sources.find((item) => item.name === wanted) || fresh.sources[0];
          if (!target) return false;
          player.video.src = target.url;
          player.video.addEventListener(
            'loadedmetadata',
            () => {
              try {
                player.video.currentTime = time;
              } catch {
                /* 忽略 */
              }
              player.video.play().catch(() => {});
            },
            { once: true }
          );
          player.video.load();
          return true;
        } catch (error) {
          toastError(error, '刷新播放地址失败');
          return false;
        }
      }
    });

    holder.player = player;
    playback.videoId = id;
    playback.video = player.video;

    return player.element;
  }

  /* ---------------- 头部信息 ---------------- */

  const stats = tpl`
    <div class="watch__stats">
      <span>${icon('eye')} ${formatCount(detail.numViews)} 次播放</span>
      <span>${icon('heart')} ${formatCount(detail.numLikes)}</span>
      <span>${icon('comment')} ${formatCount(detail.numComments)}</span>
      ${detail.rating === 'ecchi' ? tpl`<span class="badge badge--ecchi">R18</span>` : null}
      ${detail.file?.size ? tpl`<span>${formatSize(detail.file.size)}</span>` : null}
      <span>${formatDate(detail.createdAt)}</span>
    </div>`;

  const likeButton = tpl`
    <button class="btn" type="button">
      ${icon('heart')}<span>${detail.liked ? '已喜欢' : '喜欢'}</span>
      <span class="card__stat">${formatCount(detail.numLikes)}</span>
    </button>`;
  if (detail.liked) likeButton.classList.add('btn--primary');

  let liked = !!detail.liked;
  let likeCount = Number(detail.numLikes) || 0;
  let likeBusy = false;

  likeButton.addEventListener('click', async () => {
    if (likeBusy) return;
    if (!getSession().authenticated && !getSetting('token')) {
      toast('登录后才能喜欢作品', 'error');
      location.hash = '#/login';
      return;
    }
    likeBusy = true;
    const next = !liked;
    liked = next;
    likeCount += next ? 1 : -1;
    paintLike();
    try {
      await likeVideo(id, next);
    } catch (error) {
      liked = !next;
      likeCount += next ? -1 : 1;
      paintLike();
      toastError(error, '操作失败');
    } finally {
      likeBusy = false;
    }
  });

  function paintLike() {
    likeButton.classList.toggle('btn--primary', liked);
    likeButton.querySelector('span').textContent = liked ? '已喜欢' : '喜欢';
    likeButton.querySelector('.card__stat').textContent = formatCount(likeCount);
  }

  const downloadButton = tpl`<button class="btn" type="button">${icon('download')}<span>下载</span></button>`;
  downloadButton.addEventListener('click', () => openDownload(sourceData, title));

  const copyButton = tpl`<button class="btn btn--ghost" type="button">${icon('list')}<span>复制链接</span></button>`;
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('链接已复制');
    } catch {
      toast('当前浏览器不允许读取剪贴板', 'error');
    }
  });

  const refreshButton = tpl`<button class="btn btn--ghost btn--icon" type="button" title="重新获取播放地址">${icon('clock')}</button>`;
  refreshButton.addEventListener('click', async () => {
    refreshButton.disabled = true;
    try {
      const fresh = await getSources(id, { fresh: true });
      const time = player?.currentTime || 0;
      playerHost.replaceChildren(buildPlayerHost(fresh));
      if (time > 0) {
        player.video.currentTime = time;
      }
      toast('播放地址已刷新');
    } catch (error) {
      toastError(error, '刷新失败');
    } finally {
      refreshButton.disabled = false;
    }
  });

  /* ---------------- 作者栏 ---------------- */

  const authorBar = buildAuthorBar(detail.user);

  /* ---------------- 简介与标签 ---------------- */

  const bodyPanel = detail.body
    ? tpl`
      <div class="panel">
        <div class="panel__title">作品说明</div>
        <div class="desc is-clamped"></div>
      </div>`
    : null;
  if (bodyPanel) {
    const desc = bodyPanel.querySelector('.desc');
    desc.append(linkifyInto(detail.body));
    desc.addEventListener('click', () => desc.classList.toggle('is-clamped'));
  }

  /* ---------------- 相关作品 ---------------- */

  const relatedItems = [];
  const relatedHost = tpl`<div></div>`;

  (async () => {
    try {
      // 相关作品不是首屏关键路径，允许它慢一点：
      // 上游偶发超时不该让「相关作品」直接显示成加载失败。
      let data = null;
      for (let attempt = 0; attempt < 2 && !data; attempt += 1) {
        try {
          data = await fetchRelated(id, { limit: 12 });
        } catch (error) {
          if (attempt === 1) throw error;
        }
      }
      const results = Array.isArray(data?.results) ? data.results : [];
      relatedItems.push(...results);
      if (!results.length) {
        relatedHost.replaceChildren(tpl`<p class="desc">没有找到相关作品。</p>`);
        return;
      }
      relatedHost.replaceChildren(
        tpl`<div></div>`,
        ...results.map((item) => railItem(item, 'video'))
      );
    } catch {
      relatedHost.replaceChildren(tpl`<p class="desc">相关作品加载失败。</p>`);
    }
  })();

  /* ---------------- 评论 ---------------- */

  const commentsHost = tpl`<div></div>`;
  const commentPanel = tpl`
    <div class="panel">
      <div class="panel__title">评论 · ${formatCount(detail.numComments)}</div>
    </div>`;
  commentPanel.append(commentsHost);
  mountComments(commentPanel, commentsHost, 'video', id, detail);

  /* ---------------- 组装 ----------------
     版式参照 B 站：
       左栏：播放器 → 标题 → 数据与操作 → 简介 → 标签 → 评论
       右栏：作者（头像 + 关注 + 简介）→ 相关作品
     作者信息从主栏移到侧栏，主栏就只剩"看视频"和"看评论"两件事。 */

  const authorPanel = tpl`<div class="watch__author"></div>`;
  authorPanel.append(authorBar);

  // 作者简介放进右栏，跟着作者一起，而不是和作品说明混在主栏里
  (async () => {
    const handle = detail.user?.username;
    if (!handle) return;
    try {
      const profile = await fetchProfile(handle);
      const text = String(profile?.body || '').trim();
      if (!text || ctx.signal.aborted) return;
      const box = tpl`
        <div class="watch__authorbio">
          <div class="watch__authorbio-title">作者简介</div>
          <div class="desc is-clamped"></div>
        </div>`;
      box.querySelector('.desc').append(linkifyNode(text));
      box.addEventListener('click', () => box.querySelector('.desc').classList.toggle('is-clamped'));
      authorPanel.append(box);
    } catch {
      /* 拿不到简介不影响播放 */
    }
  })();

  const relatedPanel = tpl`
    <div class="watch__related">
      <div class="watch__related-title">相关作品</div>
    </div>`;
  relatedPanel.append(relatedHost);

  /* 五个同级块：只有同级才能用 grid-template-areas 精确控制两端顺序。
     桌面：左列 head/details/comments，右列 author/related
     手机：head → author → details → comments → related */
  const headBlock = tpl`
    <div class="watch__head-block">
      ${playerHost}
      <div class="watch__head">
        <h1 class="watch__title">${title}</h1>
        ${stats}
      </div>
      <div class="watch__actions">
        ${likeButton}
        ${downloadButton}
        ${copyButton}
        ${refreshButton}
      </div>
    </div>`;

  const detailsBlock = tpl`
    <div class="watch__details">
      ${bodyPanel}
      ${tagRow(detail.tags, 14) ? tpl`<div class="watch__tags">${tagRow(detail.tags, 14)}</div>` : null}
    </div>`;

  const commentsBlock = tpl`<div class="watch__comments">${commentPanel}</div>`;

  const layout = tpl`<div class="watch">${headBlock}${authorPanel}${detailsBlock}${commentsBlock}${relatedPanel}</div>`;
  root.replaceChildren(layout);

  /* ---------------- 快捷键以外的收尾 ---------------- */

  if (resume > 5) {
    toast(`从上次的 ${Math.floor(resume / 60)} 分 ${Math.floor(resume % 60)} 秒继续`);
  }
}

/* ------------------------------------------------------------------ *
 * 子块
 * ------------------------------------------------------------------ */

function loadingShell() {
  return tpl`
    <div class="watch">
      <div>
        <div class="skeleton" style="aspect-ratio:16/9"></div>
        <div class="skeleton" style="aspect-ratio:auto;height:26px;width:64%;margin-top:18px"></div>
        <div class="skeleton" style="aspect-ratio:auto;height:14px;width:38%;margin-top:10px"></div>
      </div>
      <div class="watch__side">
        <div class="skeleton" style="aspect-ratio:auto;height:220px"></div>
      </div>
    </div>`;
}

function buildAuthorBar(user) {
  if (!user) return tpl`<div class="authorbar"><div class="authorbar__text">作者信息不可用</div></div>`;
  const href = userLink(user);
  const bar = tpl`
    <div class="authorbar">
      <a href="${href || '#'}"><img class="authorbar__avatar" src="${avatarUrl(user)}" alt="" /></a>
      <div class="authorbar__text">
        <a class="authorbar__name" href="${href || '#'}">${user.name || user.username}</a>
        <div class="authorbar__handle">@${user.username || ''}</div>
      </div>
    </div>`;

  const followButton = tpl`
    <button class="btn btn--sm ${user.following ? '' : 'btn--primary'}" type="button">
      ${user.following ? '已关注' : '关注'}
    </button>`;

  let following = !!user.following;
  followButton.addEventListener('click', async () => {
    if (!getSession().authenticated && !getSetting('token')) {
      toast('登录后才能关注作者', 'error');
      location.hash = '#/login';
      return;
    }
    followButton.disabled = true;
    const next = !following;
    try {
      await followUser(user.id, next);
      following = next;
      followButton.textContent = following ? '已关注' : '关注';
      followButton.classList.toggle('btn--primary', !following);
      toast(following ? `已关注 ${user.name || user.username}` : '已取消关注');
    } catch (error) {
      toastError(error, '操作失败');
    } finally {
      followButton.disabled = false;
    }
  });

  bar.append(followButton);
  return bar;
}

function openDownload(sourceData, title) {
  const sources = (sourceData?.sources || []).filter((item) => item.downloadUrl);
  if (!sources.length) {
    toast('这部作品没有提供下载', 'error');
    return;
  }
  const list = tpl`<div></div>`;
  for (const source of sources) {
    const row = tpl`
      <a class="rowitem" href="${source.downloadUrl}" style="padding:11px 6px">
        <div class="rowitem__main">
          <div class="rowitem__title">${source.label}</div>
          <div class="rowitem__meta"><span>${source.type || 'video/mp4'}</span></div>
        </div>
        ${icon('download')}
      </a>`;
    list.append(row);
  }
  openModal({
    title: '下载这个作品',
    hint: `文件会经由本站中转，原始文件名：${title}`,
    body: list,
    actions: [{ label: '关闭', onClick: ({ close }) => close() }]
  });
}

/** 把纯文本里的 URL 变成链接节点。 */
function linkifyInto(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  let match;
  const value = String(text || '');
  while ((match = pattern.exec(value))) {
    if (match.index > last) fragment.append(document.createTextNode(value.slice(last, match.index)));
    const anchor = document.createElement('a');
    anchor.href = match[0];
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer nofollow';
    anchor.textContent = match[0];
    fragment.append(anchor);
    last = match.index + match[0].length;
  }
  if (last < value.length) fragment.append(document.createTextNode(value.slice(last)));
  return fragment;
}

/* ------------------------------------------------------------------ *
 * 评论
 * ------------------------------------------------------------------ */

/**
 * 评论区：按页加载，就地翻页。
 *
 * 不用改地址栏（那会让整个播放页连同视频重新加载），
 * 而是把分页条做成按钮，翻页后把评论区滚回视野内。
 */
function mountComments(container, host, type, id, detail) {
  const PAGE_SIZE = 20;

  let page = 0;
  let loading = false;
  let totalPages = 1;

  const list = tpl`<div class="comments__list"></div>`;
  const pagerHost = tpl`<div class="comments__pager"></div>`;
  const status = tpl`<div class="comments__status"></div>`;
  host.append(list, status, pagerHost);

  const session = getSession();
  const canComment = session.authenticated || !!getSetting('token');

  if (canComment) {
    const input = tpl`<textarea class="input" rows="3" placeholder="写点什么…" style="height:auto;padding:10px 13px;resize:vertical"></textarea>`;
    const submit = tpl`<button class="btn btn--primary btn--sm" type="button">发表评论</button>`;
    const box = tpl`<div class="comments__form">${input}<div class="comments__form-actions">${submit}</div></div>`;
    submit.addEventListener('click', async () => {
      const body = input.value.trim();
      if (!body) return;
      submit.disabled = true;
      try {
        const created = await postComment(type, id, body);
        const comment = created?.comment || created;
        // 新评论总在第一页最前，先回到第 1 页再插入，避免插到别页里
        if (page === 0 && comment?.id) list.prepend(commentNode(comment));
        input.value = '';
        toast('评论已提交');
        if (page !== 0) goTo(0);
      } catch (error) {
        toastError(error, '评论提交失败');
      } finally {
        submit.disabled = false;
      }
    });
    container.insertBefore(box, host);
  } else {
    container.insertBefore(
      tpl`<p class="desc" style="margin-bottom:16px">登录后可以发表评论。</p>`,
      host
    );
  }

  function goTo(target) {
    const next = Math.max(0, Math.min(target, totalPages - 1));
    if (next === page && list.childElementCount) return;
    page = next;
    load();
  }

  async function load() {
    if (loading) return;
    loading = true;
    list.replaceChildren(
      tpl`<div class="skeleton" style="aspect-ratio:auto;height:52px"></div>`,
      tpl`<div class="skeleton" style="aspect-ratio:auto;height:52px"></div>`
    );
    status.replaceChildren();
    pagerHost.replaceChildren();

    try {
      const data = await fetchComments(type, id, { page, limit: PAGE_SIZE });
      const results = Array.isArray(data?.results) ? data.results : [];
      const total = Number(data?.count) || results.length;
      totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

      list.replaceChildren();

      if (!results.length) {
        list.append(
          tpl`<p class="desc">${page > 0 ? '这一页没有评论了。' : '还没有评论，来说第一句。'}</p>`
        );
        if (page > 0) {
          status.append(tpl`<button class="btn btn--sm" type="button">回到第 1 页</button>`);
          status.querySelector('button').addEventListener('click', () => goTo(0));
        }
        loading = false;
        return;
      }

      const batch = document.createDocumentFragment();
      for (const comment of results) batch.append(commentNode(comment));
      list.append(batch);

      // 只有一页时不显示分页条，避免噪音
      if (totalPages > 1) {
        const bar = pager({
          page,
          totalPages,
          onNavigate: (target) => {
            goTo(target);
            // 翻页后把评论区头部带回视野，不然用户不知道内容变了
            container.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
          noun: '页'
        });
        pagerHost.append(bar);
        status.append(
          tpl`<p class="pager__hint">共 ${formatCount(total)} 条评论 · 第 ${page + 1} / ${totalPages} 页</p>`
        );
      }
    } catch (error) {
      list.replaceChildren(
        stateBlock({
          title: '评论加载失败',
          message: error?.message || '稍后再试。',
          error: true,
          action: { label: '重试', onClick: load }
        })
      );
    } finally {
      loading = false;
    }
  }

  load();
}

