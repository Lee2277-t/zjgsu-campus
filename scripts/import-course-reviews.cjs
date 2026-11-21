#!/usr/bin/env node
/**
 * 课程评价导入器（选课指南 / 通识课信息）
 *
 * 默认 dry-run，不联网。只有显式 --confirm 才写云端。
 *
 * 用法：
 *   node scripts/import-course-reviews.cjs --file=data/course-review-import/trial.json --batch=guide-trial-20261019
 *   node scripts/import-course-reviews.cjs --file=data/course-review-import/trial.json --batch=guide-trial-20261019 --confirm
 *   node scripts/import-course-reviews.cjs --inspect
 *   node scripts/import-course-reviews.cjs --rollback=guide-trial-20261019 --confirm
 *
 * 说明：
 *   - score=0 表示“只展示文字、不参与均分”；前端已按这个口径处理。
 *   - 同一批次重复执行按 id 跳过，不会重复写；不同批次仍允许保留相同内容
 *     （因为用户明确要求“不要去重，可能是不同人填的相同信息”）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'course-review-import');
const CRED = path.join(__dirname, '.exam-upload.json');
const TOKEN_CACHE = path.join(__dirname, '.exam-upload-token.json');
const ENV = 'cloud1-your-env-id';
const COL = 'reviews';
const UA = 'zjgsu-course-review-importer';

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(p, val) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(val, null, 2), 'utf8');
}
function contentLength(body) {
  if (body == null) return 0;
  return Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body), 'utf8');
}
function request(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = Object.assign({ 'User-Agent': UA }, headers || {});
    if (body != null && body.length) h['Content-Length'] = contentLength(body);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: method, headers: h }, (res) => {
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(bufs).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('请求超时')));
    if (body) req.write(body);
    req.end();
  });
}
async function get(url) { return (await request(url, 'GET', null, {})).body; }
function loadCred() {
  const c = readJson(CRED, null);
  if (!c || !c.appid || !c.secret) {
    console.error('缺少凭据：' + CRED + ' 需要 appid 和 secret');
    process.exit(1);
  }
  return c;
}
async function accessToken(cred) {
  const c = readJson(TOKEN_CACHE, null);
  if (c && c.token && c.at && Date.now() - c.at < 100 * 60 * 1000) return c.token;
  const raw = await get('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential'
    + '&appid=' + encodeURIComponent(cred.appid)
    + '&secret=' + encodeURIComponent(cred.secret));
  const j = JSON.parse(raw);
  if (!j.access_token) throw new Error('拿不到 access_token：' + (j.errmsg || raw.slice(0, 200)));
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ token: j.access_token, at: Date.now() }), 'utf8');
  return j.access_token;
}
async function tcb(token, action, query) {
  const raw = await request('https://api.weixin.qq.com/tcb/' + action + '?access_token=' + token,
    'POST', JSON.stringify({ env: ENV, query: query }), { 'Content-Type': 'application/json' });
  try {
    const j = JSON.parse(raw.body);
    if (j.errcode === 40001 || j.errcode === 42001) return { stale: true };
    return j;
  } catch (e) {
    return { bad: true, raw: raw.status + ' ' + raw.body.slice(0, 200) };
  }
}
function esc(s) { return JSON.stringify(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function qAdd(doc) { return "db.collection('" + COL + "').add({data:" + esc(doc) + '})'; }
function qByBatch(batch) { return "db.collection('" + COL + "').where({importBatch:" + esc(batch) + "}).limit(1000).get()"; }
function qRemoveBatch(batch) { return "db.collection('" + COL + "').where({importBatch:" + esc(batch) + "}).remove()"; }

function parseRows(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw) {
    try { const p = JSON.parse(raw); arr = Array.isArray(p) ? p : []; } catch (e) { arr = []; }
  }
  const out = [];
  arr.forEach((it) => {
    if (it && typeof it === 'object') out.push(it);
    else if (typeof it === 'string' && it) {
      try { out.push(JSON.parse(it)); } catch (e) { /* 跳过脏数据 */ }
    }
  });
  return out;
}

function tagsOf(r) {
  const c = String(r.content || '');
  const tags = [];
  if (/90\+|95\+|给分高|分高|高分|给分很好|给分好/.test(c)) tags.push('给分好');
  if (/作业多|论文.{0,6}(篇|字)|小论文|大作业/.test(c)) tags.push('作业多');
  if (/点名|签到|考勤/.test(c)) tags.push('点名勤');
  if (/很水|水课|轻松|不点名|不管/.test(c)) tags.push('水课');
  if (/考试难|很难|挂科/.test(c)) tags.push('考试难');
  if (/老师.{0,6}(很好|不错|负责|耐心|温柔|人很好)|人也挺好|人美心善/.test(c)) tags.push('老师很棒');
  if (r.score === 0 && /^(点名方式|考试方式)/.test(c)) tags.push('课程信息');
  return tags.slice(0, 8);
}

function docOf(r, batch) {
  const key = [batch, r.sourceFile, r.sourceSheet, r.sourceRow].join('|');
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  const now = Date.now();
  const doc = {
    id: 'imp_' + hash,
    courseId: String(r.courseId || ''),
    courseName: String(r.courseName || r.courseRaw || '').slice(0, 40),
    score: Number(r.score) || 0,
    content: String(r.content || '').slice(0, 1000),
    tags: tagsOf(r),
    teacher: String(r.teacher || '').slice(0, 20),
    teacherVerified: !!r.teacherVerified,
    teacherScore: Math.max(0, Math.min(5, Number(r.teacherScore) || 0)),
    anonymous: true,
    // 导入内容没有真实微信 openid。留空会让举报链路在服务端判定“没被举报的对象”。
    // 用保留来源 ID 只用于举报/审核定位，不会被当成真实用户展示。
    openid: 'import:course-guide',
    author: '选课指南整理',
    nickName: '选课指南整理',
    time: '2026-10-19',
    at: now,
    status: 'normal',
    helpful: 0,
    importSource: 'course-guide-2026-10',
    importBatch: batch,
    importKey: key,
    sourceFile: r.sourceFile,
    sourceSheet: r.sourceSheet,
    sourceRow: Number(r.sourceRow) || 0,
    sourceDate: '2026-10',
    courseRaw: r.courseRaw || '',
    teacherRaw: r.teacherRaw || '',
    sentimentRaw: r.sentimentRaw || '',
    teacherScoreBasis: r.teacherScoreBasis || '',
    contentRaw: r.contentRaw || ''
  };
  return doc;
}

async function getTokenAndRefresh() {
  const cred = loadCred();
  let token = await accessToken(cred);
  const refresh = async () => {
    try { fs.unlinkSync(TOKEN_CACHE); } catch (e) {}
    return accessToken(cred);
  };
  return { token, refresh };
}

async function existingBatch(token, refresh, batch) {
  let j = await tcb(token, 'databasequery', qByBatch(batch));
  if (j && j.stale) { token = await refresh(); j = await tcb(token, 'databasequery', qByBatch(batch)); }
  if (j && (j.bad || j.errcode)) throw new Error('查询已有导入失败：' + (j.raw || j.errcode + ' ' + (j.errmsg || '')));
  return { token, rows: parseRows(j && j.data) };
}

async function inspect() {
  const { token, refresh } = await getTokenAndRefresh();
  let t = token;
  let j = await tcb(t, 'databasequery', "db.collection('" + COL + "').count()");
  if (j && j.stale) { t = await refresh(); j = await tcb(t, 'databasequery', "db.collection('" + COL + "').count()"); }
  console.log('reviews count:', j && (j.total != null ? j.total : JSON.stringify(j).slice(0, 200)));
  let q = await tcb(t, 'databasequery', "db.collection('" + COL + "').where({importSource:'course-guide-2026-10'}).limit(20).get()");
  if (q && q.stale) { t = await refresh(); q = await tcb(t, 'databasequery', "db.collection('" + COL + "').where({importSource:'course-guide-2026-10'}).limit(20).get()"); }
  const rows = parseRows(q && q.data);
  console.log('已导入样本:', rows.length);
  rows.slice(0, 5).forEach((r) => console.log(' ', r.id, r.importBatch, r.courseName, r.score, r.teacher, String(r.content || '').slice(0, 40)));
  if (process.argv.indexOf('--dump') >= 0 && rows[0]) {
    console.log('--- 第一条完整记录 ---');
    console.log(JSON.stringify(rows[0], null, 2));
  }
}

async function repairOpenid(batch) {
  const { token, refresh } = await getTokenAndRefresh();
  let t = token;
  let j = await tcb(t, 'databasequery', qByBatch(batch));
  if (j && j.stale) { t = await refresh(); j = await tcb(t, 'databasequery', qByBatch(batch)); }
  const rows = parseRows(j && j.data);
  console.log('修复批次 ' + batch + '：查到 ' + rows.length + ' 条');
  let ok = 0, fail = 0;
  for (const r of rows) {
    if (!r._id) continue;
    if (r.openid === 'import:course-guide') { ok += 1; continue; }
    let u = await tcb(t, 'databaseupdate', "db.collection('" + COL + "').doc('" + String(r._id) + "').update({data:{openid:'import:course-guide'}})");
    if (u && u.stale) { t = await refresh(); u = await tcb(t, 'databaseupdate', "db.collection('" + COL + "').doc('" + String(r._id) + "').update({data:{openid:'import:course-guide'}})"); }
    if (u && (u.bad || u.errcode)) { fail += 1; if (fail <= 3) console.error('  失败 ' + r._id + '：' + (u.raw || u.errcode + ' ' + (u.errmsg || ''))); }
    else ok += 1;
  }
  console.log('修复完成：成功 ' + ok + '，失败 ' + fail);
}

async function rollback(batch) {
  const { token, refresh } = await getTokenAndRefresh();
  let t = token;
  let j = await tcb(t, 'databasequery', qByBatch(batch));
  if (j && j.stale) { t = await refresh(); j = await tcb(t, 'databasequery', qByBatch(batch)); }
  const rows = parseRows(j && j.data);
  console.log('回滚批次 ' + batch + '：查到 ' + rows.length + ' 条');
  if (!rows.length) return;
  let d = await tcb(t, 'databasedelete', qRemoveBatch(batch));
  if (d && d.stale) { t = await refresh(); d = await tcb(t, 'databasedelete', qRemoveBatch(batch)); }
  if (d && (d.bad || d.errcode)) throw new Error('回滚失败：' + (d.raw || d.errcode + ' ' + (d.errmsg || '')));
  console.log('已回滚', rows.length, '条');
}

async function main() {
  const argv = process.argv.slice(2);
  const getArg = (name) => {
    const p = argv.find((a) => a.indexOf('--' + name + '=') === 0);
    return p ? p.slice(name.length + 3) : '';
  };
  if (argv.indexOf('--inspect') >= 0) return inspect();
  const repairBatch = getArg('repair-openid');
  if (repairBatch) {
    if (argv.indexOf('--confirm') < 0) {
      console.log('这是修复 openid 的操作，默认不执行。确认后加 --confirm。批次：' + repairBatch);
      return;
    }
    return repairOpenid(repairBatch);
  }
  const rollbackBatch = getArg('rollback');
  if (rollbackBatch) {
    if (argv.indexOf('--confirm') < 0) {
      console.log('这是回滚操作，默认不执行。确认后加 --confirm。批次：' + rollbackBatch);
      return;
    }
    return rollback(rollbackBatch);
  }

  const fileArg = getArg('file') || 'data/course-review-import/trial.json';
  const batch = getArg('batch') || 'guide-trial-20261019';
  const file = path.isAbsolute(fileArg) ? fileArg : path.resolve(ROOT, fileArg);
  const rows = readJson(file, null);
  if (!Array.isArray(rows) || !rows.length) {
    console.error('读不到候选：' + file);
    process.exit(1);
  }
  const limit = Number(getArg('limit') || 0) || rows.length;
  const picked = rows.slice(0, limit);
  const docs = picked.map((r) => docOf(r, batch));
  const scored = docs.filter((d) => d.score > 0).length;
  const unscored = docs.length - scored;
  console.log('来源：' + path.relative(ROOT, file));
  console.log('批次：' + batch);
  console.log('候选：' + docs.length + ' 条（有评分 ' + scored + '，仅文字 ' + unscored + '）');
  docs.slice(0, 5).forEach((d) => console.log(' ', d.id, '|', d.courseName, '| score', d.score, '| teacherScore', d.teacherScore, '|', d.content.slice(0, 50)));

  if (argv.indexOf('--confirm') < 0) {
    console.log('\n当前是 dry-run：未联网、未写库。确认后加 --confirm。');
    writeJson(path.join(DATA, 'dry-run-' + batch + '.json'), docs);
    return;
  }

  const { token, refresh } = await getTokenAndRefresh();
  let t = token;
  const old = await existingBatch(t, refresh, batch);
  t = old.token;
  const had = {};
  old.rows.forEach((r) => { if (r.id) had[r.id] = 1; });
  console.log('云端已有本批次：' + old.rows.length + ' 条，将跳过同 id 记录');

  let ok = 0, fail = 0;
  const done = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (had[d.id]) { ok += 1; done.push(d); continue; }
    let j = await tcb(t, 'databaseadd', qAdd(d));
    if (j && j.stale) { t = await refresh(); j = await tcb(t, 'databaseadd', qAdd(d)); }
    if (j && (j.bad || j.errcode)) {
      fail += 1;
      if (fail <= 5) console.error('  失败 ' + d.id + '：' + (j.raw || j.errcode + ' ' + (j.errmsg || '')));
    } else {
      ok += 1;
      done.push(d);
      if (i < docs.length - 1) await new Promise((res) => setTimeout(res, 120));
    }
  }
  writeJson(path.join(DATA, 'rollback-' + batch + '.json'), done.map((d) => d.id));
  console.log('\n完成：成功 ' + ok + '，失败 ' + fail);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
