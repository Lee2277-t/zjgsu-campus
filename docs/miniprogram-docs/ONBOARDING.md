# 接手指南（ONBOARDING）

新人接手 / 接手维护时按本文件走一遍。配合 `README.md`（配置速查）与 `ARCHITECTURE.md`（模块地图）。

---

## 1. 第一天 checklist

- [ ] 微信开发者工具导入本目录（`project.config.json` 所在目录）
- [ ] 开通云开发，拿到环境 ID，填入 `utils/config.js` → `CLOUD_ENV`
- [ ] 部署云函数：`cloudfunctions/login`、`cloudfunctions/user`（右键 → 上传并部署）
- [ ] 建集合 + 设权限 + 建索引：照 **`docs/DATABASE.md`** 走一遍（37 个集合；权限只有 `posts`/`reviews`/`courses` 选「**所有用户可读**」，其余 34 个选「**所有用户不可读写**」——后者就是口语说的"仅管理端可读写"，**别选成「仅创建者可读写」**，那是以记录为单位的私有，语义不同；索引那节分了"必须建 / 建议建 / 不用建"三档，**必须建**那 8 个漏一个就会变成"列表空但不是没数据"）
- [ ] 配图片审核回调：**云开发控制台** → 设置 → 其他设置 → 消息推送 → 推送模式选「云函数」→ 添加 `event` / `wxa_media_check` → 云函数 `user`。⚠️ 不是 `mp` 后台那条（那是给自建服务器 URL 用的，且被云开发这条废掉）。步骤与验收办法见 `docs/DATABASE.md` §4
- [ ] 编译运行，看 Console 有无报错
- [ ] 跑全量检查：在仓库根目录 `recon/` 下 `npm run check`（**46 个脚本**：16 静态 / 29 行为 / 1 联网 / 2 Python，约 46 秒；断网时 `npm run check:offline`）
- [ ] 代码质量重新扫描（开发者工具 → 代码质量），确认「图片和音频资源 ≤ 200K」已通过
- [ ] `mp.weixin.qq.com` → 设置 → 用户隐私保护指引，勾选 **相册**、**文件（聊天记录）**
- [ ] 真机预览，验证选图 / 选文件 / 发帖 / 点赞链路
- [ ] 读 `utils/store.js`（聚合入口，看它重导出的 8 个 `store-*.js` 模块）与 `utils/user.js` 文件头的职责注释

---

## 2. 环境自检（出问题时先排查这 5 项）

| 现象 | 最可能原因 | 排查 / 修复 |
|---|---|---|
| 「我的」页认不到自己 / 点赞归属错乱 | `login` 云函数未部署，openid 拿不到 | `cloud.openidTrouble()` 看 `ok`；确认 `cloudfunctions/login` 已部署 |
| 点「发布/投进树洞」长时间「投放中…」或无反应 | `user` 云函数未部署 / 网络黑洞，`callFunction` 挂起 | 部署 `user` 云函数；前端已有 5s/12s 超时兜底，失败会留本地并提示 |
| 真机选图 / 选文件被微信拦截 | 隐私指引未勾选相册/文件权限 | `mp` 后台勾选；`utils/upload.js` 的 `ensurePrivacy()` 是前端那道门 |
| 某处图标空白 | 新增用法用到已被移出的「图标名+配色」组合 | 从 `_trash/icons-unused-*/` 取回对应 SVG；后续加图标先查 `assets/icons/` |
| 悬浮按钮 / 底部输入栏沉不到屏幕底部 | `.container`/`.page-scroll` 被加了 `transform` | 删除该 transform（见 `app.wxss` 文件头两条硬约束） |
| 「审核/复制身份ID」入口不显示 | `config.MODERATORS` 没填你的 openid | 填 openid（仅显隐入口；真权限在云函数环境变量） |
| 订阅消息收不到 | `SUBMSG` 模板 ID 或云函数 `SUBMSG_REPLY/CHAT` 环境变量未配 | 按 `config.js` 注释去 mp 公共模板库取 ID 并两端都配 |
| 冷启动首次点击发帖卡顿 | 云开发首次 `init` 慢 | 已用 `whoami` 预热 + 启动提前 `ensureCloud`；若仍慢检查云函数冷启动 |
| 某个列表**空但不是真的没数据**（私信 / 好友申请 / 审核队列 / 名片页历史发帖） | 复合索引没建，`where + orderBy` 查询报错被 `.catch` 吞成空数组 | 按 `docs/DATABASE.md` §3.1 建那 7 个索引。这类问题**没有任何前台报错**，只能靠索引清单排查 |
| 带图的帖子一直「审核中」，10 分钟后突然发出去 | 消息推送没配，审核回执回不来 | 去**云开发控制台**配（`docs/DATABASE.md` §4，不是 `mp` 后台那条）。兜底扫描会在 10 分钟后标 `unverified` 放行 —— **功能不断，但审核形同虚设** |
| 发了带图的帖子，但 `media_audit` 一条记录都没有 | `config.json` 缺 `security.mediaCheckAsync` 权限，或权限改了没重新部署 | 补权限 → 重新部署。缺它时代码直接 `return` 放行，**不报任何错** |
| 深色模式下某块还是浅色 | 那处的色值写死了 hex，没走 `--c-*` 令牌 | 换成令牌（`ARCHITECTURE §9.1`）。**这种漏改不报任何错**，只能靠 `check-theme.cjs` 的残留审计或肉眼 |

---

## 3. 「改 X 需求，动哪个文件」速查

| 你要改的需求 | 优先看的文件 |
|---|---|
| 课程评价 / 评分卡 / 教师榜 | `utils/store-course.js` + `pages/course/*` |
| 论坛列表 / 树洞 / 投票 / 评论 | `utils/store-forum.js` + `pages/forum/*` |
| 闲置（失物/二手）发布与状态 | `utils/market.js` + `pages/market/*` |
| 校园活动 / 报名 | `utils/event.js` + `pages/campus/*` |
| 官网公告 / 招聘会 / 宣讲会（定时抓取） | `cloudfunctions/user/index.js`：`WEB_SOURCES` 四栏目（静态页，通道 `webGet`）+ `JYW_CHANNELS` 两条就业网通道（ajax 接口，通道 `webPostJson`）。采集窗口在 `syncOfficialEvents` / `syncJywChannel`，展示窗口在 `pages/campus/campus.js` 的 `inWindow` —— **改一处必须同时改另一处**，否则会出现「库里存着、界面上不显示」。招聘会「0 条」的三种成因见 `campus.js` 的 `syncTrouble`，别只看计数 |
| 就业网数据源（为什么不用公众号） | `docs/ARCHITECTURE.md` §8 —— 公众号无可用列表接口、搜狗只是关键词检索且标题无结构化时间；就业网是源、公众号是渠道。**下一个想接公众号的人先读这一节** |
| 私信 / 好友关系 | `utils/chat.js` `utils/user.js`(关系接口) + `pages/user/chats*`。**加好友不做独立入口**：动作在 `utils/friend.js`（`ask` 留言弹窗），触发点在名片页 `pages/user/card/*`、找同学的搜索结果行内、会话页发满 3 条后的锁块 —— 三处共用一份实现 |
| **解除好友** | 云函数 `removeFriend`（双向删 `friends` + 清 `contacts` 双向所有记录 + 会话上盖 `quotaResetAt`）+ `utils/friend.js` 的 `remove`（带名字的二次确认）+ 落点：名片页「关系管理」卡、「我的同学 → 同学」名单行内「解除」。⚠️ 三个动作少做一件就会留下「解除了但还显示是好友」或「再也加不回来」，改之前先读云函数那段注释 |
| **非好友的消息配额** | 上限与取舍：云函数 `STRANGER_QUOTA` 一节（**双方各自 3 条 / 好友不限**），判定 `chatQuota`（回执 `used` 我发了几条 / `peerUsed` 对方发了几条 / `left` 还剩几条），闸门在 `chatSend` 里**写库之前、拉黑检查之后**；前端只是把 `quota` 翻成人话（`pages/user/chat/chat.js` 的 `quotaText` / `sendAllowed` / `lockText`）。四个落点（云端判定、`utils/friend.js` 的 `STRANGER_QUOTA`、`pages/user/card/card.js` 里说给用户听的条数、会话页文案）**必须一致** |
| 选图 / 选文件 / 上传 | `utils/upload.js` |
| 路由跳转 / 防连点 | `utils/nav.js` |
| 全局样式 / 主题色 | `app.wxss`（设计令牌）+ 各页 wxss |
| **深色模式**（跟随系统） | `app.wxss` 的 `page{}` 里 29 个 `--c-*` 令牌 + `@media (prefers-color-scheme: dark)` 只换令牌值；导航栏/tabBar 走 `theme.json`（自定义变量名）+ `app.json` 的 `"darkmode": true` 与 `@navBgColor` 引用。改完跑 `node scripts/check-theme.cjs`（校验两侧令牌集一致、无悬空 `var()`、无死令牌）。**细节见 ARCHITECTURE §9.1** |
| **列表分页** | `utils/pager.js`（`reset` 换筛选归零 / `keep` 保留进度 / `more` 触底 / `all` 取全量）。接入页：我的帖子、同学名单、学习资料、校园活动-同学发起。**细节见 ARCHITECTURE §9.2**，回归 `node scripts/test-pager.cjs` |
| **收藏招聘会** | `utils/store-favorite.js` 的 `toggleFavorite`（收藏项带 `when`/`place` 快照，因为官方活动出时间窗口后列表里就没有了）+ `pages/campus/*` 的收藏按钮 + `sub/mine/favorites/*` 第 5 个页签。回归 `node scripts/test-jobfav.cjs` |
| **客户端错误上报** | `utils/report.js` 是唯一出口（指纹去重 / 单次启动封顶 8 条 / 永不冒泡）。接线点：`app.js` 三个全局钩子 + `pages/campus/campus.js` 的云函数版本落后。**细节见 ARCHITECTURE §9.3**，回归 `node scripts/test-report.cjs` |
| 配置项（环境/开关/审核员） | `utils/config.js` |
| 后端读写 / 审核处置 / 收藏 | `cloudfunctions/user/index.js`（按 `action` 找） |
| 封号 / 解除封禁 / 封禁名册 | 云函数 `banUser` `unbanUser` `banList`（状态记在 `users` 文档的 `banned` 字段）+ `pages/admin/moderation/*` 第 4 个分段 + `pages/user/card/card.js` 的「管理操作」（名片页直接封） |
| 名片页「TA 的历史发帖」 | 云函数 `postsByAuthor`（权威，过滤匿名/树洞/下架）+ `utils/store-forum.js` 的 `getPostsBy`（本地兜底）+ `pages/user/card/*`。**匿名与树洞帖必须两端都挡，改过滤条件时先看 `postsByAuthor` 的注释** |
| 小红点（帖子被回复 / 私信未读） | `utils/unread.js`（改一处全站一致；接点见文件头注释） |
| 「我的」页三个数字卡 / 我的帖子列表 / 我的课程评价列表 | `pages/mine/mine.*`（只放可点入口）+ `sub/mine/posts/*`、`sub/mine/reviews/*`（列表与删除、清空、恢复展示都在各自页里）。**入口行别再加「我的收藏」这类重复项**，一屏里同一件事出现两次，用户会犹豫这俩是不是不一样 |
| 留言带图片 | 云函数 `postComment`（`cloud://…/comment/…` 白名单、最多 3 张）+ `utils/store-forum.js` 的 `addComment`（返回 `{comment, done}`）+ `sub/forum/detail/*`。改上限时三处一起改：`COMMENT_IMG_MAX`（云函数）/ `MAX_IMG`（页面，通过 `data.maxImg` 交给模板）|
| 帖子/留言的头像与昵称 | 快照字段 `avatarUrl`（发帖 / 留言那一刻写进记录，和 `author` 昵称同一个道理，不做实时回查）；展示在 `sub/forum/detail/*` 的 `.detail__byline`（作者行）与评论头像列。**「谁的头像」三处必须一致**：`utils/store-forum.js` 的 `decoratePost`（帖子，匿名 → `showAvatar:''` + `avatarText:'匿'`）、`sub/forum/detail/detail.js` 的 `decorateComments`（留言）、云函数 `safeAvatar`（只认 `avatars/` 目录的云文件，外链与本机路径一律丢成空串）。头像加载失败走 `binderror` → 退回文字头像，别留空圆框 |
| 隐私授权弹窗 | `utils/privacy.js` |
| 全站搜索 | `utils/search.js`（内核，前端/云函数共用一份） |
| 内容安全（屏蔽词/举报原因） | `utils/moderation.js` |
| 品牌图标 / 校徽矢量 | `assets/brand/` + **`assets/brand/design-sheet.html`（设计说明，先看这个）**。图形由 `tools/emblem/trace.py` 从官方位图描摹、`build.cjs` 出 PNG 并做保真度校验；**改图形只能改描摹参数再重跑，不要手工改 SVG 里的路径**（手改会让保真度校验失效）。`tools/` 与 `assets/brand/source/` 已在 `project.config.json` 的 packOptions.ignore 里，不进小程序包 |

---

## 4. 改动前必读的铁律

1. **云函数调用只能走 `cloud.callFunction(action, payload)`**，别在业务模块另写 `wx.cloud.callFunction`。
2. **本地存储键**集中放 `store-base.js` 的 `KEYS` / `user.js` 的 `KEY`，新增键不要散写字符串。
3. **隐私敏感字段**（联系方式）只在云函数过滤后返回，前端缓存不存他人隐私。
4. **样式硬约束**（`app.wxss` 文件头）：`.container/.page-scroll` 不动 `transform`；不用 `backdrop-filter`/`clamp`。
5. **数据层导航**：`store.js` 已拆为 `store-*.js` 模块，改动前先读聚合入口与各模块文件头职责注释，按模块定位，别通读全文。
6. **跨模块引用必须显式 require**：`store-*.js` 之间**不共享作用域**。用别的模块的顶层常量
   （`SEED_VERSION` / `PAGE_SIZE` / `SEED_POST_IDS` / `FAV_MAX` …）或共享工具函数
   （`today` / `genId` / `searchCore` …）时，必须写进文件头的 `const { … } = require('./store-base.js')`。
   漏了不会编译报错，但**真机一跑到那行就 `ReferenceError`**——拆单体文件最容易踩的就是这个。
7. **删除图标/资源前**先确认无引用（历史备份在**项目外**的 `recon/_trash/`，不是随意删）。
8. **备份 / 临时文件 / 校验脚本一律放小程序项目目录（`miniprogram/zjgsu-campus/`）外面。**
   开发者工具会把 `pages/**` 下的 `.js` 当页面编译，去找配套 `.wxml`——
   备份只拷了 `.js` 没拷 `.wxml` 就会报
   `WXML file not found: ./_trash/xxx/pages/.../list.wxml`，**整个项目编译不出来**。
   这个坑已经踩过一次（2026-09-29）。备份请放 `recon/_trash/`；
   真要在项目内备份 `pages/` 下的文件，**必须 js + json + wxml + wxss 整套拷**。
9. **给用户看的提示只能走 `utils/feedback.js`，不许裸调 `wx.showToast` / `wx.showLoading`。**
   微信把 Toast 和 Loading 放在同一块视图上，同一 tick 里「先 Toast 再 hideLoading」会把 Toast **吞掉**——
   用户看到的就是「点了按钮毫无反应」，而且按机型偶发，最难查。这个项目已经栽过一次（2026-09-29）。
   `feedback.toast()` 内部会先收 Loading、隔 30ms 再弹，这个顺序别改。
10. **任何会 await 的用户操作都必须有超时上限。** `feedback.run({ task, ms, timeoutMsg })`
    是现成的总闸。别相信「下面那段函数自己有超时」——串起来就是 12+15+12 秒的黑窗。
    同理，**注释里写了几秒不算数**，要真的有 `Promise.race` / `withTimeout` 在那儿
    （`store-base.js` 的 `waitOpenid` 以前注释写着「最多 2.5 秒」，实际一次超时都没有，能等 15 秒）。
11. **长得像按钮的东西必须真的绑了 `bindtap`。** 「只有样式没有事件」的假按钮用户一定会去点，
    点了没反应就是 Bug（树洞的 `#难过 / #迷茫 / #抱抱` 就是这么来的，2026-09-29 才补的 handler）。
12. **iOS 横向溢出三件套**：`app.wxss` 的 `page` 锁 `overflow-x: hidden`（**别锁 y**，会废掉下拉刷新）；
    横向 `scroll-view` 里的行必须 `display: inline-flex` + `white-space: nowrap`（只写 flex 在 iOS 上会换行，
    被裁掉的行横向滑动时会漏出来）；**收起的折叠面板不能带 `transform`** ——
    里面有 `<textarea>` 这类原生组件时，父容器一 transform，横向重绘就会把内容画到容器外面。
13. **提交按钮不许用 `disabled="{{submitting}}"` 之类的状态去禁用。**
    一旦上一次提交卡住（云函数没回声、或者切后台时 `setTimeout` 被系统暂停），
    `submitting` 永远解不开，按钮变成**点了连事件都不触发**——连一句提示都没有，
    是最硬的一种「毫无反应」。正确做法：按钮永远可点，由 JS 判断并给提示；
    判断「上次是不是过期了」用**点击时间戳**（`Date.now() - this._submitAt`），
    **不要用定时器复位**——真机切后台/锁屏时定时器会被系统暂停，回来照样是死的。
    （发帖页和树洞 2026-09-29 各踩一次）
14. **提示之前先收键盘。** `feedback.toast()` 里已经统一调了 `wx.hideKeyboard()`。
    真机上用户是「打完字直接点发送」，软键盘占着下半屏，Toast 弹在它后面——
    提示其实弹了，用户一个字没看到，结论还是「点了没反应」。别把这个调用删了。
15. **按下那一帧必须有反馈：view 的 `:active` 在小程序里不可靠，必须写 `hover-class`。**
    iOS 收键盘那一帧偶尔会吞掉第一次点击，没有 `hover-class` 时用户连「按到了没」都不知道。
    新加可点元素时，`class` 里带上 `.tap` 之外还要给 `hover-class` + `hover-start-time="0"`。
16. **弹窗之间会互相抢屏幕。** `wx.requestSubscribeMessage` / `wx.showModal` 这类系统弹窗
    会盖掉刚弹的 Toast。发帖成功后要订阅授权，必须排在 `wx.navigateBack` **之后**再要，
    先让「发布成功」那句露够脸（现在是返回 900ms、再过 600ms 才要授权）。
17. **色值一律写 `var(--c-xxx)`，不许再写 hex。** 深色模式是"换一套令牌值"实现的
    （`app.wxss` 的 `page{}` 定义 + `@media (prefers-color-scheme: dark)` 重定义），
    写死的 hex 到了深色下就是一块浅色补丁，而且**没有任何报错**，只能靠肉眼看。
    需要新颜色就先在两处各加一个令牌。`node scripts/check-theme.cjs` 会拦住
    "只在一侧加了令牌"这种情况。页级 `*.json` 的 `backgroundTextStyle` 同样要写
    `"@pageBgTxtStyle"`，写死 `"dark"` 的话深色下拉时那三个点看不见。
18. **长列表分页一律用 `utils/pager.js`，不要在各页自己切数组。** 自己切最容易漏两条：
    ① 「清空」这类作用在全体的操作遍历了**切片**（只删掉已展开的几条，提示却写"已清空"）；
    ② 顶部「共 N 条」写的是切片长度，往下划两屏数字会自己变大。两处都已由
    `scripts/test-pager.cjs` 钉住。触底前记得 `if (!this.data.hasMore) return`。
19. **错误上报只报意外，且只能走 `utils/report.js`。** 断网、用户点取消、表单没填完、
    命中敏感词都是正常流程，报上来只会淹没真正的 bug（一次断网能灌满 `errors` 集合）；
    所以上报是**手动调用**的，别往每个 `catch` 上挂。上报函数内部不许 `showToast`
    —— 用户已经遇到一个错误了，不能因为上报再给他弹一个。

---

## 5. 验证手段

> **先跑一条命令：`npm run check`（在仓库 `recon/` 下）** —— 它把下面这些全串起来了，
> 分「静态 / 行为 / 联网」三组跑，约 15 秒，末尾给出通过数与失败清单。
> 断网时用 `npm run check:offline`（跳过真打就业网那一条）。
> **改完任何东西，先跑它，再谈别的。**

- **跨模块引用检查（静态）**：`node scripts/check-store-refs.cjs`（在仓库 `recon/` 下跑）——查 `store-*.js` 之间有没有「用了没引」
- **数据层冒烟测试（运行期）**：`node scripts/smoke-store.cjs`——真加载聚合入口并逐个调用导出函数，本地/云端双模式
- **发送链路回归**：`node scripts/smoke-flow.cjs`——提示有没有真的弹出来、超时有没有兜住、树洞标签能不能点。
  改了 `feedback.js` / 发帖 / 树洞 / 任何 Add Toast 的地方都要跑
- **「绝不静默」专项**：`node scripts/smoke-send.cjs`——按钮会不会被 disabled 卡死、
  提示有没有被键盘挡住、切后台后状态会不会解不开、按下有没有反馈。
  **动提交按钮 / 提交状态 / 反馈层就跑这个**（45 项）
- **加载期抛错**：`node scripts/check-page-load.cjs`——真 require 页面 js，抓「Page() 没执行到」
  这类错误。它的表现极具迷惑性：按钮 hover 照样变色，但点下去毫无反应。
- **require 路径大小写**：`node scripts/check-require-case.cjs`——Windows 上大小写不敏感，
  真机（Linux 系）敏感，`require('./Utils/x.js')` 在开发者工具里完全正常、真机直接白屏。
- **深色模式令牌**：`node scripts/check-theme.cjs`——light/dark 两侧令牌集必须完全一致、
  `@变量` 无缺失无冗余、无悬空 `var(--c-*)`、无定义了没人用的死令牌。
  **动了 `app.wxss` / `theme.json` / `app.json` 就跑**
- **尺度合法性**：`node scripts/check-ui-scales.cjs`——字号在十档内、圆角在五档内、
  间距是 4rpx 的倍数、字重只有 400/500/600/700。
  **动了任何 wxss 就跑**（树洞 / 盲盒 / 引导页豁免：它们是固定深色设计，自成一套尺度）。
  这类漂移肉眼抓不住——25rpx 和 24rpx 并排没人看得出，但攒够十几处整页节奏就散了
- **视觉对齐审计**：`node scripts/audit-align.cjs`——只出报告不做断言。列出各页容器左边距、
  卡片垂直间距、热区高度的分布，用来回答「切到相邻 tab 时内容会不会左右/上下跳」。
  **不一致不等于错**，有的页面留白大是有意的；判断标准是会不会跳
- **tabBar 图标对比度**：`node scripts/check-tabbar-icons.py`——深色底上图标不能糊成一团，
  脚本直接解 PNG 算感知亮度
- **tabBar 图标几何**：`python scripts/normalize-tabbar-icons.py`——墨迹尺寸与画心是否一致。
  微信按 81×81 整张贴图，不会按内容对齐，所以「看起来大小不一」只能靠画布里的墨迹来保证；
  换图标后跑 `--fix` 就地缩放居中
- **列表分页**：`node scripts/test-pager.cjs`——**「清空」取的是全量不是切片**、
  「共 N 条」用的是 `total`、四处 `keep`/`reset` 语义正确
- **收藏招聘会**：`node scripts/test-jobfav.cjs`——截断长度、快照字段、向后兼容
- **错误上报**：`node scripts/test-report.cjs`——30 分钟静默期、单次启动封顶 8 条、
  云侧抛错/拒绝/缺接口/storage 读写失败时**一律返回 false 且不往外抛**
- **招聘会展示口径**：`node scripts/test-campus-jobfair.cjs`——时间窗口、三种同步故障话术、
  云函数版本落后有没有上报
- **语法/引用体检**：`node _syncheck.js`（在 `miniprogram/zjgsu-campus/` 下，488 文件级扫描，
  含 `cloudfunctions/`，改完必跑）；`npm run check` 里那一条 `run-syncheck.cjs` 就是它的壳
  （为绕开根目录 `"type": "module"` 导致小程序 `.js` 被当成 ESM）
- **版本指纹对账**：`node scripts/check-build-fingerprint.cjs`——云函数 `BUILD` /
  校园页 `CLOUD_BUILD` / 关于页 `EXPECT_BUILD` 三处必须一致，
  `FEATURES` 清单里的关键能力不能被静默删掉（删了等于旧版云端也被当成新版）
- **代码质量扫描**：开发者工具 → 代码质量 → 重新扫描（确认无未通过项）
- **真机预览**：上传/选图/发帖/点赞 必须真机验证（开发者工具不校验隐私与部分真机限制）

> ⚠️ **只验证「导出名字齐全」是不够的**——`verify_store.cjs` 一度全绿，但 `store-sync.js`
> 仍漏引了 `SEED_VERSION`，小程序启动即崩。前两项检查就是为堵这个洞加的，动数据层请都跑。
