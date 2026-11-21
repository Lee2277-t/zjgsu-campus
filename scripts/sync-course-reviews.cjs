#!/usr/bin/env node
'use strict';
/**
 * 全量同步课程评价：按 sourceKey 做 upsert，不按正文去重。
 * 同一 sourceFile/sheet/row/variant 只保留一条；不同行即使正文相同也各保留。
 *
 *   node scripts/sync-course-reviews.cjs                 # dry-run
 *   node scripts/sync-course-reviews.cjs --confirm       # 写库
 *   node scripts/sync-course-reviews.cjs --confirm --cleanup  # 同时删掉已不在候选里的旧导入记录
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'course-review-import');
const SRC = path.join(DATA, 'candidates.json');
const CRED = path.join(__dirname, '.exam-upload.json');
const TOKEN_CACHE = path.join(__dirname, '.exam-upload-token.json');
const BATCH = 'guide-full-20261019';
const ENV = 'cloud1-your-env-id';
const COL = 'reviews';
const UA = 'zjgsu-course-review-sync';

function readJson(p, f) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return f; } }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); }
function len(b) { return b == null ? 0 : (Buffer.isBuffer(b) ? b.length : Buffer.byteLength(String(b), 'utf8')); }
function request(url, method, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const h = Object.assign({ 'User-Agent': UA }, headers || {});
    if (body != null && body.length) h['Content-Length'] = len(body);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: h }, (res) => {
      const bufs = []; res.on('data', (d) => bufs.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(bufs).toString('utf8') }));
    });
    req.on('error', reject); req.setTimeout(120000, () => req.destroy(new Error('请求超时')));
    if (body) req.write(body); req.end();
  });
}
async function get(url) { return (await request(url, 'GET', null, {})).body; }
function cred() { const c = readJson(CRED, null); if (!c || !c.appid || !c.secret) throw new Error('缺少 ' + CRED); return c; }
async function token() {
  const c = readJson(TOKEN_CACHE, null);
  if (c && c.token && c.at && Date.now() - c.at < 100 * 60 * 1000) return c.token;
  const j = JSON.parse(await get('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + encodeURIComponent(cred().appid) + '&secret=' + encodeURIComponent(cred().secret)));
  if (!j.access_token) throw new Error('拿不到 access_token：' + (j.errmsg || ''));
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ token: j.access_token, at: Date.now() }), 'utf8');
  return j.access_token;
}
async function tcb(t, action, query) {
  const raw = await request('https://api.weixin.qq.com/tcb/' + action + '?access_token=' + t,
    'POST', JSON.stringify({ env: ENV, query }), { 'Content-Type': 'application/json' });
  try { const j = JSON.parse(raw.body); if (j.errcode === 40001 || j.errcode === 42001) return { stale: true }; return j; }
  catch (e) { return { bad: true, raw: raw.status + ' ' + raw.body.slice(0, 200) }; }
}
function esc(s) { return JSON.stringify(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function parseRows(raw) {
  let arr = []; if (Array.isArray(raw)) arr = raw; else if (typeof raw === 'string' && raw) { try { const p = JSON.parse(raw); arr = Array.isArray(p) ? p : []; } catch (e) {} }
  const out = []; arr.forEach((it) => { if (it && typeof it === 'object') out.push(it); else if (typeof it === 'string' && it) { try { out.push(JSON.parse(it)); } catch (e) {} } }); return out;
}
function sourceKeyOf(r) { return [r.sourceFile, r.sourceSheet, r.sourceRow, r.variant || ''].join('|'); }
function tagsOf(r) {
  const c = String(r.content || ''); const tags = [];
  if (/90\+|95\+|给分高|分高|高分|给分很好|给分好/.test(c)) tags.push('给分好');
  if (/作业多|论文.{0,6}(篇|字)|小论文|大作业/.test(c)) tags.push('作业多');
  if (/点名|签到|考勤/.test(c)) tags.push('点名勤');
  if (/很水|水课|轻松|不点名|不管/.test(c)) tags.push('水课');
  if (/考试难|很难|挂科/.test(c)) tags.push('考试难');
  if (/老师.{0,6}(很好|不错|负责|耐心|温柔|人很好)|人也挺好|人美心善/.test(c)) tags.push('老师很棒');
  if (r.score === 0 && /^(点名方式|考试方式)/.test(c)) tags.push('课程信息');
  return tags.slice(0, 8);
}
function docOf(r, i) {
  const key = sourceKeyOf(r);
  const id = 'imp_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return {
    id: id,
    sourceKey: key,
    variant: r.variant || '',
    courseId: String(r.courseId || ''),
    courseName: String(r.courseName || r.courseRaw || '').slice(0, 40),
    score: Number(r.score) || 0,
    content: String(r.content || '').slice(0, 1000),
    tags: tagsOf(r),
    teacher: String(r.teacher || r.teacherRaw || '').slice(0, 20),
    teacherVerified: !!r.teacherVerified,
    teacherScore: Math.max(0, Math.min(5, Number(r.teacherScore) || 0)),
    teacherScoreBasis: r.teacherScoreBasis || '',
    anonymous: true,
    openid: 'import:course-guide',
    author: '选课指南整理',
    nickName: '选课指南整理',
    time: '2026-10-19',
    at: Date.now() + i,
    status: 'normal',
    helpful: 0,
    importSource: 'course-guide-2026-10',
    importBatch: BATCH,
    importKey: key,
    sourceFile: r.sourceFile,
    sourceSheet: r.sourceSheet,
    sourceRow: Number(r.sourceRow) || 0,
    sourceDate: '2026-10',
    courseRaw: r.courseRaw || '',
    teacherRaw: r.teacherRaw || '',
    sentimentRaw: r.sentimentRaw || '',
    contentRaw: r.contentRaw || '',
    importWarnings: r.warnings || []
  };
}
function patchOf(d, existing) {
  const p = Object.assign({}, d);
  delete p._id; delete p.importBatch; delete p.importKey; delete p.id;
  if (existing && existing.at) p.at = existing.at;
  return p;
}
async function main() {
  const argv = process.argv.slice(2); const confirm = argv.indexOf('--confirm') >= 0; const cleanup = argv.indexOf('--cleanup') >= 0;
  const rows = readJson(SRC, null);
  if (!Array.isArray(rows)) { console.error('读不到 ' + SRC); process.exit(1); }
  const ready = rows.filter((r) => !r.needsReview);
  const pending = rows.filter((r) => r.needsReview);
  const docs = ready.map(docOf);
  console.log('候选 ' + rows.length + '，可同步 ' + ready.length + '，待确认跳过 ' + pending.length);
  const byKey = {}; docs.forEach((d) => { byKey[d.sourceKey] = d; });
  if (!confirm) {
    docs.slice(0, 8).forEach((d) => console.log(' ', d.id, '|', d.courseName, '| s', d.score, '| ts', d.teacherScore, '|', d.teacher, '|', d.content.slice(0, 50)));
    console.log('dry-run，未写库');
    return;
  }
  let t = await token();
  let q = await tcb(t, 'databasequery', "db.collection('" + COL + "').where({importSource:'course-guide-2026-10'}).limit(1000).get()");
  if (q && q.stale) { t = await token(); q = await tcb(t, 'databasequery', "db.collection('" + COL + "').where({importSource:'course-guide-2026-10'}).limit(1000).get()"); }
  if (q && (q.bad || q.errcode)) throw new Error('查询云端评价失败：' + (q.raw || q.errcode + ' ' + (q.errmsg || '')));
  const old = parseRows(q && q.data); const oldByKey = {};
  old.forEach((x) => { const k = x.sourceKey || sourceKeyOf(x); if (!oldByKey[k]) oldByKey[k] = x; });
  console.log('云端已有导入记录 ' + old.length + '，按 sourceKey 匹配到 ' + Object.keys(oldByKey).length + ' 个键');
  let added = 0, updated = 0, fail = 0; const doneIds = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]; const ex = oldByKey[d.sourceKey];
    let j;
    if (ex) {
      j = await tcb(t, 'databaseupdate', "db.collection('" + COL + "').doc('" + String(ex._id) + "').update({data:" + esc(patchOf(d, ex)) + '})');
      if (j && j.stale) { t = await token(); j = await tcb(t, 'databaseupdate', "db.collection('" + COL + "').doc('" + String(ex._id) + "').update({data:" + esc(patchOf(d, ex)) + '})'); }
      if (!(j && (j.bad || j.errcode))) { updated += 1; doneIds.push(d.id); } else { fail += 1; if (fail <= 5) console.error('  更新失败 ' + d.id + '：' + (j.raw || j.errcode + ' ' + (j.errmsg || ''))); }
    } else {
      j = await tcb(t, 'databaseadd', "db.collection('" + COL + "').add({data:" + esc(d) + '})');
      if (j && j.stale) { t = await token(); j = await tcb(t, 'databaseadd', "db.collection('" + COL + "').add({data:" + esc(d) + '})'); }
      if (!(j && (j.bad || j.errcode))) { added += 1; doneIds.push(d.id); } else { fail += 1; if (fail <= 5) console.error('  新增失败 ' + d.id + '：' + (j.raw || j.errcode + ' ' + (j.errmsg || ''))); }
    }
    if (i % 25 === 0) console.log('  ' + (i + 1) + '/' + docs.length + ' 新增 ' + added + ' 更新 ' + updated + ' 失败 ' + fail);
    await new Promise((res) => setTimeout(res, 70));
  }
  const orphans = old.filter((x) => { const k = x.sourceKey || sourceKeyOf(x); return !byKey[k]; });
  console.log('孤儿旧记录（不在当前可同步候选里）：' + orphans.length);
  orphans.slice(0, 20).forEach((x) => console.log('  ORPHAN', x.id, x.courseName, x.teacher, x.score, String(x.content || '').slice(0, 40)));
  if (cleanup) {
    let del = 0;
    for (const x of orphans) {
      let j = await tcb(t, 'databasedelete', "db.collection('" + COL + "').doc('" + String(x._id) + "').remove()");
      if (j && j.stale) { t = await token(); j = await tcb(t, 'databasedelete', "db.collection('" + COL + "').doc('" + String(x._id) + "').remove()"); }
      if (!(j && (j.bad || j.errcode))) del += 1;
      await new Promise((res) => setTimeout(res, 70));
    }
    console.log('已清理孤儿记录：' + del);
  }
  writeJson(path.join(DATA, 'sync-guide-full-20261019.json'), { batch: BATCH, total: rows.length, ready: ready.length, pending: pending.length, added, updated, fail, orphans: orphans.length, doneIds });
  console.log('完成：新增 ' + added + '，更新 ' + updated + '，失败 ' + fail);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
