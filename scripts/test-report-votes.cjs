// scripts/test-report-votes.cjs —— 举报计票与审核队列的守门测试
//
// 三件事被钉在这里：
//
// 一、「一个人一票」。整套自动处置的正当性全在「三个人都说不行」这句话上，
//     而旧版查重键带着理由，8 种理由能投 8 次 —— 一个人点三次就能把任何内容
//     推过 3 票的下架线、点五次就够直接删除。这个洞**不报错**，只会在某天
//     有人发现自己认真写的帖「莫名其妙没了」的时候才暴露。
//
// 二、「一条内容一行」。队列按举报条排的时候，同一条帖被 3 人举报就是三张
//     一模一样的卡：点第一张内容就删了，后两张对着空气操作；更看不出
//     「还差几票自动下架」—— 而那个数字才是「现在要不要动手」的依据。
//
// 三、处置之后能回看。确认 / 驳回之后记录从队列里消失，没有归档就等于
//     没有任何凭据：有人来问「你们凭什么删我的帖」，只能翻库。
//
// 跑法：node scripts/test-report-votes.cjs（工作目录在 recon/ 下）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram', 'zjgsu-campus');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  ← ' + JSON.stringify(extra)));
}
function readProj(rel) {
  return fs.readFileSync(path.join(APP, rel), 'utf8');
}
const userApiText = readProj('utils/user.js');

const readCloudSource = require('./cloud-source.cjs');
const CLOUD = readCloudSource();
const MOD_JS = readProj('pages/admin/moderation/moderation.js');
const MOD_WXML = readProj('pages/admin/moderation/moderation.wxml');
const MOD_WXSS = readProj('pages/admin/moderation/moderation.wxss');
const USER_JS = userApiText;

/* ==========================================================================
   一、纯函数：人数怎么数（真的跑，不扫源码）
   ========================================================================== */

// 小程序侧的 .js 是 CommonJS，但 recon/package.json 是 "type":"module"，
// 直接 require 会报 module is not defined —— 只能跟 utils/pager.js 一样手工装载
function loadVotes() {
  const mod = { exports: {} };
  new Function('module', 'exports', readProj('cloudfunctions/user/report-votes.js'))(mod, mod.exports);
  return mod.exports;
}
const RV = loadVotes();
const HIGH = ['涉及隐私', '违规交易', '广告骚扰'];

function rep(i, openid, extra) {
  return Object.assign({
    _id: 'r' + i, openid: openid, targetType: 'post', targetId: 'p1',
    target: 'author1', reason: '不文明用语', detail: '', at: 1000 + i,
    time: '10-18 10:0' + i, status: 'pending'
  }, extra || {});
}

ok('模块导出 countVoices / groupReports', typeof RV.countVoices === 'function' && typeof RV.groupReports === 'function');

{
  // 关键回归：同一个人换 3 个理由（旧版查重键允许）→ 仍然只算 1 票
  const one = [rep(1, 'A', { reason: '不文明用语' }), rep(2, 'A', { reason: '广告骚扰' }), rep(3, 'A', { reason: '涉及隐私' })];
  ok('同一个人换 3 个理由，只算 1 票（旧版这里会算 3 票 → 自动下架）',
    RV.countVoices(one, '', HIGH).total === 1, RV.countVoices(one, '', HIGH).total);
  ok('但「他说过广告」这件事仍然记得（risky 按人算，为 1）',
    RV.countVoices(one, '', HIGH).risky === 1);

  const three = [rep(1, 'A'), rep(2, 'B'), rep(3, 'C')];
  ok('三个人各一条 → 3 票', RV.countVoices(three, '', HIGH).total === 3);

  const mixed = [rep(1, 'A', { reason: '广告骚扰' }), rep(2, 'B'), rep(3, 'C', { reason: '虚假信息' })];
  ok('3 人里 1 人指认高敏 → total 3 / risky 1',
    RV.countVoices(mixed, '', HIGH).total === 3 && RV.countVoices(mixed, '', HIGH).risky === 1,
    RV.countVoices(mixed, '', HIGH));

  // 观察期里的人：票留着，但不算进「几个人」
  const withAbuser = [rep(1, 'A'), rep(2, 'ABUSER')];
  ok('观察期里的人不计入人头（他那一票不参与自动处置）',
    RV.countVoices(withAbuser, 'ABUSER', HIGH).total === 1);
  ok('观察期的人被排除后，只剩他就等于 0 票',
    RV.countVoices([rep(1, 'ABUSER')], 'ABUSER', HIGH).total === 0);
  ok('不传 excludeOpenid 时所有人都在',
    RV.countVoices(withAbuser, '', HIGH).total === 2);

  // 极老的数据可能没有 openid：宁可多算也不要吞票
  const noId = [{ _id: 'x1', reason: '其他' }, { _id: 'x2', reason: '其他' }];
  ok('没有 openid 的老记录各自算一票（不吞票）', RV.countVoices(noId, '', HIGH).total === 2);
}

/* ==========================================================================
   二、纯函数：一条内容怎么合成一行
   ========================================================================== */

{
  const rows = [
    rep(1, 'A', { reason: '广告骚扰', detail: '', at: 3000, time: '10-18 10:03' }),
    rep(2, 'B', { reason: '广告骚扰', detail: '他在评论里留了微信号', at: 2000, time: '10-18 10:02' }),
    rep(3, 'C', { reason: '虚假信息', detail: '说的价格根本不对', at: 1000, time: '10-18 10:01' })
  ];
  const g = RV.groupReports(rows);
  ok('同一条内容 3 条举报 → 1 行', g.length === 1, g.length);
  ok('这一行记住全部 3 个举报 id（驳回要一起结掉）', g[0].repIds.length === 3, g[0].repIds);
  ok('人数是 3', g[0].reportCount === 3, g[0].reportCount);
  ok('理由分布两种，多的那个排第一',
    g[0].reasons.length === 2 && g[0].reasons[0].name === '广告骚扰' && g[0].reasons[0].count === 2,
    g[0].reasons);
  ok('卡片主理由取出现最多的那个', g[0].reason === '广告骚扰', g[0].reason);
  ok('举报说明取最新一条**写了内容的**（最新那条是空话）',
    g[0].detail === '他在评论里留了微信号', g[0].detail);
  ok('时间取最新那条', g[0].time === '10-18 10:03', g[0].time);
  ok('组的 key 稳定（同内容同 key）', g[0].key === 'post|p1', g[0].key);

  const two = RV.groupReports([
    rep(1, 'A', { targetId: 'p1' }),
    rep(2, 'B', { targetId: 'p2' })
  ]);
  ok('两条不同内容 → 2 行', two.length === 2, two.length);
  ok('两条内容的 key 不相同', two[0].key !== two[1].key);

  const people = RV.groupReports([
    rep(1, 'A', { targetType: 'chat', targetId: '', target: 'bad1' }),
    rep(2, 'B', { targetType: 'chat', targetId: '', target: 'bad1' }),
    rep(3, 'C', { targetType: 'chat', targetId: '', target: 'bad2' })
  ]);
  ok('举报同一个人 2 次 → 合成 1 行（不是两张一模一样的卡）',
    people.length === 2, people.map((x) => x.key));
  ok('被举报的那个人那一行有 2 人',
    people.filter((x) => x.reportCount === 2).length === 1,
    people.map((x) => x.reportCount));

  const flags = RV.groupReports([
    rep(1, 'A', { reviewOnly: true }),
    rep(2, 'B', { escalated: true, reporterCount: 3 })
  ]);
  ok('组里只要有一个人在观察期，整行标出来', flags[0].reviewOnly === true);
  ok('组里只要有一票升级过，整行排前面（escalated）', flags[0].escalated === true);
  ok('reporterCount 取组内最大值', flags[0].reporterCount === 3, flags[0].reporterCount);

  ok('空输入不炸', RV.groupReports([]).length === 0 && RV.groupReports(null).length === 0);
  ok('targetId 为空时 key 也能算出来（不会拼出 undefined）',
    RV.groupReports([{ _id: 'z', targetType: 'post' }])[0].key === 'post|');
}

/* ==========================================================================
   三、云函数：写入口与处置链路
   ========================================================================== */

// 只看 report 自己那一段：全文件里还有别的查重（比如好友申请），扫全文件会误报
const reportDoc = (CLOUD.match(/async function report\(openid, payload\)[\s\S]*?\n}\n/) || [''])[0];
ok('举报查重不再带 reason（否则一个人换理由能投好几次）',
  /where\(\{\s*openid: openid,\s*targetId: targetId\s*\}\)/.test(reportDoc),
  (reportDoc.match(/where\(\{[^}]*\}\)/) || [''])[0]);
ok('查重里已经没有 reason 这个键',
  !/where\(\{[^}]*reason: reason[^}]*\}\)/.test(reportDoc));
ok('结掉的票不再翻案（换理由重投不会把结案的东西拉回队列）',
  /oldRep\.status\s*!==\s*'pending'/.test(reportDoc));
ok('换理由时**更新**原来那一票而不是新增',
  /COL_REPORTS\)\.doc\(oldRep\._id\)/.test(reportDoc) && /update\(\{\s*data:\s*\{\s*reason: reason/.test(reportDoc));
ok('更新时不改 at（改了等于把 24 小时窗口重新计时）',
  /reason: reason, detail: detail \|\| String\(oldRep\.detail/.test(reportDoc));

ok('内容判定改用 countVoices 数人头',
  /const voices = countVoices\(reports, excludeOpenid, MOD_RULES\.HIGH_RISK\)/.test(CLOUD));
ok('留言判定也走同一套（两处口径不能分叉）',
  (CLOUD.match(/countVoices\(reports, excludeOpenid, MOD_RULES\.HIGH_RISK\)/g) || []).length >= 2,
  (CLOUD.match(/countVoices\(/g) || []).length);
ok('不再有按记录条数算总数的写法',
  !/const total = reports\.length/.test(CLOUD));
// 2026-10-18.5：自动删除整档拆掉，只留下架。这几条断言守住「别哪天又被加回来」——
// 删除不可逆，而被误删的原文正是作者申诉 / 同学举证时唯一的凭据
const decideDoc = (CLOUD.match(/async function decideAction\([\s\S]*?\n}\n/) || [''])[0];
ok('decideAction 里不存在任何 delete 分支', !/'delete'/.test(decideDoc),
  (decideDoc.match(/.{0,40}'delete'.{0,40}/) || [''])[0]);
ok('自动删除阈值常量已经删干净（留着会让人以为规则还在）',
  !/AUTO_DELETE_THRESHOLD|COLD_AUTO_DELETE|HIGH_RISK_DELETE/.test(CLOUD.replace(/\/\/.*$/gm, '')));
ok('高敏理由不再降低门槛（只影响队列排序）', !/HIGH_RISK_HIDE|HIGH_RISK_DELETE/.test(
  CLOUD.replace(/\/\/.*$/gm, '').replace(/HIGH_RISK: \[[^\]]*\]/g, '')));
ok('留言也不再自动删（decideCommentAction 恒返回 del: false）',
  /del: false,/.test(CLOUD.match(/async function decideCommentAction\([\s\S]*?\n}\n/)[0]));
ok('decideAction 由 hideNeed 或屏蔽词命中决定',
  /const need = hideNeed\(views\)/.test(decideDoc) && /if \(total >= need \|\| \(blocked && total >= 1\)\) action = 'hide'/.test(decideDoc));

/* ---- 队列：按内容合并 ---- */
const queueDoc = (CLOUD.match(/async function getQueue\(openid\)[\s\S]*?\n}\n/) || [''])[0];
ok('getQueue 用 groupReports 合并', /groupReports\(res\.data \|\| \[\]\)/.test(queueDoc));
ok('每条带全部举报 id（repIds）', /repIds: g\.repIds/.test(queueDoc));
ok('每条带稳定 key（前端勾选用）', /gkey: g\.key/.test(queueDoc));
ok('每条带人数', /reportCount: g\.reportCount/.test(queueDoc));
ok('每条带「还差几个人」与分母（人数 + 浏览）',
  /needMore:/.test(queueDoc) && /views: detail\[i\]\.views/.test(queueDoc));
ok('差人数的提示只给走下架流程的那几类（留言没有下架档，算这个数就是撒谎）',
  /HIDE_TYPES = \['post', 'review', 'market', 'event', 'resource'\]/.test(queueDoc), '没找到 HIDE_TYPES');
ok('门槛按每条内容自己的浏览量算，不再是一个全局常数',
  /hideNeed\(views\)/.test(queueDoc) && !/const hideAt = cold/.test(queueDoc));
ok('没建 content_views 集合会被自检报出来（不然分母永远是 0，改动等于白做）',
  /COL_VIEWS,\s*\n\s*COL_DRAFTS\]/.test(CLOUD) || /COL_VIEWS/.test(CLOUD.match(/const need = \[[\s\S]*?\];/)[0]));
ok('排序：升级过 → 人数多 → 时间',
  /if \(a\.reportCount !== b\.reportCount\) return b\.reportCount - a\.reportCount/.test(queueDoc));
ok('举报人（人）的证据快照会合并，不只留最新一份',
  /g\.rows\.forEach\(\(r\) => \{\s*\n\s*\(Array\.isArray\(r\.evidence\)/.test(queueDoc));

/* ---- 归档 ---- */
ok('有 reportArchive', /async function reportArchive\(openid, payload\)/.test(CLOUD));
ok('归档包含人工处置与自动筛除状态',
  /db\.command\.in\(\['confirmed', 'rejected', 'auto_dismissed'\]\)/.test(CLOUD));
ok('归档也验审核员身份',
  /async function reportArchive\(openid, payload\) \{\s*\n\s*const err = await denyReason\(openid\)/.test(CLOUD));
ok('处置时写内容快照（删掉之后只剩这份凭据）',
  /snapTitle: snap\.title,\s*\n\s*snapDesc: snap\.desc/.test(CLOUD));
ok('快照在删除之前取（事后再取是空的）',
  /const cur = \(first\.targetId && !person\) \? await fetchTarget\(first\.targetType, first\.targetId\) : null;/.test(CLOUD));
ok('同一批里按内容分组，同一条内容只处置一次',
  /const groups = \{\};/.test(CLOUD) && /groups\[key\]\.push\(r\)/.test(CLOUD) && /for \(const key of Object\.keys\(groups\)\)/.test(CLOUD));
ok('dispatch 里挂了 reportArchive', /case 'reportArchive':/.test(CLOUD));
ok('FEATURES 里加了这次的三项能力',
  /'reportOneVote', 'queueGrouped', 'reportArchive'/.test(CLOUD));

/* ---- 前端接口 ---- */
ok('userApi 暴露 reportArchive', /function reportArchive\(scope\)/.test(USER_JS) && /reportArchive,/.test(USER_JS));

/* ==========================================================================
   四、审核页：真的把页面跑起来点两下
   ========================================================================== */

// 注意：这里必须是 async —— 页面的 setData 清理写在 .then 里，
// 同步断言只能看到「点了」，看不到「点完之后」。踩过的坑：断言写早了会假红，
// 而假红最坏的后果是让人把正确的实现改坏。
const behavior = (async () => {
  // 让 .then 链跑完（vm 之外这里就是真实事件循环）
  const flush = () => new Promise((r) => setTimeout(r, 0));

  let def = null;
  const toasts = [];
  const modals = [];
  const resolved = [];
  const archiveCalls = [];

  const stubRequire = (p) => {
    if (/utils\/config/.test(p)) return { MODERATION: { ABUSER_BADGE: '观察期' } };
    if (/utils\/cloud/.test(p)) return { getOpenid: () => 'MOD1' };
    if (/utils\/feedback/.test(p)) {
      return {
        toast: (m) => toasts.push(m), ok: (m) => toasts.push(m),
        fail: (m) => toasts.push(m)
      };
    }
    if (/utils\/store/.test(p)) return { getPosts: () => [], searchPosts: () => [], deletePost: () => Promise.resolve(true) };
    if (/utils\/market/.test(p)) return { removeLocal: () => {} };
    if (/utils\/event/.test(p)) return { removeLocal: () => {} };
    if (/utils\/user/.test(p)) {
      return {
        isModerator: (o) => !!(o && o.openid === 'MOD1'),
        whoami: () => Promise.resolve({ isMod: true }),
        getModerationQueue: () => Promise.resolve({ ok: true, list: [] }),
        appealQueue: () => Promise.resolve({ ok: true, list: [] }),
        protectList: () => Promise.resolve({ ok: true, list: [] }),
        reportArchive: (scope) => {
          archiveCalls.push(scope);
          return Promise.resolve({
            ok: true,
            list: [{ gkey: 'post|p9', confirmed: true, statusText: '已确认违规', reason: '广告骚扰', reasons: [{ name: '广告骚扰', count: 2 }], reportCount: 2, time: '10-18 10:00', title: '代写作业', desc: '', targetType: 'post' }]
          });
        },
        resolveReports: (ids, action) => {
          resolved.push({ ids: ids, action: action });
          return Promise.resolve({ ok: true, handled: ids.length });
        }
      };
    }
    return {};
  };

  const wxStub = {
    showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
    showModal: (o) => { modals.push(o); if (o && o.success) o.success({ confirm: true }); },
    showActionSheet: () => {}, getStorageSync: () => '', setStorageSync: () => {},
    getSetting: () => {}, stopPullDownRefresh: () => {}, setClipboardData: () => {}
  };

  new Function('require', 'module', 'exports', 'Page', 'wx', 'getApp',
    readProj('pages/admin/moderation/moderation.js'))(
    stubRequire, { exports: {} }, {}, (o) => { def = o; }, wxStub, () => ({})
  );
  ok('审核页模块加载得出 Page 定义', !!def && !!def.data);

  const makePage = () => {
    const inst = Object.create(def);
    inst.data = JSON.parse(JSON.stringify(def.data));
    inst.setData = function (d) { Object.assign(this.data, d); };
    return inst;
  };

  // 一条内容被 3 个人举报：勾选应当是 1 个「内容」、3 个「举报 id」
  const p = makePage();
  p.setData({
    isMod: true,
    view: 'pending',
    pending: 1,
    queue: [{
      gkey: 'post|p1', repId: 'r1', repIds: ['r1', 'r2', 'r3'],
      targetId: 'p1', targetType: 'post', reportCount: 3, needMore: 0
    }]
  });

  p.toggleCheck({ currentTarget: { dataset: { key: 'post|p1' } } });
  ok('勾选一条 3 票的内容 → 选中数算 1（不是 3）', p.data.checkedCount === 1, p.data.checkedCount);
  ok('但交上去的是 3 个举报 id（否则只驳回其中一票）', p.data.checked.length === 3, p.data.checked);
  ok('勾选状态按稳定 key 记（wxml 里不能调函数查数组）', p.data.checkedMap['post|p1'] === true);

  p.toggleCheck({ currentTarget: { dataset: { key: 'post|p1' } } });
  ok('再点一次取消：举报 id 全清空', p.data.checked.length === 0, p.data.checked);
  ok('取消后选中数为 0', p.data.checkedCount === 0);

  // 勾选之后点「驳回已选」：一次把 3 个 id 递上去
  p.toggleCheck({ currentTarget: { dataset: { key: 'post|p1' } } });
  p.rejectChecked();
  ok('驳回已选：交的是这一行的全部举报 id',
    resolved.length === 1 && resolved[0].ids.length === 3, resolved);
  await flush();
  ok('驳回后勾选状态清干净',
    p.data.checked.length === 0 && p.data.checkedCount === 0,
    { checked: p.data.checked, checkedCount: p.data.checkedCount });
  ok('确认框说的是「几条内容」而不是「几条举报」（3 张票会让人以为选多了）',
    modals.length > 0 && modals[modals.length - 1].content.indexOf('条内容') >= 0,
    modals.length ? modals[modals.length - 1].content : '');

  // 确认违规：同样要把整行的票一起结掉
  resolved.length = 0;
  const item = { gkey: 'post|p2', repId: 'r9', repIds: ['r9', 'r10'], targetId: 'p2', targetType: 'post' };
  p.confirmOne({ currentTarget: { dataset: { item: item } } });
  ok('确认违规：结掉该内容的全部举报（只结一张会把内容删了却留一堆空票）',
    resolved.length === 1 && resolved[0].ids.length === 2 && resolved[0].action === 'confirm',
    resolved);

  // 视角切换：已处置才去拉归档
  const q = makePage();
  q.setData({ isMod: true, view: 'pending' });
  q.switchView({ currentTarget: { dataset: { view: 'archive' } } });
  ok('切到「已处置」会把视角改过去', q.data.view === 'archive');
  ok('切到「已处置」会去拉归档', archiveCalls.length === 1, archiveCalls);
  q.switchView({ currentTarget: { dataset: { view: 'archive' } } });
  ok('已经在这一屏时再点不重复请求', archiveCalls.length === 1, archiveCalls);

  q.onArchiveScope({ currentTarget: { dataset: { scope: 'confirmed' } } });
  ok('筛选「已确认」按 confirmed 拉', archiveCalls[archiveCalls.length - 1] === 'confirmed', archiveCalls);
  q.onArchiveScope({ currentTarget: { dataset: { scope: 'all' } } });
  ok('筛选「全部」传空串（云端按 in([confirmed, rejected]) 查）',
    archiveCalls[archiveCalls.length - 1] === '', archiveCalls);

  // 不是在审核员时不要白拉一次（云端会拒，白花一次往返）
  const r = makePage();
  r.setData({ isMod: false, view: 'archive' });
  const before = archiveCalls.length;
  r.loadArchive();
  ok('不是审核员时不发归档请求', archiveCalls.length === before, archiveCalls.length - before);
})();

/* ==========================================================================
   五、wxml / wxss：界面真的按新口径渲染
   ========================================================================== */

ok('队列卡片用 gkey 做 key（还按 repId 会在合并后重复 key）',
  /wx:for="\{\{queue\}\}" wx:key="gkey"/.test(MOD_WXML));
ok('勾选框按 gkey 记状态', /checkedMap\[item\.gkey\]/.test(MOD_WXML)
  && /data-key="\{\{item\.gkey\}\}"/.test(MOD_WXML));
ok('不再用 repId 做勾选键', !/data-rep="\{\{item\.repId\}\}"/.test(MOD_WXML));
ok('卡片上显示人数', /item\.reportCount}} 人举报/.test(MOD_WXML));
ok('卡片上显示「差几票自动下架」', /item\.needMore > 0/.test(MOD_WXML));
ok('被保护的内容不显示差票（它根本不会自动下架）', /item\.needMore > 0 && !item\.guarded/.test(MOD_WXML));
ok('底部批量条只在「待处理」这一屏出现',
  /tab === 'reports' && view === 'pending'/.test(MOD_WXML));
ok('批量条计数用内容条数而不是举报张数', /已选 \{\{checkedCount\}\} \/ \{\{pending\}\} 条/.test(MOD_WXML));
ok('有「已处置」视角的渲染块', /已处置归档/.test(MOD_WXML) && /wx:if="\{\{view === 'archive'\}\}"/.test(MOD_WXML));
ok('归档里给了筛选：全部 / 已确认 / 已驳回',
  /data-scope="all"/.test(MOD_WXML) && /data-scope="confirmed"/.test(MOD_WXML) && /data-scope="rejected"/.test(MOD_WXML));
ok('归档空态有说明（不是一片空白）', /还没有处置记录/.test(MOD_WXML));
ok('自动处置说明里写清「人不是次数」',
  /这个人」是人数，不是次数/.test(MOD_WXML) || /这里的「人」是人数/.test(MOD_WXML));
ok('样式里有视角切换条', /\.mod-subseg\s*\{/.test(MOD_WXSS));
ok('样式里有归档筛选条', /\.arc-scope\s*\{/.test(MOD_WXSS));
ok('没有留下不存在的令牌（--r-md / --c-soft 这类）',
  !/var\(--(c-soft|r-md|r-lg|fs-xxl)\)/.test(MOD_WXSS));

/* ---- 登记进全量检查 ---- */
const all = fs.readFileSync(path.join(__dirname, 'check-all.cjs'), 'utf8');
ok('check-all.cjs 里登记了 test-report-votes.cjs', all.indexOf('test-report-votes.cjs') >= 0);

/* ========================================================================== */

// 行为块是异步的（页面的 setData 在 .then 里），所以结论要等它跑完再报
behavior.then(() => {
  if (fails.length) {
    console.log('❌ 失败 ' + fails.length + ' 项 / 通过 ' + pass + ' 项');
    fails.forEach((f) => console.log('   · ' + f));
    process.exit(1);
  }
  console.log('✅ 举报计票与审核队列：' + pass + ' 项全过');
});
