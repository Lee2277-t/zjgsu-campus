// scan-exam-papers.cjs —— 把「一堆按中文命名的试卷 PDF」整理成可检索的结构化索引
//
// 为什么要单独一个脚本：文件名的信息量全在「人写的时候顺不顺手」上。
// 同一个课程会写成「微积分(上)」「微积分（上）A」「微积分B（上）」，
// 同一份卷子会写成「2017-2018学年期末试卷B卷」和「2017-2018期末试卷B」。
// 手工整理 187 份会漏会错，漏了不报错、只是学生搜不到 —— 这类错误最难发现。
//
// 所以这里做三件事，并且**把折腾不定的那些单独列出来给人看**（不猜）：
//   1. 扫描 PDF，解析出 课程 / 学年 / 学期 / 类型 / A-B卷 / 备注
//   2. 归并同名课程（别名表在下面，可以照着改）
//   3. 输出 JSON（给工程用）+ CSV（给云开发控制台导入用）+ 一份体检报告
//
// 跑法：node scripts/scan-exam-papers.cjs [目录]   （默认 D:/历年真题）

const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || 'D:/历年真题';
const OUT_DIR = path.join(__dirname, '..', 'data');
const OUT_JSON = path.join(OUT_DIR, 'exam-papers.json');
const OUT_CSV = path.join(OUT_DIR, 'exam-papers.csv');

/* ---------------- 课程别名：不同写法归到同一个名字上 ---------------- */
// 左边是文件/目录里的写法，右边是统一后的名字。
// 改这张表不用改代码 —— 它存在的意义就是「人看到的写法」和「检索用的名字」分开。
const COURSE_ALIAS = {
  '微积分(上)': '微积分（上）',
  '微积分（上）A': '微积分（上）',
  '微积分B（上）': '微积分（上）',
  '微积分(上)A': '微积分（上）',
  '微积分（下）': '微积分（下）',
  '微积分（下）A': '微积分（下）',
  '微积分': '微积分',
  '高等数学上': '高等数学（上）',
  '高等数学（上）': '高等数学（上）',
  '高等数学下': '高等数学（下）',
  '高等数学（下）': '高等数学（下）',
  '高等数学': '高等数学',
  '中国近代史纲要': '中国近现代史纲要',
  '思想道德基础与法律修养': '思想道德与法治',
  '毛泽东思想和中国特色社会主义理论体系概论': '毛概',
  '马克思主义哲学原理': '马克思主义基本原理概论',
  'JAVA语言程序设计': 'Java 语言程序设计',
  'web程序设计': 'Web 程序设计',
  'C语言程序设计': 'C 语言程序设计',
  '马克思主义基本原理': '马克思主义基本原理概论',
  // A1 / A2 是学校课号里的「上/下」：高等数学A1 = 上册，A2 = 下册。
  // 拆成两门课的话，学生搜「高等数学（下）」会漏掉 A2 那批卷子
  '高等数学A1': '高等数学（上）',
  '高等数学A2': '高等数学（下）',
  '大学物理A1': '大学物理'
};

// 目录名后面那段「-浙江工商大学」是网盘里的重复目录，不是课程名的一部分
const FOLDER_SUFFIX = /-浙江工商大学$/;

function walk(dir, out) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return out; }
  names.forEach((n) => {
    const p = path.join(dir, n);
    let st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.pdf$/i.test(n)) out.push(p);
  });
  return out;
}

// 课程名：优先取文件名里《》包起来的那个（它最准），
// 否则取「-浙江工商大学」目录名，再不行取父目录名
function pickCourse(absPath, fileName) {
  const m = /《([^》]+)》/.exec(fileName);
  if (m) return m[1].trim();
  const parent = path.basename(path.dirname(absPath));
  const cleaned = parent.replace(FOLDER_SUFFIX, '').trim();
  // 【第3期】这类汇总目录里是散装文件，取不到课程名时不能拿它当课程
  if (/^【|^\d+期|第\d+期/.test(cleaned)) return '';
  return cleaned;
}

function normalizeCourse(raw) {
  const c = String(raw || '').trim();
  if (!c) return '';
  if (COURSE_ALIAS[c]) return COURSE_ALIAS[c];
  // 全角/半角括号统一成全角，避免「微积分(上)」和「微积分（上）」变成两门课
  return c.replace(/\(/g, '（').replace(/\)/g, '）').replace(/\s+/g, ' ').trim();
}

/* ---------- 解析文件名 ---------- */
// 一个文件名里可能同时有：学年、学期、考试类型、AB卷、适用专业备注
function parseName(name) {
  const s = String(name || '').replace(/\.pdf$/i, '').trim();
  const r = { year: '', term: '', kind: '', volume: '', note: '' };

  // 学年：2016-2017 / 2016-2017学年 / 2016—2017。单年的（2021-2022年）也认
  const y = /(\d{4})\s*[-—~]\s*(\d{2,4})/.exec(s);
  if (y) {
    const to = y[2].length === 2 ? y[1].slice(0, 2) + y[2] : y[2];
    r.year = y[1] + '-' + to;
  }
  // 学期：第一学期 / 第二学期 / 第1学期
  const t = /第\s*([一二三1-3])\s*学期/.exec(s);
  if (t) r.term = { 一: '一', 二: '二', 三: '三', 1: '一', 2: '二', 3: '三' }[t[1]] || '';
  else if (/(上|下)学期/.test(s)) r.term = /上学期/.test(s) ? '一' : '二';

  // 类型：期末 > 期中 > 补考 > 重修 > 其他考试
  if (/期末/.test(s)) r.kind = '期末';
  else if (/期中/.test(s)) r.kind = '期中';
  else if (/补考|重修/.test(s)) r.kind = /补考/.test(s) ? '补考' : '重修';
  else if (/考试|试卷/.test(s)) r.kind = '考试';

  // AB 卷：A卷 / B卷 / AB卷；也有人写成「期末试卷B」
  const v = /(AB|A|B)\s*卷/.exec(s);
  if (v) r.volume = v[1] === 'AB' ? 'AB' : v[1] + '卷';
  else {
    const v2 = /试卷\s*(A|B)\s*$/.exec(s);
    if (v2) r.volume = v2[1] + '卷';
  }

  // 备注：括号里的适用专业 / 「（数学统计学专用）」，以及 (1) 这种重名后缀
  const notes = [];
  const re = /[（(]([^（()）]+)[)）]/g;
  let m;
  while ((m = re.exec(s))) {
    const inner = m[1].trim();
    if (/^\d+$/.test(inner)) continue; // (1) 是重名，不是备注
    notes.push(inner);
  }
  r.note = notes.join(' / ');
  return r;
}

/* ---------------- 主流程 ---------------- */
const files = walk(ROOT, []);
console.log('扫描目录：' + ROOT);
console.log('找到 PDF：' + files.length + ' 个');

const records = [];
const noCourse = [];
const noYear = [];
files.forEach((abs) => {
  const file = path.basename(abs);
  const sizeKB = Math.round(fs.statSync(abs).size / 1024);
  const rawCourse = pickCourse(abs, file);
  const meta = parseName(file);
  const course = normalizeCourse(rawCourse);
  if (!course) noCourse.push(abs);
  if (!meta.year) noYear.push(abs);
  records.push({
    course: course,
    courseRaw: rawCourse,
    year: meta.year,
    term: meta.term,
    kind: meta.kind,
    volume: meta.volume,
    note: meta.note,
    file: file,
    path: path.relative(ROOT, abs).replace(/\\/g, '/'),
    sizeKB: sizeKB
  });
});

// 去重：课程+学年+学期+类型+卷 都一样的就是同一份卷子的两个来源
const seen = {};
const unique = [];
let dup = 0;
records.forEach((r) => {
  const key = [r.course, r.year, r.term, r.kind, r.volume, r.note].join('|');
  if (seen[key]) {
    dup += 1;
    // 保留体积大的那个（通常是合并完整版，不是缺页版）
    if (r.sizeKB > seen[key].sizeKB) {
      const i = unique.indexOf(seen[key]);
      unique[i] = r;
      seen[key] = r;
    }
    return;
  }
  seen[key] = r;
  unique.push(r);
});

// 排序：课程 → 学年新→旧 → 学期 → 类型 → 卷
const KIND_ORDER = { 期末: 0, 期中: 1, 补考: 2, 重修: 3, 考试: 4 };
unique.sort((a, b) => {
  if (a.course !== b.course) return a.course < b.course ? -1 : 1;
  if (a.year !== b.year) return a.year < b.year ? 1 : -1;
  if (a.term !== b.term) return (a.term || '') < (b.term || '') ? 1 : -1;
  const ka = KIND_ORDER[a.kind] === undefined ? 9 : KIND_ORDER[a.kind];
  const kb = KIND_ORDER[b.kind] === undefined ? 9 : KIND_ORDER[b.kind];
  if (ka !== kb) return ka - kb;
  return a.volume < b.volume ? -1 : 1;
});

// 编号：id 稳定（同一份卷子每次扫描都拿到同一个 id，方便对账）
const items = unique.map((r, i) => Object.assign({}, r, {
  id: 'ep' + String(i + 1).padStart(4, '0')
}));

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify({
  source: ROOT,
  scannedAt: new Date().toISOString().slice(0, 10),
  total: items.length,
  items: items
}, null, 2), 'utf8');

const esc = (v) => {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const head = ['id', 'course', 'year', 'term', 'kind', 'volume', 'note', 'file', 'sizeKB'];
const lines = [head.join(',')].concat(items.map((it) => head.map((h) => esc(it[h])).join(',')));
fs.writeFileSync(OUT_CSV, lines.join('\n'), 'utf8');

/* ---------------- 体检报告：折腾不定的单独列出来，不猜 ---------------- */
const byCourse = {};
items.forEach((r) => { byCourse[r.course] = (byCourse[r.course] || 0) + 1; });
const courseList = Object.keys(byCourse).sort();

console.log('\n去重后：' + items.length + ' 份（合并掉 ' + dup + ' 份重复来源）');
console.log('课程数：' + courseList.length);
console.log('总大小：' + Math.round(items.reduce((a, b) => a + b.sizeKB, 0) / 1024) + ' MB');
console.log('\n各课程份数：');
courseList.forEach((c) => {
  console.log('  ' + String(byCourse[c]).padStart(3) + '  ' + c);
});

if (noYear.length) {
  console.log('\n⚠ 解析不出学年（' + noYear.length + ' 个，需要手工补）：');
  noYear.slice(0, 20).forEach((p) => console.log('  ' + p));
}
if (noCourse.length) {
  console.log('\n⚠ 取不到课程名（' + noCourse.length + ' 个）：');
  noCourse.slice(0, 20).forEach((p) => console.log('  ' + p));
}

// 疑似同一门课的两种写法（归并表没覆盖到的）
const suspicious = {};
courseList.forEach((c) => {
  const key = c.replace(/[（(].*?[)）]/g, '').replace(/\s/g, '');
  if (!key) return;
  (suspicious[key] = suspicious[key] || []).push(c);
});
const groups = Object.keys(suspicious).filter((k) => suspicious[k].length > 1);
if (groups.length) {
  console.log('\n⚠ 这些名字可能是同一门课（要合并就加进 COURSE_ALIAS）：');
  groups.forEach((k) => console.log('  ' + suspicious[k].join('  /  ')));
}

console.log('\n已写出：');
console.log('  ' + path.relative(process.cwd(), OUT_JSON));
console.log('  ' + path.relative(process.cwd(), OUT_CSV));
