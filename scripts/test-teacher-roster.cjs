// scripts/test-teacher-roster.cjs —— 教师名录的守门测试
//
// 名录 1600+ 人之后，最大的风险不是「采不到人」，而是**采到了却搜不出来**：
// 云数据库单次 get 的硬上限是 1000 条，超了写 limit(1500) 直接报错，
// 写 limit(1000) 则默默只给前 1000 个 —— 不报错，只是后面那位老师怎么搜都搜不到，
// 而且按自然序截断，丢的是谁完全不可预期。
//
// 所以这里钉死三件事：取数必须分页、分页必须真的用到、前端不能拿全量文档。
// 顺带守住原始稿的格式（段名写错会把 43 位副教授写成教授）。
//
// 跑法：node scripts/test-teacher-roster.cjs（工作目录在 recon/ 下）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const DIR = path.join(ROOT, 'data', 'teacher-sources');

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
const userApiText = readProj('utils/user.js');

/* ---------------- 1. 原始稿格式 ---------------- */

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /\.cjs$/.test(f)) : [];
ok('有学院原始稿', files.length > 0, files.length);

let people = 0;
const seenName = {};
const colleges = {};
files.forEach((f) => {
  let m = null;
  try { m = require(path.join(DIR, f)); } catch (e) { m = null; }
  ok(f + ' 能被加载', !!m);
  if (!m) return;
  ok(f + ' 有学院名', !!String(m.college || '').trim());
  ok(f + ' 有来源 URL', !!String(m.sourceUrl || '').trim());
  ok(f + ' 有 names', typeof m.names === 'string' || Array.isArray(m.names));

  // 段名必须照抄页面原话。用 senior/mid 缩写的话，
  // 隔几天就分不清记的是正高还是副高 —— 已经把一批副教授误写成教授过
  const badKeys = Object.keys(m).filter((k) => /^(senior|mid|junior|associate|professor)$/i.test(k));
  ok(f + ' 没用 senior/mid 缩写段名', badKeys.length === 0, badKeys);

  const raw = Array.isArray(m.names) ? m.names.join(' ') : String(m.names || '');
  const words = raw.trim().split(/\s+/).filter(Boolean);
  ok(f + ' 名单非空', words.length > 0, words.length);
  words.forEach((w) => {
    // 页面排版会把「陈可先 博士」切成两个词，而「博士」也是 2 个汉字，
    // 光靠字符范围拦不住，会被当成一位叫「博士」的老师
    ok(f + ' 名单里没有混入职称学位词：' + w,
      ['博士', '硕士', '学士', '教授', '副教授', '讲师', '助教', '研究员'].indexOf(w) < 0);
    ok(f + ' 姓名格式合法：' + w, /^[一-龥㐀-䶿·]{2,6}$/.test(w));
    if (/^[一-龥㐀-䶿·]{2,6}$/.test(w)) {
      if (!seenName[w]) { people += 1; seenName[w] = 1; }
    }
  });
  colleges[m.college] = (colleges[m.college] || 0) + 1;
});
ok('去重后人数够多（>800）', people > 800, people);
ok('覆盖学院够多（>15）', Object.keys(colleges).length > 15, Object.keys(colleges).length);

/* ---------------- 2. 云函数取数必须分页 ---------------- */

const cloud = readCloudSource();

// 裸的 limit(1000) 会悄悄截断；名录已经 1600+，这个数字必须消失
ok('teacherList 里没有裸 limit(1000)',
  !/COL_TEACHERS\)\s*\.limit\(1000\)/.test(cloud));
ok('teacherList 里没有裸 limit(500)',
  !/COL_TEACHERS\)\s*\.limit\(500\)/.test(cloud));
ok('有取全量的辅助函数', /async function fetchAllTeachers/.test(cloud));
ok('取全量用了分页',
  /skip\(\s*i\s*\*\s*TEACHER_PAGE\s*\)/.test(cloud) || /skip\(/.test(cloud));
ok('页数常量是 1000（云数据库单次 get 上限）', /TEACHER_PAGE\s*=\s*1000/.test(cloud));
ok('teacherList 无关键词分支走全量', /let list = await fetchAllTeachers\(\)/.test(cloud));
// 搜索那支也必须翻全量：之前只取前 500 条，
// 名录一过 500 人，排在后面的老师输入全名也搜不出来
ok('teacherList 搜索分支也走全量',
  (cloud.match(/await fetchAllTeachers\(\)/g) || []).length >= 2);

/* ---------------- 3. 轻量接口（前端别搬全量文档） ---------------- */

ok('有只返回名字的 teacherNames 函数', /async function teacherNames\(/.test(cloud));
ok('teacherNames 路由已注册', /case 'teacherNames':/.test(cloud));
ok('teacherNames 走取全量', /function teacherNames\(\)[\s\S]{0,200}fetchAllTeachers/.test(cloud));

const userApi = userApiText;
ok('前端封装了 teacherNames', /function teacherNames\(\)/.test(userApi));
ok('前端导出了 teacherNames', /teacherNames,/.test(userApi));
ok('前端调的是新接口', /teacherNames\(\{\}\)/.test(userApi) || /call\('teacherNames'/.test(userApi));

// 课程列表页一进页面就要全量名录，走 teacherList 会把 1600 条整份文档搬回前端
const listJs = readProj('pages/course/list/list.js');
ok('课程列表页改用轻量接口', /userApi\.teacherNames\(\)/.test(listJs));
ok('课程列表页不再拉全量文档', !/teacherList\('', ''\)/.test(listJs));

/* ---------------- 4. 版本指纹 ---------------- */

const builds = [];
[['cloudfunctions/user/index.js', /const BUILD = '([^']+)'/],
 ['pages/campus/campus.js', /const CLOUD_BUILD = '([^']+)'/],
 ['pages/user/about/about.js', /const EXPECT_BUILD = '([^']+)'/]].forEach(([rel, re]) => {
  const m = readProj(rel).match(re);
  ok('取到指纹 ' + rel, !!m);
  if (m) builds.push(m[1]);
});
ok('三处指纹一致', builds.length === 3 && builds[0] === builds[1] && builds[1] === builds[2], builds);

/* ---------------- 5. 导入脚本 ---------------- */

const imp = read(path.join(__dirname, 'import-teachers.cjs'));
ok('导入脚本处理了 data 是字符串数组', /typeof it === 'string'/.test(imp));
ok('导入脚本逐项 JSON.parse', /out\.push\(JSON\.parse\(it\)\)/.test(imp));
ok('导入脚本按名字判重', /had\[r\.name\]/.test(imp));
ok('导入脚本支持 --src', /--src=/.test(imp));
ok('导入脚本职称缺失时不写 title', /if \(ti\) doc\.title/.test(imp));

const merge = read(path.join(__dirname, 'merge-teacher-sources.cjs'));
ok('合并脚本按名字去重', /seen\[w\]/.test(merge));

/* ---------------- 结果 ---------------- */

if (fails.length) {
  console.log('教师名录测试：' + pass + ' 通过 / ' + fails.length + ' 失败');
  fails.slice(0, 25).forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('教师名录测试：' + pass + ' 项全部通过（' + people + ' 人 / ' + Object.keys(colleges).length + ' 个学院）');
