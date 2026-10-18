/**
 * 图库与播放列表。
 *
 * 图库作品（image）本质是一组原图的集合，Iwara 用 thumbnail 字段当封面，
 * files[] 里才是要逐张看的原图。播放列表（playlist）则是一组视频的合集。
 */

import {
  avatarUrl,
  fetchComments,
  fetchImage,
  fetchImages,
  fetchPlaylist,
  fetchPlaylists,
  formatCount,
  formatDate,
  galleryImageUrl,
  imageUrl,
  playlistCoverUrl,
  postComment
} from '../api.js';
import {
  commentNode,
  lede,
  pageFromQuery,
  playlistCard,
  renderPagedFeed,
  tagRow,
  userLink,
  workCard
} from '../cards.js';
import { getSession, getSetting, ratingParam, recordHistory } from '../store.js';
import { icon, stateBlock, tpl, toast, toastError } from '../ui.js';

/* ------------------------------------------------------------------ *
 * 图库列表
 * ------------------------------------------------------------------ */

export async function renderImages(ctx) {
  const sorts = [
    { id: 'trending', label: '本周热门' },
    { id: 'date', label: '最新发布' },
    { id: 'popularity', label: '最受喜爱' },
    { id: 'views', label: '看的最多' }
  ];
  let sort = ctx.query.get('sort') || 'trending';
  if (!sorts.some((item) => item.id === sort)) sort = 'trending';

  const page = pageFromQuery(ctx.query);

  const head = lede({
    eyebrow: 'GALLERY',
    title: '图库',
    desc: '画师上传的插画与漫画。点进去可以逐张看原图。'
  });

  const chips = tpl`<div class="chips chips--scroll"></div>`;
  for (const option of sorts) {
    chips.append(
      tpl`<a class="chip ${option.id === sort ? 'is-on' : ''}" href="#/images?sort=${option.id}">${option.label}</a>`
    );
  }

  const feed = await renderPagedFeed({
    page,
    kind: 'image',
    hrefFor: (target) => `#/images?sort=${sort}&page=${target + 1}`,
    emptyTitle: '图库是空的',
    emptyMessage: '换个排序看看，或者在设置里打开 R18 内容。',
    fetchPage: (target, limit) =>
      fetchImages({ page: target, limit, sort, rating: ratingParam() })
  });

  return tpl`<div>${head}${chips}<div style="margin-top:18px">${feed}</div></div>`;
}

/* ------------------------------------------------------------------ *
 * 单个图库
 * ------------------------------------------------------------------ */

export async function renderGallery(ctx, { id }) {
  const detail = await fetchImage(id);
  if (!detail?.id) {
    return stateBlock({ title: '找不到这个图库', message: '它可能已经被作者删除。' });
  }

  const files = (Array.isArray(detail.files) ? detail.files : []).filter((file) => file?.id && file?.name);
  const title = detail.title || '无标题图库';
  const authorName = detail.user?.name || detail.user?.username || '匿名';

  // 图库也要进观看历史，和视频共用同一套记录。
  recordHistory({
    id,
    title,
    kind: 'image',
    author: authorName,
    rating: detail.rating,
    cover: {
      thumbnail: detail.thumbnail,
      customThumbnail: detail.customThumbnail
    }
  });

  /* ---------------- 大图浏览 ---------------- */

  let index = 0;
  const stage = tpl`<div class="gallery"></div>`;
  const counter = tpl`<span class="badge"></span>`;

  function paint() {
    const file = files[index];
    if (!file) {
      stage.replaceChildren(
        stateBlock({
          title: '这个图库没有可看的原图',
          message: '可能是上传失败，或者图片还在处理中。'
        })
      );
      counter.textContent = '0 / 0';
      return;
    }
    const image = document.createElement('img');
    image.alt = `${title} 第 ${index + 1} 张`;
    image.loading = 'eager';
    // 先把 <img> 挂进文档再设 src：Firefox 里对一个尚未插入文档、
    // 又被 replaceChildren 立刻换掉的元素设 src，请求会被中断并抛 error，
    // 表现为"图源不可用"——这正是排查这个 bug 时踩到的问题。
    stage.replaceChildren(image);
    image.src = galleryImageUrl(file);
    image.addEventListener('error', () => {
      stage.replaceChildren(
        stateBlock({
          title: '这张图加载失败',
          message: '图源可能暂时不可用，翻到下一张试试。',
          error: true
        })
      );
    });
    counter.textContent = `${index + 1} / ${files.length}`;
    for (const [i, button] of [...thumbs.children].entries()) {
      button.classList.toggle('is-on', i === index);
    }
  }

  const thumbs = tpl`<div class="thumbs"></div>`;
  files.forEach((file, i) => {
    const button = tpl`<button type="button" aria-label="第 ${i + 1} 张"><img src="${imageUrl(file, 'thumbnail')}" alt="" loading="lazy" /></button>`;
    button.addEventListener('click', () => {
      index = i;
      paint();
    });
    thumbs.append(button);
  });

  if (!files.length) {
    paint();
  } else {
    paint();
  }

  const viewer = tpl`<div>${stage}</div>`;

  const prev = tpl`<button class="btn btn--icon" type="button" aria-label="上一张">${icon('back')}</button>`;
  const next = tpl`<button class="btn btn--icon" type="button" aria-label="下一张">${icon('next')}</button>`;
  const step = (delta) => {
    if (!files.length) return;
    index = (index + delta + files.length) % files.length;
    paint();
  };
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));

  const nav = tpl`<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">${prev}${next}${counter}</div>`;

  const onKey = (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  };
  document.addEventListener('keydown', onKey);
  ctx.onCleanup(() => document.removeEventListener('keydown', onKey));

  /* ---------------- 页头与信息 ---------------- */

  const href = userLink(detail.user);
  const head = lede({
    eyebrow: 'GALLERY',
    title,
    desc: `由 ${authorName} 上传 · ${formatDate(detail.createdAt)}`
  });

  const stats = tpl`
    <div class="badges" style="margin-bottom:14px">
      <span class="badge">${icon('eye')} ${formatCount(detail.numViews)}</span>
      <span class="badge">${icon('heart')} ${formatCount(detail.numLikes)}</span>
      <span class="badge">${icon('comment')} ${formatCount(detail.numComments)}</span>
      <span class="badge">${files.length} 张</span>
      ${detail.rating === 'ecchi' ? tpl`<span class="badge badge--ecchi">R18</span>` : null}
    </div>`;

  const authorBar = tpl`
    <div class="authorbar">
      <a href="${href || '#'}"><img class="authorbar__avatar" src="${avatarUrl(detail.user)}" alt="" /></a>
      <div class="authorbar__text">
        <a class="authorbar__name" href="${href || '#'}">${authorName}</a>
        <div class="authorbar__handle">@${detail.user?.username || ''}</div>
      </div>
    </div>`;

  const bodyPanel = detail.body
    ? tpl`
      <div class="panel">
        <div class="panel__title">作品说明</div>
        <div class="desc"></div>
      </div>`
    : null;
  if (bodyPanel) bodyPanel.querySelector('.desc').textContent = detail.body;

  const commentPanel = tpl`
    <div class="panel">
      <div class="panel__title">评论 · ${formatCount(detail.numComments)}</div>
    </div>`;
  mountComments(ctx, commentPanel, 'image', id);

  return tpl`
    <div>
      ${head}
      ${stats}
      ${nav}
      ${viewer}
      ${thumbs}
      ${authorBar}
      ${tagRow(detail.tags, 16) ? tpl`<div class="panel">${tagRow(detail.tags, 16)}</div>` : null}
      ${bodyPanel}
      ${commentPanel}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * 评论区
 * ------------------------------------------------------------------ */

function mountComments(ctx, container, type, id) {
  const list = tpl`<div></div>`;
  const footer = tpl`<div class="loadmore"></div>`;
  container.append(list, footer);

  let page = 0;
  let loading = false;
  let done = false;

  const canComment = getSession().authenticated || !!getSetting('token');
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
    container.insertBefore(box, list);
  } else {
    container.insertBefore(tpl`<p class="desc" style="margin-bottom:16px">登录后可以发表评论。</p>`, list);
  }

  async function loadMore() {
    if (loading || done) return;
    loading = true;
    footer.replaceChildren(tpl`<div class="skeleton" style="aspect-ratio:auto;height:52px"></div>`);
    try {
      const data = await fetchComments(type, id, { page, limit: 24 });
      if (ctx.signal.aborted) return;
      const results = Array.isArray(data?.results) ? data.results : [];
      footer.replaceChildren();
      if (!results.length) {
        done = true;
        if (page === 0) list.append(tpl`<p class="desc">还没有评论。</p>`);
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
          message: error?.message || '稍后再试。',
          error: true,
          action: { label: '重试', onClick: loadMore }
        })
      );
    } finally {
      loading = false;
    }
  }

  loadMore();
}

/* ------------------------------------------------------------------ *
 * 播放列表
 * ------------------------------------------------------------------ */

export async function renderPlaylists(ctx) {
  const page = pageFromQuery(ctx.query);

  const head = lede({
    eyebrow: 'PLAYLIST',
    title: '播放列表',
    desc: '作者自己整理的合集，通常围绕一个系列或一个题材。'
  });

  const feed = await renderPagedFeed({
    page,
    hrefFor: (target) => `#/playlists?page=${target + 1}`,
    render: (item) => playlistCard(item),
    emptyTitle: '还没有公开的播放列表',
    emptyMessage: '换一页看看，或者从作者页进入他们自己的合集。',
    fetchPage: (target, limit) => fetchPlaylists({ page: target, limit })
  });

  return tpl`<div>${head}<div style="margin-top:18px">${feed}</div></div>`;
}

export async function renderPlaylist(ctx, { id }) {
  const page = pageFromQuery(ctx.query);
  const detail = await fetchPlaylist(id, { page: 0, limit: 1 });
  const playlist = detail?.playlist || detail;
  if (!playlist?.id) {
    return stateBlock({ title: '找不到这个播放列表', message: '它可能已经被删除或设为私有。' });
  }

  const href = userLink(playlist.user);
  const head = lede({
    eyebrow: 'PLAYLIST',
    title: playlist.title || '未命名播放列表',
    count: detail?.count ?? playlist.numVideos,
    desc: `由 ${playlist.user?.name || playlist.user?.username || '匿名'} 整理`
  });

  const cover = tpl`
    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:18px">
      <img src="${playlistCoverUrl(playlist)}" alt="" style="width:210px;aspect-ratio:16/9;object-fit:cover;border-radius:var(--r-sm)" />
      <div>
        ${href ? tpl`<a class="authorbar__name" href="${href}">${playlist.user?.name || playlist.user?.username}</a>` : null}
        <div class="authorbar__handle">共 ${detail?.count ?? playlist.numVideos ?? 0} 个作品</div>
      </div>
    </div>`;

  const feed = await renderPagedFeed({
    page,
    hrefFor: (target) => `#/playlist/${id}?page=${target + 1}`,
    render: (item) => workCard(item, item.numImages !== undefined && !item.file ? 'image' : 'video'),
    emptyTitle: '这个播放列表是空的',
    emptyMessage: '作者可能还没有往里加作品。',
    fetchPage: async (target, limit) => {
      const data = await fetchPlaylist(id, { page: target, limit });
      return {
        results: Array.isArray(data?.results) ? data.results : [],
        count: data?.count,
        limit: data?.limit
      };
    }
  });


  return tpl`<div>${head}${cover}${feed}</div>`;
}
