// test-jobfav.cjs —— 「收藏招聘会」的行为测试
//
// 覆盖三件事：
//   ① store 层：收藏写入 / 取消 / 快照字段 / 200 条上限不受影响
//   ② 校园页：只给招聘会开收藏入口、点一次只改自己那张卡、状态跟 store 一致
//   ③ 我的收藏页：五个页签、活动能还原成可点的条目、出窗口后靠快照兜住不消失
//
// 跑法：node test-jobfav.cjs（工作目录在 recon/ 下）

const path = require('path');
const fs = require('fs');
const Module = require('module');

const APP = path.join(__dirname, '..', 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');

// recon/ 下的 package.json 写着 "type": "module"，Node 22 会把小程序源码的 .js
// 当 ESM 加载，于是 require() 直接炸「require is not defined」。
// 这里把项目内 .js 的编译方式强行改回 CommonJS。
// ⚠️ 前缀必须用 path.resolve 过的原生路径比：Windows 下 Node 传进来的是反斜杠，
//    拿正斜杠前缀去 startsWith 永远不成立，hook 就形同虚设。
const origJsExt = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (norm(filename).startsWith(norm(APP))) return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return origJsExt(mod, filename);
};

let pass = 0;
const fails = [];

function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra ? '  → ' + extra : ''));
}
function eq(name, a, b) {
  ok(name, a === b, '期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a));
}

/* ---------------- 造一个假的 wx + 内存 storage ---------------- */

const store = {};
function makeWx() {
  return {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v; },
    removeStorageSync: (k) => { delete store[k]; },
    showToast: () => {},
    hideToast: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    showModal: (o) => { if (o && o.success) o.success({ confirm: false }); },
    navigateTo: () => {},
    navigateBack: () => {},
    getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667, statusBarHeight: 20 })
  };
}

/**
 * 在 require 一个模块之前，替掉它依赖的模块（按 require 的原始字符串路径匹配）。
 * 这是唯一能让被测文件「以为」自己拿到的是真 wx / 真云开发的办法。
 */
function stub(rewrites) {
  const orig = Module._load;
  Module._load = function (request, parent, isMain) {
    const key = parent && parent.filename ? parent.filename : '';
    const p = rewrites[key];
    if (p && Object.prototype.hasOwnProperty.call(p, request)) {
      return p[request];
    }
    return orig.apply(this, arguments);
  };
  return function restore() { Module._load = orig; };
}

// 把 wx 装进 globals，这样 utils 里裸调 wx.xxx 的地方能拿到
function installGlobals() {
  global.wx = makeWx();
  global.Page = function (p) { Page.__last = p; };
  global.getApp = () => ({ globalData: {}, store: {} });
  global.App = function () {};
}

/** 把 Page({...}) 的对象当成原型，造一个能调 setData 的实例 */
function makePage(def, initialData) {
  const inst = Object.create(def);
  inst.data = JSON.parse(JSON.stringify(Object.assign({}, def.data, initialData || {})));
  inst.setDataCalls = [];
  inst.setData = function (patch) {
    inst.setDataCalls.push(patch);
    // 只支持本页用到的两种写法：整字段、以及 'a[0].b' 路径
    Object.keys(patch).forEach((k) => {
      const m = /^([^\[]+)\[(\d+)\]\.([^.]+)$/.exec(k);
      if (m) {
        const arr = inst.data[m[1]];
        if (Array.isArray(arr) && arr[Number(m[2])]) arr[Number(m[2])][m[3]] = patch[k];
      } else {
        inst.data[k] = patch[k];
      }
    });
  };
  return inst;
}

/* ---------------- 载入被测文件里的函数 ---------------- */

function loadFn(rel, fnName, extraSource) {
  const src = fs.readFileSync(path.join(APP, rel), 'utf8');
  // 把整个文件当脚本跑一遍，只取出一个函数
  const m = new Function(extraSource || '', src + '\n;return typeof ' + fnName + ' !== "undefined" ? ' + fnName + ' : null;');
  return m();
}

(async function () {
installGlobals();

/* ============ ① store-favorite：收藏本身 ============ */

const favPath = path.join(APP, 'utils', 'store-favorite.js');
const favSrc = fs.readFileSync(favPath, 'utf8');

// store-favorite 依赖 store-base（KEYS / read / write / cloud）和 user.js。
// 这里把 store-base 替成纯内存版，把 user.js 替成记录调用次数的桩，
// 这样测的是 store-favorite 自己的逻辑，而不是云端往返。
const fakeKeys = { favorites: 'zjgsu_favorites' };
let favList = [];
let saveFavoritesCalls = 0;

const fakeBase = {
  KEYS: fakeKeys,
  read: (k, d) => (k === fakeKeys.favorites ? favList.slice() : d),
  write: (k, v) => { if (k === fakeKeys.favorites) favList = v; },
  cloud: { cfg: { USE_CLOUD: true }, ensureCloud: () => true }
};
const fakeUser = {
  saveFavorites: () => { saveFavoritesCalls += 1; return Promise.resolve({ ok: true }); },
  getFavorites: () => Promise.resolve({ list: [] })
};

// 桩要一直挂到 ① 整段测完再撤：pushFavoritesToCloud 是在**函数体内**惰性
// require('./user.js') 的，require 完就撤桩的话，真正点收藏时已经换回真的
// user.js，saveFavoritesCalls 永远是 0 —— 那是桩的时机问题，不是实现的 bug。
const restoreFav = stub({
  [favPath]: { './store-base.js': fakeBase, './user.js': fakeUser }
});
const favApi = require(favPath);

ok('store-favorite 导出 toggleFavorite', typeof favApi.toggleFavorite === 'function');
ok('store-favorite 导出 isFavorited', typeof favApi.isFavorited === 'function');
ok('store-favorite 导出 removeFavorite', typeof favApi.removeFavorite === 'function');

// 普通类型：不该多出 when / place 两个键
favApi.toggleFavorite({ type: 'post', id: 'p1', title: '帖子标题' });
eq('收藏一条帖子', favApi.getFavorites().length, 1);
eq('帖子收藏存了 type', favApi.getFavorites()[0].type, 'post');
eq('帖子收藏没有 when 键', 'when' in favApi.getFavorites()[0], false);
eq('帖子收藏没有 place 键', 'place' in favApi.getFavorites()[0], false);

// 活动类型：快照字段要落进去
favApi.toggleFavorite({ type: 'event', id: 'e1', title: '某某企业宣讲会', when: '10月20日 14:00', place: '图书馆报告厅' });
eq('收藏一条招聘会', favApi.getFavorites().length, 2);
const evRow = favApi.getFavorites().find((f) => f.type === 'event');
ok('招聘会收藏存了 when 快照', evRow.when === '10月20日 14:00', JSON.stringify(evRow));
ok('招聘会收藏存了 place 快照', evRow.place === '图书馆报告厅', JSON.stringify(evRow));

// 标题截断：收藏条目标题留 60 字、快照留 40 字，超了要截
favApi.toggleFavorite({ type: 'event', id: 'e2', title: '标'.repeat(80), when: '时'.repeat(60), place: '点'.repeat(60) });
const e2Row = favApi.getFavorites().find((f) => f.id === 'e2');
eq('收藏标题被截到 60 字', e2Row.title.length, 60);
eq('when 快照截到 40 字', e2Row.when.length, 40);
eq('place 快照截到 40 字', e2Row.place.length, 40);

// isFavorited 对得上
ok('isFavorited(e1) 为真', favApi.isFavorited('event', 'e1') === true);
ok('isFavorited(e-nope) 为假', favApi.isFavorited('event', 'e-nope') === false);

// 再点一次是取消
const again = favApi.toggleFavorite({ type: 'event', id: 'e1', title: '某某企业宣讲会' });
eq('再点一次是取消', again.favorited, false);
ok('取消后 e1 不在列表里', !favApi.getFavorites().some((f) => f.id === 'e1'));
// 取消时不应该丢掉 other 类型
ok('取消一条不影响别的', favApi.getFavorites().some((f) => f.id === 'p1'));

// 缺 type / id 直接拒绝，不该污染收藏
eq('缺 id 拒绝', favApi.toggleFavorite({ type: 'event', id: '', title: 'x' }).ok, false);
eq('缺 type 拒绝', favApi.toggleFavorite({ type: '', id: 'x1' }).ok, false);

// 上限 200：塞 250 条只留 200
favList = [];
for (let i = 0; i < 250; i++) favApi.toggleFavorite({ type: 'event', id: 'bulk' + i, title: '第' + i });
eq('收藏上限 200', favApi.getFavorites().length, 200);
ok('超限后留的是最新 200 条', favApi.getFavorites()[0].id === 'bulk249', favApi.getFavorites()[0].id);

// 同步到云端被调用过
ok('收藏会同步云端', saveFavoritesCalls > 0);
restoreFav();

favList = [];

/* ============ ② 校园页：收藏入口与状态 ============ */

const campusPath = path.join(APP, 'pages', 'campus', 'campus.js');
const campusSrc = fs.readFileSync(campusPath, 'utf8');

// 页面在 onLoad 里就要拉活动；这里把三个依赖都替掉，只喂一份固定的活动列表
const FIXTURE_EVENTS = [
  { id: 'j1', type: 'jobfair', official: true, title: 'A公司校园宣讲会', start: '10月20日 14:00', location: '图书馆报告厅', jobTs: Date.now() + 3 * 86400000, jobEndTs: Date.now() + 3 * 86400000, fromCloud: true },
  { id: 'j2', type: 'jobfair', official: true, title: 'B公司校园宣讲会', start: '10月22日 10:00', location: '教三楼 201', jobTs: Date.now() + 5 * 86400000, jobEndTs: Date.now() + 5 * 86400000, fromCloud: true },
  { id: 'n1', type: 'notice', official: true, title: '关于国庆放假安排的通知', start: '10月1日', at: Date.now() - 86400000, fromCloud: true }
];

const fakeEventApi = {
  getEvents: () => FIXTURE_EVENTS.slice(),
  fetchEvents: () => Promise.resolve(0),
  typeIcon: () => 'pin',
  typeLabel: (t) => (t === 'jobfair' ? '招聘会' : '通知'),
  getEventById: (id) => FIXTURE_EVENTS.find((e) => e.id === id) || null,
  nowText: () => '2026-10-16 08:00',
  KEY: 'events'
};
const fakeUserApi = { eventSync: () => Promise.resolve({ ok: false }) };
const fakeNav = { go: () => {} };
const campusFav = { list: [], is: {} };
const campusStoreStub = {
  isFavorited: (t, id) => !!campusFav.is[t + ':' + id],
  toggleFavorite: (it) => {
    const key = it.type + ':' + it.id;
    const adding = !campusFav.is[key];
    if (adding) { campusFav.is[key] = true; campusFav.list.push(it); }
    else {
      campusFav.is[key] = false;
      campusFav.list = campusFav.list.filter((x) => !(x.type === it.type && x.id === it.id));
    }
    return { ok: true, favorited: adding };
  }
};

const restoreCampus = stub({
  [campusPath]: {
    '../../utils/event.js': fakeEventApi,
    '../../utils/user.js': fakeUserApi,
    '../../utils/nav.js': fakeNav,
    '../../utils/store.js': campusStoreStub
  }
});
delete require.cache[require.resolve(campusPath)];
require(campusPath);
const campusDef = Page.__last;
restoreCampus();
delete require.cache[require.resolve(campusPath)];

ok('校园页导出 onFavEvent', typeof campusDef.onFavEvent === 'function');
ok('校园页导出 loadEvents', typeof campusDef.loadEvents === 'function');

const campusPage = makePage(campusDef);
await campusPage.loadEvents();

const shown = campusPage.data.shownOfficial;
ok('官网活动有 3 条', shown.length === 3, '实际 ' + shown.length);
const j1 = shown.find((x) => x.id === 'j1');
const n1 = shown.find((x) => x.id === 'n1');
ok('招聘会卡片存在', !!j1);
ok('公告卡片存在', !!n1);

// 只有招聘会给收藏状态
eq('招聘会 favorited 初值为 false', j1.favorited, false);
eq('公告没有收藏状态', n1.favorited, false);

// 点一下收藏
campusPage.onFavEvent({ currentTarget: { dataset: { id: 'j1' } } });
const j1After = campusPage.data.shownOfficial.find((x) => x.id === 'j1');
eq('点收藏后该卡 favorited 变 true', j1After.favorited, true);
eq('只改了一张卡', campusPage.data.shownOfficial.find((x) => x.id === 'j2').favorited, false);
eq('公告没被影响', campusPage.data.shownOfficial.find((x) => x.id === 'n1').favorited, false);
ok('收藏条目带上了时间快照', campusFav.list[0].when === '10月20日 14:00', JSON.stringify(campusFav.list[0]));
ok('收藏条目带上了地点快照', campusFav.list[0].place === '图书馆报告厅');
eq('收藏用的是 event 类型', campusFav.list[0].type, 'event');

// 再点取消
campusPage.onFavEvent({ currentTarget: { dataset: { id: 'j1' } } });
eq('再点一次取消收藏', campusPage.data.shownOfficial.find((x) => x.id === 'j1').favorited, false);

// 无效 id 不能炸
campusPage.onFavEvent({ currentTarget: { dataset: { id: 'not-exist' } } });
campusPage.onFavEvent({ currentTarget: { dataset: {} } });
ok('无效 id 不会改坏数据', campusPage.data.shownOfficial.length === 3);

// 已收藏时重新进页面，状态要跟着 store 回来
campusFav.is['event:j2'] = true;
const campusPage2 = makePage(campusDef);
await campusPage2.loadEvents();
eq('重进页面时已收藏状态能恢复', campusPage2.data.shownOfficial.find((x) => x.id === 'j2').favorited, true);
campusFav.is['event:j2'] = false;

/* ============ ③ 我的收藏页：五个页签 + 快照兜底 ============ */

const favPagePath = path.join(APP, 'sub', 'mine', 'favorites', 'favorites.js');
const fakeMarket = { getMarketById: () => null };

// 这份 store 里放：一个活动（还在列表里）、一个活动（已出列表，只能靠快照）、
// 一个帖子（对照：还在的走正常分支）、一个已删的帖子（对照：应该安静跳过）
const favPageStore = {
  getFavorites: () => [
    { type: 'event', id: 'j1', title: 'A公司校园宣讲会', when: '10月20日 14:00', place: '图书馆报告厅', at: 1 },
    { type: 'event', id: 'jGONE', title: 'C公司秋招宣讲会', when: '11月3日 15:00', place: '体育馆', at: 2 },
    { type: 'post', id: 'p1', title: '还在的帖子', at: 3 },
    { type: 'post', id: 'pGone', title: '被删的帖子', at: 4 },
    { type: 'market', id: 'mGone', title: '卖掉了的闲置', at: 5 }
  ],
  getPostById: (id) => (id === 'p1' ? { title: '还在的帖子', content: '正文' } : null),
  getReviewById: () => null,
  getCourseById: () => null,
  removeFavorite: () => {}
};

const restoreFavPage = stub({
  [favPagePath]: {
    '../../../utils/store.js': favPageStore,
    '../../../utils/market.js': fakeMarket,
    // 只让 j1 还在活动列表里；jGONE 模拟「已出官网窗口」
    '../../../utils/event.js': {
      getEventById: (id) => (id === 'j1' ? FIXTURE_EVENTS[0] : null)
    },
    '../../../utils/nav.js': { go: () => {} }
  }
});
delete require.cache[require.resolve(favPagePath)];
require(favPagePath);
const favPageDef = Page.__last;
restoreFavPage();
delete require.cache[require.resolve(favPagePath)];

const fp = makePage(favPageDef);
fp.load();

const items = fp.data.items;
eq('共还原出 3 条', items.length, 3);
ok('已删的帖子被安静跳过', !items.some((x) => x.key === 'pGone'));
ok('卖掉的闲置被安静跳过', !items.some((x) => x.key === 'mGone'));

const j1Item = items.find((x) => x.key === 'j1');
const jGoneItem = items.find((x) => x.key === 'jGONE');
ok('列表内的活动能还原出来', !!j1Item);
ok('出了列表的活动靠快照保住，没消失', !!jGoneItem);
eq('出了列表的活动走了详情页', jGoneItem.url, '/sub/campus/event/event?id=jGONE');
eq('出了列表的活动标题来自快照', jGoneItem.title, 'C公司秋招宣讲会');
eq('出了列表的活动副标题来自快照', jGoneItem.desc, '11月3日 15:00 · 体育馆');
eq('出了列表的活动标了 gone', jGoneItem.gone, true);
eq('列表内的活动 gone 为 false', j1Item.gone, false);
eq('列表内的活动副标题来自活动本身', j1Item.desc, '10月20日 14:00 · 图书馆报告厅');

// 类型标签
eq('帖子标签正确', items.find((x) => x.key === 'p1').typeLabel, '帖子');
eq('活动标签正确', j1Item.typeLabel, '招聘会');

// 五个页签
eq('页签共 5 个', Object.keys(fp.data.tabMap).length, 5);
ok('页签含 event', 'event' in fp.data.tabMap);

// 切到「招聘会」这一档只剩活动
fp.onTab({ currentTarget: { dataset: { k: 'event' } } });
eq('切到招聘会档只剩 2 条', fp.data.items.length, 2);
ok('招聘会档里没有帖子', !fp.data.items.some((x) => x.type === 'post'));
eq('切档后 tabMap.event 为真', fp.data.tabMap.event, true);
eq('切档后 tabMap.all 为假', fp.data.tabMap.all, false);

// 切回全部
fp.onTab({ currentTarget: { dataset: { k: 'all' } } });
eq('切回全部又有 3 条', fp.data.items.length, 3);

// 页面里不能留「type === 'market' ? ... : ...」这种套三元
const favWxml = fs.readFileSync(path.join(APP, 'sub', 'mine', 'favorites', 'favorites.wxml'), 'utf8');
ok('收藏页模板没有套三元标签', favWxml.indexOf("item.type === 'market'") < 0);

/* ============ ④ 两处入口的状态必须一致 ============ */

// 校园页和详情页都调 store 的同一个 type，收藏一次两处都要变
ok('校园页用 event 类型', campusSrc.indexOf("type: 'event'") > 0);
const detailSrc = fs.readFileSync(path.join(APP, 'sub', 'campus', 'event', 'event.js'), 'utf8');
ok('详情页也用 event 类型', detailSrc.indexOf("type: 'event'") > 0);
ok('校园页收藏后只改这一张卡的字段', campusSrc.indexOf(".favorited']: !!r.favorited") > 0);

const campusWxml = fs.readFileSync(path.join(APP, 'pages', 'campus', 'campus.wxml'), 'utf8');
ok('卡片上的收藏按钮只挂在 jobfair 上', campusWxml.indexOf("wx:if=\"{{item.type === 'jobfair'}}\"\n              class=\"ev__fav") > 0);
const detailWxml = fs.readFileSync(path.join(APP, 'sub', 'campus', 'event', 'event.wxml'), 'utf8');
ok('详情页收藏按钮只挂在 jobfair 上', detailWxml.indexOf("wx:if=\"{{ev.type === 'jobfair'}}\"") > 0);

// 界面上不能再有「加进校历」的入口或文案 —— 那是已经否掉的方案。
// 只扫 wxml：campus.js 的注释里要解释「为什么不做成加进校历」，那是给后来人看的
// 决策记录，出现在界面上才会误导人以为这功能存在。
const uiSrc = [
  'pages/campus/campus.wxml',
  'sub/campus/event/event.wxml',
  'sub/mine/favorites/favorites.wxml'
].map((p) => fs.readFileSync(path.join(APP, p), 'utf8')).join('\n');
ok('界面上没有残留的「加进校历」文案', uiSrc.indexOf('加进校历') < 0 && uiSrc.indexOf('写入校历') < 0);

// 但决策本身要在代码里留痕，否则以后有人会再提一遍同样的需求
ok('campus.js 留了为什么不做校历的记录', campusSrc.indexOf('加进校历') > 0);

/* ---------------- 汇总 ---------------- */

console.log('通过 ' + pass + ' 项');
if (fails.length) {
  console.log('\n失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('全部通过');
})();
