# AGENTS.md · 实现说明与开发约定

这份文档写给要改这个项目代码的人（以及 AI 助手）。
面向"这是什么、怎么部署"的说明在 [README.md](./README.md)。

---

## 架构

```
浏览器  ──►  Cloudflare Worker  ──►  apiq.iwara.tv        业务接口
                 │                 ├─ filesq.iwara.tv      清晰度清单
                 │                 ├─ i.iwara.tv           封面 / 头像 / 原图
                 │                 └─ *.iwara.tv            视频分片节点
                 │
                 └──►  静态资源交给 Assets（assests binding）返回
```

一个 Worker 承担三件事，前端是零依赖的原生 ES 模块单页应用。

### 请求流

1. `verifyBasicAuth` —— 可选的站点级 Basic Auth。
2. `handleGateRoutes` —— 站点访问密码（`SITE_PASSWORD`）。**必须在所有路由之前**，
   否则知道直链的人能绕开登录页。
3. `/api/*` → `routeApi`，`/media/*` → `handleMedia`。
4. 其余交给 `env.ASSETS.fetch`。

> ⚠️ `wrangler.jsonc` 里 `assets.run_worker_first` 必须是 `true`。
> 如果只放 `/api/*` 和 `/media/*`，Assets 的 SPA 回退会把 `index.html`
> 直接吐给未知路径（如 `/video/xxx`），访问密码就只能挡数据、挡不住页面外壳。

---

## 目录

```
src/
  index.js       路由与 Worker 入口
  gate.js        站点访问密码（登录页、Cookie 签发、恒定时间比较）
  api.js         /api/iwara/* 业务接口反代（白名单 + 可选边缘缓存）
  media.js       /media/* 视频与图片代理（Range、主机名校验）
  sources.js     清晰度清单解析 + X-Version 签名 + 盐值自愈
  session.js     Iwara 账号登录、Token 交换、会话 Cookie
  upstream.js    上游请求头、UA 选择、Basic Auth
  util.js        编码、AES-GCM、Cookie、恒定时间比较、响应构造
public/
  index.html     外壳 + 内联 SVG 图标精灵
  css/app.css    全部样式（含主题变量）
  js/
    app.js           引导：路由注册、顶栏、会话与主题
    router.js        哈希路由（视图契约见下）
    ui.js            tpl 模板、吐司、弹窗、骨架屏、图标
    store.js         设置、会话、主题、观看历史
    api.js           接口客户端、媒体地址构造、格式化
    cards.js         卡片、信息流、评论、标签行
    cards-preview.js 悬停预览
    player.js        播放器、手势、迷你播放器
    theme-init.js    首帧前定配色（必须独立文件，CSP 禁内联脚本）
    views/           各页面视图
test/              后端 / 路由 / 密码 测试
tools/             check-imports.mjs、shot.mjs
dev-server.mjs     本地开发服务器（Node 跑真正的 Worker）
```

---

## 三个上游机制

### 1. X-Version 签名

Iwara 的视频地址是 `https://filesq.iwara.tv/file/<uuid>?expires=...&hash=...`，
请求清晰度清单时必须带签名头：

```
X-Version = sha1("<uuid>_<expires>_<盐值>")
```

盐值写死在官网前端 `main.<hash>.js` 里。

**关键：盐值不对时上游不报错**，照样返回 200，只是清单里只剩 360 / preview 两档。
所以 `src/sources.js` 把「清单里没有 `Source`」当作盐值失效的信号：
去官网首页找 `main.js`、正则提取新盐、重签重发一次。取不到就沿用低清结果。

正则写在文件顶部（`MAIN_SCRIPT_PATTERN` / `SALT_PATTERN`），官网改版时改这里。

### 2. Range 分片透传

播放器拖进度条时浏览器发 `Range` 请求，Worker 原样转发给分片节点，
返回 `206` 与 `Content-Range`，不缓冲整个文件。

分片主机名是随机的（`kafka` / `robin` / `zani` / `acheron` …），
所以 `/media/v?u=` 必须接受任意 `*.iwara.tv`，但会校验主机后缀防止变成任意站点代理。

### 3. 封面帧地址

**这一条最容易踩坑。** 视频封面的真实地址是：

```
/image/thumbnail/<fileId>/thumbnail-<NN>.jpg      NN 必须两位补零
```

- 用 `<fileId>.<ext>`（即"文件本身"的路径）→ 返回 Iwara 的**灰色胶卷占位图**，不报错。
- 用 `thumbnail-3.jpg`（不补零）→ 同样返回占位图。
- 帧号来自列表项的 `thumbnail` 字段（0 起）。

`public/js/api.js` 的 `videoThumbnailUrl()` 强制 `padStart(2, '0')`。

---

## 前端约定

### 视图契约

```js
export async function renderXxx(ctx, params) {
  // ctx: { query: URLSearchParams, path, navigate, signal, onCleanup }
  return node;   // 必须返回 DOM 节点
}
```

- 注册在 `public/js/app.js` 的路由表里。
- 清理逻辑用 `ctx.onCleanup(fn)`。
- 视图被切走时 router 会先 `controller.abort()` 再跑 cleanup；
  加载中使用 `ctx.signal.aborted` 判断是否该放弃。

### 模板

用 `tpl` 标签函数，插值默认转义：

```js
tpl`<h1 class="title">${untrusted}</h1>`          // 自动转义
tpl`<div>${raw('<b>可信的 HTML</b>')}</div>`      // 显式放行
```

**注意 `tpl` 的返回值**：单个元素时返回该元素（可用 `.classList` 等），
多个子节点时返回 DocumentFragment。

### 图标

```js
icon('play')      // 返回 raw 包装，只能放进 tpl 里
iconNode('play')  // 返回真实 DOM 节点，用于 replaceChildren/append
```

把 `icon()` 的结果塞进 `replaceChildren` 会渲染成 `[object Object]`。

### 播放器手势

`player.js` 里手势是自己实现的分发，不用原生 `click` + `dblclick`：

- **单击** 暂停/继续，**双击** 全屏，**长按**（320ms）2 倍速。
- 双击判定必须自己做延时窗口（260ms）：原生 `click` 与 `dblclick` 同时绑定时，
  第一次点击会立刻触发暂停，两次连点的结果变成「暂停又播放」。
- 长按阈值内如果指针移动超过 12px（想拖进度条），取消长按判定。
- 画中画失败要给出原因：iOS Safari 根本不支持网页画中画，静默失败最像 bug。

### 样式

全部集中在 `public/css/app.css`，视图里不写 `<style>`。

配色靠 CSS 变量，主题切换只覆盖 `:root[data-theme='light']` 那一组：

| 变量 | 用途 |
| :-- | :-- |
| `--ink` / `--ink-1..3` | 底色，数字越大越亮（浅色主题反过来） |
| `--paper` / `--paper-2` / `--paper-3` | 文字，从主到弱 |
| `--rose` / `--celadon` / `--amber` | 主色 / 数据色 / 分级色 |
| `--tint-*` | 徽章底色 |
| `--surface-sunken` / `--scrim` | 顶栏毛玻璃 / 弹窗遮罩 |

播放器与迷你播放器**强制深色**（`color-scheme: dark`）：它们盖在视频画面上，
浅色主题下变成白底会干扰观看。

---

## 测试

```bash
npm test               # 31 项后端集成（打真实 Iwara）
npm run test:gate      # 26 项站点访问密码
npm run test:routes    # 23 项路由冒烟：逐页确认没有白屏
npm run test:player    # 12 项播放器手势（单击/双击/长按/画中画/键盘）
npm run test:theme     # 7 项主题持久化与首帧无闪烁
npm run test:ui        # 播放器、悬停预览、迷你播放器
npm run check          # import 具名导出一致性
npm run shots          # 重新生成 README 截图（输出到 docs/screenshots/）
```

除 `test` 与 `test:gate` 外，都需要先 `node dev-server.mjs`。
若开了站点密码，本地启动时带上环境变量：

```bash
SITE_PASSWORD='@Gao123456' node dev-server.mjs
```

### 本地为什么用 curl

`dev-server.mjs` 把上游请求交给 `curl`（见 `test/curl-fetch.mjs`）。
原因是 Node 的 TLS 指纹配上浏览器 UA 会被 Cloudflare 判为可疑客户端并返回挑战页；
线上跑在 Workers 里没有这个问题。副作用是本地请求慢一个数量级，
**所以浏览器测试里所有断言都要用轮询等待，不要写固定 sleep**。

### 写新测试时注意

- `test/routes.smoke.mjs` 会先自动过密码网关。
- 断言用 `waitFor` 轮询；固定 `waitForTimeout` 在本地慢速传输下必然不稳。

---

## 改代码时的雷区

按被踩到的次数排序：

1. **`run_worker_first` 不能只写 `/api/*`。** 见上文，会让密码失效。
2. **`hidden` 属性会被 `display` 覆盖。** `.modal` 用了 `display: grid`，
   盖掉浏览器默认的 `display: none`，会变成一层透明遮罩吃掉全站点击。
   `app.css` 顶部有全局 `[hidden] { display: none !important }` 兜底，别删。
3. **`icon()` 不是节点。** 见上文。
4. **对未插入文档的 `<img>` 设 src 后又被替换，Firefox 会中断请求并触发 error。**
   图库大图要先把元素挂进文档，再设 `src`。
5. **上游 `limit` 封顶 50。** 请求 96 只回 50，判断"到底了"要用响应里的 `limit`。
6. **窄屏下顶栏换行后，DOM 靠后的元素会盖住绝对定位的菜单。**
   菜单面板的 `z-index` 和窄屏 `position: fixed` 都是为了这个，别动。
7. **内联 `<script>` 会被 CSP 拦掉**（`script-src 'self'`）。
   需要在首帧前跑的东西必须独立成文件，参考 `theme-init.js`。
8. **`wrangler.jsonc` 的 `vars` 与 `secret` 不能同名**，否则 `secret put` 报
   `Binding name already in use`。

---

## 上游接口备忘

已实测可用的路径（都经 `/api/iwara/` 透传）：

```
/videos?page&limit&sort&rating&user&tags&subscribed
/video/{id}  /video/{id}/related  /video/{id}/comments  /video/{id}/likes
/images?page&limit&sort&rating      /image/{id}
/tags?sort      /tags/{id}
/profile/{username}   /user/{id}/followers   /user/{id}/following
/playlists      /playlist/{id}
/forum/threads  /forum/{cat}/{threadId}      /posts   /post/{id}
/search?query&type      # ⚠️ 需要有效 token，否则固定 500
```

其他要点：

- `x-site: www.iwara.tv` 决定拿主站还是 AI 站内容。
- `/search` 未登录固定返回 `errors.serverError`（500），不是本站故障。
- `subscribed=true` **未登录时被上游静默忽略**，会返回全站内容且不报错——
  所以订阅页把登录作为硬前置条件。
- Iwara 没有服务端观看历史接口，历史只能是本地的。
