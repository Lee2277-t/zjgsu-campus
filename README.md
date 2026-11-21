# 商砖小站 · 浙江工商大学校园服务小程序

> **纪念归档。** 这个项目不会再上线，微信云开发环境已停用、AppID 未续费。
> 代码保留下来当作一次完整的产品 + 工程练习的记录：从 Vue 高保真原型，到能在微信里跑的小程序。

商砖小站是一个校园服务小程序：查课、评课、逛论坛、二手闲置、校园信息、个人主页。
五个 Tab，主包 + 5 个分包，云开发做后端。

---

## 里面有什么

| 目录 | 内容 |
|---|---|
| `miniprogram/zjgsu-campus/` | 微信小程序本体（原生 WXML/WXSS/JS + 云函数） |
| `src/`、`public/`、`index.html` | Vue 3 + Vite 的 Web 高保真原型（同一套信息架构，先在浏览器里把交互跑通） |
| `docs/` | 架构、数据库集合、性能与上线检查等工程文档 |
| `scripts/` | 构建检查、包体积检查、数据导入与校验脚本 |

### 小程序模块

主包 5 个页面，分包按功能拆开：

- **课程**：全校课程浏览、搜索、评价、同学共建课程
- **论坛**：发帖、评论、三级回复、赞踩、举报与申诉
- **闲置**：二手交易与课程互助
- **校园**：校历、地点、活动、教师名录
- **我的**：个人资料、收藏、私信、备忘录
- **管理后台**（分包）：审核员处理举报、下架内容

### 技术栈

- 小程序：原生框架 + 微信云开发（数据库 / 云函数 / 云存储）
- 原型：Vue 3、Vite、Vue Router、Tailwind CSS、lucide 图标
- 构建校验：主包体积红线、页面可加载、下拉刷新、包依赖大小等自检脚本

## 怎么翻

### 看原型（最快）

```bash
pnpm install
pnpm dev
```

浏览器里就是这套信息架构的完整交互。

### 看小程序

用微信开发者工具「导入项目」，选 `miniprogram/zjgsu-campus`。

- AppID 填 `touristappid`（游客模式）即可浏览页面结构
- 项目里的 `CLOUD_ENV` 已替换为占位符 `cloud1-your-env-id`；要让云端功能真的跑起来，需要你自己建一个云开发环境，把环境 ID 填进 `miniprogram/zjgsu-campus/utils/config.js`，并按 `docs/miniprogram-docs/DATABASE.md` 建好集合
- 云函数在 `miniprogram/zjgsu-campus/cloudfunctions/`

> 云端已停用，所以**不填自己的环境时，联网相关页面会一直转圈**，这是预期的。

## 关于隐私

这个仓库在归档前做过清理：

- 移除了 AppID / AppSecret / 云环境 ID / access token，统一改占位符
- 移除了所有真实用户数据（用户 openid、帖子、评价、投票记录等）
- 移除了从教务抓取的课程、教师、真题原始数据
- 移除了内部交接文档与本机路径

仓库里只有代码、文档和少量演示用的种子数据。**不要把真实 AppSecret、用户数据或生产环境 ID 提交进来。**

## 现状与边界

- 不再维护，不接受功能请求
- 云开发环境已停用，联网功能不可用
- 当年的合规与上线流程（备案、类目、隐私协议）没有走完，这也是项目停在这里的原因
- 代码里保留了当时的工程约定和检查脚本，读起来会有点啰嗦，但那是它真实的样子

## 许可

AGPL-3.0-only，见 [LICENSE](LICENSE)。仅作学习与纪念用途；其中涉及的校名、课程名、教师名录等为公开信息，不代表任何官方立场。

---

## English

A campus service mini-program for Zhejiang Gongshang University: course browsing and reviews, a forum, second-hand marketplace, campus info and a profile area — five tabs, one main package plus five sub-packages, with WeChat Cloud Development as the backend.

This repository is **an archive, not a live product**. The cloud environment is shut down and the AppID is not renewed.

- `miniprogram/zjgsu-campus/` — the WeChat mini-program (native framework + cloud functions)
- `src/`, `public/` — a Vue 3 + Vite high-fidelity prototype sharing the same information architecture
- `docs/` — architecture, database collections, performance and launch checklists

Credentials, cloud environment IDs, user openids and scraped production data were removed before publication; the appid is `touristappid` and the environment ID is a placeholder. To run the cloud features you would need your own WeChat Cloud environment.

AGPL-3.0-only licensed. Archived for learning and commemoration.
