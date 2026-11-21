// scripts/test-report-thresholds.cjs —— 举报门槛（按浏览量分档）的守门测试
//
// 这一轮改了两件容易被改回去的事，都得有人盯着：
//
// 一、门槛不再是一个固定数字。固定「3 个人举报就下架」惩罚的是「火」而不是「坏」：
//     8 个人看过被 3 人举报是 37%，800 个人看过被 3 人举报是 0.4%。
//     现在按**独立浏览人数**分档（0-49 → 3、50-199 → 5、200-499 → 7、500+ → 10）。
//     边界写错一个数字，全网的下架速度就变了，而且**不会报任何错**。
//
// 二、系统只下架、不删除。删除不可逆，而被误删的原文正是作者申诉、被举报人举证时
//     唯一的凭据。所以哪怕将来有人觉得「人多就该删」，也得先看这段注释。
//
// 跑法：node scripts/test-report-thresholds.cjs（工作目录在 recon/ 下）

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
const RULES_SRC = readProj('cloudfunctions/user/report-rules.js');
const USER_JS = userApiText;
const POST_DETAIL = readProj('sub/forum/detail/detail.js');
const MARKET_DETAIL = readProj('sub/market/detail/detail.js');
const EVENT_DETAIL = readProj('sub/campus/event/event.js');
const MOD_WXML = readProj('pages/admin/moderation/moderation.wxml');
const CONFIG = readProj('utils/config.js');

/* ==========================================================================
   一、分档表本身（真的跑，不扫源码）
   ========================================================================== */

// 小程序侧是 CommonJS，但 recon/package.json 是 "type":"module"，
// 直接 require 会报 module is not defined —— 只能跟 report-votes.js 一样手工装载
function loadRules() {
  const mod = { exports: {} };
  new Function('module', 'exports', RULES_SRC)(mod, mod.exports);
  return mod.exports;
}
const R = loadRules();

// 边界：每一档的「最后一个落点」和「第一个下一个档的落点」都要对。
// 这些数字是刻意选的 —— 49/50、199/200、499/500 各是一对，
// 改表的时候最容易在这三处差一
const CASES = [
  [0, 3], [1, 3], [12, 3], [49, 3],
  [50, 5], [120, 5], [199, 5],
  [200, 7], [350, 7], [499, 7],
  [500, 10], [2000, 10], [50000, 10]
];
CASES.forEach(([views, need]) => {
  ok('浏览 ' + views + ' 人 → 需要 ' + need + ' 人举报',
    R.hideNeed(views) === need, R.hideNeed(views));
});

// 自动筛除必须保守：只有单票、无说明、非高敏、无屏蔽词命中才归档。
ok('单票无说明低敏举报自动筛除', R.shouldAutoDismiss({ total: 1, blocked: false, highRisk: false, reporterLimited: false, detail: '' }) === true);
ok('带可核实说明的单票仍进人工', R.shouldAutoDismiss({ total: 1, blocked: false, highRisk: false, reporterLimited: false, detail: '附了截图和链接' }) === false);
ok('高敏理由即使单票也进人工', R.shouldAutoDismiss({ total: 1, blocked: false, highRisk: true, reporterLimited: false, detail: '' }) === false);
ok('屏蔽词命中不自动归档', R.shouldAutoDismiss({ total: 1, blocked: true, highRisk: false, reporterLimited: false, detail: '' }) === false);
ok('多人举报不自动归档', R.shouldAutoDismiss({ total: 2, blocked: false, highRisk: false, reporterLimited: false, detail: '' }) === false);

// 脏输入不能把门槛算成 0 或 NaN —— 那等于「一个举报就下架」
[NaN, undefined, null, -5, 'abc', {}].forEach((bad) => {
  ok('脏输入（' + String(bad) + '）按 0 处理，落到最低档 3 人',
    R.hideNeed(bad) === 3, R.hideNeed(bad));
});

// 单调：看的人越多，要求的人只可能更多，不可能更少
let prev = 0;
let mono = true;
for (let v = 0; v <= 3000; v += 1) {
  const n = R.hideNeed(v);
  if (n < prev) { mono = false; break; }
  prev = n;
}
ok('门槛随浏览量单调不减（不会出现「看得越多越容易被下架」）', mono);

// 下限 3：两个人凑一起就能藏任何内容，是这次改动唯一不能碰的底线
let floorOk = true;
for (let v = 0; v <= 200; v += 1) if (R.hideNeed(v) < 3) floorOk = false;
ok('任何浏览量下门槛都不低于 3 人（两人合谋藏不掉任何内容）', floorOk);

// 上限 10：再火的内容也不能要求「无限多的人」，否则热门违规内容等于免检
let capOk = true;
for (let v = 500; v <= 100000; v += 500) if (R.hideNeed(v) > 10) capOk = false;
ok('门槛封顶 10 人（热门内容不会因为「要的人太多」而永远下不掉）', capOk);

// 分档表本身：四档、上界递增
ok('分档表是 4 档', Array.isArray(R.VIEW_TIERS) && R.VIEW_TIERS.length === 4,
  R.VIEW_TIERS && R.VIEW_TIERS.length);
ok('最后一档上界是 Infinity（兜住所有更大的浏览量）',
  R.VIEW_TIERS[R.VIEW_TIERS.length - 1].max === Infinity);

// 审核员看的那句话要带分母：只说「差 3 人」会被误读成「没人管」
ok('describeTier 带浏览量与门槛', /人看过.*需.*人举报/.test(R.describeTier(320)), R.describeTier(320));
ok('没有浏览数据时说清楚「按最低档算」', /暂无浏览数据/.test(R.describeTier(0)), R.describeTier(0));

/* ---- 用规则模拟一次判定：三条举报在不同曝光下结果不同 ---- */
function wouldHide(views, voices) { return voices >= R.hideNeed(views); }
ok('12 人看过 + 3 人举报 → 下架（本来就没几个人看，三个人说不行够重了）',
  wouldHide(12, 3) === true);
ok('300 人看过 + 3 人举报 → 不下架（这是「火帖被三个人搞掉」那一类）',
  wouldHide(300, 3) === false);
ok('300 人看过 + 7 人举报 → 下架', wouldHide(300, 7) === true);
ok('900 人看过 + 7 人举报 → 不下架（热门内容要 10 个人）', wouldHide(900, 7) === false);
ok('900 人看过 + 10 人举报 → 下架', wouldHide(900, 10) === true);

/* ==========================================================================
   二、云函数：分母怎么算、判定怎么用
   ========================================================================== */

const countDoc = (CLOUD.match(/async function countViews\([\s\S]*?\n}\n/) || [''])[0];
ok('有 countViews', !!countDoc);
ok('分母排除作者本人（他自己反复打开不算观众）',
  /db\.command\.neq\(who\)/.test(countDoc), countDoc.slice(0, 80));
ok('分母从 content_views 数（不是帖子文档上的一个计数器，客户端改不了）',
  /COL_VIEWS\)\.where\(where\)\.count\(\)/.test(countDoc));
ok('读不到浏览量时回 0（→ 最低档 3 人，也就是改造前的原始门槛）',
  /\(res && Number\(res\.total\)\) \|\| 0/.test(countDoc));

const viewDoc = (CLOUD.match(/async function contentView\(openid, payload\)[\s\S]*?\n}\n/) || [''])[0];
ok('有 contentView 动作', !!viewDoc);
ok('浏览按 openid 去重（同一个人刷新十次只算一次）',
  /targetType \+ '_' \+ targetId \+ '_' \+ String\(openid/.test(viewDoc));
ok('_id 撞上就当作「看过了」，不是错误',
  /catch \(e\) \{\s*\n\s*\/\/ 撞主键/.test(viewDoc));
ok('openid 由服务端上下文取，不吃客户端传的（否则能刷分母）',
  /contentView\(openid, event\)/.test(CLOUD) && !/payload\.openid/.test(viewDoc));
ok('contentView 在 action 分发里注册了',
  /case 'contentView':\s*\n\s*return contentView\(openid, event\)/.test(CLOUD));

ok('decideAction 用 countViews 算分母', /const views = await countViews\(targetType, targetId, content\.openid\)/.test(CLOUD));
ok('decideAction 用 hideNeed 算门槛', /const need = hideNeed\(views\)/.test(CLOUD));
ok('举报回执里带 views / need（前端能说清「还差几个人」）',
  /views: verdict\.views \|\| 0,\s*\n\s*need: verdict\.need \|\| 0/.test(CLOUD));
ok('没到门槛时告诉举报人还差几个',
  /还差 '[\s\S]{0,40}verdict\.need - verdict\.total/.test(CLOUD));

/* ==========================================================================
   三、前端：三个详情页都要上报，否则分母永远是 0
   ========================================================================== */

ok('utils/user.js 导出 contentView', /contentView,/.test(USER_JS));
ok('utils/user.js 调的是 contentView 动作', /call\('contentView'/.test(USER_JS));
ok('帖子详情页上报浏览', /userApi\.contentView\('post', this\.data\.id\)/.test(POST_DETAIL));
ok('闲置详情页上报浏览', /userApi\.contentView\('market', this\.id\)/.test(MARKET_DETAIL));
ok('活动详情页上报浏览', /userApi\.contentView\('event', this\.data\.id\)/.test(EVENT_DETAIL));
ok('上报失败静默（记浏览失败不该影响看内容）',
  /contentView\('post'[\s\S]{0,400}\.catch\(\(\) => \{\}\)/.test(POST_DETAIL));

// 浏览人数要让「别人」看得到。它走的是云函数返回值，跟 content_views 的集合权限
// 没有关系 —— 所以这三条一旦只上报不显示，功能就白做了（上报了却谁都看不见）
ok('帖子详情页显示浏览人数', /\{\{viewsText\}\}/.test(readProj('sub/forum/detail/detail.wxml')));
ok('闲置详情页显示浏览人数', /\{\{viewsText\}\}/.test(readProj('sub/market/detail/detail.wxml')));
ok('活动详情页显示浏览人数', /\{\{viewsText\}\}/.test(readProj('sub/campus/event/event.wxml')));
ok('三个页面都收下云函数回的浏览数', [POST_DETAIL, MARKET_DETAIL, EVENT_DETAIL].every(
  (s) => /const v = Number\(r && r\.views\) \|\| 0;/.test(s)));

// 门槛存在的唯一目的是「冷启动期别显示小数字」。它是产品判断，不是实现细节：
// 一条内容写「3 人看过」，读者读到的是「这个平台没人」
ok('门槛常量定义在 config（三页共用一个数，不是各写一遍）',
  /VIEW_SHOW_MIN:\s*50\b/.test(CONFIG), (CONFIG.match(/VIEW_SHOW_MIN:\s*\d+/) || [''])[0]);
ok('三个页面都用这个门槛，不各自写死数字', [POST_DETAIL, MARKET_DETAIL, EVENT_DETAIL].every(
  (s) => /if \(v >= config\.VIEW_SHOW_MIN\)/.test(s)
    && !/if \(v >= \d+\)/.test(s)));
ok('门槛以下什么都不写（不是写个「0 人看过」）',
  [POST_DETAIL, MARKET_DETAIL, EVENT_DETAIL].every((s) => /viewsText: ''/.test(s)));

// 作者自己打开自己的内容，不该把自己算进「几个人看过」——
// 否则刚发完帖的人看到的第一句话是「1 人看过」，那个 1 就是他自己
ok('contentView 先取作者，再按作者排除着数',
  /const content = await fetchTarget\(targetType, targetId\);[\s\S]{0,300}await countViews\(targetType, targetId, author\)/.test(CLOUD));
ok('没有把 countViews 的第三个参数退回空串（那等于不排除作者）',
  !/countViews\(targetType, targetId, ''\)/.test(CLOUD));
ok('审核队列卡片显示分母与门槛',
  /item\.views.*人看过.*item\.hideAt/.test(MOD_WXML),
  (MOD_WXML.match(/差 \{\{item\.needMore\}\}[^<]*/) || [''])[0]);

/* ==========================================================================
   四、审核页的规则说明不能继续说旧规则
   ========================================================================== */

ok('审核页不再写「5 人举报 → 直接删除」', !/5 人举报<\/text> → 直接删除/.test(MOD_WXML));
ok('审核页写明「系统只下架，不删除」', /系统只下架，不删除/.test(MOD_WXML));
ok('审核页写明四档门槛', /0-49 人看过/.test(MOD_WXML) && /500 人以上看过/.test(MOD_WXML));
ok('审核页不再提冷启动降档（那套已经删了）', !/冷启动期/.test(MOD_WXML));

/* ---- 汇总 ---- */
if (fails.length) {
  console.log('\n✗ test-report-thresholds: ' + fails.length + ' 项失败 / ' + (pass + fails.length) + ' 项');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('✓ test-report-thresholds: ' + pass + ' 项全部通过');
