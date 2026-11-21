# 校园小站（zjgsu-campus）微信小程序

> 浙江工商大学校园生活一站式小程序：课程评价、校园论坛、闲置交易、校园活动、树洞匿名、
> 学习资料、私信交友等 8 大模块。
>
> **前端：微信小程序原生框架（WXML / WXSS / JS）。后端：微信云开发（云函数 + 云数据库 + 云存储），无需自建服务器。**

---

## 1. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 视图 | 小程序原生 WXML / WXSS | 无第三方 UI 框架，设计系统自研（`app.wxss`） |
| 逻辑 | 小程序原生 JS（CommonJS，无打包工具） | 开发者工具直接编译，无 webpack / vite |
| 后端 | 微信云开发 | 两个云函数：`login`（极简）、`user`（catch-all 路由） |
| 存储 | 云数据库（文档型）+ 云存储 | 集合清单见 `utils/config.js` 文件头注释 |
| 设计 | 自研设计令牌 | 迁移自 Vue3 + Tailwind 高保真原型 |

---

## 2. 目录结构

```
zjgsu-campus/
├── app.js                 # 应用入口：启动流程、隐私授权、云初始化、openid、欢迎弹窗
├── app.json               # 全局配置：页面注册、tabBar、隐私开关、分包懒加载
├── app.wxss               # 全站设计系统（设计令牌 + 通用类，详见文件头）
├── project.config.json    # 工程配置（打包根、appid 等）
├── _syncheck.js           # 走查脚本：扫描全部 .js 语法/引用健康度（node 运行）
│
├── pages/                 # 页面（按业务域分 8 组，详见 app.json）
│                          #   其中 8 个低频页已注册进 app.json 的 subPackages（见 §2.1）：
│                          #   tool/* 4 个、admin/moderation、user/guide、
│                          #   forum/comment-appeal、forum/hidden
│   ├── course/            # 课程：列表 / 详情 / 评价 / 教师 / 加课
│   ├── forum/             # 论坛：列表 / 详情 / 发帖 / 树洞 / 隐藏帖
│   ├── market/            # 闲置：列表 / 详情 / 发布 / 我的
│   ├── campus/            # 校园：活动 / 发布 / 详情 / 盲盒
│   ├── mine/              # 我的：主页 / 我的帖子 / 我的课程评价 / 收藏 / 草稿
│                          #   （主页只放「看一眼、点进去」的入口，三份列表各自成页）
│   ├── user/              # 用户：引导 / 资料 / 名片 / 好友 / 私信
│   ├── admin/             # 审核：内容审核台（仅审核员可见入口）
│   └── tool/              # 工具：校历 / 资料 / 地点 / 备忘录
│
├── components/            # 自定义组件
│   ├── ui/                # 通用 UI（base-button / base-card / empty-state / bottom-sheet / ...）
│   └── course/            # 业务组件（course-card）
│
├── utils/                 # 核心逻辑层（42 个模块，每个文件头都有职责注释）
│   ├── config.js          # ★ 配置中心：环境 ID、云开关、订阅消息、审核员名单
│   ├── cloud.js           # 云开发辅助：懒初始化 + openid 获取 + 统一云函数入口
│   ├── store.js           # ★ 数据层聚合入口（薄壳，重导出下方 8 个 store-* 模块，保持 module.exports 兼容）
│   ├── store-base.js      #   共享基础设施：KEYS / read / write / 墓碑 / 工具 / 常量（被其余模块 require）
│   ├── store-user.js      #   用户资料（getUser / setUser）
│   ├── store-course.js    #   课程 + 课程评价（评分 / 教师榜 / refreshCourses）
│   ├── store-forum.js     #   校园论坛（帖子 / 投票 / 点赞 / 树洞 / 举报 / 审核）
│   ├── store-sync.js      #   云端同步 + 启动初始化（initStore / syncNow / ensureSeed）
│   ├── store-search.js    #   论坛搜索（searchPosts / 历史 / 高亮）
│   ├── store-favorite.js  #   收藏（getFavorites / 增删同步）
│   │                       #   类型：course / post / review / market / event（招聘会）
│   │                       #   活动类会多存 when / place 快照：官网活动只在窗口内，
│   │                       #   出了窗口列表里就没有这条了，收藏要自己站得住
│   └── store-draft.js     #   草稿（saveDraft / 读取 / 删除）
│   ├── user.js            # 用户身份 / 资料 / 同学关系 / 审核 / 内容写入 / 封号
│   ├── upload.js          # 选图 / 选文件 / 上传云存储（隐私门 + 超时 + 降级）
│   ├── privacy.js         # 微信隐私保护指引授权
│   ├── search.js          # 全站共用 精准/模糊 搜索内核
│   ├── unread.js          # ★ 小红点收口：我的帖子被回复（本地已读水位）+ 私信未读 → tabBar badge
│   ├── nav.js             # 统一路由跳转守卫（防连点 / 栈满退化）
│   ├── feedback.js / perf.js                      # 反馈唯一出口（Toast/Loading 互斥 + 超时闸）/ 节流 + 结果缓存
│   ├── event.js / market.js / bottle.js / chat.js  # 各业务数据层（chat 支持图文私信）
│   ├── moderation.js / weather.js / notify.js / haptic.js / system.js
│   └── (详见 ARCHITECTURE.md 模块职责表)
│
├── cloudfunctions/        # 云函数（需部署到微信云开发）
│   ├── login/index.js     # 仅返回调用者 openid
│   └── user/             # ★ 单文件 action 路由与业务实现（回退版）
│
├── data/                  # 静态数据：seed.js 课程库（1096 门：专业课 889 / 通识 189 / 思政 5 / 体育 13）
└── assets/                # 图片 / 图标 / 插画 / tabBar 图标
    ├── icons/             # SVG 图标（按需引用，已剔除非引用副本）
    ├── illustrations/     # 空状态插画
    └── tabbar/            # 底部 5 个 tab 图标
```

> ★ = 接手优先级最高 / 改动最频繁的文件。

### 2.1 分包：哪 8 个页面不在主包里，以及为什么

开发者工具「代码质量」要求**主包 < 1.5M**。2026-10-17 之前是 1.64M（未通过），
所以八个低频页注册进了 `app.json` 的 `subPackages`，主包降到 **1.39M**：

| 分包 root | 页面 | 大约体积 | 为什么它配进出 | 
|---|---|---|---|
| `pages/tool` | 校历 / 学习资料 / 校园地点 / 我的备忘 | 77 KB | 天然独立的一组，且只有一个 tab 能进 |
| `pages/admin` | 内容审核台 | 73 KB | 只有审核员点得到，普通人一次也用不上 |
| `pages/user/guide` | 应用说明 | 10 KB | 看一次就不看了，且文案只增不改 |
| `pages/forum/comment-appeal` | 留言申诉 | 10 KB | 仅在申诉通知里被点开 |
| `pages/forum/hidden` | 被暂停展示的内容 | 5 KB | 仅受影响用户才进 |

**关键取舍：root 直接指到原来的 `pages/xxx` 目录**，而不是新建 `packageA/`。
因为 `root + pages` 拼出来的路径恰好等于原页面路径（如 `pages/tool/memo/memo`），
于是 **41 处 `nav.go` / `navigateTo` / 订阅消息里的 page 路径一个字都没改** ——
省掉了最容易出错的「改完以后某处跳转漏改」。代价只是目录多了一层语义。

能被安全拆出去的前提（已由 `scripts/check-package-size.cjs` 钉住）：

1. 全工程**没有任何 `require('.../pages/...')`**，页面之间不互相引用，
   所以不存在「主包伸手要分包里的东西」这种非法依赖；
2. 这八页 require 的全是 `../../../utils/*`，组件全是 `/components/*` —— 
   **分包引用主包是允许的**，反过来不允许；
3. tabBar 的五个页全部留在主包（平台要求，tab 页不能进分包）。

**首次进入某个分包会先下载它**，所以用 `preloadRule` 在入口页预热
（`pages/campus/campus` 预热 tool、`pages/mine/mine` 预热 guide 等），
用户点进去不会干等。审核页（admin）故意**不预热** —— 它不是人人都用，
没必要让每个打开「我的」的人都替管理员下载 73 KB。

改这里的时候记住：**新加页面默认放主包**，只有当某段代码证明它「低频且独立」时才挪进分包，
并且在 `app.json` 之外的地方（比如这篇文档的表格）同步一句，否则很快又会不记得为什么这么拆。

---

## 3. 快速开始

1. **导入工程**：微信开发者工具 → 导入项目 → 选择本目录（含 `project.config.json`）。
2. **开通云开发**：工具内点「云开发」→ 创建环境，拿到环境 ID。
3. **配置环境 ID**：填入 `utils/config.js` 的 `CLOUD_ENV`（见第 4 节）。
4. **部署云函数**：右键 `cloudfunctions/login` 与 `cloudfunctions/user` → 上传并部署（node）。

   > ⚠️ **云函数不是「保存即生效」**：小程序前端改完编译一下就能看到效果，云函数必须手动重新部署。
   >   两者一旦不同步（本地是新版、云端还跑着旧版），症状会非常像前端有 bug。真实踩过：
   >   「私信发图」依赖云端 `chatSend` 认识 `images` 字段，云端旧版时纯图消息一律回
   >   「内容不能为空」，图文消息则**悄悄把图丢掉**（文字照发，用户以为图也送到了）。
   >   现在前端能识别这两种情况，直接提示「图片没发出去：云函数是旧版，需重新部署」。
   >   同一个坑在**校园页的「招聘会」**上也踩过一次：只接就业网的招聘会通道（一学期几场），
   >   页面看着还是空的；现在接了招聘会 + 宣讲会**两条**通道。若「招聘会」分类一直是 0，
   >   点「更新」按钮会直接告诉你是哪一种 —— 云端旧版 / 接口没返回 / 这季节本来就没场次。
   >
   > **怎么确认云端是哪一版**（开发者工具 → 调试器 Console）：
   > ```js
   > wx.cloud.callFunction({ name: 'user', data: { action: 'diag' } }).then(r => console.log(r.result))
   > ```
   > 看 `build` 与 `features` 两个字段（当前 `2026-10-20.5`；
   > `features` 至少含 `['chatImage','ban','whoamiMod','postsByAuthor','commentImage','jobfair','jobtalk',
   > 'byline','chatQuota','removeFriend','accountCancel','reportPerson','chatRequest','chatRecall',
   > 'notify','mediaCheck','postEdit','modLog','modQueueImages','commentVote','commentReply',
   > 'commentTable','commentCount','commentAppeal','reportGuard',
   > 'contentProtect','pinExpire',
   > 'myPostsAnon','notifyPage','chatReadAt','commentRecount','submsgComment',
   > 'marketReport','eventReport','draftCloud','chatRevCas','myContent',
   > 'reportOneVote','queueGrouped','reportArchive',
   > 'viewCount','hideByViews','noAutoDelete','viewShowGate','anonComment','voteTableCountOnly']`）。
   > 这两行会随每次发版变动，**不必手抄** —— 以 `cloudfunctions/user/index.js` 的
   > `BUILD` / `FEATURES` 为准（`scripts/check-build-fingerprint.cjs` 会自动核对文档与源码是否一致）。
   > **回执里没有这两个字段 = 跑的是旧版**，重新部署即可。
   > 三处版本号（云函数 `BUILD` / 校园页 `CLOUD_BUILD` / 关于页 `EXPECT_BUILD`）
   > 由 `npm run check` 里的 `check-build-fingerprint.cjs` 盯住，漏改一个会直接红。
   > `pages/campus/campus.js` 顶部的 `CLOUD_BUILD` 是**前端期望的版本号**，跟这里必须一起改
   > （它只用于把「招聘会没同步上」翻译成「云端是旧版，去重新部署」）。
   > 每次改动云函数的行为（新增 action、改参数或回执形状），都要把 `index.js` 顶部的 `BUILD` 加一位。
5. **建集合 + 设权限 + 建索引**：照 **`DATABASE.md`** 走一遍（37 个集合）。
   索引那节分了三档，其中「**必须建**」的 7 个漏一个，表现是
   「列表空但不是真的没数据」—— 私信、好友申请、审核队列、名片页历史发帖都属这一类，
   而且**没有任何前台报错**。
6. **配图片审核回调**：**云开发控制台** → 设置 → 其他设置 → **消息推送** → 推送模式选
   「云函数」→ 添加一条：消息类型 `event` / 事件类型 `wxa_media_check` / 云函数 `user`。
   ⚠️ 不是 `mp.weixin.qq.com` 的「开发管理 → 开发设置 → 消息推送」（那条给自建服务器 URL 用，
   且云开发一配就把它废了）。步骤与验收办法见 `DATABASE.md` §4。
   不配的话图片会一直停在 `pending`，10 分钟后被兜底扫描标 `unverified` 放行 ——
   **功能不断，但审核形同虚设**
7. **编译运行**：默认 `USE_CLOUD: true`。若仅本地调试，可临时设 `USE_CLOUD: false`（走本地缓存）。
8. **隐私合规（必做）**：登录 `mp.weixin.qq.com` → 设置 → **服务内容声明** → 用户隐私保护指引，
   选「本小程序处理了用户信息，将如实填写并及时更新」，然后勾选 **微信昵称头像**、
   **选中的照片或视频**、**选中的文件**、**选择的位置信息**、**剪切板**、**相册（仅写入）** 共 6 项
   （第 6 项因已支持「长按图片保存到相册」`show-menu-by-longpress` 而必勾）。
   另需在后台「开发管理 → 接口设置」开通**位置接口**（否则地图选点不可用），
   且 `app.json` 的 `requiredPrivateInfos` 必须含 `chooseLocation`（已配）。
   逐项依据与填写文案见 **`PRIVACY-CHECKLIST.md`**。不勾，真机上换头像/选图/选文件/选位置/保存图片会被微信直接拦。

> ⚠️ 代码质量规则「图片和音频资源 ≤ 200K」当前已通过（资源合计 ≈ 92 KB）。
> 后续若新增图标用法用到已移出的「图标名+配色」组合，需从 `_trash/icons-unused-*/` 取回对应 SVG。

---

## 4. 配置项速查（utils/config.js）

| 字段 | 类型 | 含义 |
|---|---|---|
| `USE_CLOUD` | bool | 是否启用云开发。关闭则全走本地缓存，无云端共享 |
| `CLOUD_ENV` | string | 云开发环境 ID（来自 mp 后台「开发 → 开发设置」） |
| `KEEP_SEED_CONTENTS` | bool | 是否灌入/展示示例帖与示例评价（课程库不受影响，始终保留） |
| `SUBMSG.reply / chat` | string | 订阅消息模板 ID（留空则不弹授权、不发通知） |
| `MODERATORS` | string[] | 审核员 openid 白名单（仅控制前端入口显隐；真权限在云函数环境变量） |
| `MODERATION.ABUSER_BADGE` | string | 审核页展示用的「观察期」标签 |

> 审核相关的权威阈值在云函数 `cloudfunctions/user` 的 `MOD_RULES`，前端 `utils/moderation.js`
> 另有即时提示词表；**两者不要各自维护**（历史已删过一份漂移死数据）。

---

## 5. 设计系统与命名约定

- **设计令牌**集中在 `app.wxss` 文件头。颜色用语义类（`.bg-brand` / `.text-forum` / `.scene-market` …），
  **不散写 hex**。令牌共 66 个，分五族（改样式前先看这一节，别自己造数）：

  | 族 | 前缀 | 档位 | 谁在管 |
  |---|---|---|---|
  | 色彩 | `--c-*` | 33 个（画布/文字/描边/场景色/叠色） | 深浅两套值，跟随系统 |
  | 字阶 | `--fs-*` | **10 档** 20/22/24/26/28/30/36/44/56/88 | 只有这十种字号 |
  | 间距 | `--sp-*` | **4rpx 栅格** `--sp-1`:4 ~ `--sp-10`:40 | padding/margin/gap |
  | 圆角 | `--r-*` | **5 档** s:8 / m:16 / l:24 / xl:32 / pill:999 | — |
  | 阴影 | `--sh-*` | **4 档** 卡片 / 上浮 / 主色发光 / 小元素 | 色值跟深浅走 |
  | 热区 | `--hit*` | **2 档** 88（标准）/ 72（小胶囊） | min-height |

  校验：`node scripts/check-ui-scales.cjs`（字号/圆角/间距/字重是否都落在档位内）。
  批量归并用 `mptools/normalize-scales.py` / `tokenize-shadows.py` / `tokenize-hit.py` / `normalize-press.py`
  （都支持 `--dry-run`，改完再跑一次应为 0；脚本住在仓库根的 `mptools/`，
   不在小程序目录里 —— 小程序根下每个字节都算主包体积，构建脚本没理由跟着进用户的手机）。
- **按压反馈三档**（不是随手值，各自有语义）：`0.72` 普通 · `0.6` 删除/清空等危险操作 ·
  `0.88` 整张卡片/主提交按钮（大元素按太暗会整块闪）。校验同上。
- **深色模式（跟随系统）**：色值令牌 `--c-*` 定义在 `app.wxss` 的 `page{}` 里，
  `@media (prefers-color-scheme: dark)` **只重定义令牌的值**，不重写任何选择器。
  导航栏 / tabBar 走 `theme.json`（写的是**自定义变量名**，如 `navBgColor`）+ `app.json` 的
  `"darkmode": true` 与 `"@navBgColor"` 引用。页级 `*.json` 的 `backgroundTextStyle` 写
  `"@pageBgTxtStyle"`。**新颜色一律先加令牌（light/dark 两侧各一个值），不要在组件里写 hex**，
  否则深色下就是一块浅色补丁且不报任何错。校验：`node scripts/check-theme.cjs`。
  详由见 `ARCHITECTURE.md` §9.1。
- **三条硬约束**（改样式前必读 `app.wxss` 文件头）：
  1. `.container` / `.page-scroll` 只允许动 `opacity`，加 `transform` 会让所有 `fixed` 元素退化；
  2. 不用 `backdrop-filter` / `@property` / `clamp`，毛玻璃用半透明 + 同色描边降级；
  3. 不在业务 wxss 里写 `@media (prefers-color-scheme: dark)` —— 深色是"换一套令牌值"，
     不是"每个组件再写一遍另一种颜色"。
- **代码注释基线**：每个 `utils/*.js` 第 1 行均为 `// utils/x.js —— 职责` 头注释，
  并写明设计取舍与踩坑点。**新增模块请遵循同一约定**。
- **数据层导航**：`store.js` 已拆为 8 个 `store-*.js` 模块（聚合入口 `store.js` 仅重导出、保持原接口不变），
  每个模块文件头有职责注释、`module.exports` 列出自身对外函数；`user` 云函数文件头有「action 索引」。
  接手者按模块定位，无需通读全文。
- **错误上报**只有 `utils/report.js` 一个出口（指纹去重 30 分钟 / 单次启动封顶 8 条 /
  上报自身永不抛错不弹窗）。**只报意外** —— 断网、取消、校验失败都是正常流程，
  别往每个 `catch` 上挂。详由见 `ARCHITECTURE.md` §9.3。
- **列表分页**一律走 `utils/pager.js`（`reset` / `keep` / `more` / `all`），接入页：
  我的帖子、同学名单、学习资料、校园活动-同学发起。详由见 `ARCHITECTURE.md` §9.2。
- **一键全量检查**（改完任何东西先跑它）：

  | 命令 | 作用 |
  |---|---|
  | `npm run check` | **46 个脚本全跑**（静态 16 + 行为 29 + 联网 1 + Python 2），约 46 秒，末尾给通过数与失败清单。在仓库 `recon/` 下执行 |
  | `npm run check:offline` | 同上但跳过真打就业网那一条（断网 / 对方改版时用） |
  | `node scripts/check-all.cjs --only behavior` | 只跑某一组（`static` / `behavior` / `net`） |

- **模块化自检脚本**（动过数据层就请各跑一遍，命令在仓库 `recon/` 目录下执行）：

  | 命令 | 作用 |
  |---|---|
  | `node scripts/check-store-refs.cjs` | 静态扫描 `store-*.js` 之间有无「用了却没 require 进来」的跨模块引用 |
  | `node scripts/smoke-store.cjs` | 真加载聚合入口并逐个调用导出函数（本地 + 云端两种模式），未定义引用会当场抛错 |
  | `node scripts/smoke-system.cjs` | 导航栏系统信息（`utils/system.js`）取值回归：新 API / 老 API / 新 API 抛错三种场景都要算出正确高度 |
  | `node scripts/smoke-privacy.cjs` | 隐私授权弹窗（`utils/privacy.js`）：**任何情况下都必须回调 resolve**——不回调 = 选图/选文件永久挂起。含「组件没挂载时退回系统弹窗」的兜底 |
  | `node scripts/smoke-flow.cjs` | 发送链路回归（69 项）：反馈层 `utils/feedback.js`（Loading 与 Toast 的调用顺序、空文案兜底、截断）、`deadline/run` 超时闸、发帖 `submit()` 与树洞 `send()` 的**每条出口都必须有提示**、树洞快捷话题标签；末尾一组静态约束防止改动被改回去 |
  | `node scripts/smoke-perf.cjs` | 性能专项回归：节流时序、结果缓存淘汰、`market` 内存缓存层、`uploadMany` 并发上限/顺序/保底/进度单调 |
  | `node scripts/check-page-load.cjs` | 真机模拟加载「发帖 / 树洞」页，抓**加载期抛错**（会让整页 `bindtap` 全失效、只留 hover 变色那种）。脚本内已强制 CommonJS 编译小程序文件，不受仓库根 `"type": "module"` 影响 |
  | `node scripts/check-require-case.cjs` | 校验所有相对 `require` 路径在**真机视角**（区分大小写）下大小写一致、文件存在 |
  | `node scripts/check-theme.cjs` | 深色模式令牌一致性：light/dark 两侧令牌集完全相同、`@变量` 无缺失无冗余、无悬空 `var(--c-*)`、无死令牌。**动了 `app.wxss` / `theme.json` / `app.json` 就跑** |
  | `node scripts/check-ui-scales.cjs` | 尺度合法性：字号在十档内、圆角在五档内、间距是 4rpx 倍数（2rpx 发丝除外）、字重只有 400/500/600/700。**动了任何 wxss 就跑**（树洞/盲盒/引导页豁免，它们自成一套尺度） |
  | `node scripts/audit-align.cjs` | 视觉对齐**审计**（只出报告不做断言）：各页容器左边距、卡片间距、热区高度的分布。用来回答"切 tab 时内容会不会跳" |
  | `node scripts/check-tabbar-icons.py` | 解 PNG 算 tabBar 图标的感知亮度，确认深浅两种底上都看得见 |
  | `python scripts/normalize-tabbar-icons.py` | tabBar 图标**几何对齐**：按 alpha 包围盒量出墨迹尺寸与中心，和 62px 画心比对，偏了就报错。`--fix` 就地缩放居中（预乘 alpha + 双线性，幂等）。tabBar 是微信唯一不会自动对齐的地方，换个图标就可能又歪回去 |
  | `node scripts/test-pager.cjs` | 分页回归（87 项）：**「清空」取全量而非切片**、「共 N 条」用 `total`、四处 `keep`/`reset` 语义 |
  | `node scripts/test-jobfav.cjs` | 收藏招聘会：快照字段、截断长度、向后兼容（普通类型不写 `when`/`place`） |
  | `node scripts/test-report.cjs` | 错误上报（70 项）：30 分钟静默期、封顶 8 条、云侧抛错/拒绝/缺接口/storage 失败时一律 `false` 且不冒泡 |
  | `node scripts/test-modqueue.cjs` | 审核队列回执契约（14 项）：`evidence` **只能是 URL 字符串数组**、`personEvidence` 不许再挂回 `evidence`。钉的是一个已修故障——人的证据（对象数组）被当成图片渲染，名片举报那一栏从上线起就是一块碎图，而它长得和「没有证据」一模一样 |
  | `node scripts/check-build-fingerprint.cjs` | 版本指纹三方对账（27 项）：云函数 `BUILD` / 校园页 `CLOUD_BUILD` / 关于页 `EXPECT_BUILD` 必须一致，**外加 README 抄的那份 build/features 与源码一致**（文档写死版本号必然再次过时，所以由脚本兜） |
  | `node scripts/test-friend-v2.cjs` / `test-chatbox.cjs` / `test-postedit.cjs` / `test-byline.cjs` / `test-campus-jobfair.cjs` | 好友配额与解除、私信配额与撤回、帖子编辑回滚、头像署名、招聘会展示口径 |
  | `node scripts/test-jobtalk.cjs` | 真打就业网（联网），并刷新 `scripts/fixtures/jobs.json` |
  | `node _syncheck.js`（在 `miniprogram/zjgsu-campus/` 下） | 全工程语法体检，纯编译不执行 |

  > **历史教训（务必记住）**：拆分后仅验证「导出名字是否齐全」是不够的。
  > `store-sync.js` 曾在接口验证全绿的情况下漏引了顶层常量 `SEED_VERSION`、`PAGE_SIZE`、
  > `SEED_POST_IDS` 等，真机启动立刻 `ReferenceError: SEED_VERSION is not defined`。
  > **接口齐全 ≠ 行为正确**——跨模块的顶层常量与共享工具函数是最容易漏的一类，
  > 必须靠 `check-store-refs.cjs`（静态）+ `smoke-store.cjs`（运行期）双保险收口。

### 云开发控制台的「索引建议 / 全量查询告警」该怎么看

调试器 Console 里这几条**不是报错**，是云开发对慢查询的善意提醒，代码改不掉、只能在控制台处理：

| Console 提示 | 出处 | 要不要处理 |
|---|---|---|
| `posts` 建议索引 `time: 降序` | `utils/store-sync.js` 的 `collection('posts').orderBy('time','desc')` | **建议建**：云开发控制台 → 数据库 → `posts` → 索引管理 → 新建索引（字段 `time`、降序、不唯一）。也可以直接点 Console 里那条绿色提示，它会自动带上环境参数 |
| `users` 建议索引 `banned` | 云函数 `banList` 的 `collection('users').where({banned:true}).limit(50)` | **建议建**：审核页的「封禁名册」每次进页都要扫一遍。字段 `banned`、升序、不唯一。**不建也能用**（只是全表扫，封禁数很少），所以 Console 不出提示也不用管 |
| `courses` / `reviews` 全量查询告警 | `store-sync.js` 启动同步时 `.limit(500).get()`（无过滤条件） | **当前规模可不管**：一次性拉 500 条，作业数据量下无感。若评价涨到几千条，再改成按 `time` 降序分页拉取 |
| `127.0.0.1:xxxxx 资源 preload 未被使用` / `[worker] reportRealtimeAction:fail not support` / `[自动热重载] …` | 开发者工具自身 | ❌ 噪音，忽略 |

> ⚠️ **上面这些是"慢查询提醒"，还有一类是"查询直接失败"，两者在界面上长得一模一样（都是空列表）。**
>
> 云开发的 `where(...) + orderBy(...)` 走**复合索引**，没建索引时查询会报错，
> 而调用点外面普遍套着 `.catch(() => ({ data: [] }))` —— 错误被吞掉，用户看到"空列表"
> 就当成"真的没有"，日志里什么都查不到。**「好友申请收不到」这个 bug 的根因就是它。**
>
> 涉及的是：`chats`（私信列表，or 查询要两个索引）、`posts`（名片页历史发帖）、
> `reports`（审核队列）、`memos`、`market`（带分类时）。
> 完整清单与"建哪个、缺了会怎样"见 **`DATABASE.md` §3**。

---

## 6. 文档导航

| 文档 | 用途 |
|---|---|
| `../PROJECT-SUMMARY.md` | **全项目单一入口**：目标、架构、目录、数据流、已完成/未完成、配置、部署、优先级。接手先读这份 |
| `ARCHITECTURE.md` | 分层架构、模块职责表、关键流程、本地↔云端数据流、命名约定、重构路线；**§9 是三个横切关注点**（深色模式 / 列表分页 / 错误上报） |
| `ONBOARDING.md` | 接手第一天 checklist、环境自检、常见报错与坑、改需求看哪个文件、19 条改动铁律 |
| `DATABASE.md` | **建哪些集合（31 个）、设什么权限、建哪些索引**（分"必须建 / 建议建 / 不用建"三档）、图片审核回调怎么配 |
| `feature-audit-20261016.md` | 功能盘点与改进建议（含"故意不做"及理由） |
| `PRIVACY-CHECKLIST.md` | 隐私保护指引逐项依据与填写文案 |
| `PERF.md` | 性能专项：切分类/上传的瓶颈定位、已做的优化、后端索引与 CDN 的实情、没做虚拟列表的理由 |

---

## 7. 已知短板与后续重构（供接手者评估）

| 文件 | 行数 | 问题 | 建议 |
|---|---|---|---|
| `utils/store.js` | 原 2102 | 单文件承载 10 个业务域 | ✅ 已拆分为 `store-*.js`（聚合入口 store.js + 8 个业务模块），对外接口零变化（详见 §6 与 ARCHITECTURE §2.1） |
| `cloudfunctions/user/index.js` | 1941 | action 路由 + 共享基础设施（116 个 action） | ✅ 已拆为五个域模块；仍保持单函数部署 |
| `utils/user.js` | 615 | 名实不符（身份+关系+审核+内容写入+资源+日历+地点+天气+配置） | 内容写入/资源/日历/地点下沉到各自域文件 |
| 命名重叠 | — | `store.getUser` vs `user.getMyProfile`；`cloud.getOpenid` vs `fetchOpenid`；投票/点赞/互动多套近义接口 | 统一术语：本地缓存 vs 云端身份 分层命名，避免跨文件语义混淆 |

> 数据层拆分**本轮已执行**（非破坏性：调用方零改动；已通过 `verify_store.cjs` 接口验证、
> `scripts/check-store-refs.cjs` 交叉引用检查、`scripts/smoke-store.cjs` 本地/云端双模式冒烟测试、
> `_syncheck.js` 全工程语法体检）。
> 拆分后曾出现「跨模块顶层常量漏引」的回归（`SEED_VERSION` 等），已修复并将两类检查固化为脚本，见 §5。
> `user` 云函数与 `utils/user.js` 的拆分仍属破坏性重构，需单独评估排期。
