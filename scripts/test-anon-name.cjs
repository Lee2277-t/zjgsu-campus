/* 匿名代号：同一个人发的多条匿名帖，不能被串成一个人
 *
 * 改之前代号是 `'匿名·' + openid.slice(-4)` —— 一个账号一个固定名字。
 * 后果不是「被认出真名」，而是**被串联**：看两条就知道「这人又发了」，
 * 「这两条是同一个人写的」。匿名只剩「不知道真名」，等于把人发过什么全交代了。
 *
 * 现在代号按**帖子 id** 的哈希取，于是有两个必须同时成立的性质：
 *   ① 同一条帖子永远同一个名字（刷新、换设备都不变，不落库也稳）
 *   ② 不同帖子名字不同（跨帖串不起来）
 *
 * ① 一旦破（用 Math.random）：每次进页面换个名字，读者连「刚才那条」都对不上；
 * ② 一旦破（按 openid 取名）：回到改造前。
 * 这两条都不是肉眼能看出来的，所以钉在这里。
 *
 * 用法：node scripts/test-anon-name.cjs
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');

// 仓库根 package.json 是 type:module，Node 22 会把小程序 .js 当 ESM —— 强制回 CommonJS
const origJs = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (norm(filename).startsWith(norm(PROJ))) return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return origJs(mod, filename);
};

/* ---------------- wx 桩 ---------------- */
const MEM = {};
const noop = () => undefined;
const chain = (() => {
  const c = {};
  ['collection', 'doc', 'where', 'orderBy', 'limit', 'field', 'skip'].forEach((m) => { c[m] = () => c; });
  c.get = () => Promise.resolve({ data: [] });
  c.add = () => Promise.resolve({ _id: 'x' });
  c.update = () => Promise.resolve({});
  c.remove = () => Promise.resolve({});
  c.count = () => Promise.resolve({ total: 0 });
  c.set = () => Promise.resolve({});
  return c;
})();
const wxBase = {
  getStorageSync: (k) => (k in MEM ? MEM[k] : ''),
  setStorageSync: (k, v) => { MEM[k] = v; },
  removeStorageSync: (k) => { delete MEM[k]; },
  showToast: noop, showModal: noop, showLoading: noop, hideLoading: noop,
  showActionSheet: noop, previewImage: noop, hideKeyboard: noop,
  setNavigationBarTitle: noop, setNavigationBarColor: noop,
  navigateTo: noop, redirectTo: noop,
  getSystemInfoSync: () => ({}), getWindowInfo: () => ({}),
  vibrateShort: noop,
  cloud: { init: noop, database: () => chain, callFunction: () => Promise.resolve({ result: { ok: true, openid: 'mock-me' } }) }
};
global.wx = new Proxy(wxBase, { get: (t, k) => (k in t ? t[k] : noop) });
global.getApp = () => ({ globalData: {} });
global.getCurrentPages = () => [{ route: 'pages/forum/list/list', options: {} }];
global.Page = noop;
global.Component = noop;
global.App = noop;

let pass = 0; let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fail += 1;
  console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}

const base = require(path.join(PROJ, 'utils', 'store-base.js'));
const forum = require(path.join(PROJ, 'utils', 'store-forum.js'));
const cloudMod = require(path.join(PROJ, 'utils', 'cloud.js'));
// 关掉云端：这里测的是展示层的取名规则，云端掺进来会把权威值盖回去
cloudMod.cfg.USE_CLOUD = false;

const SRC = fs.readFileSync(path.join(PROJ, 'utils', 'store-forum.js'), 'utf8');

function mkPost(id, oid, anon, board) {
  return {
    id: id,
    board: board || '闲聊',
    title: '标题' + id,
    content: '正文',
    author: '真名同学',
    authorOpenid: oid,
    openid: oid,
    images: [],
    likes: 0,
    dislikes: 0,
    comments: [],
    commentCount: 0,
    at: Date.parse('2026-10-18 10:00') || 1,
    time: '2026-10-18 10:00',
    anonymous: !!anon,
    status: 'normal'
  };
}
const seed = (list) => { MEM[base.KEYS.posts] = list; };
const nameOf = (id) => {
  const p = forum.getPostById(id);
  return p ? p.showAuthor : null;
};

/* ============ A. 同一条帖子，名字必须稳定 ============ */
console.log('A. 同一条帖子名字稳定（不能每次渲染换一个）');
seed([mkPost('pA', 'oABCD', true)]);
const n1 = nameOf('pA');
const n2 = nameOf('pA');
const n3 = forum.getPosts({}).find((p) => p.id === 'pA').showAuthor;
ok('两次直取同名', !!n1 && n1 === n2, { n1, n2 });
ok('列表与详情同名', n1 === n3, { n1, n3 });
ok('形状是「匿名·中文词」', /^匿名·[\u4e00-\u9fa5]{2,3}$/.test(String(n1)), n1);

/* ============ B. 同一个人的多条帖子，名字必须分散 ============ */
console.log('B. 同一个账号的 12 条匿名帖，名字要分散（旧的固定名字会全部相同）');
const sameIds = [];
for (let i = 0; i < 12; i += 1) sameIds.push('same' + i);
seed(sameIds.map((id) => mkPost(id, 'oSAMEACCOUNT', true)));
const names = forum.getPosts({}).map((p) => p.showAuthor);
const uniq = new Set(names);
ok('12 条里至少 10 种不同名字', uniq.size >= 10, { 不同名字数: uniq.size, names });
ok('没有任何一条叫「匿名·SAME」这种 openid 片段',
  names.every((n) => !n.includes('SAME') && !n.includes('ACCO')), names);
ok('代号不再含 openid 后四位', names.every((n) => !/^匿名·[A-Za-z0-9]{4}$/.test(n)), names);

/* ============ C. 非匿名帖不受影响 ============ */
console.log('C. 非匿名帖照常显示昵称');
seed([mkPost('pN', 'oABCD', false)]);
ok('非匿名帖显示真名', nameOf('pN') === '真名同学', nameOf('pN'));

/* ============ D. 树洞帖同一条链路 ============ */
console.log('D. 树洞帖（发帖时固定 anonymous:true）同样按帖子取名');
seed([mkPost('pH1', 'oSAMEACCOUNT', true, '树洞'), mkPost('pH2', 'oSAMEACCOUNT', true, '树洞')]);
const holes = forum.getPosts({ hole: true });
ok('树洞页拿得到两条', holes.length === 2, holes.length);
ok('两条树洞帖名字不同（同一账号）', holes[0].showAuthor !== holes[1].showAuthor,
  holes.map((p) => p.showAuthor));

/* ============ E. 词池本身 ============ */
console.log('E. 词池规模与实现方式');
const seg = SRC.match(/const ANON_WORDS = \[([\s\S]*?)\n\];/);
const pool = seg ? (seg[1].match(/'[^']+'/g) || []).map((s) => s.slice(1, -1)) : [];
ok('词池解析得到 >= 100 个词', pool.length >= 100, pool.length);
ok('词池没有重复', new Set(pool).size === pool.length, { 总数: pool.length, 去重: new Set(pool).size });
ok('每个词都是 2–3 个汉字', pool.every((w) => /^[\u4e00-\u9fa5]{2,3}$/.test(w)));
// 静态钉住实现方式：一旦有人改回「按 openid 取名」或换成 Math.random，这里立刻红
ok('代号按帖子 id 取（不是 openid）',
  /anonCodeOf\(p\.id/.test(SRC) || /ANON_WORDS\[hashStr\(p\.id/.test(SRC));
ok('没有残留「取 openid 后四位」的旧写法', !/const tail = String\(oid\)\.slice\(-4\)/.test(SRC));
ok('没有用 Math.random 取名（那会让同一条帖子每次换名字）',
  !/ANON_WORDS\[[^\]]*Math\.random/.test(SRC));

/* ============ 汇总 ============ */
console.log('');
if (fail) {
  console.log('✗ test-anon-name: ' + fail + ' 项失败 / ' + (pass + fail) + ' 项');
  process.exit(1);
}
console.log('✓ test-anon-name: ' + pass + ' 项全部通过');
