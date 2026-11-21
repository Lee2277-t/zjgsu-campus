// utils/nav.js —— 统一的路由跳转守卫
//
// 为什么要有这一层（第 7 点：匿名树洞重复入栈）：
//   「从我的页点树洞，进去两次、要退出两次」这类问题，根因可能有三种：
//     ① 连点：手指抖一下 / 觉得没反应再点一下，两次 navigateTo 依次生效；
//     ② 重复绑定：父元素 bindtap + 子元素 bindtap 冒泡，一次点击跑两遍；
//     ③ 事件在自定义组件边界上既走了 triggerEvent 又被页面 catch 到。
//   逐个去查 54 处跳转点的调用现场太脆，而且下次新加页面还会再犯。
//
//   所以收敛成一条：所有 navigateTo 都走 nav.go()，由守卫保证
//   「同一个目标在极短时间窗内只跳一次」「栈顶已经是目标页就不再压栈」
//   「页面栈到 10 层上限时自动退化成 redirectTo，而不是静默失败」。
//
// 这样不管触发源是上面哪一种，页面栈都不会再被压进两个相同实例。

// 连点锁：两次同目标跳转间隔小于这个值，第二次直接丢掉。
// 700ms 是按人最快连续点两次的间隔取的，正常操作（看完一页再返回再进）远大于它。
const LOCK_MS = 700;

// 小程序页面栈上限 10 层，超了 navigateTo 会直接失败（界面上就是「点了没反应」）
const MAX_STACK = 10;

// tabBar 页只能用 switchTab 跳，用 navigateTo 会被平台直接拒绝且**不触发 fail 回调**
// （这就是「搜索结果里点查看全部毫无反应」的根因，见 pages/search）。
// 五个 tab 的路径必须和 app.json 的 tabBar.list 一致。
const TAB_PAGES = [
  'pages/course/list/list',
  'pages/forum/list/list',
  'pages/market/list/list',
  'pages/campus/campus',
  'pages/mine/mine'
];

// tabBar 页**带不了 query**（switchTab 不接受参数）。带词跳 tab 的做法是：
// 先把参数写进 storage，目标页 onShow 里用 takePending(this.route) 取走。
const PENDING_KEY = 'nav_tab_pending';
// 投递有效期：超过这个时间就不再认。用户可能压根没跳成、或跳过去干别的了，
// 不能几十分钟后突然把他的列表按一个早就忘了的词筛一遍。
const PENDING_TTL = 15000;

const lastAt = Object.create(null);

/** 当前栈顶页面的 route，如 sub/forum/hole/hole */
function topPage() {
  try {
    const pages = getCurrentPages();
    return pages.length ? pages[pages.length - 1] : null;
  } catch (e) {
    return null;
  }
}

/** 把 '/pages/x/x?a=1&b=2' 拆成 { path, query } */
function parse(url) {
  const s = String(url || '');
  const i = s.indexOf('?');
  const path = (i >= 0 ? s.slice(0, i) : s).replace(/^\//, '');
  const query = {};
  if (i >= 0) {
    s.slice(i + 1).split('&').forEach((kv) => {
      if (!kv) return;
      const p = kv.indexOf('=');
      const k = p >= 0 ? kv.slice(0, p) : kv;
      const v = p >= 0 ? decodeURIComponent(kv.slice(p + 1)) : '';
      query[k] = v;
    });
  }
  return { path: path, query: query };
}

/** 栈顶是不是已经是目标页（路径 + 参数都相同） */
function isAtTarget(url) {
  const top = topPage();
  if (!top || !top.route) return false;
  const t = parse(url);
  if (t.path !== top.route) return false;
  const cur = top.options || {};
  const keys = Object.keys(t.query);
  // 参数全比一遍：详情页 ?id=A 和 ?id=B 是两个不同实例，不能互相挡掉
  for (const k of keys) {
    if (String(cur[k] === undefined ? '' : cur[k]) !== String(t.query[k])) return false;
  }
  return true;
}

/** 是不是 tabBar 页（路径不带前导斜杠） */
function isTabPage(path) {
  return TAB_PAGES.indexOf(String(path || '').replace(/^\//, '')) >= 0;
}

/** 给 tab 页投递参数（switchTab 带不了 query，只能中转一次） */
function setPending(path, query) {
  try {
    wx.setStorageSync(PENDING_KEY, {
      path: String(path || '').replace(/^\//, ''),
      query: query || {},
      at: Date.now()
    });
  } catch (e) { /* storage 满了也不该挡住跳转 */ }
}

/**
 * 目标页取走投递给自己的参数。
 * @param {string} route 页面自己的 this.route（如 'pages/forum/list/list'）
 * @returns {object|null} 没有、过期、或不是投给自己的，都返回 null
 */
function takePending(route) {
  const self = String(route || '').replace(/^\//, '');
  if (!self) return null;
  let box = null;
  try { box = wx.getStorageSync(PENDING_KEY); } catch (e) { return null; }
  if (!box || !box.path || box.path !== self) return null;
  // 只清自己那一份：另一个 tab 的投递不该被顺手抹掉
  try { wx.removeStorageSync(PENDING_KEY); } catch (e) { /* 清不掉也不影响本次使用 */ }
  if (Date.now() - (Number(box.at) || 0) > PENDING_TTL) return null;
  return box.query || null;
}

/**
 * 跳转。同时兼容字符串和对象两种写法：
 *   nav.go('/pages/a/a')
 *   nav.go({ url: '/pages/a/a?id=1', events: {...} })
 * @returns {boolean} 是否真的发起了跳转（false = 被守卫拦下）
 */
function go(arg) {
  const opt = typeof arg === 'string' ? { url: arg } : Object.assign({}, arg);
  const url = String(opt.url || '');
  if (!url) return false;

  const now = Date.now();
  if (lastAt[url] && now - lastAt[url] < LOCK_MS) return false;
  lastAt[url] = now;

  const target = parse(url);

  // tabBar 页：走 switchTab。参数没法经 URL 带过去，投递到 storage 由目标页取。
  // 这一段必须放在 isAtTarget / 栈深判断之前 —— switchTab 不受页面栈层数限制，
  // 而且它本身就是「清空其它页」，不需要 redirectTo 兜底。
  if (isTabPage(target.path)) {
    const keys = Object.keys(target.query);
    if (keys.length) setPending(target.path, target.query);
    const top = topPage();
    if (top && top.route === target.path) {
      // 已经站在这个 tab 上：switchTab 是空转，onShow 也不会再来一次。
      // 这时候参数得直接塞给活着的页面实例，否则用户点了「查看全部」等于没点。
      if (keys.length && typeof top.onTabParams === 'function') {
        try { top.onTabParams(target.query); } catch (e) { /* 页面自己没接住不该连累跳转 */ }
      }
      return false;
    }
    wx.switchTab({ url: '/' + target.path });
    return true;
  }

  // 栈顶已经是这一页：再跳一次只会多压一个一模一样的实例，
  // 表现就是「点进去要退出两次」
  if (isAtTarget(url)) return false;

  let depth = 1;
  try { depth = getCurrentPages().length; } catch (e) { depth = 1; }
  if (depth >= MAX_STACK) {
    // 栈满了 navigateTo 必失败，退化成替换当前页，保证跳转不会石沉大海
    wx.redirectTo({ url: url });
    return true;
  }

  wx.navigateTo(opt);
  return true;
}

/** 返回上一页；已经在栈底时给一个兜底首页，避免「点了返回没反应」 */
function back(delta) {
  let depth = 1;
  try { depth = getCurrentPages().length; } catch (e) { depth = 1; }
  if (depth > 1) {
    wx.navigateBack({ delta: Math.max(1, Number(delta) || 1) });
  } else {
    wx.switchTab({ url: '/pages/course/list/list' });
  }
}

module.exports = { go, back, isAtTarget, isTabPage, takePending, TAB_PAGES, LOCK_MS, MAX_STACK };
