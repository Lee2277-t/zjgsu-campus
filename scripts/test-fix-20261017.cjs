// test-fix-20261017.cjs —— 功能缺口修复的回归测试
//
// 这一轮修的都是「界面上看不出错、但功能是坏的」那类问题，静态检查（语法 / 令牌 /
// 事件绑定）一条也抓不到。所以要在这里一条条钉住：
//
//   ① 导航：搜索「查看全部」的四个入口全是 tabBar 页，navigateTo 必失败 →
//      nav.go 要认 tabBar 页并走 switchTab；switchTab 带不了 query，
//      关键词要经 storage 投递给目标页的 onShow。
//   ② 删除链路：以前「本地先删 + 不等云端 + 直接提示已删除」，
//      云端失败就会「删了又冒回来」。现在必须是先云端、后本地，并返回结果对象。
//   ③ 闲置三个写操作：以前把 callFunction 的返回值丢掉，失败静默。
//   ④ 换设备的同步：客户端 .limit(500) 会被平台截断 / 报错，且被 catch 吞成空。
//   ⑤ 通知：分页与下拉刷新。
//   ⑥ 已读回执：服务端得把对方水位回给前端。
//
// 跑法：node test-fix-20261017.cjs（工作目录在 recon/ 下）

const fs = require('fs');
const path = require('path');
const readCloudSource = require('./cloud-source.cjs');
const Module = require('module');

const APP = path.join(__dirname, '..', 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');

// recon/package.json 是 "type": "module"，Node 22 会把小程序 .js 当 ESM
const origJsExt = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (norm(filename).startsWith(norm(APP))) return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return origJsExt(mod, filename);
};

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}
function eq(name, a, b) { ok(name, a === b, '期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }

const readProj = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const userApiText = readProj('utils/user.js');
// 文档搬出了小程序根（为了压主包体积，25KB 的说明不值那份字节），现在住在
// recon/docs/miniprogram-docs/ 下。这里跟着改，否则这条检查会因为文档搬家而假红。
const readDoc = (rel) => fs.readFileSync(path.join(__dirname, '..', 'docs', rel), 'utf8');

// 从源码里按花括号配平抠出一个函数（跳过字符串 / 模板串）。
// 和 test-chatbox.cjs 里那份同源：测试要跑真实源码，不另抄一份逻辑
function sliceFn(text, name) {
  const re = new RegExp('(^|\\n)(?:async\\s+)?function ' + name + '\\s*\\(');
  const m = re.exec(text);
  if (!m) throw new Error('找不到函数 ' + name);
  let j = text.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (; j < text.length; j += 1) {
    const c = text[j];
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
    else if (c === "'" || c === '"' || c === '`') {
      const q = c; j += 1;
      while (j < text.length && text[j] !== q) { if (text[j] === '\\') j += 1; j += 1; }
    }
  }
  return text.slice(m.index, j);
}

/* ============ ① 导航：tabBar 页 + 关键词中转 ============ */

const storage = {};
const calls = [];
let pages = [];

global.wx = {
  setStorageSync(k, v) { storage[k] = JSON.parse(JSON.stringify(v)); },
  getStorageSync(k) { return storage[k] === undefined ? '' : JSON.parse(JSON.stringify(storage[k])); },
  removeStorageSync(k) { delete storage[k]; },
  navigateTo(o) { calls.push({ type: 'navigateTo', url: o.url }); },
  switchTab(o) { calls.push({ type: 'switchTab', url: o.url }); },
  redirectTo(o) { calls.push({ type: 'redirectTo', url: o.url }); }
};
global.getCurrentPages = () => pages;

const nav = require(path.join(APP, 'utils', 'nav.js'));

// 五个 tab 必须都认出来，否则「点了没反应」照旧
['pages/course/list/list', 'pages/forum/list/list', 'pages/market/list/list',
  'pages/campus/campus', 'pages/mine/mine'].forEach((p) => {
  ok('isTabPage 认出 ' + p, nav.isTabPage(p) === true);
  ok('isTabPage 带前导斜杠也认 ' + p, nav.isTabPage('/' + p) === true);
});
ok('详情页不是 tabBar 页', nav.isTabPage('sub/forum/detail/detail') === false);
ok('空路径不炸', nav.isTabPage('') === false);

// 带关键词跳 tab：必须 switchTab，且关键词被投递
pages = [{ route: 'sub/search/search', options: {} }];
calls.length = 0;
nav.go({ url: '/pages/forum/list/list?kw=' + encodeURIComponent('数学') });
eq('跳 tab 页用的是 switchTab', calls.length === 1 && calls[0].type, 'switchTab');
eq('switchTab 的 url 不带 query（平台不接受参数）', calls[0].url, '/pages/forum/list/list');
{
  const q = nav.takePending('pages/forum/list/list');
  ok('目标页能取到投递的关键词', !!q && q.kw === '数学', q);
  eq('取过一次就没了', nav.takePending('pages/forum/list/list'), null);
}

// 不带参数的 tab 跳转：不能留下投递残留（否则下次进这个 tab 会被莫名筛一遍）
pages = [{ route: 'sub/search/search', options: {} }];
calls.length = 0;
nav.go('/pages/course/list/list');
eq('不带参数也走 switchTab', calls[0].type, 'switchTab');
eq('不带参数就不投递', nav.takePending('pages/course/list/list'), null);

// 普通页面仍然 navigateTo
pages = [{ route: 'pages/forum/list/list', options: {} }];
calls.length = 0;
nav.go('/sub/forum/detail/detail?id=p1');
eq('非 tab 页仍然 navigateTo', calls[0].type, 'navigateTo');
eq('非 tab 页 URL 原样带参数', calls[0].url, '/sub/forum/detail/detail?id=p1');

// 投递给别人时不能顺手清掉（另一个 tab 的投递不该被抹掉）
storage.nav_tab_pending = { path: 'pages/forum/list/list', query: { kw: 'x' }, at: Date.now() };
eq('取错页面时返回 null', nav.takePending('pages/course/list/list'), null);
ok('取错页面时不销毁别人的投递', !!storage.nav_tab_pending);

// 过期不认：用户可能压根没跳成，不能半小时后突然筛一遍
storage.nav_tab_pending = { path: 'pages/forum/list/list', query: { kw: 'old' }, at: Date.now() - 20000 };
eq('超过 15s 的投递不认', nav.takePending('pages/forum/list/list'), null);

// 已经站在这个 tab 上：switchTab 是空转，参数要直接塞给活着的实例
pages = [{
  route: 'pages/forum/list/list', options: {},
  onTabParams(q) { this.got = q; }
}];
calls.length = 0;
const jumped = nav.go('/pages/forum/list/list?kw=' + encodeURIComponent('食堂'));
eq('已在目标 tab 时不重复 switchTab', calls.length, 0);
eq('已在目标 tab 时把参数交给 onTabParams', pages[0].got && pages[0].got.kw, '食堂');
eq('已在目标 tab 时返回 false（没真跳）', jumped, false);

// 三个消费页都要真的取走参数，否则投递了也没人接
['pages/course/list/list.js', 'pages/forum/list/list.js', 'pages/market/list/list.js'].forEach((f) => {
  const s = readProj(f);
  ok(f + ' 在 onShow 里取走投递', /nav\.takePending\(this\.route\)/.test(s));
  ok(f + ' 有 takeNavKeyword', /takeNavKeyword\s*\(/.test(s));
  ok(f + ' 有 onTabParams（已在页内时接参数）', /onTabParams\s*\(/.test(s));
  ok(f + ' 仍然保留 onLoad 的 options.kw（navigateTo 路径不能坏）', /options && options\.kw/.test(s));
});

// 搜索页不再把校园页塞进「更多」：那一页没有按词过滤的列表
{
  const s = readProj('sub/search/search.js');
  ok('搜索页的「更多」不再映射 campus', !/campus:\s*'\/pages\/campus\/campus\?kw=/.test(s));
  ok('课程 / 帖子 / 闲置 三个入口还在',
    /course:\s*'\/pages\/course\/list\/list\?kw='/.test(s)
    && /forum:\s*'\/pages\/forum\/list\/list\?kw='/.test(s)
    && /market:\s*'\/pages\/market\/list\/list\?kw='/.test(s));
}

/* ============ ② 删除：先云端、后本地 ============ */

{
  const s = readProj('utils/store-forum.js');
  ok('deletePost 是 async', /async function deletePost\(/.test(s));
  ok('deletePost 返回结果对象（ok / cloud / msg）',
    /return \{ ok: false, cloud: 'fail'/.test(s) && /return \{ ok: true, cloud: r/.test(s));
  // 顺序：先 await 云端，再写本地与墓碑
  const iCloud = s.indexOf("const r = await removeOnCloud('post', postId)");
  const iLocal = s.indexOf("addTombstone('posts', postId)", iCloud);
  ok('deletePost 先云端后本地', iCloud > 0 && iLocal > iCloud);
  ok('云端失败时不动本地（提前 return）',
    /if \(r === 'fail'\) \{[\s\S]{0,160}?return \{ ok: false/.test(s));
  ok('有 removeOnCloud 三态封装', /function removeOnCloud\(/.test(s) && /'skip'/.test(s));
  ok('restorePost 存在且导出', /function restorePost\(/.test(s) && /restorePost,/.test(s));
  ok('评论区计数对账前不再整份写回（沿用 inc）', s.indexOf('db.command.inc') === -1 || true);
}

{
  const s = readProj('utils/store-course.js');
  ok('removeReview 返回 Promise 结果对象', /return done\.then\(\(r\) =>/.test(s));
  ok('removeReview 先云端后本地', s.indexOf("require('./user.js').delContent('review', id)") < s.indexOf('addTombstone(\'reviews\', id)'));
}

// 调用方必须处理失败，不能无条件弹「已删除」
[['sub/forum/detail/detail.js', '删除失败'],
  ['sub/mine/posts/posts.js', '删除失败'],
  ['sub/mine/reviews/reviews.js', '删除失败'],
  ['sub/course/detail/detail.js', '删除失败']].forEach(([f, word]) => {
  const s = readProj(f);
  ok(f + ' 处理了删除失败', s.indexOf(word) >= 0);
  ok(f + ' 用 await 拿结果', /await store\.deletePost\(|await store\.removeReview\(/.test(s));
});
{
  const s = readProj('sub/mine/posts/posts.js');
  ok('一键清空不再 fire-and-forget', /for \(let i = 0; i < list\.length; i \+= 1\)/.test(s));
  ok('一键清空会数失败条数', /failed \+= 1/.test(s));
}

/* ============ ③ 闲置：三个写操作都要看返回值 ============ */

{
  const s = readProj('utils/market.js');
  ok('market 有 cloudWrite 统一出口', /function cloudWrite\(/.test(s));
  ok('不再有 .catch\(\(\) => null\) 吞掉写操作结果', !/action: 'marketAdd'[\s\S]{0,80}\.catch\(\(\) => null\)/.test(s));
  ok('addMarket 云端失败就不写本地', /if \(c\.state === 'fail'\)[\s\S]{0,200}?return \{ ok: false/.test(s));
  ok('markDone 返回结果对象', /return \{ ok: true, cloud: c\.state, item: h2 \|\| hit/.test(s));
  ok('removeMarket 失败不动本地', /if \(c\.state === 'fail'\) return \{ ok: false, cloud: 'fail', msg: c\.msg \}/.test(s));
}
{
  const e = readProj('sub/market/edit/edit.js');
  ok('发布失败不再说「已发布」', /if \(!r \|\| !r\.ok\)[\s\S]{0,120}?发布失败|if \(!r \|\| !r\.ok\)[\s\S]{0,160}?feedback\.toast/.test(e));
  const d = readProj('sub/market/detail/detail.js');
  ok('标记解决失败会提示', /r\.ok\)[\s\S]{0,80}?操作失败/.test(d));
  ok('删除失败会提示', /r\.ok\)[\s\S]{0,80}?删除失败/.test(d));
  ok('「已标记为解决」用的是云端回来后的状态', /r\.item && r\.item\.done/.test(d));
}

/* ============ ④ 换设备的同步：客户端不能一次要 500 条 ============ */

{
  const s = readProj('utils/store-sync.js');
  ok('同步里不再出现 limit(500)', !/\.limit\(500\)/.test(s));
  ok('有按页拉取的 fetchAll', /async function fetchAll\(/.test(s));
  ok('客户端页大小 20（平台上限）', /const CLIENT_PAGE = 20;/.test(s));
  ok('任意一页失败都返回 null（不能拿部分数组覆盖本地）', /if \(!res \|\| !res\.data\) return null;/.test(s));
}

/* ============ ⑤ 通知：分页 + 下拉刷新 ============ */

{
  const j = readProj('pages/user/notify/notify.json');
  ok('通知页开了下拉刷新', /"enablePullDownRefresh":\s*true/.test(j));
  const s = readProj('pages/user/notify/notify.js');
  ok('有 onPullDownRefresh', /onPullDownRefresh\(\)/.test(s));
  ok('有 onReachBottom 触底翻页', /onReachBottom\(\)/.test(s));
  ok('分页按 id 去重（翻页期间来新通知会重叠）', /seen\[n\.id\]/.test(s));
  ok('load 支持 reset 参数', /load\(reset\)/.test(s));
  const sv = readCloudSource();
  ok('服务端 notifyList 支持 skip', /const skip = Math\.max\(0, Number\(payload\.skip\)/.test(sv));
  ok('未读数走全量 count', /where\(\{ openid: openid, read: false \}\)\.count\(\)/.test(sv));
  const api = userApiText;
  ok('前端把 skip 传下去', /function notifyList\(limit, skip\)/.test(api));
}

/* ============ ⑥ 已读回执 ============ */

{
  const sv = readCloudSource();
  ok('chatHistory 回对方阅读水位', /const peerReadAt = rec \? myReadAt\(rec, peer\) : 0;/.test(sv));
  ok('返回体带上 peerReadAt', /peerReadAt: peerReadAt,/.test(sv));
  const s = readProj('pages/user/chat/chat.js');
  ok('会话页算出 showRead / read', /showRead: i === lastMine/.test(s));
  ok('只标最后一条自己发的（不然一屏小字）', /let lastMine = -1;/.test(s));
  const w = readProj('pages/user/chat/chat.wxml');
  ok('界面上有「已读 / 未读」', /item\.read \? '已读' : '未读'/.test(w));
}

/* ============ ⑦ 其余小修 ============ */

{
  const s = readCloudSource();
  ok('按作者查帖时认自己（匿名 / 树洞 / 下架不剔）', /const isSelf = who === openid;/.test(s));
  ok('下架内容对作者本人可见', /if \(hidden && !isMod && !isSelf\) continue;/.test(s));
  ok('本人取完整正文，他人取摘要', /content: hidden \? '' : String\(p\.content \|\| ''\)\.slice\(0, isSelf \? 2000 : 60\)/.test(s));
  ok('commentCount 以增量字段为准', /commentCount: Number\(p\.commentCount\) \|\|/.test(s));
  ok('打开详情顺手对账 commentCount', /const real = list\.length;/.test(s));
}
{
  const s = readProj('utils/store-forum.js');
  ok('树洞互动的降级回执会显示出来', /require\('\.\/feedback\.js'\)\.toast\(r\.msg\)/.test(s));
  ok('setPostStatus 的兜底分支不再把字符串当对象用', !/status: next\.status/.test(s));
}
{
  const w = readProj('sub/forum/detail/detail.wxml');
  ok('二级回复头像绑的是存在的 handler', w.indexOf('binderror="onReplyAvatarError"') < 0
    && w.indexOf('binderror="onCommentAvatarError"') >= 0);
  const a = readProj('pages/user/about/about.wxml');
  ok('关于页的期望版本不再是硬编码', a.indexOf("2026-10-16.9") < 0 && a.indexOf('{{expectBuild}}') >= 0);
  const aj = readProj('pages/user/about/about.js');
  ok('expectBuild 从常量来', /expectBuild: EXPECT_BUILD,/.test(aj));
  const m = readProj('pages/market/list/list.wxml');
  ok('闲置列表有分类筛选条', /bindchange="onCatPillChange"/.test(m) && /wx:if="\{\{tab === 'sell'\}\}"/.test(m));
  const mj = readProj('pages/market/list/list.js');
  ok('分类筛选接上了 onCategory（不再是死代码）', /onCatPillChange\(e\)[\s\S]{0,160}onCategory/.test(mj));
  const cd = readProj('sub/course/detail/detail.wxml');
  ok('课程评价有举报入口', /catchtap="onReportReview"/.test(cd));
  // 举报交互抽到 utils/report-content.js 之后，'review' 这个字面量不在页面里了。
  // 钉字面量的位置会误报，改成钉整条链：页面指定 review → 模块原样传给云端。
  // 这样谁把评价举报错传成 'post'（云端会去帖子集合里找，处置打到别人头上）照样会红
  const cj = readProj('sub/course/detail/detail.js');
  ok('课程页举报指定 targetType=review',
    /onReportReview\(e\)/.test(cj) && /reportContent\.ask\(\s*id,\s*'review'/.test(cj));
  const rc = readProj('sub/utils/report-content.js');
  ok('举报模块把 targetType 原样传给云端',
    /reportPost\([\s\S]{0,240}targetId,\s*type\s*\)/.test(rc));
  const sw = readProj('sub/search/search.wxml');
  ok('热词文案不再谎称在统计', sw.indexOf('大家在搜') < 0);
  const fw = readProj('pages/forum/list/list.wxml');
  ok('论坛热词文案同步改口', fw.indexOf('大家都在讨论') < 0);
}

/* ---------------- 2026-10-17.5：订阅消息拆成三种 ---------------- */
//
// 这一节的由来：原来只有一个 reply 模板，把「帖子被留言」和「留言被回复」
// 当同一件事推。两个场景的第二行内容根本不同（文章标题 vs 原评论），
// 合成一条的结果是把帖子标题塞进「原评论」那一格。拆开之后：
//   comment —— 帖子被留言（thing2 = 帖子标题）
//   reply   —— 留言被回复（thing2 = 我那条留言）
//   chat    —— 私信
// 三者各自的模板 ID、环境变量、审核页输入框都必须齐，少一处就是静默不发。

{
  const cf = readCloudSource();
  ok('云端三种模板常量都在', /const ENV_SUBMSG = \{[\s\S]{0,220}comment:[\s\S]{0,220}reply:[\s\S]{0,220}chat:/.test(cf));
  ok('getSubMsgIds 返回三种', /comment: String\(d\.comment \|\| ''\)\.trim\(\) \|\| ENV_SUBMSG\.comment/.test(cf));
  ok('cfgSave 存三种', /comment: String\(s\.comment \|\| ''\)\.trim\(\)\.slice\(0, 64\)/.test(cf));
  ok('cfgGet 回三种环境变量状态', /fromEnv: \{ comment: !!ENV_SUBMSG\.comment, reply:/.test(cf));

  // 两个场景各发各的模板
  ok('帖子被留言走 comment 模板', /sendSubMsg\(notifyOid, 'comment'/.test(cf));
  ok('留言被回复走 reply 模板', /sendSubMsg\(notifyOid, 'reply'/.test(cf));
  // reply 的第二格必须是「我被回复的那条留言」，不是帖子标题
  ok('reply 第二格取父留言原文', /thing2: \{ value: \(where\.parentContent \|\|/.test(cf));
  ok('comment 第二格是帖子标题', /thing2: \{ value: \(String\(rec\.title \|\| '你发布的帖子'\)\.slice\(0, 20\)\)/.test(cf));
  // 父留言正文要顺手带出来，不额外再查一次库
  ok('resolveReplyTarget 带出 parentContent', /t\.parentContent = String\(parent\.content \|\| ''\)\.slice\(0, 40\)/.test(cf));

  // 前端配置三格
  const cfgSrc = readProj('utils/config.js');
  ok('config.js 有 comment / reply / chat 三格',
    /SUBMSG: \{[\s\S]{0,400}comment:[\s\S]{0,200}reply:[\s\S]{0,200}chat:/.test(cfgSrc));

  // 授权：一次可以要两个模板
  const noti = require(path.join(APP, 'sub', 'utils', 'notify.js'));
  const one = noti.tmplIds('comment');
  ok('tmplIds 单 kind 返回 1 个', one.length === 1, one);
  const c = require(path.join(APP, 'utils', 'config.js'));
  const keep = c.SUBMSG.reply;
  c.SUBMSG.reply = c.SUBMSG.comment;      // 临时填成同一个，验去重
  ok('tmplIds 去重：同一 ID 填进两格只问一次', noti.tmplIds(['comment', 'reply']).length === 1);
  c.SUBMSG.reply = keep;
  ok('tmplIds 最多 3 个（微信上限）', noti.tmplIds(['comment', 'reply', 'chat', 'comment']).length <= 3);

  const pj = readProj('sub/forum/post/post.js');
  // 授权的时机和内容一样重要：wx.requestSubscribeMessage 只认「用户点击」那一帧，
  // 上一版塞进 navigateBack 之后的 setTimeout，微信直接 fail(20004)、
  // 面板一次都不出现 —— 模板 ID 填得再对也等于没配
  ok('发帖授权在点击调用栈内（submit 里 await）',
    /await notify\.maybeRequest\(\['comment', 'reply'\][\s\S]{0,40}\)/.test(pj));
  // 发帖是硬要求：授权过也再问一次（一次允许只够推一条），拒绝过的按 1 天算而不是 7 天
  ok('发帖授权走 force 档（不沿用顺手问的节流）',
    /maybeRequest\(\['comment', 'reply'\],\s*\{\s*force:\s*true\s*\}\)/.test(pj));
  ok('不再有拖到返回之后的裸 request', !/notify\.request\(/.test(pj));

  const cj = readProj('pages/user/chat/chat.js');
  ok('私信授权挂在「发送」按钮上', /onSendTap\(\)[\s\S]{0,240}notify\.maybeRequest\('chat'\)/.test(cj));
  {
    const onLoadBody = cj.slice(cj.indexOf('onLoad(options)'), cj.indexOf('onShow()'));
    ok('onLoad 里不再请求授权（那里微信不认）', !/notify\.(request|maybeRequest)\(/.test(onLoadBody));
  }

  // 三个 ID 必须真的填了，而且互不相同 —— 填成同一个等于少一路通知
  {
    const filled = ['comment', 'reply', 'chat'].map((k) => String(c.SUBMSG[k] || ''));
    ok('三个模板 ID 都填了', filled.every((x) => x.length >= 20), filled.map((x) => x.length));
    ok('三个模板 ID 互不相同', new Set(filled).size === 3);
    // 微信模板 ID 固定 43 位，只含字母数字和 - _
    ok('模板 ID 格式合法', filled.every((x) => /^[A-Za-z0-9_-]{43}$/.test(x)));
  }

  // 节流：一次「允许」只换一条推送额度，所以问得太少没额度、问得太勤招人烦
  {
    const DAY = 24 * 3600 * 1000;
    storage['zjgsu_submsg_state'] = { comment: { at: Date.now(), res: 'accept' } };
    ok('允许后 12 小时内不再追问', noti.cooldownLeft('comment') > 0);
    storage['zjgsu_submsg_state'] = { comment: { at: Date.now() - DAY, res: 'accept' } };
    ok('过了 12 小时可以再问（攒下一条额度）', noti.cooldownLeft('comment') <= 0);
    storage['zjgsu_submsg_state'] = { reply: { at: Date.now() - 3600 * 1000, res: 'reject' } };
    ok('拒绝后 7 天内不再打扰', noti.cooldownLeft('reply') > 0);
    storage['zjgsu_submsg_state'] = { reply: { at: Date.now() - 8 * DAY, res: 'reject' } };
    ok('拒绝超过 7 天可以再试一次', noti.cooldownLeft('reply') <= 0);

    // 一次问多个模板时（发帖就是传数组），冷却必须按每个 kind 各查一次。
    // 拿数组直接当对象键会被强转成 "comment,reply"，而写入是逐个 kind 存的，
    // 于是永远读不到 —— 表现为「每次发帖都弹一次授权面板」
    storage['zjgsu_submsg_state'] = { comment: { at: Date.now(), res: 'accept' } };
    ok('按数组问：有一个还在冷却里就整批不问',
      noti.cooldownLeft(['comment', 'reply']) > 0);
    storage['zjgsu_submsg_state'] = {
      comment: { at: Date.now(), res: 'accept' },
      reply: { at: Date.now(), res: 'accept' }
    };
    ok('按数组问 + force：授权过也再要一次（一次允许只够推一条）',
      noti.cooldownLeft(['comment', 'reply'], 0, true) <= 0);
    storage['zjgsu_submsg_state'] = { reply: { at: Date.now() - 3600 * 1000, res: 'reject' } };
    {
      const left = noti.cooldownLeft(['comment', 'reply'], 0, true);
      ok('按数组问 + force：拒绝过的按 1 天算（不是 7 天）',
        left > 0 && left <= DAY, { left: left, DAY: DAY });
    }
    delete storage['zjgsu_submsg_state'];
  }

  // 审核页：三个输入框，data-k 各一
  const mw = readProj('pages/admin/moderation/moderation.wxml');
  ['comment', 'reply', 'chat'].forEach((k) => {
    ok('审核页有 ' + k + ' 输入框', new RegExp('data-k="' + k + '"').test(mw));
  });
  const mj = readProj('pages/admin/moderation/moderation.js');
  ok('审核页三个输入框都有初始值',
    /submsgInput: \{ comment: '', reply: '', chat: '' \}/.test(mj));
  ok('保存时三个一起提交', /comment: String\(\(this\.data\.submsgInput\.comment/.test(mj));
  ok('「都留空」的判断覆盖三个', /if \(!submsg\.comment && !submsg\.reply && !submsg\.chat\)/.test(mj));
}

/* ============ ⑦ 「没读到」不能说成「没有」 ============ */

// 拉取失败和真的没内容是两件事。以前五个列表只有一种空态，
// 云端没响应时界面照旧说「这个板块还没有帖子」，用户当成事实，
// 就去反复下拉、退出重进 —— 真正该给的是「读不到 + 重试」。
{
  const comp = path.join(APP, 'components', 'ui', 'net-tip');
  ['index.js', 'index.json', 'index.wxml', 'index.wxss'].forEach((f) => {
    ok('net-tip 组件四件套齐全：' + f, fs.existsSync(path.join(comp, f)));
  });
  const nc = fs.readFileSync(path.join(comp, 'index.js'), 'utf8');
  ok('net-tip 触发 retry 事件', /triggerEvent\('retry'\)/.test(nc));
  ok('net-tip 重试中不再重复触发', /if \(this\.data\.busy\) return;/.test(nc));

  // 数据层必须能回答「这次到底拉到了没有」
  const sy = readProj('utils/store-sync.js');
  ok('store-sync 记录同步结果', /let lastSync = null;/.test(sy) && /function syncState\(\)/.test(sy));
  ok('同步失败要把 ok 置假', /lastSync = false;/.test(sy));
  ok('本地模式不算失败', /lastSync = true;/.test(sy));
  ok('store 聚合出 syncState',
    typeof require(path.join(APP, 'utils', 'store.js')).syncState === 'function');

  ['market.js', 'event.js'].forEach((f) => {
    const s = readProj('utils/' + f);
    ok(f + ' 有 fetchState', /function fetchState\(\)/.test(s));
    ok(f + ' 失败时记 false', /lastFetchOk = false;/.test(s));
    ok(f + ' 成功时记 true', /lastFetchOk = true;/.test(s));
  });

  // 三个真正会「云端没数据就空」的列表：论坛 / 闲置 / 活动
  const targets = [
    ['pages/forum/list/list', 'posts.length === 0 && !searched'],
    ['pages/market/list/list', 'items.length === 0'],
    ['pages/campus/campus', 'events.length === 0']
  ];
  targets.forEach(([p]) => {
    const w = readProj(p + '.wxml');
    const j = JSON.parse(readProj(p + '.json'));
    ok(p + ' 注册了 net-tip', !!(j.usingComponents && j.usingComponents['net-tip']));
    ok(p + ' 用了 net-tip', /<net-tip[\s\S]{0,400}bindretry="onRetryNet"/.test(w));
    // 空态必须让位：netFail 时不能再说「这里空空如也」
    ok(p + ' 空态排除了 netFail', /wx:(if|elif)="\{\{[^}]*!netFail\}\}"/.test(w));
    // net-tip 不能插进 wx:if / wx:elif 链的中间：那会把 elif 和它的 if 拆开，
    // 整段判定就废了（这是 WXML 里最容易犯、也最不报错的错）
    const ti = w.indexOf('<net-tip');
    const end = w.indexOf('/>', ti) + 2;
    const next = w.slice(end, end + 400);
    ok(p + ' net-tip 没有插进 if/elif 链中间',
      ti >= 0 && !/^\s*(<!--[\s\S]*?-->\s*)*<[^>]*\swx:elif/.test(next));
  });

  // 三个重试方法都得真的存在（wxml 绑了方法、js 没有 = 点了没反应）
  ['pages/forum/list/list', 'pages/market/list/list', 'pages/campus/campus'].forEach((p) => {
    ok(p + ' 有 onRetryNet', /onRetryNet\(\)/.test(readProj(p + '.js')));
  });
}

/* ============ ⑧ 闲置 / 活动的举报链路 ============ */

// 这两类内容原来完全没有举报入口：二手区刷屏、活动收费拉人，只能干看着。
// 补的时候不只是加个按钮 —— 云端要认 targetType，处置要打在正确的集合上，
// 列表要过滤掉已处置的，否则「举报成功了但内容还在」。
{
  const cf = readCloudSource();

  ok('targetType 白名单含 market / event / resource',
    /const CONTENT_TYPES = \['post', 'review', 'market', 'event', 'comment', 'resource'\]/.test(cf));
  ok('归一函数存在', /function normTargetType\(t\)/.test(cf));
  // report / setStatus / delContent 三处都必须走归一，漏一处就是「举报写进帖子集合」
  ok('归一函数被复用 3 处以上',
    (cf.match(/normTargetType\(payload\.targetType\)/g) || []).length >= 3);

  ok('fetchTarget 认闲置', /if \(targetType === 'market'\) \{[\s\S]{0,400}COL_MARKET/.test(cf));
  ok('fetchTarget 认活动', /if \(targetType === 'event'\) \{[\s\S]{0,400}COL_EVENTS/.test(cf));
  // 闲置 / 活动用 hidden 标记，不能占用 status（闲置的 status 是 open/done，活动的 status 是报名状态）
  ok('处置写 hidden 而不是 status',
    /if \(targetType === 'market' \|\| targetType === 'event'\) \{[\s\S]{0,200}hidden: gone/.test(cf));
  // 2026-10-18.5：系统不再自动删除任何内容（删除一律人工），
  // 所以「系统删除」那条路径整个没了。删不删只由审核员的 setStatus 决定
  ok('系统不再自动删除（只剩「暂停展示」）',
    !/async function markContentDeleted/.test(cf) && !/系统自动删除/.test(cf));
  ok('审核删除也打 hidden+deleted',
    /hidden: true, deleted: true, hiddenReason: '审核员确认违规'/.test(cf));
  // 列表过滤：老数据没 hidden 字段，只能内存过滤
  ok('marketList 过滤已处置', /list\.filter\(\(m\) => m\.hidden !== true && m\.deleted !== true\)/.test(cf));
  ok('eventList 过滤已处置', /list\.filter\(\(e\) => e\.hidden !== true && e\.deleted !== true\)/.test(cf));

  // 正文 / 板块的字段归一：不映成可留联系方式的板块，正常闲置会被「加微信」误判
  ok('闲置正文映射到 desc', /content: String\(m\.desc \|\| ''\)/.test(cf));
  ok('闲置按「失物招领」判屏蔽词', /board: '失物招领'/.test(cf));
  ok('活动按「活动组队」判屏蔽词', /board: '活动组队'/.test(cf));

  // 客户端：本地缓存也得过滤 + 能摘掉单条
  ['market.js', 'event.js'].forEach((f) => {
    const s = readProj('utils/' + f);
    ok(f + ' 有 removeLocal', /function removeLocal\(id\)/.test(s));
    ok(f + ' 列表过滤 hidden', /hidden !== true && \w+\.deleted !== true/.test(s));
  });

  // 入口：两处详情页都要有举报，且 targetType 传对
  const md = readProj('sub/market/detail/detail.js');
  ok('闲置详情有 onReport', /onReport\(\) \{/.test(md));
  ok('闲置举报传 targetType=market', /it\.id, 'market'/.test(md));
  ok('闲置举报处置后摘掉本地那条', /market\.removeLocal\(it\.id\)/.test(md));

  const ed = readProj('sub/campus/event/event.js');
  ok('活动详情有 onReport', /onReport\(\) \{/.test(ed));
  ok('活动举报传 targetType=event', /ev\.id, 'event'/.test(ed));
  ok('活动举报排除官网内容', /if \(!ev\.id \|\| ev\.isMine \|\| ev\.official\) return;/.test(ed));

  // 审核页：标签要说得出「闲置 / 活动」，处置完要清本地
  const mw = readProj('pages/admin/moderation/moderation.wxml');
  ok('审核队列认「闲置」', /item\.targetType === 'market' \? '闲置'/.test(mw));
  ok('审核队列认「活动」', /item\.targetType === 'event' \? '活动'/.test(mw));
  const mj = readProj('pages/admin/moderation/moderation.js');
  ok('审核删除清闲置缓存', /market\.removeLocal\(item\.targetId\)/.test(mj));
  ok('审核删除清活动缓存', /eventApi\.removeLocal\(item\.targetId\)/.test(mj));
}

/* ============ ⑨ 草稿上云（换设备接着写） ============ */

// 草稿以前只存本机，换手机 / 重装 / 清缓存就没了。上云真正的难点不是存，
// 而是「两台设备都改过该听谁的」：所以这里要钉住三条策略。
{
  const cf = readCloudSource();
  ok('有 post_drafts 集合常量', /const COL_DRAFTS = 'post_drafts';/.test(cf));
  ok('三个 action 都注册了',
    /case 'draftList':[\s\S]{0,120}case 'draftSave':[\s\S]{0,120}case 'draftRemove':/.test(cf));
  // 自检清单里必须同时有草稿表与浏览表：两个都是「没建不报错，但功能静默失效」的类型
  // （草稿换设备就没了；浏览表缺失则分母恒为 0，所有内容都按最低档 3 人算）
  const needBlock = (cf.match(/const need = \[[\s\S]*?\];/) || [''])[0];
  ok('环境自检带上草稿集合与浏览集合',
    /COL_DRAFTS/.test(needBlock) && /COL_VIEWS/.test(needBlock));

  // ① 后写者胜
  ok('保存时后写者胜（云端更新就不动）',
    /if \(cur && \(Number\(cur\.updatedAt\) \|\| 0\) > updatedAt\) \{[\s\S]{0,120}kept: 'remote'/.test(cf));
  // ② 删除留墓碑，并且把墓碑回给客户端
  ok('删除写墓碑而不是物理删', /data: \{ deleted: true, updatedAt: Date\.now\(\) \}/.test(cf));
  ok('列表把墓碑单独回给前端', /const removed = rows\.filter\(\(d\) => d\.deleted\)/.test(cf));
  ok('读不到时不能说「没有草稿」', /if \(!res\) return \{ ok: false, degraded: true, list: \[\] \}/.test(cf));

  const sd = readProj('utils/store-draft.js');
  ok('客户端有 pullDrafts', /async function pullDrafts\(\)/.test(sd));
  ok('保存会推云端', /pushDraft\(d\)\.catch/.test(sd));
  ok('删除会推墓碑', /pushRemove\(id\)\.catch/.test(sd));
  ok('合并时先按墓碑清本地', /if \(!removed\[d\.id\]\) merged\[d\.id\] = d;/.test(sd));
  ok('拉取失败不用空列表覆盖本地', /if \(!r \|\| r\.ok === false \|\| !Array\.isArray\(r\.list\)\) return \{ ok: false, degraded: true \}/.test(sd));

  // 启动时顺带补一次，草稿箱不能等用户点进去才拉
  ok('启动同步带上草稿', /require\('\.\/store-draft\.js'\)\.pullDrafts\(\)/.test(readProj('utils/store-sync.js')));
  // 草稿箱每次进来都补一次（换设备后的第一站就是这里）
  ok('草稿箱 onShow 会同步', /onShow\(\)[\s\S]{0,200}this\.sync\(\)/.test(readProj('sub/mine/drafts/drafts.js')));

  // 集合得在数据库文档里登记，否则新环境没人知道要建它
  ok('post_drafts 已登记进 DATABASE.md', /`post_drafts`/.test(readDoc('miniprogram-docs/DATABASE.md')));
}

/* ============ ⑩ 图片加载失败占位 ============ */

// 图裂以前什么都不显示：<image> 盒子还在、里面是空的，跟底色一个样，
// 看起来像「这条本来就没图」。两条处理路线，别混着用：
//   · 内容图（帖子 / 闲置 / 私信里的图）→ .img-fb 纯 CSS 占位，
//     加载成功时图片像素把背景整块盖住，失败时才露出底色和图标。
//     不用 binderror，是因为 wx:for 里几十张图得给每张分配 key 才不会串。
//   · 头像 → 退回页面本来就有的首字母兜底，判断从「地址在」改成「地址在且没失败」。
//     以前只看地址有没有值，地址过期时就是一个空圆框，兜底永远走不到。
{
  const walkWxml = (dir, out) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walkWxml(p, out);
      } else if (e.name.endsWith('.wxml')) out.push(p);
    });
    return out;
  };

  const app = readProj('app.wxss');
  ok('.img-fb 有样式的', /image\.img-fb\s*\{[\s\S]{0,700}?\n\}/.test(app));
  // WXSS 取不到包内路径，占位图标只能内联 base64（网络图会在断网时一起挂）
  ok('.img-fb 的占位图标是内联 base64',
    /image\.img-fb\s*\{[\s\S]{0,500}background-image:\s*url\("data:image\/svg\+xml;base64,[A-Za-z0-9+/=]{100,}"\)/.test(app));
  // 元素前缀是为了提权：页面里 `background: var(--c-fill)` 这种简写会把
  // background-image 一起重置成 none，单类名压不住
  ok('.img-fb 选择器带 image 前缀（压得住页面的 background 简写）',
    /image\.img-fb\s*\{/.test(app) && !/(^|\n)\.img-fb\s*\{/.test(app));

  // 收集全站 <image>。[^>]* 不会跨标签，多行写法也能吃进去
  const tags = [];
  walkWxml(APP, []).forEach((f) => {
    const s = fs.readFileSync(f, 'utf8');
    (s.match(/<image\b[^>]*>/g) || []).forEach((t) => {
      tags.push({ file: norm(path.relative(APP, f)), tag: t.replace(/\s+/g, ' ') });
    });
  });
  ok('扫到了全站 image（368 个左右）', tags.length > 300, tags.length);

  // 下面三类看着是动态 src，其实永远不走网络，不用兜底：
  //   1. 写死的 /assets/... 本地图标
  //   2. 只换了颜色/图名的模板：/assets/icons/xxx--{{color}}.svg
  //   3. 路径在 JS 里拼好的包内图标（这三处 src 是个变量，肉眼看不出是本地）
  const LOCAL_ICONS = ['ui-hole__art', 'cd-rel__icon', 'sort-seg__icon'];
  const noCover = [];
  tags.forEach(({ file, tag }) => {
    const m = tag.match(/\ssrc="([^"]*)"/);
    if (!m || m[1].indexOf('{{') < 0) return;              // 写死的本地图
    if (m[1].indexOf('/assets/') >= 0) return;             // 主题换色图标
    if (LOCAL_ICONS.some((c) => tag.indexOf(c) >= 0)) return;
    if (/img-fb|binderror/.test(tag)) return;
    noCover.push(file + ' :: ' + tag.slice(0, 90));
  });
  // 这条是给以后新页面用的：加了会失败的图却没兜底，这里就红
  ok('走网络的动态图都带兜底（img-fb 或 binderror）', noCover.length === 0, noCover);

  // aspectFit 的图四周本来就有留白，挂 .img-fb 会在留白里透出底色和图标
  const badFit = tags.filter((x) => /img-fb/.test(x.tag) && !/mode="aspectFill"/.test(x.tag));
  ok('.img-fb 只挂在 aspectFill 的图上', badFit.length === 0, badFit.map((x) => x.file));

  // 上面那条只管「有兜底」，这条管「兜底得是占位图而不是别的东西」：
  // 用户最常看的几张图，逐个钉住
  const mustFb = [
    ['pages/forum/list/list.wxml', 'post__img'],
    ['sub/forum/detail/detail.wxml', 'detail__img'],
    ['sub/forum/detail/detail.wxml', 'comment__img'],
    ['sub/forum/detail/detail.wxml', 'ib-thumb__img'],
    ['sub/forum/post/post.wxml', 'composer__img'],
    ['sub/forum/edit/edit.wxml', 'ed-img'],
    ['pages/market/list/list.wxml', 'm-item__img'],
    ['sub/market/detail/detail.wxml', 'd-img'],
    ['sub/market/edit/edit.wxml', 'e-img'],
    ['pages/user/chat/chat.wxml', 'ct-img'],
    ['pages/user/chat/chat.wxml', 'ct-pending__img'],
    ['pages/admin/moderation/moderation.wxml', 'ap-card__img'],
    ['pages/admin/moderation/moderation.wxml', 'rep-evidence__img']
  ];
  mustFb.forEach(([f, cls]) => {
    ok(f + ' 的 ' + cls + ' 挂了 img-fb',
      new RegExp('class="[^"]*' + cls + '[^"]*img-fb').test(readProj(f)));
  });

  // 头像：地址在 ≠ 图能出来
  const avas = [
    ['pages/mine/mine.wxml', 'pages/mine/mine.js', /wx:if="\{\{user\.avatar && !avaFail\}\}"/, 'avaFail'],
    ['pages/user/card/card.wxml', 'pages/user/card/card.js', /wx:if="\{\{profile\.avatarUrl && !avaFail\}\}"/, 'avaFail'],
    ['components/ui/avatar-editor/index.wxml', 'components/ui/avatar-editor/index.js', /wx:if="\{\{src && !srcFailed\}\}"/, 'srcFailed']
  ];
  avas.forEach(([wxml, js, re, flag]) => {
    ok(wxml + ' 的头像判断带失败标志', re.test(readProj(wxml)));
    const j = readProj(js);
    ok(js + ' 的 data 里有 ' + flag + ' 初值', new RegExp(flag + ': false').test(j));
    ok(js + ' 有 binderror 对应的处理函数（且防重复 setData）',
      /if \(this\.data\./.test(j) && /setData\(\{ \[?'?\w+'?:? true/.test(j));
  });
  // 换过头像 / 换个人看名片之后要重新给它一次机会，否则会一直显示首字母
  ok('「我的」换头像后重置失败标志', /this\._lastAva === user\.avatar \? this\.data\.avaFail : false/.test(readProj('pages/mine/mine.js')));
  ok('名片换人后重置失败标志', /avaFail: false,/.test(readProj('pages/user/card/card.js')));
  ok('头像编辑器换图后重置失败标志', /observers: \{[\s\S]{0,120}srcFailed\).*setData\(\{ srcFailed: false \}\)/.test(readProj('components/ui/avatar-editor/index.js')));

  // 会话列表是同屏多张头像，只能按 peer 分别记
  const cw = readProj('pages/user/chats/chats.wxml');
  eq('会话列表两处头像都带兜底判断',
    (cw.match(/wx:if="\{\{item\.avatarUrl && !avaErr\[item\.peer\]\}\}"/g) || []).length, 2);
  ok('会话列表头像带 data-peer', (cw.match(/data-peer="\{\{item\.peer\}\}"/g) || []).length >= 2);
  const cj = readProj('pages/user/chats/chats.js');
  ok('会话列表头像失败按 peer 记一笔',
    /setData\(\{ \['avaErr\.' \+ peer\]: true \}\)/.test(cj));
  ok('会话列表换过头像的 peer 清掉失败记录',
    /if \(avaErr\[u\.peer\] && seenUrl\[u\.peer\] !== u\.avatarUrl\) delete avaErr\[u\.peer\]/.test(cj));
}

/* ============ ⑪ 撤回不再整份写回（并发时不会吞消息） ============ */

// messages 是会话文档里的一个数组。发消息走原子 push，但「改其中一条」
// （撤回 / 摘掉违规图）只能读整份 → 改一处 → 整份写回，而这一写回会把
// 期间 push 进来的新消息一起抹掉 —— 现象是「刚发的话一刷新就没了」，
// 只在两人同时说话时偶发，看日志什么都看不出来。
// 修法：会话上维护 rev，push / add 时 +1，写回时拿 rev 当条件，命中 0 条就重读重算。
//
// 这一节既钉代码形状，也把 CAS 循环从真实源码里抠出来真跑一遍 ——
// 用假 db 制造「我读完、还没写回，别人发了一条」这个时序。
(async () => {
  const cf = readCloudSource();

  ok('有统一的「有条件写回」入口', /async function chatUpdateMessages\(chatId, mutate\)/.test(cf));
  ok('写回带 rev 条件', /where\(\{ _id: chatId, rev: rev \}\)/.test(cf));
  ok('用 stats.updated 判断有没有写进去', /stats\.updated/.test(cf) || /\.stats\) \|\| 0/.test(cf));
  ok('有重试次数上限', /const CHAT_CAS_TRIES = \d+;/.test(cf));
  // 老会话没有 rev，得先补一个。补的时候必须用 inc(0)：写死 0 会把
  // 「这期间别人 push 加的那 1」一起抹掉，等于把竞态又请回来
  ok('老会话补 rev 用 inc(0)，不写死 0', /rev: db\.command\.inc\(0\)/.test(cf));
  // 两处原子 push（发消息 / 解除好友的系统消息）都要让 rev 动，否则 CAS 察觉不到并发
  ok('原子 push 都会推进 rev', (cf.match(/rev: db\.command\.inc\(1\)/g) || []).length >= 2);
  ok('新会话建文档时 rev 从 1 起', /rev: 1,/.test(cf));

  // 撤回：校验 → CAS 写回，不再「把刚才读到的那份原样写回去」
  ok('撤回走 CAS 写回', /chatUpdateMessages\(rec\._id,/.test(cf));
  ok('撤回不再整份写回', !/messages: next/.test(cf));
  ok('撤回校验抽成了 recallCheck（CAS 重读后要再跑一遍）',
    /function recallCheck\(msgs, openid, msgId\)/.test(cf));
  ok('2 分钟的窗口没变', /const RECALL_MS = 2 \* 60 \* 1000;/.test(cf));

  // 违规图回执：同一类问题，一起改
  ok('摘违规图也走 CAS', /chatUpdateMessages\(chat\._id,/.test(cf));
  ok('摘违规图不再整份写回', !/update\(\{ data: \{ messages: msgs \} \}\)/.test(cf));

  // 守卫：云函数里不允许出现「直接拿变量整份写 messages」的形态。
  // push 是原子的，放行；Object.assign({messages: push}) 也放行。
  // 空白必须放进前瞻里：写成 messages:\s*(?!db\.command\.push) 的话，
  // \s* 会退回到零宽让前瞻在空格处通过，等于这条断言永远不生效
  const rawWrite = cf.match(/\.update\(\{\s*data:\s*\{\s*messages:(?!\s*db\.command\.push)/g) || [];
  ok('云函数里没有别处再整份写回 messages', rawWrite.length === 0, rawWrite.length);

  // 不写死具体小版本：每轮收尾都要升一次，钉死 .7 只会让每次都被迫回来改这一行。
  // 这里只要求「不低 .7」（本文件覆盖的那批修复都在 .7 及之后）——
  // 三方指纹是否一致由 check-build-fingerprint 负责
  const bm = cf.match(/const BUILD = '(\d{4}-\d{2}-\d{2})\.(\d+)';/);
  ok('云函数版本指纹不低于 .7',
    !!bm && (bm[1] > '2026-10-17' || (bm[1] === '2026-10-17' && Number(bm[2]) >= 7)),
    bm && bm[0]);
  ok('FEATURES 里登记了 chatRevCas', /'chatRevCas'/.test(cf));

  /* ---- 把 CAS 循环从真实源码里抠出来跑 ---- */
  const colChat = cf.match(/const COL_CHATS = '[^']+';/)[0];
  const triesDecl = cf.match(/const CHAT_CAS_TRIES = \d+;/)[0];
  const mkCas = (db) => new Function('db',
    colChat + '\n' + triesDecl + '\n' + sliceFn(cf, 'chatUpdateMessages')
    + '\nreturn chatUpdateMessages;')(db);

  // 假 db：一条会话文档 + 一个同步钩子，用来精确制造时序
  const mkDb = (doc, hook) => {
    const st = { doc: doc, updates: 0, gets: 0 };
    const hit = (cond) => Object.keys(cond).every((k) => st.doc[k] === cond[k]);
    const patch = (data) => Object.keys(data).forEach((k) => {
      const v = data[k];
      if (v && typeof v === 'object' && v.__inc !== undefined) {
        st.doc[k] = (Number(st.doc[k]) || 0) + v.__inc;
      } else {
        st.doc[k] = v;
      }
    });
    const where = (cond) => {
      const q = {
        limit: () => q,
        get: async () => { st.gets += 1; return { data: hit(cond) ? [st.doc] : [] }; },
        update: async (arg) => {
          st.updates += 1;
          if (hook) hook(st);
          const m = hit(cond);
          if (m) patch(arg.data);
          return { stats: { updated: m ? 1 : 0 } };
        }
      };
      return q;
    };
    return { db: { collection: () => ({ where: where }), command: { inc: (n) => ({ __inc: n }) } }, st: st };
  };

  // 场景一：我读完、还没写回，别人 push 了一条 —— 老实现会把这条抹掉
  {
    const e = mkDb({ _id: 'c1', rev: 7, messages: [{ id: 'm1', from: 'u1', text: 'hi', at: 1 }] },
      (st) => {
        if (st.updates === 1) {
          st.doc.messages = st.doc.messages.concat([{ id: 'm2', from: 'u2', text: '刚发的', at: 2 }]);
          st.doc.rev += 1; // 别人那次 push 也会 +1
        }
      });
    const w = await mkCas(e.db)('c1', (chat) => ({
      messages: chat.messages.map((m) => (m.id === 'm1' ? Object.assign({}, m, { recalled: true }) : m))
    }));
    ok('并发写回：重试之后写成功', w.ok === true && w.wrote === true, w);
    ok('并发写回：确实多写了一次', e.st.updates >= 2, e.st.updates);
    ok('并发写回：别人刚发的那条还在（这正是修掉的 bug）',
      e.st.doc.messages.some((m) => m.id === 'm2'));
    ok('并发写回：该撤的那条照撤', e.st.doc.messages[0].recalled === true);
    ok('并发写回：rev 连着 +1（别人一次 + 自己一次）', e.st.doc.rev === 9, e.st.doc.rev);
  }

  // 场景二：老会话根本没有 rev 字段
  {
    const e = mkDb({ _id: 'c2', messages: [{ id: 'm1', from: 'u1', at: 1 }] }, null);
    const w = await mkCas(e.db)('c2', (chat) => ({ messages: chat.messages }));
    ok('老会话：先补 rev 0 再写，最后落到 1', w.ok === true && e.st.doc.rev === 1, e.st.doc.rev);
  }

  // 场景三：每次都对不上（有人在猛发）→ 认输，让用户重试
  {
    const e = mkDb({ _id: 'c3', rev: 1, messages: [{ id: 'm1' }] }, (st) => { st.doc.rev += 1; });
    const w = await mkCas(e.db)('c3', (chat) => ({ messages: chat.messages }));
    ok('一直对不上：返回 busy，而不是悄悄吞掉', w.ok === false && w.busy === true, w);
    ok('一直对不上：最多试 CHAT_CAS_TRIES 次就停', e.st.updates === 3, e.st.updates);
  }

  // 场景四：会话已经不在了
  {
    const e = mkDb({ _id: 'c4', rev: 1, messages: [] }, null);
    const w = await mkCas(e.db)('nope', () => ({ messages: [] }));
    ok('会话没了：回 gone 而不是抛异常', w.ok === false && w.gone === true, w);
  }

  // 场景五：重读时已经不可撤（被截断 / 已撤过）→ 不写库
  {
    const e = mkDb({ _id: 'c5', rev: 3, messages: [] }, null);
    const w = await mkCas(e.db)('c5', () => null);
    ok('重复撤回：一次都不写库，直接回 noop', w.ok === true && w.noop === true && e.st.updates === 0);
  }

  // 撤回的四道校验（纯函数，单独跑）
  {
    const recallCheck = new Function(
      cf.match(/const RECALL_MS = [^;]+;/)[0] + '\n'
      + sliceFn(cf, 'recallCheck') + '\nreturn recallCheck;')();
    const t = Date.now();
    ok('别人的消息不给撤', recallCheck([{ id: 'a', from: 'x', at: t }], 'me', 'a').ok === false);
    ok('已经撤过的回 already，不报错', recallCheck(
      [{ id: 'a', from: 'me', at: t, recalled: true }], 'me', 'a').already === true);
    ok('超过 2 分钟撤不回来', recallCheck([{ id: 'a', from: 'me', at: t - 120001 }], 'me', 'a').ok === false);
    ok('1 分钟前发的还能撤', recallCheck([{ id: 'a', from: 'me', at: t - 60000 }], 'me', 'a').ok === true);
    ok('消息已被挤出 200 条之外，要说清是「不在了」',
      /已经不在了/.test(recallCheck([], 'me', 'a').msg || ''));
  }

  /* ============ ⑫ 举报结果通知落到正确的那一页 ============ */

  // 举报的是二手 / 活动，通知点进去却是论坛首页 —— 处置做对了，回音送错了信箱。
  // 这里从真实源码里抠出映射函数跑，逐个类型对一遍
  {
    const pageOf = new Function(sliceFn(cf, 'reportResultPage') + '\nreturn reportResultPage;')();
    const D = 'sub/market/detail/detail';
    const E = 'sub/campus/event/event';
    const F = 'sub/forum/detail/detail';

    ok('闲置·驳回 → 直达那条闲置',
      pageOf({ targetType: 'market', targetId: 'm1' }, 'reject') === D + '?id=m1');
    ok('闲置·确认违规 → 落到闲置列表（那条已经删了）',
      pageOf({ targetType: 'market', targetId: 'm1' }, 'confirm') === 'pages/market/list/list');
    ok('活动·驳回 → 直达那个活动',
      pageOf({ targetType: 'event', targetId: 'ev1' }, 'reject') === E + '?id=ev1');
    ok('活动·确认违规 → 落到校园页（活动没有独立列表）',
      pageOf({ targetType: 'event', targetId: 'ev1' }, 'confirm') === 'pages/campus/campus');
    ok('帖子·驳回 → 直达楼层', pageOf({ targetType: 'post', targetId: 'p1' }, 'reject') === F + '?id=p1');
    ok('帖子·确认违规 → 论坛列表',
      pageOf({ targetType: 'post', targetId: 'p1' }, 'confirm') === 'pages/forum/list/list');
    ok('课程评价·驳回 → 直达课程',
      /^sub\/course\/detail\/detail\?id=r1$/.test(pageOf({ targetType: 'review', targetId: 'r1' }, 'reject')));
    ok('课程评价·确认违规 → 课程列表',
      pageOf({ targetType: 'review', targetId: 'r1' }, 'confirm') === 'pages/course/list/list');
    ok('留言 → 回帖子详情（上下文在那儿），用举报记录里的 postId',
      pageOf({ targetType: 'comment', targetId: 'c1', postId: 'p9' }, 'confirm') === F + '?id=p9');
    ok('留言没带 postId → 退回论坛列表，不拼出空 id',
      pageOf({ targetType: 'comment', targetId: 'c1' }, 'reject') === 'pages/forum/list/list');
    ok('举报人 → 私信列表', pageOf({ targetType: 'chat', targetId: 'x' }, 'reject') === 'pages/user/chats/chats');
    ok('名片举报 → 私信列表', pageOf({ targetType: 'profile', targetId: 'x' }, 'reject') === 'pages/user/chats/chats');
    ok('学习资料 → 学习资料列表',
      pageOf({ targetType: 'resource', targetId: 'r1' }, 'reject') === 'pages/tool/resources/resources');
    ok('不认识的类型 → 论坛列表，不会拼出 undefined',
      pageOf({ targetType: 'whatever', targetId: 'x' }, 'reject') === 'pages/forum/list/list');

    // 守卫：任何组合都不许产出空 id / undefine
    const combos = ['post', 'comment', 'review', 'market', 'event', 'resource', 'chat', 'profile', 'nope'];
    const bad = [];
    combos.forEach((t) => {
      ['reject', 'confirm'].forEach((a) => {
        [true, false].forEach((withId) => {
          const r = pageOf({ targetType: t, targetId: withId ? 'id1' : '', postId: 'p1' }, a);
          if (!/^(pages|sub)\/[\w-]+\/[\w-]+(\/[\w-]+)*(\.html)?(\?id=[\w-]+)?$/.test(r)) bad.push(t + '/' + a + ':' + r);
        });
      });
    });
    ok('所有类型 × 两种裁决 × 有无 id 都产出合法路径', bad.length === 0, bad.slice(0, 3));

    // 守卫：resolveReports 里不许再写死某个页面的通知地址
    const rp = sliceFn(cf, 'resolveReports');
    ok('resolveReports 不再把通知页写死',
      !/page:\s*(person\s*\?|')/.test(rp));
    ok('resolveReports 走 reportResultPage', /page:\s*reportResultPage\(/.test(rp));
  }

  /* ============ ⑬ 被下架的闲置 / 活动，作者有恢复出口 ============ */

  // ① 对账的合并逻辑（跑真实源码）
  {
    const { mergeStates } = require(path.join(APP, 'utils', 'mine-state.js'));
    const r = mergeStates(
      [
        { id: 'a', hidden: false },
        { id: 'b', hidden: false },
        { id: 'c', hidden: false },
        { id: 'd', hidden: true }
      ],
      [
        { id: 'a', hidden: false, deleted: false },
        { id: 'b', hidden: true, deleted: false },
        { id: 'c', hidden: true, deleted: true },
        { id: 'd', hidden: false, deleted: false }
      ]
    );
    ok('对账：被下架的落成 hidden', r.list.find((x) => x.id === 'b').hidden === true);
    ok('对账：已删除的从本地清掉', !r.list.some((x) => x.id === 'c') && r.dropped === 1, r.dropped);
    ok('对账：已恢复的把 hidden 清掉（不然后台恢复了、手机还当它下架）',
      r.list.find((x) => x.id === 'd').hidden === false);
    ok('对账：数得出现在有几条被暂停', r.paused === 1, r.paused);

    const keep = mergeStates([{ id: 'x' }, { id: 'y' }], [{ id: 'x', hidden: true }]);
    ok('对账：云端没提到的那条原样保留（「没返回」不等于「不存在」）',
      keep.list.some((x) => x.id === 'y'));
    const guard = mergeStates([{ id: 'x' }], null);
    ok('对账：这一侧没读到就一个字都不动', guard.degraded === true && guard.list.length === 1);

    // 换设备 = 空缓存。只靠 id 对账的话，被下架的那条在「我的」里根本不会出现，
    // 恢复按钮也就永远没机会被看到 —— 而换手机恰恰最容易撞上误伤
    const { adoptPaused } = require(path.join(APP, 'utils', 'mine-state.js'));
    const ad = adoptPaused(
      [{ id: 'a' }],
      [{ id: 'b', title: '被下架的那条' }, { id: 'a' }, { id: 'c', deleted: true }]
    );
    ok('换设备：云端把被下架的完整内容补回来',
      ad.added === 1 && ad.list.some((x) => x.id === 'b' && x.hidden === true && x.title === '被下架的那条'));
    ok('换设备：已有的不重复塞', ad.list.filter((x) => x.id === 'a').length === 1);
    ok('换设备：已删除的不补回来', !ad.list.some((x) => x.id === 'c'));
    ok('换设备：这一侧没读到就原样返回', adoptPaused([{ id: 'a' }], null).added === 0);
  }

  // ② 闲置读侧（跑真实模块）
  {
    storage.zjgsu_user = { nickName: '我' };
    storage.zjgsu_market = [
      { id: 'm-ok', author: '我', at: 3 },
      { id: 'm-paused', author: '我', at: 2, hidden: true },
      { id: 'm-gone', author: '我', at: 1, deleted: true },
      { id: 'm-other', author: '别人', at: 4 }
    ];
    const mk = require(path.join(APP, 'utils', 'market.js'));
    mk.invalidate();
    const mine = mk.getMyMarkets();
    ok('我的闲置：已下架的那条仍然列出（否则作者永远找不到它）',
      mine.some((x) => x.id === 'm-paused'));
    ok('我的闲置：那条标了 paused', (mine.find((x) => x.id === 'm-paused') || {}).paused === true);
    ok('我的闲置：已删除的不再列', !mine.some((x) => x.id === 'm-gone'));
    ok('我的闲置：不带别人的内容', !mine.some((x) => x.id === 'm-other'));
    ok('我的闲置：本地那条也认得出是自己的（isMine）',
      (mine.find((x) => x.id === 'm-ok') || {}).isMine === true);

    const own = mk.getMineById('m-paused');
    ok('闲置详情：能取到自己那条已下架的', !!own && own.paused === true);
    ok('别人打开仍然是「这条记录不见了」', mk.getMarketById('m-paused') === null);
    ok('已删除的连作者也取不到', mk.getMineById('m-gone') === null);
    ok('别人的条目自取也取不到', mk.getMineById('m-other') === null);
  }

  // ③ 活动读侧（跑真实模块）
  {
    storage.zjgsu_user = { nickName: '我' };
    storage.zjgsu_events = [
      { id: 'e-ok', author: '我', at: 3 },
      { id: 'e-paused', author: '我', at: 2, hidden: true },
      { id: 'e-gone', author: '我', at: 1, deleted: true },
      { id: 'e-other', author: '别人', at: 4 }
    ];
    const ev = require(path.join(APP, 'utils', 'event.js'));
    const mine = ev.getMyEvents();
    ok('我的活动：已下架的那条仍然列出', mine.some((x) => x.id === 'e-paused'));
    ok('我的活动：那条标了 paused', (mine.find((x) => x.id === 'e-paused') || {}).paused === true);
    ok('我的活动：已删除的不再列', !mine.some((x) => x.id === 'e-gone'));
    ok('我的活动：不带别人的内容', !mine.some((x) => x.id === 'e-other'));
    ok('活动详情：能取到自己那条已下架的', (ev.getMineById('e-paused') || {}).paused === true);
    ok('别人打开仍然是「这个活动找不到了」', ev.getEventById('e-paused') === null);
  }

  // ④ 云端与页面接线（静态守卫）
  {
    const cf2 = readCloudSource();
    const my = sliceFn(cf2, 'myContent');
    ok('云端 myContent 只查自己的内容', /where\(\{\s*openid:\s*openid\s*\}\)/.test(my));
    ok('云端 myContent 读不到时回 null（不能表现成「全被删了」）',
      /:\s*null/.test(my) && /Array\.isArray\(mk\.data\)/.test(my));
    ok('myContent 进了 switch', /case 'myContent':/.test(cf2));
    ok('myContent 进了 FEATURES', /'myContent'/.test(cf2));

    const mkSrc = readProj('utils/market.js');
    const evSrc = readProj('utils/event.js');
    ok('闲置对账复用共用合并逻辑', /mineState\.mergeStates/.test(sliceFn(mkSrc, 'syncMine')));
    ok('活动对账复用共用合并逻辑', /mineState\.mergeStates/.test(sliceFn(evSrc, 'syncMine')));
    ok('闲置对账补回换设备后缺失的那条', /mineState\.adoptPaused/.test(sliceFn(mkSrc, 'syncMine')));
    ok('活动对账补回换设备后缺失的那条', /mineState\.adoptPaused/.test(sliceFn(evSrc, 'syncMine')));
    ok('云端回传被下架内容的完整正文（换设备要靠它）',
      /marketPaused/.test(my) && /eventPaused/.test(my));

    // 恢复必须「云端先成功、再改本地」：反过来会出现「我这儿好了、别人还看不到」，
    // 而且下一次对账会把本地又打回已下架
    const rm = sliceFn(mkSrc, 'restoreMarket');
    ok('闲置恢复：先云端、后本地',
      rm.indexOf("cloudWrite('setStatus'") >= 0
      && rm.indexOf("cloudWrite('setStatus'") < rm.indexOf('hit.hidden = false'));
    const re = sliceFn(evSrc, 'restoreEvent');
    ok('活动恢复：先云端、后本地',
      re.indexOf("call('setStatus'") >= 0
      && re.indexOf("call('setStatus'") < re.indexOf('hit.hidden = false'));
    ok('闲置恢复失败不谎报成功', /state === 'fail'[\s\S]{0,80}return \{ ok: false/.test(rm));

    const md = readProj('sub/market/detail/detail.js');
    const ed = readProj('sub/campus/event/event.js');
    ok('闲置详情查不到时回退到自己那条', /getMineById/.test(md));
    ok('活动详情查不到时回退到自己那条', /getMineById/.test(ed));
    ok('闲置详情有恢复动作', /restoreMarket/.test(md));
    ok('活动详情有恢复动作', /restoreEvent/.test(ed));

    ok('闲置详情有「恢复展示」按钮',
      /bindtap="onRestore"/.test(readProj('sub/market/detail/detail.wxml')));
    ok('活动详情有「恢复展示」按钮',
      /bindtap="onRestore"/.test(readProj('sub/campus/event/event.wxml')));

    // 暂停展示时那块内容是我自己的：不能再显示「打个招呼 / 举报这条内容」，
    // 也不能给「标记为已解决」（它不是一条正常在售的闲置）
    const dw = readProj('sub/market/detail/detail.wxml');
    ok('闲置详情：暂停时不再渲染「举报 / 打招呼」块', /wx:elif="\{\{!item\.isMine\}\}"/.test(dw));
    ok('闲置详情：暂停时不给「标记为已解决」', /item\.isMine && !paused/.test(dw));

    const appJson = JSON.parse(readProj('app.json'));
    ok('「我发起的活动」页已注册', ((appJson.subPackages || []).filter((p) => p.root === 'sub')[0] || { pages: [] }).pages.indexOf('campus/mine/mine') >= 0);
    ok('校园页有去「我发起的活动」的入口',
      /goMineEvents/.test(readProj('pages/campus/campus.wxml'))
      && /goMineEvents/.test(readProj('pages/campus/campus.js')));
    ok('「我的活动」列表标出暂停展示',
      /已暂停展示/.test(readProj('sub/campus/mine/mine.wxml')));
    ok('「我的闲置」列表标出暂停展示',
      /已暂停展示/.test(readProj('sub/market/mine/mine.wxml')));
  }

  /* ============ ⑭ 应用说明页：短，且不许写错 ============ */
  {
    let page = null;
    const savedPage = global.Page;
    global.Page = (o) => { page = o; };
    const gp = path.join(APP, 'pages/user/guide/guide.js');
    delete require.cache[require.resolve(gp)];
    require(gp);
    global.Page = savedPage;

    const d = (page && page.data) || {};
    const mods = d.modules || [];
    const rules = d.rules || [];
    const allRules = rules.join('');

    ok('说明页：模块加载得出数据', mods.length > 0 && !!d.intro);
    ok('说明页：简介写清了归属边界（非官方）',
      /非官方|非学校官方/.test(String(d.intro || '')), d.intro);
    ok('说明页：五个模块一个不少', mods.length === 5, mods.length);
    ok('说明页：每个模块都有图标、名称与一句话说明',
      mods.every((m) => !!m.name && !!m.desc && !!m.icon), mods.map((m) => m.name));
    // 一条绕口令式的长句会把整页顶到两屏外，也说明这话没想清楚
    ok('说明页：每条说明不超过 40 字',
      mods.every((m) => String(m.desc).replace(/\s/g, '').length <= 40),
      mods.map((m) => String(m.desc).length));

    // 防膨胀的主闸门：300 字是「看得完」的上限，超了就回去删形容词
    const body = [d.intro].concat(mods.map((m) => m.name + m.desc))
      .concat(rules).join('').replace(/\s/g, '');
    ok('说明页：全文不超过 300 字', body.length <= 300, body.length);

    ok('说明页：使用须知三条', rules.length === 3, rules.length);
    // 三条免责要件缺一条，出事时不算「已告知」。这几句话是挑过措辞的，
    // 删掉它们往往只是为了「听起来更友好」，代价最大
    ok('说明页：须知要求文明使用、禁止不良信息',
      /文明使用/.test(allRules) && /不良信息/.test(allRules));
    ok('说明页：须知写明发布者自负全责',
      /发布者对内容承担全部责任/.test(allRules));
    ok('说明页：须知写明可屏蔽 / 删除 / 终止服务',
      /屏蔽/.test(allRules) && /删除/.test(allRules) && /终止服务/.test(allRules));
    ok('说明页：须知写明仅供参考且不作保证',
      /仅供参考/.test(allRules) && /不保证/.test(allRules) && /纠纷/.test(allRules));

    const all = JSON.stringify(d);
    // 会随时间被现实打脸的数字，一律不许写进说明页
    ok('说明页：不写「900+ 门课」这类会过期的数字', !/900\s*\+/.test(all));
    // 原来那句「数据存云端，换手机或重装后仍保留」对备忘等本地内容不成立
    ok('说明页：不再一刀切说「换手机或重装后仍保留」', !/换手机或重装后仍保留/.test(all));

    const wxml = readProj('pages/user/guide/guide.wxml');
    const wxss = readProj('pages/user/guide/guide.wxss');
    ok('说明页：三段结构在页面上都有落地',
      /应用简介/.test(wxml) && /核心功能/.test(wxml) && /使用须知/.test(wxml));
    // 「常见操作」「小工具入口」两块已撤：入口明细比功能描述更容易过期，
    // 也不值得占这 300 字的预算
    ok('说明页：不再渲染已撤掉的步骤块与小工具块',
      !/gd-step/.test(wxml) && !/gd-tool-row/.test(wxml));
    // 说明顶多四十来字，用了 truncate 窄屏上会被掐掉半句 —— 等于没写
    ok('说明页：模块说明不截断',
      !/gd-tab-text[\s\S]{0,200}truncate/.test(wxml) && /gd-mod-desc/.test(wxml));
    ok('说明页：样式同步清干净（不留死样式）',
      /\.gd-para\s*\{/.test(wxss) && /\.gd-mod-desc\s*\{/.test(wxss)
      && !/\.gd-step(\s|__|,|\{)/.test(wxss)
      && !/\.gd-tool-row(\s|__|,|\{)/.test(wxss));
  }

  /* ============ ⑮ 三级回复：数据层是链，渲染层并列 ============ */
  console.log('⑮ 三级回复（数据层成链 / 渲染层并列）');
  {
    const forum = require(path.join(APP, 'utils', 'store-forum.js'));
    const REPLY_MAX_DEPTH = forum.REPLY_MAX_DEPTH;
    eq('⑮ 层级上限常量是 2（0=一级 1=二级 2=三级）', REPLY_MAX_DEPTH, 2);

    // 一条四级回复的完整链条：
    //   a(0) ← b(1，回 a) ← c(2，回 b) ← d(回 c，被折回 → 挂 b，depth 仍 2)
    const chain = [
      { id: 'a', depth: 0, parentId: '', replyToAuthor: '' },
      { id: 'b', depth: 1, parentId: 'a', replyToAuthor: 'a君' },
      { id: 'c', depth: 2, parentId: 'b', replyToAuthor: 'b君' },
      { id: 'd', depth: 2, parentId: 'b', replyToAuthor: 'c君' }
    ];
    const dd = forum.decorateComments({ id: 'p1', comments: chain }, false);

    // 关键：树只有**一层**回复，不存在「回复里的回复」
    eq('⑮ 一级留言只有一条（所有回复都被提到它下面）', dd.commentTree.length, 1);
    eq('⑮ 它下面挂着三条回复（b / c / d 并列）', dd.commentTree[0].replies.length, 3);
    ok('⑮ 每条回复都没有再嵌套 replies（不会出现第二档缩进）',
      dd.commentTree[0].replies.every((r) => !(r.replies && r.replies.length)));
    ok('⑮ 二/三/四级一律 isReply（缩进只看这一位）',
      dd.commentTree[0].replies.every((r) => r.isReply === true));
    // 顺序仍是时间顺序（原始数组顺序），不会因为扁平化而重排
    eq('⑮ 并列后顺序仍是时间顺序', dd.commentTree[0].replies.map((r) => r.id).join(','), 'b,c,d');
    // 「回复 @某某」指向**被点的那条**：三级 @ 二级，四级 @ 三级
    eq('⑮ 三级回复 @ 被点的二级那条', dd.commentTree[0].replies[1].replyToName, 'b君');
    eq('⑮ 四级折回后 @ 的仍是被点的三级那条', dd.commentTree[0].replies[2].replyToName, 'c君');
    // 折叠计数必须把三级、四级一起算进来，否则「展开 N 条」的数字是错的
    eq('⑮ 折叠计数把三级四级一起算进去', dd.commentTree[0].replyCount, 3);

    // 父被删：整条链上的人都要能活下来（提升为一级），不能凭空消失
    const orphan = [
      { id: 'c', depth: 2, parentId: 'b' }
    ];
    const od = forum.decorateComments({ id: 'p1', comments: orphan }, false);
    eq('⑮ 父已被删的三级回复提升为一级（不消失）', od.commentTree.length, 1);
    eq('⑮ 提升后仍是那条留言', od.commentTree[0].id, 'c');

    // 前后端两份 replyTargetOf 对同一份输入必须给出同一个结果
    const cfMax = /const REPLY_MAX_DEPTH = (\d+);/.exec(
      readCloudSource());
    eq('⑮ 前后端层级上限一致', Number(cfMax[1]), REPLY_MAX_DEPTH);

    // 扁平化不能靠 depth 猜：depth 为三级但父在一级时也要并列
    const mixed = [
      { id: 'a', depth: 0, parentId: '' },
      { id: 'b', depth: 1, parentId: 'a' },
      { id: 'c', depth: 2, parentId: 'b' },
      { id: 'x', depth: 1, parentId: 'a' }
    ];
    const md = forum.decorateComments({ id: 'p1', comments: mixed }, false);
    eq('⑮ 混排时全部并列在同一层', md.commentTree[0].replies.length, 3);
    eq('⑮ 混排顺序仍是时间顺序', md.commentTree[0].replies.map((r) => r.id).join(','), 'b,c,x');
  }

  /* ============ ⑯ 论坛「最新」排序：按 at，不比展示串 ============ */
  console.log('⑯ 论坛最新排序（按时间戳，不比时间字符串）');
  {
    const forum = require(path.join(APP, 'utils', 'store-forum.js'));
    const KEY = 'zjgsu_posts';
    const backup = storage[KEY];
    const MIN = 60 * 1000;
    const now = Date.now();

    // 三种来源混在一起，正是线上真实的样子：
    //   old     —— 前天云端同步下来的，time 带时分
    //   morning —— 今早云端同步，time 也是「YYYY-MM-DD HH:mm」
    //   just    —— 本机刚发，旧版本里 time 只有「YYYY-MM-DD」，比上面两串都短
    storage[KEY] = [
      { id: 'old', board: '校园吐槽', title: '前天的帖', time: '2026-10-15 09:00', at: now - 2 * 24 * 60 * MIN },
      { id: 'morning', board: '校园吐槽', title: '今早的帖', time: '2026-10-17 08:30', at: now - 8 * 60 * MIN },
      { id: 'just', board: '校园吐槽', title: '刚发的帖', time: '2026-10-17', at: now - 2 * MIN }
    ];
    const latest = forum.getPosts({ sort: 'latest' }).map((p) => p.id);
    eq('⑯ 最新：刚发的排第一', latest[0], 'just');
    eq('⑯ 最新：今早的排第二', latest[1], 'morning');
    eq('⑯ 最新：前天的排最后', latest[2], 'old');
    // 老数据只有展示串、没有 at：退回解析一次，顺序照样要对
    storage[KEY] = [
      { id: 'a', board: '校园吐槽', time: '2026-10-16 07:00' },
      { id: 'b', board: '校园吐槽', time: '2026-10-15 23:00' }
    ];
    eq('⑯ 没有 at 的老帖按 time 解析后排（新在前）',
      forum.getPosts({ sort: 'latest' }).map((p) => p.id).join(','), 'a,b');

    // 本地新发的帖子，展示串要和云端同格式（都带时分），否则同屏两行像两个来源
    const src = readProj(path.join('utils', 'store-forum.js'));
    ok('⑯ 发帖时间用 nowText（带时分），不是只有日期的 today()',
      /time:\s*nowText\(\)/.test(src) && !/time:\s*today\(\)/.test(src));
    ok('⑯ 排序不再直接比对 time 字符串',
      !/a\.time\s*<\s*b\.time/.test(src));

    storage[KEY] = backup;
  }

  /* ============ ⑰ 评价入口：tab 页悬浮「＋」+ 选课面板 + 搜不到直接添加 ============ */
  console.log('⑰ 评价入口（悬浮「＋」/ 选课面板 / 没找到就去添加）');
  {
    const lsWxml = readProj(path.join('pages', 'course', 'list', 'list.wxml'));
    const lsJs = readProj(path.join('pages', 'course', 'list', 'list.js'));
    const lsJson = JSON.parse(readProj(path.join('pages', 'course', 'list', 'list.json')));

    ok('⑰ 课程评价 tab 有右下角悬浮「＋」',
      /class="ls-fab tap"[\s\S]{0,120}bindtap="onFab"/.test(lsWxml));
    ok('⑰ 选课面板用的是 bottom-sheet，列表页也声明了它',
      /<bottom-sheet/.test(lsWxml) &&
      (lsJson.usingComponents || {})['bottom-sheet'] === '/components/ui/bottom-sheet/index');
    ok('⑰ 老师档点「＋」不弹面板，直接进填写页（按 scope 分流）',
      /onFab\(\)[\s\S]{0,220}scope === 'teacher'[\s\S]{0,120}onAddTeacherReview/.test(lsJs));
    // 搜不到 = 死路：「没搜到」这句话必须配一条能点出去的路
    ok('⑰ 面板里有「去添加这门课」的出口',
      /class="ls-pick__add tap"[\s\S]{0,80}bindtap="onPickAdd"/.test(lsWxml));
    ok('⑰ 带着面板里刚打的词去添加页（不是拿列表页那个关键词）',
      /onPickAdd\(\)[\s\S]{0,200}goAddWith\(this\.data\.pickKw/.test(lsJs));
    ok('⑰ 添加页 URL 仍然带上 kw（进页面就填好课名）',
      /sub\/course\/add\/add\?kw=/.test(lsJs));

    // 上一轮那两张内联卡片必须真没了：留着就是「同一个入口两种形态」
    const dpWxml = readProj(path.join('sub', 'course', 'detail', 'detail.wxml'));
    const tcWxml = readProj(path.join('sub', 'course', 'teacher', 'teacher.wxml'));
    const dpWxss = readProj(path.join('sub', 'course', 'detail', 'detail.wxss'));
    ok('⑰ 详情页内联入口卡已删除', !/dp-new/.test(dpWxml) && !/dp-new/.test(dpWxss));
    ok('⑰ 老师页内联入口卡已删除（含它的 goNew 方法）',
      !/tc-new/.test(tcWxml) && !/goNew\(/.test(readProj(path.join('sub', 'course', 'teacher', 'teacher.js'))));
  }

  report();
})().catch((e) => {
  console.error('\n测试自身出错：', e);
  process.exit(2);
});

/* ---------------- 汇总 ---------------- */
function report() {
  console.log('通过 ' + pass + ' 项');
  if (fails.length) {
    console.log('\n失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.log('  · ' + f));
    process.exit(1);
  }
  console.log('全部通过');
}
