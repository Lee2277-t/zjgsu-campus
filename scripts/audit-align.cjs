#!/usr/bin/env node
/**
 * 视觉对齐审计（一次性报告，不参与 check-all）
 *
 * check-ui-scales.cjs 管的是"数值合法不合法"，这个脚本管的是"合法但不一致"：
 * 每页都自成一派地挑了一个合法的左边距，每页单独看都对，
 * 但在 tab 之间来回切的时候，内容会左右跳 —— 这就是用户说的"排列不整齐"。
 *
 * 报告三件事：
 *   1. 各页顶层容器的水平内边距分布（对齐基准线：内容左边缘该在同一条竖线上）
 *   2. 卡片之间的垂直间距分布（节奏：同层级卡片之间隔多少）
 *   3. 列表行的最小高度分布（热区：同类列表行该一样高）
 *
 * 用法：node scripts/audit-align.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram', 'zjgsu-campus');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.wxss')) out.push(p);
  }
  return out;
}
const files = walk(path.join(ROOT, 'pages'), []);

function group(title, rows) {
  console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 52 - title.length)));
  const by = {};
  rows.forEach((r) => {
    (by[r.key] = by[r.key] || []).push(r);
  });
  Object.keys(by)
    .sort((a, b) => by[b].length - by[a].length)
    .forEach((k) => {
      console.log('  ' + k + '  ×' + by[k].length);
      by[k].slice(0, 8).forEach((r) => console.log('      ' + r.label));
      if (by[k].length > 8) console.log('      … 还有 ' + (by[k].length - 8) + ' 处');
    });
}

// ---------- 1) 顶层容器水平内边距 ----------
const padRows = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  // 顶层容器类：通常是文件里第一个带 padding 的类
  const re = /^\.([\w-]+)\s*\{([^}]*)\}/gm;
  let m;
  let first = null;
  while ((m = re.exec(src))) {
    const body = m[2];
    const pm = /(^|[;\s])padding:\s*([^;]+);/.exec(body);
    if (pm) {
      first = { cls: m[1], v: pm[2].trim() };
      break;
    }
  }
  if (!first) continue;
  const nums = (first.v.match(/(\d+)rpx/g) || []).map((s) => parseInt(s, 10));
  if (nums.length !== 2 && nums.length !== 4) continue;
  const left = nums.length === 4 ? nums[1] : nums[0];
  padRows.push({ key: left + 'rpx', label: rel + '  .' + first.cls + ' { padding: ' + first.v + ' }' });
}
group('顶层容器左边距（内容左边缘该在同一条竖线上）', padRows);

// ---------- 2) 卡片垂直间距 ----------
const gapRows = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*(\/\*|\*)/.test(line)) return;
    const m = /(^|[\s;{])margin-bottom:\s*([^;]+);/.exec(line);
    if (!m) return;
    const v = m[2].trim();
    if (v.startsWith('var(')) return;
    const num = /^(\d+)rpx$/.exec(v);
    if (!num) return;
    // 只看 16~40 这段"卡片之间"的量级，排除 4/8 这类元素内微调
    const n = Number(num[1]);
    if (n < 16 || n > 40) return;
    gapRows.push({ key: n + 'rpx', label: rel + ':' + (i + 1) + '  margin-bottom: ' + v });
  });
}
group('卡片之间的垂直间距（同层级该等距）', gapRows);

// ---------- 3) 列表行最小高度 ----------
const hRows = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const lines = src.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*(\/\*|\*)/.test(line)) return;
    const m = /(^|[\s;{])min-height:\s*([^;]+);/.exec(line);
    if (!m) return;
    const v = m[2].trim();
    const num = /^(\d+)rpx$/.exec(v);
    if (!num) return;
    const n = Number(num[1]);
    if (n < 60) return; // 只看行/按钮级热区
    hRows.push({ key: n + 'rpx', label: rel + ':' + (i + 1) + '  min-height: ' + v });
  });
}
group('列表行 / 按钮最小高度（同类热区该一样高）', hRows);

console.log('\n说明：这只是报告，不是断言。"不一致"不等于"错"——');
console.log('  有的页面留白大是有意的（如首页要呼吸感）。判断标准是：');
console.log('  切到相邻 tab 时，内容会不会左右/上下跳。会跳的就是要修的。');
