'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const cred = JSON.parse(fs.readFileSync(path.join(__dirname, '.exam-upload.json'), 'utf8'));
const ENV = 'cloud1-your-env-id';

function post(tok, action, query) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ env: ENV, query: query });
    const req = https.request({
      hostname: 'api.weixin.qq.com',
      path: '/tcb/' + action + '?access_token=' + tok,
      method: 'POST',
      headers: {
        'User-Agent': 'diag',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const b = [];
      res.on('data', (d) => b.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(b).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    req.write(body);
    req.end();
  });
}

https.get('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid='
  + cred.appid + '&secret=' + cred.secret, { headers: { 'User-Agent': 'diag' } }, (res) => {
  const b = [];
  res.on('data', (d) => b.push(d));
  res.on('end', async () => {
    const s = Buffer.concat(b).toString('utf8');
    // 响应里带着 access_token，原样打印会把凭据泄进终端记录和日志
    let ok = false;
    try { ok = !!JSON.parse(s).access_token; } catch (e) { ok = false; }
    console.log('拿 token：' + (ok ? '成功' : '失败 → ' + s.slice(0, 120)));
    let tok;
    try { tok = JSON.parse(s).access_token; } catch (e) { console.log('token 解析失败'); return; }
    if (!tok) return;
    // 这里也必须翻页：云数据库单次 get 上限 1000，
    // 只取前 1000 条的话，核对出来的数字会永远是 1000，看不出问题
    // 总数藏在 get 响应的 pager.Total 里；count() 的返回格式不一样，直接读 .total 拿到的是 0，
    // 于是页数算成 1，永远只看前 1000 条 —— 核对工具自己被 1000 上限蒙住，最讽刺
    function rowsOf(body) {
      let d = [];
      try {
        const j = JSON.parse(body);
        const rawd = Array.isArray(j.data) ? j.data : [];
        d = rawd.map((it) => (typeof it === 'string' ? JSON.parse(it) : it));
        return { rows: d, total: (j.pager && j.pager.Total) || 0 };
      } catch (e) { return { rows: [], total: 0 }; }
    }
    const first = rowsOf((await post(tok, 'databasequery',
      "db.collection('teachers').limit(1000).get()")).body);
    const total = first.total || first.rows.length;
    const list = first.rows.slice();
    const pages = Math.ceil(total / 1000);
    for (let i = 1; i < pages; i++) {
      const rr = await post(tok, 'databasequery',
        "db.collection('teachers').skip(" + (i * 1000) + ').limit(1000).get()');
      rowsOf(rr.body).rows.forEach((x) => list.push(x));
    }
    console.log('云端 teachers 总数: ' + total + '（分 ' + pages + ' 页拉回 ' + list.length + ' 条）');
    const dupMap = renderStats(list);
    if (process.argv.slice(2).indexOf('--dedupe') >= 0 && Object.keys(dupMap).length) {
      // 每组留一条：优先留有职称的（信息全），都没有就留先入库的
      let removed = 0;
      for (const n of Object.keys(dupMap)) {
        const g = dupMap[n].slice().sort((a, b) => {
          if (!!a.title !== !!b.title) return a.title ? -1 : 1;
          return a.at - b.at;
        });
        for (let i = 1; i < g.length; i++) {
          const rr = await post(tok, 'databasedelete',
            "db.collection('teachers').doc('" + g[i]._id + "').remove()");
          let okd = false;
          try { okd = JSON.parse(rr.body).errcode === 0; } catch (e) { okd = false; }
          console.log('  删除重名 ' + n + ' (' + g[i].college + ') ' + (okd ? '成功' : '失败 ' + rr.body.slice(0, 80)));
          if (okd) removed += 1;
        }
      }
      console.log('去重完成：删掉 ' + removed + ' 条');
    }
  });
});

function renderStats(list) {
  const byCollege = {};
  const byTitle = {};
  const groups = {};
  list.forEach((t) => {
    byCollege[t.college || '(空)'] = (byCollege[t.college || '(空)'] || 0) + 1;
    byTitle[t.title || '(无职称)'] = (byTitle[t.title || '(无职称)'] || 0) + 1;
    const n = t.name || '';
    if (n) (groups[n] = groups[n] || []).push(t);
  });
  const dups = {};
  Object.keys(groups).forEach((n) => { if (groups[n].length > 1) dups[n] = groups[n]; });
  const dup = Object.keys(dups).length;
  console.log('--- 职称分布 ---');
  Object.keys(byTitle).sort((a, b) => byTitle[b] - byTitle[a])
    .forEach((k) => console.log('  ' + byTitle[k] + '\t' + k));
  console.log('--- 学院分布（' + Object.keys(byCollege).length + ' 个）---');
  Object.keys(byCollege).sort((a, b) => byCollege[b] - byCollege[a])
    .forEach((k) => console.log('  ' + byCollege[k] + '\t' + k));
  console.log('重名条数: ' + dup + (dup ? '  ← 有重复，导入时去重没生效' : ''));
  Object.keys(dups).forEach((n) => {
    console.log('  重名: ' + n + '  在 ' + dups[n].map((x) => x.college).join(' / '));
  });
  if (list.length) console.log('样例: ' + JSON.stringify(list[0]));
  return dups;
}
