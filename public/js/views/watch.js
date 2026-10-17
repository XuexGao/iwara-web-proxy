/**
 * 播放页：播放器 + 作品信息 + 作者 + 标签 + 简介 + 评论 + 相关作品。
 *
 * 离开这个页面时，如果视频还在播，会交给迷你播放器继续放；
 * 再回到同一部作品时把那个 <video> 元素接回来，进度和缓冲都不丢。
 */

import {
  avatarUrl,
  coverUrl,
  fetchComments,
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
import { commentNode, railItem, tagRow, userLink } from '../cards.js';
import { createPlayer, mini, playback } from '../player.js';
import { getResume, getSession, getSetting, recordHistory } from '../store.js';
import { icon, openModal, stateBlock, toast, toastError, tpl } from '../ui.js';

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export async function renderWatch(ctx, { id }) {
  const holder = { player: null, meta: { id, title: '', author: '' }, finished: false, disposed: false };
  const root = tpl`<div></div>`;

  ctx.onCleanup(() => {
    holder.disposed = true;
    const player = holder.player;
    if (!player) return;
    const video = player.video;
    const keepPlaying =
      video &&
      !holder.finished &&
      !video.paused &&
      !video.ended &&
      Number.isFinite(video.currentTime) &&
      video.currentTime > 1;

    if (keepPlaying) {
      holder.meta.title = holder.meta.title || '正在播放';
      mini.adopt(player.detachVideo(), holder.meta);
      player.destroy({ keepVideo: true });
      return;
    }

    player.destroy();
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
    const adoptable =
      playback.detached && playback.videoId === id && playback.video ? mini.release() : null;

    player = createPlayer({
      sources: data.sources || [],
      preview: data.preview,
      meta: { id, title, author: authorName },
      poster: coverUrl(detail, 'video'),
      startAt: adoptable ? 0 : resume,
      autoplay: getSetting('autoplay'),
      videoElement: adoptable,
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
      const data = await fetchRelated(id, { limit: 12 });
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

  /* ---------------- 组装 ---------------- */

  const main = tpl`
    <div>
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
      ${authorBar}
      ${tagRow(detail.tags, 14) ? tpl`<div class="panel">${tagRow(detail.tags, 14)}</div>` : null}
      ${bodyPanel}
      ${commentPanel}
    </div>`;

  const side = tpl`
    <div class="watch__side">
      <div class="panel">
        <div class="panel__title">相关作品</div>
      </div>
    </div>`;
  side.querySelector('.panel').append(relatedHost);

  const layout = tpl`<div class="watch">${main}${side}</div>`;
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

function mountComments(container, host, type, id, detail) {
  let page = 0;
  let loading = false;
  let done = false;

  const list = tpl`<div></div>`;
  const footer = tpl`<div class="loadmore"></div>`;
  host.append(list, footer);

  const session = getSession();
  const canComment = session.authenticated || !!getSetting('token');

  if (canComment) {
    const input = tpl`<textarea class="input" rows="3" placeholder="写点什么…" style="height:auto;padding:10px 13px;resize:vertical"></textarea>`;
    const submit = tpl`<button class="btn btn--primary btn--sm" type="button">发表评论</button>`;
    const box = tpl`<div style="margin-bottom:18px">${input}<div style="display:flex;justify-content:flex-end;margin-top:8px">${submit}</div></div>`;
    submit.addEventListener('click', async () => {
      const body = input.value.trim();
      if (!body) return;
      submit.disabled = true;
      try {
        const created = await postComment(type, id, body);
        const comment = created?.comment || created;
        if (comment?.id) list.prepend(commentNode(comment));
        input.value = '';
        toast('评论已提交');
      } catch (error) {
        toastError(error, '评论提交失败');
      } finally {
        submit.disabled = false;
      }
    });
    container.insertBefore(box, host);
  } else {
    const hint = tpl`<p class="desc" style="margin-bottom:16px">登录后可以发表评论。</p>`;
    container.insertBefore(hint, host);
  }

  async function loadMore() {
    if (loading || done) return;
    loading = true;
    footer.replaceChildren(tpl`<div class="skeleton" style="aspect-ratio:auto;height:52px"></div>`);
    try {
      const data = await fetchComments(type, id, { page, limit: 24 });
      const results = Array.isArray(data?.results) ? data.results : [];
      footer.replaceChildren();
      if (!results.length) {
        done = true;
        if (page === 0) list.append(tpl`<p class="desc">还没有评论，来说第一句。</p>`);
        return;
      }
      for (const comment of results) list.append(commentNode(comment));
      page += 1;
      if (results.length < 24) {
        done = true;
        return;
      }
      const more = tpl`<button class="btn btn--sm" type="button">加载更多评论</button>`;
      more.addEventListener('click', loadMore);
      footer.append(more);
    } catch (error) {
      footer.replaceChildren(
        stateBlock({
          title: '评论加载失败',
          message: error.message,
          error: true,
          action: { label: '重试', onClick: loadMore }
        })
      );
      loading = false;
    } finally {
      loading = false;
    }
  }

  loadMore();
}
