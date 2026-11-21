/* 匿名帖的评论区：整帖匿名，不是只有主贴匿名
 *
 * 改之前只有 `decoratePost` 换了作者名，`decorateComments` 一点没动：
 * 留言的 author / avatarUrl / replyToAuthor 全是原样透传。于是有三条漏路：
 *
 *   ① 楼主在自己匿名帖下回一句「补充一下」，昵称一露 —— 前面那串代号全白取；
 *   ② 别人实名留言，等于在一个匿名话题下被挨个点名；
 *   ③ 点头像能进名片页（真名 + 他发过的所有帖子），名字换了、门还开着。
 *
 * 现在：评论区的昵称与头像按 openid 换成代号，楼主用主贴那个代号，
 * 名片入口整个收掉；云端 commentList 在下发前就把真名摘掉 ——
 * 前端换代号只是「遮住屏幕」，真名还在响应体里，抓包一看就有。
 *
 * 用法：node scripts/test-anon-comment.cjs
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');
const readProj = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8');
const readCloudSource = require('./cloud-source.cjs');

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
global.getCurrentPages = () => [{ route: 'sub/forum/detail/detail', options: {} }];
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
cloudMod.cfg.USE_CLOUD = false;

const SRC = readProj('utils/store-forum.js');
const CF = readCloudSource();
const DETAIL_WXML = readProj('sub/forum/detail/detail.wxml');
const DETAIL_JS = readProj('sub/forum/detail/detail.js');

// 一条留言：author 是真名 —— 库里存的就是真名（审核、申诉要用）
function mkComment(id, oid, opts) {
  const o = opts || {};
  return {
    id: id,
    author: '真名' + oid,
    avatarUrl: 'https://x/' + oid + '.png',
    authorOpenid: oid,
    content: '内容' + id,
    parentId: o.parentId || '',
    depth: o.depth || 0,
    replyToOpenid: o.replyToOpenid || '',
    replyToAuthor: o.replyToAuthor || '',
    likes: 0,
    dislikes: 0,
    images: [],
    removed: false,
    time: '2026-10-18 10:00',
    at: Date.parse('2026-10-18 10:00') || 1
  };
}

function mkPost(id, oid, anon, board, comments) {
  return {
    id: id,
    board: board || '闲聊',
    title: '标题' + id,
    content: '正文',
    author: '楼主真名',
    authorOpenid: oid,
    openid: oid,
    images: [],
    likes: 0,
    dislikes: 0,
    comments: comments || [],
    commentCount: (comments || []).length,
    at: Date.parse('2026-10-18 10:00') || 1,
    time: '2026-10-18 10:00',
    anonymous: !!anon,
    status: 'normal'
  };
}
const seed = (list) => { MEM[base.KEYS.posts] = list; };

// 走真实链路：getPostById → decorateComments（详情页就是这么拿数据的）
function view(id) {
  const p = forum.getPostById(id);
  if (!p) return null;
  return forum.decorateComments(p, false, {});
}
const cm = (post, id) => ((post && post.comments) || []).find((c) => c.id === id);

/* ============ A. 楼主在评论区用主贴那个代号 ============ */
console.log('A. 楼主回复自己的匿名帖，代号必须和主贴一致');
seed([mkPost('pA', 'oPOSTER', true, '树洞', [
  mkComment('c1', 'oPOSTER')
])]);
const vA = view('pA');
ok('主贴有代号', /^匿名·/.test(String(vA.showAuthor)), vA.showAuthor);
ok('楼主留言用同一个代号', cm(vA, 'c1').author === vA.showAuthor,
  { 留言: cm(vA, 'c1').author, 主贴: vA.showAuthor });
ok('楼主留言不显示真名', cm(vA, 'c1').author !== '真名oPOSTER', cm(vA, 'c1').author);

/* ============ B. 其他留言者：代号，不是真名 ============ */
console.log('B. 别人在这条匿名帖下留言，也不能露真名');
seed([mkPost('pB', 'oPOSTER', true, '树洞', [
  mkComment('c1', 'oPOSTER'),
  mkComment('c2', 'oGUEST1'),
  mkComment('c3', 'oGUEST2')
])]);
const vB = view('pB');
ok('三个人的名字都是代号',
  ['c1', 'c2', 'c3'].every((id) => /^匿名·[\u4e00-\u9fa5]{2,3}$/.test(String(cm(vB, id).author))),
  ['c1', 'c2', 'c3'].map((id) => cm(vB, id).author));
ok('没有任何一条叫「真名…」',
  ['c1', 'c2', 'c3'].every((id) => !String(cm(vB, id).author).includes('真名')));
ok('楼主代号与其他人不同（能分清谁是谁）',
  cm(vB, 'c1').author !== cm(vB, 'c2').author,
  { 楼主: cm(vB, 'c1').author, 客人: cm(vB, 'c2').author });

/* ============ C. 同帖内稳定、跨帖串不起来 ============ */
console.log('C. 同一帖内同名（能对话），跨帖不同名（串不起来）');
seed([
  mkPost('pC1', 'oPOSTER', true, '树洞', [
    mkComment('x1', 'oGUEST'),
    mkComment('x2', 'oGUEST'),
    mkComment('x3', 'oGUEST', { parentId: 'x1', depth: 1, replyToOpenid: 'oGUEST' })
  ]),
  mkPost('pC2', 'oPOSTER', true, '树洞', [mkComment('y1', 'oGUEST')])
]);
const vC1 = view('pC1');
const vC2 = view('pC2');
ok('同一个人的两条留言同名', cm(vC1, 'x1').author === cm(vC1, 'x2').author,
  { x1: cm(vC1, 'x1').author, x2: cm(vC1, 'x2').author });
ok('同一个人的回复也同名', cm(vC1, 'x3').author === cm(vC1, 'x1').author,
  { x3: cm(vC1, 'x3').author, x1: cm(vC1, 'x1').author });
ok('换个帖子就换名字（跨帖串不起来）',
  cm(vC1, 'x1').author !== cm(vC2, 'y1').author,
  { pC1: cm(vC1, 'x1').author, pC2: cm(vC2, 'y1').author });

/* ============ D. 头像与名片入口 ============ */
console.log('D. 头像不显示、头像点不进名片');
ok('showAvatar 为空', cm(vB, 'c2').showAvatar === '', cm(vB, 'c2').showAvatar);
ok('文字头像固定「匿」', cm(vB, 'c2').avatarText === '匿', cm(vB, 'c2').avatarText);
ok('canProfile 为假（名片入口收掉）', cm(vB, 'c2').canProfile === false, cm(vB, 'c2').canProfile);
ok('openid 仍然保留（判断「我的留言」「举报」「删除」都要它）',
  cm(vB, 'c2').authorOpenid === 'oGUEST1', cm(vB, 'c2').authorOpenid);

/* ============ E. 「回复 @某某」不能把真名带出来 ============ */
console.log('E. 回复链里的名字同样是代号');
seed([mkPost('pE', 'oPOSTER', true, '树洞', [
  mkComment('e1', 'oPOSTER'),
  mkComment('e2', 'oGUEST'),
  // 回复楼主：replyToAuthor 在库里是真名，展示时必须换成主贴代号
  mkComment('e3', 'oGUEST2', { parentId: 'e1', depth: 1, replyToOpenid: 'oPOSTER', replyToAuthor: '楼主真名' }),
  // 回复普通留言者
  mkComment('e4', 'oGUEST3', { parentId: 'e2', depth: 1, replyToOpenid: 'oGUEST', replyToAuthor: '真名oGUEST' }),
  // 回复的人不在这批留言里（列表只拉到前 200 条）
  mkComment('e5', 'oGUEST4', { parentId: 'e2', depth: 1, replyToOpenid: 'oGONE', replyToAuthor: '真名oGONE' })
])]);
const vE = view('pE');
ok('回复楼主 → 写主贴代号', cm(vE, 'e3').replyToName === vE.showAuthor,
  { 显示: cm(vE, 'e3').replyToName, 主贴: vE.showAuthor });
ok('回复楼主 → 不是真名', cm(vE, 'e3').replyToName !== '楼主真名');
ok('回复普通留言者 → 写对方的代号', cm(vE, 'e4').replyToName === cm(vE, 'e2').author,
  { 显示: cm(vE, 'e4').replyToName, 对方: cm(vE, 'e2').author });
ok('回复的人查不到 → 中性称呼，不退回真名',
  cm(vE, 'e5').replyToName === '匿名同学' && !String(cm(vE, 'e5').replyToName).includes('oGONE'),
  cm(vE, 'e5').replyToName);

/* ============ F. 非匿名帖一点不受影响 ============ */
console.log('F. 非匿名帖照常显示真名与头像');
seed([mkPost('pN', 'oPOSTER', false, '闲聊', [
  mkComment('n1', 'oGUEST'),
  mkComment('n2', 'oGUEST2', { parentId: 'n1', depth: 1, replyToOpenid: 'oGUEST', replyToAuthor: '真名oGUEST' })
])]);
const vN = view('pN');
ok('留言照常显示昵称', cm(vN, 'n1').author === '真名oGUEST', cm(vN, 'n1').author);
ok('头像照常显示', cm(vN, 'n1').showAvatar !== '', cm(vN, 'n1').showAvatar);
ok('名片入口照常可用', cm(vN, 'n1').canProfile === true, cm(vN, 'n1').canProfile);
ok('「回复 @某某」照常写真名', cm(vN, 'n2').replyToName === '真名oGUEST', cm(vN, 'n2').replyToName);

/* ============ G. 匿名口径：字段为真 或 发在树洞板块 ============ */
console.log('G. 匿名判定不只看 anonymous 字段');
seed([
  // 树洞帖但字段丢了（历史数据 / 迁移遗漏）：仍然按匿名处理
  mkPost('pG', 'oPOSTER', false, '树洞', [mkComment('g1', 'oGUEST')])
]);
const vG = view('pG');
ok('树洞板块即使字段为假也匿名', cm(vG, 'g1').author !== '真名oGUEST', cm(vG, 'g1').author);
ok('isAnonPost 导出且认板块', typeof forum.isAnonPost === 'function'
  && forum.isAnonPost({ board: '树洞' }) === true
  && forum.isAnonPost({ anonymous: true }) === true
  && forum.isAnonPost({ board: '闲聊' }) === false);

/* ============ H. 云端脱敏：真名不出库 ============ */
console.log('H. 云端 commentList 下发前摘掉真名');
const listFn = (CF.match(/async function commentList[\s\S]*?\n}/) || [''])[0];
ok('commentList 有匿名字段判定', /const anon = !!post\.anonymous \|\| String\(post\.board \|\| ''\) === ANON_BOARD/.test(listFn));
ok('匿名时走脱敏', /anon \? maskAnonComments\(list\) : list/.test(listFn));
const maskFn = (CF.match(/function maskAnonComments[\s\S]*?\n}/) || [''])[0];
ok('脱敏函数存在', !!maskFn, maskFn.slice(0, 40));
ok('清昵称', /author: ''/.test(maskFn));
ok('清头像', /avatarUrl: ''/.test(maskFn));
ok('清「回复 @某某」里的真名（漏这条前两条等于白清）', /replyToAuthor: ''/.test(maskFn));

/* ============ I. 页面：模板与事件两道闸 ============ */
console.log('I. 名片入口两处都要拦');
ok('一级留言头像按 canProfile 判定', /comment__ava \{\{c\.canProfile \? 'tap' : ''\}\}/.test(DETAIL_WXML));
ok('二级回复头像按 canProfile 判定', /reply__ava \{\{r\.canProfile \? 'tap' : ''\}\}/.test(DETAIL_WXML));
ok('不再用「有 openid 就能点」的老条件',
  !/comment__ava \{\{\(c\.authorOpenid \|\| c\.mine\)/.test(DETAIL_WXML)
  && !/reply__ava \{\{\(r\.authorOpenid \|\| r\.mine\)/.test(DETAIL_WXML));
ok('goCommenter 里有匿名拦截', /goCommenter\(e\) \{[\s\S]{0,400}isAnonPost\(this\.data\.post\)/.test(DETAIL_JS));
// detail.js 调的是 store.isAnonPost（聚合入口），store-forum 导出了不代表聚合层也有
ok('store 聚合入口也导出了 isAnonPost',
  typeof require(path.join(PROJ, 'utils', 'store.js')).isAnonPost === 'function');

/* ============ J. 没有留下「按 openid 取名」的老写法 ============ */
console.log('J. 取名口径没有被退回去');
ok('代号统一走 anonCodeOf', /function anonCodeOf\(nameSeed\)/.test(SRC));
ok('评论区的名字不是直接透传 c.author',
  !/author: c\.author,/.test(SRC));
ok('评论区的回复名不是直接透传 replyToAuthor',
  !/replyToName: String\(c\.replyToAuthor \|\| ''\),/.test(SRC));
ok('没有按 openid 取名（那会让一个人所有匿名内容串起来）',
  !/anonCodeOf\(String\(c\.authorOpenid/.test(SRC));

/* ============ 汇总 ============ */
console.log('');
if (fail) {
  console.log('✗ test-anon-comment: ' + fail + ' 项失败 / ' + (pass + fail) + ' 项');
  process.exit(1);
}
console.log('✓ test-anon-comment: ' + pass + ' 项全部通过');
