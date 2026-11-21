// test-report.cjs —— 客户端错误上报（utils/report.js + app.js 的三个全局钩子）
//
// 这个测试存在的理由：上报这套东西**错了不会有人发现**。
// 它不参与任何业务流程，写错了既不会白屏也不会报错，只是从此以后
// 真机上的错误一条都收不到 —— 等你想查「为什么同学说点了没反应」时，
// 库是空的，而你已经无从知道它是从哪天开始空的。所以四条纪律各钉一组断言：
//
//   ① 只报意外：空消息 / 重复消息不发出去（否则一次断网能灌满整个集合）
//   ② 指纹合并：前 80 字相同算同一条；换作用域算新的一条
//   ③ 单次封顶：一次启动最多 8 条，超出的留在 console
//   ④ 永不冒泡：云侧抛错 / 拒绝 / 缺接口 / storage 读写失败，都要返回 false 且不抛
//
// 跑法：node scripts/test-report.cjs（工作目录在 recon/ 下）

const fs = require('fs');
const path = require('path');
const Module = require('module');

const APP = path.join(__dirname, '..', 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');

// recon/package.json 是 "type": "module"，Node 22 会把小程序 .js 当 ESM。
// 强制把项目内的 .js 改回 CommonJS 编译。
const origJsExt = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (norm(filename).startsWith(norm(APP))) return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return origJsExt(mod, filename);
};

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}
function eq(name, a, b) { ok(name, a === b, '期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }

const readProj = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

/* ---------------- 替身：拦截 report.js 里的 require ---------------- */

const REPORT = path.join(APP, 'utils', 'report.js');

// ./user.js 替身：记录每次真实发出去的调用，并可按 mode 制造各种失败
const calls = [];
let mode = 'ok'; // ok | throw | reject
const userStub = {
  reportError(scope, msg, extra) {
    calls.push({ scope: scope, msg: msg, extra: extra || {} });
    if (mode === 'throw') throw new Error('云调用同步炸了');
    if (mode === 'reject') return Promise.reject(new Error('云调用异步失败'));
    return Promise.resolve({ ok: true });
  }
};
const realReportError = userStub.reportError;

// ./cloud.js 替身：只有 cfg.USE_CLOUD 被用到
const cloudStub = { cfg: { USE_CLOUD: true } };

const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && norm(parent.filename) === norm(REPORT)) {
    if (/utils[\\/]user\.js$/.test(request) || request === './user.js') return userStub;
    if (/utils[\\/]cloud\.js$/.test(request) || request === './cloud.js') return cloudStub;
  }
  return origLoad.apply(this, arguments);
};

// 每次 fresh() 都是一个全新的「启动」：report.js 的 memSeen / sessionCount 是模块级状态
function fresh() {
  delete require.cache[require.resolve(REPORT)];
  return require(REPORT);
}

/* ---------------- wx 替身 ---------------- */

function makeWx(store, hasBaseInfo) {
  const wx = {
    getStorageSync(k) { return store[k]; },
    setStorageSync(k, v) { store[k] = v; }
  };
  if (hasBaseInfo !== false) wx.getAppBaseInfo = () => ({ SDKVersion: '3.5.5' });
  return wx;
}
const KEY = 'zjgsu_err_fingerprints';
const last = () => calls[calls.length - 1];

(async function () {

/* ============ ① 静默期与指纹（storage 层去重） ============ */

{
  const store = {};
  store[KEY] = {
    'quiet.scope|这条刚报过': Date.now() - 60 * 1000,          // 1 分钟前，还在 30 分钟静默期内
    'old.scope|七小时前': Date.now() - 7 * 60 * 60 * 1000      // 7 小时前，超过 6 小时保留期
  };
  global.wx = makeWx(store);
  calls.length = 0;
  const R = fresh();

  eq('静默期内的同一条被压掉', await R.report('quiet.scope', '这条刚报过'), false);
  eq('被压掉时一个请求都不发', calls.length, 0);
  // 压掉的分支在读表之后就 return 了：既不 prune 也不 write。
  // 这条断言的意义是「被压掉时不应该顺手改动指纹表」，否则高频重复会把写入放大成每次都写
  ok('被压掉时不写指纹表（表还是原来两条）', Object.keys(store[KEY]).length === 2);

  eq('新的错误要发出去', await R.report('s', '第一次'), true);
  eq('发出了 1 条', calls.length, 1);
  const seen = store[KEY];
  ok('过期的指纹被清掉', !('old.scope|七小时前' in seen));
  ok('静默期内的指纹保留着', 'quiet.scope|这条刚报过' in seen);
  ok('新指纹写进表', 's|第一次' in seen);
  eq('指纹表剩 2 条（清掉旧的、留着静默的、加上新的）', Object.keys(seen).length, 2);

  eq('同一条第二次被进程内去重', await R.report('s', '第一次'), false);
  eq('去重之后仍然只发了 1 条', calls.length, 1);

  // 指纹只取前 80 字：消息里带 id / 时间戳时，同一类错误不该每次都算新的
  const long1 = 'A'.repeat(200) + '尾巴一';
  const long2 = 'A'.repeat(200) + '尾巴二';
  eq('长消息第一条发出', await R.report('fp', long1), true);
  eq('只改尾部（前 80 字相同）视为同一条', await R.report('fp', long2), false);
  eq('长消息只发了一条', calls.length, 2);
  eq('上报的 msg 仍是完整的（截断交给云侧）', last().msg, long1);

  eq('换作用域就是新错误', await R.report('other', long1), true);
  eq('换作用域后发了 3 条', calls.length, 3);
}

/* ============ ② 单次启动封顶 ============ */

{
  const store = {};
  global.wx = makeWx(store);
  calls.length = 0;
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));

  const R = fresh();
  let sent = 0;
  for (let i = 0; i < 20; i += 1) {
    if (await R.report('cap', '错误' + i)) sent += 1;
  }
  console.warn = origWarn;

  eq('一次启动最多报 8 条', sent, 8);
  eq('被封顶的一个都不发', calls.length, 8);
  ok('封顶时往 console 留了话（不至于彻底没痕迹）',
    warns.some((w) => w.indexOf('report') >= 0), warns.slice(0, 1));
  eq('8 条指纹都进了表', Object.keys(store[KEY]).length, 8);
}

/* ============ ③ 空消息不上报 ============ */

{
  global.wx = makeWx({});
  calls.length = 0;
  const R = fresh();
  eq('空字符串不上报', await R.report('empty', ''), false);
  eq('null 不上报', await R.report('empty', null), false);
  eq('undefined 不上报', await R.report('empty', undefined), false);
  eq('空消息一个请求都不发', calls.length, 0);
  // 空消息连指纹都不该写：断网时 errMsg 可能是空串，这类会把表冲淡
  eq('空消息不写指纹表', calls.length, 0);
}

/* ============ ④ 各种错误形态都要读出人话 ============ */

{
  global.wx = makeWx({});
  calls.length = 0;
  const R = fresh();

  await R.report('t', '直接是字符串');
  eq('字符串原样上报', last().msg, '直接是字符串');

  await R.report('t', { errMsg: 'cloud.callFunction:fail timeout' });
  eq('微信失败回调取 errMsg', last().msg, 'cloud.callFunction:fail timeout');

  await R.report('t', { message: '炸了' });
  eq('普通对象取 message', last().msg, '炸了');

  await R.report('t', { errMsg: 'x:fail 优先', message: '其次' });
  eq('errMsg 优先于 message', last().msg, 'x:fail 优先');

  await R.report('t', new Error('真 Error'));
  eq('Error 取 message', last().msg, '真 Error');
  ok('Error 带上了 stack', typeof last().extra.stack === 'string' && last().extra.stack.length > 0);
  ok('stack 截在 300 字以内（整段存一条能占几 KB）', last().extra.stack.length <= 300,
    last().extra.stack && last().extra.stack.length);
  eq('附带基础库版本', last().extra.sdk, '3.5.5');

  await R.report('t', '带附加信息', { page: 'campus', postId: 'p1' });
  eq('extra 合并进去了', last().extra.page, 'campus');
  eq('extra 多个字段都在', last().extra.postId, 'p1');
  eq('extra 不会盖掉 stack/sdk', last().extra.sdk, '3.5.5');
}

/* ============ ⑤ 上报自己绝不能出错（第四条纪律） ============ */

{
  global.wx = makeWx({});

  mode = 'throw';
  calls.length = 0;
  const R1 = fresh();
  let threw = false;
  let ret = null;
  try { ret = await R1.report('boom', '云侧同步抛错'); } catch (e) { threw = true; }
  ok('云侧同步抛错时不往外冒', !threw);
  eq('同步抛错返回 false', ret, false);

  mode = 'reject';
  const R2 = fresh();
  eq('云侧 Promise 失败也只返回 false', await R2.report('boom2', '云侧异步失败'), false);

  // 云函数还是旧版（没有 reportError 这个 action）时，不能因为上报把页面也拖挂
  userStub.reportError = undefined;
  const R3 = fresh();
  eq('云侧缺这个接口时也不炸', await R3.report('boom3', '缺 reportError'), false);
  userStub.reportError = realReportError;
  mode = 'ok';
}

/* ============ ⑥ storage 不可用也要报得出去 ============ */

{
  global.wx = {
    getStorageSync() { throw new Error('存储满了'); },
    setStorageSync() { throw new Error('存储满了'); },
    getAppBaseInfo: () => ({ SDKVersion: '3.5.5' })
  };
  calls.length = 0;
  const R = fresh();
  eq('storage 读不了也要发得出去', await R.report('nostore', '存储坏了'), true);
  eq('storage 读不了时确实发了 1 条', calls.length, 1);
  // 同一条第二次：读不到表，只能靠进程内去重兜住
  eq('读不到表时靠进程内去重兜底', await R.report('nostore', '存储坏了'), false);
}

// 老基础库没有 getAppBaseInfo：不能因此把整条上报丢掉
{
  global.wx = makeWx({}, false);
  calls.length = 0;
  const R = fresh();
  eq('基础库接口缺失不影响上报', await R.report('nosdk', '没有 getAppBaseInfo'), true);
  eq('拿不到版本号就留空（不能是 undefined）', last().extra.sdk, '');
}

/* ============ ⑦ reportIfCloud ============ */

{
  global.wx = makeWx({});
  cloudStub.cfg = { USE_CLOUD: false };
  calls.length = 0;
  const R = fresh();
  eq('云模式关着就不报', await R.reportIfCloud('cloud', '只在云模式下才值得看'), false);
  eq('云模式关着一个请求都不发', calls.length, 0);

  cloudStub.cfg = { USE_CLOUD: true };
  eq('云模式开着照常报', await R.reportIfCloud('cloud', '只在云模式下才值得看'), true);
  eq('云模式开着发了 1 条', calls.length, 1);
  cloudStub.cfg = { USE_CLOUD: true };
}

/* ============ ⑧ 静默期过了要能再报一次 ============ */

{
  const store = {};
  store[KEY] = { 'again|三十一分钟前报过': Date.now() - 31 * 60 * 1000 };
  global.wx = makeWx(store);
  calls.length = 0;
  const R = fresh();
  eq('过了 30 分钟静默期可以再报一次', await R.report('again', '三十一分钟前报过'), true);
  eq('确实又发了一条', calls.length, 1);
}

/* ============ ⑨ 静态：纪律不能被人顺手改掉 ============ */

{
  const src = readProj('utils/report.js');
  const appSrc = readProj('app.js');
  const campusSrc = readProj('pages/campus/campus.js');

  ok('导出 report', /report[,}]/.test(src) && /module\.exports\s*=/.test(src));
  ok('导出 reportIfCloud', src.indexOf('reportIfCloud') >= 0);

  // 上报不能弹任何东西：用户已经遇到一个错误了，不能因为上报再给他弹一个
  ok('report.js 里没有 showToast', src.indexOf('showToast') < 0);
  ok('report.js 里没有 showModal', src.indexOf('showModal') < 0);
  ok('report.js 里没有 require feedback（feedback 会弹提示）', src.indexOf("require('./feedback.js')") < 0);
  ok('report.js 自己不抛异常', !/\bthrow\b/.test(src));

  ok('有 30 分钟静默期', /QUIET_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/.test(src));
  ok('有 6 小时指纹保留期', /KEEP_MS\s*=\s*6\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(src));
  ok('单次启动封顶 8 条', /MAX_PER_SESSION\s*=\s*8/.test(src));
  ok('指纹只取前 80 字', /slice\(0,\s*80\)/.test(src));

  // app.js 三个全局钩子
  ok('app.js 引入了 utils/report.js', appSrc.indexOf("require('./utils/report.js')") >= 0);
  ok('app.js 接了 onError', /onError\(msg\)\s*\{[\s\S]{0,120}report\.report\(/.test(appSrc));
  ok('app.js 接了 onUnhandledRejection',
    /onUnhandledRejection\(res\)\s*\{[\s\S]{0,160}report\.report\(/.test(appSrc));
  ok('app.js 接了 onPageNotFound',
    /onPageNotFound\(res\)\s*\{[\s\S]{0,200}report\.report\(/.test(appSrc));
  ok('onUnhandledRejection 取的是 reason（不是整个 res 对象）',
    /report\.report\(\s*'app\.unhandledRejection',\s*\(res && res\.reason\) \|\| res/.test(appSrc));

  // 「云端版本落后要上报」由 scripts/check-build-fingerprint.cjs 静态钉住、
  // 由 scripts/test-campus-jobfair.cjs 在运行时钉住，这里不重复第三遍
  ok('campus.js 引入了 utils/report.js', campusSrc.indexOf("require('../../utils/report.js')") >= 0);

  // 自己别被漏跑：没登记进 check-all 的话，这个测试等于不存在
  const all = fs.readFileSync(path.join(__dirname, 'check-all.cjs'), 'utf8');
  ok('check-all.cjs 里登记了 test-report.cjs', all.indexOf('test-report.cjs') >= 0);
}

/* ---------------- 汇总 ---------------- */

console.log('通过 ' + pass + ' 项');
if (fails.length) {
  console.log('\n失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('全部通过');
})();
