/**
 * 把用户粘贴的 Iwara 链接转成本站的 hash 路由。
 *
 * 场景：搜索框里粘一个 https://www.iwara.tv/video/xxxx 时，
 * 不该拿整串去做关键词搜索（必然搜不到），而应该直接跳到那个作品页。
 *
 * 支持 www.iwara.tv / iwara.tv / m.iwara.tv 等子域，以及 www.iwara.ai。
 * 只认能明确对应的路径，其余（比如 /videos 列表页、未知路径）交回搜索处理。
 */

/** 是否是 iwara 域名的链接（允许省略协议）。 */
const IWARA_URL = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*iwara\.(?:tv|ai)(?:[/?#]|$)/i;

/**
 * @param {string} raw 用户输入
 * @returns {string|null} 形如 `/video/abc123` 的路由；不是 Iwara 链接则返回 null
 */
export function routeFromInput(raw) {
  const text = String(raw || '').trim();
  if (!text || !IWARA_URL.test(text)) return null;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }

  if (!/(^|\.)iwara\.(tv|ai)$/i.test(url.hostname)) return null;

  // iwara.ai 是另一套站点内容，用 _site=ai 让接口层切过去
  const isAi = /iwara\.ai$/i.test(url.hostname);
  const withSite = (route) => (isAi ? `${route}${route.includes('?') ? '&' : '?'}_site=ai` : route);

  const parts = url.pathname.split('/').filter(Boolean);
  const head = (parts[0] || '').toLowerCase();
  const second = parts[1] || '';

  switch (head) {
    case 'video':
      return second ? withSite(`/video/${encodeURIComponent(decodeSafe(second))}`) : null;
    case 'image':
      return second ? withSite(`/image/${encodeURIComponent(decodeSafe(second))}`) : null;
    case 'images':
      return withSite('/images');
    case 'profile':
      return second ? withSite(`/user/${encodeURIComponent(decodeSafe(second))}`) : null;
    case 'user':
      // /user/<uuid> 不是用户名，本站按用户名取，认不出来就交给搜索
      return null;
    case 'playlist':
      return second ? withSite(`/playlist/${encodeURIComponent(decodeSafe(second))}`) : null;
    case 'playlists':
      return withSite('/playlists');
    case 'tag':
    case 'tags':
      return second ? withSite(`/tag/${encodeURIComponent(decodeSafe(second))}`) : withSite('/search');
    case 'forum':
      if (!second) return '/forum';
      return `/forum/${encodeURIComponent(decodeSafe(second))}${
        parts[2] ? `/${encodeURIComponent(decodeSafe(parts[2]))}` : ''
      }`;
    case 'posts':
      return '/posts';
    case 'videos':
      // 站点的列表页没有额外的筛选语义，直接回首页
      return withSite('/');
    default:
      return null;
  }
}

/** 路径片段可能已经是百分号编码，别重复编码。 */
function decodeSafe(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
