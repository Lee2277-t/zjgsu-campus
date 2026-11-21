#!/usr/bin/env node
'use strict';
/**
 * 给所有正常帖子加 4-5 个测试赞、1-2 个测试踩，方便验证“一人一票”计数是否稳定。
 *
 *   node scripts/seed-test-votes.cjs              # dry-run
 *   node scripts/seed-test-votes.cjs --confirm    # 写入
 *   node scripts/seed-test-votes.cjs --rollback --confirm  # 删除测试票并重算
 *
 * 测试票使用 seed:v: 前缀的合成 openid，不会和真实微信 openid 冲突；
 * 删除时只删这个前缀，不动真实用户投票。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'test-votes-seed-20261020.json');
const CRED = path.join(__dirname, '.exam-upload.json');
const TC = path.join(__dirname, '.exam-upload-token.json');
const ENV = 'cloud1-your-env-id';
const PREFIX = 'seed:v:';

function readJson(p, f) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return f; } }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); }
function request(url, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const h = { 'Content-Type': 'application/json' };
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers: h }, (res) => {
      const bufs = []; res.on('data', d => bufs.push(d)); res.on('end', () => resolve(Buffer.concat(bufs).toString()));
    });
    req.on('error', reject); req.setTimeout(120000, () => req.destroy(new Error('请求超时')));
    if (body) req.write(body); req.end();
  });
}
async function token() {
  const cached = readJson(TC, null);
  if (cached && cached.token && cached.at && Date.now() - cached.at < 100 * 60 * 1000) return cached.token;
  const c = readJson(CRED, null);
  if (!c || !c.appid || !c.secret) throw new Error('缺少 ' + CRED);
  const j = JSON.parse(await request('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + encodeURIComponent(c.appid) + '&secret=' + encodeURIComponent(c.secret), 'GET'));
  if (!j.access_token) throw new Error('拿不到 access_token');
  fs.writeFileSync(TC, JSON.stringify({ token: j.access_token, at: Date.now() }));
  return j.access_token;
}
async function tcb(t, action, query) {
  const raw = await request('https://api.weixin.qq.com/tcb/' + action + '?access_token=' + t, 'POST', JSON.stringify({ env: ENV, query }));
  try { const j = JSON.parse(raw); if (j.errcode === 40001 || j.errcode === 42001) return { stale: true }; return j; }
  catch (e) { return { bad: true, raw: raw.slice(0, 200) }; }
}
function rows(raw) {
  let a = []; if (Array.isArray(raw)) a = raw; else { try { const j = JSON.parse(raw); a = Array.isArray(j.data) ? j.data : []; } catch (e) {} }
  return a.map(x => typeof x === 'string' ? JSON.parse(x) : x);
}
function esc(s) { return JSON.stringify(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

async function run() {
  const argv = process.argv.slice(2);
  const confirm = argv.indexOf('--confirm') >= 0;
  const rollback = argv.indexOf('--rollback') >= 0;
  let t = await token();
  const q = async (s) => {
    let j = await tcb(t, 'databasequery', s);
    if (j && j.stale) { t = await token(); j = await tcb(t, 'databasequery', s); }
    if (j && (j.bad || j.errcode)) throw new Error('查询失败：' + (j.raw || j.errcode + ' ' + (j.errmsg || '')));
    return rows(j && j.data);
  };
  const posts = await q("db.collection('posts').limit(1000).get()");
  const votes = await q("db.collection('post_votes').limit(1000).get()");
  const byPost = {};
  votes.forEach(v => {
    byPost[v.postId] = byPost[v.postId] || { like: {}, dislike: {} };
    byPost[v.postId][v.kind === 'dislike' ? 'dislike' : 'like'][v.openid] = 1;
  });

  if (rollback) {
    const targets = votes.filter(v => String(v.openid || '').indexOf(PREFIX) === 0);
    console.log('测试票：' + targets.length + ' 条');
    if (!confirm) { console.log('dry-run，未删除'); return; }
    let deleted = 0;
    for (const v of targets) {
      let j = await tcb(t, 'databasedelete', "db.collection('post_votes').doc('" + String(v._id) + "').remove()");
      if (j && j.stale) { t = await token(); j = await tcb(t, 'databasedelete', "db.collection('post_votes').doc('" + String(v._id) + "').remove()"); }
      if (!(j && (j.bad || j.errcode))) deleted += 1;
      await new Promise(r => setTimeout(r, 50));
    }
    // 重新统计受影响的帖子
    const live = await q("db.collection('post_votes').limit(1000).get()");
    const finalBy = {};
    live.forEach(v => {
      finalBy[v.postId] = finalBy[v.postId] || { like: {}, dislike: {} };
      finalBy[v.postId][v.kind === 'dislike' ? 'dislike' : 'like'][v.openid] = 1;
    });
    let updated = 0;
    for (const p of posts) {
      if (!byPost[p.id]) continue;
      const x = finalBy[p.id] || { like: {}, dislike: {} };
      const likeList = Object.keys(x.like), dislikeList = Object.keys(x.dislike);
      let j = await tcb(t, 'databaseupdate', "db.collection('posts').where({id:'" + esc(p.id).slice(1, -1) + "'}).update({data:" + esc({ likes: likeList.length, dislikes: dislikeList.length, likedBy: likeList, dislikedBy: dislikeList, votesMigrated: true }) + '})');
      if (j && j.stale) { t = await token(); j = await tcb(t, 'databaseupdate', "db.collection('posts').where({id:'" + esc(p.id).slice(1, -1) + "'}).update({data:" + esc({ likes: likeList.length, dislikes: dislikeList.length, likedBy: likeList, dislikedBy: dislikeList, votesMigrated: true }) + '})'); }
      if (!(j && (j.bad || j.errcode))) updated += 1;
      await new Promise(r => setTimeout(r, 50));
    }
    console.log('已删除测试票 ' + deleted + '，重算帖子 ' + updated);
    return;
  }

  const plan = [];
  let idx = 0;
  for (const p of posts) {
    if (p.status && p.status !== 'normal') continue;
    const likeN = 4 + (idx % 2);
    const dislikeN = 1 + (idx % 2);
    idx += 1;
    const likeIds = Array.from({ length: likeN }, (_, i) => PREFIX + 'like:' + (i + 1));
    const dislikeIds = Array.from({ length: dislikeN }, (_, i) => PREFIX + 'dislike:' + (i + 1));
    const cur = byPost[p.id] || { like: {}, dislike: {} };
    const addLikes = likeIds.filter(id => !cur.like[id] && !cur.dislike[id]);
    const addDislikes = dislikeIds.filter(id => !cur.like[id] && !cur.dislike[id]);
    const likeSet = Object.assign({}, cur.like), dislikeSet = Object.assign({}, cur.dislike);
    addLikes.forEach(id => { likeSet[id] = 1; });
    addDislikes.forEach(id => { dislikeSet[id] = 1; });
    plan.push({ post: p, likeIds, dislikeIds, addLikes, addDislikes, finalLikes: Object.keys(likeSet), finalDislikes: Object.keys(dislikeSet) });
  }
  console.log('目标帖子：' + plan.length + ' 条');
  plan.slice(0, 10).forEach(x => console.log(' ', x.post.id, x.post.title || '(无标题)', 'add', x.addLikes.length + '/' + x.addDislikes.length, 'total', x.finalLikes.length + '/' + x.finalDislikes.length));
  if (!confirm) { console.log('dry-run，未写库'); return; }

  let added = 0, failed = 0, updated = 0;
  const now = Date.now();
  for (const x of plan) {
    let i = 0;
    for (const oid of x.addLikes.concat(x.addDislikes)) {
      const kind = x.addLikes.indexOf(oid) >= 0 ? 'like' : 'dislike';
      const doc = { _id: String(x.post.id) + '_' + oid, postId: String(x.post.id), openid: oid, kind, at: now + i };
      i += 1;
      let j = await tcb(t, 'databaseadd', "db.collection('post_votes').add({data:" + esc(doc) + '})');
      if (j && j.stale) { t = await token(); j = await tcb(t, 'databaseadd', "db.collection('post_votes').add({data:" + esc(doc) + '})'); }
      if (j && (j.bad || j.errcode)) { failed += 1; } else added += 1;
      await new Promise(r => setTimeout(r, 40));
    }
    const data = { likes: x.finalLikes.length, dislikes: x.finalDislikes.length, likedBy: x.finalLikes, dislikedBy: x.finalDislikes, votesMigrated: true };
    let j = await tcb(t, 'databaseupdate', "db.collection('posts').where({id:'" + esc(x.post.id).slice(1, -1) + "'}).update({data:" + esc(data) + '})');
    if (j && j.stale) { t = await token(); j = await tcb(t, 'databaseupdate', "db.collection('posts').where({id:'" + esc(x.post.id).slice(1, -1) + "'}).update({data:" + esc(data) + '})'); }
    if (!(j && (j.bad || j.errcode))) updated += 1;
    await new Promise(r => setTimeout(r, 45));
  }
  writeJson(OUT, { at: new Date().toISOString(), prefix: PREFIX, posts: plan.map(x => ({ id: x.post.id, title: x.post.title || '', addedLikes: x.addLikes, addedDislikes: x.addDislikes })), added, failed, updated });
  console.log('完成：新增测试票 ' + added + '，失败 ' + failed + '，更新帖子 ' + updated + '，快照 ' + OUT);
}
run().catch(e => { console.error(e.message || e); process.exit(1); });
