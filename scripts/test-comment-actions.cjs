/* 评论区四项交互行为测试
 *
 * 覆盖本轮加进评论区的四件事里**最容易在真机上坏、又最难靠肉眼发现**的部分：
 *   A. 赞踩互斥 / 可取消 / 计数不漂移 / 连点只算一次
 *   B. 回复层级：三级照旧挂在二级下面、四级折回三级、父不存在退化成一级
 *      （前后端两份算法同构）
 *   C. 树与折叠：二三级回复并列在同一层、父被删的回复不能凭空消失
 *   D. 删父连子：不留「回复 @某某」却找不到原话的孤儿
 *   E. 举报处理状态：pending / confirmed / rejected 三种人话
 *   F. 云端那段 commentVote 的关键三行还在（记名 upsert / 数人头 / 降级）
 *   G. 页面事件：回复目标、展开折叠、缺参数不炸
 *
 * 全部跑真实源码（utils/store-forum.js、sub/forum/detail/detail.js、
 * cloudfunctions/user/index.js），不另抄一份逻辑。
 *
 * 用法：node scripts/test-comment-actions.cjs
 */
const path = require('path');
const readCloudSource = require('./cloud-source.cjs');
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
global.getCurrentPages = () => [{ route: 'sub/forum/detail/detail', options: { id: 'p1' } }];
let CAPTURED = null;
global.Page = (o) => { CAPTURED = o; };
global.Component = noop;
global.App = noop;

let pass = 0; let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fail += 1;
  console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 赞踩的连点闸是 350ms，测试要「真的等过它」才测得到下一次点击
const THROTTLE_WAIT = 420;

(async function main() {
  const base = require(path.join(PROJ, 'utils', 'store-base.js'));
  const forum = require(path.join(PROJ, 'utils', 'store-forum.js'));
  const cloudMod = require(path.join(PROJ, 'utils', 'cloud.js'));
  // 关掉云端：这一组测的是本地记账（互斥 / 取消 / 计数不漂移），
  // 让云端掺进来会把权威值写回基线，断言就不干净了
  cloudMod.cfg.USE_CLOUD = false;

  const seedPost = (comments) => {
    MEM[base.KEYS.posts] = [{
      id: 'p1', board: '闲聊', title: 't', content: 'c', author: 'me',
      authorOpenid: 'me', images: [], likes: 0, dislikes: 0,
      comments: comments, at: Date.now(), time: '2026-10-17'
    }];
  };
  const readComments = () => (MEM[base.KEYS.posts][0].comments || []);

  /* ============ A. 赞踩 ============ */
  console.log('A. 留言赞踩（互斥 / 取消 / 计数 / 连点）');
  seedPost([{ id: 'c1', author: '别人', authorOpenid: 'o1', content: 'x', likes: 0, dislikes: 0, at: 1 }]);

  let r = forum.toggleCommentVote('p1', 'c1', 'like');
  ok('点赞 → liked，计数 1', r && r.liked === true && r.likes === 1 && r.dislikes === 0, r);

  r = forum.toggleCommentVote('p1', 'c1', 'like');
  ok('连点第二下被闸吃掉（不动数据）', !!r && r.throttled === true && r.likes === 1, r);

  await sleep(THROTTLE_WAIT);
  r = forum.toggleCommentVote('p1', 'c1', 'like');
  ok('再点一次同一个 = 取消', !!r && r.liked === false && r.likes === 0, r);

  await sleep(THROTTLE_WAIT);
  r = forum.toggleCommentVote('p1', 'c1', 'dislike');
  ok('点踩 → disliked', !!r && r.disliked === true && r.dislikes === 1 && r.likes === 0, r);

  await sleep(THROTTLE_WAIT);
  r = forum.toggleCommentVote('p1', 'c1', 'like');
  ok('赞踩互斥：换边后踩归零', !!r && r.liked === true && r.likes === 1 && r.dislikes === 0, r);

  // 计数漂移：服务端同步下来的权威值是 5，我这一票加上去是 6，取消回 5。
  // 「点一次 +1」那种写法在这里最容易露馅 —— 基数被云端覆盖后数字会跳
  seedPost([{ id: 'c2', author: '别人', authorOpenid: 'o1', content: 'x', likes: 5, dislikes: 2, at: 1 }]);
  r = forum.toggleCommentVote('p1', 'c2', 'like');
  ok('云端基数 5 → 我赞上是 6（不是从 0 重来）', !!r && r.likes === 6 && r.dislikes === 2, r);
  await sleep(THROTTLE_WAIT);
  r = forum.toggleCommentVote('p1', 'c2', 'like');
  ok('取消后回到 5（计数没漂移）', !!r && r.likes === 5, r);
  await sleep(THROTTLE_WAIT);
  forum.toggleCommentVote('p1', 'c2', 'dislike');
  await sleep(THROTTLE_WAIT);
  forum.toggleCommentVote('p1', 'c2', 'like');
  await sleep(THROTTLE_WAIT);
  forum.toggleCommentVote('p1', 'c2', 'dislike');
  await sleep(THROTTLE_WAIT);
  forum.toggleCommentVote('p1', 'c2', 'like');
  const after = readComments().filter((c) => c.id === 'c2')[0];
  ok('来回换边四次后计数仍然对得上 6 / 2', after.likes === 6 && after.dislikes === 2, after);

  ok('留言不存在 → 返回 null（页面据此说「这条留言已经不在了」）',
    forum.toggleCommentVote('p1', 'nope', 'like') === null);

  /* ============ B. 回复层级 ============ */
  console.log('B. 回复层级（三级并列、四级折回）');
  const cs = [
    { id: 'a', depth: 0, parentId: '' },
    { id: 'b', depth: 1, parentId: 'a' },
    { id: 'c', depth: 2, parentId: 'b' }
  ];
  let t = forum.replyTargetOf(cs, 'a');
  ok('回复一级 → 挂在一级下，depth 1', t.parentId === 'a' && t.depth === 1, t);
  t = forum.replyTargetOf(cs, 'b');
  ok('回复二级 → 挂在二级下，depth 2（三级回复，展示时再拉平）',
    t.parentId === 'b' && t.depth === 2, t);
  t = forum.replyTargetOf(cs, 'c');
  ok('回复三级 → 折回二级（深度封顶），不再往上长', t.parentId === 'b' && t.depth === 2, t);
  t = forum.replyTargetOf(cs, 'zzz');
  ok('父不存在 → 退化成一级（不丢内容）', t.parentId === '' && t.depth === 0, t);
  t = forum.replyTargetOf(cs, '');
  ok('不带 parentId → 一级留言', t.parentId === '' && t.depth === 0, t);
  ok('层级上限常量前后端都是 2（改一边忘改另一边会两副面孔）',
    forum.REPLY_MAX_DEPTH === 2, { v: forum.REPLY_MAX_DEPTH });

  // addComment 带回复：层级在数据层就定好，乐观显示的那条和云端回来的一样
  seedPost(cs.slice());
  const added = forum.addComment('p1', '群满了', [], {
    parentId: 'b', replyToOpenid: 'oB', replyToAuthor: '小明'
  });
  ok('回复二级留言：挂载点就是那条二级', added.comment.parentId === 'b', added.comment);
  ok('回复二级留言：深度是 2', added.comment.depth === 2, added.comment);
  ok('「回复的是谁」照旧记着被点的那个人', added.comment.replyToAuthor === '小明', added.comment);
  ok('新留言自带赞踩计数 0（和云端回执同构）',
    added.comment.likes === 0 && added.comment.dislikes === 0, added.comment);

  /* ============ C. 树与折叠（二三级并列） ============ */
  console.log('C. 树与折叠（二三级并列）');
  const many = [{ id: 'a', depth: 0, parentId: '' }];
  for (let i = 1; i <= 5; i += 1) many.push({ id: 'r' + i, depth: 1, parentId: 'a', replyToAuthor: 'a君' });
  many.push({ id: 'orphan', depth: 1, parentId: 'gone' });
  let dec = forum.decorateComments({ id: 'p1', comments: many }, false);
  ok('二级回复挂在父下面', dec.commentTree.length === 2 && dec.commentTree[0].replies.length === 5,
    dec.commentTree.map((n) => n.id + ':' + n.replies.length));
  ok('父被删的回复提升为一级（不凭空消失）', dec.commentTree[1].id === 'orphan', dec.commentTree[1]);
  ok('默认折叠：藏起 5-3=2 条', dec.commentTree[0].hiddenCount === 2, dec.commentTree[0]);
  ok('默认不展开（有隐藏项时）', dec.commentTree[0].expanded === false, dec.commentTree[0]);
  ok('总数单独给一份（折叠按钮要用）', dec.commentTree[0].replyCount === 5, dec.commentTree[0]);
  dec = forum.decorateComments({ id: 'p1', comments: many }, false, { a: true });
  ok('展开过的那条保持展开', dec.commentTree[0].expanded === true, dec.commentTree[0]);
  const few = forum.decorateComments({ id: 'p1', comments: [{ id: 'a', depth: 0, parentId: '' }, { id: 'r1', depth: 1, parentId: 'a' }] }, false);
  ok('回复没超过预览条数 → 永远展开（不冒出「展开 0 条」）',
    few.commentTree[0].hiddenCount === 0 && few.commentTree[0].expanded === true, few.commentTree[0]);
  ok('「回复 @某某」的展示名单独存（折叠后不能靠 parentId 反查）',
    dec.commentTree[0].replies[0].replyToName === 'a君', dec.commentTree[0].replies[0]);

  // 三级回复（depth 2，parentId 指向二级）在树里要和二级并列，缩进一致
  {
    const deep = [
      { id: 'a', depth: 0, parentId: '' },
      { id: 'b', depth: 1, parentId: 'a', replyToAuthor: 'a君' },
      { id: 'c', depth: 2, parentId: 'b', replyToAuthor: 'b君' },
      { id: 'd', depth: 2, parentId: 'b', replyToAuthor: 'b君' }
    ];
    const dd = forum.decorateComments({ id: 'p1', comments: deep }, false);
    ok('三级回复被提到一级下面，和二级并列（不是嵌在二级里）',
      dd.commentTree.length === 1 && dd.commentTree[0].replies.length === 3,
      dd.commentTree.map((n) => n.id + ':' + n.replies.length));
    ok('并列后顺序仍是时间顺序（b / c / d）',
      dd.commentTree[0].replies.map((r) => r.id).join(',') === 'b,c,d',
      dd.commentTree[0].replies.map((r) => r.id));
    ok('三级回复也标成 isReply（缩进只看这一位）',
      dd.commentTree[0].replies.every((r) => r.isReply === true),
      dd.commentTree[0].replies.map((r) => r.isReply));
    ok('三级回复的「回复 @某某」指向被点的那条（b君），不是挂载点',
      dd.commentTree[0].replies[1].replyToName === 'b君',
      dd.commentTree[0].replies[1]);
    // 四级：replyTargetOf 把它折回二级，树里自然还是并列的
    const w = forum.replyTargetOf(deep, 'c');
    ok('四级回复折回三级：parentId 指回二级那条 b，depth 仍是 2',
      w.parentId === 'b' && w.depth === 2, w);
  }

  /* ============ D. 删父连子 ============ */
  console.log('D. 删留言连子回复');
  seedPost([
    { id: 'a', depth: 0, parentId: '', authorOpenid: 'o1' },
    { id: 'b', depth: 1, parentId: 'a', authorOpenid: 'o2' },
    { id: 'c', depth: 1, parentId: 'b', authorOpenid: 'o3' },
    { id: 'd', depth: 0, parentId: '', authorOpenid: 'o4' }
  ]);
  forum.removeComment('p1', 'a');
  const left = readComments().map((c) => c.id);
  ok('删一级 → 它的回复和回复的回复一起没', left.length === 1 && left[0] === 'd', left);
  ok('删掉的子回复也各记一笔墓碑（别人手机上不会留着）',
    !!(base.commentTomb()['b']) && !!(base.commentTomb()['c']), base.commentTomb());

  /* ============ E. 举报状态 ============ */
  console.log('E. 举报处理状态');
  forum.markCommentReport('p1', 'c9', '广告骚扰', 'pending');
  const st = forum.commentReportOf('p1', 'c9');
  ok('记下原因与状态', !!st && st.reason === '广告骚扰' && st.status === 'pending', st);
  ok('顺带点亮「我举报过」（两个入口共用一份事实）', forum.hasReportedComment('p1', 'c9') === true);
  ok('待核实 → 「已举报·待核实」', forum.commentReportLabel('pending') === '已举报·待核实');
  ok('已处置 → 「已举报·已处理」', forum.commentReportLabel('confirmed') === '已举报·已处理');
  ok('证据不足 → 「已举报·未成立」', forum.commentReportLabel('rejected') === '已举报·未成立');
  ok('没举报过 → 没有状态', forum.commentReportOf('p1', 'not-reported') === null);

  /* ============ F. 云函数那段 ============ */
  console.log('F. 云函数 commentVote（静态关键行）');
  const cfSrc = readCloudSource();
  ok('用了 doc().set() 写记名表（upsert，连点只落一条）',
    /COL_COMMENT_VOTES\)\.doc\(voteId\)\.set\(/.test(cfSrc));
  ok('计数从记名表数人头，不是累加',
    /COL_COMMENT_VOTES\)\.where\(\{ commentId: commentId, kind: 'like' \}\)\.count\(\)/.test(cfSrc));
  ok('记名表写不动时走降级而不是让按钮装死', /\[commentVote\] vote table unavailable/.test(cfSrc));
  ok('不能给自己的留言点赞', /不能给自己的留言点赞/.test(cfSrc));
  // 回复的节奏比留言快：共用一把尺子的话一问一答都聊不起来
  ok('回复单独一档频率闸，且比留言那档短', /const REPLY_GAP_MS = \d+ \* \d+;/.test(cfSrc)
    && Number(/const REPLY_GAP_MS = (\d+) \* (\d+);/.exec(cfSrc).slice(1).reduce((a, b) => a * Number(b), 1)) < 60000);
  ok('重复内容只对一级留言判重（回复里「好的」本来就会重复）',
    /if \(where\.depth === 0\) \{[\s\S]{0,600}?const dup = mine\.some/.test(cfSrc));
  // ⚠️ 真踩过一次：三道闸都要按「第几层」分别对待，而 where 是在它们之后才算出来的。
  // 挪动代码顺序就会变成 TDZ ReferenceError —— 云函数直接 500，
  // 前端看到的是「发评论毫无反应」，且本地怎么试都试不出来
  {
    const m = /async function postComment\(openid, payload\) \{[\s\S]*?\n\}\n/.exec(cfSrc);
    const body = m ? m[0] : '';
    const at = body.indexOf('const where =');
    const use = body.search(/where\.(depth|parentId)/);
    ok('postComment 里 where 的定义早于三道闸用到它的地方（挪了会 TDZ 报错）',
      at >= 0 && use >= 0 && at < use, { def: at, use: use });
  }
  ok('新增集合进了自检清单（没建要能在 diag 里看到）',
    cfSrc.indexOf('COL_COMMENT_VOTES,') >= 0 || /COL_COMMENT_VOTES,\s*$/m.test(cfSrc));

  // 前后端两份 replyTargetOf 必须同构：不一样的话「手机上挂一级、云端挂二级」
  const cfMax = /const REPLY_MAX_DEPTH = (\d+);/.exec(cfSrc);
  ok('云函数里有 REPLY_MAX_DEPTH', !!cfMax);
  if (cfMax) {
    ok('前后端层级上限一致（改一边忘改另一边会两副面孔）',
      Number(cfMax[1]) === forum.REPLY_MAX_DEPTH, { cloud: cfMax[1], client: forum.REPLY_MAX_DEPTH });
  }
  const cfReply = /function replyTargetOf\(comments, parentId\) \{[\s\S]*?\n\}/.exec(cfSrc);
  ok('云函数里有 replyTargetOf', !!cfReply);
  if (cfReply) {
    // 云端那份依赖文件里的 REPLY_MAX_DEPTH 常量，抽出来跑时得自己带上
    // eslint-disable-next-line no-new-func
    const cfFn = new Function('REPLY_MAX_DEPTH',
      'return (' + cfReply[0].replace('function replyTargetOf', 'function _rt') + ')'
    )(Number(cfMax[1]));
    const t2 = cfFn(cs, 'b');
    const mine2 = forum.replyTargetOf(cs, 'b');
    ok('云端那份对同一份输入给出同一个结果（回复二级）',
      t2.parentId === mine2.parentId && t2.depth === mine2.depth
        && t2.parentId === 'b' && t2.depth === 2, { cloud: t2, client: mine2 });
    const t3 = cfFn(cs, 'c');
    const mine3 = forum.replyTargetOf(cs, 'c');
    ok('云端那份对同一份输入给出同一个结果（回复三级 → 折回）',
      t3.parentId === mine3.parentId && t3.depth === mine3.depth
        && t3.parentId === 'b' && t3.depth === 2, { cloud: t3, client: mine3 });
  }

  /* ============ G. 页面事件 ============ */
  console.log('G. 页面事件');
  require(path.join(PROJ, 'sub', 'forum', 'detail', 'detail.js'));
  ok('页面加载成功并捕获到 Page', !!CAPTURED && typeof CAPTURED.onCommentVote === 'function');
  ok('回复 / 展开 / 取消回复四个入口都注册了',
    typeof CAPTURED.onReplyComment === 'function'
    && typeof CAPTURED.onToggleReplies === 'function'
    && typeof CAPTURED.onCancelReply === 'function'
    && typeof CAPTURED.refreshComments === 'function');

  seedPost([
    { id: 'a', depth: 0, parentId: '', author: '小明', authorOpenid: 'o1', content: '群号多少', likes: 0, dislikes: 0, at: 1 },
    { id: 'b', depth: 1, parentId: 'a', author: '小红', authorOpenid: 'o2', content: '满了', likes: 0, dislikes: 0, at: 2 }
  ]);
  const ctx = {
    data: {
      id: 'p1',
      expanded: {},
      replyTo: null,
      replyPreview: forum.REPLY_PREVIEW,
      post: forum.decorateComments(MEM[base.KEYS.posts][0], false)
    },
    setData(o) { Object.keys(o).forEach((k) => { this.data[k] = o[k]; }); },
    refreshComments() {
      const p = MEM[base.KEYS.posts].filter((x) => x.id === this.data.id)[0];
      if (p) this.setData({ post: forum.decorateComments(p, false, this.data.expanded) });
    }
  };

  CAPTURED.onReplyComment.call(ctx, { currentTarget: { dataset: { id: 'b' } } });
  ok('点回复 → 记住被回的是谁', !!ctx.data.replyTo && ctx.data.replyTo.author === '小红', ctx.data.replyTo);
  CAPTURED.onCancelReply.call(ctx);
  ok('取消回复 → 回到普通留言', ctx.data.replyTo === null);

  CAPTURED.onReplyComment.call(ctx, { currentTarget: { dataset: { id: 'nope' } } });
  ok('回复一条不存在的留言 → 静默（不弹报错）', ctx.data.replyTo === null);
  CAPTURED.onReplyComment.call(ctx, { currentTarget: { dataset: {} } });
  ok('缺 id → 静默', ctx.data.replyTo === null);

  CAPTURED.onToggleReplies.call(ctx, { currentTarget: { dataset: { id: 'a' } } });
  ok('点展开 → 记下展开态', ctx.data.expanded.a === true, ctx.data.expanded);
  CAPTURED.onToggleReplies.call(ctx, { currentTarget: { dataset: { id: 'a' } } });
  ok('再点 → 收起', ctx.data.expanded.a === undefined, ctx.data.expanded);

  // 赞踩走页面入口：连点那一下不该把数字点歪
  let toast = '';
  const voteCtx = Object.assign({}, ctx, {
    // 页面里的提示出口，这里接住就好
    setData(o) { Object.keys(o).forEach((k) => { this.data[k] = o[k]; }); }
  });
  voteCtx.data.expanded = {};
  CAPTURED.onCommentVote.call(voteCtx, { currentTarget: { dataset: { id: 'a', k: 'like' } } });
  ok('页面点赞 → 界面上那条的赞数变 1',
    voteCtx.data.post.commentTree[0].likes === 1, voteCtx.data.post.commentTree[0]);
  CAPTURED.onCommentVote.call(voteCtx, { currentTarget: { dataset: { id: 'a', k: 'dislike' } } });
  ok('紧接着点踩被闸吃掉，赞没有被换掉',
    voteCtx.data.post.commentTree[0].likes === 1 && voteCtx.data.post.commentTree[0].dislikes === 0,
    voteCtx.data.post.commentTree[0]);
  CAPTURED.onCommentVote.call(voteCtx, { currentTarget: { dataset: { id: '', k: 'like' } } });
  ok('缺 id → 不炸也不改数据', voteCtx.data.post.commentTree[0].likes === 1);
  CAPTURED.onCommentVote.call(voteCtx, { currentTarget: { dataset: { id: 'a', k: 'zzz' } } });
  ok('非法 kind → 不炸也不改数据', voteCtx.data.post.commentTree[0].likes === 1);
  void toast;

  console.log('');
  if (fail === 0) {
    console.log('全部通过：' + pass + ' 通过 / 0 失败');
  } else {
    console.log(pass + ' 通过 / ' + fail + ' 失败');
    process.exit(1);
  }
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
