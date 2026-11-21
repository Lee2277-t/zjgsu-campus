// utils/store-favorite.js —— 收藏（本地 + 云端同步）
// 基础设施（KEYS / read / write / 墓碑 / 工具函数）统一来自 store-base.js；
// 跨模块调用通过 require 同级 store-* 模块获取，不跨文件改写逻辑。

const { KEYS, read, write, cloud } = require('./store-base.js');

/* ---------------- 收藏 ---------------- */

// 收藏最多留 200 条：再多没人会去翻，却要拖慢每次读取
const FAV_MAX = 200;

function getFavorites() {
  const list = read(KEYS.favorites, []);
  return Array.isArray(list) ? list : [];
}

// 收藏同一个开关：已在收藏里就移除，不在就加上
// item: { type, id, title, when, place }
//   when / place 是给「活动」这类需要副信息的类型用的，其余类型不写就没这两个键。
//   为什么把它们存进收藏条目、而不是等渲染时再去查原文：官网活动只在窗口内
//   （招聘会按举办日期、公告按发布时间），一场秋招宣讲会可能在同学点开收藏
//   之前就从列表里滚掉了。到时候只剩一个打不开的 id，收藏就变成了死链接。
//   存一份快照，条目自己就能站住 —— 打不开也不要紧，至少还看得见是哪一场。
function toggleFavorite(item) {
  const it = item || {};
  const type = String(it.type || '');
  const id = String(it.id || '');
  if (!type || !id) return { ok: false, favorited: false };
  const before = getFavorites();
  const adding = !before.some((f) => f.type === type && f.id === id);
  let list = before.filter((f) => !(f.type === type && f.id === id));
  if (adding) {
    const row = {
      type: type,
      id: id,
      title: String(it.title || '').slice(0, 60),
      at: Date.now()
    };
    if (it.when) row.when = String(it.when).slice(0, 40);
    if (it.place) row.place = String(it.place).slice(0, 40);
    list.unshift(row);
  }
  if (list.length > FAV_MAX) list = list.slice(0, FAV_MAX);
  write(KEYS.favorites, list);
  pushFavoritesToCloud(list);
  return { ok: true, favorited: adding };
}

function isFavorited(type, id) {
  return getFavorites().some((f) => f.type === type && f.id === id);
}

function removeFavorite(type, id) {
  const list = getFavorites().filter((f) => !(f.type === type && f.id === id));
  write(KEYS.favorites, list);
  pushFavoritesToCloud(list);
  return list;
}

// 收藏是「我」的私有数据，整份覆盖写即可，没有并发冲突
function pushFavoritesToCloud(list) {
  if (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud()) return Promise.resolve(false);
  try {
    return require('./user.js').saveFavorites(list).then(() => true).catch(() => false);
  } catch (e) {
    return Promise.resolve(false);
  }
}

// 换设备 / 重装后把云端那份收藏拉回来，本地那份作为兜底
function pullFavorites() {
  if (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud()) return Promise.resolve(null);
  try {
    return require('./user.js').getFavorites()
      .then((r) => ((r && Array.isArray(r.list) && r.list.length) ? r.list : null))
      .catch(() => null);
  } catch (e) {
    return Promise.resolve(null);
  }
}

module.exports = {
  getFavorites,
  toggleFavorite,
  isFavorited,
  removeFavorite,
  pushFavoritesToCloud,
  pullFavorites,
  // 收藏上限：云端合并（store-sync.mergeFavorites）也要用同一个上限，集中在此定义
  FAV_MAX
};
