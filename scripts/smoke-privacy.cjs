/**
 * 冒烟：隐私授权弹窗（utils/privacy.js + components/ui/privacy-modal）
 *
 * 背景：原来只在 App.onLaunch 阶段用 wx.showModal 被动弹窗，
 * 页面还没渲染完弹窗经常被吞 —— 用户看到「提示要确定隐私协议，却没地方点同意」。
 * 现在改成：进入首页主动申请 + 由组件承载真正的弹窗。
 *
 * 这里验证的核心不变式：**任何情况下都必须回调 resolve**。
 * 不回调 = 触发授权的那个接口（选图 / 选文件）永久挂起 = 用户看到「点了没反应」。
 *
 * 用法：node scripts/smoke-privacy.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram', 'zjgsu-campus');

function loadFile(abs, wxStub) {
  const code = fs.readFileSync(abs, 'utf8');
  const module = { exports: {} };
  const dir = path.dirname(abs);
  const req = (p) => (p.startsWith('.') ? loadFile(path.resolve(dir, p), wxStub) : {});
  const fn = new Function('module', 'exports', 'wx', 'require', 'console', code);
  fn(module, module.exports, wxStub, req, console);
  return module.exports;
}

let all = true;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) all = false;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + ' => ' + JSON.stringify(got) + (ok ? '' : ' (期望 ' + JSON.stringify(want) + ')'));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每个用例都要一份干净的环境：needAuthHook 是「微信回调过来」的入口
function makeEnv() {
  const env = {
    need: true,
    hook: null,
    authOpts: [],
    modals: [],
    toasts: [],
    contract: 0,
    probe: 0,
    autoAuth: false // true = 授权接口立刻 success（否则要手动触发，Promise 会一直挂着）
  };
  env.wx = {
    onNeedPrivacyAuthorization: (cb) => { env.hook = cb; },
    getPrivacySetting: (o) => {
      env.probe += 1;
      if (o && o.success) {
        o.success({ needAuthorization: env.need, privacyContractName: '用户隐私保护指引' });
      }
    },
    requirePrivacyAuthorize: (o) => {
      env.authOpts.push(o);
      if (env.autoAuth && o && o.success) o.success({});
    },
    showModal: (o) => { env.modals.push(o); },
    showToast: (o) => { env.toasts.push(o && o.title); },
    openPrivacyContract: () => { env.contract += 1; }
  };
  env.load = () => loadFile(path.join(ROOT, 'utils', 'privacy.js'), env.wx);
  return env;
}

/* 1. 有组件挂载：授权请求交给组件，用户表态后必须回调 resolve */
async function testWithComponent() {
  const env = makeEnv();
  const priv = env.load();
  priv.setup();

  let shown = null;
  priv.onAsk((name) => { shown = name; });

  const resolved = [];
  env.hook((v) => resolved.push(v));   // 微信把 resolve 交给我们
  await sleep(20);                      // 等 getPrivacyName() 的 Promise

  eq('1.1 组件收到弹窗通知', shown, '用户隐私保护指引');
  eq('1.2 未表态时不回调 resolve（等用户）', resolved.length, 0);
  eq('1.3 isAsking 为真', priv.isAsking(), true);
  eq('1.4 pendingName 可取到协议名', priv.pendingName(), '用户隐私保护指引');

  priv.answer(true);
  eq('1.4 同意后回调了 resolve', resolved.length, 1);
  eq('1.5 同意是无参 resolve', resolved[0] === undefined, true);
  eq('1.6 表态后不再 asking', priv.isAsking(), false);
}

/* 2. 用户拒绝 */
async function testDeny() {
  const env = makeEnv();
  const priv = env.load();
  priv.setup();
  priv.onAsk(() => {});

  const resolved = [];
  env.hook((v) => resolved.push(v));
  await sleep(20);

  priv.answer(false);
  eq('2.1 拒绝时回调 resolve', resolved.length, 1);
  eq('2.2 拒绝带 cancel 回执', resolved[0] && resolved[0].eventType, 'cancel');
}

/* 3. 最危险的场景：组件没挂载（从别的页面触发）时必须兜底，绝不能把请求晾着 */
async function testFallback() {
  const env = makeEnv();
  const priv = env.load();
  priv.setup();
  // 故意不注册 onAsk

  const resolved = [];
  env.hook((v) => resolved.push(v));
  await sleep(20);

  eq('3.1 没有组件时退回系统弹窗', env.modals.length, 1);
  eq('3.2 系统弹窗有可读内容', String(env.modals[0].content).indexOf('用户隐私保护指引') >= 0, true);
  eq('3.3 此时还没回调 resolve', resolved.length, 0);

  env.modals[0].success({ confirm: true });  // 用户在系统弹窗点「同意并继续」
  eq('3.4 点同意后照样回调 resolve', resolved.length, 1);

  // 系统弹窗本身调用失败也不能卡住
  const env2 = makeEnv();
  const priv2 = env2.load();
  priv2.setup();
  const r2 = [];
  env2.hook((v) => r2.push(v));
  await sleep(20);
  env2.modals[0].fail({ errMsg: 'showModal:fail' });
  eq('3.5 弹窗调用失败也会回调（不留悬挂请求）', r2.length, 1);
}

/* 4. 主动申请：进入小程序就问一次 */
async function testRequireIfNeeded() {
  const env = makeEnv();
  const priv = env.load();
  priv.setup();
  priv.onAsk(() => {});

  const p = priv.requireIfNeeded();
  await sleep(10);
  eq('4.1 需要授权时触发了授权接口', env.authOpts.length, 1);
  eq('4.2 授权请求通过微信回调弹窗', env.hook !== null, true);

  env.authOpts[0].success();
  eq('4.3 用户同意 → true', await p, true);

  // 本来就已授权：不该打扰
  const env2 = makeEnv();
  env2.need = false;
  const priv2 = env2.load();
  priv2.setup();
  const ok = await priv2.requireIfNeeded();
  eq('4.4 已授权时直接放行', ok, true);
  eq('4.5 已授权时不弹窗', env2.authOpts.length, 0);
}

/* 5. askOnEnter 幂等：切 tab 回来不反复烦人 */
async function testAskOnEnterOnce() {
  const env = makeEnv();
  env.autoAuth = true; // 让授权接口立刻 success，否则 await 会一直挂着（真机上就是等用户点）
  const priv = env.load();
  priv.setup();
  priv.onAsk(() => {});

  await priv.askOnEnter();
  await priv.askOnEnter();
  await priv.askOnEnter();
  eq('5.1 只主动问一次', env.probe, 1);
  eq('5.2 只触发一次授权接口', env.authOpts.length, 1);
  const p1 = priv.askOnEnter();
  const p2 = priv.askOnEnter();
  eq('5.3 多次调用共享同一个 Promise', p1 === p2, true);
}

/* 6. whenSettled：欢迎弹窗用它来避让隐私弹窗 */
async function testWhenSettled() {
  const env = makeEnv();
  const priv = env.load();
  priv.setup();
  priv.onAsk(() => {});

  // 没有待处理请求时：立刻放行，别让欢迎弹窗空等
  let fired = 0;
  priv.whenSettled().then(() => { fired += 1; });
  await sleep(10);
  eq('6.1 无需授权时立即放行', fired, 1);

  // 有待处理请求时：必须等到用户表态
  const env2 = makeEnv();
  const priv2 = env2.load();
  priv2.setup();
  priv2.onAsk(() => {});
  env2.hook(() => {});
  await sleep(20);
  let fired2 = 0;
  priv2.whenSettled().then(() => { fired2 += 1; });
  await sleep(20);
  eq('6.2 用户未表态时不放行', fired2, 0);
  priv2.answer(true);
  await sleep(20);
  eq('6.3 用户表态后放行', fired2, 1);
}

/* 7. 启动顺序：应用说明必须等隐私授权有结果；返回首页要恢复未完成隐私窗 */
{
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const modalSrc = fs.readFileSync(path.join(ROOT, 'components', 'ui', 'privacy-modal', 'index.js'), 'utf8');
  eq('7.1 应用说明使用共享隐私入口等待', /privacy\.askOnEnter\(\)/.test(appSrc), true);
  eq('7.2 应用说明不再提前 whenSettled', /privacy\.whenSettled\(/.test(appSrc), false);
  eq('7.3 隐私组件回前台会恢复未完成弹窗', /privacy\.isAsking\(\)/.test(modalSrc) && /pendingName/.test(modalSrc), true);
}

/* 8. 首次拒绝后，后续真正使用隐私接口仍能重新申请 */
async function testRetryAfterDeny() {
  const env = makeEnv();
  const priv = env.load();
  priv.setup();
  priv.onAsk(() => {});

  const first = priv.askOnEnter();
  await sleep(10);
  eq('8.1 首次进入触发了一次授权', env.authOpts.length, 1);
  env.authOpts[0].fail({ errMsg: 'requirePrivacyAuthorize:fail privacy unauthorized' });
  eq('8.2 首次拒绝返回 false', await first, false);

  const second = priv.requireIfNeeded();
  await sleep(10);
  eq('8.3 后续使用会再次申请', env.authOpts.length, 2);
  env.authOpts[1].success();
  eq('8.4 后续可以正常同意', await second, true);
}

(async function main() {
  console.log('--- 组件承接授权 ---');
  await testWithComponent();
  console.log('--- 用户拒绝 ---');
  await testDeny();
  console.log('--- 无组件时的兜底（最关键） ---');
  await testFallback();
  console.log('--- 主动申请 ---');
  await testRequireIfNeeded();
  console.log('--- 进入时只问一次 ---');
  await testAskOnEnterOnce();
  console.log('--- 拒绝后重新申请 ---');
  await testRetryAfterDeny();
  console.log('--- whenSettled 避让 ---');
  await testWhenSettled();
  console.log(all ? '\n== 全部通过 ==' : '\n== 有失败项 ==');
  process.exit(all ? 0 : 1);
})();
