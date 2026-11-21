#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'course-review-import', 'guide-courses.json');
const ROLLBACK = path.join(ROOT, 'data', 'course-review-import', 'rollback-guide-courses-20261019.json');
const CRED = path.join(__dirname, '.exam-upload.json');
const TOKEN_CACHE = path.join(__dirname, '.exam-upload-token.json');
const ENV = 'cloud1-your-env-id';
const COL = 'courses';
const UA = 'zjgsu-guide-course-importer';

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
function docOf(c, now) {
  return {
    id: c.id, name: c.name, college: c.college || '待确认', major: c.major || '通识教育',
    credit: c.credit == null ? null : c.credit, tags: c.tags || [], ctype: c.ctype || '通识课',
    description: c.description || '根据学生选课指南整理；具体开课与学分以教务系统为准。',
    source: c.source || '学生选课指南（2026-10）', sourceVersion: c.sourceVersion || '2026-10',
    builtin: true, guideImport: true, guideBatch: 'guide-courses-20261019', at: now
  };
}
async function main() {
  const argv = process.argv.slice(2); const confirm = argv.indexOf('--confirm') >= 0;
  if (argv.indexOf('--rollback') >= 0) {
    if (!confirm) { console.log('回滚课程导入需要加 --confirm'); return; }
    let t = await token();
    let j = await tcb(t, 'databasedelete', "db.collection('" + COL + "').where({guideBatch:'guide-courses-20261019'}).remove()");
    if (j && j.stale) { t = await token(); j = await tcb(t, 'databasedelete', "db.collection('" + COL + "').where({guideBatch:'guide-courses-20261019'}).remove()"); }
    if (j && (j.bad || j.errcode)) throw new Error('回滚失败：' + (j.raw || j.errcode + ' ' + (j.errmsg || '')));
    console.log('已回滚 guide-courses-20261019');
    return;
  }
  const all = readJson(SRC, null);
  if (!Array.isArray(all) || !all.length) { console.error('读不到 ' + SRC); process.exit(1); }
  const now = Date.now(); const docs = all.map((c) => docOf(c, now));
  console.log('候选课程：' + docs.length);
  if (!confirm) { docs.slice(0, 8).forEach((d) => console.log(' ', d.id, d.name, d.ctype)); console.log('dry-run，未写库'); return; }
  let t = await token();
  let r = await tcb(t, 'databasequery', "db.collection('" + COL + "').limit(1000).get()");
  if (r && r.stale) { t = await token(); r = await tcb(t, 'databasequery', "db.collection('" + COL + "').limit(1000).get()"); }
  const existing = parseRows(r && r.data); const byId = {}; existing.forEach((x) => { if (x.id) byId[x.id] = x; });
  console.log('云端现有课程：' + existing.length + '，候选里已存在：' + docs.filter((d) => byId[d.id]).length);
  let ok = 0, skip = 0, fail = 0; const added = [];
  for (const d of docs) {
    if (byId[d.id]) { skip += 1; continue; }
    let j = await tcb(t, 'databaseadd', "db.collection('" + COL + "').add({data:" + esc(d) + '})');
    if (j && j.stale) { t = await token(); j = await tcb(t, 'databaseadd', "db.collection('" + COL + "').add({data:" + esc(d) + '})'); }
    if (j && (j.bad || j.errcode)) { fail += 1; if (fail <= 5) console.error('  失败 ' + d.id + '：' + (j.raw || j.errcode + ' ' + (j.errmsg || ''))); }
    else { ok += 1; added.push(d.id); }
    await new Promise((res) => setTimeout(res, 80));
  }
  writeJson(ROLLBACK, added);
  console.log('完成：新增 ' + ok + '，已存在跳过 ' + skip + '，失败 ' + fail);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
