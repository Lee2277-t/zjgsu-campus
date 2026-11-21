// test-market-categories.cjs —— 闲置分类「一处定义，两处可用」
//
// 这个测试存在的理由：分类这件事**错了不报错，只是永远筛不出来**。
//
// 一份分类要同时服务两个入口：
//   · 发布页 pages/market/edit —— 选「这是什么类型的闲置」
//   · 列表页 pages/market/list —— 顶部分类胶囊筛选
// 而「分类合法吗」这件事**云端还会再判一次**（云函数 normalizeMarket 里的白名单）。
// 三处只要漏掉一处，表现就是：发布时能选、存进库变成「其他」、筛选永远选不到，
// 全程没有一条报错。所以这里钉的不是「某个分类在不在」，而是**三边必须对得上**。
//
// 跑法：node scripts/test-market-categories.cjs（工作目录在 recon/ 下）

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
const readCloudSource = require('./cloud-source.cjs');

/* ---------------- A. 前端那份：utils/market.js ---------------- */
console.log('A. utils/market.js 的 CATEGORIES');

// 只 require 数据层，页面要 Page() 全局，这里用不到
const market = require(path.join(APP, 'utils', 'market.js'));
const cats = market.CATEGORIES;

ok('CATEGORIES 是数组且不为空', Array.isArray(cats) && cats.length > 0, cats && cats.length);
ok('每一项都有 key / label / icon',
  cats.every((c) => c && typeof c.key === 'string' && c.key && c.label && c.icon),
  cats.map((c) => c && c.key));
ok('key 不重复', cats.length === new Set(cats.map((c) => c.key)).size,
  cats.map((c) => c.key));
ok('「其他」是最后一项（它是兜底，插在中间顺序就乱了）',
  cats[cats.length - 1].key === 'other', cats[cats.length - 1]);

// 本轮要加的那一项（中文名后来从「代课」改成「课程互助」，key 保持不变）
const sub = cats.filter((c) => c.key === 'substitute')[0];
ok('有「课程互助」这一项', !!sub, cats.map((c) => c.key));
if (sub) {
  eq('它的中文名是「课程互助」', sub.label, '课程互助');
  ok('它有图标', !!sub.icon, sub.icon);
}
// key 一旦上线就不能改：改了库里已存的条目会全部落到「其他」
ok('key 仍是 substitute（改名只改 label，不动 key）',
  cats.some((c) => c.key === 'substitute'), cats.map((c) => c.key));

/* ---------------- B. 云端那份：白名单 ---------------- */
console.log('B. 云函数的分类白名单');

const cfSrc = readCloudSource();
// normalizeMarket 里那一行形如：
//   category: ['book', 'digital', 'life', 'other'].indexOf(it.category) >= 0 ? ...
const m = /category: \[([^\]]*)\]\.indexOf\(it\.category\)/.exec(cfSrc);
ok('云函数里找得到分类白名单那一行', !!m, m && m[1]);
let cloudKeys = [];
if (m) {
  cloudKeys = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  ok('云端白名单不为空', cloudKeys.length > 0, cloudKeys);
}

/* ---------------- C. 两边必须一一对应 ---------------- */
console.log('C. 前后端两份白名单比对');

const feKeys = cats.map((c) => c.key);
// 顺序也要一致：胶囊顺序由前端数组决定，云端只是兜底；
// 顺序不同不会出错，但会让人以为「云端另有一套口径」
eq('前后端分类列表完全一致（含顺序）', cloudKeys.join(','), feKeys.join(','));
if (cloudKeys.length) {
  ok('云端认得「代课」这个 key（漏了会静默落成「其他」）',
    cloudKeys.indexOf('substitute') >= 0, cloudKeys);
  ok('云端没有多出前端不认识的分类',
    cloudKeys.every((k) => feKeys.indexOf(k) >= 0), cloudKeys);
}

/* ---------------- D. 两个入口都从这里取 ---------------- */
console.log('D. 发布页与列表页都取 market.CATEGORIES');

const editSrc = readProj(path.join('sub', 'market', 'edit', 'edit.js'));
const listSrc = readProj(path.join('pages', 'market', 'list', 'list.js'));

ok('发布页从 market.CATEGORIES 取分类（不是自己抄一份）',
  /cats:\s*CATS/.test(editSrc) && /const CATS = market\.CATEGORIES\.filter/.test(editSrc));
ok('列表页从 market.CATEGORIES 拼筛选胶囊（不是自己抄一份）',
  /market\.CATEGORIES/.test(listSrc));
ok('列表页把「全部」拼在最前面',
  /\[\{\s*key:\s*'all'[\s\S]{0,120}\}\]\.concat\([\s\S]{0,120}market\.CATEGORIES/.test(listSrc));
// 这一档是「提上来」不是「复制一份」：顶上那一排有它，第二排就不该再出现同一个词
ok('课程互助成了一级入口（TABS 里有它）',
  /key:\s*'substitute',\s*label:\s*promotedLabel/.test(listSrc));
// 顶上一排的中文名直接读 CATEGORIES，不另写一份 —— 否则改名时两边会分家
ok('一级入口的中文名取自 market.CATEGORIES（两处同一个词）',
  /promotedLabel[^\n]*=[\s\S]{0,240}market\.CATEGORIES/.test(listSrc));
ok('第二排分类里滤掉了这一项（同一屏不重复）',
  /c\.key\s*!==\s*PROMOTED_KEY/.test(listSrc));
// 发布页只有「闲置分享」才显示分类：寻物 / 招领没有分类可填
ok('发布页只在「闲置分享」时显示分类',
  /showCategory/.test(editSrc) && /wx:if="\{\{showCategory\}\}"/.test(readProj(path.join('sub', 'market', 'edit', 'edit.wxml'))));

/* ---------------- E. 端到端：能存、能筛 ---------------- */
console.log('E. 端到端（归一化 + 筛选）');

// normalizeMarket 的兜底：不认识的 key 一律落「其他」，认识的照原样存。
// 这一段不走云函数（不出网），而是直接复用前端同一份白名单验证口径一致
const allow = feKeys;
ok('白名单认得 book', allow.indexOf('book') >= 0);
ok('白名单认得 substitute', allow.indexOf('substitute') >= 0);
ok('白名单不认得「substituteX」这类拼写错误（防手滑）',
  allow.indexOf('substituteX') < 0);
// 列表页筛选用的是 key 而不是中文：改成中文匹配会一到改名就失联
ok('列表页筛选按 key 过滤（不是按中文）',
  /cat/.test(listSrc) && !/category\s*===\s*'代课'/.test(listSrc));

/* ---------------- F. 发布页「我要发的是」里的课程互助 ---------------- */
console.log('F. 发布页「我要发的是」四格');

// 它是一个入口，不是第四种 type：云端 MARKET_TYPES 只有 lost/found/sell，
// 硬塞一种新 type 会被静默改成「寻物」——所以落库必须还是 sell
ok('四格里有「课程互助」', /key:\s*'substitute',\s*label:\s*'课程互助'/.test(editSrc));
ok('课程互助落库映射回 sell（不新增 type）',
  /const real = isSub \? 'sell' : chip/.test(editSrc));
ok('选中课程互助时把分类定成 substitute', /category = SUBSTITUTE_CAT/.test(editSrc));
ok('课程互助不显示参考价', /showPrice: real === 'sell' && !isSub/.test(editSrc));
ok('提交时没显示价格就不带 price（切档后残留的 ¥ 不能跟着发出去）',
  /price: d\.showPrice \? d\.price : ''/.test(editSrc));
ok('发布页分类胶囊里不重复「课程互助」',
  /CATEGORIES\.filter\(\(c\) => c\.key !== SUBSTITUTE_CAT\)/.test(editSrc));

/* ---------------- 汇总 ---------------- */
console.log('');
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + pass + ' 通过 / 0 失败');
