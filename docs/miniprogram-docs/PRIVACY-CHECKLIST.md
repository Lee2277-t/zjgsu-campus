# 用户隐私保护指引 · 填写与自查清单

> 给谁看：接手本项目的开发者、以及每次提审前的自查。
> 依据：微信官方《小程序用户隐私保护指引内容介绍》的「处理的信息 ↔ 接口」映射表，
> 加上对本工程代码的全量扫描（2026-09-28，覆盖 `pages/` `components/` `utils/`）。
> 结论：**要勾 5 项，代码侧另有 2 个前提必须同步满足**（见第四节）。

---

## 一、先明确三件事

| 问题 | 答案 |
|---|---|
| 在哪填 | `mp.weixin.qq.com` → 设置 → **服务内容声明** → 用户隐私保护指引 |
| 谁去填 | **只能开发者本人在后台点**。它不进 git、代码里改不了、别人代劳不了 |
| 代码侧开关 | `app.json` → `__usePrivacyCheck__: true`（本工程已开）。开了这项，**没在后台声明的隐私接口会被微信直接拦掉** |

代码里唯一能做的是"弹窗告知 + 跳协议页"。
**但后台那几个勾，代码替代不了** —— `utils/privacy.js` 头注释就写着这句。

### 弹窗现在是怎么弹的（2026-09-29 改过）

| | 旧做法（有问题） | 现在 |
|---|---|---|
| 时机 | **被动**：只有用户第一次点「加图 / 选文件」时，微信才回调要授权 | **主动**：进入首页（`pages/course/list`）就问一次 |
| 载体 | `wx.showModal`（在 `App.onLaunch` 阶段弹） | 自定义组件 `components/ui/privacy-modal`，挂在首页上 |
| 能不能点开协议 | ❌ 系统弹窗只有两个按钮，塞不进「查看协议」 | ✅ 组件里《用户隐私保护指引》可点开 |
| 同意按钮 | 手动 `resolve()` | `<button open-type="agreePrivacyAuthorization">`，由微信完成授权，更可靠 |

**为什么不再在 `App.onLaunch` 弹**：那时首页还没渲染完，`wx.showModal` 经常被吞掉——
用户看到的就是「提示要确定隐私协议，却没地方点同意」，而触发授权的接口还在那挂着等。
现在移到页面 `onShow`，页面已渲染，弹窗必定出得来。

- 模块：`utils/privacy.js`（`setup` 注册监听 / `askOnEnter` 主动申请 / `onAsk` 交给 UI / `answer` 回传用户选择）
- 组件：`components/ui/privacy-modal/`（挂在首页 `list.wxml` 末尾）
- 兜底：组件没挂载时（比如从别的页面触发隐私接口）自动退回 `wx.showModal`，**绝不把授权请求晾着**
- 幂等：切 tab 回来不会反复弹；用户选「暂不同意」后，等他真正用到隐私接口时会再给一次机会

---

## 二、第一屏怎么选

打开后在顶部会让你确认「本小程序对用户信息的收集和使用情况」，两个选项：

| 选项 | 什么时候选 |
|---|---|
| 本小程序开发者承诺并保证，未以任何方式处理用户的任何信息 | 完全没碰过任何用户信息。**本工程不适用** |
| ✅ **本小程序处理了用户信息，将如实填写并及时更新** | **本工程必须选这项** |

**为什么必须选第二项**：本工程实际收集/使用了昵称、头像、选中的图片、选中的文件、
选择的位置、剪切板（全部有代码位置，见第三节）。选第一项属于"声明与实际不符"——
审核过不去，而且代码在真机上会被拦。

> 提示：有些小程序这一屏进去后默认只展示少量项，需要点「**增加消息类型**」把第三节的 5 项补全。

---

## 三、必须勾选的 6 项（代码实证）

| # | 处理的信息（后台里的项名） | 触发它的代码 · 本工程真实位置 | 用途建议怎么写 |
|---|---|---|---|
| 1 | **收集你的昵称、头像** | `<input type="nickname">` → `pages/user/profile/profile.wxml`；头像选取 → `components/ui/avatar-editor` → `utils/upload.js` `pickImages` | 为了让你在校园社区里有可辨识的昵称与头像，发帖、留言、发布闲置时展示 |
| 2 | **收集你选中的照片或视频信息** | `wx.chooseMedia` / `wx.chooseImage`（`utils/upload.js` `pickImages`）；调用点：发帖配图 `pages/forum/post`、换头像 `components/ui/avatar-editor`、发布闲置/失物 `pages/market/edit` | 为了让你在发帖、换头像、发布闲置时上传自己选中的图片 |
| 3 | **收集你选中的文件** | `wx.chooseMessageFile`（`utils/upload.js` `pickFile`）；调用点：`pages/tool/resources`（课件/资料） | 为了让你把聊天记录里的课件、资料上传到课程资料区 |
| 4 | **收集你选择的位置信息** | `wx.chooseLocation`；调用点：`pages/tool/places` `pickLocation()` | 为了让你在地图上标出校园地点（食堂、快递点等）的真实坐标 |
| 5 | **读取你的剪切板** | `wx.setClipboardData`；调用点：`profile` `event` `campus` `chat` `market/detail` `card` `moderation` | 为了让你一键复制联系方式、地址、单号等文本 |
| 6 | **相册（仅写入）** | `<image show-menu-by-longpress>`（长按图片弹出系统"保存到相册"）；涉及 `forum/detail`、`forum/list`、`market/detail`、`market/list`、`market/mine`、`market/edit`、`user/card`、`user/chats`、`mine/mine`、`avatar-editor`、`treehole-entry` 等 **16 处内容图** | 为了让用户把帖子配图、商品图、头像等内容图片保存到自己的手机相册 |

> ⚠️ **以微信后台的实际提示为准**：后台会根据你提交版本里调用到的接口，自动把对应项标为必填。
> 上表是我按代码扫描出的"最小必要集"——后台标了必填的，一个都别漏。
>
> 📌 **第 6 项（相册仅写入）是后来加的**：最初版本没有"保存图片"功能，所以不勾；
> 2026-09-28 加了 `show-menu-by-longpress` 长按保存后，该项**变为必勾**，否则真机长按保存会被微信拦截。

### 3.1 后台输入框「用途」可直接粘贴的文案

后台每一行后面都有个「请填写用途」的框，**逐行照抄下面这句**即可（都是具体用途，不是"提升体验"这类空话，审核友好）：

```
1) 收集你的微信昵称、头像 → 用于在校园社区展示你的昵称与头像，便于发帖、评论、发布闲置时识别你的身份。

2) 收集你选中的照片或视频信息 → 用于发帖配图、更换头像、发布闲置或失物信息时，上传你选中的图片。

3) 收集你选中的文件 → 用于上传课件、课程资料到课程资料区。

4) 获取你选择的位置信息 → 用于在地图上标注校园地点（食堂、快递点、教学楼等）的真实位置。

5) 读取你的剪切板 → 用于一键复制联系方式、地址、快递单号等文本。仅在你有复制操作时读取。

6) 使用你的相册（仅写入）权限 → 用于将你长按保存的帖子配图、商品图等内容图片保存到手机相册。
```

**写用途的 3 条原则**（避免被驳回）：
1. **具体到功能**：说清"用来干什么"（发帖配图/课件上传/复制单号），别写"为了提供更好的服务"。
2. **与代码行为一致**：文案描述的动作，代码里必须真的做了（上表右列就是依据）。
3. **不夸大范围**：没做的别写（比如没做个性化推荐，就别写"用于推荐"）。

---

## 四、代码侧必须同步满足的 3 个前提（最容易被漏）

### 4.1 `app.json` 里声明 `requiredPrivateInfos` ✅ 已修

`wx.chooseLocation` 属于**地理位置类接口**，必须在 `app.json` 里声明，否则真机直接失败：

```
chooseLocation:fail the api need to be declared in the requiredPrivateInfos field in app.json
```

本工程原来这里是空数组 `[]`，**已修复**：

```json
"requiredPrivateInfos": [
  "chooseLocation"
],
```

> 别多加：`getLocation`（精确位置）与 `getFuzzyLocation`（模糊位置）**互斥**，同时写会报错；
> 本工程只用 `chooseLocation`（地图上点选），所以只声明它。

### 4.2 `app.json` 里补 `permission.scope.userLocation` ✅ 已修（2026-10-18）

**这条是 2026-10-18 补上的，之前一直缺**，症状就是打开「校园地点」页时
微信直接弹一个白框：

> 需要在 app.json 中声明 permission scope.userLocation 字段

卡在这里的话，授权框根本不会出现 —— 不是用户「没给权限」，是工程没声明用途，
`wx.chooseLocation` 与 `<map show-location>` 都用不了。

```json
"permission": {
  "scope.userLocation": {
    "desc": "用于在地图上显示你的位置，并在地图上选点添加校园地点"
  }
},
```

- `desc` 会原样出现在微信的授权弹窗里，**写具体用途**（审核会看），别写「提升用户体验」。
- 只声明 `requiredPrivateInfos` 不够：那个管「能不能调用」，这个管「弹窗里说什么 + 准不准调」。

**同时改了地图的显示方式**：`<map>` 的 `show-location` 不再写死，
而是绑 `showLoc`，只有**已经授过位置权限**的人才显示定位点
（`places.js` 的 `checkLocAuth()` 用 `wx.getSetting` 静默查一次，不弹框）。
理由：`show-location` 一渲染就去要权限，第一次进页面就弹授权框，属于
「用户还没用这个功能就先申请权限」，审核常挑这一条；用户在地图上选过点之后
（`pickLocation` 成功）才把定位点打开。

> 想恢复「一进页面就有自己的位置点」：把 `places.wxml` 的 `show-location="{{showLoc}}"`
> 改回 `show-location` 即可 —— 但那样首屏会弹授权框，不建议。

### 4.3 后台「接口设置」自助开通 ⚠️ 需要你本人去点

路径：`mp.weixin.qq.com` → 开发 → 开发管理 → **接口设置** → 找到位置相关接口 → 申请开通
（如实填申请理由，一般工作日半天内通过）。

**只改 `app.json` 不够**：没在后台开通接口权限，真机上依旧拿不到位置。

---

## 五、本工程**用不到、不要勾**的项

多勾 = 声明超出实际收集范围 = 属"过度收集"，反而有审核风险。以下都扫过，**没有调用**：

| 项 | 为什么不用勾 |
|---|---|
| 摄像头 | 没有 `<camera>` 组件、没调 `wx.createVKSession`。`chooseMedia` 带拍照已归入第 2 项 |
| 麦克风 | 没有 `RecorderManager` / `wx.startRecord` / `<live-pusher>` |
| 手机号 | 没有 `<button open-type="getPhoneNumber">` |
| 通讯录（仅写入） | 没有 `wx.addPhoneContact` |
| 日历（仅写入） | 没有 `wx.addPhoneCalendar` |
| 蓝牙 | 没有 `wx.openBluetoothAdapter` |
| 微信运动步数 | 没有 `wx.getWeRunData` |
| 发票信息 / 通讯地址 | 没有 `wx.chooseInvoice*` / `wx.chooseAddress` |
| 加速/陀螺仪/磁场/方向传感器 | 没有 `wx.startAccelerometer` 等 |

> 📌 **「相册（仅写入）」已从"不用勾"挪到上面的第三节第 6 项**：本工程通过 `<image show-menu-by-longpress>` 支持长按保存图片，属于写入相册，必须勾选。

---

## 六、提审前自查清单

- [ ] 后台选「**处理了用户信息，将如实填写并及时更新**」
- [ ] 第三节 5 项**都已勾选**，且每项都填了**具体**用途（不要写"提升用户体验"这类空话）
- [ ] **联系方式邮箱已填**（官方必填项：用户行使查阅/复制/更正/删除权利的入口）
- [ ] `app.json` 的 `requiredPrivateInfos` 含 `chooseLocation` ✅
- [ ] `app.json` 的 `permission.scope.userLocation.desc` **已写且写了具体用途** ✅
      （缺了这条，打开校园地点页直接弹「需要在 app.json 中声明 permission scope.userLocation 字段」）
- [ ] 后台「接口设置」里**位置接口已开通**
- [ ] 真机（体验版）走一遍这 5 个场景，都要能弹出隐私授权窗并继续：
      换头像 / 发帖配图 / 上传学习资料 / 地图选点 / 复制联系方式
- [ ] 拒绝授权时有降级提示（本工程统一走 `utils/upload.js`，会给可读原因）

---

## 七、报错对照表

| 报错（工具或真机 errMsg） | 原因 | 怎么处理 |
|---|---|---|
| `...:fail privacy` 或 `api ... is not authorized` | 用户未同意隐私指引 / 后台没声明该项 | 后台补勾对应项；代码确认走 `utils/privacy.js` 链路 |
| `chooseLocation:fail the api need to be declared in the requiredPrivateInfos field` | `app.json` 缺声明 | 补 `requiredPrivateInfos`（已修） |
| 白框「**需要在 app.json 中声明 permission scope.userLocation 字段**」（带「查看详情」按钮） | `app.json` 缺 `permission.scope.userLocation`。**这不是用户没给权限**，是工程没写用途说明，授权框根本弹不出来；`chooseLocation` 和 `<map show-location>` 都会踩 | 补 `permission` 块（2026-10-18 已修，见 4.2）。补完不用动后台，重新编译即生效 |
| `chooseLocation:fail ...` 且声明无误 | 后台未开通位置接口权限 | 去「开发管理 → 接口设置」申请开通 |
| `chooseMedia:fail auth deny` | 用户拒绝了相册权限 | 引导去微信设置开（`upload.js` 已译为"没拿到权限，去微信设置里开一下"） |
| `...:fail not support` / `unsupported` | 基础库或微信版本太旧 | 提示换设备/升级（`upload.js` 已译为"这台设备的微信版本太老"） |
| `<input type="nickname">` 报 `showNicknameAccessory:fail ... privacy permission is unauthorized, errno:104` | 后台《用户隐私保护指引》**没勾「收集你的昵称、头像」**（或勾了还没审核通过） | 后台补勾本文第 1 项并等审核通过。**功能不会坏**——该组件会自动降级成普通输入框，只是少了键盘上方「使用微信昵称」那个一键按钮；提示语已写成「取个昵称，也可直接用微信昵称」，降级后照样能手打 |
| Console 里 `云开发数据库索引建议` / `全量查询告警` | 查询条件为空（扫全表）或排序字段没索引 | 见下节「云开发索引与全量查询」 |

---

## 八、相关文件索引

| 关心什么 | 看哪 |
|---|---|
| 隐私弹窗、协议页、授权状态 | `utils/privacy.js` |
| 隐私授权门（选图/选文件前先过） | `utils/upload.js` → `ensurePrivacy()` |
| 启动时注册授权监听 | `app.js`（`privacy.setup()`） |
| 协议入口 | `pages/mine` |
| 全局开关 | `app.json` → `__usePrivacyCheck__` / `requiredPrivateInfos` |
| 选图/选文件的**所有**调用点 | `components/ui/avatar-editor`、`pages/forum/post`、`pages/market/edit`、`pages/tool/resources` |
| 位置选择 | `pages/tool/places` → `pickLocation()` |

---

*生成：WorkBuddy（阿澈）· 依据：微信官方隐私指引接口映射表 + 本工程代码全量扫描 · 2026-09-28*
