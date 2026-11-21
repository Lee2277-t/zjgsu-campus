// scripts/test-exam-papers.cjs —— 历年真题导入的守门测试
//
// 真题走的是「和学生上传资料完全相同」的那条路：
//   scripts/import-exam-papers.cjs 把 PDF 传进云存储，
//   再往 resources 集合写一条元数据。
// 所以这里验的不是某个独立页面，而是**写进去的那条数据长什么样** ——
// 字段对不上，学生在学习资料页看到的就是残缺的一份：
// 没有 sizeText、点开没有文件、排序飘到十几年前，而且全都不报错。
//
// 元数据构造直接 require 导入脚本导出的方法，不在测试里抄一份规则 ——
// 抄一份就等于没有规则。
//
// 跑法：node scripts/test-exam-papers.cjs（工作目录在 recon/ 下）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram', 'zjgsu-campus');

let pass = 0;
const fails = [];

function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  ← ' + JSON.stringify(extra)));
}
function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
const readCloudSource = require('./cloud-source.cjs');
function readProj(rel) {
  return read(path.join(APP, rel));
}

/* ---------------- 1. 扫描结果 ---------------- */

const SRC = path.join(ROOT, 'data', 'exam-papers.json');
ok('扫描结果存在', fs.existsSync(SRC));
const src = fs.existsSync(SRC) ? JSON.parse(read(SRC)) : { items: [] };
const items = src.items || [];

ok('扫到了卷子', items.length > 0, items.length);
ok('份数过百（真题库该有的规模）', items.length >= 100, items.length);

const seen = {};
let dupId = null;
items.forEach((r) => {
  if (seen[r.id]) dupId = r.id;
  seen[r.id] = 1;
});
ok('id 不重复（导入时拿它做幂等键）', !dupId, dupId);

ok('每条都有课程名（列表显示 + 搜索命中都靠它）',
  items.every((r) => !!String(r.course || '').trim()),
  items.filter((r) => !r.course).slice(0, 3).map((r) => r.file));
ok('每条都有原始文件名（传丢时能照着找回原件）',
  items.every((r) => !!String(r.file || '').trim()));

// 清单指向的本地文件还在不在：导入脚本是按这份清单读盘的，
// 文件被移动过就会在跑到一半时报「本地文件不见了」。
// path 是相对扫描目录的相对路径，根目录记在 source 里
ok('扫描结果记了来源目录（导入要靠它拼绝对路径）', !!src.source, src.source);
const gone = src.source
  ? items.filter((r) => !fs.existsSync(path.join(src.source, r.path))) : [];
ok('清单里的本地文件都还在', src.source && gone.length === 0,
  gone.slice(0, 3).map((r) => r.path));

/* ---------------- 2. 写进 resources 的那条数据 ---------------- */

const api = require('./import-exam-papers.cjs');
ok('导入脚本导出了元数据构造方法（测试不另抄一份规则）',
  typeof api.docOf === 'function');

// 云函数 resourceAdd 里那条 doc 的字段。少任何一个，前端就缺一块
const DOC_FIELDS = ['id', 'title', 'desc', 'fileID', 'fileName', 'size',
  'category', 'courseName', 'author', 'openid', 'time', 'at', 'thanks', 'status'];

const all = items.map((r) => api.docOf(r, 'cloud://x/papers/' + r.id + '.pdf', ''));
const sample = all.slice(0, 30);

ok('字段和 resourceAdd 完全一致',
  sample.every((d) => DOC_FIELDS.every((k) => Object.prototype.hasOwnProperty.call(d, k))),
  Object.keys(sample[0] || {}));

ok('category 固定是「真题」（学习资料页靠它分档）',
  sample.every((d) => d.category === '真题'));
ok('status 是 normal（不然会被列表过滤掉）',
  sample.every((d) => d.status === 'normal'));

// resourceAdd 对这些字段有硬截断，超了会被切掉半句
ok('title 不超过 40 字', all.every((d) => d.title.length <= 40),
  all.map((d) => d.title.length).filter((n) => n > 40));
ok('courseName 不超过 30 字', all.every((d) => d.courseName.length <= 30),
  all.map((d) => d.courseName.length).filter((n) => n > 30));
ok('desc 不超过 200 字', all.every((d) => d.desc.length <= 200),
  all.map((d) => d.desc.length).filter((n) => n > 200));
ok('fileName 不超过 60 字', all.every((d) => d.fileName.length <= 60),
  all.map((d) => d.fileName.length).filter((n) => n > 60));

ok('size 是字节（decorateResource 按字节换算 MB / KB）',
  all.every((d) => typeof d.size === 'number' && d.size > 0));
ok('at 是毫秒时间戳（列表按它倒序）',
  all.every((d) => typeof d.at === 'number' && d.at > 1000000000000));
ok('time 是「年-月-日 时:分」（和别的资料显示成一样）',
  all.every((d) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(d.time)),
  all.slice(0, 3).map((d) => d.time));

/* ---------------- 3. 检索：能搜到什么，取决于 title 写了什么 ---------------- */

// 云函数 resourceList 只用 courseName 和 title 做匹配。
// 学年 / 学期 / 卷别不写进 title，这些维度在小程序里就等于搜不到
function hits(q) {
  const k = String(q).toLowerCase();
  return all.filter((d) => d.courseName.toLowerCase().indexOf(k) >= 0
    || d.title.toLowerCase().indexOf(k) >= 0).length;
}
ok('搜课程名能命中', hits('高等数学') > 0, hits('高等数学'));
// 学年写进了 title，才搜得到。用库里真实存在的年份验，不写死某一年
const years = Array.from(new Set(items.map((r) => String(r.year || ''))
  .filter((y) => /\d{4}/.test(y)))).sort();
const lastYear = years[years.length - 1] || '';
ok('搜学年能命中（学年写进了 title）', !!lastYear && hits(lastYear) > 0,
  { 搜: lastYear, 命中: hits(lastYear) });
ok('搜「期末」能命中', hits('期末') > 0, hits('期末'));
ok('搜「A卷」能命中', hits('A卷') > 0, hits('A卷'));
ok('每条 title 都带上了课程名',
  all.every((d) => !d.courseName || d.title.indexOf(d.courseName) >= 0
    || d.title.indexOf(d.courseName.slice(0, 4)) >= 0));

/* ---------------- 4. 排序：at 决定列表顺序 ---------------- */

// 列表按 at 倒序。at 若全用导入时间，185 份就挤在同一天，
// 2023 年的卷子可能排在 2002 年后面
ok('大部分卷子能解析出学年',
  items.filter((r) => /\d{4}/.test(String(r.year || ''))).length > items.length * 0.7,
  items.filter((r) => !/\d{4}/.test(String(r.year || ''))).length + ' 份没解析出学年');
ok('at 不是全部相同（按学年推算过）', new Set(all.map((d) => d.at)).size > 1);
const newest = all.slice().sort((a, b) => b.at - a.at)[0];
ok('排在最前面的是较新的学年', /20[12]\d/.test(newest.title), newest.title);

/* ---------------- 5. 云端要撑得住 185 条 ---------------- */

// 只看 resourceList 这一处：文件里还有别的集合也在用同样的写法，
// 匹配第一处会读到不相干的那一处，然后一直报「不够」
const cloudSrc = readCloudSource();
const fnAt = cloudSrc.indexOf('async function resourceList(');
ok('云函数里有 resourceList', fnAt >= 0);
const fnBody = fnAt >= 0 ? cloudSrc.slice(fnAt, fnAt + 1200) : '';
const lm = fnBody.match(/orderBy\('at',\s*'desc'\)\.limit\((\d+)\)/);
const limit = lm ? Number(lm[1]) : 0;
ok('resourceList 一次拉的条数够放下全部真题', limit >= items.length,
  { 现在: limit, 真题: items.length });

/* ---------------- 6. 没有留下第二个真题库 ---------------- */

ok('app.json 里没有独立真题页的路由',
  readProj('app.json').indexOf('papers/papers') < 0);
ok('没有随包的真题索引', !fs.existsSync(path.join(APP, 'data', 'exam-papers.js')));
ok('没有随包的真题瘦索引', !fs.existsSync(path.join(APP, 'data', 'exam-papers-index.js')));

const resJs = readProj('pages/tool/resources/resources.js');
ok('学习资料页不为真题留特例（数据源只有一个）',
  resJs.indexOf('paperIndex') < 0 && resJs.indexOf('loadPapers') < 0);
ok('学习资料页支持 ?tab=真题（从别处跳过来直接落在那一档）',
  resJs.indexOf('PAPER_TAB') >= 0 && resJs.indexOf('q.tab') >= 0);
ok('学习资料页支持 ?course= 预填搜索', resJs.indexOf('q.course') >= 0);

ok('「我的」页没有真题入口', readProj('pages/mine/mine.wxml').indexOf('goPapers') < 0);
ok('课程详情页没有真题入口', readProj('sub/course/detail/detail.wxml').indexOf('goPapers') < 0);

/* ---------------- 7. 凭证不进仓库 ---------------- */

const gi = read(path.join(ROOT, '.gitignore'));
ok('.gitignore 排除了上传凭证', /\.exam-upload\.json/.test(gi));
ok('.gitignore 排除了 token 缓存', /\.exam-upload-token\.json/.test(gi));

/* ---------------- 汇总 ---------------- */

console.log('');
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过：' + pass + ' 通过 / 0 失败');
