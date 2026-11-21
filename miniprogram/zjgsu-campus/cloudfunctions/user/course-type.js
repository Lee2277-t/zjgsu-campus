// cloudfunctions/user/course-type.js —— 课程类型推断（云函数侧独立一份）
//
// 为什么不直接复用前端 data/seed.js 的函数：云函数有自己的打包目录，
// require 前端文件会把整份 900+ 门课的数据拖进云函数包，得不偿失。
// 判据必须和前端 data/seed.js 的 guessCourseType **保持一致** ——
// 两边判得不一样，同一门课本地显示「通识课」、云端存的是「专业课」，
// 列表筛选就会出现「选了类型课却消失」的鬼现象。改判据时两边一起改。
// 全站课程类型的名册：同学在「添加课程」页能自己挑一个，
// 挑了就以他挑的为准，没挑才走下面的按名推断。
const COURSE_TYPES = ['专业课', '通识课', '体育课', '思政课'];
const DEFAULT_TYPE = '专业课';
const LEGACY_COURSE_TYPES = { '专业必修': '专业课', '专业选修': '专业课' };
function normalizeCourseType(value) {
  const t = String(value || '').trim();
  if (LEGACY_COURSE_TYPES[t]) return LEGACY_COURSE_TYPES[t];
  return COURSE_TYPES.indexOf(t) >= 0 ? t : '';
}

// 只有这 5 门按学校口径归为思政课；毛概 / 形策 / 马原也接受简称。
const POLITICAL_COURSE_NAMES = [
  '习近平法治思想概论',
  '中国近现代史纲要',
  '中国近代史纲要',
  '毛泽东思想和中国特色社会主义理论体系概论',
  '毛概',
  '形势与政策',
  '形策',
  '马克思主义基本原理概论',
  '马克思主义基本原理',
  '马原'
];
function normalizeCourseName(name) {
  return String(name || '').replace(/\s+/g, '');
}
function isPoliticalCourseName(name) {
  const t = normalizeCourseName(name);
  return POLITICAL_COURSE_NAMES.indexOf(t) >= 0;
}

function guessCourseType(name) {
  const t = String(name || '');
  if (/体育|球类|田径|游泳|武术|太极|健美操|瑜伽/.test(t)) return '体育课';
  if (isPoliticalCourseName(t)) return '思政课';
  if (/军事|国防|安全教育|心理健康|职业生涯|就业指导|创新创业|劳动|通识|美育|艺术|音乐|影视|戏剧|书法|美术|大学语文|应用文写作|演讲与口才|沟通|礼仪|生态文明|健康教育|心理/.test(t)) return '通识课';
  return DEFAULT_TYPE;
}

// 同学手挑的类型要过一遍名册：前端传来的东西不能直接信，
// 认不出就按课名重推一次，保证存进库里的一定是这四种之一。
function pickCourseType(want, name) {
  const w = normalizeCourseType(want);
  if (w) return w;
  return guessCourseType(name);
}

module.exports = { COURSE_TYPES, DEFAULT_TYPE, LEGACY_COURSE_TYPES, normalizeCourseType, guessCourseType, pickCourseType };
