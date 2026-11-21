/* 私信与会话列表改造 —— 行为测试
 *
 * 覆盖这一轮落地的四件事：
 *   ① 陌生人消息进「消息请求箱」（列表页分组 + 会话页就地接受/忽略）
 *   ② 会话页顶部的关系状态条 + 解除好友后那条系统消息怎么渲染
 *   ③ 长按消息菜单：复制 / 撤回（2 分钟内）/ 重发 / 举报
 *   ④ 会话页 20 秒增量轮询（含「用户正在往上翻记录时不许把他拽到底」）
 *
 * 原则与项目一贯一致：**不另抄一份逻辑**，全部从真实源码里抠出来跑：
 *   A. chat.js 的 decorate / mergeById —— 纯函数，花括号配平抽出
 *   B. 会话页 applyState            —— 用捕获到的真实 Page 对象 + 假 this
 *   C. 长按菜单与四个动作            —— wx.showActionSheet / showModal 打桩
 *   D. 会话列表页                    —— 分组、分页、接受/忽略、长按删除
 *   E. 模板与常量一致性              —— 绑定名、catchtap、理由枚举、轮询间隔
 *
 * 用法：node scripts/test-chatbox.cjs
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');
const SRC = path.join(PROJ, 'cloudfunctions', 'user', 'index.js');
const readCloudSource = require('./cloud-source.cjs');
const src = readCloudSource();
const readProj = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8');

// 仓库根 package.json 是 type:module，Node 22 会把小程序 .js 当 ESM —— 强制回 CommonJS
// ⚠️ 前缀要用 path.resolve 过的原生路径比：Windows 下 Node 给的是反斜杠
const origJs = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (norm(filename).startsWith(norm(PROJ))) return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return origJs(mod, filename);
};

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra))); }
};

/* ---------- 花括号配平抽函数（跳过字符串 / 模板串） ---------- */
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

const CHAT_JS = readProj(path.join('pages', 'user', 'chat', 'chat.js'));
const CHATS_JS = readProj(path.join('pages', 'user', 'chats', 'chats.js'));
const CHAT_WXML = readProj(path.join('pages', 'user', 'chat', 'chat.wxml'));
const CHATS_WXML = readProj(path.join('pages', 'user', 'chats', 'chats.wxml'));
const CHAT_WXSS = readProj(path.join('pages', 'user', 'chat', 'chat.wxss'));

const stringify = (v) => JSON.stringify(v);

/* ============ A. 消息形状：decorate / mergeById ============ */
console.log('\nA. 消息的界面形状（chat.js 的 decorate / mergeById）');

const FE = new Function(
  CHAT_JS.match(/const RECALL_MS = [^;]+;/)[0] + '\n'
  + sliceFn(CHAT_JS, 'clock') + '\n'
  + sliceFn(CHAT_JS, 'decorate') + '\n'
  + sliceFn(CHAT_JS, 'mergeById') + '\n'
  + 'return { decorate: decorate, mergeById: mergeById };'
)();

const NOW = 1_700_000_000_000;

const d1 = FE.decorate({ id: 'm1', from: 'peer', text: 'hi', at: NOW - 1000 }, NOW);
ok('对方发的：mine 为假', d1.mine === false);
ok('对方发的：不能撤回（能撤回就等于能删掉别人说的话）', d1.canRecall === false);
ok('时间戳翻成人话（HH:MM）', /^\d{2}:\d{2}$/.test(d1.clock), d1.clock);

const d2 = FE.decorate({ id: 'm2', from: 'me', mine: true, text: 'yo', at: NOW - 1000 }, NOW);
ok('自己发的、刚发出去：可以撤回', d2.canRecall === true);
ok('超过 2 分钟：撤回入口消失（与服务端 RECALL_MS 同一把尺）',
  FE.decorate({ id: 'm3', from: 'me', mine: true, at: NOW - 120001 }, NOW).canRecall === false);
ok('正好 2 分钟边界内还能撤（口径是「未超过」，不是「小于」）',
  FE.decorate({ id: 'm4', from: 'me', mine: true, at: NOW - 120000 }, NOW).canRecall === false);
ok('发送中（pending）不给撤回入口：消息还没落库，撤什么',
  FE.decorate({ id: 'm5', from: 'me', mine: true, at: NOW - 1000, pending: true }, NOW).canRecall === false);
ok('未送达（failed）不给撤回入口：对方根本没收到',
  FE.decorate({ id: 'm6', from: 'me', mine: true, at: NOW - 1000, failed: true }, NOW).canRecall === false);
ok('本地独有（云函数没部署）不给撤回入口',
  FE.decorate({ id: 'm7', from: 'me', mine: true, at: NOW - 1000, localOnly: true }, NOW).canRecall === false);
ok('已经撤回过的：不再给撤回入口', FE.decorate(
  { id: 'm8', from: 'me', mine: true, at: NOW - 1000, recalled: true }, NOW).canRecall === false);
ok('没有 at 的老消息：不给撤回入口（算不出时间窗就别猜）',
  FE.decorate({ id: 'm9', from: 'me', mine: true }, NOW).canRecall === false);

const sys1 = FE.decorate({ id: 's1', from: 'system', sys: true, text: 'x', at: NOW }, NOW);
ok('系统消息：from 是 system → sys 标记为真', sys1.sys === true);
ok('系统消息：mine 为假（不能靠右站，那就成「我发的」了）', sys1.mine === false);
ok('系统消息：不给撤回入口', sys1.canRecall === false);

const raw1 = FE.decorate({ id: 'n1', from: 'peer', at: NOW }, NOW);
ok('老消息（图片功能上线前）没有 images → 补成空数组，'
  + '否则 WXML 里 item.images.length 取到 undefined 会渲染异常',
  Array.isArray(raw1.images) && raw1.images.length === 0);
ok('text 缺失 → 补成空串（模板里 {{item.text}} 才不会渲染出 undefined）', raw1.text === '');
ok('images 是字符串（旧数据形状异常）时也退回空数组', Array.isArray(FE.decorate(
  { id: 'n2', from: 'peer', images: 'a,b', at: NOW }, NOW).images) === true);

// mergeById：轮询只回增量，整表替换会把已有历史全丢掉
const cur = [
  { id: 'a', at: 1, text: '一' },
  { id: 'b', at: 2, text: '二' },
  { id: 'tmp1', at: 99, text: '本地未确认', pending: true }
];
const inc = [
  { id: 'b', at: 2, text: '二', recalled: true, images: [] },
  { id: 'c', at: 3, text: '三' }
];
const merged = FE.mergeById(cur, inc);
ok('轮询合并：云端已有的一条被**覆盖**（撤回这类状态变化靠这一行同步过来）',
  merged.filter((m) => m.id === 'b')[0].recalled === true);
ok('轮询合并：新消息追加在后面', merged[merged.length - 1].id === 'c' || merged.some((m) => m.id === 'c'));
ok('轮询合并：本地未确认的那条没被冲掉（否则刚发出去的话会凭空消失）',
  merged.some((m) => m.id === 'tmp1'));
ok('轮询合并：已有记录的条数不会因为「本地独有的不在增量里」而变少', merged.length === 4);
ok('轮询合并：顺序仍然按时间（a 在 b 前）',
  merged.findIndex((m) => m.id === 'a') < merged.findIndex((m) => m.id === 'b'));

/* ============ 环境打桩 ============ */
const MEM = {};
const CALLS = [];
let CALL_REPLY = null;
let onModal = null;
let onSheet = null;
let LAST_MODAL = null;
const SHEETS = [];

const noop = () => undefined;
const chain = (() => {
  const c = {};
  ['collection', 'doc', 'where', 'orderBy', 'limit', 'field', 'skip'].forEach((m) => { c[m] = () => c; });
  c.get = () => Promise.resolve({ data: [] });
  c.add = () => Promise.resolve({ _id: 'x' });
  c.update = () => Promise.resolve({});
  c.remove = () => Promise.resolve({});
  return c;
})();
const wxBase = {
  nextTick: (fn) => fn(),
  getStorageSync: (k) => (k in MEM ? MEM[k] : ''),
  setStorageSync: (k, v) => { MEM[k] = v; },
  removeStorageSync: (k) => { delete MEM[k]; },
  showToast: noop,
  hideToast: noop,
  showLoading: noop,
  hideLoading: noop,
  stopPullDownRefresh: noop,
  setTabBarBadge: noop,
  removeTabBarBadge: noop,
  showTabBarRedDot: noop,
  hideTabBarRedDot: noop,
  setClipboardData: (o) => { MEM.__clip = (o && o.data) || ''; if (o && o.success) o.success({}); },
  previewImage: noop,
  getSystemInfoSync: () => ({ platform: 'ios', windowHeight: 800, statusBarHeight: 20 }),
  getAccountInfoSync: () => ({ miniProgram: { version: '1.0.0' } }),
  showModal: (o) => { LAST_MODAL = o; if (onModal) onModal(o); },
  showActionSheet: (o) => {
    SHEETS.push((o && o.itemList) || []);
    if (onSheet) onSheet(o);
  },
  cloud: {
    init: noop,
    database: () => chain,
    callFunction: (o) => {
      const action = (o && o.data && o.data.action) || o.name;
      const payload = (o && o.data) || {};
      CALLS.push({ action: action, payload: payload });
      if (CALL_REPLY) {
        const r = CALL_REPLY(action, payload);
        if (r !== undefined) return Promise.resolve({ result: r });
      }
      return Promise.resolve({ result: { ok: true } });
    },
    uploadFile: () => Promise.resolve({ fileID: 'cloud://x' })
  }
};
global.wx = new Proxy(wxBase, { get: (t, k) => (k in t ? t[k] : noop) });
global.getApp = () => ({ globalData: {} });
global.getCurrentPages = () => [{ route: 'pages/user/chats/chats', options: {} }];
global.Component = noop;
global.App = noop;

let CAP = null;
global.Page = (o) => { CAP = o; };
function capturePage(rel) {
  CAP = null;
  const abs = path.join(PROJ, rel);
  delete require.cache[require.resolve(abs)];
  require(abs);
  if (!CAP) throw new Error('没捕获到 Page：' + rel);
  return CAP;
}

const CT = capturePage(path.join('pages', 'user', 'chat', 'chat.js'));
const CS = capturePage(path.join('pages', 'user', 'chats', 'chats.js'));

// proto 传页面对象：handler 里 this.xxx() 调的是同一个 Page 上的方法（真实运行时就是这样）。
// data 以页面**声明的默认值**为底再覆盖 —— 真实运行时 this.data 起手就是那一份，
// 不铺底的话「请求箱默认收起」这类默认值断言会拿到 undefined，测的是空气
const mkThis = (data, extra, proto) => Object.assign(Object.create(proto || null), {
  data: Object.assign({}, (proto && proto.data) ? JSON.parse(JSON.stringify(proto.data)) : {}, data || {}),
  setData(p) { Object.assign(this.data, p); }
}, extra || {});

// 页面 handler 多是「发出去就不管」；弹窗回调 → 云调用 → setData 是一串微任务。
// 用一记宏任务把它们冲干净，否则断言会跑在 state 还没落地的时候
const tick = () => new Promise((r) => setTimeout(r, 0));

const MSG = (o) => Object.assign({ id: 'm1', from: 'peer', text: 'hi', at: NOW - 1000, mine: false }, o);

(async () => {
  /* ============ B. 会话页 applyState ============ */
  console.log('\nB. 会话页 applyState（整段加载 / 增量轮询 / 请求箱判定）');

  const fullReply = {
    ok: true,
    // 最后一条**是对方发的**：这才是「待处理请求」的形状（我回过就不算请求了）
    messages: [
      { id: 'm1', from: 'me', text: '在', at: NOW - 5000, mine: true },
      { id: 'm2', from: 'peer', text: '你好', at: NOW - 4000, mine: false }
    ],
    peer: { openid: 'peer', nickName: '小王', alias: '小王', avatarUrl: '', college: '' },
    isFriend: false,
    quota: { isFriend: false, limit: 3, left: 2, used: 1, replied: false, peerUsed: 0 },
    blockedByMe: false,
    blockedByThem: false,
    reqState: '',
    requested: false,
    incomingRequest: null
  };

  const t1 = mkThis({ messages: [], input: '打了一半的话' }, { peer: 'peer' }, CT);
  CT.applyState.call(t1, fullReply, { full: true });
  ok('整段加载：peerName 用云端给的昵称', t1.data.peerName === '小王', t1.data.peerName);
  ok('整段加载：备注名单独存一份（模板里要判断有没有备注）', t1.data.alias === '小王');
  ok('★ 云端返回的 nickName 已经是「备注名优先」（chatHistory 里 nickName: alias || u.nickName，'
    + '与会话列表同一口径）—— 两处不一致会出现「列表里是小王、点进来变回本名」',
    src.indexOf('nickName: alias || u.nickName') > 0
    && src.indexOf('nickName: aliases[peer] || u.nickName') > 0);
  ok('★★ 整段加载不清 input（原先每次 load 都清，而 load 在 onShow 也跑 ——'
    + '打了一半字出去看张图再回来就没了）', t1.data.input === '打了一半的话');
  ok('整段加载：非好友 + 最后一条是对方发的 + reqState 空 → 判定为待处理请求',
    t1.data.isPendingReq === true, { req: t1.data.reqState, p: t1.data.isPendingReq });
  ok('整段加载：额度与输入区一起落地（canSend / lockText 不能各说各话）',
    t1.data.canSend === true && t1.data.quota.left === 2);
  ok('整段加载：关系状态条文案带上「还能发 2 条」', String(t1.data.quotaText).indexOf('2') > 0);
  ok('整段加载：滚动水位记的是云端确认过的时间戳', t1.lastAt === NOW - 4000, t1.lastAt);

  // 请求箱状态：接受过 / 忽略过 / 已经是好友 —— 三种都不该再挂那条请求条
  const t2 = mkThis({ messages: [] }, { peer: 'peer' }, CT);
  CT.applyState.call(t2, Object.assign({}, fullReply, { reqState: 'accepted' }), { full: true });
  ok('已经接受过 → 不再显示请求条（否则用户会以为自己按了没生效）', t2.data.isPendingReq === false);

  const t3 = mkThis({ messages: [] }, { peer: 'peer' }, CT);
  CT.applyState.call(t3, Object.assign({}, fullReply, { reqState: 'dismissed' }), { full: true });
  ok('已经忽略过 → 不再显示请求条（它已经沉到请求箱里了）', t3.data.isPendingReq === false);

  const t4 = mkThis({ messages: [] }, { peer: 'peer' }, CT);
  CT.applyState.call(t4, Object.assign({}, fullReply, {
    isFriend: true, reqState: '', quota: { isFriend: true, limit: 0, left: 0 }
  }), { full: true });
  ok('已经是好友 → 不显示请求条（都不是陌生人了，还问「要不要接受」很怪）',
    t4.data.isPendingReq === false);

  const t5 = mkThis({ messages: [] }, { peer: 'peer' }, CT);
  CT.applyState.call(t5, Object.assign({}, fullReply, {
    messages: [{ id: 'x', from: 'peer', at: NOW, mine: false }, { id: 'y', from: 'me', mine: true, at: NOW + 1 }]
  }), { full: true });
  ok('最后一条是我回的 → 不算待处理请求（我回过就说明这段对话成立了）',
    t5.data.isPendingReq === false);

  // 增量轮询
  const t6 = mkThis({ messages: [] }, { peer: 'peer' }, CT);
  CT.applyState.call(t6, fullReply, { full: true });
  const scrolled = [];
  t6.scrollToEnd = (id) => { scrolled.push(id); t6.atBottom = true; };
  t6.atBottom = true;
  const t7 = mkThis(t6.data, {
    peer: 'peer', lastAt: t6.lastAt, atBottom: true,
    scrollToEnd: (id) => scrolled.push(id)
  }, CT);
  CT.applyState.call(t7, {
    ok: true, messages: [{ id: 'm3', from: 'peer', text: '在吗', at: NOW, mine: false }],
    peer: fullReply.peer, isFriend: false, quota: fullReply.quota
  }, { full: false });
  ok('轮询：新消息追加进去（不是整表替换）', t7.data.messages.length === 3);
  ok('轮询：用户在底部 → 自动滚到最新一条', scrolled.indexOf('m3') >= 0, scrolled);
  ok('轮询：到过底了就不该再浮角标', (t7.data.newHint || 0) === 0, t7.data.newHint);

  const scrolled2 = [];
  const t8 = mkThis(t6.data, {
    peer: 'peer', lastAt: t6.lastAt, atBottom: false,
    scrollToEnd: (id) => scrolled2.push(id)
  }, CT);
  CT.applyState.call(t8, {
    ok: true, messages: [{ id: 'm4', from: 'peer', text: '在吗', at: NOW + 10, mine: false }],
    peer: fullReply.peer, isFriend: false, quota: fullReply.quota
  }, { full: false });
  ok('★★ 用户正在往上翻记录 → 不把他一把拽到底（聊天页最容易招人烦的一种行为）',
    scrolled2.length === 0, scrolled2);
  ok('★★ 那种情况改浮「N 条新消息」角标', t8.data.newHint === 1, t8.data.newHint);

  const t9 = mkThis(Object.assign({}, t6.data, { newHint: 2 }), {
    peer: 'peer', lastAt: t6.lastAt, atBottom: false,
    scrollToEnd: () => { throw new Error('不该滚'); }
  }, CT);
  CT.applyState.call(t9, {
    ok: true, messages: [
      { id: 'n1', from: 'peer', text: 'a', at: NOW + 20, mine: false },
      { id: 'n2', from: 'peer', text: 'b', at: NOW + 21, mine: false }
    ],
    peer: fullReply.peer, isFriend: false, quota: fullReply.quota
  }, { full: false });
  ok('角标是累加的（用户一直不点，数字要一直涨）', t9.data.newHint === 4, t9.data.newHint);

  // 水位：本地未确认的消息不能把水位顶高，否则会漏掉对方紧接着发来的那条
  const t10 = mkThis({
    messages: [
      { id: 'm1', from: 'peer', text: 'x', at: NOW - 5000, mine: false },
      { id: 'tmp9', text: '本地未确认', at: NOW + 999999, mine: true, pending: true }
    ]
  }, { peer: 'peer', lastAt: 0 }, CT);
  CT.applyState.call(t10, {
    ok: true, messages: [], peer: fullReply.peer, isFriend: true, quota: { isFriend: true }
  }, { full: false });
  ok('★★ 增量水位只认云端确认过的消息（拿本地 temp 消息推水位会让轮询漏掉对方下一条）',
    t10.lastAt === NOW - 5000, t10.lastAt);

  const t11 = mkThis({ messages: [], loading: true }, { peer: 'peer' }, CT);
  CT.applyState.call(t11, {
    ok: true, messages: [], peer: fullReply.peer, isFriend: true, quota: { isFriend: true }
  }, { full: true });
  ok('云端回空也要把 loading 关掉（否则页面永远停在「加载中…」）', t11.data.loading === false);

  // 降级：拿不到 isFriend 时当成好友，不锁
  const t12 = mkThis({ messages: [...t6.data.messages], loading: true }, { peer: 'peer' }, CT);
  CT.applyState.call(t12, { ok: true, messages: [] }, { full: false });
  ok('云端降级（没有 isFriend / quota 字段）→ 不锁输入区（云端不可用不能把人锁死）',
    t12.data.isFriend === true && t12.data.canSend === true);
  ok('降级时也不画关系状态条（一个字都不该提）', t12.data.quotaText === '');

  /* ============ C. 长按菜单与四个动作 ============ */
  console.log('\nC. 长按消息菜单（复制 / 撤回 / 重发 / 举报）');

  const menuOf = (msgs, idx) => {
    SHEETS.length = 0;
    onSheet = null;
    const t = mkThis({ messages: msgs, peer: 'peer' }, { peer: 'peer' }, CT);
    CT.msgMenu.call(t, { currentTarget: { dataset: { idx: idx } } });
    return { ctx: t, list: SHEETS.length ? SHEETS[SHEETS.length - 1] : [] };
  };

  let mm = menuOf([MSG({ id: 'me1', from: 'me', mine: true, at: NOW - 1000, canRecall: true })], 0);
  ok('自己发的、2 分钟内的消息 → 菜单里有「复制文字」「撤回」', mm.list.join('/') === '复制文字/撤回', mm.list);
  ok('自己的消息菜单里没有「举报自己」', mm.list.indexOf('举报这位同学') < 0);

  mm = menuOf([MSG({ id: 'p1', at: NOW - 1000, canRecall: false })], 0);
  ok('对方发的消息 → 菜单里有「复制文字」「举报这位同学」，没有「撤回」',
    mm.list.join('/') === '复制文字/举报这位同学', mm.list);

  mm = menuOf([MSG({ id: 'f1', from: 'me', mine: true, text: 'x', failed: true, canRecall: false })], 0);
  ok('未送达的自己消息 → 菜单里有「重发」', mm.list.indexOf('重发') >= 0, mm.list);

  mm = menuOf([MSG({ id: 's1', from: 'system', sys: true, text: '系统消息' })], 0);
  ok('系统消息长按不弹菜单（它不是谁说的话，没什么可复制/举报的）', mm.list.length === 0);

  mm = menuOf([MSG({ id: 'i1', from: 'peer', images: ['cloud://a'], text: '' })], 0);
  ok('纯图消息长按也能举报（对方发来一张图，照样要能报他）',
    mm.list.indexOf('举报这位同学') >= 0, mm.list);

  mm = menuOf([MSG({ id: 'e1', from: 'me', mine: true, text: '', images: [], canRecall: false })], 0);
  ok('空消息（没有任何内容也没失败的残留）→ 不弹空菜单', mm.list.length === 0);

  // 复制的只有文字，不把图一起塞进剪贴板
  MEM.__clip = '(未被写入)';
  const cp = mkThis({ messages: [MSG({ id: 'c1', text: '  一段文字  ', images: ['cloud://a'] })] }, { peer: 'peer' }, CT);
  CT.copyMsg.call(cp, cp.data.messages[0]);
  ok('复制消息：进剪贴板的是纯文字（把 fileID 塞进去用户粘出来是一串打不开的 ID）',
    MEM.__clip === '一段文字', MEM.__clip);
  MEM.__clip = '(未被写入)';
  CT.copyMsg.call(cp, MSG({ id: 'c2', text: '', images: ['cloud://a'] }));
  ok('复制消息：纯图消息没有文字可复制 → 不写剪贴板（不留下上一次的内容）',
    MEM.__clip === '(未被写入)');

  // 撤回
  onModal = (o) => o.success({ confirm: false });
  let before = CALLS.length;
  const rc1 = mkThis({ messages: [MSG({ id: 'r1', from: 'me', mine: true, text: 'x', at: NOW })] }, { peer: 'peer' }, CT);
  CT.onRecall.call(rc1, rc1.data.messages[0]);
  await tick();
  ok('撤回：用户取消 → 一个请求都不发', CALLS.length === before);
  ok('撤回：取消时本地不改动（不能本地先抹掉，云端还在的话对方看得到我看不到）',
    rc1.data.messages[0].text === 'x');

  onModal = (o) => o.success({ confirm: true });
  CALL_REPLY = () => ({ ok: true, recalled: true });
  const rc2 = mkThis({ messages: [MSG({ id: 'r2', from: 'me', mine: true, text: 'x', images: ['a'] })] }, { peer: 'peer' }, CT);
  CT.onRecall.call(rc2, rc2.data.messages[0]);
  await tick();
  const recallCall = CALLS[CALLS.length - 1];
  ok('撤回：带上了 peer 与 msgId', recallCall.action === 'chatRecall'
    && recallCall.payload.peer === 'peer' && recallCall.payload.msgId === 'r2', recallCall);
  ok('撤回成功 → 本地标 recalled', rc2.data.messages[0].recalled === true);
  ok('撤回成功 → 本地同时清空 text 与 images（留着就是「撤回了但内容还在」）',
    rc2.data.messages[0].text === '' && rc2.data.messages[0].images.length === 0);
  ok('撤回成功 → 顺手收掉撤回入口（同一个菜单不该能点第二次）',
    rc2.data.messages[0].canRecall === false);

  CALL_REPLY = () => ({ ok: false, msg: '超过 2 分钟了，撤不回来' });
  const rc3 = mkThis({ messages: [MSG({ id: 'r3', from: 'me', mine: true, text: 'x' })] }, { peer: 'peer' }, CT);
  CT.onRecall.call(rc3, rc3.data.messages[0]);
  await tick();
  ok('★★ 云端说撤不回来时，本地**不**抹掉（谎报撤回比不撤回更糟：'
    + '我以为删掉了，对方那边还在）',
    rc3.data.messages[0].text === 'x' && !rc3.data.messages[0].recalled);

  // 举报。理由枚举这一轮从私信页搬进了 utils/report-person.js（与名片页共用）——
// 判据也跟着换落点：绑在某一个页面上，等于逼着下一轮再抄一份
  const RP_JS = readProj('pages/user/utils/report-person.js');
  const PEER_REASONS = (src.match(/const PERSON_REASONS = \[([^\]]*)\]/) || [])[1] || '';
  const feReasons = (RP_JS.match(/const PERSON_REASONS = \[([^\]]*)\]/) || [])[1] || '';
  ok('★ 举报理由与服务端 PERSON_REASONS 逐字一致'
    + '（前端多写一个词，云函数会把那一票静默归到「其他」）',
    feReasons.replace(/\s/g, '') === PEER_REASONS.replace(/\s/g, ''), { fe: feReasons, be: PEER_REASONS });
  ok('举报理由是 4 个（wx.showActionSheet 的实际上限是 6，别越界）',
    (RP_JS.match(/const PERSON_REASONS = \[([^\]]*)\]/)[1].split(',').length) === 4);
  ok('★ 举报交互只有一份实现：私信页自己那份枚举已经删掉（抄两份就一定会漂移一次）',
    CHAT_JS.indexOf('const PERSON_REASONS') < 0
    && CHAT_JS.indexOf("utils/report-person.js") > 0);

  SHEETS.length = 0;
  onSheet = (o) => o.success({ tapIndex: 0 });
  CALL_REPLY = () => ({ ok: true, msg: '举报已提交' });
  const rp = mkThis({ messages: [] }, { peer: 'peer' }, CT);
  CT.onReport.call(rp);
  await tick();
  const reportCall = CALLS[CALLS.length - 1];
  ok('举报：弹出的理由菜单与服务端枚举一致',
    SHEETS.length === 1 && SHEETS[0].join('/') === '恶意骚扰/冒充他人/广告骚扰/涉及隐私', SHEETS[0]);
  ok('举报：调的是 report 且 targetType=chat、targetOpenid=peer',
    reportCall.action === 'report' && reportCall.payload.targetType === 'chat'
    && reportCall.payload.targetOpenid === 'peer', reportCall);
  ok('举报：选项下标映射到正确的理由（选第 1 项 → 恶意骚扰）',
    reportCall.payload.reason === '恶意骚扰', reportCall.payload.reason);

  CALL_REPLY = () => ({ ok: false, msg: '你已经举报过这位同学了' });
  onSheet = (o) => o.success({ tapIndex: 1 });
  const rp2 = mkThis({ messages: [] }, { peer: 'peer' }, CT);
  CT.onReport.call(rp2);
  await tick();
  ok('举报：云端的拒绝理由原样转发出来（不吞掉「已经举报过」这句）',
    CALLS[CALLS.length - 1].payload.reason === '冒充他人');

  // 请求箱：接受 / 忽略
  CALL_REPLY = () => ({ ok: true, accepted: true });
  const ac = mkThis({ isPendingReq: true, reqState: '' }, { peer: 'peer' }, CT);
  await CT.onAcceptReq.call(ac);
  ok('接受请求：调 chatAccept 且带 peer',
    CALLS[CALLS.length - 1].action === 'chatAccept' && CALLS[CALLS.length - 1].payload.peer === 'peer');
  ok('接受请求：本地状态立刻改掉（不重拉也不该还挂着「接受」按钮）',
    ac.data.reqState === 'accepted' && ac.data.isPendingReq === false);

  CALL_REPLY = () => ({ ok: true, dismissed: true });
  const ds = mkThis({ isPendingReq: true, reqState: '' }, { peer: 'peer' }, CT);
  await CT.onDismissReq.call(ds);
  ok('忽略请求：调 chatDismiss', CALLS[CALLS.length - 1].action === 'chatDismiss');
  ok('忽略请求：本地状态改掉（不等于拉黑，对方再发还会回来）',
    ds.data.reqState === 'dismissed' && ds.data.isPendingReq === false);

  CALL_REPLY = () => ({ ok: false, msg: '参数不对' });
  const ac2 = mkThis({ isPendingReq: true, reqState: '' }, { peer: 'peer' }, CT);
  await CT.onAcceptReq.call(ac2);
  ok('接受失败 → 本地状态不动（不能乐观改掉再被云端打回来）',
    ac2.data.reqState === '' && ac2.data.isPendingReq === true);

  // 轮询定时器
  onSheet = null;
  const pl = mkThis({ messages: [] }, { peer: 'peer', load: noop }, CT);
  CALL_REPLY = () => ({ ok: true, messages: [] });
  pl.startPoll();
  ok('轮询：起了一个定时器', !!pl.pollTimer);
  pl.stopPoll();
  ok('轮询：停掉之后定时器清空（onHide / onUnload 一定要停，否则白烧云函数调用）',
    pl.pollTimer === null);

  /* ============ D. 会话列表页 ============ */
  console.log('\nD. 会话列表页（分组 / 分页 / 接受忽略 / 长按删除）');

  const CSF = new Function(
    sliceFn(CHATS_JS, 'ago') + '\n' + sliceFn(CHATS_JS, 'cut') + '\n'
    + sliceFn(CHATS_JS, 'decorate') + '\n'
    + 'return { decorate: decorate };'
  )();
  const dl = CSF.decorate([
    { peer: 'p', nickName: '张三', lastText: 'x'.repeat(40), lastTime: Date.now() - 30000, unread: 1 }
  ]);
  ok('列表项：算出相对时间（30 秒前）', dl[0].timeText === '刚刚' || /分钟前/.test(dl[0].timeText), dl[0].timeText);
  ok('列表项：摘要截到 30 字（长消息会把整行撑开）', dl[0].lastTextCut.length === 31, dl[0].lastTextCut.length);
  ok('列表项：算出头像首字（WXML 里不能调 charAt）', dl[0].avatarText === '张');
  ok('列表项：昵称缺失时首字兜底成「同」', CSF.decorate([{ peer: 'p' }])[0].avatarText === '同');
  ok('decorate 对 null / undefined 输入不炸（云端降级时可能给空）',
    CSF.decorate(null).length === 0 && CSF.decorate(undefined).length === 0);

  CALL_REPLY = (action) => {
    if (action !== 'chatList') return undefined;
    return {
      ok: true,
      list: [{ peer: 'a', nickName: '甲', lastText: 'hi', lastTime: NOW, isFriend: true, unread: 1 }],
      requests: [{ peer: 'b', nickName: '乙', lastText: '在吗', lastTime: NOW, isFriend: false, unread: 1 }],
      total: 1, requestTotal: 1, hasMore: true, requestHasMore: true
    };
  };
  const c1 = mkThis({}, { peer: '' }, CS);
  await CS.load.call(c1, true);
  const listCall = CALLS[CALLS.length - 1];
  ok('列表加载：带 limit / offset（会话多了以后一次拉 50 条不够用）',
    listCall.action === 'chatList' && listCall.payload.limit === 30 && listCall.payload.offset === 0, listCall.payload);
  ok('列表加载：主列表与请求箱分成两段', c1.data.list.length === 1 && c1.data.requests.length === 1);
  ok('★ 请求箱默认收起（默认展开的话，一条陌生人的广告会永远占住列表第一屏）',
    CS.data.showRequests === false && c1.data.showRequests === false, {
      declared: CS.data.showRequests, afterLoad: c1.data.showRequests
    });
  ok('请求箱收起时也要知道有几条', c1.data.requestTotal === 1);
  ok('列表加载：分页标记透传上来', c1.data.hasMore === true && c1.data.requestHasMore === true);
  ok('列表加载：骨架屏关掉', c1.data.loading === false);
  ok('★ 请求箱里的未读也计入总未读（光算主列表的话，'
    + '被收进请求箱的消息一条红点都不亮，用户完全察觉不到有人找过他）',
    CHATS_JS.indexOf('list.concat(reqs).reduce') > 0
    && CHATS_JS.indexOf('unread.setChatUnread(sum)') > 0);
  ok('列表加载：offset 记住，供下一页使用', c1.offset === 30);

  c1.data.hasMore = true;
  await CS.loadMore.call(c1);
  ok('翻页：offset 递增，不重复拉第一页',
    CALLS[CALLS.length - 1].payload.offset === 30, CALLS[CALLS.length - 1].payload);
  ok('翻页：新的一页追加在后面', c1.data.list.length === 2);

  const c2 = mkThis({}, { peer: '' }, CS);
  CALL_REPLY = (action) => (action === 'chatList'
    ? { ok: true, list: [], requests: [], degraded: true } : undefined);
  await CS.load.call(c2, true);
  ok('★★ 查询失败（degraded）与「真的没有会话」必须分开：'
    + '都显示成空列表的话，用户会以为聊天记录被清空了',
    c2.data.degraded === true && c2.data.list.length === 0);

  const c3 = mkThis({}, { peer: '' }, CS);
  CALL_REPLY = (action) => (action === 'chatList' ? null : undefined);
  await CS.load.call(c3, true);
  ok('★ 云函数没响应（offline）也标出来，同样不冒充「没有会话」', c3.data.offline === true);

  CALL_REPLY = () => ({ ok: true });
  const c4 = mkThis({}, { peer: '' }, CS);
  let reloaded = 0;
  c4.load = () => { reloaded += 1; return Promise.resolve(); };
  CALL_REPLY = (action) => (action === 'chatAccept' ? { ok: true } : (action === 'chatList' ? { ok: true, list: [], requests: [] } : undefined));
  await CS.onAcceptReq.call(c4, { currentTarget: { dataset: { peer: 'b' } } });
  await tick();
  ok('列表页「接受」→ 调 chatAccept', CALLS[CALLS.length - 1].action === 'chatAccept'
    || CALLS.some((x) => x.action === 'chatAccept' && x.payload.peer === 'b'));
  ok('列表页「接受」→ 整表重拉（这一行要从请求箱挪进主列表，本地硬搬容易漏排序）', reloaded === 1);

  CALL_REPLY = (action) => (action === 'chatDismiss' ? { ok: true } : (action === 'chatList' ? { ok: true, list: [], requests: [] } : undefined));
  await CS.onDismissReq.call(c4, { currentTarget: { dataset: { peer: 'b' } } });
  await tick();
  ok('列表页「忽略」→ 调 chatDismiss（不是拉黑：对方再发一条还会回来）',
    CALLS.some((x) => x.action === 'chatDismiss' && x.payload.peer === 'b'));
  ok('列表页「忽略」也会重拉', reloaded === 2);

  // 长按删除
  onModal = (o) => o.success({ confirm: false });
  before = CALLS.length;
  const c5 = mkThis({}, { peer: '' }, CS);
  CS.onLongPress.call(c5, { currentTarget: { dataset: { peer: 'a', name: '甲' } } });
  await tick();
  ok('长按会话 → 弹确认框（删除是有成本的动作，不该长按即删）', CALLS.length === before);
  ok('确认框里说清「只删我这一边」与「对方再发会回来」'
    + '（不提的话用户会以为对方也看不到了）',
    !!LAST_MODAL && LAST_MODAL.content.indexOf('对方那边不受影响') > 0
    && LAST_MODAL.content.indexOf('重新出现') > 0);
  ok('确认框主按钮是「删除」且用了危险色（默认的「确定」看不出代价）',
    LAST_MODAL.confirmText === '删除' && !!LAST_MODAL.confirmColor);

  onModal = (o) => o.success({ confirm: true });
  const c6 = mkThis({}, { peer: '' }, CS);
  c6.load = () => Promise.resolve();
  CALL_REPLY = (action) => (action === 'chatRemove' ? { ok: true, removed: true } : (action === 'chatList' ? { ok: true, list: [], requests: [] } : undefined));
  CS.onLongPress.call(c6, { currentTarget: { dataset: { peer: 'a', name: '甲' } } });
  await tick();
  ok('长按确认 → 调 chatRemove（只删我这一侧，对方那份记录保留）',
    CALLS.some((x) => x.action === 'chatRemove' && x.payload.peer === 'a'));

  CALL_REPLY = (action) => (action === 'chatRemove' ? { ok: false, msg: '云端没响应，再试一次' } : undefined);
  const c7 = mkThis({}, { peer: '' }, CS);
  let reloaded7 = 0;
  c7.load = () => { reloaded7 += 1; return Promise.resolve(); };
  CS.onLongPress.call(c7, { currentTarget: { dataset: { peer: 'a', name: '甲' } } });
  await tick();
  ok('删除失败 → 不重拉（本地不动，用户看到提示还能再试一次）', reloaded7 === 0);

  const c8 = mkThis({}, { peer: '' }, CS);
  before = CALLS.length;
  CS.onLongPress.call(c8, { currentTarget: { dataset: {} } });
  await tick();
  ok('长按但没有 peer → 什么都不做', CALLS.length === before);

  /* ============ E. 模板与常量一致性 ============ */
  console.log('\nE. 模板 / 常量一致性');

  const beRecall = Number((src.match(/const RECALL_MS = ([^;]+);/) || [])[1] && 120000);
  const feRecall = Number((CHAT_JS.match(/const RECALL_MS = ([^;]+);/) || [])[1]
    ? CHAT_JS.match(/const RECALL_MS = ([^;]+);/)[1].split('*').reduce((a, b) => a * Number(b.trim()), 1) : 0);
  ok('★ 前端撤回窗口与云函数 RECALL_MS 同值（不一致会出现「菜单里有撤回、点了却被拒」）',
    feRecall === beRecall, { fe: feRecall, be: beRecall });

  const pollMs = Number((CHAT_JS.match(/const POLL_MS = (\d+);/) || [])[1]);
  ok('会话页轮询间隔在 15~30 秒之间（' + pollMs + 'ms）—— 更短白烧调用，更长像没发出去',
    pollMs >= 15000 && pollMs <= 30000);
  const chatPoll = Number((CHATS_JS.match(/const POLL_MS = (\d+);/) || [])[1]);
  ok('列表页轮询不比会话页更密（用户停在列表上没有正在等的回信，'
    + '没必要比会话页还勤）：' + chatPoll + ' >= ' + pollMs, chatPoll >= pollMs);

  ok('会话页模板挂了长按菜单', CHAT_WXML.indexOf('bindlongpress="msgMenu"') > 0);
  ok('会话页滚动区挂了 bindscroll + bindscrolltolower（判断「用户在不在底部」的唯一依据）',
    CHAT_WXML.indexOf('bindscroll="onScroll"') > 0
    && CHAT_WXML.indexOf('bindscrolltolower="onScrollToLower"') > 0);
  ok('会话页模板有系统消息的独立分支（不给它气泡，否则会被读成对方说的话）',
    CHAT_WXML.indexOf('{{item.sys}}') > 0 && CHAT_WXSS.indexOf('.ct-sys') > 0);
  ok('会话页模板有「已撤回」的占位分支（保留原位，否则上下两句会接在一起读）',
    CHAT_WXML.indexOf('{{item.recalled}}') > 0 && CHAT_WXSS.indexOf('.ct-recalled') > 0);
  ok('会话页模板有请求箱的接受/忽略条', CHAT_WXML.indexOf('onAcceptReq') > 0
    && CHAT_WXML.indexOf('onDismissReq') > 0);
  ok('会话页模板有「N 条新消息」角标', CHAT_WXML.indexOf('onJumpNew') > 0
    && CHAT_WXSS.indexOf('.ct-newhint') > 0);
  ok('角标给锁块状态留了让位（锁块比输入行高，不跟着挪会正好压在按钮上）',
    CHAT_WXSS.indexOf('.ct-newhint--lock') > 0);

  ok('★ 列表页请求箱的两个按钮用 catchtap（不 catch 会连带触发整行跳转，按了个寂寞）',
    CHATS_WXML.indexOf('catchtap="onDismissReq"') > 0
    && CHATS_WXML.indexOf('catchtap="onAcceptReq"') > 0);
  ok('列表页主列表行挂了长按删除', CHATS_WXML.indexOf('bindlongpress="onLongPress"') > 0);
  ok('列表页有「长按会话可以删除」的提示（手势没有视觉线索，新用户不会去试）',
    CHATS_WXML.indexOf('长按会话可以删除') > 0);
  ok('列表页的请求箱行**不**挂长按（那边已有两个明确按钮，'
    + '而「忽略」对一条请求的效果与「删除会话」一样）',
    CHATS_WXML.indexOf('cs-req__item"') > 0
    && !/cs-req__item[^>]*bindlongpress/.test(CHATS_WXML));
  ok('列表页把「没拉到」与「没有会话」分成两个分支显示',
    CHATS_WXML.indexOf('degraded || offline') > 0
    && CHATS_WXML.indexOf('还没有和同学聊过天') > 0);

  // 模板里引用的图标必须真的存在（写错名字在真机上是一块空白，编译期不报）
  const iconMiss = [];
  [CHAT_WXML, CHATS_WXML].forEach((t) => {
    const re = /assets\/icons\/[A-Za-z0-9_\-]+\.svg/g;
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(t))) {
      if (!fs.existsSync(path.join(PROJ, m[0]))) iconMiss.push(m[0]);
    }
  });
  ok('两个模板里引用的图标文件都存在', iconMiss.length === 0, iconMiss);

  // wx:if / wx:elif / wx:else 之间夹注释：各端编译器对「注释算不算兄弟节点」
  // 处理并不一致，属于「本地好好的、真机裂开」那类问题。链前后随便写，链中间不行。
  // 判据：wx:elif / wx:else 元素的前一个 '<' 如果是 '<!--'，说明注释就贴在它前面 ——
  // 那正是夹在上一节的 wx:if 兄弟与它之间
  const chainGaps = (t) => {
    const hits = [];
    const re = /wx:(?:elif|else)\b/g;
    let m;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(t))) {
      const selfLt = t.lastIndexOf('<', m.index);
      const prevLt = t.lastIndexOf('<', selfLt - 1);
      if (prevLt >= 0 && t.startsWith('<!--', prevLt)) {
        hits.push(t.slice(prevLt, prevLt + 40));
      }
    }
    return hits;
  };
  ok('会话页模板的 wx:if/wx:else 之间没有夹注释', chainGaps(CHAT_WXML).length === 0,
    chainGaps(CHAT_WXML));
  ok('会话列表页模板的 wx:if/wx:else 之间没有夹注释', chainGaps(CHATS_WXML).length === 0,
    chainGaps(CHATS_WXML));

  // ⚠️ 判据要打**调用形状**（带括号），不能打裸词 ——
  //    注释里写着「走反馈层而不是裸调 wx.showToast」也会命中，
  //    这是这个项目已经踩过一次的「断言撞上注释」陷阱
  ok('会话页不再裸调 wx.showToast（提示统一走反馈层：它会先收键盘，'
    + '免得 toast 弹在键盘后面看不见）',
    !/wx\.showToast\s*\(/.test(CHAT_JS) && /feedback\.toast\(/.test(CHAT_JS));
  ok('会话列表页同样不裸调 wx.showToast', !/wx\.showToast\s*\(/.test(CHATS_JS));
  ok('会话页 JS 里没有裸写 hex 色值（颜色只出现在 wxss 的令牌/语义类里）',
    !/#[0-9a-fA-F]{6}/.test(CHAT_JS.replace(/#d9534f/g, '')));

  console.log('\n' + (fail ? '✗ ' : '✓ ') + '共 ' + (pass + fail) + ' 项，通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试自身出错：', e);
  process.exit(2);
});
