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
    player.js        播放器与手势（无小窗：离开即停止）
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

### 3. 下载文件名

上游给的下载文件名是 `<uuid>_Source.mp4`，下下来认不出是什么，所以
`src/sources.js` 用**作品标题**重命名（`safeFileBase()`：清洗非法字符、
压空白、截断到 80 字）。非原画档追加清晰度后缀。

`src/media.js` 的 `buildContentDisposition()` 同时输出 ASCII 兜底与
RFC 5987 的 `filename*`，否则中文标题在 Safari / 老版 Chrome 上会乱码。

### 4. 封面帧地址

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

### 播放器手势（桌面与移动不同）

`player.js` 里手势是自己实现的分发，不用原生 `click` + `dblclick`。
两端约定**必须分开**，用 `(hover: none)` / `maxTouchPoints` 判定：

| 操作 | 桌面 | 移动 |
| :-- | :-- | :-- |
| 单击 | 显隐控制栏 | 显隐控制栏 |
| 双击 | 全屏 | 暂停 / 继续 |
| 长按 320ms | 2 倍速 | 2 倍速 |

单击统一是「显隐控制栏」：手指点一下就想暂停是最容易误触的设计，
主流播放器（YouTube / B 站 / 抖音）也都是单击唤起控件。
暂停/继续交给双击与播放按钮。移动端双击要 `preventDefault`，否则会被当成返回手势。

**控制栏显隐的三个陷阱**（都踩过）：
1. `wake()`（pointermove 唤起）会覆盖单击的隐藏结果——用户点完鼠标就停在画面上，
   hover 一直成立。所以要用 `userHiddenControls` 标记「用户主动隐藏」，
   主动隐藏后只能再点一次才回来，鼠标移动不能唤醒。
2. `.player.is-paused .player__controls { opacity: 1 }` 与隐藏规则优先级相同，
   后写的赢。必须显式写 `.is-paused.is-hidden-controls`。
3. 双击判定窗口在触摸设备上要放宽到 450ms：真实手机上两次 tap 间隔常到
   400ms 以上，260ms 会被拆成两次单击，表现就是「双击没反应」。

其他要点：
- 双击判定必须自己做延时窗口（260ms）：原生 `click` 与 `dblclick` 同时绑定时，
  第一次点击会立刻触发单击动作，连点就变成「两次单击」。
- 长按阈值内指针移动超过 12px（想拖进度条）则取消长按。
- 画中画失败要给出原因：iOS Safari 根本不支持网页画中画，静默失败最像 bug。

### 关系列表的数据形状

`/user/{id}/followers` 与 `/following` **不是裸用户数组**：

```
followers: { id, createdAt, follower: { name, username, avatar, ... } }
following: { id, createdAt, user:     { name, username, avatar, ... } }
```

直接渲染外层会得到一堆「匿名」。前端用 `item.follower || item.user || item` 取。
（Iwara 客户端显示正常，是因为它取的就是内层。）

### 正文与评论的 Markdown

Iwara 的**作品说明、评论、作者简介、论坛正文**都是 Markdown 内联语法：

```
![alt](https://img3.pixhost.cc/....jpg)     图片
[文字](https://...)                          链接
```

真实例子：

- 作品说明：`4K 60FPS Link: [patreon](https://www.patreon.com/c/xxx) /[爱赞助](https://azz.ee/xxx)`
- 评论：`❤️👍` + `![](https://img3.pixhost.cc/….jpg)`

`ui.js` 的 `linkify()` / `linkifyNode()` 用同一个 `tokenizeInline()` 解析这三种
（图片 / Markdown 链接 / 裸 URL），其余语法按普通文本输出。

**只保留 http(s)**：`safeHref()` 挡掉 `javascript:` 与 `data:` 伪协议。

**不要自己再写一份。** 曾经有三份实现（`ui.js` 两份 + `views/watch.js` 里的
`linkifyInto` 只认裸 URL），结果作品说明里的 `[patreon](…)` 一直显示成原始文本。
现在只有 `ui.js` 一处。

图片要放开 CSP：`img-src 'self' data: blob: https:`。外链图片直连图床，
不经过 Worker——代价是图床能看到访客 IP；若要隐藏就改成走 `/media/` 代理。

### 搜索

搜索页（`views/search.js`）有三处必须注意：

1. **`type` 必须是复数**：`videos` / `images` / `users` / `posts`。
   传单数不会报参数错误，而是 500，很容易被误判成鉴权或上游故障。
   地址栏保留旧的单数写法做兼容（`TYPE_ALIASES`）。
2. **`unwrap()` 不能顺手写 `item.user`**：作品对象自己就有 `user`（作者），
   那样会把整个作品替换成作者，标题全变「无标题」。
3. `canSearch` 要把服务端共享 Token 算进去（`session.sharedToken`），
   否则配了 `IWARA_AUTHORIZATION` 前端仍显示「需要登录」。

**排序**按板块收窄（对齐参考客户端的 FilterConfig）：

| 板块 | 可排序 |
| :-- | :-- |
| videos / images | `date`（最新）、`relevance`（相关性）、`views`（观看次数）、`likes`（点赞数） |
| users / posts / forum | `date`、`relevance` |

传上游不认的排序值**不会报错**，只会静默按默认排序，所以必须按板块过滤，
否则用户切板块后会看到「选了观看次数但顺序没变」的假象。默认 `date`。

Wrangler 部署注意：`IWARA_AUTHORIZATION` 用 `wrangler secret put` 配置，
**不能**同时写进 `wrangler.jsonc` 的 `vars`（同名会报 `Binding name already in use`）。

### 播放页版式（B 站式两栏）

播放页拆成 **5 个同级块**：`head` / `author` / `details` / `comments` / `related`。

只有同级元素才能用 `grid-template-areas` 分别控制两端的顺序，
把其中一块塞进另一块里就没法排了（踩过：评论曾塞在主栏内，
结果手机端被作者卡挤到最下面）。

```
桌面                    移动（≤1180px）
┌────────┬──────────┐   ┌──────────┐
│ head   │ author   │   │ head     │  视频 + 标题 + 数据 + 操作
│ details│ related  │   ├──────────┤
│ comments│         │   │ author   │  头像 / 关注 / 作者简介
└────────┴──────────┘   ├──────────┤
                        │ details  │  作品说明 + 标签
blocks:                 ├──────────┤
  head     播放器+标题   │ comments │  评论（每页 20 条，自动分页）
  author   作者卡        ├──────────┤
  details  说明+标签     │ related  │  相关作品
  comments 评论          └──────────┘
  related  相关作品
```

### 评论区

`mountComments()` 分页而不是无限加载：

- 每页 20 条，`pager()` 用 `onNavigate` 生成**按钮**而非链接——
  评论翻页不改地址，否则整个播放页（含视频）会重新加载。
- 翻页后滚动到评论区顶部，避免用户不知道内容已换。
- 只有一页时不渲染分页条。

`pager()` 因此有两种模式：传 `hrefFor` 出链接（列表页），
传 `onNavigate` 出按钮（就地翻页）。

### 分页

列表统一用 `renderPagedFeed()`（`cards.js`），**不是无限滚动**：

- 每页 `PAGE_SIZE = 30`。
- 页码写在地址里（`?page=2`），刷新和分享都能回到同一页。
- 切页后 `router` 会把页面滚回顶部（见 `scrollToTop()`：要连做三次，
  只调一次 `scrollTo(0,0)` 会被浏览器的滚动恢复抵消）。
- 渲染期间 `main` 会加 `.is-loading`（变淡 + 禁用点击），
  否则点了翻页之后界面纹丝不动，看起来像没反应。
- 首屏骨架屏**必须放进 `.grid` 内部**：放进 `.loadmore`（`place-items:center`）
  会被压成单列。
- `renderPagedFeed` 是**同步返回**的：先交出带骨架的节点，数据回来再填充。
  一旦改回 async 并在内部 await 接口，骨架就永远不显示（调用方 await 到的是
  已经填好的节点），表现为「骨架屏消失了」。

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

播放器**强制深色**（`color-scheme: dark`）：它盖在视频画面上，
浅色主题下变成白底会干扰观看。

---

## 测试

```bash
npm test               # 31 项后端集成（打真实 Iwara）
npm run test:gate      # 26 项站点访问密码
npm run test:routes    # 23 项路由冒烟：逐页确认没有白屏
npm run test:player    # 12 项桌面播放器手势（单击/双击/长按/画中画/键盘）
npm run test:mobile    # 13 项移动端手势（单击显隐控件、双击暂停）
npm run test:page      # 17 项分页（每页 30、翻页回顶、刷新保持）
npm run test:download  # 12 项下载文件名（含 RFC 5987 中文编码）
npm run test:linkify   # 25 项 linkify（Markdown 链接/图片、防 [object Object]）
npm run test:theme     # 7 项主题持久化与首帧无闪烁
npm run test:ui        # 播放器、悬停预览、离开即停止
npm run check          # import 具名导出一致性
npm run test:search    # 12 项搜索（复数 type / unwrap / 共享 Token）
npm run test:hardening # 31 项安全加固（路径穿越 / 媒体防盗链 / 频控 / CSRF）
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
9. **`linkify()` 返回的是 raw 包装，不是节点。** 直接 `append(linkify(...))`
   会渲染成 `[object Object]`（论坛回复就这么坏过）。要节点请用 `linkifyNode()`。
10. **骨架屏别放进 `.loadmore`。** 那里的 `place-items:center` 会把网格压成单列。
11. **改了 CSS/JS 一定要重新部署并核对线上文件。** 出现过「JS 结构已更新、
    CSS 没部署」，页面塌成一列。核对时注意两点：
    - 未过站点密码时请求静态资源会拿到 401 登录页，直接 grep 会误判成「没部署」，
      要带上 Cookie；
    - `/css/*` 与 `/js/*` 有边缘缓存，`cf-cache-status: HIT` 时可能还是旧文件，
      加个 `?v=<时间戳>` 再看。缓存 TTL 已压到 60 秒，就是为了缩短这个窗口——
      `index.html` 里的资源路径不带版本号，长缓存会导致「新 HTML + 旧 JS/CSS」。
12. **`includes('..')` 抓不到 `%2e%2e`。** 路径白名单必须同时拒绝编码形式的
    点段与分隔符（`%2e` / `%2f` / `%5c` / `%25`）：字面量检查漏掉之后，
    上游解码时可能真的变成 `../`。`api.js` 与 `media.js` 都按这个来。
13. **`contain: paint` 会裁剪子元素。** 进度条轨道曾经带 `contain: layout paint`，
    结果 9px 的圆点被压进 4px 的轨道里。需要溢出显示的容器只能用 `layout style`。
14. **共享 Token 不该让缓存失效。** 缓存只对「访客自带身份」关闭（session / inline），
    站点级共享 Token 对所有人是同一份，必须允许缓存，否则最需要省额度的场景反而零缓存。
15. **缓存 key 要带站点维度。** `_site` 只影响请求头、不影响目标主机，
    而它在构造 target 前就被删掉了，不补回 key 会让主站与 AI 站串同一个缓存条目。
16. **要排序的块必须同级。** 播放页拆成 head/author/details/comments/related
    五个同级块，才能让手机端排成「视频→作者→说明→评论→相关」；
    把评论塞进主栏内部就没法排了。

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
/search?query&type      # ⚠️ type 必须是复数，且需要有效 token
```

其他要点：

- `x-site: www.iwara.tv` 决定拿主站还是 AI 站内容。
- **`/search` 的 `type` 必须是复数**：`videos` / `images` / `users` / `posts`。
  传单数（`video`、`image`…）不会提示参数错误，而是直接返回
  `500 {"message":"errors.serverError"}` —— 这正是搜索「用不了」的真正原因，
  很容易被误判成鉴权或上游故障。
- `/search` 还需要有效 token；未登录时同样返回 500。
- `type=forum` 目前上游固定 500（服务端故障），前端已单独提示。
- `subscribed=true` **未登录时被上游静默忽略**，会返回全站内容且不报错——
  所以订阅页把登录作为硬前置条件。
- Iwara 没有服务端观看历史接口，历史只能是本地的。
