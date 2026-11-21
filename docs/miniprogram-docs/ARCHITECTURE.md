# 架构与模块职责（ARCHITECTURE）

本文件面向**接手维护的开发者**，讲清整体分层、每个模块干什么、关键逻辑怎么走、数据怎么流动。
代码细节以 `utils/*.js` 文件头注释为准，本文件是「地图」而非「字典」。

---

## 1. 分层架构

```
┌──────────────────────────────────────────────────────────────┐
│  视图层  pages/(8 业务域)  +  components/(ui 通用 / course 业务) │
│  WXML 只做展示与事件绑定；逻辑一律下沉到 utils，不要往 wxml 塞函数 │
└───────────────┬──────────────────────────────────────────────┘
                │ require('./utils/xxx')
┌───────────────▼──────────────────────────────────────────────┐
│  逻辑 / 接口层  utils/                                          │
│  store.js(聚合)→store-*.js 数据层 │ user.js 身份关系 │ upload.js 上传 │ nav.js 路由 │
│  search/privacy/notify/haptic/system/event/market/bottle/chat… │
└───────────────┬──────────────────────────────────────────────┘
                │ require('./cloud.js').callFunction(action, payload)
┌───────────────▼──────────────────────────────────────────────┐
│  通信层  utils/cloud.js                                         │
│  云开发懒初始化 + 统一云函数入口（所有模块共用同一份 callFunction）  │
└───────────────┬──────────────────────────────────────────────┘
                │ wx.cloud.callFunction({ name:'user', data:{action} })
┌───────────────▼──────────────────────────────────────────────┐
│  后端层  cloudfunctions/                                        │
│  login/index.js（仅 openid）│ user/index.js（action 路由 catch-all）│
└───────────────┬──────────────────────────────────────────────┘
                │ 云数据库 / 云存储
┌───────────────▼──────────────────────────────────────────────┐
│  存储层  云数据库（文档集合）+ 云存储（图片/文件）+ 本地缓存       │
│  本地缓存 = wx.setStorageSync(KEYS.xxx)，秒开 + 云端不可用回落     │
└──────────────────────────────────────────────────────────────┘
```

**关键设计原则**
- 页面「秒开」靠本地缓存；云端只在 `USE_CLOUD` 开启且 `ensureCloud()` 成功后才介入。
- 所有云函数调用收口到 `cloud.callFunction(action, payload)`，**不要**在业务模块里各自 `wx.cloud.callFunction`。
- 涉及「别人联系方式 / 审核处置」的读写**只在云函数里做权限过滤**，前端缓存只是展示镜像。

---

## 2. 模块职责表

### 2.1 utils/（42 个，每个文件头已有职责注释）

| 模块 | 一句话职责 | 对外主要接口 | 依赖 |
|---|---|---|---|
| `config.js` | ★ 配置中心（环境/开关/订阅/审核员） | `USE_CLOUD` `CLOUD_ENV` `KEEP_SEED_CONTENTS` `SUBMSG` `MODERATORS` | — |
| `cloud.js` | ★ 云开发辅助：懒初始化 + openid + 统一入口 | `ensureCloud` `db` `getOpenid` `fetchOpenid` `callFunction` `cfg` | config |
| `store.js` | ★ 数据层**聚合入口**（薄壳，重导出下方 8 模块，保持 `module.exports` 兼容） | 见下方「store 子模块」 | store-base + 7 业务模块 |
| `store-base.js` | 共享基础设施：KEYS / read / write / 墓碑 / 工具 / 常量（被其余模块 require） | `KEYS` `read` `write` `myOpenid` `seed` `HOLE_BOARD` `PAGE` `openidTrouble` | — |
| `store-user.js` | 用户资料（本地缓存层） | `getUser` `setUser` | store-base |
| `store-course.js` | 课程 + 课程评价（评分 / 教师榜 / 类型纠正） | `getCourses` `getCourseById` `addCourse` `getReviews` `addReview` `refreshCourses` | store-base, store-user, store-forum |
| `store-forum.js` | 校园论坛（帖子 / 投票 / 点赞 / 树洞 / 举报 / 审核） | `getPosts` `getMyPosts` `getPostsBy`(名片页历史发帖的本地兜底) `addPost` `toggleLike` `toggleVote` `toggleReact` `decoratePost` `visibleToMe` `setReviewStatus` | store-base, store-user |
| `store-sync.js` | 云端同步 + 启动初始化 | `initStore` `syncNow` `syncFromCloud` `ensureSeed` `mergeFavorites` | store-base, store-course, store-forum, store-favorite |
| `store-search.js` | 论坛搜索（历史 / 热词 / 高亮 / 模糊） | `searchPosts` | store-base, store-forum |
| `store-favorite.js` | 收藏（本地 + 云端合并；招聘会收藏**带时间/地点快照**） | `getFavorites` `isFavorited` `toggleFavorite` `removeFavorite` `pullFavorites` `pushFavoritesToCloud` `FAV_MAX` | store-base |
| `store-draft.js` | 草稿 | `saveDraft` `getDrafts` `removeDraft` | store-base |
| `user.js` | 身份 / 资料 / 同学关系 / 审核 / 内容写入 | `initUser` `getMyProfile` `saveProfile` `postsByAuthor` `search` `addRequest` `reportPost` `postAdd` … | cloud |
| `upload.js` | 选图 / 选文件 / 上传（隐私门 + 超时 + 降级） | `ensurePrivacy` `pickImages` `pickFile` `uploadFile` `cloudPathFor` | cloud |
| `privacy.js` | 微信隐私保护指引授权 | `setup` `isAuthorized` `openContract` `getPrivacyName` | — |
| `search.js` | 全站共用 精准/模糊 搜索内核 | `matchFields` `matchLevel` `passLevel` `editDistance` | — |
| `nav.js` | 统一路由守卫（防连点 / 栈满退化） | `go` `back` `isAtTarget` | — |
| `event.js` | 校园活动（报名/取消，独立数据层） | `addEvent` `getEvents` `joinEvent` `cancelJoin` `getMyEvents` | cloud |
| `market.js` | 失物/二手（lost/found/sell，状态流转） | `addMarket` `getMarkets` `markDone` `getMyMarkets` | cloud/search |
| `bottle.js` | 校园盲盒/漂流瓶（数据在云端） | `throwBottle` `fetchBottle` `replyBottle` `myBottles` | user |
| `chat.js` | 同学私信（进会话拉历史 + 发后刷新，支持图文） | `list` `send(to, text, images)` `history` | cloud |
| `unread.js` | ★ 小红点收口：我的帖子被回复（本地已读水位）+ 私信未读 → tabBar badge | `markPostSeen` `markAllSeenFor` `forgetPost` `replyMap` `refreshBadge` `setChatUnread` `chatUnread` `KEYS` `MINE_TAB_INDEX` | store（chat 延迟 require） |
| `moderation.js` | 内容安全（屏蔽词 + 长度/图片校验，前端层） | `checkBlocked` `guardText` `reportTip` `REPORT_REASONS` | — |
| `feedback.js` | 用户反馈唯一出口（Toast/Loading 互斥、提交链超时、看门狗） | `toast` `ok` `loading` `hideLoading` `run` `deadline` `watchdog` `buzz` | — |
| `report.js` | ★ 客户端错误上报**唯一出口**（指纹去重 / 单次启动封顶 / 永不冒泡） | `report` `reportIfCloud` | user(惰性) cloud(惰性) |
| `pager.js` | 列表分页状态机（本地切片；`reset`/`keep`/`more`/`view`/`all`） | `create` `DEFAULT_SIZE` | — |
| `perf.js` | 交互性能小工具：节流 + 结果缓存 | `throttle` `createCache` | — |
| `weather.js` | 今日+明日天气（Open-Meteo，云函数中转+直连兜底） | `fetchWeather` `fetchTomorrow` `peek` | user(动态) |
| `notify.js` | 订阅消息一次性授权 | `request` `tmplIds` | config |
| `haptic.js` | 轻震动反馈（仅结果确认类） | `ok` | — |
| `system.js` | 自定义导航栏系统信息（状态栏/胶囊） | `system` `vibrateShort` | — |

> **store 子模块依赖方向（无环）**：`store-base` 被所有模块依赖；`forum/user/course/draft/favorite/search` 只依赖 base 与同级模块；
> `store-sync` 依赖 `store-course`+`store-forum`+`store-favorite`，`store-search` 依赖 `store-forum`。**所有页面仍 `require('../utils/store.js')` 不变**，
> 聚合入口用 `Object.assign` 把 8 个模块导出合并，对外形状与原单体完全一致。
>
> ⚠️ **拆开后模块间不共享作用域**：凡用到其他模块的顶层**常量**（`SEED_VERSION` / `PAGE_SIZE` /
> `SEED_POST_IDS` / `SEED_REVIEW_IDS` / `FAV_MAX` …）或**共享工具函数**（`today` / `genId` / `searchCore` …），
> 必须在文件头显式 `require`。漏引不报编译错、运行到那行才 `ReferenceError`（已发生过一次回归，见报告 §14）。
> 动完数据层请跑 `scripts/check-store-refs.cjs`（静态）+ `scripts/smoke-store.cjs`（运行期）。

> `store.js` / `user.js` / `upload.js` / `cloud.js` 是**改动最频繁**的 4 个，优先读它们的文件头。

### 2.2 components/（11 个）

**通用 UI（components/ui/，页面按需 `usingComponents` 引入）**

| 组件 | 用途 | 关键 properties |
|---|---|---|
| `app-header` | 自定义导航栏 | `title` `showBack` `dark` `bg` `border` |
| `base-button` | 通用按钮 | `variant`(primary/secondary/ghost/danger/dark) `size` `disabled` `loading` `block` |
| `base-card` | 通用卡片容器 | `padded` `clickable` `flat` `flush` |
| `bottom-sheet` | 半屏底部抽屉 | `open` `title` `description` `maskClosable` |
| `empty-state` | 空状态占位 | `title` `description` `actionLabel` `icon` `iconColor` |
| `pill-selector` | 胶囊筛选选择器 | `items` `value` `labels` `accent`(brand/forum/market/campus) |
| `sticky-filter` | 吸顶筛选栏容器 | `blur` |
| `avatar-editor` | 头像选择/上传 | `src` `size` `readonly` |
| `treehole-entry` | 匿名树洞入口卡片（业务） | `iconVariant` `title` `subtitle` |
| `vote-card` | 投票卡片（强绑投票数据结构） | `voteData` `compact` |

**业务组件（components/course/）**

| 组件 | 用途 | 关键 properties |
|---|---|---|
| `course-card` | 课程卡片（评分/标签/学院/好评率 → 详情） | `courseName` `score` `tags` `reviewsCount` `college` `goodRate` `to` |

### 2.3 cloudfunctions/（需部署）

| 函数 | 职责 | action 清单 |
|---|---|---|
| `login` | 仅返回调用者 `openid`（`wxContext.OPENID`），无业务 | （无 action） |
| `user` | 全站唯一后端 catch-all，按 `action` 路由 | 见下方 2.4 |

### 2.4 `user` 云函数 action 路由（前端 `cloud.callFunction(action)` 对应）

> 想改后端逻辑，先在这里找 action 名；云函数文件头也有一份「action 索引」注释。

- **资料/关系**：`upsertProfile` `getProfile` `search` `addRequest` `respond` `friendAccept`
  `friendReject` `listRequests` `listOutgoing` `listFriends` `block` `unblock` `listBlocks` `whoami` `setAdmin`
- **审核**：`report`(子动作 `delete`/`hide`/`throttle`) `getQueue` `resolveReports`(`confirm`/`reject`)
  `setStatus` `delContent` `patchContent`
- **封号**（管理员，卖片这类把账号当广告位的直接封）：`banUser` `unbanUser` `banList`
- **收藏**：`saveFavorites` `getFavorites`
- **内容写入**：`postAdd` `voteCast` `reviewAdd` `courseAdd` `courseRemove` `likeToggle` `holeReact`
  `weather` `postPin` `cfgGet` `cfgSave` `calendarReset`
- **名片页历史发帖**：`postsByAuthor`(仅出该作者的**非匿名**帖子；树洞帖与 `anonymous`
  帖一律不出，被下架的条目只对审核员露出标题、不带正文和图片)
- **市场**：`marketAdd` `marketList` `marketDone` `marketRemove`
- **私信**：`chatSend`(支持 `images`，最多 6 张，走 `cloud://…/chat/…` 白名单) `chatList` `chatHistory`
- **评论**：`postComment`(文字 / `images`，最多 3 张，走 `cloud://…/comment/…` 白名单)
  `commentRemove` `commentReport`

> **帖子 / 留言的头像走「快照」而不是「实时回查」**：`avatarUrl` 在发帖、发评论那一刻由客户端
> 带上，服务端用 `safeAvatar` 过滤 —— 只认 `cloud://…/avatars/…`，`http(s)` 外链与
> 「上传失败退回本机」的临时路径一律丢成空串（前者是站外图床入口，后者别人手机上根本没有）。
> 代价是换了头像之后老帖子仍是旧头像；昵称本来就是这么存快照的，两处口径一致。
> 换成实时回查则要按每条帖子的作者回查一遍 `users` 集合，列表页几十条就是几十次查询。
> **匿名帖（含树洞）一律「默认头像 + 默认名」**：`showAvatar` 留空（前端渲染成「匿」字圆）、
> 名字走 `匿名·青柠` 这样的随机代号、主页入口一并收掉 —— 头像是全校唯一能一眼认人的东西，
> 匿名帖挂上它等于当众点名。
> **代号按帖子 id 取，不按 openid**：同一个账号的每条匿名帖名字都不同，
> 所以看两条也串不出「这人又发了」。同一条帖子则永远同名（刷新、换设备都不变）。
> **匿名覆盖整个帖子，包括评论区**：帖子匿名时留言也匿名 —— 楼主用主贴那个代号
> （读者才对得上「这条回复」和「主帖」），其他留言者按「帖子 id + openid」取名
> （同帖内稳定能对话，跨帖串不起来）。只让主贴匿名是不够的：楼主回一句「补充一下」
> 昵称一露，前面那串代号全白取；别人实名留言，等于在匿名话题下被挨个点名。
> **名片入口在匿名帖下整个收掉**（`canProfile`）：那头像是通往真人的门 ——
> 点进去就是真名和他发过的所有帖子。模板与 `goCommenter` 各拦一次。
> **真名不出库**：`commentList` 在匿名内容上直接把 `author` / `avatarUrl` /
> `replyToAuthor` 换成空串再下发（代号由前端按 openid 算，词表只有一份）。
> 前端换代号只是「遮住屏幕」，真名照样躺在响应体里，抓包一看就有 —— 承诺了匿名
> 就不能靠客户端自觉。`openid` 保留：判断「我的留言」「能不能删」「举报定位作者」都要它。
> 展示侧的三个落点（`decoratePost` / `decorateComments` /
> 云函数 `safeAvatar`）必须保持一致，清单见 `docs/ONBOARDING.md` 的模块表。
> 头像加载失败由 `image` 的 `binderror` 兜底，退回「名字首字」的文字头像，不留空圆框。
- **学习资料**：`resourceAdd` `resourceList` `resourceUrl` `resourceThanks` `resourceRemove`
- **校历**：`calendarList` `calendarSave` `calendarRemove`
- **校园地点**：`placeList` `placeAdd` `placeRemove`
- **活动**：`eventAdd` `eventList` `eventJoin` `eventCancel` `eventRemove` `eventSyncFromWeb`
- **其他**：`teacherSyncFromWeb` `diag`(环境自检)

> **官网同步（`eventSyncFromWeb` / `teacherSyncFromWeb`）走两条不同的通道**：
> ① `WEB_SOURCES` 那四个栏目（校团委 / 体育工作部 / 学生处 / 学校主页）是**抓静态页面里的
> `<a> 链接 + 日期`**，通道是 `webGet`；② 就业网（`jyw.zjgsu.edu.cn`）的招聘类信息是前端 ajax
> 渲染的、静态 HTML 里没有数据，只能 POST 它的接口，通道是 `webPostJson`。
> **旧域名 `job.zjgsu.edu.cn` 已整体下线**，所以就业信息不再走通用通道。
>
> ② 里又分**两条通道**（`JYW_CHANNELS`，见源码 `招聘会 / 宣讲会` 一节）：
> - `zphxx`（招聘会 / 双选会）`POST /career/zphxx/search/{页}/{每页}` + `zphlb=allzph`
>   —— 学校层面的大场子，实测全站 167 条里落在窗口内的只有 **3 条**；
> - `xjhxx`（宣讲会）`POST /career/xjhxx/search/all/{页}/{每页}`
>   —— 企业进校开的专场，实测 **30 条全在未来两个月内**。
>
> **只接一条页面看着还是空的**，这是「分类有、列表空」的第二次踩坑；两条都接上才撑得住
> 「招聘会」这个分类。两者共用一套「取数 → 卡举办时间窗口 → 按 `sourceUrl` 判重 → 落库」的
> 流程（`syncJywChannel`），差异只在 `JYW_CHANNELS` 表里：地址、字段映射、`daysBack`
> （招聘会 7 天、宣讲会 1 天）。
>
> 这两批消息和就业指导中心公众号每天推的是同一批内容 —— 就业网就是它们的内容源，
> 见 §8 的说明（为什么不直接抓公众号）。
>
> 招聘类的时间口径与公告不同：`at` 存的是**举办日期**（不是发布日），展示端另用
> `jobTs` / `jobEndTs` 判断「还没办 / 已办完」，卡片类别标签用 `jobKind`（宣讲会 / 双选会 /…）。
>
> 同步回执里带 `build` 版本指纹和 `jobfair.channels` 逐通道战果：前端据此区分
> 「云端跑的是旧版云函数」「某条通道的接口没返回」和「这个季节本来就没场次」——
> 三种故障在界面上都表现为「招聘会 0 条」，但要做的事完全不同。

> **统一入口的封禁拦截**：写操作（`BANNED_BLOCK_ACTIONS` 里那批，约 40 个 action）在路由前先读
> `users` 文档上的 `banned` 字段（封禁状态记在 `users` 里，一人一份、天然幂等，**不需要新建集合**），
> 被封的账号直接返回 `{ok:false, msg:'账号已被封禁'}`；读操作（`getProfile` / `chatList` /
> `getQueue` …）一律放行 —— 封号是为了让他发不出内容，不是让他连自己的内容都看不到。
> 校验以**云函数侧**为准（前端那份只是入口显隐），`whoami` 会返回 `banned` / `banReason` 供前端提示。

> **好友关系与「非好友」的私信配额**（`friendIdSet` / `chatQuota` / `chatSend` 闸门）。
> 关系以 `friends` 集合为准：一条记录一个方向，`_id` 定死成 `A_openid + '_' + B_openid`，
> 同意时在一个事务里双向写两条（重复执行幂等）。读侧统一走 `friendIdSet` ——
> `listFriends`（同学列表）与 `chatList`（会话上的「非好友」标记）共用这一份口径，
> 两处各写一套就会出现「列表里是同学、私信里标着还不是好友」这种没人知道该信哪个的矛盾。
>
> **同意之前不能无限发私信**。非好友的上限在 `chatQuota`：**双方各自 3 条**，
> 成为好友后没有上限。规则刻意只有这一条 —— 出现过「对方回过我就放宽到 20 条」的版本，
> 已去掉：那种形状下用户无法预知自己处在哪一档。为什么是 3 条写在源码
> `STRANGER_QUOTA` 一节，改之前先读那段。四个约束：
> - 闸门在 `chatSend` 里，位置**必须在写库之前、两个拉黑检查之后**。放写库之后等于
>   「先发出去再退回」，消息已经进对方会话了；放拉黑检查之前，被拉黑的人会收到
>   「你发满了」—— 等于告诉他换个号还能再发 3 条。
> - 配额按**方向**计数，对方发的消息不吃我的额度。计数直接数会话记录里的条数（回执里
>   `used` 是我发了几条、`peerUsed` 是对方发了几条），不另存计数器：非好友阶段物理上限
>   是 2×3 条，远在 `CHAT_KEEP`(200) 以内，这份计数在「配额还有意义」的区间里永远准，
>   也省掉一个要给老会话做迁移的新字段。
> - 会话文档上的 `quotaResetAt` 是**额度水位**：解除好友时（见 `removeFriend`）盖一个时间戳，
>   只数它之后的消息。不加这道水位的话，长会话会被数出成百条历史、额度直接算成 0 ——
>   聊了半年的两个人一解除，双方立刻都说不了话（连「你怎么把我删了」都发不出去）。
>   这个字段对老会话不存在，取不到按 0 处理，计数口径与历史版本完全一致。
> - ⚠️ 好友关系查询失败时**必须放行**（返回 `degraded: true`）。把一对老同学误判成
>   「陌生人已用满 3 条」，会当场锁死他们的输入框，而原因完全看不出来 ——
>   与全站「云端判断不了就不拦」的口径一致。
>
> **解除好友**（云函数 `removeFriend`，前端 `utils/friend.js` 的 `remove`）。
> 任何一方都能单方面发起，不需要对方同意 —— 退出关系不该需要对方批准。三件事必须一起做：
> ① 双向删 `friends` 记录（按 `where` 删，不能按定死的 `_id` 删 —— 早期记录 id 是随机的）；
> ② 清掉 `contacts` 里这对人**两个方向、所有状态**的申请记录 ——
> 漏了这一步，`addRequest` 会先查到一条 `status:'accepted'` 的老记录、直接回「你们已经是好友啦」，
> 两人从此**再也加不回来**，而界面给的理由和真实状态正好对不上；
> ③ 在会话上盖 `quotaResetAt`（见上）。聊天记录**保留**，与拉黑一致：删记录并不能让对方
> 忘掉说过的话，反而会把自己这边的约定、地点、联系方式一并弄丢。
>
> **加好友不做独立入口**。动作本身（留言弹窗 + 文案）在 `utils/friend.js` 的 `ask`，
> 触发点嵌在用户本来就会经过的地方：同学名片、找同学的**搜索结果行内**、私信发满 3 条后的锁块。
> 三处共用一份实现，改文案改一处就够 —— 各写一遍迟早出现「名片页提示已发出、搜索结果页点了没反应」。
>
> **联系方式只在互认好友之间返回**。`chatHistory` 的 `peer.contactValue` 原先是无条件
> 吐出来的：名片页严格判了 `isFriend`，私信页却直接把微信号给出去，等于「不用加好友
> 也能拿到联系方式」，把好友那道门整个绕过去了。现在两处都以 `quota.isFriend` 为准。

---

## 3. 关键流程

### 3.1 启动（app.js → onLaunch）
```
privacy.setup()            // 隐私授权（收集信息前必须先得同意）
  → 读本地 zjgsu_user（无则建默认用户『浙小商』）
  → cloud.ensureCloud()    // 云开发提前初始化，避免首次发布卡顿
  → store.initStore()      // 初始化本地存储层（云端数据异步拉回）
  → cloud.fetchOpenid()    // 异步拿 openid，拿到后 user.initUser() 登记『我』
  → wx.cloud.callFunction('user', {action:'whoami'})  // 冷启动预热，付掉 SDK 初始化开销
  → weather.fetchWeather() // 天气预热（欢迎弹窗用）
  → showGuideOnce()        // 首次打开弹一次应用说明（本机缓存去重）
```

### 3.2 发帖 / 点赞 / 评论链路
```
页面 → store.addPost({...})            // 写本地 + 标 needSync
     → cloud.callFunction('user',{action:'postAdd'})  // 同步云端
     → 成功回写本地；失败留本地，下次 syncNow 重试
点赞：store.toggleLike → user.likeToggle（云端 inc 已改为从 post_votes 表统计，避免并发重复加）
评论：store.addComment → user.postComment
     留言可以带图（最多 3 张 / 一条）：页面先 upload.uploadMany({prefix:'comment'}) 拿到 fileID，
     再随文字一起提交。addComment 返回 { comment, done } —— comment 是本地立刻落地的那条，
     done 是云端那一步，页面据它决定提示「成功」还是「云函数是旧版，图被吞了」
```
> 赞踩计数来自 `post_votes` 记名表（_id=帖子id_用户openid，唯一约束），不再是字段 inc 累加。

### 3.3 选图 / 选文件上传（upload.js —— 隐私门）
```
ensurePrivacy()             // 未授权先弹隐私协议（__usePrivacyCheck__ 开启时必走）
  → pickImages()/pickFile() // 调 wx.chooseMedia / wx.chooseMessageFile
  → uploadFile()            // 传云存储，带 UPLOAD_TIMEOUT_MS 超时与失败降级
  → 返回云 fileID
```
> 后台**未勾选相册/文件权限**时，真机到这一步会被微信直接拦截。

### 3.4 内容审核链路
```
用户举报 → user.reportPost/reportComment → 云函数写 reports 集合
审核员（MODERATORS 白名单）→ admin/moderation 页 getQueue → resolveReports(confirm/reject)
  → delContent/patchContent/setStatus 处置（阈值权威值在云函数 MOD_RULES）
```

### 3.5 本地 ↔ 云端同步（store.js）
```
initStore()         // 启动初始化本地
syncNow()           // 主动全量/增量同步（收藏、帖子、课程类型等）
云端不可用          // 全程回落本地缓存，功能不中断，仅『无他人新内容』
```
- 本地键集中在 `store-base.js` 的 `KEYS`（如 `zjgsu_posts` `zjgsu_reviews` `zjgsu_votes`）。
- 「删除」用墓碑（`tombRead/addTombstone`）而非物理删，便于云端收敛。

---

## 4. 数据流小结

```
写：页面 → utils(store/user/...) → cloud.callFunction → 云函数 → 云数据库
读：页面 → 本地缓存（秒开）── 云端拉回后覆盖本地镜像（store.syncNow / pullFavorites）
```
- **本地缓存**是事实源（秒开 + 离线可用）；**云端**是共享源（他人可见）。
- 隐私敏感字段（联系方式）**绝不**经前端缓存下发，只在云函数过滤后返回。

---

## 5. 配置详解

> 详见 `utils/config.js` 文件头（含完整集合清单与踩坑说明）。

- `USE_CLOUD`：总开关。关闭后纯本地，适合无云环境调试。
- `CLOUD_ENV`：环境 ID，部署后必填。
- `KEEP_SEED_CONTENTS`：示例帖/评价开关；课程库（seed.js 1096 门）不受影响。
- `SUBMSG`：订阅消息模板 ID，留空静默跳过。
- `MODERATORS`：审核员 openid，**仅控制前端入口显隐**；真权限在云函数环境变量 `MODERATORS`。
- 云函数侧还需：`MOD_RULES`（审核阈值）、`SUBMSG_REPLY`/`SUBMSG_CHAT`（订阅模板）、`MODERATORS`。

---

## 6. 命名约定（接手者请遵守）

1. **utils 文件**：第 1 行 `// utils/x.js —— 一句话职责`，并写明设计取舍/坑。新增模块照做。
2. **组件**：`components/<域>/<kebab-name>/`，含 `index.{js,wxml,wxss,json}`；对外用 `properties` 声明，类型写全。
3. **本地存储键**：集中在 `store-base.js` 的 `KEYS` / `user.js` 的 `KEY`，不要散写字符串。
4. **云函数调用**：一律 `cloud.callFunction(action, payload)`，action 名见 2.4。
5. **颜色/样式**：用语义类（`.bg-brand`/`.text-forum`），不散写 hex；设计令牌见 `app.wxss`。

### 6.1 已知命名重叠（历史债，改动请注意）
- `store.getUser/setUser`（本地用户缓存） vs `user.getMyProfile/saveProfile`（云端身份资料）——跨文件同概念不同名。
- `cloud.getOpenid` vs `cloud.fetchOpenid`——几乎同义的两套 openid 获取器。
- 投票/点赞/互动三套近义接口并存：`store.toggleLike`/`castVote`/`toggleReact` ↔ `user.likeToggle`/`voteCast`/`holeReact`。
- 举报三处：`store.hasReported/markReported` ↔ `user.reportPost` ↔ 云函数 `action:'report'`。
> 重构时建议统一：本地缓存层 vs 云端身份层 用前缀区分，避免语义混淆。

---

## 7. 后续重构路线（破坏性，需单独评估）

| 目标 | 现状 | 建议 |
|---|---|---|
| 数据层拆分 | ✅ **已拆分**（原 `store.js` 2102 行 / 10 域 → `store-*.js` 8 模块 + 聚合入口 `store.js`，对外接口零变化） | 维持现状；新增业务优先放进对应域模块，避免回潮成单体 |
| 后端结构 | ↩️ 已回退为单文件 `user/index.js`，优先保证稳定；拆分目录在 `_trash/refactor-20261018/` | 后续如再拆分，必须先补运行时依赖测试 |
| user.js 结构 | ↩️ 已回退为单文件 `utils/user.js` | 当前优先稳定，不再继续拆 |
| 命名统一 | 见 6.1 | 分层前缀 + 消除近义接口 |

> 数据层拆分**非破坏性**：17 个调用方仍 `require('../utils/store.js')` 不变，已用 `verify_store.cjs`（原 77 导出名全部存活）+ `_syncheck.js`（410 文件语法全过）验证。
> 任何后续拆分都**先保 `module.exports` 兼容**，页面零改动；测试覆盖发帖/点赞/审核链路后再上线。

---

## 8. 数据源边界：为什么招聘会接就业网，不直接抓就业指导中心公众号

需求里提过「从浙江工商大学就业指导中心公众号搜集招聘会信息」。**结论是走就业网，
不走公众号**，理由都在实测里，记下来免得下一个人再试一遍：

1. **公众号没有可用的列表接口。** `mp.weixin.qq.com/mp/profile_ext?action=home&__biz=…`
   （公众号历史消息页）会返回一个「验证」拦截页 —— 它需要微信客户端的登录态，
   服务端拿不到，云函数里也拿不到。
2. **搜狗微信搜索只能算「关键词检索」，不是这家公众号的时间线。**
   `weixin.sogou.com/weixin?type=2&query=浙江工商大学就业指导中心` 能返回结果页，
   但：结果是**跨全部公众号按关键词命中的**（实测前几条是「招办访谈」「专家解读」这类
   别的号的文章）、有索引延迟、对高频请求会转验证码，而且返回的链接是
   `/link?url=…` 需要再解一次跳转。
3. **最关键的：公众号的标题里没有结构化字段。** 我们的卡片要显示
   「举办时间 / 地点 / 企业」，`jobState` 还要算「还有 N 天 / 就是今天 / 已结束」——
   这些只能从结构化数据来。从标题里用正则抠日期，遇到「10月19日」「下周三」这类写法
   立刻失真，而**办错日期比不显示更糟**。
4. **公众号和就业网本来就是同一份内容。** 就业指导中心的推文是把就业网上发布的
   宣讲会 / 双选会重新编排后推出来的，就业网是**源**、公众号是**渠道**。
   接源比接渠道更全（列表接口一次给全量）、更新（不经过编辑排版这一道）、更结构化。

> 所以「公众号上有哪些招聘会」这件事，回答就是 `JYW_CHANNELS` 那两条通道。
> 真要做公众号，唯一站得住的路子是走微信开放平台的**公众号第三方授权**拿图文素材接口，
> 那需要该公众号管理员授权、且属于公众号运营方的事，不是小程序能单方面做的。

### 8.1 明确**没有**接的两个栏目（评估过，故意不加）

| 栏目 | 接口 | 为什么不接 |
|---|---|---|
| 招聘公告 `news/zpgg` | `POST /career/news/search/zpgg/{页}/{每页}`（实测 78 条） | 是**公告**不是**活动**：内容形如「毕业生春季校园招聘服务指南」「公开招录消防员公告」，没有举办时间 / 地点字段，混进「招聘会」分类只会让「还有 N 天」这条唯一有用的信息失效 |
| 全职 / 实习招聘 `zpxx` | `POST /career/zpxx/search/{xxlb}/{页}/{每页}` | 是**岗位**不是**场次**，量级上千条，且同学找岗位该去就业网投简历，不是在小程序里看列表 |

---

## 9. 三个横切关注点（改之前先读这一节）

这三样东西都**铺满了整个项目**，但它们没有独立的页面，所以很容易被当成"某页的细节"
随手改掉，改完又在全站范围里出问题。

### 9.1 深色模式：令牌化，跟随系统

| 层 | 文件 | 做法 |
|---|---|---|
| 色值令牌 | `app.wxss` 的 `page{}` | 定义 29 个 `--c-*` 令牌（画布 / 卡片 / 文字 / 描边 / 主色 / 场景色 …）；`@media (prefers-color-scheme: dark)` 里**只重定义令牌的值**，不重写任何选择器 |
| 导航栏 / tabBar | `theme.json` + `app.json` | `theme.json` 里写的是**自定义变量名**（`navBgColor` / `tabSelectedColor` …），`app.json` 用 `@navBgColor` 引用；`app.json` 开 `"darkmode": true` |
| 下拉 loading | 各页 `*.json` | `backgroundTextStyle` 写 `"@pageBgTxtStyle"`。写死 `"dark"` 的话，深色下拉时那三个点会看不见 |

三条纪律：

1. **任何新色值都必须是 `var(--c-xxx)`。** 需要新令牌就先在 `app.wxss` 的 `page{}` 里加、
   再在 dark 媒体查询里补一个值。`node scripts/check-theme.cjs` 会校验两侧令牌集完全一致
   （多一个少一个都报错）、没有悬空的 `var()`、也没有定义了没人用的死令牌。
2. **不要在业务 wxss 里写 `@media (prefers-color-scheme: dark)`。**
   深色是"换一套令牌值"，不是"每个组件再写一遍另一种颜色" —— 后者会让
   "某个按钮在深色下还是浅色"这类漏改无限增殖，且无从检查。
3. **深色不是把颜色取反。** 纯黑配纯白看久了累，所以底是 `#0d1117` 不是 `#000`、
   文字是 `#e6edf3` 不是 `#fff`，彩色整体提亮一档。这些值在 `app.wxss` 里都有注释说明。

> 树洞 `pages/forum/hole` 与盲盒 `pages/campus/blindbox` 是**固定深色主题页**（设计如此，
> 不跟随系统），它们的色值不参与令牌替换。

### 9.2 列表分页：一律走 `utils/pager.js`

四处长列表（我的帖子 / 同学名单 / 学习资料 / 校园活动-同学发起）共用一套本地切片分页，
`pages/**` 里的模板只认 `hasMore` / `done` / `total` 三个字段：

| 入口 | 语义 | 用在哪 |
|---|---|---|
| `reset(list)` | 换筛选、换关键词 → 归零 | 学习资料切分类/搜索、同学名单搜索、校园活动切档 |
| `keep(list)` | 数据刷新但**保留展开进度**（列表变短会自动缩回） | 我的帖子每次 `onShow` 重算红点、同学名单 6 秒轮询 |
| `more()` | 触底；已经到底返回 `null` | `onReachBottom` |
| `all()` | 返回**全量副本**，不是切片 | 「清空」这类作用于全体条目的操作 |

两个已经踩过、并由 `scripts/test-pager.cjs` 钉住的坑：

- **「清空」必须取 `all()`。** 用 `data.posts` 的话它只是当前切片，
  结果"清空"只删掉已展开的几条、其余原样留着，提示却写着「已清空」。
- **计数必须取 `total`。** 模板里写 `{{posts.length}}` / `{{friendView.length}}` 的话，
  往下划两屏这个数字会自己变大。

### 9.3 错误上报：只报意外

真机上 `console.error` 没有人看得见。同学反馈「点了没反应」时，唯一能对上的线索就是
`errors` 集合里这段时间写了什么。出口只有一个：**`utils/report.js`**。

- 接线点：`app.js` 的 `onError` / `onUnhandledRejection` / `onPageNotFound` 三个全局钩子，
  加上 `pages/campus/campus.js` 的「云端云函数版本落后」（`campus.cloudBuildStale`）。
- **不要给每个 `catch` 都挂上报。** 断网、用户点取消、表单没填完、命中敏感词都是正常流程，
  报上来只会淹没真正的 bug —— 一次断网能灌满整个集合。
- 去重与兜底都在 `report.js` 内部：同一「作用域 + 消息前 80 字」30 分钟内只报一次，
  单次启动最多 8 条，指纹表留 6 小时后清掉。
- **上报自己永远不能出错、不能阻塞、不能弹任何东西。** 用户已经遇到一个错误了，
  不能因为上报再给他弹一个（所以 `report.js` 里没有 `showToast`，也不抛异常）。
