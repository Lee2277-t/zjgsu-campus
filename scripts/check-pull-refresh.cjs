// check-pull-refresh.cjs —— 下拉刷新的「覆盖面」体检
//
// 这个检查存在的理由：下拉刷新是一种**错了不报错**的交互。
// 微信只负责在用户往下拽时把那三个点弹出来，什么时候收起来要页面自己调
// wx.stopPullDownRefresh()。少写这个收尾，表现就是转圈转个不停 ——
// 不白屏、不报错、点哪儿都还有反应，唯独那三个点永远在转。
// 这类口子在评审时几乎必漏，只能靠脚本钉。
//
// 三条一起查，任何一条不成立的页面都会被点名：
//   ① 开了 enablePullDownRefresh 的页面，js 里必须有 onPullDownRefresh
//   ② onPullDownRefresh 里必须真的调用 wx.stopPullDownRefresh()
//      （而且要在 finally 里 —— 中途抛错也得收尾）
//   ③ 列表不能套在纵向 scroll-view 里 —— 一旦套了，手势被 scroll-view 吃掉，
//      页面级下拉在列表区域**根本不会触发**，只剩下列表上方那一小块能拽动。
//      这正是「局部区域无法触发」最常见的成因。
//
// 用法：node scripts/check-pull-refresh.cjs

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram', 'zjgsu-campus');

const fails = [];
let pass = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}

const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

// app.json 里的 pages + 分包里的页面，都要算进来
const appRaw = fs.readFileSync(path.join(APP, 'app.json'), 'utf8');
const app = JSON.parse(appRaw);
const pagePaths = (app.pages || []).slice();
(app.subPackages || []).forEach((p) => {
  (p.pages || []).forEach((q) => {
    pagePaths.push((p.root ? p.root + '/' : '') + q);
  });
});

// 只看 wxml 里带 scroll-y 的部分，纵向滚动容器才吃下拉手势
function hasVerticalScrollView(wxml) {
  return /<scroll-view[\s\S]*?scroll-y\s*=\s*["'](true|\{\{[^}]*\}\})["']/.test(wxml);
}

// 把 onPullDownRefresh 那一整段（到下一个同级方法为止）抠出来
function handlerBody(js) {
  const at = js.indexOf('onPullDownRefresh(');
  if (at < 0) return '';
  const end = js.indexOf('\n  },', at);
  return end < 0 ? js.slice(at) : js.slice(at, end);
}

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

let enabled = 0;
pagePaths.forEach((p) => {
  const base = path.join(APP, p);
  const jsonPath = base + '.json';
  const jsPath = base + '.js';
  const wxmlPath = base + '.wxml';
  if (!fs.existsSync(jsonPath) || !fs.existsSync(jsPath)) return;

  const jsonRaw = fs.readFileSync(jsonPath, 'utf8');
  let conf = null;
  try { conf = JSON.parse(stripComments(jsonRaw)); } catch (e) { conf = null; }
  if (!conf || conf.enablePullDownRefresh !== true) return;
  enabled += 1;

  // p 已经是完整的页面相对路径（app.json 里的 pages 就是去掉后缀的路径），
  // 后面直接补扩展名即可 —— 再拼一次 basename 会多出一层目录
  const js = read(p + '.js');
  const body = handlerBody(js);

  // ① 有没有接
  ok(p + ' 开了下拉刷新却没写 onPullDownRefresh', body.length > 0);
  if (!body.length) return;

  // ② 收尾在不在、在不在 finally 里
  const stopped = /wx\.stopPullDownRefresh\(/.test(body)
    || /feedback\.hideLoading\(/.test(body);
  ok(p + ' 的 onPullDownRefresh 没有收尾（刷新动画停不下来）', stopped);
  if (/finally\s*\{/.test(body)) {
    ok(p + ' 的收尾不在 finally 里（中途抛错会卡住刷新动画）',
      /finally\s*\{[\s\S]*?(wx\.stopPullDownRefresh|feedback\.hideLoading)/.test(body));
  }

  // ③ 列表有没有被纵向 scroll-view 吞掉手势
  if (fs.existsSync(wxmlPath)) {
    const wxml = read(p + '.wxml');
    ok(p + ' 的列表套在纵向 scroll-view 里（下拉手势会被吃掉）',
      !hasVerticalScrollView(wxml));
  }
});

ok('至少有一个页面开了下拉刷新（这条不通过说明扫描逻辑坏了）', enabled > 0, { enabled: enabled });

/* ---------------- 汇总 ---------------- */
console.log('下拉刷新覆盖面：扫到 ' + enabled + ' 个开了刷新的页面');
if (fails.length) {
  console.log('\n失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + pass + ' 通过 / 0 失败');
