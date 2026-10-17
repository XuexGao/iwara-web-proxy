# Iwara 映像 · Cloudflare Workers 网页版

把 Iwara（iwara.tv）搬到 Cloudflare 边缘网络上：**一个 Worker 同时承担网页、接口反代和视频流代理**，
浏览器打开就能浏览、搜索、播放、收藏，全部流量走 Cloudflare，不依赖任何本地服务器或第三方中转。

界面是完整的单页应用：作品索引、标签、图库、播放列表、作者页、论坛、评论区、收藏与观看历史。
播放器自建控件，支持清晰度切换、进度条悬停预览、画中画、键盘快捷键和**跨页面常驻的迷你播放器**。

---

## 目录

- [它能做什么](#它能做什么)
- [快速部署](#快速部署)
- [配置项](#配置项)
- [工作原理](#工作原理)
- [本地开发](#本地开发)
- [接口一览](#接口一览)
- [已知限制](#已知限制)
- [常见问题](#常见问题)
- [致谢](#致谢)

---

## 它能做什么

| 模块 | 状态 | 说明 |
| :-- | :-- | :-- |
| 作品索引 | ✅ | 本周热门 / 最新 / 最受喜爱 / 点赞最多 / 播放最多，无限滚动 |
| 分级开关 | ✅ | 默认显示全部内容，可一键切到只看一般向 |
| 标签 | ✅ | 标签总览 + 标签下的作品列表 |
| 图库 | ✅ | 插画作品列表与多图浏览（键盘 ← → 切换） |
| 播放列表 | ✅ | 列表与详情 |
| 作者页 | ✅ | 作品 / 图库 / 播放列表 / 粉丝 / 关注，可关注取关 |
| 播放器 | ✅ | 清晰度切换、进度条悬停预览、画中画、全屏、倍速外的全部常用操作 |
| 悬停预览 | ✅ | 鼠标停在封面上播放 Iwara 自带的 preview 片段，左右移动可擦拭进度 |
| 迷你播放器 | ✅ | 切页面视频不中断，搬进右下角继续播，回来时进度不丢 |
| 评论区 | ✅ | 阅读 +（登录后）发表 |
| 搜索 | ✅ | 视频 / 图库 / 作者 / 论坛 / 帖子，**需要登录**（上游接口要求认证） |
| 收藏与历史 | ✅ | 收藏需登录；观看历史存在本机 |
| 论坛与帖子 | ✅ | 只读 |
| 账号登录 | ✅ | 邮箱密码登录，Token 加密存放在 HttpOnly Cookie 里 |

---

## 快速部署

前置：Node.js 18+ 与一个 Cloudflare 账号（免费版足够）。

```bash
git clone https://github.com/<你的用户名>/iwara-web-proxy.git
cd iwara-web-proxy

npx wrangler login                 # 首次使用需要授权
npx wrangler secret put SESSION_SECRET
# 粘贴一段随机字符串（至少 16 位），例如：openssl rand -base64 32
# 这个密钥用来加密登录后的 Token，不配置则登录功能关闭，其余功能照常。

npx wrangler deploy
```

部署完会输出形如 `https://iwara-web.<你的子域>.workers.dev` 的地址，直接打开即可。

> **建议**：公开部署时开启站点级 Basic Auth，避免额度被陌生人消耗（见下一节 `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`）。

---

## 配置项

### 普通变量（写在 `wrangler.jsonc` 的 `vars` 里）

| 变量 | 默认值 | 作用 |
| :-- | :-- | :-- |
| `SITE_NAME` | `Iwara 映像` | 站点名称，显示在标题与接口配置里 |
| `DEFAULT_SITE` | `main` | 内容来源：`main` = iwara.tv，`ai` = iwara.ai |
| `API_CACHE_TTL` | `30` | 上游 GET 接口的缓存秒数，用来省每日请求数；`0` 关闭 |
| `IMAGE_CACHE_TTL` | `604800` | 封面/头像缓存秒数 |
| `VIDEO_CACHE_TTL` | `3600` | 视频分片在边缘的缓存秒数 |

### 密钥（用 `wrangler secret put` 配置，不要写进配置文件）

| 变量 | 必需 | 作用 |
| :-- | :-- | :-- |
| `SESSION_SECRET` | 登录功能必需 | 加密会话 Cookie 的密钥，≥16 位随机字符串 |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | 可选 | 站点级 Basic Auth，设了之后整个站点都要先过这层 |
| `IWARA_AUTHORIZATION` | 可选 | 访客共享 Token。填了之后**未登录访客也能用搜索等功能** |

> `IWARA_AUTHORIZATION` 填的是 Iwara 的 **access token**。共享账号 Token 有被滥用的风险，
> 如果要用，务必同时开启 Basic Auth。

---

## 工作原理

```
浏览器  ──►  Cloudflare Worker  ──►  apiq.iwara.tv        业务接口
                 │                 ├─ filesq.iwara.tv      清晰度清单
                 │                 ├─ i.iwara.tv           封面 / 头像 / 原图
                 │                 └─ *.iwara.tv            视频分片节点
                 │
                 └──► 静态资源（HTML/CSS/JS/字体）由 Cloudflare 直接返回，不计 Worker 请求数
```

### 三件核心的事

**1. X-Version 签名。** Iwara 的视频地址是 `https://filesq.iwara.tv/file/<uuid>?expires=...&hash=...`，
请求它的清晰度清单时必须带上一个签名头：

```
X-Version = sha1("<uuid>_<expires>_<盐值>")
```

盐值写死在官网前端 `main.<hash>.js` 里，官方换盐时所有人都得跟着换。
这里的做法是：内置一个当前盐值，并把「清单里没有原画档」当成盐值失效的信号，
自动去官网首页找到 `main.js`、正则提取新盐值、重签重发一次。取不到就沿用低清结果，至少还能看。

**2. Range 分片透传。** 播放器拖动进度条时浏览器发 `Range` 请求，
Worker 把 `Range` 原样转发给分片节点，返回 `206` 与 `Content-Range`，不缓冲整个文件。

**3. 会话加密。** 登录流程与官方前端一致：

```
POST /user/login  {email, password}          → { token }       # refresh token，约 30 天
POST /user/token  Authorization: Bearer <rt> → { accessToken } # 短期 access token
业务接口           Authorization: Bearer <at>
```

浏览器侧只保存一枚 `HttpOnly + Secure + SameSite=Lax` 的 Cookie，
内容是 AES-GCM 加密后的 Token 串，**明文 Token 不会进入前端 JS，也不会落到 localStorage**。
access token 过期时服务端自动用 refresh token 续期，续期失败就静默回到访客态。

### 目录结构

```
src/
  index.js       路由与 Worker 入口
  api.js         /api/iwara/* 业务接口反代（白名单 + 可选边缘缓存）
  media.js       /media/* 视频与图片代理（Range、主机名校验）
  sources.js     清晰度清单解析 + X-Version 签名 + 盐值自愈
  session.js     登录、Token 交换、会话 Cookie
  upstream.js    上游请求头、UA、站点级 Basic Auth
  util.js        编码、AES-GCM、Cookie、响应构造
public/          前端单页应用（原生 ES 模块，无构建步骤）
  js/views/      各页面视图
tools/shot.mjs   本地视觉检查脚本
test/            后端集成测试（打真实上游）
```

---

## 本地开发

```bash
node dev-server.mjs        # http://127.0.0.1:8788
node test/backend.test.mjs # 31 项后端集成测试，打真实 Iwara 接口
```

`dev-server.mjs` 是一个薄适配层：静态资源从 `public/` 读盘，
`/api/*` 与 `/media/*` 交给真正的 Worker 处理器，因此本地与线上跑的是同一份代码。

> 它会把上游请求交给 `curl` 发出。原因是 Node 的 TLS 指纹配上浏览器 UA 会被 Cloudflare
> 当成可疑客户端并返回挑战页，而线上跑在 Workers 里不存在这个问题。

---

## 接口一览

### 自有接口

| 方法 | 路径 | 说明 |
| :-- | :-- | :-- |
| GET | `/api/status` | 运行状态、盐值来源、各项开关 |
| GET | `/api/auth/config` | 登录是否可用、是否配置了共享 Token |
| GET | `/api/auth/me` | 当前会话 |
| POST | `/api/auth/login` | 邮箱密码登录 |
| POST | `/api/auth/token` | 用现成 Token 登录（access 或 refresh 都接受） |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/sources/:videoId` | 解析出的清晰度清单（已转成本站地址） |
| GET | `/media/i/image/<size>/<id>/<name>` | 图片（`thumbnail`/`large`/`original`/`avatar`/`profileHeader`） |
| GET | `/media/v?u=<签名地址>` | 视频与下载，支持 `Range`；加 `&dl=<文件名>` 触发下载 |

### 业务接口反代

```
/api/iwara/<上游路径>?<原样查询串>   →   https://apiq.iwara.tv/<上游路径>?<原样查询串>
```

第一层路径必须是白名单内的（`videos`、`video`、`images`、`image`、`search`、`tags`、`tag`、
`profile`、`user`、`playlists`、`playlist`、`forum`、`post`、`posts`、`comment`、`comments`、
`autocomplete`、`notifications`、`favorites`、`light`、`page`、`rules`、`conversation`、`message`）。
`user/login` 与 `user/token` 被显式屏蔽，由本 Worker 自己实现。

响应原样透传，不做二次变形——这样 Iwara 加字段时前端不需要跟着改代理。

---

## 已知限制

- **搜索需要登录。** 这是 Iwara 上游的限制：`/search` 在没有有效 access token 时固定返回 500。
  不想让每个访客都登录，可以用 `IWARA_AUTHORIZATION` 配一个共享 Token。
- **免费版每天 10 万次请求。** 拖进度条、切清晰度、翻页都会消耗请求数。
  接口默认缓存 30 秒、图片缓存 7 天能省下相当一部分；真要公开大规模使用建议上付费计划。
- **上游改版会出问题。** 接口路径、字段、签名盐值都由 Iwara 决定，随时可能变。
  出现「只剩 360P」通常就是换盐了——Worker 会自动去官网取新盐，取不到就得改内置值。
- **人机校验。** 极小概率上游会对 Cloudflare 出口返回挑战页，此时接口会返回 502 与一句说明。
- **不存储、不转码、不限速。** 所有媒体都是从 Iwara 原样转发，版权归原作者。

---

## 常见问题

**部署后打开是一片空白？**
先看 `/api/status` 是否返回 200。若返回 401，说明你设了 Basic Auth 但没输入账号密码。

**登录报「未配置 SESSION_SECRET」？**
执行 `npx wrangler secret put SESSION_SECRET` 后重新部署。

**视频只有 360P？**
上游换签名盐值了。打开 `/api/status` 看 `salt.isDefault`；若为 `true`，
把官网 `main.js` 里的新盐值替换 `src/sources.js` 的 `DEFAULT_SALT`，或者等一次自动刷新后重试。

**想只用它的接口做别的客户端？**
可以。业务接口保持透明，媒体接口可以直接嵌进 `<video>`。跨域时媒体接口已经带 `Access-Control-Allow-Origin: *`。

---

## 致谢

本项目参考了这两个项目的做法与经验：

- [Iskongkongyo/iwaraVideoProxy](https://github.com/Iskongkongyo/iwaraVideoProxy) —
  最早用 Cloudflare Worker 反代 Iwara 视频并处理 Token / Basic Auth 的实践
- [FoxSensei001/LoveIwara](https://github.com/FoxSensei001/LoveIwara) —
  完整的第三方 Iwara 客户端，接口清单、X-Version 签名算法与盐值自愈思路来自这里

内容版权归 Iwara 与各位原作者所有。本项目只做网络转发，不存储任何作品。

MIT License.
