/* 留言拆表 + 举报防刷 + 申诉通道 行为测试
 *
 * 这一轮动的是**存储结构**（留言从帖子文档里的数组变成独立集合），
 * 坏起来的特征和 UI 完全不同：界面一切正常，但换个人同时留言就丢一条、
 * 点赞把别人的新回复盖回去、删帖之后留言变成孤儿 —— 全都看不出来。
 * 所以这里测的是「写法还在不在」而不是「长得对不对」：
 *
 *   A. 云端不再整份读改写留言数组（竞态的根）
 *   B. 一条留言一个文档，且都带 postId（外键）
 *   C. 删除是软删（申诉要能核对原文），读的一侧按 removed 过滤
 *   D. 分页取留言（单次 get 上限 100，写 250 会静默少给一半）
 *   E. 老数据惰性迁移：抢锁、全成功才清原数组
 *   F. 举报防刷：新号 24h 不计票、同人 10 分钟只触发一次自动处置
 *   G. 申诉：本人 / 7 天窗口 / 一人一次 / 恢复后关闭入口
 *   H. 前端计数改读 commentCount（本地缓存不等于总数）
 *   I. 数据层可执行断言：decoratePost / hotScore / 排序 / applyCloudComments
 *   J. 页面注册与文件齐全
 *
 * 用法：node scripts/test-comment-table.cjs
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
  c.update = () => Promise.resolve({ stats: { updated: 1 } });
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
  cloud: { init: noop, database: () => chain, callFunction: () => Promise.resolve({ result: { ok: true } }) }
};
global.wx = new Proxy(wxBase, { get: (t, k) => (k in t ? t[k] : noop) });
global.getApp = () => ({ globalData: {} });
global.getCurrentPages = () => [];
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

const readProj = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8');
const readCloudSource = require('./cloud-source.cjs');
const readCloud = () => readCloudSource();
// 取一段函数体：从签名到下一个顶层 `async function` / `function` 之前
function fnBody(src, name) {
  const re = new RegExp('(?:async )?function ' + name + '\\s*\\([\\s\\S]*?\\n\\}\\n', 'm');
  const m = re.exec(src);
  return m ? m[0] : '';
}

const CF = readCloud();

/* ============ A. 不再整份读改写留言数组 ============ */
console.log('A. 竞态的根：整份覆盖留言数组');
{
  // 这三个写法分别对应「新增留言」「删留言」「回写赞踩计数」的老实现，
  // 它们全都是「读整份 → 改 → 整份写回」，并发时后写的把先写的抹掉
  ok('没有任何地方再把整份 comments 写回帖子',
    !/update\(\{\s*data:\s*\{\s*comments:\s*(next|kept|nextComments)\b/.test(CF));
  ok('新增留言用 doc(id).set（一文档一写，不碰别人）',
    /COL_POST_COMMENTS\)\.doc\(comment\.id\)[\s\S]{0,80}\.set\(/.test(CF));
  ok('新增留言之后 commentCount 原子自增', /commentCount: db\.command\.inc\(1\)/.test(CF));
  ok('点赞只 update 自己这条的计数字段',
    /COL_POST_COMMENTS\)\.doc\(commentId\)[\s\S]{0,120}update\(\{\s*data:\s*\{\s*likes: likes, dislikes: dislikes/.test(CF));
  ok('patchContent 不再允许客户端写 comments（否则幽灵留言有后门）',
    !/\['likes', 'comments', 'status', 'hiddenReason'\]/.test(CF));
}

/* ============ B. 一留言一文档 ============ */
console.log('B. 一条留言一个文档');
{
  ok('集合常量存在', /const COL_POST_COMMENTS = 'post_comments';/.test(CF));
  const post = fnBody(CF, 'postComment');
  ok('新留言带 postId（删帖清孤儿、按帖查询都靠它）', /postId: postId,/.test(post));
  ok('新留言带 removed: false（读的一侧按它过滤）', /removed: false,/.test(post));
  ok('新留言带 appealable 之外的删除字段时不会误写', !/removed: true/.test(post));
  ok('自检清单里能看到这个集合（没建等于评论区打不开）',
    /COL_POST_COMMENTS, COL_COMMENT_APPEALS,/.test(CF));
}

/* ============ C. 软删 ============ */
console.log('C. 删除是软删');
{
  const soft = fnBody(CF, 'softRemoveCommentTree');
  ok('softRemoveCommentTree 置 removed 而不是 remove()', /removed: true/.test(soft) && !/\.remove\(\)/.test(soft));
  ok('软删记下谁删的、为什么删（申诉与复核要看）',
    /removedBy: String\(opts\.by/.test(soft) && /removedReason: String\(opts\.reason/.test(soft));
  ok('软删连子回复一起（不留孤儿）', /doomed\[String\(c\.parentId/.test(soft));
  ok('删完计数原子减', /commentCount: db\.command\.inc\(-ids\.length\)/.test(soft));
  const list = fnBody(CF, 'listCommentsOfPost');
  ok('读留言时过滤 removed', /filter\(\(c\) => c && !c\.removed\)/.test(list));
  ok('审核员确认违规走软删而不是物理删',
    /await softRemoveCommentTree\(String\(c\.postId\), String\(targetId\), \{[\s\S]{0,120}by: 'mod'/.test(CF));
  ok('commentRemove 改走 softRemoveCommentTree',
    /const del = await softRemoveCommentTree\(postId, commentId, \{/.test(CF));
  ok('帖子被删时顺手清掉它的留言（否则成孤儿文档）',
    /if \(targetType === 'post'\) \{[\s\S]{0,200}COL_POST_COMMENTS\)\.where\(\{ postId: id \}\)\.remove\(\)/.test(CF));
}

/* ============ D. 分页 ============ */
console.log('D. 分页取留言');
{
  const list = fnBody(CF, 'listCommentsOfPost');
  ok('自己分页（云函数端默认只回 100 条）', /const PAGE = 100;/.test(list) && /while \(out\.length < COMMENT_CAP/.test(list));
  // 云函数端 limit 的硬上限是 1000，超过会直接报错；这里兜住别写出四位数的 limit
  const bigLimits = (CF.match(/\.limit\((\d+)\)/g) || [])
    .map((s) => Number(s.slice(7, -1)))
    .filter((n) => n > 1000);
  ok('没有超过 1000 的 limit（云函数端硬上限）', bigLimits.length === 0, bigLimits);
  ok('排序在内存里做（where+orderBy 没索引会整段失败）',
    /\.sort\(\(a, b\) => \(Number\(a\.at\) \|\| 0\) - \(Number\(b\.at\) \|\| 0\)\)/.test(list));
}

/* ============ E. 老数据迁移 ============ */
console.log('E. 老数据惰性迁移');
{
  const mig = fnBody(CF, 'migrateLegacyComments');
  ok('靠条件更新抢锁，避免多人同时迁', /commentsMigrated: db\.command\.neq\(true\)/.test(mig));
  ok('只有拿到锁（stats.updated > 0）才动手', /stats\.updated > 0/.test(mig));
  ok('全部写成功才清原数组（原数组是唯一副本）',
    /if \(failed\) \{[\s\S]{0,400}return;[\s\S]{0,300}comments: db\.command\.remove\(\)/.test(mig));
  ok('失败会把标记退回未迁，下次重试', /commentsMigrated: false/.test(mig));
  ok('三个入口都会先迁移：发留言 / 删留言 / 点赞 / 拉列表 / 举报',
    (CF.match(/await migrateLegacyComments\(/g) || []).length >= 4);
}

/* ============ F. 举报防刷 ============ */
console.log('F. 举报防刷');
{
  // 2026-10-18.5：留言不再自动删除（删除一律人工），所以「新号不计票」
  // 「处置冷却」「triggered 打标」这三道闸一起拆掉了 —— 它们拦的是自动动作，
  // 而自动动作本身已经不存在。这一节改为守住「确实没有自动删除」。
  const rep = fnBody(CF, 'commentReport');
  ok('留言举报不再有自动删除分支', !/if \(verdict\.del\)/.test(rep) && !/softRemoveCommentTree/.test(rep));
  ok('留言判定恒返回 del: false', /del: false,/.test(fnBody(CF, 'decideCommentAction')));
  ok('回执说「交给老师核实」而不是「已经删掉」',
    /会由老师核实后处理/.test(rep) && !/已经自动删掉/.test(rep));
  ok('观察期里的那一票仍然留痕（照进队列，只是不算人数）',
    /reviewOnly: !!ab\.limited/.test(rep) && /ab\.limited \? openid : ''/.test(rep));
  ok('留言查重也不再带 reason（否则一个人换理由能投 8 次）',
    /where\(\{ openid: openid, targetId: commentId, targetType: 'comment' \}\)/.test(rep)
    && !/targetType: 'comment', reason: reason/.test(rep));
}

/* ============ G. 申诉 ============ */
console.log('G. 申诉通道');
{
  ok('申诉集合存在', /const COL_COMMENT_APPEALS = 'comment_appeals';/.test(CF));
  const info = fnBody(CF, 'commentAppealInfo');
  ok('只给作者本人看原文', /if \(String\(c\.authorOpenid \|\| ''\) !== String\(openid\)\)/.test(info));
  ok('7 天窗口', /const APPEAL_WINDOW_MS = 7 \* 24 \* 60 \* 60 \* 1000;/.test(CF));
  const ap = fnBody(CF, 'commentAppeal');
  ok('申诉理由至少 10 个字', /reason\.length < 10/.test(ap));
  ok('只能申诉已删且可申诉的', /if \(!c\.removed\)/.test(ap) && /if \(!c\.appealable\)/.test(ap));
  ok('已申诉过不重复写', /already: true/.test(ap));
  ok('_id = commentId 天然幂等', /COL_COMMENT_APPEALS\)\.doc\(commentId\)\.set\(/.test(ap));
  const rs = fnBody(CF, 'commentRestore');
  ok('恢复要审核员', /if \(!\(await isModerator\(openid\)\)\)/.test(rs));
  ok('恢复后计数加回、申诉入口关闭',
    /commentCount: db\.command\.inc\(1\)/.test(rs) && /appealable: false/.test(rs));
  ok('恢复会结掉申诉记录', /status: 'accepted'/.test(rs));
  ok('删留言时通知作者（以前是静默的）',
    /await notifyCommentRemoved\(rec, target/.test(CF));
  // 自动删除已经取消，所以「系统删掉时也通知」只剩人工删除那一条路要守：
  // 只要不是作者自己删的（帖主 / 审核员），必须通知作者
  ok('别人删的会通知（静默删除等于让人以为程序坏了）',
    /await notifyCommentRemoved\(rec, target, isMod \? '审核员判定违规' : '帖主认为不合适', openid\)/.test(CF));
  ok('自己删的不通知', /if \(String\(by \|\| ''\) && String\(by\) === to\) return;/.test(CF));
  // 路由
  ['commentList', 'commentAppealInfo', 'commentAppeal', 'commentRestore', 'appealQueue']
    .forEach((n) => ok('路由注册：' + n, new RegExp("case '" + n + "':").test(CF)));
}

/* ============ H. 前端计数 ============ */
console.log('H. 前端计数改读 commentCount');
{
  ok('list.wxml 用 commentCount', /\{\{p\.commentCount\}\}/.test(readProj('pages/forum/list/list.wxml')));
  ok('hole.wxml 用 commentCount', /\{\{p\.commentCount\}\}/.test(readProj('sub/forum/hole/hole.wxml')));
  ok('detail.wxml 用 commentCount', /post\.commentCount/.test(readProj('sub/forum/detail/detail.wxml')));
  ok('未读水位用 commentCount', /Number\(p\.commentCount\) \|\| \(p\.comments \|\| \[\]\)\.length/.test(readProj('utils/unread.js')));
  ok('审核端置顶列表用 commentCount', /Number\(p\.commentCount\) \|\| \(p\.comments \|\| \[\]\)\.length/.test(readProj('pages/admin/moderation/moderation.js')));
}

/* ============ I. 数据层可执行断言 ============ */
console.log('I. 数据层');
{
  const base = require(path.join(PROJ, 'utils', 'store-base.js'));
  const forum = require(path.join(PROJ, 'utils', 'store-forum.js'));
  const cloudMod = require(path.join(PROJ, 'utils', 'cloud.js'));
  cloudMod.cfg.USE_CLOUD = false;

  // ① 列表页只拿得到 commentCount（帖子文档里没有留言数组），
  //    这时候必须显示云端那个数，而不是 0
  const p1 = forum.decoratePost({
    id: 'p1', board: '闲聊', title: 't', author: 'a', authorOpenid: 'o1',
    commentCount: 12, comments: [], likes: 0, dislikes: 0, at: Date.now(), time: '2026-10-17'
  });
  ok('云端 commentCount 优先于本地空数组', p1.commentCount === 12, { got: p1.commentCount });

  // ② 老帖子没有 commentCount → 退回数组长度
  const p2 = forum.decoratePost({
    id: 'p2', board: '闲聊', title: 't', author: 'a', authorOpenid: 'o1',
    comments: [{ id: 'c1' }, { id: 'c2' }], likes: 0, dislikes: 0, at: Date.now(), time: '2026-10-17'
  });
  ok('没有 commentCount 时退回数组长度', p2.commentCount === 2, { got: p2.commentCount });

  // ③ 热度要把留言算进去，而它读的是原始帖子（没有 decorate 过的量）
  const hot = forum.hotScore({
    likes: 0, dislikes: 0, commentCount: 10, comments: [], at: Date.now()
  });
  ok('热度公式读 commentCount', hot >= 19, { got: hot });

  // ④ applyCloudComments：整份替换 + 墓碑过滤 + 总数
  MEM[base.KEYS.posts] = [{
    id: 'p1', board: '闲聊', title: 't', author: 'a', authorOpenid: 'o1',
    comments: [{ id: 'old' }], commentCount: 1, likes: 0, dislikes: 0, at: Date.now(), time: '2026-10-17'
  }];
  MEM[base.KEYS.commentTomb] = { gone: true };
  forum.applyCloudComments('p1', [
    { id: 'c1', content: 'a' },
    { id: 'gone', content: 'b' },
    { id: 'c3', content: 'c', removed: true }
  ], 3);
  const after = MEM[base.KEYS.posts][0];
  ok('拉回来的留言整份替换本地缓存', after.comments.length === 1 && after.comments[0].id === 'c1',
    { ids: after.comments.map((c) => c.id) });
  ok('墓碑与 removed 都挡掉', !after.comments.some((c) => c.id === 'gone' || c.id === 'c3'));
  ok('总数用云端给的（哪怕本地只剩 1 条可见）', after.commentCount === 3, { got: after.commentCount });
  ok('applyCloudComments 对不存在的帖子不炸', forum.applyCloudComments('nope', [], 0) === false);

  // ⑤ 本地发一条 / 删一条，列表页的数字要跟着动
  MEM[base.KEYS.posts] = [{
    id: 'p3', board: '闲聊', title: 't', author: 'me', authorOpenid: 'me',
    comments: [], commentCount: 0, likes: 0, dislikes: 0, at: Date.now(), time: '2026-10-17'
  }];
  const add = forum.addComment('p3', '你好', [], null);
  ok('本地发留言后 commentCount +1', MEM[base.KEYS.posts][0].commentCount === 1,
    { got: MEM[base.KEYS.posts][0].commentCount, has: !!add.comment });
  forum.removeComment('p3', add.comment.id);
  ok('本地删留言后 commentCount -1', MEM[base.KEYS.posts][0].commentCount === 0,
    { got: MEM[base.KEYS.posts][0].commentCount });
}

/* ============ J. 页面 ============ */
console.log('J. 申诉页');
{
  const appJson = JSON.parse(readProj('app.json'));
  // 主包 pages + 分包 subPackages 都要认：申诉页为压主包体积搬进了分包，
  // 它对用户仍然是同一个路径，只是首次进入才下载
  const allPages = (appJson.pages || []).concat(
    (appJson.subPackages || []).reduce((a, p) => a.concat(
      (p.pages || []).map((q) => (p.root ? p.root + '/' : '') + q)), []));
  ok('页面已注册', allPages.indexOf('pages/forum/comment-appeal/comment-appeal') >= 0);
  ['js', 'wxml', 'wxss', 'json'].forEach((ext) => {
    ok('文件齐全：.' + ext,
      fs.existsSync(path.join(PROJ, 'pages/forum/comment-appeal/comment-appeal.' + ext)));
  });
  const js = readProj('pages/forum/comment-appeal/comment-appeal.js');
  ok('缺 commentId 时给结论而不是空白', /链接不完整/.test(js));
  ok('提交前拦字数', /text\.length < MIN_LEN/.test(js));
  ok('提交后重拉状态（否则用户以为没成功）', /this\.load\(\)/.test(js));
  ok('通知中心认得 comment_removed', /comment_removed: 'shield-check'/.test(readProj('pages/user/notify/notify.js')));
  const modJs = readProj('pages/admin/moderation/moderation.js');
  ok('审核页拉申诉队列', /userApi\.appealQueue\(\)/.test(modJs));
  ok('审核页有恢复入口', /onRestoreAppeal/.test(modJs));
}

console.log('');
if (fail) {
  console.log('失败 ' + fail + ' 项 / 通过 ' + pass + ' 项');
  process.exit(1);
}
console.log('全部通过：' + pass + ' 通过 / 0 失败');
