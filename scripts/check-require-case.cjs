// 真机视角 require 检查：微信真机（iOS/Android）文件系统大小写敏感，
// 而 Windows/macOS 默认不敏感 —— 开发者工具能解析、真机却找不到文件的 require，
// 会让整个 Page() 注册失败（所有 bindtap 失效，但 hover-class 仍生效，表现就是「按下去有变色、之后毫无反应」）。
// 本脚本逐段比对每个相对 require 的真实目录条目大小写，抓出这种只在真机暴露的坑。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram', 'zjgsu-campus');
const SKIP = new Set(['_trash', 'node_modules', 'scripts']);

function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    if (SKIP.has(f)) continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (f.endsWith('.js')) out.push(p);
  }
}

const files = [];
walk(ROOT, files);

const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const issues = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue; // 只查相对路径（npm 包真机也走打包，不查）
    const resolved = path.resolve(path.dirname(f), spec);
    const rel = path.relative(ROOT, resolved);
    const segs = rel.split(path.sep).filter(Boolean);
    let realPath = ROOT;
    let ok = true;
    let badSeg = '';
    for (const s of segs) {
      let entries;
      try { entries = fs.readdirSync(realPath); } catch (e) { ok = false; badSeg = s; break; }
      if (!entries.includes(s)) { ok = false; badSeg = s; break; }
      realPath = path.join(realPath, s);
    }
    if (!ok) {
      issues.push({
        file: path.relative(ROOT, f),
        spec,
        expect: path.relative(ROOT, resolved),
        reason: '真机将找不到该文件（Windows 能解析但大小写不匹配/路径不存在）',
        badSeg
      });
    }
  }
}

console.log('扫描文件数:', files.length);
if (issues.length === 0) {
  console.log('✅ 所有相对 require 路径在真机视角下大小写一致、文件存在');
} else {
  console.log('❌ 发现', issues.length, '处真机可能加载失败的 require：');
  for (const i of issues) {
    console.log('  ', i.file, '->', i.spec, '|', i.reason, i.badSeg ? '(段:' + i.badSeg + ')' : '');
  }
}
process.exit(issues.length ? 1 : 0);
