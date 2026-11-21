// scripts/check-build-fingerprint.cjs —— 版本指纹三方对账
//
// 为什么要单独一个脚本盯着这三个字符串：
//
// 小程序前端**保存即生效**，云函数**必须手动部署**。两边天然不同步，
// 而不同步的症状非常像前端有 bug —— 于是排查方向一开始就错了。真实踩过三次：
//   · 私信发图：云端旧版不认识 images 字段，纯图消息一律回「内容不能为空」，
//     图文消息则悄悄把图丢掉（文字照发，用户以为图也送到了）；
//   · 纯图评论：同样的理由被 postComment 打回；
//   · 校园页招聘会：云端旧版不认这条通道，「招聘会」分类恒为 0。
//
// 三处版本号分别写着「云端期望」「前端期望」「关于页展示」，任何一个漏改，
// 页面上那句「云端是旧版，去重新部署」就会指向错误的版本，把人越带越偏。
// 这个脚本不跑云端、不联网，纯静态比对，秒级完成。

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'miniprogram', 'zjgsu-campus');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
// README 搬去了 docs/：小程序根下每一个字节都算主包体积，
// 25KB 的说明文档不值这个价（开发者读得到就行，不必跟着进用户的手机）。
const readDoc = (rel) => fs.readFileSync(path.join(__dirname, '..', 'docs', rel), 'utf8');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}

// 三处指纹：云端实际版本 / 前端期望版本 / 关于页展示版本
const SITES = [
  { where: 'cloudfunctions/user/index.js', re: /^const BUILD = '([^']+)';/m, note: '云端云函数' },
  { where: 'pages/campus/campus.js', re: /const CLOUD_BUILD = '([^']+)';/, note: '校园页（招聘会故障话术）' },
  { where: 'pages/user/about/about.js', re: /const EXPECT_BUILD = '([^']+)';/, note: '关于页' }
];

const found = SITES.map((s) => {
  const m = s.re.exec(read(s.where));
  return { where: s.where, note: s.note, build: m ? m[1] : null };
});

found.forEach((f) => ok(f.where + ' 里能读到版本号', !!f.build, f.build));

const builds = {};
found.forEach((f) => { if (f.build) builds[f.build] = (builds[f.build] || []).concat(f.note); });
const distinct = Object.keys(builds);

ok('三处版本号完全一致', distinct.length === 1,
  found.map((f) => f.note + '=' + f.build));

// 形如 2026-10-16.9：日期 + 当天递增序号。乱写会让「哪个更新」没法一眼看出
if (distinct.length === 1) {
  ok('版本号形如 YYYY-MM-DD.N（不是随手编的字符串）',
    /^\d{4}-\d{2}-\d{2}\.\d+$/.test(distinct[0]), distinct[0]);
}

/* ---- 云函数的 FEATURES 清单：diag 回执靠它判断「云端有没有这个能力」 ---- */

const cfSrc = read('cloudfunctions/user/index.js');
const fm = /const FEATURES = \[([\s\S]*?)\];/.exec(cfSrc);
ok('云函数里有 FEATURES 清单', !!fm);

if (fm) {
  const feats = (fm[1].match(/'([a-zA-Z]+)'/g) || []).map((s) => s.replace(/'/g, ''));
  ok('FEATURES 至少列了 10 项', feats.length >= 10, feats.length);
  ok('FEATURES 里没有重复项', new Set(feats).size === feats.length,
    feats.filter((f, i) => feats.indexOf(f) !== i));

  // 关键能力必须留着：前端是靠「回执里有没有这个字符串」决定要不要提示用户去部署的。
  // 静默删掉一项 = 旧版云端也会被当成新版，提示从此不再出现
  ['jobfair', 'chatImage', 'commentImage', 'chatQuota', 'removeFriend',
    'accountCancel', 'chatRequest', 'chatRecall', 'notify', 'mediaCheck',
    'postEdit', 'reportPerson', 'modLog'].forEach((f) => {
    ok('FEATURES 保留了 ' + f + '（删掉会让「云端是旧版」的提示失效）',
      feats.indexOf(f) >= 0);
  });
}

// 关于页要真的拿它去做比对，不能只是定义在那里
const aboutSrc = read('pages/user/about/about.js');
ok('关于页真的用 EXPECT_BUILD 做了比对（不是摆设）',
  /EXPECT_BUILD/.test(aboutSrc) && /buildStale/.test(aboutSrc));

/* ---- 文档里抄的版本号 / 特性串，必须与源码一致 ----
 *
 * README 为了让读者「照着比对云端回执」，把当前 build 与 features 抄了一份。
 * 但抄下来的那一刻它就开始过时：每次发版改了源码里的 BUILD，
 * 文档里那份数字没人记得同步，读者照着比就会得出「云端是旧版」的错误结论 ——
 * 而这恰恰是本文开头说的那种「把人越带越偏」。
 * 所以这里反过来用源码当权威去校验文档，文档忘了改就直接红。 */

if (fm && distinct.length === 1) {
  const build = distinct[0];
  const feats = (fm[1].match(/'([a-zA-Z]+)'/g) || []).map((s) => s.replace(/'/g, ''));
  const readme = readDoc('miniprogram-docs/README.md');

  ok('README 里抄的 build 与源码一致（文档写死版本号必然再次过时，所以由脚本兜）',
    readme.indexOf(build) >= 0, build);

  // README 列的是「至少含」，取它抄的那一段逐项比对，缺一项就说明发版时忘了补
  const block = /至少含[^`]*`\[([^\]]*)\]`/.exec(readme);
  if (block) {
    const listed = (block[1].match(/'([a-zA-Z]+)'/g) || []).map((s) => s.replace(/'/g, ''));
    const missing = feats.filter((f) => listed.indexOf(f) < 0);
    ok('README 抄的 features 覆盖了源码全部项（发版加了新的要补上去）',
      missing.length === 0, missing);
    const bogus = listed.filter((f) => feats.indexOf(f) < 0);
    ok('README 没有抄源码里不存在的能力名', bogus.length === 0, bogus);
  } else {
    ok('README 里有可核对的 features 清单', false, '没找到「至少含 [...]」那一段');
  }
}

// 自己别被漏跑：没登记进 check-all 的话，这个脚本等于不存在
const all = fs.readFileSync(path.join(__dirname, 'check-all.cjs'), 'utf8');
ok('check-all.cjs 里登记了 check-build-fingerprint.cjs',
  all.indexOf('check-build-fingerprint.cjs') >= 0);

/* ---- 本轮新增：云函数版本落后要主动上报 ---- */

const campusSrc = read('pages/campus/campus.js');
ok('校园页的「云端版本落后」会主动上报（不点「更新」的人那边是静默的）',
  /report\.report\(\s*'campus\.cloudBuildStale'/.test(campusSrc));

/* ---------------- 汇总 ---------------- */

console.log('通过 ' + pass + ' 项');
if (fails.length) {
  console.log('\n失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('版本指纹一致：' + distinct[0]);
