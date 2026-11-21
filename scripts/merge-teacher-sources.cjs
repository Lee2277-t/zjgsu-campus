#!/usr/bin/env node
/**
 * 把 data/teacher-sources/ 下各学院的原始稿合并成一份成品名单。
 *
 * 去重口径是「只看名字」：小程序里同学评价时填的只有老师名字，
 * 学院字段是附带的（有就显示，没有也不影响补全和打勾）。
 * 所以两个学院各自列了同名的人，只留一条 —— 与其让补全列表里冒出
 * 两个一模一样的选项让用户不知道选哪个，不如留一条。
 *
 * 用法：node scripts/merge-teacher-sources.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'teacher-sources');
const OUT = path.join(ROOT, 'data', 'zjgsu-teachers-all.json');

// 页面上的学位/职称后缀词，切分出来不能当人名收
const TITLE_WORDS = { 博士: 1, 硕士: 1, 学士: 1, 教授: 1, 副教授: 1, 讲师: 1, 助教: 1, 研究员: 1 };
const NAME_RE = /^[一-龥㐀-䶿·]{2,6}$/;

function main() {
  const files = fs.readdirSync(DIR).filter((f) => /\.cjs$/.test(f)).sort();
  if (!files.length) {
    console.error('没有原始稿：' + DIR);
    process.exit(1);
  }

  const seen = {};
  const rows = [];
  let bad = 0;
  const perCollege = {};

  files.forEach((f) => {
    let mod = null;
    try {
      mod = require(path.join(DIR, f));
    } catch (e) {
      console.error('  读不了 ' + f + '：' + e.message);
      return;
    }
    const college = String(mod.college || '').trim();
    const src = String(mod.sourceUrl || '').trim();
    const raw = Array.isArray(mod.names) ? mod.names.join(' ') : String(mod.names || '');
    let n = 0;
    raw.trim().split(/\s+/).forEach((w) => {
      if (!w || TITLE_WORDS[w]) return;
      if (!NAME_RE.test(w)) { bad += 1; return; }
      if (seen[w]) return;          // 同名只留第一次出现的那条
      seen[w] = 1;
      rows.push({ name: w, college: college, title: '', sourceUrl: src });
      perCollege[college] = (perCollege[college] || 0) + 1;
      n += 1;
    });
    console.log('  ' + f + '  ' + college + '  新增 ' + n);
  });

  const out = {
    meta: {
      collectedAt: new Date().toISOString().slice(0, 10),
      note: '各学院官网「专任教师/师资队伍」页 + 学校教师主页平台，按姓名全局去重',
      sourceFiles: files.length
    },
    total: rows.length,
    teachers: rows
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

  console.log('\n=== 合并完成 ===');
  console.log('原始稿 ' + files.length + ' 个 → 去重后 ' + rows.length + ' 人（不规范词条 ' + bad + '）');
  console.log('--- 按学院 ---');
  Object.keys(perCollege).sort((a, b) => perCollege[b] - perCollege[a])
    .forEach((k) => console.log('  ' + perCollege[k] + '\t' + k));
  console.log('\n输出：' + path.relative(ROOT, OUT));
}

main();
