// utils/official.js —— 学校官网链接白名单
//
// 小程序不能随意打开站外网页：web-view 只允许业务域名。
// 这里做代码侧第一道白名单，后台业务域名仍必须由开发者在 mp 后台配置。

const ROOT = 'zjgsu.edu.cn';
// 个别学校站点没有可用的 HTTPS（例如体育工作部 HTTPS 会 301 回 HTTP），
// web-view 只接受 HTTPS，配了也会跳回 HTTP。这类域名只保留复制链接兜底。
const NO_WEBVIEW_HOSTS = ['tgb.zjgsu.edu.cn'];

function normalizeUrl(url) {
  const s = String(url || '').trim();
  // 学校站点历史上有一批 http 链接；浏览器/微信 web-view 都要求 https。
  // 只升级学校域名，绝不把任意外链改协议。
  return /^http:\/\/[^/]*zjgsu\.edu\.cn/i.test(s) ? s.replace(/^http:/i, 'https:') : s;
}

function hostOf(url) {
  const s = normalizeUrl(url);
  if (!/^https:\/\//i.test(s)) return '';
  const m = /^https:\/\/([^/?#]+)/i.exec(s);
  if (!m) return '';
  return String(m[1] || '').toLowerCase().replace(/:\d+$/, '');
}

function isOfficialUrl(url) {
  const host = hostOf(url);
  if (!host || NO_WEBVIEW_HOSTS.indexOf(host) >= 0) return false;
  return host === ROOT || host.endsWith('.' + ROOT);
}

function webviewPath(url, title) {
  return '/sub/campus/webview/webview?url=' + encodeURIComponent(normalizeUrl(url))
    + '&title=' + encodeURIComponent(String(title || ''));
}

module.exports = { ROOT, NO_WEBVIEW_HOSTS, normalizeUrl, hostOf, isOfficialUrl, webviewPath };