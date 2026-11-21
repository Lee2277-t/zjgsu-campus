#!/usr/bin/env node
/**
 * build-teacher-roster.cjs —— 把 data/zjgsu-teachers.source.js 洗成成品
 *
 * 跑法：node scripts/build-teacher-roster.cjs
 *
 * 为什么要单独一个脚本，而不是直接把原始稿当成品用：
 *   1. 源站排版在两字姓名中间插了空格（「王 莹」），不洗会出现同一个人两条记录；
 *   2. 同一个人可能在多个来源出现，职称说法不一致，要定一个取舍规则；
 *   3. 学院名和课库里的口径不一致（站上叫「统计与数学学院」，课库叫「统计与数据科学学院」）。
 *
 * 输出：
 *   data/zjgsu-teachers.json   —— 主数据，带来源与置信度
 *   data/zjgsu-teachers.csv    —— 便于人眼核对
 */

const fs = require('fs');
const path = require('path');
// 必须 .cjs：recon 包是 "type":"module"，.js 会被当成 ESM，require 直接炸
const src = require('../data/zjgsu-teachers.source.cjs');

const ROOT = path.resolve(__dirname, '..');

// 职称高低排序。数字越大越资深，多来源冲突时取资深的那条。
// 依据是「正高 > 副高 > 中级」这个通用序列，不为某一来源背书。
const TITLE_RANK = {
  教授: 5,
  研究员: 5,
  副教授: 4,
  副研究员: 4,
  讲师: 3,
  助教: 2
};

// 来源可信度。S1 是人事处口径的教授全集，最硬；S4 是照片墙，连职称都没有。
const SOURCE_CONFIDENCE = {
  S1: 'high',
  S2: 'high',
  S3: 'high',
  S4: 'low'
};

/** 去掉姓名里所有空白：半角空格、源站排版用的全角空格（U+3000）。 */
function cleanName(raw) {
  return String(raw).replace(/[\s\u3000]/g, '');
}

/** 按 (姓名 + 学院) 去重，职称冲突时取资深的一条，并把冲突记下来供人工复核。 */
function merge() {
  const map = new Map();
  const conflicts = [];

  function put(name, college, title, source) {
    const key = name + '@' + college;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { name, college, title, sources: [source] });
      return;
    }
    // 同一来源重复写入（源站自己重复列了人）直接跳过
    if (existing.sources.includes(source)) return;

    existing.sources.push(source);
    const oldRank = TITLE_RANK[existing.title] || 0;
    const newRank = TITLE_RANK[title] || 0;
    if (newRank > oldRank) {
      conflicts.push({
        name,
        college,
        from: existing.title || '(空)',
        to: title,
        sources: existing.sources.slice()
      });
      existing.title = title;
    } else if (newRank < oldRank && title) {
      conflicts.push({
        name,
        college,
        kept: existing.title || '(空)',
        dropped: title,
        sources: existing.sources.slice()
      });
    }
  }

  for (const [college, names] of Object.entries(src.S1_PROFESSORS)) {
    for (const n of names) put(cleanName(n), college, '教授', 'S1');
  }
  for (const [college, rows] of Object.entries(src.S2_ECONET)) {
    for (const [n, t] of rows) put(cleanName(n), college, t, 'S2');
  }
  for (const [college, rows] of Object.entries(src.S3_FINANCE)) {
    for (const [n, t] of rows) put(cleanName(n), college, t, 'S3');
  }
  for (const [college, names] of Object.entries(src.S4_GSGL_NO_TITLE)) {
    // 这个来源页面没写职称，title 留空，不拿它冒充已知
    for (const n of names) put(cleanName(n), college, '', 'S4');
  }

  return { map, conflicts };
}

const { map, conflicts } = merge();

const teachers = [...map.values()]
  .map((t) => {
    // 置信度取来源里最弱的那条：一条来自照片墙的数据，整体就不能标 high
    const ranks = t.sources.map((s) => SOURCE_CONFIDENCE[s]);
    const confidence = ranks.includes('low') ? 'low' : ranks.includes('mid') ? 'mid' : 'high';
    return {
      name: t.name,
      college: t.college,
      title: t.title || '',
      sources: t.sources.sort().join('+'),
      confidence
    };
  })
  .sort((a, b) =>
    a.college.localeCompare(b.college, 'zh') || a.name.localeCompare(b.name, 'zh')
  );

/* ---------- 统计 ---------- */
const byCollege = {};
const byTitle = {};
for (const t of teachers) {
  byCollege[t.college] = (byCollege[t.college] || 0) + 1;
  byTitle[t.title || '(未知)'] = (byTitle[t.title || '(未知)'] || 0) + 1;
}

const noTitle = teachers.filter((t) => !t.title).length;

const meta = {
  collectedAt: '2026-10-18',
  sources: [
    { id: 'S1', name: '在职正高级专业技术职务人员名单', url: 'http://wap.zjgsu.edu.cn/list-75.html' },
    { id: 'S2', name: '教师个人主页 经济学院', url: 'https://mypage.zjgsu.edu.cn/ssjglm/list.htm?wp_tw_orgId=8' },
    { id: 'S3', name: '金融学院 师资队伍', url: 'http://jrxy.zjsu.edu.cn/3079/list.htm' },
    { id: 'S4', name: '工商管理学院 师资队伍（照片墙，无职称）', url: 'https://gsgl.zjgsu.edu.cn/szdw/list.htm' }
  ],
  note: [
    '仅收录学校主动公开到公网页面的师资信息，未触碰任何需登录的教务系统。',
    '课程与教师不做关联：名单是独立的名册，谁上哪门课不在本轮范围内。',
    'S1 只覆盖正高级，副教授/讲师目前仅经济学院、金融学院两院齐全。'
  ]
};

/* ---------- 落盘 ---------- */
fs.writeFileSync(
  path.join(ROOT, 'data', 'zjgsu-teachers.json'),
  JSON.stringify({ meta, total: teachers.length, teachers }, null, 2),
  'utf8'
);

const csv = ['姓名,学院,职称,来源,置信度']
  .concat(teachers.map((t) => [t.name, t.college, t.title, t.sources, t.confidence].join(',')))
  .join('\n');
// BOM：不然 Excel 打开中文会乱码
fs.writeFileSync(path.join(ROOT, 'data', 'zjgsu-teachers.csv'), '\uFEFF' + csv, 'utf8');

/* ---------- 打印 ---------- */
console.log('=== 浙商大师资名册 构建完成 ===');
console.log('总人数：' + teachers.length);
console.log('缺职称人数：' + noTitle);
console.log('\n--- 按学院 ---');
for (const [c, n] of Object.entries(byCollege).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + n + '\t' + c);
}
console.log('\n--- 按职称 ---');
for (const [t, n] of Object.entries(byTitle).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + n + '\t' + t);
}
if (conflicts.length) {
  console.log('\n--- 职称冲突（已取资深的一条，供人工复核）---');
  for (const c of conflicts) {
    console.log('  ' + c.name + '(' + c.college + '): ' + JSON.stringify(c));
  }
} else {
  console.log('\n无职称冲突');
}
