/**
 * 首帧前定配色，避免浅色用户看到一瞬深色底。
 *
 * 必须独立成文件：站点 CSP 是 script-src 'self'，内联脚本会被拦掉，
 * 主题就会在页面渲染完之后才切换，出现明显闪烁。
 */
(function () {
  try {
    // 主题存成裸字符串（'dark'），这里同时兼容带引号的历史写法。
    var saved = localStorage.getItem('iwara.theme.v1') || '';
    if (saved.charAt(0) === '"') { try { saved = JSON.parse(saved); } catch (e) { saved = ''; } }
    var pref = saved === 'light' || saved === 'dark' ? saved : null;
    if (!pref) {
      pref = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.dataset.theme = pref;
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
