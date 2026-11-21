#!/usr/bin/env node
/**
 * 把公开的师资名册灌进云端 teachers 集合。
 *
 * 和真题导入是同一条链路（微信云开发 HTTP API），共用两个已踩过的坑的解法：
 *   1) 请求必须显式带 Content-Length，否则走 chunked，微信网关回 412 空 body
 *   2) 这里不传文件，没有 COS 那一段
 *
 * 为什么写云端而不是随包：小程序里 teachers 是「评价时输老师名自动补全」的数据源，
 * 官方名录（official:true）还会被打上勾，且 teacherRemove 拒删。随包一份等于分叉。
 *
 * 用法：
 *   node scripts/import-teachers.cjs --dry    只看前 5 条，不联网
 *   node scripts/import-teachers.cjs          真跑
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'zjgsu-teachers.json');
const STATE = path.join(ROOT, 'data', 'teachers-imported.json');
const CRED = path.join(__dirname, '.exam-upload.json');
const TOKEN_CACHE = path.join(__dirname, '.exam-upload-token.json');

const ENV = 'cloud1-your-env-id';
const COL = 'teachers';
const UA = 'zjgsu-campus-teacher-importer';

// 名字这块比云函数 teacherAdd 宽一档：那边是校验同学手填的，得严；
// 这边是官方名录，遇到「王㤖」这种生僻字（在 CJK 扩展 A 区，不在 一-龥 里）不能误杀。
// 放的只是汉字扩展区和间隔号，数字、空格、标点一样进不来 —— 混进乱码照样拦下。
const NAME_RE = /^[一-龥㐀-䶿·]{2,6}$/;
// 页面上的学位/职称后缀词，切分出来不能当人名收
const TITLE_WORDS = { 博士: 1, 硕士: 1, 学士: 1, 教授: 1, 副教授: 1, 讲师: 1, 助教: 1, 研究员: 1 };

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

// 名单文件有两种写法，都接住：
//   1) 成品稿（.json）：{ teachers: [{name, college, title}] }
//   2) 学院原始稿（.cjs）：{ college, sourceUrl, senior, mid, senior2... }
//      空格分隔的名字串 + 统一的学院名，写起来短，改起来也只改一处
function loadRows(p) {
  let raw = null;
  if (/\.cjs$|\.js$/.test(p)) {
    try { raw = require(p); } catch (e) { return []; }
  } else {
    raw = readJson(p, null);
  }
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.teachers)) return raw.teachers;
  const out = [];
  // 整页一锅端的写法：只要名字，不分职称。
  // 小程序里同学评价时填的就是老师名字，职称有没有不影响自动补全和打勾，
  // 所以来源页分不清职称时，宁可留空也别猜。
  if (typeof raw.names === 'string' || Array.isArray(raw.names)) {
    const src = Array.isArray(raw.names) ? raw.names.join(' ') : raw.names;
    src.trim().split(/\s+/).forEach((n) => {
      if (TITLE_WORDS[n]) return;
      if (NAME_RE.test(n)) out.push({ name: n, college: raw.college, title: '', sourceUrl: raw.sourceUrl });
    });
    return out;
  }
  // 键名直接用页面上那段标题的原话（正高级/副高级/中级），不做英文缩写。
  // 之前用 senior/mid 这种通用词，结果「senior」在一个人心里是正高、在另一个文件里
  // 存的是副高，映射一写就反 —— 食品那批 43 位副教授差点全被写成教授。
  const titles = { 正高级: '教授', 副高级: '副教授', 中级: '讲师' };
  Object.keys(raw).forEach((k) => {
    if (!titles[k] || typeof raw[k] !== 'string') return;
    raw[k].trim().split(/\s+/).forEach((n) => {
      // 「陈可先 博士」这种页面排版，切分后「博士」自己会成一个词，
      // 而它也是 2 个汉字，光靠字符范围拦不住 —— 会被当成一位叫「博士」的老师写进库
      if (TITLE_WORDS[n]) return;
      if (NAME_RE.test(n)) out.push({ name: n, college: raw.college, title: titles[k], sourceUrl: raw.sourceUrl });
    });
  });
  return out;
}

function loadCred() {
  const c = readJson(CRED, null);
  if (!c || !c.appid || !c.secret) {
    console.error('缺凭证：' + CRED + ' 里要有 appid 和 secret');
    process.exit(1);
  }
  return c;
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
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: method, headers: h
    }, (res) => {
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

async function get(url) {
  const r = await request(url, 'GET', null, {});
  return r.body;
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

// 40001 / 42001 = token 失效，交给调用方刷新后重试
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

function esc(s) {
  return JSON.stringify(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// 和云函数 syncOfficialTeachers 里那条 doc 保持同一个形状，
// 只多一个 title（职称），前端不读就是多的，不会破坏既有逻辑
function docOf(t) {
  const doc = {
    id: 'timp' + t.college.slice(0, 2) + t.name + Date.now(),
    name: t.name,
    college: String(t.college || '').slice(0, 30),
    official: true,
    sourceUrl: t.sourceUrl || '',
    at: Date.now()
  };
  // 职称是顺手带的：来源页分得清才写，分不清就整个字段不落库。
  // 小程序评价时只认名字，缺职称不影响补全和打勾，留着空串反而占地方。
  const ti = String(t.title || '').trim();
  if (ti) doc.title = ti.slice(0, 20);
  return doc;
}

function queryAdd(doc) {
  return "db.collection('" + COL + "').add({data:" + esc(doc) + '})';
}

async function fetchExisting(token, onStale) {
  const q = "db.collection('" + COL + "').limit(1000).get()";
  let j = await tcb(token, 'databasequery', q);
  if (j && j.stale) { token = await onStale(); j = await tcb(token, 'databasequery', q); }
  // 微信这条接口返回的 data 是「字符串数组」：每个元素是一条 doc 的 JSON 文本，不是对象。
  // 直接拿去当对象读，t.name 全是 undefined —— 去重键会退化成 "undefined|undefined"，
  // 于是每次重跑都会再灌一遍全量。所以这里逐项 parse 回对象。
  // 另外空集合回来的是 []，整体 JSON.parse 会变成 parse("")，炸「Unexpected end of JSON input」
  const raw = j && j.data;
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw) {
    try { const p = JSON.parse(raw); arr = Array.isArray(p) ? p : []; } catch (e) { arr = []; }
  }
  const out = [];
  arr.forEach((it) => {
    if (it && typeof it === 'object') { out.push(it); return; }
    if (typeof it === 'string' && it) {
      try { out.push(JSON.parse(it)); } catch (e) { /* 脏数据跳过 */ }
    }
  });
  return out;
}

async function main() {
  const arg = process.argv.slice(2).find((a) => a.indexOf('--src=') === 0);
  const srcPath = arg ? path.resolve(ROOT, arg.slice(6)) : SRC;
  const all = loadRows(srcPath);
  if (!all.length) {
    console.error('读不到名单：' + srcPath);
    process.exit(1);
  }
  console.log('来源文件：' + path.relative(ROOT, srcPath));
  const dry = process.argv.slice(2).indexOf('--dry') >= 0;

  // 先在本方去重 + 过滤脏名字，别把重复带进云端
  const seen = {};
  const rows = [];
  let bad = 0;
  all.forEach((t) => {
    const name = String(t.name || '').trim();
    const college = String(t.college || '').trim() || '未知学院';
    if (!NAME_RE.test(name)) { bad += 1; return; }
    if (seen[name]) return;
    seen[name] = 1;
    // sourceUrl 要跟着走到 docOf，不然写的全是默认那个，出问题时查不到这条来自哪页
    rows.push({ name: name, college: college, title: String(t.title || ''), sourceUrl: String(t.sourceUrl || '') });
  });

  console.log('名单 ' + all.length + ' 条 → 清洗后 ' + rows.length + ' 条（跳过不规范名字 ' + bad + ' 条）');

  if (dry) {
    console.log('--- 干跑，前 5 条 ---');
    rows.slice(0, 5).forEach((r) => console.log(JSON.stringify(docOf(r))));
    console.log('（--dry 不联网，要看真的就去掉这个参数）');
    return;
  }

  const cred = loadCred();
  let token = await accessToken(cred);
  const refresh = async () => {
    fs.unlinkSync(TOKEN_CACHE);
    const t = await accessToken(cred);
    return t;
  };

  const existed = await fetchExisting(token, refresh);
  // 只按名字判重：学院名在不同来源里写法会飘（有的带括号后缀有的不带），
  // 拿 姓名|学院 当键会把同一个人当成两个人再写一遍。
  // 而小程序里同学填的本来就只有名字，名字唯一就够了。
  const had = {};
  existed.forEach((t) => { if (t.name) had[t.name] = 1; });
  console.log('云端现有 ' + existed.length + ' 条');

  const todo = rows.filter((r) => !had[r.name]);
  if (todo.length !== rows.length) {
    console.log('名字与云端重复的 ' + (rows.length - todo.length) + ' 条已跳过');
  }
  console.log('待导入 ' + todo.length + ' 条（已存在的跳过）');
  if (!todo.length) return;

  const done = readJson(STATE, []);
  const doneSet = {};
  done.forEach((k) => { doneSet[k] = 1; });

  let ok = 0, fail = 0;
  const t0 = Date.now();
  for (let i = 0; i < todo.length; i++) {
    const r = todo[i];
    const key = r.name;
    if (doneSet[key]) { ok += 1; continue; }
    let j = await tcb(token, 'databaseadd', queryAdd(docOf(r)));
    if (j && j.stale) {
      token = await refresh();
      j = await tcb(token, 'databaseadd', queryAdd(docOf(r)));
    }
    if (j && (j.bad || j.errcode)) {
      fail += 1;
      if (fail <= 3) console.error('  失败 ' + key + ' → ' + (j.raw || j.errcode + ' ' + (j.errmsg || '')));
    } else {
      ok += 1;
      done.push(key);
      if (done.length % 25 === 0) {
        fs.writeFileSync(STATE, JSON.stringify(done), 'utf8');
        console.log('  ' + ok + '/' + todo.length + '  ' + Math.round((Date.now() - t0) / 1000) + 's');
      }
    }
  }
  fs.writeFileSync(STATE, JSON.stringify(done), 'utf8');
  console.log('\n完成：成功 ' + ok + '，失败 ' + fail + '，耗时 ' + Math.round((Date.now() - t0) / 1000) + 's');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
