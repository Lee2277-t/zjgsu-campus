/* 内容保护 + 限时置顶 行为测试
 *
 * 这两个功能的共同点是「坏起来不报错」：
 *  - 保护没生效 → 内容照旧被几个人举报到自动下架，运营以为护住了；
 *  - 置顶到期没失效 → 一条去年的公告一直顶着，管理页还说「没人置顶」；
 *  - 保护顺手挡住了人工审核 → 违规内容删不掉，这是最危险的一种「修好了」。
 *
 * 所以测的是「判定发生在哪一层、有没有越界」，不是界面长得对不对：
 *
 *   A. 保护在判定层短路，且只降级 delete / hide
 *   B. 保护挡不住人工处置（这是设计意图，不是漏洞）
 *   C. 保护表的读写：只审核员可写、独立集合、自带标题快照
 *   D. 限时置顶：存绝对时间戳、上限一年、取消时清零
 *   E. 到期失效有两条路：读侧 pinAliveNow + 定时 pinSweep
 *   F. 前端交互：时长预设不超 actionSheet 上限、保护开关走字符串
 *   G. 可执行断言：pinAliveNow 的真实判定
 *
 * 用法：node scripts/test-protect-pin.cjs
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');

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
function fnBody(src, name) {
  const re = new RegExp('(?:async )?function ' + name + '\\s*\\([\\s\\S]*?\\n\\}\\n', 'm');
  const m = re.exec(src);
  return m ? m[0] : '';
}

const CF = readCloud();

/* ============ A. 保护在判定层短路 ============ */
console.log('A. 保护：判定层短路，且只降级 delete / hide');
{
  const decide = fnBody(CF, 'decideAction');
  const decideComment = fnBody(CF, 'decideCommentAction');

  ok('decideAction 会查保护', /isProtected\(targetType, targetId\)/.test(decide));
  // 2026-10-18.5：自动处置只剩「下架」一档，删除全部人工，所以降级只可能是 hide
  ok('降级只吃 hide（现在没有 delete 可降了）',
    /cap\s*=\s*\(a\)\s*=>\s*\(guarded && a === 'hide' \? '' : a\)/.test(decide));
  ok('return 用 cap(action)（漏了它等于保护形同虚设）',
    (decide.match(/action: cap\(action\)/g) || []).length === 1, (decide.match(/action: cap\(action\)/g) || []).length);
  ok('返回体带 guarded 与 rawAction（前端文案要分清「本来就不够格」和「被保护挡住」）',
    /guarded: !!guarded, rawAction: action/.test(decide));
  ok('保护文案覆盖所有保护内容，并说明不进普通审核队列',
    /if \(verdict\.guarded\)[\s\S]{0,220}不会进入普通审核队列/.test(CF));
  // 留言不再自动处置（删除一律人工），所以留言侧根本不需要「保护」这道闸 ——
  // 这比「保护住了」更彻底：没有任何自动删除能绕过它
  ok('留言侧不存在自动删除（恒返回 del: false）',
    /del: false,/.test(decideComment) && !/del = true/.test(decideComment));
  ok('保护状态没写进帖子正文（posts 所有人可读，写进去等于公布管理员名单）',
    !/data:\s*\{\s*(?:guarded|protected|protect):/.test(CF));
  ok('保护表是独立集合', /const COL_PROTECTS = 'content_protects'/.test(CF));
  ok('主键统一拼，不吃 targetType 的任意值',
    /function protectKey\(targetType, targetId\)[\s\S]{0,160}'comment' : 'post'/.test(CF));
}

/* ============ B. 保护挡不住人工 ============ */
console.log('B. 保护不会把违规内容变成免检');
{
  // 人工处置的入口：确认违规（resolveReports）、审核页删留言（commentRemove）、
  // 手动下架/恢复（setContentStatus）、删除内容（delContent）。
  // 它们的函数体里都不该出现 isProtected —— 保护只挡系统自动动手，
  // 万一有人把它也接到人工链路上，违规内容就再也删不掉了
  ['resolveReports', 'commentRemove', 'setContentStatus', 'delContent'].forEach((fn) => {
    const body = fnBody(CF, fn);
    ok('人工处置 ' + fn + ' 不受保护影响', !!body && !/isProtected/.test(body));
  });
}

/* ============ C. 保护表的读写 ============ */
console.log('C. 保护表：权限、快照、幂等');
{
  const ps = fnBody(CF, 'protectSet');
  const pl = fnBody(CF, 'protectList');
  ok('protectSet 先验审核员身份', /if \(!\(await isModerator\(openid\)\)\)/.test(ps));
  ok('关掉保护不要求对象还存在（内容被删了也得能清掉那条记录）',
    /if \(!on\)[\s\S]{0,200}\.remove\(\)/.test(ps));
  ok('打开保护要求对象存在', /if \(!c \|\| c\.removed\) return \{ ok: false/.test(ps));
  ok('记录里存标题快照（内容以后被删，列表里还看得出护的是哪条）',
    /title: String\(c\.content \|\| '\[图片留言\]'\)\.slice\(0, 60\)/.test(ps) && /title: String\(p\.title \|\| ''\)\.slice\(0, 60\)/.test(ps));
  ok('写保护用 doc(key).set（幂等，重复保护不会叠加记录）',
    /doc\(protectKey\(targetType, targetId\)\)[\s\S]{0,40}\.set\(\{ data: doc \}\)/.test(ps));
  ok('protectList 只给审核员', /protectList[\s\S]{0,120}isModerator\(openid\)/.test(pl + CF.slice(0, 0)) || /async function protectList\(openid\) \{\s*\n\s*if \(!\(await isModerator\(openid\)\)\)/.test(CF));
  ok('每一条保护都写审核日志（谁护的、为什么护）', /logMod\(openid, 'protect'/.test(ps) && /logMod\(openid, 'unprotect'/.test(ps));
}

/* ============ D. 限时置顶 ============ */
console.log('D. 限时置顶：绝对时间戳 + 上限 + 清零');
{
  const pin = fnBody(CF, 'postPin');
  ok('存的是毫秒时间戳而不是天数（改规则不会改写历史决定）',
    /let pinUntil = Number\(payload\.until\) \|\| 0/.test(pin));
  ok('截止时间必须晚于现在', /if \(pinUntil <= nowMs\) return \{ ok: false/.test(pin));
  ok('最长一年', /PIN_MAX_DAYS = 365/.test(CF) && /最多置顶 ' \+ PIN_MAX_DAYS \+ ' 天/.test(pin));
  ok('置顶写入带 pinUntil', /pinned: true, pinnedAt: nowMs, pinUntil: pinUntil/.test(pin));
  ok('取消置顶同时清 pinUntil（留着会让下次置顶莫名带着旧期限）',
    (pin.match(/pinned: false, pinnedAt: 0, pinUntil: 0/g) || []).length >= 2);
  ok('并发超限回滚时也清 pinUntil',
    (pin.match(/pinUntil: 0/g) || []).length >= 3,
    (pin.match(/pinUntil: 0/g) || []).length);
  ok('审计日志记下到期日', /限时置顶至 /.test(pin));
}

/* ============ E. 到期失效两条路 ============ */
console.log('E. 到期：读侧判定 + 定时清理');
{
  const sweep = fnBody(CF, 'pinSweep');
  const timer = fnBody(CF, 'runTimerSync');
  ok('pinSweep 只捞「有 pinUntil 且已过期」的', /pinned: true, pinUntil: _\.gt\(0\)\.and\(_\.lte\(nowMs\)\)/.test(sweep));
  ok('pinSweep 逐条写，不用批量 update（避免条件偏差时误清没到期的）',
    /for \(const p of rows\)[\s\S]{0,600}\.doc\(p\._id\)[\s\S]{0,120}update\(/.test(sweep));
  ok('清理挂在已有的每日定时里（不新开 timer，省一次配额）',
    /pins = await pinSweep\(\)/.test(timer) && /pinSweep: pins/.test(timer));
  ok('定时器默认入口会走到 runTimerSync', /event\.Type === 'Timer'/.test(CF));

  const forum = readProj(path.join('utils', 'store-forum.js'));
  ok('读侧 decoratePost 用 pinAliveNow', /pinned: pinAliveNow\(p\)/.test(forum));
  ok('pinAliveNow 把 0 当永久', /until === 0 \|\| until > Date\.now\(\)/.test(forum));
  ok('名片页也算同一个判断（否则论坛掉了、名片还挂着徽标）',
    /pinned: store\.pinAliveNow\(p\)/.test(readProj(path.join('pages', 'user', 'card', 'card.js'))));
  ok('setPostPinned 把 until 透到云端', /postPin\(postId, !!pinned, u\)/.test(forum));
}

/* ============ F. 前端交互 ============ */
console.log('F. 前端交互');
{
  const js = readProj(path.join('pages', 'admin', 'moderation', 'moderation.js'));
  const wxml = readProj(path.join('pages', 'admin', 'moderation', 'moderation.wxml'));
  ok('未置顶给 6 个时长选项（actionSheet 上限就是 6）',
    /\['置顶 1 天', '置顶 2 天', '置顶 7 天', '置顶 30 天', '置顶 90 天', '永久置顶'\]/.test(js));
  ok('已置顶只给 5 项（取消 + 四个改期）',
    /\['取消置顶', '改为 1 天', '改为 7 天', '改为 30 天', '改为永久'\]/.test(js));
  ok('改期不被自己的名额挡住', /只有「从未置顶变成置顶」才占名额/.test(js));
  ok('保护开关用字符串传（布尔经 dataset 会变 \'false\' 这种真值）',
    /data-on="\{\{item\.guarded \? '0' : '1'\}\}"/.test(wxml) && /String\(d\.on\) !== '0'/.test(js));
  ok('保护前弹确认，并写明举报留痕但不进普通队列', /不会进入普通审核队列/.test(js));
  ok('举报卡文案认留言类型', /item\.targetType === 'comment' \? '留言'/.test(wxml));
  ok('置顶行显示到期时间', /class="pin-expire"/.test(wxml));
  ok('有「已保护」总清单，且能解除', /已保护（\{\{protect\.length\}\}）/.test(wxml) && /catchtap="toggleProtect"/.test(wxml));
  ok('markGuarded 支持显式传 protect（避开 setData 时序）',
    /markGuarded\(list, protect\)/.test(js));
}

/* ============ G. 可执行：pinAliveNow ============ */
console.log('G. pinAliveNow 真实判定');
{
  const forum = require(path.join(PROJ, 'utils', 'store-forum.js'));
  ok('未置顶 → false', forum.pinAliveNow({ pinned: false }) === false);
  ok('空对象 → false', forum.pinAliveNow(null) === false);
  ok('永久置顶（pinUntil 缺省）→ true', forum.pinAliveNow({ pinned: true }) === true);
  ok('永久置顶（pinUntil = 0）→ true', forum.pinAliveNow({ pinned: true, pinUntil: 0 }) === true);
  ok('未到期 → true', forum.pinAliveNow({ pinned: true, pinUntil: Date.now() + 3600e3 }) === true);
  ok('已过期 → false', forum.pinAliveNow({ pinned: true, pinUntil: Date.now() - 1000 }) === false);
}

console.log('\n通过 ' + pass + ' 项' + (fail ? '，失败 ' + fail + ' 项' : '，全部通过'));
process.exit(fail ? 1 : 0);
