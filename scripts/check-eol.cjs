// scripts/check-eol.cjs —— 行尾风格守卫
//
// 为什么要有这一条：一个文件被整体从 LF 翻成 CRLF（或反过来），**内容一个字没变**，
// 但 git diff 会把整个文件标成重写。那种 diff 没法 review —— 真正的两行改动
// 淹没在三百行"删除+新增"里，谁也看不出你到底改了什么。
// 真踩过一次：批量改色值的脚本（mptools/tokenize-colors.py）默认是文本模式读写，
// Windows 上把 CRLF 写成了 LF，两百多个文件的 diff 全废。
//
// 只查**已改动**的文件（git diff --name-only）：没改动就不可能被翻转，
// 全量扫 488 个文件既慢又没意义。所以它天然只在"你刚改完东西"的时候有用。
//
// 判断标准是"和 HEAD 比有没有翻转"，**不是**"必须是 LF"。
// 曾经走过一段弯路：`.cjs`/`.py` 不匹配 .gitattributes 里的 `*.js`，落回 `* text=auto`，
// 在 Windows 上等于"检出时转 CRLF" —— 于是这两个扩展名在本机就是 CRLF，
// git 每次碰都要警告一句。那句警告混进脚本输出里，会被误读成"检查挂了"。
// 已在 .gitattributes 里显式声明 `*.py` / `*.cjs` / `*.mjs` 为 eol=lf，警告消失。
// 但**判断标准仍然是"有没有翻转"**：仓库里确实存在历史遗留的 CRLF 文件，
// 一刀切要求 LF 会把那些文件全判成有罪。

const fs = require('fs');
const cp = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function git(args) {
  return cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
}

// 有些人在纯下载的代码包里跑（没有 .git），这时这条检查没有意义，跳过而不是变红
let inRepo = true;
try { git(['rev-parse', '--is-inside-work-tree']); } catch (e) { inRepo = false; }
if (!inRepo) {
  console.log('（不在 git 工作区里，跳过行尾检查）');
  process.exit(0);
}

const files = git(['diff', '--name-only']).trim().split('\n').map((s) => s.trim()).filter(Boolean);

if (!files.length) {
  console.log('没有改动过的文件，行尾检查跳过');
  process.exit(0);
}

let bad = 0;
let checked = 0;

files.forEach((rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return; // 删除掉的文件不用查
  const st = fs.statSync(abs);
  if (st.isDirectory()) return;
  checked += 1;

  let cur = '';
  let head = '';
  try {
    cur = fs.readFileSync(abs).toString('utf8');
    head = git(['show', 'HEAD:' + rel]);
  } catch (e) {
    // 新文件（还没进 HEAD）：只统计，不判定 —— 它没有"原来的样子"可比对
    console.log('  新文件  ' + rel + '  CRLF=' + (cur.match(/\r\n/g) || []).length);
    return;
  }

  const crlf = (cur.match(/\r\n/g) || []).length;
  const hcrlf = (head.match(/\r\n/g) || []).length;
  const hlf = (head.match(/(^|[^\r])\n/g) || []).length;

  // 「翻转」= 原本是纯 LF，现在冒出了 CRLF。反过来（原本 CRLF 现在混了 LF）同样算
  const flipped = (crlf > 0 && hcrlf === 0 && hlf > 0)
    || (hcrlf > 0 && crlf === 0 && (cur.match(/\n/g) || []).length > 0);
  if (flipped) bad += 1;

  console.log((flipped ? '!! 行尾翻转  ' : 'ok  ') + rel
    + '  now(CRLF=' + crlf + ')  head(CRLF=' + hcrlf + ')');
});

console.log('\n查了 ' + checked + ' 个改动文件');

if (bad) {
  console.log('\n有 ' + bad + ' 个文件的行尾风格被翻转，需要回正：');
  console.log('  最快办法：git checkout -- <文件> 之后重做改动，');
  console.log('  或者确认改动内容无误后，把整个文件统一成原来的风格再提交。');
  console.log('  改之前先看一眼 git diff --stat，整文件重写就说明是行尾问题。');
  process.exit(1);
}

console.log('行尾风格全部与 HEAD 一致');

// 自己别被漏跑
const all = fs.readFileSync(path.join(__dirname, 'check-all.cjs'), 'utf8');
if (all.indexOf('check-eol.cjs') < 0) {
  console.log('\n!! check-all.cjs 里没登记 check-eol.cjs，这个脚本等于不存在');
  process.exit(1);
}
