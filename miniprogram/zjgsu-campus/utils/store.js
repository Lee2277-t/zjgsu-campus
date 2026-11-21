// utils/store.js —— 数据层聚合入口
//
// 本文件不再包含业务实现，只把各业务模块（store-*.js）统一导出，
// 对外保持与原版完全一致的 module.exports 接口，所有调用方无需改动。
//
// 业务实现分布：
//   store-base.js     共享基础设施（KEYS / read / write / 墓碑 / 工具 / 常量）
//   store-user.js     用户资料
//   store-course.js   课程 + 课程评价
//   store-forum.js    校园论坛（帖子 / 投票 / 点赞 / 树洞 / 举报 / 审核）
//   store-sync.js     云端同步 + 启动初始化
//   store-search.js   论坛搜索
//   store-favorite.js 收藏
//   store-draft.js    草稿

const base = require('./store-base.js');
const user = require('./store-user.js');
const course = require('./store-course.js');
const forum = require('./store-forum.js');
const sync = require('./store-sync.js');
const search = require('./store-search.js');
const favorite = require('./store-favorite.js');
const draft = require('./store-draft.js');

module.exports = Object.assign({}, user, course, forum, sync, search, favorite, draft, {
  // 来自 store-base 的顶层导出
  HOLE_BOARD: base.HOLE_BOARD,
  PAGE: base.PAGE,
  myOpenid: base.myOpenid,
  openidTrouble: base.openidTrouble,
  // 幂等键用：发帖页要在「第一次提交时生成、重试时复用」同一个 id，
  // 这样超时重发不会在云端多出一条（见 utils/store-forum.js 的 addPost）
  genId: base.genId
});
