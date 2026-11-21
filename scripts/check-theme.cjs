// scripts/check-theme.cjs —— 深色模式令牌一致性检查
//
// 这个脚本防的是熟面孔那几类问题：
//   ① 某个令牌只在浅色那套里定义了，@media (prefers-color-scheme: dark) 里漏了
//      —— 深色模式下它悄悄保持浅色值。白底白字、浅灰字压在深底上，
//         而且只在切到深色时才暴露，本地跑一百遍都看不出来。
//   ② wxss 里 var(--c-xxx) 引用了一个根本没定义的令牌
//      —— 那条声明直接失效，元素会变成透明/继承，不报错。
//   ③ theme.json 里 light / dark 两侧的键不齐，app.json 引用了没定义的 @变量
//   ④ 定义了但没人用的令牌（死令牌，会误导后来改色板的人）
//
// 用法：node scripts/check-theme.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram', 'zjgsu-campus');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) pass += 1;
  else fails.push(name + (extra === undefined ? '' : '  → ' + extra));
}

/** 从 startBrace 处的 { 开始，按花括号配平取出整块 */
function blockAt(text, startBrace) {
  let depth = 0;
  for (let i = startBrace; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startBrace, i + 1);
    }
  }
  return '';
}

/** 扫一个目录下所有 .wxss */
function walkWxss(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.name === 'node_modules' || e.name === '_trash') return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkWxss(p, out);
    else if (e.name.endsWith('.wxss')) out.push(p);
  });
  return out;
}

/* ---------------- ① app.json / theme.json ---------------- */

const appJsonRaw = fs.readFileSync(path.join(APP, 'app.json'), 'utf8');
const appJson = JSON.parse(appJsonRaw);
ok('app.json 开了 darkmode', appJson.darkmode === true, String(appJson.darkmode));
ok('app.json 指定了 themeLocation', !!appJson.themeLocation, appJson.themeLocation);

const themePath = path.join(APP, appJson.themeLocation || 'theme.json');
ok('theme.json 存在', fs.existsSync(themePath));
const theme = JSON.parse(fs.readFileSync(themePath, 'utf8'));
ok('theme.json 有 light', !!theme.light);
ok('theme.json 有 dark', !!theme.dark);
ok('light 与 dark 的键完全对齐',
  JSON.stringify(Object.keys(theme.light).sort()) === JSON.stringify(Object.keys(theme.dark).sort()),
  JSON.stringify({
    只有light: Object.keys(theme.light).filter((k) => !(k in theme.dark)),
    只有dark: Object.keys(theme.dark).filter((k) => !(k in theme.light))
  }));

// 所有 json 里引用的 @变量，两侧都必须有定义
const refs = new Set();
function walkJson(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.name === 'node_modules' || e.name === '_trash' || e.name === 'tools') return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJson(p);
    else if (e.name.endsWith('.json')) {
      const t = fs.readFileSync(p, 'utf8');
      (t.match(/"(@[A-Za-z0-9_]+)"/g) || []).forEach((m) => refs.add(m.slice(1, -1)));
    }
  });
}
walkJson(APP);
const missingVar = [];
refs.forEach((v) => {
  const key = v.slice(1);
  if (!theme.light || !(key in theme.light)) missingVar.push(v + '(light)');
  if (!theme.dark || !(key in theme.dark)) missingVar.push(v + '(dark)');
});
ok('json 里引用的 @变量两侧都有定义', missingVar.length === 0, missingVar.join(','));
const unusedVar = Object.keys(theme.light || {}).filter((k) => !refs.has('@' + k));
ok('theme.json 没有没人引用的变量', unusedVar.length === 0, unusedVar.join(','));

/* ---------------- ② wxss 令牌 ---------------- */

const appWxss = fs.readFileSync(path.join(APP, 'app.wxss'), 'utf8');
const MEDIA = '@media (prefers-color-scheme: dark)';
const mediaAt = appWxss.indexOf(MEDIA);
ok('app.wxss 里有 prefers-color-scheme: dark 的媒体查询', mediaAt >= 0);

let darkBlock = '';
if (mediaAt >= 0) {
  const brace = appWxss.indexOf('{', mediaAt);
  darkBlock = blockAt(appWxss, brace);
}
const lightPart = mediaAt >= 0 ? appWxss.slice(0, mediaAt) : appWxss;

// 令牌分两族：
//   --c-*            色彩令牌：深浅两套都必须定义（深色漏一个 = 深色下保持浅色值）
//   --fs/--sp/--r/--sh 尺度令牌：深浅同值，只在浅色侧定义一次；
//                    深色块里出现尺度令牌 = 有人误以为它要随主题变，拦下来
const COLOR = /^--c-/;
const SCALE = /^--(fs|sp|r|sh)-/;
const defRe = /(--(?:c|fs|sp|r|sh)-[a-z0-9-]+)\s*:/g;
const lightTokens = new Set();
let m;
while ((m = defRe.exec(lightPart))) lightTokens.add(m[1]);
const darkTokens = new Set();
while ((m = defRe.exec(darkBlock))) darkTokens.add(m[1]);

ok('浅色侧定义了令牌', lightTokens.size > 0, lightTokens.size);
ok('深色侧定义了令牌', darkTokens.size > 0, darkTokens.size);

// 最关键的一条：色彩令牌两侧集合必须完全一致
const lightColors = [...lightTokens].filter((t) => COLOR.test(t));
const darkColors = [...darkTokens].filter((t) => COLOR.test(t));
const onlyLight = lightColors.filter((t) => !darkTokens.has(t));
const onlyDark = darkColors.filter((t) => !lightTokens.has(t));
ok('深色块里的色彩令牌与浅色完全对齐（漏一个就会在深色下保持浅色值）',
  onlyLight.length === 0 && onlyDark.length === 0,
  JSON.stringify({ 只有浅色有: onlyLight, 只有深色有: onlyDark }));

// 尺度令牌不该出现在深色块（字号/间距/圆角/阴影结构不随主题变；
// 阴影的深浅变化走 --c-shadow* 色值令牌，--sh-* 只是引用它们）
const scaleInDark = [...darkTokens].filter((t) => SCALE.test(t));
ok('尺度令牌只在浅色侧定义（深色块里不该有 --fs/--sp/--r/--sh）',
  scaleInDark.length === 0, scaleInDark.join(','));

// 引用了的令牌必须都已定义
const wxssFiles = walkWxss(APP, []);
const used = new Map();
wxssFiles.forEach((f) => {
  const t = fs.readFileSync(f, 'utf8');
  (t.match(/var\((--(?:c|fs|sp|r|sh)-[a-z0-9-]+)/g) || []).forEach((v) => {
    const key = v.slice(4);
    used.set(key, (used.get(key) || 0) + 1);
  });
});
const dangling = [...used.keys()].filter((k) => !lightTokens.has(k));
ok('没有引用了却没定义的令牌（那条声明会直接失效）', dangling.length === 0, dangling.join(','));
const dead = [...lightTokens].filter((k) => !used.has(k));
ok('没有定义了却没人用的死令牌', dead.length === 0, dead.join(','));

/* ---------------- ③ 结果 ---------------- */

console.log('深色模式令牌检查');
console.log('  令牌 ' + lightTokens.size + ' 个（浅色/深色两侧各一套）');
console.log('  被引用 ' + used.size + ' 处种类 · 共 ' + wxssFiles.length + ' 个 wxss 文件');
console.log('  主题变量 ' + refs.size + ' 个（app.json / 页面 json 引用的 @变量）');
console.log('');
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  ✗ ' + f));
  console.log('\n还有没走令牌的写死色值？跑：');
  console.log('  python mptools/tokenize-colors.py --report');
  process.exit(1);
}
console.log('通过 ' + pass + ' 项，全部通过');
