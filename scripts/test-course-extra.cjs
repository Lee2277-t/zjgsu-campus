// scripts/test-course-extra.cjs —— 回退版课程扩充与老师页 UI 守门
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const oldExt = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (path.resolve(filename).startsWith(path.resolve(PROJ))) return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return oldExt(mod, filename);
};
let pass = 0; const fails = [];
function ok(name, cond, extra) { if (cond) { pass += 1; return; } fails.push(name + (extra === undefined ? '' : '  ← ' + JSON.stringify(extra))); }
function read(rel) { return fs.readFileSync(path.join(PROJ, rel), 'utf8'); }
function normName(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
try {
  const baseExtra = require(path.join(PROJ, 'data', 'courses-extra.js'));
  const historyExtra = require(path.join(PROJ, 'data', 'courses-extra-history.js'));
  const politicalExtra = require(path.join(PROJ, 'data', 'courses-political.js'));
  const extra = baseExtra.concat(historyExtra, politicalExtra);
  const seed = require(path.join(PROJ, 'data', 'seed.js'));
  const ids = new Set(); const names = new Set();
  extra.forEach((c) => { if (c.id) ids.add(c.id); if (c.name) names.add(c.name + '|' + c.college); });
  ok('首批样本保持 33 门', baseExtra.length === 33, baseExtra.length);
  ok('历年公开课程新增 153 门', historyExtra.length === 153, historyExtra.length);
  ok('思政课程新增 7 门', politicalExtra.length === 7, politicalExtra.length);
  ok('新增课程合计 193 门', extra.length === 193, extra.length);
  ok('新增课程没有重复 id', ids.size === extra.length, { ids: ids.size, total: extra.length });
  ok('新增课程没有重复课程名+学院', names.size === extra.length, { names: names.size, total: extra.length });
  ok('新增课程按名称无重复', new Set(extra.map((c) => normName(c.name))).size === extra.length);
  ok('所有样本有来源 URL', extra.every((c) => /^https:\/\/(jww|tgb|marx)\.zjgsu\.edu\.cn\//.test(c.sourceUrl || '')));
  ok('原 903 门课程仍在，去重后 928 门', !!seed.courses.find((c) => c.id === 'c1') && seed.courses.length === 928, seed.courses.length);
  const courseNameKeys = seed.courses.map((c) => normName(c.name));
  ok('课程列表按课程名已去重', new Set(courseNameKeys).size === seed.courses.length, { unique: new Set(courseNameKeys).size, total: seed.courses.length });
  ok('新增课程已标记 official builtin', extra.every((c) => seed.courses.find((x) => x.id === c.id && x.builtin === true)));
  ok('课程类型名册已合并为四类', JSON.stringify(seed.COURSE_TYPES) === JSON.stringify(['专业课', '通识课', '体育课', '思政课']), seed.COURSE_TYPES);
  const political = seed.courses.filter((c) => c.ctype === '思政课').map((c) => c.name);
  ok('思政课只保留指定五门', JSON.stringify(political) === JSON.stringify([
    '习近平法治思想概论',
    '中国近现代史纲要',
    '毛泽东思想和中国特色社会主义理论体系概论',
    '形势与政策',
    '马克思主义基本原理概论'
  ]), political);
  const courseOf = (name) => seed.courses.find((c) => c.name === name) || {};
  ok('马克思主义新闻观归入专业课', courseOf('马克思主义新闻观').ctype === '专业课');
  ok('马克思主义哲学归入专业课', courseOf('马克思主义哲学').ctype === '专业课');
  ok('思想道德修养与法律基础改为通识课', courseOf('思想道德修养与法律基础').ctype === '通识课');
  ok('当代世界经济与政治改为通识课', courseOf('当代世界经济与政治').ctype === '通识课');
  ok('思想政治理论课实践教学改为通识课', courseOf('思想政治理论课实践教学').ctype === '通识课');
  const tally = seed.courses.reduce((m, c) => { m[c.ctype] = (m[c.ctype] || 0) + 1; return m; }, {});
  ok('分类数量为 723 / 187 / 5 / 13', tally['专业课'] === 723 && tally['通识课'] === 187 && tally['思政课'] === 5 && tally['体育课'] === 13, tally);
  const list = read('pages/course/list/list.wxml');
  const listJs = read('pages/course/list/list.js');
  ok('课程列表不再显示老师评价数量角标', list.indexOf('teacherCount') < 0 && list.indexOf('ls-seg-num') < 0 && listJs.indexOf('teacherCount') < 0);
  ok('课程列表老师卡不再显示官方名录', list.indexOf('官方名录') < 0);
  ok('课程列表已改为四类筛选项', listJs.indexOf("'专业课'") >= 0 && listJs.indexOf("'专业必修'") < 0 && listJs.indexOf("'专业选修'") < 0 && listJs.indexOf("'思政课'") >= 0);
  const teacher = read('sub/course/teacher/teacher.wxml');
  ok('老师页不再显示官方名录提示', teacher.indexOf('官方名录') < 0 && teacher.indexOf('名录里还没查到') < 0);
  ok('老师主评价标题不再显示数量', teacher.indexOf('的评价（{{count}}）') < 0);
  const detail = read('sub/course/detail/detail.wxml');
  ok('无学分课程显示待确认而不是 0 学分', detail.indexOf('学分待确认') >= 0);
  console.log('\n课程扩充与老师页检查：通过 ' + pass);
} finally {
  Module._extensions['.js'] = oldExt;
}
if (fails.length) { console.error(fails.join('\n')); process.exit(1); }
