/* 帖子详情「头像 + 名字」行为测试
 *
 * 四组，全部跑真实源码，不另抄一份逻辑：
 *   A. 云函数 safeAvatar —— 花括号配平从 cloudfunctions/user/index.js 里抽出来跑（安全边界）
 *   B. 页面 decorateComments —— 同上，从 sub/forum/detail/detail.js 抽
 *   C. decoratePost —— 直接加载真实 utils/store-forum.js（喂真实本地存储）
 *   D. 页面事件处理 —— 用 check-page-load 那套 Page() 捕获 + 假 this 调用
 *
 * 用法：node scripts/test-byline.cjs
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

// ---- wx 桩 ----
const MEM = {};
const NAVS = [];
const noop = () => undefined;
const chain = (() => {
  const c = {};
  ['collection', 'doc', 'where', 'orderBy', 'limit', 'field', 'skip'].forEach((m) => { c[m] = () => c; });
  c.get = () => Promise.resolve({ data: [] });
  c.add = () => Promise.resolve({ _id: 'x' });
  c.update = () => Promise.resolve({});
  c.remove = () => Promise.resolve({});
  c.count = () => Promise.resolve({ total: 0 });
  return c;
})();
const wxBase = {
  getStorageSync: (k) => (k in MEM ? MEM[k] : ''),
  setStorageSync: (k, v) => { MEM[k] = v; },
  removeStorageSync: (k) => { delete MEM[k]; },
  showToast: noop, showModal: noop, showLoading: noop, hideLoading: noop,
  setNavigationBarTitle: noop, setNavigationBarColor: noop,
  navigateTo: (o) => { NAVS.push(String((o && o.url) || '')); },
  redirectTo: (o) => { NAVS.push(String((o && o.url) || '')); },
  getSystemInfoSync: () => ({}),
  getWindowInfo: () => ({}),
  cloud: { init: noop, database: () => chain, callFunction: () => Promise.resolve({ result: { ok: true, openid: 'mock-me' } }) }
};
global.wx = new Proxy(wxBase, { get: (t, k) => (k in t ? t[k] : noop) });
global.getApp = () => ({ globalData: {} });
global.getCurrentPages = () => [{ route: 'sub/forum/detail/detail', options: { id: 'p1' } }];
let CAPTURED = null;
global.Page = (o) => { CAPTURED = o; };
global.Component = noop;
global.App = noop;

let pass = 0; let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; } else { fail += 1; console.log('  x ' + name); }
}

// ---- 花括号配平抽函数（跳过字符串 / 模板串 / 注释）----
function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('找不到函数 ' + name);
  const start = src.indexOf('{', at);
  let depth = 0; let q = '';
  let i = start;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (q) {
      if (ch === q && src[i - 1] !== '\\') q = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 1; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return src.slice(at, i);
}

/* ============ A. 云函数 safeAvatar（安全边界） ============ */
console.log('A. 云函数 safeAvatar / isCloudFileIn');
const readCloudSource = require('./cloud-source.cjs');
const cloudSrc = readCloudSource();
const maxDecl = (cloudSrc.match(/const FILEID_MAX\s*=\s*\d+;/) || [''])[0];
if (!maxDecl) throw new Error('没抽到 FILEID_MAX');
const cloudFns = new Function(
  maxDecl + '\n'
  + extractFn(cloudSrc, 'isCloudFileIn') + '\n'
  + extractFn(cloudSrc, 'safeAvatar') + '\n'
  + 'return { safeAvatar: safeAvatar };'
)();
const S = cloudFns.safeAvatar;
const GOOD = 'cloud://cloud1-abc.636c-cloud1-abc-1309829868/avatars/onXs_1729.jpg';
ok('接受 avatars/ 下的云文件', S(GOOD) === GOOD);
ok('两端空白会 trim', S('  ' + GOOD + '  ') === GOOD);
ok('空值 → 空串', S('') === '' && S(undefined) === '' && S(null) === '');
ok('拒绝 http 外链（站外图床入口）', S('http://evil.com/a.jpg') === '');
ok('拒绝 https 外链', S('https://evil.com/a.jpg') === '');
ok('拒绝本机临时路径', S('wxfile://tmp_abc.jpg') === '' && S('http://tmp/a.jpg') === '');
ok('拒绝别的目录（跨业务越权）', S(GOOD.replace('/avatars/', '/chat/')) === '');
ok('拒绝文件名带空格', S(GOOD.replace('.jpg', ' b.jpg')) === '');
ok('拒绝段数不对', S('cloud://e.b/avatars/a/b.jpg') === '');
ok('拒绝超长 fileID', S('cloud://e.b/avatars/' + 'x'.repeat(600) + '.jpg') === '');

/* ============ B. 留言装饰 decorateComments ============ */
// 这个函数原本写在页面里，加进赞踩 / 举报状态 / 二级回复之后搬到了数据层 ——
// 它成了四个功能的公共出口，留在页面里就只能靠「抽源码」测，
// 而它依赖的同文件函数会越抽越多。现在直接 require 真实模块跑
console.log('B. 留言装饰 decorateComments');
const forumB = require(path.join(PROJ, 'utils', 'store-forum.js'));
const out = forumB.decorateComments({
  id: 'p1',
  comments: [
    { id: 'c1', author: 'zako', avatarUrl: 'cloud://e.b/avatars/a.jpg', authorOpenid: 'o1' },
    { id: 'c2', author: '匿名用户' },
    { id: 'c3', author: '', _openid: 'o3' }
  ]
}, false);
const [c1, c2, c3] = out.comments;
ok('有头像 → showAvatar 透传', c1.showAvatar === 'cloud://e.b/avatars/a.jpg');
ok('文字头像取名字首字', c1.avatarText === 'z');
ok('avaErr 初始为 false（还没加载失败）', c1.avaErr === false);
ok('无头像 → showAvatar 空串（走文字头像）', c2.showAvatar === '');
ok('无头像照样有文字头像', c2.avatarText === '匿');
ok('缺 authorOpenid → 归一成空串', c2.authorOpenid === '');
ok('老留言 _openid 归一成 authorOpenid', c3.authorOpenid === 'o3');
ok('名字缺失 → 文字头像兜底「浙」', c3.avatarText === '浙');
ok('images 缺失补成数组', Array.isArray(c1.images) && c1.images.length === 0);

/* ============ C. decoratePost（真实模块） ============ */
console.log('C. decoratePost（匿名 / 普通 / 老帖）');
const base = require(path.join(PROJ, 'utils', 'store-base.js'));
const forum = require(path.join(PROJ, 'utils', 'store-forum.js'));
const seed = (id, extra) => Object.assign({
  id: id, board: '闲聊', title: 't' + id, content: 'c', author: '默认名',
  images: [], comments: [], likes: 0, dislikes: 0, at: Date.now(), time: '2026-10-16'
}, extra);
MEM[base.KEYS.posts] = [
  seed('p-anon', { board: '树洞', author: '真名同学', authorOpenid: 'oA', anonymous: true, avatarUrl: 'cloud://e.b/avatars/a.jpg' }),
  seed('p-normal', { author: 'zako', authorOpenid: 'oB', avatarUrl: 'cloud://e.b/avatars/b.jpg' }),
  seed('p-old', { author: '老王', authorOpenid: 'oC' })
];
const anon = forum.getPostById('p-anon');
ok('匿名帖：头像留空（走默认头像）', anon.showAvatar === '');
ok('匿名帖：名字是代号而不是真名', /^匿名/.test(anon.showAuthor) && anon.showAuthor.indexOf('真名同学') < 0);
ok('匿名帖：文字头像固定「匿」', anon.avatarText === '匿');
const normal = forum.getPostById('p-normal');
ok('普通帖：头像透传', normal.showAvatar === 'cloud://e.b/avatars/b.jpg');
ok('普通帖：名字是真昵称', normal.showAuthor === 'zako');
ok('普通帖：文字头像取首字', normal.avatarText === 'z');
const old = forum.getPostById('p-old');
ok('老帖无 avatarUrl → 头像兜底为空', old.showAvatar === '');
ok('老帖仍有文字头像可用', old.avatarText === '老');

/* ============ D. 页面事件（兜底 / 跳转） ============ */
console.log('D. 页面事件处理');
require(path.join(PROJ, 'sub', 'forum', 'detail', 'detail.js'));
ok('页面加载成功并捕获到 Page', !!CAPTURED && typeof CAPTURED.onCommentAvatarError === 'function');

function makeCtx() {
  return {
    // 留言区现在是两层：avatar 失败要写的是 commentTree 上那条
    // （树上的节点是副本，写到扁平 comments 上界面不会动）
    data: {
      postAvatarFailed: false,
      post: {
        commentTree: [
          { avaErr: false, replies: [{ avaErr: false }, { avaErr: false }, { avaErr: false }] },
          { avaErr: false, replies: [] }
        ]
      }
    },
    setData(o) {
      Object.keys(o).forEach((k) => {
        const keys = k.replace(/\[(\d+)\]/g, '.$1').split('.');
        let cur = this.data;
        for (let i = 0; i < keys.length - 1; i += 1) cur = cur[keys[i]];
        cur[keys[keys.length - 1]] = o[k];
      });
    }
  };
}
const a = makeCtx();
CAPTURED.onPostAvatarError.call(a);
ok('帖子头像加载失败 → 切文字头像', a.data.postAvatarFailed === true);
CAPTURED.onPostAvatarError.call(a);
ok('重复 error 不出问题', a.data.postAvatarFailed === true);

const b = makeCtx();
CAPTURED.onCommentAvatarError.call(b, { currentTarget: { dataset: { p: 1 } } });
ok('某条留言头像失败 → 只标它自己',
  b.data.post.commentTree[1].avaErr === true && b.data.post.commentTree[0].avaErr === false);
// 二级回复：data-r 有值就往 replies 里写
CAPTURED.onCommentAvatarError.call(b, { currentTarget: { dataset: { p: 0, r: 2 } } });
ok('二级回复头像失败 → 标的是它自己那条回复',
  b.data.post.commentTree[0].replies[2].avaErr === true
  && b.data.post.commentTree[0].replies[0].avaErr === false
  && b.data.post.commentTree[0].avaErr === false);
CAPTURED.onCommentAvatarError.call(b, { currentTarget: { dataset: {} } });
ok('下标缺失不炸', b.data.post.commentTree[1].avaErr === true);

const d = makeCtx();
CAPTURED.goCommenter.call(d, { currentTarget: { dataset: { openid: 'o9' } } });
ok('点评论者头像 → 进 TA 的名片页', NAVS.indexOf('/pages/user/card/card?openid=o9') >= 0);
const before = NAVS.length;
CAPTURED.goCommenter.call(d, { currentTarget: { dataset: {} } });
ok('没有 openid → 静默不跳转', NAVS.length === before);
const before2 = NAVS.length;
CAPTURED.goAuthor.call(d, { currentTarget: { dataset: { openid: 'oA' } } });
ok('帖子作者入口 → 同一个名片落点', NAVS.length === before2 + 1 && NAVS[NAVS.length - 1] === '/pages/user/card/card?openid=oA');

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
