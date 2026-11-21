#!/usr/bin/env node
/**
 * 视觉对齐守护：尺度合法性检查
 *
 * 为什么要有这个脚本：
 *   设计令牌定好了十档字号、五档圆角、4rpx 间距栅格，但"定好"不等于"用上"。
 *   只要有一处手写了 font-size: 27rpx，页面上就多一种字号；攒够十几处，
 *   界面就开始"说不出哪里不对"。这类漂移靠肉眼审稿抓不住——两个 25rpx 和
 *   24rpx 的字并排，没人看得出，但整页的节奏就是散的。
 *   所以把它变成一条能跑的断言：新增的违规当场拦下，历史欠账一次性清完。
 *
 * 检查四项（都是「数值合法性」，不是审美判断）：
 *   1. font-size    必须是十档字阶之一，或 var(--fs-*)
 *   2. border-radius 必须是五档圆角之一，或 0 / 50%（圆点是特例，不进栅格）
 *   3. padding / margin / gap 的 rpx 必须是 4 的倍数
 *      —— 2rpx 是发丝描边，允许；0 允许
 *   4. font-weight  只允许 400 / 500 / 600 / 700（三档字重，不要第四种）
 *
 * 不检查什么：
 *   - width / height：那是尺寸不是间距，走各自的设计意图（头像 88、大图 360…）
 *   - 树洞 / 盲盒两个固定深色页：它们有自己的一套尺度，走白名单
 *   - 写死色值：那是 check-theme.cjs 的活
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram', 'zjgsu-campus');

// 十档字阶（与 app.wxss 的 --fs-* 一一对应）
const FS_OK = new Set([20, 22, 24, 26, 28, 30, 36, 44, 56, 88]);
// 五档圆角
const R_OK = new Set([8, 16, 24, 32, 999]);
// 三档字重
const W_OK = new Set([400, 500, 600, 700]);

// 固定深色主题页：树洞 / 盲盒 / 引导，尺度自成一套，不参与栅格
const EXEMPT_FILE = /pages\/(forum\/hole|campus\/blindbox|user\/guide)\//;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.wxss')) out.push(p);
  }
  return out;
}

const files = walk(path.join(ROOT, 'pages'), [])
  .concat(walk(path.join(ROOT, 'components'), []))
  .concat([path.join(ROOT, 'app.wxss')]);

const bad = { fs: [], radius: [], space: [], weight: [] };

for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  if (EXEMPT_FILE.test(rel)) continue;

  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const ln = i + 1;
    const where = rel + ':' + ln;

    // 跳过注释行
    if (/^\s*\/\*/.test(line) || /^\s*\*/.test(line)) return;

    // 1) 字号
    let m = /(^|[\s;{])font-size:\s*([^;]+);/.exec(line);
    if (m) {
      const v = m[2].trim();
      if (!v.startsWith('var(--fs-')) {
        const num = /^(\d+)rpx$/.exec(v);
        if (!num || !FS_OK.has(Number(num[1]))) bad.fs.push(where + '  font-size: ' + v);
      }
    }

    // 2) 圆角
    m = /(^|[\s;{])border-radius:\s*([^;]+);/.exec(line);
    if (m) {
      const v = m[2].trim();
      // 完全走令牌（`var(--r-l)`）或混合写法（`0 0 0 var(--r-l)`）都合法，
      // 只要字面部分出现在档位里就行
      const allToken = /^var\(--r-[a-z]+\)$/.test(v.trim());
      if (!allToken && v !== '0' && v !== '50%') {
        // 剩下能出现的合法成分只有三种：0（这个角不圆）、档位内的 Nrpx、N%。
        // 除此之外都算看不懂。逐项判定而不是整体正则，混合写法才不会被误伤。
        const parts = v.replace(/var\(--r-[a-z]+\)/g, ' ').trim().split(/\s+/).filter(Boolean);
        const invalid = parts.filter((p) => {
          if (p === '0') return false;
          const r = /^(\d+)rpx$/.exec(p);
          if (r) return !R_OK.has(Number(r[1]));
          if (/^\d+%$/.test(p)) return false;
          return true;
        });
        if (invalid.length) bad.radius.push(where + '  border-radius: ' + v);
      }
    }

    // 3) 间距：4rpx 栅格
    m = /(^|[\s;{])(padding|margin|gap)(-(top|bottom|left|right|inline|block))?:\s*([^;]+);/.exec(line);
    if (m) {
      const v = m[5].trim();
      if (!v.startsWith('var(')) {
        // 取所有 rpx 数值，剔除 calc() 里的安全区变量
        const clean = v.replace(/calc\([^)]*\)/g, ' ').replace(/env\([^)]*\)/g, ' ');
        const nums = (clean.match(/(\d+)rpx/g) || []).map((s) => parseInt(s, 10));
        const off = nums.filter((n) => n !== 0 && n !== 2 && n % 4 !== 0);
        if (off.length) bad.space.push(where + '  ' + m[2] + ': ' + v + '  → 非 4 倍数: ' + off.join(','));
      }
    }

    // 4) 字重
    m = /(^|[\s;{])font-weight:\s*([^;]+);/.exec(line);
    if (m) {
      const v = m[2].trim();
      const n = /^(\d+)$/.exec(v);
      if (!n || !W_OK.has(Number(n[1]))) bad.weight.push(where + '  font-weight: ' + v);
    }
  });
}

let pass = 0;
let fail = 0;
function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label);
    if (detail && detail.length) {
      detail.slice(0, 40).forEach((d) => console.log('      ' + d));
      if (detail.length > 40) console.log('      … 还有 ' + (detail.length - 40) + ' 处');
    }
  }
}

console.log('尺度合法性检查（字号 / 圆角 / 间距 / 字重）');
console.log('  扫了 ' + files.length + ' 个 wxss（树洞 / 盲盒 / 引导页豁免）');
console.log('');

ok(bad.fs.length === 0, '字号都在十档字阶内', bad.fs);
ok(bad.radius.length === 0, '圆角都在五档内（或 0 / 50%）', bad.radius);
ok(bad.space.length === 0, '间距都是 4rpx 的倍数（2rpx 发丝除外）', bad.space);
ok(bad.weight.length === 0, '字重只有 400 / 500 / 600 / 700', bad.weight);

console.log('');
if (fail === 0) {
  console.log('通过 ' + pass + ' 项，全部通过');
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('\n修法：');
  console.log('  字号 → 换成 var(--fs-*)，档位见 app.wxss「字阶」一节');
  console.log('  圆角 → 换成 var(--r-*)');
  console.log('  间距 → 归并到最近的 4 倍数，或直接写 var(--sp-*)');
  console.log('  字重 → 500 以上的都用 600，只有页主标题和大数字才用 700');
}
process.exit(fail === 0 ? 0 : 1);
