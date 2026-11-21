// scripts/check-package-size.cjs —— 小程序包的体积红线守卫
//
// 为什么要把它钉成一条脚本：
//
// 微信开发者工具「代码质量」面板挂着两条硬指标 ——
//   主包大小 < 1.5M、图片和音频资源 < 200K，
// 超了就「未通过」。问题是这个面板只在人主动点开时才算一次，
// 而且它给的是结论不是过程：你不知道是哪几个文件把它顶上去的。
// 于是一轮 UI 重构下来，几百 KB 的 SVG 图标和开发脚本就悄悄堆进去了，
// 等到要上线才发现挂了，再回头找是谁贡献的字节就很被动。
//
// 这里把两件事固化下来：
//   ① 本地随时能算出「主包现在多少、离红线还剩多少」，不用开 IDE；
//   ② 超标就直接红，并打印 Top N 大文件 —— 谁贡献的最多一眼看到。
//
// 口径对齐开发者工具的几个关键点（当时逐条验证过）：
//   · cloudfunctions/ 不属于小程序包，不计（`cloudfunctionRoot` 是单独上传的）
//   · 分包目录里的东西算分包，不算主包 —— 这正是配分包能省主包的原因
//   · packOptions.ignore 命中的文件按排除处理
//   · 资源只统计图片 + 音频，.py / .md / 构建脚本这类不是资源但照样占主包

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'miniprogram', 'zjgsu-campus');

// 开发者工具「代码质量」给的红线
const MAIN_LIMIT = 1.5 * 1024 * 1024; // 主包 < 1.5M
const MEDIA_LIMIT = 200 * 1024;       // 图片 + 音频 < 200K
// 余量低于这个值就提醒：不是失败，是「再加点东西就红了」的提前告警
const WARN_HEADROOM = 80 * 1024;

// 图片 + 音频扩展名（开发者工具资源统计口径）
const MEDIA_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|mp3|wav|aac|m4a|ogg|amr|silk|flac)$/i;

let pass = 0;
const fails = [];
const warns = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}

const kb = (b) => (b / 1024).toFixed(1) + ' KB';
const mb = (b) => (b / (1024 * 1024)).toFixed(3) + ' MB';

/* ---------------- 读配置 ---------------- */

const appJson = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
const projJson = JSON.parse(fs.readFileSync(path.join(APP, 'project.config.json'), 'utf8'));

const mainPages = appJson.pages || [];
const subPkgs = appJson.subPackages || appJson.subpackages || [];
const subRoots = subPkgs.map((p) => String(p.root || '').replace(/\/+$/, ''));

ok('app.json 能解析出 pages 清单', mainPages.length > 0, mainPages.length);
/* ---------------- packOptions.ignore ---------------- */

const ignores = ((projJson.packOptions || {}).ignore || []).map((i) => ({
  value: String(i.value || ''),
  type: String(i.type || 'glob')
}));

ok('cloudfunctions 已在 packOptions.ignore 排除',
  ignores.some((ig) => ig.value.replace(/\\/g, '/') === 'cloudfunctions' && ig.type === 'folder'));

function ignored(rel) {
  const r = rel.replace(/\\/g, '/');
  return ignores.some((ig) => {
    const v = ig.value.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!v) return false;
    if (ig.type === 'file') return r === v;
    if (ig.type === 'folder') return r === v || r.indexOf(v + '/') === 0;
    // prefix / glob：按「路径以它开头」处理，够覆盖本项目用到的写法
    return r === v || r.indexOf(v) === 0;
  });
}

function inSub(rel) {
  const r = rel.replace(/\\/g, '/');
  return subRoots.some((s) => s && (r === s || r.indexOf(s + '/') === 0));
}

function subRootOf(rel) {
  const r = rel.replace(/\\/g, '/');
  const hit = subRoots.filter((s) => s && (r === s || r.indexOf(s + '/') === 0))[0];
  return hit || MAIN;
}

/* ---------------- 归属判定：按依赖，不按位置 ----------------
 *
 * 微信决定一个 .js 进哪个包，看的是**谁引用它**，不是它躺在哪个目录：
 * 只被某个分包引用的模块会被打进那个分包，哪怕它物理上在主包目录里。
 * data/exam-papers.js 就是这种：它在 data/ 下，但只有 tool 分包的真题页
 * require 它，构建时进 tool 分包。按位置算会凭空多算 20KB 主包，
 * 于是「明明还有空间」被报成「快到红线了」——守卫失真比没有守卫更糟，
 * 它会让人为了一个不存在的数字去做无谓的删减。
 *
 * 代价是这里要做一次依赖遍历。页面几百个、边几千条，在脚本里是毫秒级。 */

const MAIN = '';

// 入口：每个页面的四个文件归属由 app.json 说了算
const entryPkg = {};
mainPages.forEach((p) => { entryPkg[p + '.js'] = MAIN; });
subPkgs.forEach((sp) => {
  const root = String(sp.root || '').replace(/\/+$/, '');
  (sp.pages || []).forEach((pg) => {
    entryPkg[(root ? root + '/' : '') + pg + '.js'] = root;
  });
});

const reqCache = {};
function requiresOf(rel) {
  if (reqCache[rel]) return reqCache[rel];
  let src = '';
  try { src = fs.readFileSync(path.join(APP, rel), 'utf8'); } catch (e) { reqCache[rel] = []; return []; }
  const out = [];
  // 只认 require('.xx')：require('/xx') 写法在项目里没有，
  // 真出现了会是另一种解析规则，宁可漏算也不能用错的规则算
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const t = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
    if (fs.existsSync(path.join(APP, t))) out.push(t);
  }
  reqCache[rel] = out;
  return out;
}

// 从每个入口出发做一次 DFS，记下「这个文件被哪些包用到」
const usedBy = {};
Object.keys(entryPkg).forEach((f) => {
  const pkg = entryPkg[f];
  const stack = [f];
  const seen = {};
  seen[f] = 1;
  while (stack.length) {
    const cur = stack.pop();
    if (!usedBy[cur]) usedBy[cur] = {};
    usedBy[cur][pkg || MAIN] = 1;
    requiresOf(cur).forEach((t) => {
      if (seen[t]) return;
      seen[t] = 1;
      stack.push(t);
    });
  }
});

function pkgOf(rel) {
  // 页面的四个文件跟着页面走
  const asJs = rel.replace(/\.(js|wxml|wxss|json)$/, '.js');
  if (entryPkg[asJs] !== undefined) return entryPkg[asJs];
  if (/\.js$/.test(rel)) {
    const s = usedBy[rel] ? Object.keys(usedBy[rel]) : [];
    // 没人引用（比如组件自己的 js）→ 退回位置判定
    if (!s.length) return subRootOf(rel);
    // 被主包用到、或被多个分包共用 → 主包。
    // 后者是刻意保守：共用模块微信会放主包，算它是主包不会低估
    if (s.indexOf(MAIN) >= 0 || s.length > 1) return MAIN;
    return s[0];
  }
  // 图片 / 组件的 wxml 等：按位置
  return subRootOf(rel);
}

/* ---------------- 遍历统计 ---------------- */

const all = [];       // 所有打包文件 { rel, size, media }
let mainBytes = 0;
let mediaBytes = 0;
let mediaCount = 0;
let ignoredBytes = 0;

(function walk(base, rel) {
  let ents = [];
  try { ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch (e) { return; }
  ents.forEach((e) => {
    const child = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (child === 'cloudfunctions' && !rel) return; // 云函数不进小程序包
      walk(base, child);
      return;
    }
    let size;
    try { size = fs.statSync(path.join(base, child)).size; } catch (e2) { return; }
    const isMedia = MEDIA_RE.test(e.name);
    all.push({ rel: child, size: size, media: isMedia });
    if (ignored(child)) { ignoredBytes += size; return; }
    if (isMedia) { mediaBytes += size; mediaCount += 1; }
    if (pkgOf(child) === MAIN) mainBytes += size;
  });
})(APP, '');

/* ---------------- ① 主包大小 ---------------- */

ok('主包大小 < 1.5M（开发者工具「代码质量」红线）', mainBytes < MAIN_LIMIT, {
  now: mb(mainBytes),
  limit: mb(MAIN_LIMIT),
  over: kb(mainBytes - MAIN_LIMIT)
});

/* ---------------- ② 图片音频资源 ---------------- */

ok('图片和音频资源 < 200K', mediaBytes < MEDIA_LIMIT, {
  now: kb(mediaBytes),
  limit: kb(MEDIA_LIMIT),
  count: mediaCount
});

/* ---------------- ③ 分包配置自身要合法 ---------------- */

// 平台要求：tabBar 页必须在主包，进分包直接报「page is not found」
const tabPaths = ((appJson.tabBar || {}).list || []).map((t) => String(t.pagePath).replace(/^\//, ''));
if (tabPaths.length) {
  const tabInSub = tabPaths.filter((p) => subRoots.some((s) => p.indexOf(s + '/') === 0));
  ok('tabBar 页全部留在主包（平台禁止 tab 页进分包）', tabInSub.length === 0, tabInSub);
}

// 同一个页面同时挂在主包 pages 和分包里，编译期会报「重复」这种很难懂的错
const declaredInSub = [];
subPkgs.forEach((p) => {
  const root = String(p.root || '');
  (p.pages || []).forEach((p2) => declaredInSub.push((root ? root + '/' : '') + p2));
});
const dup = declaredInSub.filter((p) => mainPages.indexOf(p) >= 0);
ok('没有页面同时出现在主包 pages 和分包里', dup.length === 0, dup);

// 分包声明的路径必须真的存在，否则打包时才会炸
const missing = declaredInSub.filter((p) => !fs.existsSync(path.join(APP, p + '.js')));
ok('分包声明的每个页面都存在', missing.length === 0, missing);

/* ---------------- ③ 被引用的资源不能被 ignore 命中 ----------------
 *
 * 真踩过：为了给主包瘦身，`assets/brand/icon-` 这条 prefix ignore 把整批多尺寸
 * 校徽导出排了出去。后来清理时只留下 about 页正在用的 icon-app-512.png，
 * 但 prefix 规则没跟着收窄 —— 于是「关于页的图标不显示」，
 * 而且不点开任何东西、不报任何错，只有肉眼能看到。
 * 反过来讲：ignore 的前提是「反正没人用」，这一条就是验证那个「没人用」是否还成立。 */

const refAssets = new Set();
(function collectRefs(base, rel) {
  let ents = [];
  try { ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch (e) { return; }
  ents.forEach((e) => {
    const child = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (child === 'cloudfunctions' && !rel) return;
      collectRefs(base, child);
      return;
    }
    if (!/\.(js|wxml|wxss|json)$/.test(e.name)) return;
    let src = '';
    try { src = fs.readFileSync(path.join(base, child), 'utf8'); } catch (e2) { return; }
    // 形如 "/assets/brand/icon-app-512.png" 或 "../../assets/x.png"
    const re = /["'](\/?(?:assets|components)\/[^"']+\.(?:png|jpe?g|gif|webp|svg|mp3|wav|aac|m4a))["']/gi;
    let m;
    // 跳过 {{ }} 拼出来的路径：那是运行时才成型的（图标名带变体后缀），
    // 静态阶段没法判定，真去看看 ThemeIcon 组件与 tabBar 的取值表
    while ((m = re.exec(src))) {
      if (m[1].indexOf('{{') >= 0) continue;
      refAssets.add(m[1].replace(/^\//, ''));
    }
  });
})(APP, '');

const brokenAsset = [];
refAssets.forEach((p) => {
  if (!fs.existsSync(path.join(APP, p))) brokenAsset.push('文件不存在: ' + p);
  else if (ignored(p)) brokenAsset.push('被 ignore 排除却在用: ' + p);
});
ok('代码里引用到的图片/音频既存在、也没被 packOptions.ignore 排除',
  brokenAsset.length === 0, brokenAsset.slice(0, 10));

// 主包引用分包里的模块是非法的（反过来允许）—— 这条最容易在后面加功能时踩到
const crossRef = [];
(function scanDir(base, rel) {
  let ents = [];
  try { ents = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch (e) { return; }
  ents.forEach((e) => {
    const child = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (child === 'cloudfunctions' && !rel) return;
      if (inSub(child)) return; // 分包内部互引没问题，不扫
      scanDir(base, child);
      return;
    }
    if (!/\.(js|wxml|wxss|json)$/.test(e.name)) return;
    let src = '';
    try { src = fs.readFileSync(path.join(base, child), 'utf8'); } catch (e2) { return; }
    // 绝对路径的组件引用（"app-header": "/components/ui/app-header/index"）
    // 也要扫：它和 require 是同一类跨包依赖，只是写在 json 里、更难一眼看见
    if (/\.json$/.test(e.name)) {
      let comps = {};
      try { comps = JSON.parse(src).usingComponents || {}; } catch (e3) { comps = {}; }
      Object.keys(comps).forEach((tag) => {
        const target = String(comps[tag] || '').replace(/^\//, '');
        if (target && subRoots.some((s) => target === s || target.indexOf(s + '/') === 0)) {
          crossRef.push(child + ' → <' + tag + '> ' + comps[tag]);
        }
      });
    }
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(child), m[1]));
      // 目标落在某个分包 root 下 = 主包伸手去要分包的东西
      if (subRoots.some((s) => target === s || target.indexOf(s + '/') === 0)) {
        crossRef.push(child + ' → ' + m[1]);
      }
    }
  });
})(APP, '');
ok('主包没引用分包里的模块或组件（合法方向只有分包→主包）', crossRef.length === 0, crossRef);

/* ---------------- ④ 自我登记 ---------------- */

const allScript = fs.readFileSync(path.join(__dirname, 'check-all.cjs'), 'utf8');
ok('check-all.cjs 里登记了 check-package-size.cjs',
  allScript.indexOf('check-package-size.cjs') >= 0);

/* ---------------- 汇总 ---------------- */

const top = all.filter((f) => !ignored(f.rel) && pkgOf(f.rel) === MAIN)
  .sort((a, b) => b.size - a.size).slice(0, 6);

console.log('主包        ' + kb(mainBytes) + ' / ' + mb(mainBytes) + '   红线 1.5M   余量 ' + kb(MAIN_LIMIT - mainBytes));
console.log('图片音频    ' + kb(mediaBytes) + ' / ' + mediaCount + ' 个        红线 200K   余量 ' + kb(MEDIA_LIMIT - mediaBytes));
if (subPkgs.length) {
  console.log('分包        ' + subPkgs.length + ' 个：' + subRoots.join(' / '));
}
if (ignoredBytes) console.log('（已按 packOptions.ignore 排除 ' + kb(ignoredBytes) + '）');
console.log('主包里最大的几个：');
top.forEach((f) => console.log('  ' + kb(f.size).padStart(10) + '  ' + f.rel));

if (MAIN_LIMIT - mainBytes < WARN_HEADROOM || MEDIA_LIMIT - mediaBytes < WARN_HEADROOM) {
  warns.push('离红线不足 ' + kb(WARN_HEADROOM) + '，再加东西前先看一眼上面那串大文件');
}

console.log('\n通过 ' + pass + ' 项');
warns.forEach((w) => console.log('  ! ' + w));
if (fails.length) {
  console.log('\n失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
