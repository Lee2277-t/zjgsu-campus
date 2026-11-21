const https = require('https');
function get(u) {
  return new Promise((resolve, reject) => {
    https.get(u, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return get(new URL(r.headers.location, u).href).then(resolve, reject);
      }
      let b = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { b += c; });
      r.on('end', () => resolve({ u, status: r.statusCode, html: b }));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}
(async () => {
  const list = await get('https://www.zjgsu.edu.cn/');
  console.log('LIST', list.status, list.html.length);
  const links = [...list.html.matchAll(/href=["']([^"']+)["']/gi)]
    .map((m) => { try { return new URL(m[1], list.u).href; } catch (e) { return ''; } })
    .filter((u) => u && /zjgsu\.edu\.cn/.test(u) && !/\.(css|js|png|jpg|jpeg|gif|svg)(\?|$)/i.test(u));
  console.log(links.slice(0, 20).join('\n'));
  const art = links.find((u) => /\d{4}\/\d{2}\/\d{2}|info\/|content\/|page\.htm/i.test(u)) || links.find((u) => !/\/$/.test(u) && !/main\.htm/.test(u));
  if (art) {
    const a = await get(art);
    console.log('ARTICLE', a.status, a.html.length, art);
    console.log(a.html.slice(0, 4000));
  }
})().catch((e) => console.error('ERR', e.message));