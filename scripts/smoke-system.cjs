/**
 * 冒烟：utils/system.js（自定义导航栏的系统信息读取）
 *
 *   为什么需要：wx.getSystemInfoSync 已被官方标记废弃（基础库 3.x 的 Console 会打黄条）。
 *   改走 wx.getWindowInfo + wx.getDeviceInfo 后，导航栏高度/安全区一旦算错，
 *   所有页面的顶部都会错位 —— 光看语法是看不出来的，必须跑一遍取值。
 *   这个脚本就是给这次改动留的回归测试：
 *     A. 新 API 存在     → 取新 API，且一行都不碰废弃 API
 *     B. 新 API 不存在   → 自动退回 getSystemInfoSync（老基础库）
 *     C. 新 API 抛错     → 也退回，不让导航栏整个挂掉
 *     外加：返回值字段集合必须与改造前完全一致，页面取字段才不会拿到 undefined
 *
 *   用法：node scripts/smoke-system.cjs      （在本文件所在目录的上级运行即可）
 *
 * ⚠️ 注意：上级 recon/package.json 是 "type":"module"，直接 require(项目里的 .js)
 *    会被当 ESM 报错 "module is not defined"。所以这里手动搭一个 CommonJS 壳执行
 *    文件内容，不碰 require 缓存 —— 这和小程序的真实运行方式也是一致的。
 */
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'miniprogram', 'zjgsu-campus', 'utils', 'system.js');
const code = fs.readFileSync(base, 'utf8');

function load(wxStub) {
  const module = { exports: {} };
  const fn = new Function('module', 'exports', 'wx', 'require', code);
  fn(module, module.exports, wxStub, () => ({}));
  return module.exports;
}

const CAPSULE = { top: 48, height: 32, right: 340, bottom: 80 };
let oldApiCalls = 0;

// A：新版基础库（两个新 API 都在）
const A = load({
  getWindowInfo: () => ({ statusBarHeight: 44, windowWidth: 390, windowHeight: 844, safeArea: { bottom: 810 } }),
  getDeviceInfo: () => ({ platform: 'ios' }),
  getMenuButtonBoundingClientRect: () => CAPSULE,
  getSystemInfoSync: () => { oldApiCalls += 1; return {}; },
}).system();

// B：老基础库（只有已废弃的旧 API）
const B = load({
  getMenuButtonBoundingClientRect: () => CAPSULE,
  getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 375, windowHeight: 667, safeArea: { bottom: 667 }, platform: 'android' }),
}).system();

// C：新 API 直接抛错
const C = load({
  getWindowInfo: () => { throw new Error('boom'); },
  getMenuButtonBoundingClientRect: () => CAPSULE,
  getSystemInfoSync: () => ({ statusBarHeight: 24, windowWidth: 414, windowHeight: 896, safeArea: { bottom: 862 }, platform: 'devtools' }),
}).system();

let all = true;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) all = false;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + ' => ' + JSON.stringify(got) + (ok ? '' : ' (期望 ' + JSON.stringify(want) + ')'));
};

eq('A 状态栏高度', A.statusBarHeight, 44);
eq('A 导航栏高度', A.navBarHeight, (48 - 44) * 2 + 32);
eq('A 底部安全区', A.safeBottom, 844 - 810);
eq('A 胶囊右边距', A.capsuleRight, 390 - 340);
eq('A 平台', A.platform, 'ios');
eq('A 未调用废弃 API', oldApiCalls, 0);
eq('B 状态栏高度', B.statusBarHeight, 20);
eq('B 平台', B.platform, 'android');
eq('C 兜底后的宽度', C.windowWidth, 414);
eq('C 平台', C.platform, 'devtools');

const KEYS = ['statusBarHeight', 'capsuleHeight', 'capsuleTop', 'navBarHeight', 'capsuleRight', 'windowWidth', 'windowHeight', 'safeBottom', 'platform'];
eq('A 返回字段集合不变', Object.keys(A).sort(), KEYS.slice().sort());

console.log(all ? '\n== 全部通过 ==' : '\n== 有失败项 ==');
process.exit(all ? 0 : 1);
