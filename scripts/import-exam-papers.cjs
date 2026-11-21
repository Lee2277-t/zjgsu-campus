// scripts/import-exam-papers.cjs —— 把历年真题批量灌进「学习资料」
//
// 走的是微信云开发的 HTTP API（不是云函数）：
//   1. tcb/uploadfile  拿上传直链 + fileID，再把 PDF PUT 上去
//   2. tcb/databaseadd 往 resources 集合写一条元数据
//
// 第 2 步是关键：真题写进的是**和学生上传资料完全相同的那张表**，
// 用的字段、走的打开流程、在列表里的样子都一模一样。
// 所以学习资料页一个字都不用改 —— 切到「真题」档就看到 185 份，
// 搜课程名能命中，点「打开」走的是同一条下载链路。
// 另起一张表 / 另做一个页面，结果就是两个真题库、两处不一致。
//
// 前置条件：小程序后台的 AppID 和 AppSecret。
//   微信公众平台 → 开发 → 开发管理 → 开发设置 → 开发者 ID(AppID) / 开发者密码(AppSecret)
//   填进 scripts/.exam-upload.json（已 gitignore，不会进仓库）：
//     { "appid": "wx...", "secret": "...", "openid": "（选填，见下）" }
//   也支持环境变量 WECHAT_APPID / WECHAT_APPSECRET。
//
//   openid 这一项：如果 resources 集合的权限是「仅创建者可读写」，
//   导入时留空会让同学读不到这些卷子。那种情况下要么把集合权限
//   改成「所有用户可读，仅创建者可写」（推荐），要么在这里填一个真实 openid。
//
// 用法：
//   node scripts/import-exam-papers.cjs            # 灌全部没灌过的
//   node scripts/import-exam-papers.cjs ep0001     # 只灌指定 id（调试用）
//   node scripts/import-exam-papers.cjs --dry      # 只打印前 5 条会写成什么样
//
// 中断了直接重跑：每份传完、写完就落盘，已完成的会跳过。
// access_token 有效期两小时且有每日获取次数上限，缓存复用，过期才重取。

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'exam-papers.json');
const STATE = path.join(ROOT, 'data', 'exam-papers-imported.json');
const CRED = path.join(__dirname, '.exam-upload.json');
const TOKEN_CACHE = path.join(__dirname, '.exam-upload-token.json');

const ENV = 'cloud1-your-env-id';
const PREFIX = 'papers/';
const COL = 'resources';
const UA = 'zjgsu-campus-exam-papers-importer';

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function loadCred() {
  const f = readJson(CRED, null);
  const appid = (f && f.appid) || process.env.WECHAT_APPID || '';
  const secret = (f && f.secret) || process.env.WECHAT_APPSECRET || '';
  if (!appid || !secret) {
    // 分两种情况说：只缺 secret 时把已读到的 appid 回显出来，
    // 让人一眼看出「配置读到了，就差这一个字段」，而不是以为整个文件没生效
    if (appid) {
      console.error('已读到 AppID：' + appid);
      console.error('还差 AppSecret（小程序后台「开发者密码」，32 位）。');
    } else {
      console.error('缺少 AppID / AppSecret。');
    }
    console.error('  方式一：写进 ' + path.relative(ROOT, CRED) + '（已 gitignore）');
    console.error('          { "appid": "' + (appid || 'wx...') + '", "secret": "..." }');
    console.error('  方式二：环境变量 WECHAT_APPID / WECHAT_APPSECRET');
    console.error('  在微信公众平台 → 开发 → 开发管理 → 开发设置 里能拿到。');
    console.error('  注意 AppSecret 只在生成时显示一次，忘了就只能重置。');
    process.exit(1);
  }
  return { appid: appid, secret: secret, openid: (f && f.openid) || '' };
}

function get(url, opt) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      const bufs = [];
      res.on('data', (d) => bufs.push(d));
      res.on('end', () => resolve(Buffer.concat(bufs).toString('utf8')));
    });
    req.on('error', reject);
    if (opt && opt.timeout) req.setTimeout(opt.timeout, () => { req.destroy(new Error('超时')); });
  });
}

// 必须显式带上 Content-Length。
// Node 的 https.request 在没给这个头时会走 chunked transfer encoding，
// 而微信网关不支持分块流式传输 —— 结果是 HTTP 412 + 空响应体，
// 没有任何 errcode 可以判断，只能看到 JSON.parse('') 炸掉。
// （GET 没 body 所以不受影响，这也解释了为什么拿 token 一直是好的）
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
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: method,
      headers: h
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

async function accessToken(cred) {
  const c = readJson(TOKEN_CACHE, null);
  if (c && c.token && c.at && Date.now() - c.at < 100 * 60 * 1000) return c.token;
  const raw = await get('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential'
    + '&appid=' + encodeURIComponent(cred.appid)
    + '&secret=' + encodeURIComponent(cred.secret), { timeout: 20000 });
  const j = JSON.parse(raw);
  if (!j.access_token) {
    throw new Error('拿不到 access_token：' + (j.errmsg || raw.slice(0, 200)));
  }
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ token: j.access_token, at: Date.now() }), 'utf8');
  return j.access_token;
}

// 一次 tcb 调用。40001 / 42001 = token 失效，交给调用方刷新后重试
async function tcb(token, action, query) {
  const raw = await request('https://api.weixin.qq.com/tcb/' + action + '?access_token=' + token,
    'POST', JSON.stringify({ env: ENV, query: query }), { 'Content-Type': 'application/json' });
  const j = JSON.parse(raw.body);
  if (j.errcode === 40001 || j.errcode === 42001) return { stale: true };
  return j;
}

async function askUpload(token, cloudPath) {
  const raw = await request('https://api.weixin.qq.com/tcb/uploadfile?access_token=' + token,
    'POST', JSON.stringify({ env: ENV, path: cloudPath }), { 'Content-Type': 'application/json' });
  const u = JSON.parse(raw.body);
  if (u.errcode === 40001 || u.errcode === 42001) return { stale: true };
  if (u.errcode || !u.url) {
    return { ok: false, msg: '申请直链失败 ' + u.errcode + ' ' + (u.errmsg || '') };
  }
  return { ok: true, url: u.url, token: u.token, authorization: u.authorization, fileId: u.file_id };
}

// COS 直传必须是 POST + multipart/form-data，不是 PUT + 裸 body。
// 签名是按 POST 算的，发 PUT 会得到 403「The Signature you specified is invalid」——
// 错误信息里提的是签名，看起来像密钥错了，其实是方法错了，很容易查偏。
// form 里必须带 key（对象路径，URL 里的路径会被忽略）和 file（文件内容）。
function multipart(key, fileName, buf) {
  const b = '----zjgsu' + Date.now();
  const head = Buffer.from(
    '--' + b + '\r\nContent-Disposition: form-data; name="key"\r\n\r\n' + key + '\r\n'
    + '--' + b + '\r\nContent-Disposition: form-data; name="file"; filename="'
    + String(fileName).replace(/"/g, '') + '"\r\nContent-Type: application/pdf\r\n\r\n',
    'utf8');
  const tail = Buffer.from('\r\n--' + b + '--\r\n', 'utf8');
  return { body: Buffer.concat([head, buf, tail]), type: 'multipart/form-data; boundary=' + b };
}

async function push(url, cosToken, authorization, buf, cloudPath, fileName) {
  const mp = multipart(cloudPath, fileName, buf);
  const r = await request(url, 'POST', mp.body, {
    Authorization: authorization,
    'x-cos-security-token': cosToken,
    'Content-Type': mp.type
  });
  // 成功是 204 No Content，body 是空的
  if (r.status >= 200 && r.status < 300 && r.body.indexOf('<Error>') < 0) return { ok: true };
  const m = r.body.match(/<Message>([^<]*)<\/Message>/);
  return { ok: false, msg: '上传失败 HTTP ' + r.status + ' ' + (m ? m[1] : r.body.slice(0, 160)) };
}

/* ---------------- 元数据：按 resourceAdd 的字段来 ---------------- */

// 列表里能搜到什么，全看 title 和 courseName —— 云函数 resourceList
// 只用这两个字段做匹配。所以学年 / 学期 / 类型 / 卷别都写进 title：
// 搜「2023」「期末」「A卷」都能命中，等于用一个搜索框覆盖所有筛选维度
function titleOf(r) {
  const bits = [r.course];
  if (r.year) bits.push(r.year);
  if (r.term) bits.push('第' + r.term + '学期');
  if (r.kind) bits.push(r.kind);
  if (r.volume) bits.push(r.volume);
  return bits.join('·').slice(0, 40);
}

function descOf(r) {
  const bits = [];
  if (r.note) bits.push(r.note);
  if (r.volume) bits.push(r.volume);
  bits.push('原文件：' + r.file);
  return bits.join(' · ').slice(0, 200);
}

// at 决定列表顺序（云端按 at 倒序）。用学年推算，而不是全用导入时间 ——
// 否则 185 份全挤在同一天，最新的 2023 卷子可能排在最老的 2002 后面
function atOf(r) {
  const m = String(r.year || '').match(/(\d{4})/);
  const y = m ? Number(m[1]) : 0;
  if (!y) return Date.now();
  // 学年「2020-2021」取结束年；第 1 学期算 1 月，第 2 学期算 6 月（期末季）。
  // 学期在扫描结果里两种写法都有（「1」和「一」），两边都要认
  const end = String(r.year).indexOf('-') >= 0 ? y + 1 : y;
  const t = String(r.term || '');
  const month = (t === '1' || t === '一') ? 0 : 5;
  return new Date(end, month, 15, 12, 0, 0).getTime();
}

function timeOf(at) {
  const d = new Date(at);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 和云函数 resourceAdd 里那条 doc 保持同一个形状。
// 字段对不上，前端拿到的就是残缺的资料（没有 sizeText、点开没有文件）
function docOf(r, fileID, openid) {
  const at = atOf(r);
  return {
    id: r.id,
    title: titleOf(r),
    desc: descOf(r),
    fileID: fileID,
    fileName: String(r.file || '').slice(0, 60),
    size: Math.round((Number(r.sizeKB) || 0) * 1024),
    category: '真题',
    courseName: String(r.course || '').slice(0, 30),
    author: '浙小商',
    openid: openid || '',
    time: timeOf(at),
    at: at,
    thanks: [],
    status: 'normal'
  };
}

// 数据库接口收的是一段 JS 表达式，doc 用 JSON.stringify 塞进去。
// 单引号会被字符串里的内容提前闭合，所以先转义
function toQuery(doc) {
  return "db.collection('" + COL + "').add({data:"
    + JSON.stringify(doc).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    + '})';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 清单里的 path 是相对扫描目录的（「【第3期】浙江工商大学/xxx.pdf」），
// 直接拿去读盘会全部报「本地文件不见了」。根目录记在扫描结果的 source 里，
// 换过位置就用 --root= 覆盖
function filesRoot(src) {
  const arg = process.argv.slice(2).find((a) => a.indexOf('--root=') === 0);
  if (arg) return arg.slice(7);
  return src.source || '';
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.indexOf('--dry') >= 0;
  const only = args.filter((a) => a.indexOf('--') !== 0 && a.indexOf('--root=') !== 0);

  const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const rows = src.items || [];
  const base = filesRoot(src);
  if (!base) {
    console.error('扫描结果里没有记录来源目录（source 字段），也不知道文件在哪。');
    console.error('  用 --root=D:/历年真题 指定一次，或者重跑 node scripts/scan-exam-papers.cjs');
    process.exit(1);
  }

  if (dry) {
    console.log('--dry：只预览前 5 条会写成什么样，不上传也不写库');
    rows.slice(0, 5).forEach((r) => {
      const d = docOf(r, 'cloud://' + ENV + '/' + PREFIX + r.id + '.pdf', '');
      console.log('  ' + d.id + ' | ' + d.title);
      console.log('        course=' + d.courseName + ' size=' + d.size + ' at=' + d.at + ' (' + d.time + ')');
      console.log('        desc=' + d.desc);
    });
    return;
  }

  const cred = loadCred();
  const state = readJson(STATE, {});
  let token = await accessToken(cred);

  const queue = rows.filter((r) => {
    if (only.length) return only.indexOf(r.id) >= 0;
    // 两个阶段都算完成才算过：只传完没入库的也要补
    return !(state[r.id] && state[r.id].fileID && state[r.id].added);
  });

  const uploaded = Object.keys(state).filter((k) => state[k].fileID).length;
  if (!queue.length) {
    console.log('没有要灌的（' + uploaded + ' 份已上传 / ' + Object.keys(state).length + ' 份已入库）。');
    return;
  }

  console.log('环境 ' + ENV + ' → 集合 ' + COL);
  console.log('待处理 ' + queue.length + ' 份（已上传 ' + uploaded + '）');

  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < queue.length; i += 1) {
    const r = queue[i];
    const tag = '[' + (i + 1) + '/' + queue.length + '] ' + r.id;
    const rec = state[r.id] || {};

    // 阶段一：上传文件
    if (!rec.fileID) {
      const abs = path.join(base, r.path);
      if (!fs.existsSync(abs)) {
        console.error('  ' + tag + ' 本地文件不见了：' + abs);
        failCount += 1;
        continue;
      }
      const buf = fs.readFileSync(abs);
      let up = await askUpload(token, PREFIX + r.id + '.pdf');
      if (up.stale) {
        try { fs.unlinkSync(TOKEN_CACHE); } catch (e) { /* 没有就算了 */ }
        token = await accessToken(cred);
        up = await askUpload(token, PREFIX + r.id + '.pdf');
      }
      if (!up.ok) {
        console.error('  ' + tag + ' ' + up.msg);
        failCount += 1;
        continue;
      }
      const put = await push(up.url, up.token, up.authorization, buf,
        PREFIX + r.id + '.pdf', r.id + '.pdf');
      if (!put.ok) {
        console.error('  ' + tag + ' ' + put.msg);
        failCount += 1;
        continue;
      }
      rec.fileID = up.fileId;
      state[r.id] = rec;
      // 传完立刻落盘：150MB 传到一半崩了，重跑不用把前面几十 MB 再传一遍
      fs.writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8');
      await sleep(120);
    }

    // 阶段二：写库
    const doc = docOf(r, rec.fileID, cred.openid);
    let add = await tcb(token, 'databaseadd', toQuery(doc));
    if (add && add.stale) {
      try { fs.unlinkSync(TOKEN_CACHE); } catch (e) { /* 同上 */ }
      token = await accessToken(cred);
      add = await tcb(token, 'databaseadd', toQuery(doc));
    }
    if (!add || add.errcode) {
      console.error('  ' + tag + ' 写库失败 ' + (add && add.errcode) + ' ' + (add && add.errmsg));
      failCount += 1;
      continue;
    }

    rec.added = true;
    rec.title = doc.title;
    state[r.id] = rec;
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8');
    okCount += 1;
    console.log('  ' + tag + ' ' + doc.title);
    await sleep(120);
  }

  console.log('');
  console.log('完成：入库 ' + okCount + ' 份，失败 ' + failCount + ' 份');
  console.log('进度记在 ' + path.relative(ROOT, STATE) + '，重跑会跳过已完成的。');
  if (okCount) {
    console.log('');
    console.log('还差一步：云函数要重新部署一次 —— resourceList 原来一次只拉 60 条，');
    console.log('已改成 400，否则「真题」档只能看到最新的 60 份。');
  }
}

// 只在被直接运行时跑导入。导出构造元数据的那几个函数，
// 是为了让 scripts/test-exam-papers.cjs 能拿真实数据验字段契约 ——
// 测试里再抄一份规则，就等于没有规则
if (require.main === module) {
  main().catch((e) => {
    console.error('导入中断：' + (e && e.message ? e.message : e));
    console.error('已完成的都记在 ' + path.relative(ROOT, STATE) + ' 里，重跑会跳过。');
    process.exit(1);
  });
}

module.exports = { titleOf, descOf, atOf, timeOf, docOf, toQuery };
