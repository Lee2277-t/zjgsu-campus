// utils/event.js —— 校园活动
//
// 为什么单开一个数据层：活动有「时间 / 地点 / 人数上限 / 报名」这些字段，
// 论坛帖没有；而且它是唯一带「报名」这种可撤销状态的功能，
// 塞进 store.js 会让那个文件再长一截。
//
// 结构和 store.js / market.js 一脉相承：本地缓存负责秒开，云端负责全校可见，
// 云函数不可用时自动回落到本地，发布和报名都不会卡死。
const cloud = require('./cloud.js');
// 「我发的这条被下架了还是被删了」的合并逻辑，闲置那边共用
const mineState = require('./mine-state.js');

const KEY = 'zjgsu_events';

// 四种活动类型。选这几个是因为它们都是「有明确时间地点、会有人想一起去」的事，
// 顺便 / 吐槽这类内容更适合丢进论坛
const TYPES = {
  jobfair: { label: '招聘会', icon: 'briefcase', hint: '招聘会 / 双选会 / 宣讲会' },
  lecture: { label: '讲座', icon: 'megaphone️', hint: '讲座 / 宣讲 / 经验交流会' },
  contest: { label: '比赛', icon: 'award', hint: '学科竞赛 / 演讲比赛 / 答辩' },
  team: { label: '组队', icon: 'users-round', hint: '大创 / 挑战杯 / 数学建模找队友' },
  other: { label: '其他', icon: 'sparkles', hint: '社团活动 / 志愿活动 / 聚餐' }
};

function typeLabel(type) {
  return (TYPES[type] && TYPES[type].label) || '其他';
}

function typeIcon(type) {
  return (TYPES[type] && TYPES[type].icon) || 'sparkles';
}

function read(key, fallback) {
  const v = wx.getStorageSync(key);
  return (v === '' || v === undefined || v === null) ? fallback : v;
}
function write(key, val) {
  try { wx.setStorageSync(key, val); } catch (e) {}
}

function readList() {
  const v = read(KEY, []);
  return Array.isArray(v) ? v.filter(Boolean) : [];
}
function genId() {
  return 'ev' + Date.now() + Math.floor(Math.random() * 1000);
}

function nowText() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 云函数统一入口在 cloud.js，这里只转发
const call = cloud.callFunction;

/* ---------------- 发布 ---------------- */

// item: { type, title, desc, location, date, time, capacity, contact, contactType }
async function addEvent(item) {
  const it = item || {};
  const doc = {
    id: genId(),
    type: TYPES[it.type] ? it.type : 'other',
    title: String(it.title || '').trim().slice(0, 40),
    desc: String(it.desc || '').trim().slice(0, 500),
    location: String(it.location || '').trim().slice(0, 40),
    // date / time 两个 picker 拼成一个字符串，WXML 里直接显示，不用再拆
    start: (String(it.date || '').trim() + ' ' + String(it.time || '').trim()).trim(),
    capacity: Math.max(0, Math.min(500, Math.round(Number(it.capacity) || 0))),
    contact: String(it.contact || '').trim().slice(0, 40),
    contactType: it.contactType || 'wechat',
    author: it.author || '',
    openid: cloud.getOpenid() || '',
    time: nowText(),
    at: Date.now(),
    joinedCount: 0
  };

  // 本地先落地：云函数还没重新部署的时候，活动也照样发得出去
  const list = readList();
  list.unshift(doc);
  write(KEY, list);

  const r = await call('eventAdd', { event: doc });
  // 云端明确说「存不住」时，本地这份要撤掉，否则列表里会出现一条云端没有的幽灵活动
  // （下次同步时它会被顶掉，同学看到的就是「刚发的活动没了」）
  if (r && r.ok === false) {
    if (r.saved === false) {
      write(KEY, readList().filter((x) => x.id !== doc.id));
    }
    return r;
  }
  if (r && r.event) {
    const list2 = readList().map((x) => (x.id === doc.id ? r.event : x));
    write(KEY, list2);
  }
  return r && r.ok ? { ok: true } : { ok: true };
}

/* ---------------- 列表 ---------------- */

function sortByTime(list) {
  return list.slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
}

// 本地缓存（秒开用）
function getEvents() {
  // 被举报下架 / 审核删除的活动不进列表。云端已经过滤了，
  // 这层是给「本机缓存里还留着上一次那份」兜底
  return sortByTime(readList().filter((e) => e.hidden !== true && e.deleted !== true));
}

// 只清本地那一条（审核员处置完 / 云端已下架时用）
function removeLocal(id) {
  if (!id) return false;
  const list = readList();
  const next = list.filter((e) => e.id !== id);
  if (next.length === list.length) return false;
  write(KEY, next);
  return true;
}

function getCloudEvents() {
  return sortByTime(readList().filter((e) => e.fromCloud === true));
}

// 从云端拉一页并写回本地缓存：本地缓存只是镜像，云端才是全校共享的那份
// 最近一次拉活动的结果：null = 还没拉过，true = 拉到了，false = 没拉到。
// fetchEvents 的返回值是「拿到几条」，0 条既可能是真的没有、也可能是请求失败 ——
// 界面要说清是哪一种，就不能只看这个数字。
let lastFetchOk = null;

function fetchState() {
  return { ok: lastFetchOk };
}

async function fetchEvents(page) {
  if (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud()) {
    lastFetchOk = true;   // 本地模式，本地就是唯一数据源
    return 0;
  }
  const p = Math.max(1, page || 1);
  const res = await call('eventList', { page: p });
  const list = res && Array.isArray(res.list) ? res.list : null;
  if (!list) {
    lastFetchOk = false;
    return 0;
  }
  lastFetchOk = true;

  const cache = readList();
  const seen = {};
  list.forEach((e) => { seen[e.id] = true; e.fromCloud = true; });
  const localOnly = cache.filter((e) => !seen[e.id]);
  write(KEY, list.concat(localOnly));
  return list.length;
}

function nickName() {
  const u = wx.getStorageSync('zjgsu_user');
  return (u && u.nickName) || '';
}

// 这条是不是我发起的。openid 优先；老数据没有 openid 才退回昵称
function isMine(e) {
  if (!e) return false;
  const me = cloud.getOpenid() || '';
  if (e.openid && me) return e.openid === me;
  const name = nickName();
  return !!name && e.author === name;
}

function getEventById(id) {
  const hit = readList().find((e) => e.id === id);
  // 已处置的活动对所有人都不再展示（详情页拿到 null 会说「找不到了」）
  if (!hit || hit.hidden === true || hit.deleted === true) return null;
  // 本地那条（刚发完 / 还没同步上去）没有 isMine，详情页会把自己的活动当别人的
  return isMine(hit) ? Object.assign({}, hit, { isMine: true }) : hit;
}

// 我发起的那一个，**含已被举报下架（hidden）的**，不含 deleted。
// 活动详情页靠它让作者进得来看原因、点恢复 —— 否则下架就等于永远消失
function getMineById(id) {
  const hit = readList().find((e) => e.id === id);
  if (!hit || hit.deleted === true || !isMine(hit)) return null;
  return Object.assign({}, hit, { isMine: true, paused: hit.hidden === true });
}

/* ---------------- 报名 ---------------- */

// 报名：云端写库成功才算数。这里不打本地补丁再删，
// 前面 addEvent 已经为了「云函数没部署也能发」写了本地，
// 但报名不涉及「新内容」，本地缓存改不动别人的活动，失败了就如实说。
async function joinEvent(id) {
  const r = await call('eventJoin', { id: id });
  if (r === null) return { ok: false, saved: false, msg: '云端连不上，报名没记上' };
  return r;
}

// 取消报名（报给自己取消，不影响别人）
async function cancelJoin(id) {
  const r = await call('eventCancel', { id: id });
  if (r === null) return { ok: false, saved: false, msg: '云端连不上，没能取消' };
  return r;
}

/* ---------------- 删除 ---------------- */

// 只能删自己发的：删了之后本地那条也一并清掉，
// 不然「云端删了、本地还留着」，下次进列表又冒出来一条看不了的活动
async function removeEvent(id) {
  const r = await call('eventRemove', { id: id });
  if (r === null) return { ok: false, msg: '云端连不上，没能删掉' };
  if (r.ok === false) return r;
  write(KEY, readList().filter((e) => e.id !== id));
  return { ok: true };
}

/* ---------------- 我的 ---------------- */

function getMyEvents() {
  return sortByTime(readList().filter((e) => e.deleted !== true && isMine(e)))
    .map((e) => Object.assign({}, e, { isMine: true, paused: e.hidden === true }));
}

// 和云端对一次账：我发起的活动现在是不是被暂停展示了 / 已经被删了。
// 公开列表里查不到被下架的那些，本地缓存只知道「上次看到的样子」，必须问云端
async function syncMine() {
  if (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud()) return { ok: false, skipped: true };
  const r = await call('myContent', {});
  if (!r || r.ok === false) return { ok: false, degraded: true };
  const before = readList();
  const merged = mineState.mergeStates(before, r.event);
  if (merged.degraded) return { ok: false, degraded: true };
  // 换台设备时本地是空的，被下架那条只能靠云端把完整内容补回来
  const adopted = mineState.adoptPaused(merged.list, r.eventPaused);
  const next = adopted.list;
  const changed = adopted.added > 0
    || next.length !== before.length
    || next.some((x, i) => !before[i] || before[i].id !== x.id || (before[i].hidden === true) !== (x.hidden === true));
  if (changed) write(KEY, next);
  return { ok: true, paused: merged.paused, dropped: merged.dropped, added: adopted.added };
}

// 恢复展示：云端先成功再改本地，理由同 market.restoreMarket
async function restoreEvent(id) {
  const r = await call('setStatus', { targetId: id, status: 'normal', targetType: 'event' });
  if (r === null) return { ok: false, msg: '云端连不上，没能恢复' };
  if (r.ok === false) return r;
  const list = readList();
  const hit = list.find((e) => e.id === id);
  if (hit) {
    hit.hidden = false;
    hit.hiddenReason = '';
    hit.hiddenAt = '';
    write(KEY, list);
  }
  return { ok: true };
}

// 官网活动正文：云端抓取并转成 Markdown，详情页渲染
function fetchArticle(id) {
  return call('eventArticle', { id: id }).then((r) => r || { ok: false, msg: '云函数没响应' });
}

module.exports = {
  TYPES,
  KEY,
  typeLabel,
  typeIcon,
  nowText,
  addEvent,
  getEvents,
  removeLocal,
  getCloudEvents,
  fetchEvents,
  fetchState,
  getEventById,
  getMineById,
  joinEvent,
  cancelJoin,
  removeEvent,
  getMyEvents,
  syncMine,
  restoreEvent,
  fetchArticle
};
