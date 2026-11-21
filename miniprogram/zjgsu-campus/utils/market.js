// utils/market.js —— 失物招领与二手交易
//
// 为什么不放进论坛 posts：
//   这两类内容需要「联系方式 + 状态流转」（我捡到了 / 我联系上了 / 已送出），
//   论坛帖没有这些字段，硬塞会让帖子列表变得又长又难看懂。
//
// 三种 type：
//   lost  —— 我丢了东西，捡到的同学按联系方式找我
//   found —— 我捡到了东西，丢东西的同学按联系方式认领
//   sell  —— 二手出售 / 想收，带价格
//
// 结构上和 store.js 一脉相承：本地缓存负责秒开，云端负责全校可见，
// 云函数不可用时自动回落到本地，功能不会中断。
const cloud = require('./cloud.js');
// 精准 / 模糊的搜索内核（全站共用）
const searchCore = require('./search.js');
// 「我发的这条被下架了还是被删了」的合并逻辑，活动那边共用
const mineState = require('./mine-state.js');

const KEY = 'zjgsu_market';

// 三种类型的中文名与配色，列表页 / 发布页共用
const TYPES = {
  lost: { label: '寻物', icon: 'search', hint: '我丢了东西，捡到的同学联系我' },
  found: { label: '招领', icon: 'inbox', hint: '我捡到了东西，丢的同学来认领' },
  sell: { label: '闲置', icon: 'shopping-bag️', hint: '分享你的闲置物品信息，可注明参考价' }
};

// 内存缓存：wx.getStorageSync 每次都要把整份 JSON 重新反序列化一遍。
// 切一次分类读一次、敲一个字读一次 —— 上百条数据时这一遍是几十毫秒纯白花。
// 缓存已经解析好的数组，写操作（发布 / 删除 / 标记 / 拉云端）同步更新它。
//
// ⚠️ 谁要是绕开 write() 直接改 storage，记得调 invalidate() 让缓存作废。
let _mem = null;

function read(key, fallback) {
  if (key === KEY && _mem) return _mem;
  const v = wx.getStorageSync(key);
  const out = (v === '' || v === undefined || v === null) ? fallback : v;
  if (key === KEY) _mem = out;
  return out;
}
function write(key, val) {
  if (key === KEY) _mem = val;
  try { wx.setStorageSync(key, val); } catch (e) {}
}

// 让内存缓存作废（下次读取重新走 storage）
function invalidate() {
  _mem = null;
}

function genId() {
  return 'm' + Date.now() + Math.floor(Math.random() * 1000);
}

function typeLabel(type) {
  return (TYPES[type] && TYPES[type].label) || '闲置';
}

// 闲置分类：教材是开学季最强需求，单独拆一栏出来。
// 个人主体不能做在线交易，所以这里只做「信息发布 + 私信联系」，不碰钱。
//
// ⚠️ 这份数组是「发布页（pages/market/edit）」和「列表筛选（pages/market/list）」
//    两处的**唯一来源** —— 两边都从这里取，新增分类只要改这里，
//    不会出现「发布时能选、筛选时选不到」这种只对一半的情况。
//    「其他」必须放最后：它是兜底项，插在中间会让胶囊顺序看着随机。
//
// ⚠️ key 一旦上线就不能改：改 key 等于让库里已有的条目全部落到「其他」，
//    而 label 随时可以改（它只是给人看的）。「代课」→「课程互助」就是只改了 label。
//    理由：云函数 AD_HINTS 里「代课」是广告特征词（和代写 / 代考一组），
//    这一档叫「课程互助」才不会把「找人换课 / 补笔记」和「有偿代上课」混为一谈。
const CATEGORIES = [
  { key: 'book', label: '教材', icon: 'book-open' },
  { key: 'digital', label: '数码', icon: 'laptop' },
  { key: 'life', label: '生活', icon: 'life-buoy' },
  { key: 'substitute', label: '课程互助', icon: 'users-round' },
  { key: 'other', label: '其他', icon: 'inbox' }
];

function categoryLabel(key) {
  const hit = CATEGORIES.filter((c) => c.key === key)[0];
  return hit ? hit.label : '其他';
}

function categoryIcon(key) {
  const hit = CATEGORIES.filter((c) => c.key === key)[0];
  return hit ? hit.icon : 'inbox';
}

/* ---------------- 云端写操作的统一出口 ---------------- */

// 三种结果：
//   { state:'ok' }            云端做成了
//   { state:'skip' }          没开云 / 没有云环境（本地模式）：改本地就算完成
//   { state:'fail', msg }     云端明确拒绝或根本连不上：本地一个字都不该动
// 以前这三处都是 `await callFunction(...).catch(() => null)`：返回值没人看，
// 于是「云端失败」和「云端成功」在界面上长一个样。
function cloudWrite(action, payload) {
  if (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud()) return Promise.resolve({ state: 'skip' });
  return cloud.callFunction(action, payload).then((r) => {
    if (r && r.ok) return { state: 'ok' };
    return { state: 'fail', msg: (r && r.msg) || '云端没响应，稍后重试' };
  });
}

/* ---------------- 发布 ---------------- */

// item: { type, title, desc, contact, contactType, price, location, images }
async function addMarket(item) {
  const it = item || {};
  const type = TYPES[it.type] ? it.type : 'lost';
  const doc = {
    id: genId(),
    type: type,
    title: String(it.title || '').trim().slice(0, 40),
    desc: String(it.desc || '').trim().slice(0, 500),
    contact: String(it.contact || '').trim().slice(0, 40),
    contactType: it.contactType || 'phone',
    price: type === 'sell' ? String(it.price || '').trim().slice(0, 20) : '',
    location: String(it.location || '').trim().slice(0, 40),
    category: CATEGORIES.some((c) => c.key === it.category) ? it.category : 'other',
    courseName: String(it.courseName || '').trim().slice(0, 30),
    images: Array.isArray(it.images) ? it.images.slice(0, 6) : [],
    author: it.author || '',
    openid: cloud.getOpenid() || it.openid || '',
    time: it.time || today(),
    at: Date.now(),
    status: 'open', // open → done（已经联系上 / 已经出手）
    done: false
  };

  // 先云端、后本地。以前是「本地先落地、云端调用失败也不看返回值」，
  // 结果是没发出去的东西只有本机看得见，用户却收到「已发布」——
  // 别人永远刷不到，他也不知道为什么没人联系。
  const c = await cloudWrite('marketAdd', { item: doc });
  if (c.state === 'fail') {
    // 本地一个字都不写，退回发布页让他改完重试，免得列表里多一条幽灵
    return { ok: false, cloud: 'fail', item: null, msg: c.msg };
  }

  // 重新读一次再插：await 期间列表可能被别的写入（拉新一页）换过
  const list = read(KEY, []);
  list.unshift(doc);
  write(KEY, list);
  return { ok: true, cloud: c.state, item: doc, msg: '' };
}

/* ---------------- 列表 ---------------- */

// 本地缓存（秒开用）：不传 type 拿全部。
// 被举报下架 / 审核删除的条目不进列表 —— 云端已经过滤了，
// 但本机缓存可能还留着上一次拉回来的那份，这一层是给「刚好在详情页被处置」兜底
function getMarkets(type) {
  let list = read(KEY, []).filter((m) => m.hidden !== true && m.deleted !== true);
  if (type && TYPES[type]) list = list.filter((m) => m.type === type);
  return list.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
}

// 只清本地那一条（审核员处置完 / 云端已下架时用）。
// 不走云端：调用方已经在云端处置过了，这里只是别让本机还挂着它
function removeLocal(id) {
  if (!id) return false;
  const list = read(KEY, []);
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return false;
  write(KEY, next);
  return true;
}

// 本地关键词搜索：标题 / 描述 / 地点 / 发布人 / 课程名
function searchMarkets(type, keyword, exact) {
  const kw = String(keyword || '').trim().toLowerCase();
  // 搜本地全量而不是「只搜已同步云端的」：刚发出去还没同步上的那条，
  // 列表里看得见、一搜却搜不到会让人以为没发出去
  const all = getMarkets(type);
  if (!kw) return all;
  // 和论坛、课程用同一套精准 / 模糊判定：把关键字打错一个字也该搜得到，
  // 在哪个板块的体验都该一样
  return all.filter((m) => searchCore.passLevel(searchCore.matchFields(
    [m.title, m.desc, m.location, m.author, m.courseName], kw
  ), !!exact));
}

// 按分类筛（教材 / 数码 / 生活 / 其他）：只在闲置 tab 里用
function filterByCategory(list, category) {
  const c = String(category || '');
  if (!c || c === 'all') return list;
  return list.filter((m) => (m.category || 'other') === c);
}

// 从云端拉一页并写回本地缓存：本地缓存只是镜像，云端才是全校共享的那份
// @param {number} page 第几页（从 1 开始）
// @param {string} type 只拉这个类型（lost / found / sell）；不传就是全部类型。
//   类型下推给云端能少传很多数据；老云函数不认这个参数时会返回全类型，
//   客户端还有一层本地过滤，结果一样对。
// 最近一次从云端拉闲置的结果：null = 还没拉过，true = 拉到了，false = 没拉到。
// fetchMarkets 的返回值只表示「拿到几条」，0 条既可能是真的空、也可能是请求失败 ——
// 光看它没法区分，界面就会把「没读到」说成「这里空空如也」。
let lastFetchOk = null;

function fetchState() {
  return { ok: lastFetchOk };
}

async function fetchMarkets(page, type) {
  if (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud()) {
    // 没开云：本地就是唯一数据源，不算「没读到」
    lastFetchOk = true;
    return 0;
  }
  const p = Math.max(1, page || 1);
  const t = TYPES[type] ? type : '';
  const data = { action: 'marketList', page: p };
  if (t) data.type = t;
  const res = await wx.cloud.callFunction({
    name: 'user',
    data: data
  }).catch(() => null);
  const list = res && res.result && Array.isArray(res.result.list) ? res.result.list : null;
  if (!list) {
    lastFetchOk = false;
    return 0;
  }
  lastFetchOk = true;

  const cache = read(KEY, []);
  // 云端那条先落地并打上标记，本地没同步上去的（自己刚发的）原样保留
  const seen = {};
  list.forEach((m) => { seen[m.id] = true; m.fromCloud = true; });
  const localOnly = cache.filter((m) => !seen[m.id]);
  write(KEY, list.concat(localOnly));
  return list.length;
}

function getCloudMarkets(type) {
  let list = read(KEY, []).filter((m) => m.fromCloud === true && m.hidden !== true && m.deleted !== true).slice();
  if (type && TYPES[type]) list = list.filter((m) => m.type === type);
  return list.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
}

/* ---------------- 详情 / 状态 ---------------- */

function nickName() {
  const u = wx.getStorageSync('zjgsu_user');
  return (u && u.nickName) || '';
}

// 这条是不是我发的。openid 优先；老数据没有 openid 时退回昵称比对
// （昵称会重名，所以只在没有 openid 时才用，别把主判据写成昵称）
function isMine(m) {
  if (!m) return false;
  const me = cloud.getOpenid() || '';
  if (m.openid && me) return m.openid === me;
  const name = nickName();
  return !!name && m.author === name;
}

function getMarketById(id) {
  const hit = read(KEY, []).find((m) => m.id === id);
  // 被处置过的条目对所有人（含作者）都不再展示：详情页拿到 null 会说「不存在」，
  // 比打开一个已被下架的内容更合适
  if (!hit || hit.hidden === true || hit.deleted === true) return null;
  // 本地那条（刚发完就进详情、或还没同步到云端）没有 isMine 字段，
  // 详情页会把「删除」「标记为已解决」当成别人的内容不显示
  return isMine(hit) ? Object.assign({}, hit, { isMine: true }) : hit;
}

// 我发的那一条，**含已被举报下架（hidden）的**，但不含 deleted ——
// 那是审核员确认违规之后的结果，没有恢复这回事。
// 为什么必须开这个口子：下架之后 getMarketById 一律 null，作者打开详情只会看到
// 「这条记录不见了」，被误伤时连申诉和恢复的入口都没有。
function getMineById(id) {
  const hit = read(KEY, []).find((m) => m.id === id);
  if (!hit || hit.deleted === true || !isMine(hit)) return null;
  return Object.assign({}, hit, { isMine: true, paused: hit.hidden === true });
}

// 认领 / 成交：Mark 一下，别人列表里能看到「已经解决了」，避免抢同一件东西
//
// 同样先云端、后本地：状态是给别人看的，本地改了云端没改，
// 别人那边永远是「还在」，等于这个功能只是自己安慰自己。
async function markDone(id) {
  const hit = read(KEY, []).find((m) => m.id === id);
  if (!hit) return { ok: false, cloud: 'skip', item: null, msg: '这条已经不在了' };
  const next = hit.status === 'done' ? 'open' : 'done';

  const c = await cloudWrite('marketDone', { id: id, done: next === 'done' });
  if (c.state === 'fail') return { ok: false, cloud: 'fail', item: hit, msg: c.msg };

  // 重新读一次：await 期间可能拉了新一页，拿旧数组整份写回会丢数据
  const list = read(KEY, []);
  const h2 = list.find((m) => m.id === id);
  if (h2) {
    h2.status = next;
    h2.done = next === 'done';
    write(KEY, list);
  }
  return { ok: true, cloud: c.state, item: h2 || hit, msg: '' };
}

// 删除（自己的）
async function removeMarket(id) {
  const c = await cloudWrite('marketRemove', { id: id });
  // 云端没删掉就不动本地：否则本地看不见、别人还看得见，
  // 下次拉新一页又把它合并回来（fetchMarkets 是「云端 + 本地独有」合并的）
  if (c.state === 'fail') return { ok: false, cloud: 'fail', msg: c.msg };
  write(KEY, read(KEY, []).filter((m) => m.id !== id));
  return { ok: true, cloud: c.state, msg: '' };
}

/* ---------------- 我的 ---------------- */

function getMyMarkets() {
  return read(KEY, [])
    // 已删除的不再列给作者：那是审核确认违规的结果，留在列表里只会让人反复点开又打不开
    .filter((m) => m.deleted !== true && isMine(m))
    // 被举报下架的仍然列出，但打上 paused —— 「我发布的」是作者唯一找得到它的地方
    .map((m) => Object.assign({}, m, { isMine: true, paused: m.hidden === true }))
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
}

// 和云端对一次账：我发的东西现在是不是被暂停展示了 / 已经被删了。
// 只动我自己那几条，别人的内容一概不碰
async function syncMine() {
  if (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud()) return { ok: false, skipped: true };
  const r = await cloud.callFunction('myContent', {});
  if (!r || r.ok === false) return { ok: false, degraded: true };
  const before = read(KEY, []);
  const merged = mineState.mergeStates(before, r.market);
  if (merged.degraded) return { ok: false, degraded: true };
  // 换台设备时本地是空的：被下架的那条只能靠这里的完整内容补回来，
  // 否则它永远进不了「我的闲置」，恢复按钮也就没机会被看到
  const adopted = mineState.adoptPaused(merged.list, r.marketPaused);
  const next = adopted.list;
  const changed = adopted.added > 0
    || next.length !== before.length
    || next.some((x, i) => !before[i] || before[i].id !== x.id || (before[i].hidden === true) !== (x.hidden === true));
  if (changed) write(KEY, next);
  return { ok: true, paused: merged.paused, dropped: merged.dropped, added: adopted.added };
}

// 恢复展示。必须先云端改成功再动本地：反过来的话本地看着好了、别人还是看不到，
// 而且下一次 syncMine 会把本地又打回已下架 —— 用户看到的会是「恢复没生效」
async function restoreMarket(id) {
  const c = await cloudWrite('setStatus', { targetId: id, status: 'normal', targetType: 'market' });
  if (c.state === 'fail') return { ok: false, cloud: 'fail', msg: c.msg };
  if (c.state === 'ok') {
    const list = read(KEY, []);
    const hit = list.find((m) => m.id === id);
    if (hit) {
      hit.hidden = false;
      hit.hiddenReason = '';
      hit.hiddenAt = '';
      write(KEY, list);
    }
  }
  return { ok: true, cloud: c.state };
}

function today() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

module.exports = {
  TYPES,
  KEY,
  CATEGORIES,
  typeLabel,
  categoryLabel,
  categoryIcon,
  filterByCategory,
  invalidate,
  addMarket,
  getMarkets,
  removeLocal,
  getCloudMarkets,
  searchMarkets,
  fetchMarkets,
  fetchState,
  getMarketById,
  getMineById,
  markDone,
  removeMarket,
  getMyMarkets,
  syncMine,
  restoreMarket
};
