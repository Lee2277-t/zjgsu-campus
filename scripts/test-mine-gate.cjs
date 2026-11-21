// scripts/test-mine-gate.cjs —— 「我的」页不该摆别人用不上的东西
//
// 背景：内容审核、环境自检、身份 ID 复制、云函数版本自检，这四样只有干活的人用得上。
// 以前它们敞着挂在每个人的「我的」页里 —— 同学点进去要么一脸茫然，要么以为自己被人审了。
// 现在统一挂在 isMod（审核员白名单）后面。
//
// 为什么要把这件事写成测试而不是靠自觉：
//   这类入口的加法和减法不对称 —— 加一个新入口的人只想着「我好用」，
//   不会想到「全校每个人都要多看一行」。少了这一份断言，它们过两轮就会自己长回来。
//
// 覆盖：
//   1. 四处入口在 wxml 里都挂着 wx:if="{{isMod}}"
//   2. 「关于」页不再指路到一个同学看不到的地方（「我的 → 内容审核」）
//   3. 页面真的按 isMod 走：警示条对同学去「关于」、对审核员才去自检

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');

// 项目 package.json 是 "type":"module"，小程序 .js 会被 Node 当 ESM 解析。
// 强制按 CommonJS 编译小程序目录下的文件
const origJs = Module._extensions['.js'];
Module._extensions['.js'] = function (m, f) {
  if (norm(f).indexOf(norm(ROOT)) === 0) return m._compile(fs.readFileSync(f, 'utf8'), f);
  return origJs(m, f);
};

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}

const readProj = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const MINE_WXML = readProj('pages/mine/mine.wxml');
const PROFILE_WXML = readProj('pages/user/profile/profile.wxml');
const ABOUT_WXML = readProj('pages/user/about/about.wxml');
const MINE_JS = readProj('pages/mine/mine.js');
const PROFILE_JS = readProj('pages/user/profile/profile.js');
const ABOUT_JS = readProj('pages/user/about/about.js');

// 取某个 markers 所在的那个 <view ...> 开标签。
// 静态正则最容易犯的错是「在文件别处找到了 wx:if」—— 所以这里限定在同一对尖括号里
function tagOf(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return '';
  const start = src.lastIndexOf('<view', i);
  const end = src.indexOf('>', i);
  if (start < 0 || end < 0) return '';
  return src.slice(start, end + 1);
}

/* ---------------- 一、入口必须挂在 isMod 后面 ---------------- */

ok('「内容审核」入口还在（没被整块删掉，走投无路时管理员也要用它）',
  MINE_WXML.indexOf('bindtap="onModeration"') >= 0);
ok('「内容审核」只对审核员显示',
  tagOf(MINE_WXML, 'bindtap="onModeration"').indexOf('wx:if="{{isMod}}"') >= 0,
  tagOf(MINE_WXML, 'bindtap="onModeration"').slice(0, 120));

ok('「环境自检」入口还在', MINE_WXML.indexOf('bindtap="onDiag"') >= 0);
ok('「环境自检」只对审核员显示',
  tagOf(MINE_WXML, 'bindtap="onDiag"').indexOf('wx:if="{{isMod}}"') >= 0,
  tagOf(MINE_WXML, 'bindtap="onDiag"').slice(0, 120));

ok('「身份 ID」只对审核员显示（它是加白名单用的，同学拿到无处可用）',
  tagOf(PROFILE_WXML, 'bindtap="onCopyOpenid"').indexOf('wx:if="{{isMod}}"') >= 0,
  tagOf(PROFILE_WXML, 'bindtap="onCopyOpenid"').slice(0, 120));

// 关于页三样施工件：云函数版本 / 过期警告 / 云端能力清单
ok('关于页的云函数版本行只对审核员显示',
  tagOf(ABOUT_WXML, "class=\"ab-row__v {{buildStale ? 'ab-row__v--warn' : ''}}\"")
    .indexOf('wx:if="{{isMod}}"') >= 0);
ok('关于页的「云函数没部署」警告只对审核员显示',
  tagOf(ABOUT_WXML, 'class="ab-warn"').indexOf('wx:if="{{isMod}}') >= 0
  || tagOf(ABOUT_WXML, 'class="ab-warn"').indexOf('wx:if="{{isMod &&') >= 0,
  tagOf(ABOUT_WXML, 'class="ab-warn"').slice(0, 120));
ok('关于页的云端能力清单只对审核员显示',
  tagOf(ABOUT_WXML, 'class="ab-feats"').indexOf('wx:if="{{isMod}}') >= 0
  || tagOf(ABOUT_WXML, 'class="ab-feats"').indexOf('wx:if="{{isMod &&') >= 0,
  tagOf(ABOUT_WXML, 'class="ab-feats"').slice(0, 120));

// 三条断言防的是同一件事：给同学看的东西里不该出现施工用语
ok('关于页还有版本信息给同学报障（小程序版本那几行没被连锅端）',
  ABOUT_WXML.indexOf('class="ab-sec">版本信息') >= 0
  && ABOUT_WXML.indexOf('ab-row__k">基础库') >= 0);
ok('关于页还留着联系方式与侵权投诉通道',
  ABOUT_WXML.indexOf('侵权投诉与内容处理') >= 0 && ABOUT_WXML.indexOf('联系我们') >= 0);

/* ---------------- 二、指路不能指到空气 ---------------- */

// 「我的 → 内容审核」已经不对普通人显示，免责声明里再这么写，
// 同学照着找会找不到 —— 指路指向一个看不见的页面，比不指更糟
ok('关于页不再把「我的 → 内容审核」当成大家都能去的入口',
  ABOUT_WXML.indexOf('我的 → 内容审核') < 0);

ok('「我的」页默认不是审核员（入口先隐藏，判出来再显示）',
  /isMod:\s*false/.test(MINE_JS) && /isMod:\s*false/.test(PROFILE_JS)
  && /isMod:\s*false/.test(ABOUT_JS));
// 三个页面各自都补了云端 whoami —— 否则 openid 迟到那几秒，管理员自己的入口会一闪而过
ok('三个页面都问了云端 whoami（不以本地名单为准）',
  /whoami\(\)/.test(MINE_JS) && /whoami\(\)/.test(PROFILE_JS) && /checkMod\(\)/.test(ABOUT_JS));

/* ---------------- 三、真跑一遍：警示条该把人送去哪儿 ---------------- */

const wxCalls = [];
global.wx = {
  showToast(o) { wxCalls.push('toast:' + String((o && o.title) || '')); },
  showModal(o) { wxCalls.push('modal:' + String((o && o.title) || '')); },
  showLoading() {}, hideLoading() {},
  setClipboardData() {}, getSystemInfoSync() { return { SDKVersion: '3.5.0' }; },
  getAccountInfoSync() { return { miniProgram: { version: '1.0.0' } }; },
  getStorageSync() { return ''; }, setStorageSync() {}, removeStorageSync() {},
  requestSubscribeMessage() {}, getRealtimeLogManager() { return null; },
  onNetworkStatusChange() {}, getNetworkType() { return Promise.resolve({ networkType: 'wifi' }); },
  cloud: { init() {} }
};

const nav = require(path.join(APP, 'utils/nav.js'));
const userApi = require(path.join(APP, 'utils/user.js'));
const cloudApi = require(path.join(APP, 'utils/cloud.js'));

let navUrls = [];
let diagCalls = 0;
nav.go = function (o) { navUrls.push(String((o && o.url) || '')); };
cloudApi.getOpenid = function () { return ''; };
cloudApi.fetchOpenid = function () { return Promise.resolve(''); };
cloudApi.ensureCloud = function () { return true; };
userApi.whoami = function () { return Promise.reject(new Error('云函数没部署')); };
userApi.isModerator = function () { return false; };
userApi.listFriends = function () { return Promise.resolve([]); };
userApi.listRequests = function () { return Promise.resolve([]); };
userApi.notifyList = function () { return Promise.resolve({ ok: true, unread: 0 }); };
userApi.accountState = function () { return Promise.resolve({ ok: true, pending: false }); };
userApi.diagCloud = function () {
  diagCalls += 1;
  return Promise.resolve({ ok: true, missing: [], sec: 'ok' });
};

let mineCfg = null;
global.Page = function (c) { mineCfg = c; return c; };
require(path.join(APP, 'pages/mine/mine.js'));

function makePage(cfg) {
  const p = Object.assign({}, cfg);
  p.data = JSON.parse(JSON.stringify(cfg.data));
  p.setData = function (patch) { Object.assign(p.data, patch); };
  return p;
}

(async () => {
  // 1) 普通同学点了「还没拿到身份」的警示条 → 去关于页（有邮箱），不去自检
  let p = makePage(mineCfg);
  p.data.isMod = false;
  p.data.registered = false;
  diagCalls = 0; navUrls = [];
  await p.onRegAlert();
  ok('同学点警示条 → 去「关于」（那里才有联系方式）',
    navUrls.indexOf('/pages/user/about/about') >= 0, navUrls);
  ok('同学点警示条不会去跑环境自检（那份缺失清单他看不懂）',
    diagCalls === 0, diagCalls);

  // 2) 审核员点了 → 走自检看缺哪个集合
  p = makePage(mineCfg);
  p.data.isMod = true;
  p.data.registered = false;
  diagCalls = 0; navUrls = [];
  await p.onRegAlert();
  await new Promise((r) => setTimeout(r, 0));
  ok('审核员点警示条 → 跑环境自检', diagCalls === 1, diagCalls);
  ok('审核员点警示条不会被送去关于页', navUrls.length === 0, navUrls);

  // 3) 关于页：云端说我是审核员，施工件就要露出来
  let aboutCfg = null;
  global.Page = function (c) { aboutCfg = c; return c; };
  require(path.join(APP, 'pages/user/about/about.js'));
  let whoamiMod = false;
  userApi.whoami = function () { return Promise.resolve({ isMod: whoamiMod, build: BUILD }); };
  const BUILD = '2026-10-18.4';
  const a = makePage(aboutCfg);
  whoamiMod = false;
  a.checkMod();
  await new Promise((r) => setTimeout(r, 0));
  ok('关于页默认不给同学看施工件', a.data.isMod === false, a.data.isMod);

  whoamiMod = true;
  const b = makePage(aboutCfg);
  b.checkMod();
  await new Promise((r) => setTimeout(r, 0));
  ok('云端认了审核员，关于页才显示云函数版本那些', b.data.isMod === true, b.data.isMod);

  /* ---------------- 汇总 ---------------- */
  console.log('\n「我的」页入口闸门：' + pass + ' 项通过'
    + (fails.length ? '，' + fails.length + ' 项失败' : ''));
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
