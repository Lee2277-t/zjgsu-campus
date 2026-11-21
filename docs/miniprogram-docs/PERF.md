# 性能优化说明（页面切换 + 文件上传）

> 目标：解决「校园板块 / 闲置板块切分类卡」和「发帖传图、发资料选文件慢」。
> 原则：先定位真正的瓶颈，再动手；能验证的一律写进冒烟脚本，不放过夜。

---

## 一、瓶颈定位（改之前是什么在慢）

### 1. 闲置板块切分类慢：慢在网络，不是慢在计算

`pages/market/list/list.js` 原来的 `load()` **每次都 `await market.fetchMarkets(1)`**。
也就是说，用户点一下「教材」分类，前端要跑完一次「云函数 → 数据库 → 回包」的完整往返，
再重新过滤、排序、`setData`。手指连点就是连着发好几次请求。

而这一步其实**完全没必要**：切换筛选条件时数据本身没变，变的只是「从同一份数据里挑哪些出来」。

### 2. 校园板块切板块/排序：每次都把全量帖子重算一遍

`pages/forum/list/list.js` 的 `load()` 每次调用都：
1. `store.getPosts(...)` 全量过滤 + 排序；
2. 在「课程评价」板块还要**再跑一次** `store.getPosts()` 去统计课程条数（第二遍全量）；
3. `posts.map(...)` 逐条打举报标记；再逐条比对决定是否 `setData`。

单次几十毫秒看着不多，但它在 `onShow`、切板块、点赞、触底时都会被反复触发。

### 3. 上传慢的五个原因（按影响从大到小，后两个是第二轮才挖出来的）

| 原因 | 说明 |
|---|---|
| **① 隐私门白等 8 秒**（头号） | 点「加图 / 选文件」之后、打开相册**之前**，代码会先 `await wx.requirePrivacyAuthorize`。后台隐私指引漏勾某一项时这个接口既不 success 也不 fail，靠 8 秒超时兜底 —— **每次点击先白等 8 秒**。日志里的 `errno:104 privacy permission is unauthorized` 就是它 |
| **② 压缩只降画质不降分辨率** | 只给 `quality:70`，一张 4000×3000 的图还是 4000×3000，体积砍不动多少，压缩时间却照付。**像素数才是体积的分母** |
| ③ 图片没二次压缩 | 选图时只跟微信要了「压缩版」（`sizeType:'compressed'`），**没有按体积二次压缩**。手机拍的照片动辄 3–8MB |
| ④ 并发无序 | 发帖页是 `Promise.all` 一次性把 6 张全塞出去（互相抢带宽），闲置发布页又是全项目唯一裸调 `wx.cloud.uploadFile` 的地方：**没超时、没压缩、没进度、失败静默** |
| ⑤ 进度不可信 + 蒙层挡输入 | 云存储的 `wx.cloud.uploadFile` 在小程序端只给 Promise、**不给上传任务**，拿不到真实字节进度；同时 `wx.showLoading({mask:true})` 会在上传那几秒把输入框锁死，用户感受到的就是「整页卡住」 |

---

## 二、这次改了什么（前端）

### 1. 新增 `utils/perf.js`
- `throttle(fn, wait)`：首次立刻执行，间隔内的重复触发在间隔末尾**用最新参数补一次**。
  （不用「丢弃重复点击」，否则连点 A→B 会停在 A，看着像没点上。）
- `createCache(limit)`：带上限的结果缓存，满了淘汰一半最久没用的。

### 2. 闲置板块（`pages/market/list/list.js` + `utils/market.js`）
| 改动 | 效果 |
|---|---|
| **切 tab / 切分类不再联网**；只有「首次进入、下拉刷新、这个 tab 还没拉过」才请求 | 切换从「等一次网络往返」变成 **0 请求** |
| 结果缓存：key = `tab + 分类 + 关键词 + 精准/模糊` | 切过的组合再切回来直接渲染 |
| `utils/market.js` 加**内存缓存层** | 不再每次切分类都把整份 JSON 从 storage 反序列化一遍 |
| 分类切换加 300ms 节流 | 连点不会在同一帧里跑两遍 |
| 分页渲染（一屏 30 条，触底 +30） | 一次 `setData` 几百条是卡顿主因，现在只渲染看得见的部分 |
| 翻页游标按 tab 分开记 | 修掉「在全部翻到第 3 页再切寻物会跳页」的隐患 |

### 3. 校园板块（`pages/forum/list/list.js`）
- 板块 × 排序 × 课程 三维结果缓存；数据被改过（点赞 / 举报 / 拉新一页 / 回到页面）时整体作废；
- 「课程评价」板块的统计**复用**第一次查询结果，不再跑第二遍全量（选了具体课程时才单独查）；
- 三个切换入口全部加 300ms 节流。

### 4. 上传链路（`utils/upload.js` + 两个发布页）
- `compressIfNeeded()`：超过 200KB 才处理，**长边压到 1280px + 质量 70**；压完反而更大就放弃（已经压过的图、部分 png 会这样）；
- `uploadMany()`：**并发 3** 的队列上传（不是 6 张一起挤，也不是一张一张等），保持入参顺序，支持失败保底回调；
- 进度用**真实完成度**（每张 0 或 100，整体取平均）——**不按时间假装往前爬**；拿到真实进度回调的版本照样接；
- 修掉 `sub/market/edit/edit.js` 里裸调 `wx.cloud.uploadFile` 的历史遗留（无超时 / 无压缩 / 无进度 / 失败静默）。

### 5. 第二轮：把「等待」从用户眼前挪走（这轮才是体感改善的大头）

| 改动 | 为什么有用 |
|---|---|
| **隐私门三段式** | ① 授权结果缓存（确认过一次后本次运行期零开销）→ ② `wx.getPrivacySetting` 毫秒级探测，不需要授权就立刻放行 → ③ 确实需要授权才调 `requirePrivacyAuthorize`，**超时从 8 秒降到 3 秒，且超时一律放行**。理由：让微信原生接口自己的报错（会带 privacy 字样）暴露出来翻译成人话，也比让用户对着空白干等强 |
| **压缩降分辨率**（长边 1280） | 4000px → 1280px，像素数降到约 1/10，3MB 的原图通常落到 150–300KB。只给长边那一边，另一边微信按比例算（等比缩放）；**尺寸本来就没超标的图不给尺寸参数**，否则微信会把小图放大 |
| **`prewarm()` 后台预热压缩** | 选完图立刻开始压，**不 await**。用户还要填标题、正文、选板块，通常十几秒，压缩正好在这段时间里做完，点发布时就只剩上传。缓存里存的是 Promise 而不是结果 —— 预热还没压完、上传就来要时，两边拿到同一个 Promise，绝不会同一张图压两遍 |
| **超时按体积动态给** | 20 秒起步，每 1MB 多给 4 秒，封顶 90 秒。固定 60 秒两头不讨好：小图真出故障要干等一分钟，大文件弱网下又可能刚传一半被判超时 |
| **去掉 `mask:true` 蒙层** | 上传是在填内容的**过程中**发生的。带 mask 的 loading 会把输入框锁死几秒，那种「点了加图整页卡住」的体感比真的慢还难受。进度改由页面内联显示（`post.wxml` / `edit.wxml` 的 `uploadPercent`），不挡任何操作 |
| **大文件提示连 WiFi** | 资料上传超过 5MB 时在 loading 上带一句「大文件建议连 WiFi」。PDF / zip 压不了（非图片），代码能做的只有让等待可见 |

顺带修掉一个真 bug：`requirePrivacyAuthorize` 这个**接口名本身就含 "Privacy"**，旧代码拿整条 errMsg 做 `indexOf('privacy')` 必然命中，于是 `requirePrivacyAuthorize:fail not support`（老基础库没有这个接口 = 本来就不拦）被误判成「用户拒绝授权」，直接把功能掐死。现在统一走 `failReason()`——**只看冒号后面的失败原因，不看接口名**。

---

## 三、后端要做的（云开发控制台，代码改不了的部分）

### 1. 索引（真能改变查询计划，建议建）

| 集合 | 索引 | 谁在用 |
|---|---|---|
| `posts` | `time` 降序 | 客户端 `store-sync.js` 的 `orderBy('time','desc')` 分页拉帖 |
| `market` | `at` 降序 | 云函数 `marketList` 不带 type 时 |
| `market` | 复合：`type` 升序 + `at` 降序 | 云函数 `marketList` 带 type 时（本次新增的下推查询） |

建法：云开发控制台 → 数据库 → 选集合 → **索引管理** → 新建索引 → 填字段与排序 → 确定。
（`posts` 那条也可以直接点调试器 Console 里的绿色「索引建议」提示，它自带环境参数。）

### 2. 云函数改动（需要重新部署才生效）

`cloudfunctions/user/index.js` 的 `marketList` 支持了 `type` 参数：带上就只返回该类型的一页。
**老云函数不认这个参数时会照旧返回全类型，前端还有一层本地过滤兜底，结果一样对** ——
所以前端可以先发，云函数后部署，不会出错，只是省不下流量。

部署：微信开发者工具 → 右键 `cloudfunctions/user` → **上传并部署：云端安装依赖**。

### 3. 关于 CDN 加速与带宽（如实说明，别被话术带偏）

- 云存储的文件下载**默认走腾讯云 CDN**，这一步在小程序代码里**不可配置**，控制台也没有单独的「开关」；
- 上传速度的上限取决于**用户自己的网络**（校园网 / 4G）和文件大小，代码侧能做的只有**把文件变小**（本次已做：按需压缩）；
- 能查的是配额与用量：云开发控制台 → 概览 / 云存储，看容量、下载次数、CDN 流量。

### 4. 还知道但这次刻意没动的

| 现象 | 为什么不现在改 |
|---|---|
| `reviews` / `courses` 每次启动 `limit(500)` 空条件全量拉 | 当前数据量下无感。真到几千条，应改成按 `time` 分页 + 索引，或把同步收口进云函数做字段裁剪 |
| 用 `field()` 裁剪返回字段 | `decorateMarket` 等函数需要整份文档，裁剪容易漏字段导致「详情少了东西」，收益/风险不划算 |

---

## 四、为什么没上虚拟列表（Virtual List）

需求里写的是「虚拟列表**或**分页加载」，这里选了分页，理由：

1. 本项目的卡片高度**不固定**（有无配图、文字长短、有无标签），虚拟列表必须精确知道每项高度，
   否则滚动时会出现跳动和空白；
2. 真正的虚拟列表要引入 `recycle-view` 组件（需 npm 构建）或自己写可视区计算 + 占位容器，
   改动面覆盖 WXML 结构、样式和滚动容器；
3. 现在一屏只渲染 30 条，长列表的主要成本（一次性 `setData` 几百条、图片一次性解码）已经消掉。

**结论**：分页加载已经解决了当前量级的卡顿；等列表稳定超过几百条再上虚拟列表，届时按固定行高改造卡片即可。

---

## 五、怎么验证 / 怎么回滚

```bash
cd recon
node scripts/smoke-perf.cjs      # 节流、缓存、内存缓存层、并发上传共 20 项断言
node scripts/smoke-store.cjs     # 数据层（本地 + 云端双模式）
node scripts/check-store-refs.cjs
# 全工程语法体检（在 miniprogram/zjgsu-campus 下；注意上级 package.json 是 type:module，
# 直接 node _syncheck.js 会报 require 未定义，复制成 .cjs 再跑）
cp _syncheck.js _syncheck_tmp.cjs && node _syncheck_tmp.cjs
```

回滚：改动前的原文件都在 **`recon/_trash/`**（项目目录**外**）：
- `perf-opt-backup/`（切分类优化：`utils/market.js`、`utils/upload.js`、
  `pages/market/list/list.js` + `list.json`、`pages/forum/list/list.js`、
  `sub/market/edit/edit.js`、`sub/forum/post/post.js`）
- `upload-speed-backup/`（上传提速第二轮：`utils/upload.js`、`sub/forum/post/post.js`、
  `sub/market/edit/edit.js`、`pages/tool/resources/resources.js`）
- `system-api-backup/`（`utils/system.js` 废弃接口替换）

整目录拷回 `miniprogram/zjgsu-campus/` 对应位置即可还原。

> ⚠️ **备份目录必须放在小程序项目目录外面**。曾经把它放在
> `miniprogram/zjgsu-campus/_trash/` 下，结果开发者工具把备份的
> `pages/market/list/list.js` 当成真实页面去编译，报
> `WXML file not found: ./_trash/perf-opt-backup/pages/market/list/list.wxml`
> —— 整个项目编译失败。现在已移到 `recon/_trash/`，并在
> `project.config.json` 的 `packOptions.ignore` 里加了 `_trash` 兜底。

---

*生成：WorkBuddy（阿澈）· 2026-09-29*
