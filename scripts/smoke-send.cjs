/**
 * smoke-send.cjs —— 「点了发送毫无反应」第二轮修复的回归冒烟
 *
 * 运行：cd recon && node scripts/smoke-send.cjs
 *
 * 这一轮修的不是业务逻辑，而是**反馈根本没送到用户眼前**这几类问题：
 *   ① 按钮被 disabled 卡死 → 点击连事件都不触发（最硬的一种静默）
 *   ② Toast 被软键盘挡住 → 提示弹了，用户一个字没看到
 *   ③ 切后台后 setTimeout 被系统暂停 → 总闸哑火，按钮永久失灵
 *   ④ 订阅授权框把「发布成功」那句盖掉
 *   ⑤ view 的 :active 不可靠 → 按下那一帧没有任何视觉反馈
 *
 * 这些都「不报错」，只能靠断言调用顺序 + 静态检查兜住。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram', 'zjgsu-campus');

let all = true;
let passed = 0;

function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed += 1;
    console.log('PASS ' + name);
  } else {
    all = false;
    console.log('FAIL ' + name + '\n     期望 ' + w + '\n     实际 ' + g);
  }
}
function ok(name, cond) { eq(name, !!cond, true); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ------------------------------------------------------------------ *
 * 迷你 CommonJS 加载器（带 root 解析 + 依赖桩）
 * ------------------------------------------------------------------ */
function makeLoader(stubs) {
  const cache = {};
  function load(abs) {
    if (cache[abs]) return cache[abs].exports;
    const code = fs.readFileSync(abs, 'utf8');
    const module = { exports: {} };
    cache[abs] = module;
    const req = (id) => {
      const base = path.basename(id);
      if (stubs[base]) return stubs[base];
      const target = path.resolve(path.dirname(abs), id);
      return load(target);
    };
    const fn = new Function(
      'module', 'exports', 'require', 'wx', 'Page', 'console',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'Promise', 'JSON', 'Math',
      code
    );
    fn(module, module.exports, req, stubs.__wx, stubs.__Page, console,
      setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, JSON, Math);
    return module.exports;
  }
  return load;
}

// 记录所有 wx 调用的桩：toast / loading / modal 都带时间戳，便于断言先后顺序
function makeWx() {
  const log = [];
  const wx = {
    _log: log,
    _throwToast: false,
    showToast: (o) => {
      if (wx._throwToast) throw new Error('showToast boom');
      log.push({ api: 'toast', title: o.title, icon: o.icon, t: Date.now() });
    },
    showLoading: (o) => log.push({ api: 'loading', title: o.title, t: Date.now() }),
    hideLoading: () => log.push({ api: 'hideLoading', t: Date.now() }),
    hideKeyboard: () => log.push({ api: 'hideKeyboard', t: Date.now() }),
    vibrateShort: () => log.push({ api: 'buzz', t: Date.now() }),
    showModal: (o) => log.push({ api: 'modal', title: o.title, t: Date.now() }),
    navigateBack: () => log.push({ api: 'navigateBack', t: Date.now() }),
    requestSubscribeMessage: (o) => { log.push({ api: 'subscribe', t: Date.now() }); if (o && o.fail) o.fail({}); },
    showActionSheet: () => {},
    stopPullDownRefresh: () => {},
    getSystemInfoSync: () => ({}),
    previewImage: () => {},
    setStorageSync: () => {},
    getStorageSync: () => '',
    removeStorageSync: () => {}
  };
  return wx;
}

// 静态断言前必须把注释剥掉：注释里经常写着「别再裸调 wx.showToast」这种话，
// 不剥的话断言永远通过不了（或者更糟——永远通过，等于没测）
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, '$1');
}

// Toast 是隔一帧（30ms）才弹出来的，断言前要给它这点时间，
// 否则会把「其实弹了」误判成「静默失败」
async function toastAfter(log, fn, ms) {
  await fn();
  await sleep(ms === undefined ? 60 : ms);
  return log;
}

function seq(log) { return log.map((x) => x.api); }
function titles(log, api) { return log.filter((x) => x.api === (api || 'toast')).map((x) => x.title); }
function lastTitle(log, api) {
  const t = log.filter((x) => x.api === (api || 'toast'));
  return t.length ? t[t.length - 1].title : null;
}

function makePageStub() {
  const captured = {};
  return {
    captured,
    Page: (opts) => { captured.opts = opts; }
  };
}

/* ================================================================== *
 * 一、反馈层：键盘 / 弹窗失败 / 看门狗
 * ================================================================== */
async function testFeedback() {
  const wxStub = makeWx();
  const load = makeLoader({ __wx: wxStub });
  const feedback = load(path.join(ROOT, 'utils', 'feedback.js'));
  const log = wxStub._log;

  // 1. 弹提示之前必须先收键盘：键盘挡住 Toast 是最常见的一种「毫无反应」
  log.length = 0;
  await feedback.toast('出错了');
  ok('1.1 弹 Toast 前先收键盘', seq(log).indexOf('hideKeyboard') >= 0
    && seq(log).indexOf('hideKeyboard') < seq(log).indexOf('toast'));

  // 2. Loading 与 Toast 的先后顺序（老问题不能被改回去）
  log.length = 0;
  feedback.loading('发布中', true);
  await feedback.toast('出错了');
  eq('1.2 Loading 之后 Toast 仍在（没被吞）',
    seq(log).filter((x) => x !== 'hideKeyboard'),
    ['loading', 'hideLoading', 'toast']);

  // 3. wx.showToast 本身失败也要把话送到：退 Modal
  log.length = 0;
  wxStub._throwToast = true;
  await feedback.toast('网络不太稳');
  wxStub._throwToast = false;
  eq('1.3 Toast 接口失败时退 Modal（绝不静默）', titles(log, 'modal'), ['网络不太稳']);

  // 4. 看门狗：一条链跑了很久却一个结论都没给 → 自己站出来说话
  log.length = 0;
  const wd = feedback.watchdog({ ms: 120, msg: '这条卡太久了' });
  await sleep(200);
  wd.cancel();
  eq('1.4 看门狗在无结论时兜底提示', titles(log), ['这条卡太久了']);

  // 5. 期间已经给过结论 → 不重复打扰
  log.length = 0;
  const wd2 = feedback.watchdog({ ms: 120, msg: '别重复打扰' });
  await feedback.toast('发布成功');
  await sleep(200);
  wd2.cancel();
  eq('1.5 已有结论时看门狗闭嘴', titles(log), ['发布成功']);

  // 6. 主动取消后不再响
  log.length = 0;
  const wd3 = feedback.watchdog({ ms: 120, msg: '不该出现' });
  wd3.cancel();
  await sleep(200);
  eq('1.6 cancel 之后看门狗不响', titles(log), []);

  // 7. 总闸：任务永不返回时按超时处理，并且一定有提示
  log.length = 0;
  const r = await feedback.run({
    task: new Promise(() => {}),
    ms: 150,
    timeoutValue: { ok: false, msg: '超时了' },
    timeoutMsg: '超时了'
  });
  eq('1.7 总闸超时后给出结论', [r.timedOut, lastTitle(log)], [true, '超时了']);

  // 8. 反馈时间戳会更新（页面靠它判断状态是否过期）
  ok('1.8 lastFeedbackAt 有记录', feedback.lastFeedbackAt() > 0);

  // 9. 震动：唯一不会被任何弹窗吞掉的反馈，点击时必须给
  log.length = 0;
  feedback.buzz();
  eq('1.9 点击给震动反馈', seq(log), ['buzz']);

  // 10. force 收 Loading：系统里可能挂着**别人**留下的 Loading，
  //     记账是 false 但 showToast 照样会被它吃掉
  log.length = 0;
  await feedback.toast('出错了');
  ok('1.10 没有 Loading 时也强制收一次（防残留 Loading 吞 Toast）',
    seq(log).indexOf('hideLoading') >= 0 && seq(log).indexOf('hideLoading') < seq(log).indexOf('toast'));
}

/* ================================================================== *
 * 二、发帖页 submit()
 * ================================================================== */
async function testPost() {
  let addPostResult = { ok: true };
  let addPostCalls = 0;

  const wxStub = makeWx();
  const page = makePageStub();
  const stubs = {
    __wx: wxStub,
    __Page: page.Page,
    'store.js': {
      HOLE_BOARD: '树洞',
      getBoards: () => [{ name: '社团同好' }, { name: '闲聊' }],
      getDrafts: () => [],
      getDraft: () => null,
      saveDraft: () => ({ id: 'd1' }),
      removeDraft: () => {},
      hasDraftText: () => true,
      addPost: () => { addPostCalls += 1; return Promise.resolve(addPostResult); },
      getPosts: () => [],
      getCourses: () => [],
      // 发帖页用它现一个幂等键：重复提交时云端按它认出「这是同一条」
      genId: () => 'cid'
    },
    'moderation.js': { guardText: () => true, CONTACT_OK_BOARDS: [] },
    'user.js': { checkText: () => Promise.resolve({ ok: true }) },
    'cloud.js': { cfg: { USE_CLOUD: false }, ensureCloud: () => false, fetchOpenid: () => Promise.resolve('oid') },
    'upload.js': { pickImages: () => Promise.resolve({ ok: false, canceled: true }), prewarm: () => {}, uploadMany: () => Promise.resolve({ ok: [], failed: 0 }) },
    // maybeRequest 是带节流的授权入口（见 utils/notify.js）；桩里直接回 false，
    // 表示「没授权」，发布流程必须照常继续 —— 这也是真实情况下最常见的分支
    'notify.js': { request: () => Promise.resolve(false), maybeRequest: () => Promise.resolve(false) },
    'search.js': { matchFields: () => -1 }
  };
  const load = makeLoader(stubs);
  load(path.join(ROOT, 'sub', 'forum', 'post', 'post.js'));
  const opts = page.captured.opts;
  const log = wxStub._log;

  const mkInst = () => Object.assign({}, opts, {
    data: JSON.parse(JSON.stringify(opts.data)),
    _published: false,
    setData(patch) { this.data = Object.assign(this.data, patch); }
  });

  // 1. 正常的成功链路：必须有成功提示，并返回上一页
  let inst = mkInst();
  inst.setData({ title: '标题', content: '正文', board: '闲聊' });
  log.length = 0;
  addPostCalls = 0;
  await inst.submit();
  eq('2.1 成功时给了成功提示', lastTitle(log), '发布成功');
  eq('2.2 成功时确实调用了 addPost', addPostCalls, 1);
  eq('2.3 提交结束后 submitting 复位', inst.data.submitting, false);

  // 2. 发布成功后才返回（900ms），让人看清那句「发布成功」
  await sleep(1200);
  const s = seq(log);
  ok('2.4 返回发生在成功提示之后', s.indexOf('toast') < s.indexOf('navigateBack'));
  // 订阅授权的时机：微信只认「用户点击」那一帧，否则 fail 20004
  // （can only be invoked by user TAP gesture），面板一次都不出现。
  // 上一版为了不盖掉成功提示，把它挪到 navigateBack 之后又套了个 setTimeout，
  // 结果模板 ID 填得再对也永远弹不出来。现在改成 submit() 校验通过后立刻 await。
  // 桩里 notify 是假的、走不到真实接口，所以这两条断言源码位置。
  const postSrc = fs.readFileSync(path.join(ROOT, 'sub', 'forum', 'post', 'post.js'), 'utf8');
  ok('2.5 订阅授权在点击调用栈内同步发起（await notify.maybeRequest）',
    /await notify\.maybeRequest\(\[/.test(postSrc));
  ok('2.5b 授权发生在返回列表之前',
    postSrc.indexOf('notify.maybeRequest') >= 0
    && postSrc.indexOf('notify.maybeRequest') < postSrc.indexOf('wx.navigateBack'));
  ok('2.5c 不再有拖到回调里的裸 request', !/notify\.request\(/.test(postSrc));

  // 3. 云端失败：必须有话说
  addPostResult = { ok: false, msg: '已存在本机，云端暂时连不上' };
  inst = mkInst();
  inst.setData({ title: '标题', content: '正文', board: '闲聊' });
  log.length = 0;
  await inst.submit();
  eq('2.6 失败时把原因说出来', lastTitle(log), '已存在本机，云端暂时连不上');
  eq('2.7 失败后按钮也复位', inst.data.submitting, false);

  // 4. 校验边界：该放的放行、该拦的拦住。
  // 普通帖的标题改成选填之后，这两条从「都要提示」变成「都不该提示」——
  // 放行那两条用「不等于旧文案」来断言，放行后流程会走下去并留下别的提示，
  // 写死期望值反而会把它钉成别的毛病
  addPostResult = { ok: true };
  inst = mkInst();
  inst.setData({ title: '', content: '正文', board: '闲聊', images: [] });
  log.length = 0;
  await toastAfter(log, () => inst.submit());
  eq('2.8 只发一句话不再被标题拦住', lastTitle(log) === '写个标题', false);
  eq('2.8b 一句话真的进了发布流程', addPostCalls > 0, true);

  inst = mkInst();
  inst.setData({ title: '', content: '', board: '闲聊', kind: 'normal', images: ['cloud://a.png'] });
  log.length = 0;
  addPostCalls = 0;
  await toastAfter(log, () => inst.submit());
  eq('2.9 只发一张图不再被正文拦住', lastTitle(log) === '写点什么，或者加张图', false);
  eq('2.9b 一张图真的进了发布流程', addPostCalls > 0, true);

  // 图和文字都没有：这才是真的没内容
  inst = mkInst();
  inst.setData({ title: '', content: '', board: '闲聊', kind: 'normal', images: [] });
  log.length = 0;
  addPostCalls = 0;
  await toastAfter(log, () => inst.submit());
  eq('2.9c 图文都空才拦', lastTitle(log), '写点什么，或者加张图');
  eq('2.9d 拦下的时候没发请求', addPostCalls, 0);

  inst = mkInst();
  inst.setData({ title: '标题', content: '', board: '课程评价', isCourseBoard: true, courseId: '' });
  log.length = 0;
  await toastAfter(log, () => inst.submit());
  eq('2.10 课程板块漏选课程时提示', lastTitle(log), '先选一门课程');

  // 5. 卡住的 submitting：未过期给提示，过期了自己放开（不靠定时器）
  inst = mkInst();
  inst.setData({ title: '标题', content: '正文', board: '闲聊', submitting: true });
  inst._submitAt = Date.now();   // 刚刚点的 → 还没过期
  log.length = 0;
  addPostCalls = 0;
  await toastAfter(log, () => inst.submit());
  eq('2.11 上一条还没发完时给提示', lastTitle(log), '还在发上一条，稍等一下');
  eq('2.12 未过期时不重复提交', addPostCalls, 0);

  inst = mkInst();
  inst.setData({ title: '标题', content: '正文', board: '闲聊', submitting: true });
  inst._submitAt = Date.now() - 40 * 1000;   // 40 秒前点的 → 早该过期了
  log.length = 0;
  addPostCalls = 0;
  await inst.submit();
  eq('2.13 卡死的 submitting 会自动放开并重发', addPostCalls, 1);
  eq('2.14 放开之后照常给出结论', lastTitle(log), '发布成功');

  // 6. 点击反馈：点了就得有震动（在不依赖 Toast 的通道上先给个回音）
  inst = mkInst();
  inst.setData({ title: '标题', content: '正文', board: '闲聊' });
  log.length = 0;
  await inst.submit();
  eq('2.15 点下去就有震动反馈', seq(log).indexOf('buzz') >= 0, true);

  // 7. tap 丢失时的补刀：手指落下又抬起，却没有 tap 事件
  inst = mkInst();
  inst.setData({ title: '标题', content: '正文', board: '闲聊' });
  addPostCalls = 0;
  inst._tapAt = 0;
  inst.onSubmitTouchStart({ touches: [{ clientX: 10, clientY: 10 }] });
  await inst.onSubmitTouchEnd({ changedTouches: [{ clientX: 12, clientY: 11 }] });
  eq('2.16 tap 没来时抬手补一次提交', addPostCalls, 1);

  // 8. tap 已经来过了就不许重复提交
  inst = mkInst();
  inst.setData({ title: '标题', content: '正文', board: '闲聊' });
  addPostCalls = 0;
  inst._tapAt = Date.now();      // 刚刚 tap 过
  inst.onSubmitTouchStart({ touches: [{ clientX: 10, clientY: 10 }] });
  await inst.onSubmitTouchEnd({ changedTouches: [{ clientX: 12, clientY: 11 }] });
  eq('2.17 tap 已触发时不再重复提交', addPostCalls, 0);

  // 9. 滑动（翻开页面时手指扫过按钮）不能误发
  inst = mkInst();
  inst.setData({ title: '标题', content: '正文', board: '闲聊' });
  addPostCalls = 0;
  inst._tapAt = 0;
  inst.onSubmitTouchStart({ touches: [{ clientX: 10, clientY: 10 }] });
  await inst.onSubmitTouchEnd({ changedTouches: [{ clientX: 90, clientY: 120 }] });
  eq('2.18 滑动经过按钮不会误提交', addPostCalls, 0);

  // 10. 看门狗在发帖链上真的挂上了
  const src = fs.readFileSync(path.join(ROOT, 'sub', 'forum', 'post', 'post.js'), 'utf8');
  ok('2.19 发帖链挂了看门狗', /feedback\.watchdog\(/.test(src) && /wd\.cancel\(\)/.test(src));
}

/* ================================================================== *
 * 三、树洞 send()
 * ================================================================== */
async function testHole() {
  let addPostResult = { ok: true };
  let addPostCalls = 0;

  const wxStub = makeWx();
  const page = makePageStub();
  const stubs = {
    __wx: wxStub,
    __Page: page.Page,
    'store.js': {
      HOLE_BOARD: '树洞',
      addPost: () => { addPostCalls += 1; return Promise.resolve(addPostResult); },
      getHolePosts: () => [],
      hasReported: () => false,
      getDrafts: () => [],
      saveDraft: () => ({ id: 'd1' }),
      removeDraft: () => {},
      // 发帖页用它现一个幂等键：重复提交时云端按它认出「这是同一条」
      genId: () => 'cid'
    },
    'moderation.js': { guardText: () => true, CONTACT_OK_BOARDS: [] },
    'user.js': { checkText: () => Promise.resolve({ ok: true }) },
    'nav.js': { go: () => {} },
    'system.js': { vibrateShort: () => {} }
  };
  const load = makeLoader(stubs);
  load(path.join(ROOT, 'sub', 'forum', 'hole', 'hole.js'));
  const opts = page.captured.opts;
  const log = wxStub._log;

  const mkInst = () => Object.assign({}, opts, {
    data: JSON.parse(JSON.stringify(opts.data)),
    _published: false,
    setData(patch) { this.data = Object.assign(this.data, patch); }
  });

  // 1. 成功：点了就要有 Loading（以前树洞这儿什么都没有），结束要有结论
  let inst = mkInst();
  inst.setData({ title: '', content: '今天有点累' });
  log.length = 0;
  addPostCalls = 0;
  await inst.send();
  eq('3.1 投递时给了「投放中」反馈', titles(log, 'loading').indexOf('投放中') >= 0, true);
  eq('3.2 成功时给出结论', lastTitle(log), '已投进树洞');
  eq('3.3 结束后 posting 复位', inst.data.posting, false);

  // 2. 空内容
  inst = mkInst();
  inst.setData({ title: '', content: '   ' });
  log.length = 0;
  await toastAfter(log, () => inst.send());
  eq('3.4 空内容时提示', lastTitle(log), '想说什么就写下来吧');

  // 3. 只写标题也算数（树洞允许）
  inst = mkInst();
  inst.setData({ title: '就一句话', content: '' });
  log.length = 0;
  addPostCalls = 0;
  await inst.send();
  eq('3.5 只写标题也能投', addPostCalls, 1);

  // 4. 失败
  addPostResult = { ok: false, msg: '网络好像不太稳' };
  inst = mkInst();
  inst.setData({ title: '', content: '今天有点累' });
  log.length = 0;
  await inst.send();
  eq('3.6 失败时把原因说出来', lastTitle(log), '网络好像不太稳');

  // 5. posting 卡住：未过期给提示，过期自己放开
  addPostResult = { ok: true };
  inst = mkInst();
  inst.setData({ title: '', content: '今天有点累', posting: true });
  inst._sendAt = Date.now();
  log.length = 0;
  addPostCalls = 0;
  await toastAfter(log, () => inst.send());
  eq('3.7 上一条还没发完时给提示', lastTitle(log), '还在发上一条，稍等一下');
  eq('3.8 未过期时不重复投递', addPostCalls, 0);

  inst = mkInst();
  inst.setData({ title: '', content: '今天有点累', posting: true });
  inst._sendAt = Date.now() - 40 * 1000;
  log.length = 0;
  addPostCalls = 0;
  await inst.send();
  eq('3.9 卡死的 posting 会自动放开并重投', addPostCalls, 1);

  // 6. 切走再回来：卡住的 posting 必须复位（posting 只影响按钮，卡住就是点不动）
  inst = mkInst();
  inst.setData({ posting: true, content: '今天有点累' });
  log.length = 0;
  await toastAfter(log, () => inst.onShow());
  eq('3.10 回到页面时复位卡住的 posting', inst.data.posting, false);
  eq('3.11 复位时给了说明', lastTitle(log), '上一条没投完，已复位，可以再试');

  // 7. 点击反馈 + tap 丢失补刀
  inst = mkInst();
  inst.setData({ title: '', content: '今天有点累' });
  log.length = 0;
  await inst.send();
  eq('3.12 点下去就有震动反馈', seq(log).indexOf('buzz') >= 0, true);

  inst = mkInst();
  inst.setData({ title: '', content: '今天有点累' });
  addPostCalls = 0;
  inst._tapAt = 0;
  inst.onSendTouchStart({ touches: [{ clientX: 10, clientY: 10 }] });
  await inst.onSendTouchEnd({ changedTouches: [{ clientX: 11, clientY: 12 }] });
  eq('3.13 tap 没来时抬手补一次投递', addPostCalls, 1);

  inst = mkInst();
  inst.setData({ title: '', content: '今天有点累' });
  addPostCalls = 0;
  inst._tapAt = Date.now();
  inst.onSendTouchStart({ touches: [{ clientX: 10, clientY: 10 }] });
  await inst.onSendTouchEnd({ changedTouches: [{ clientX: 11, clientY: 12 }] });
  eq('3.14 tap 已触发时不重复投递', addPostCalls, 0);

  // 8. 看门狗
  const src = fs.readFileSync(path.join(ROOT, 'sub', 'forum', 'hole', 'hole.js'), 'utf8');
  ok('3.15 树洞链挂了看门狗', /feedback\.watchdog\(/.test(src) && /wd\.cancel\(\)/.test(src));
}

/* ================================================================== *
 * 四、静态检查：按钮不能再被 disabled 卡死，按下要有反馈
 * ================================================================== */
function testStatic() {
  // ⚠️ 一律先剥注释：注释里会写「别再裸调 wx.showToast」这类说明，
  //    不剥掉的话这类断言不是失败就是假通过 —— 两种都是白写
  const postWxml = stripComments(fs.readFileSync(path.join(ROOT, 'sub', 'forum', 'post', 'post.wxml'), 'utf8'));
  const holeWxml = stripComments(fs.readFileSync(path.join(ROOT, 'sub', 'forum', 'hole', 'hole.wxml'), 'utf8'));
  const postWxss = stripComments(fs.readFileSync(path.join(ROOT, 'sub', 'forum', 'post', 'post.wxss'), 'utf8'));
  const holeWxss = stripComments(fs.readFileSync(path.join(ROOT, 'sub', 'forum', 'hole', 'hole.wxss'), 'utf8'));
  const mod = stripComments(fs.readFileSync(path.join(ROOT, 'utils', 'moderation.js'), 'utf8'));

  ok('4.1 发布按钮不再被 disabled 卡死', !/disabled="{{submitting}}"/.test(postWxml));
  ok('4.2 发布按钮有按下反馈 hover-class', /class="composer__submit[^"]*"[^>]*hover-class="composer__submit--press"/.test(postWxml));
  ok('4.3 按下反馈样式真的写了', /\.composer__submit--press\s*\{/.test(postWxss));
  ok('4.4 树洞发送按钮有按下反馈', /hover-class="composer__send--press"/.test(holeWxml));
  ok('4.5 树洞按下反馈样式真的写了', /\.composer__send--press\s*\{/.test(holeWxss));
  ok('4.6 树洞置灰条件与 send() 一致（标题也算）', /composer__send \{\{\(title \|\| content\)/.test(holeWxml));
  ok('4.7 屏蔽词提示不再裸调 wx.showToast', !/wx\.showToast/.test(mod));
  ok('4.8 屏蔽词提示走反馈层', /feedback\.toast/.test(mod));

  // 反馈层附近不能有裸调（feedback.js 自己除外）
  const upload = stripComments(fs.readFileSync(path.join(ROOT, 'utils', 'upload.js'), 'utf8'));
  const storeForum = stripComments(fs.readFileSync(path.join(ROOT, 'utils', 'store-forum.js'), 'utf8'));
  ok('4.9 upload.js 不再裸调 wx.showToast', !/wx\.showToast/.test(upload));
  ok('4.10 store-forum.js 不再裸调 wx.showToast', !/wx\.showToast/.test(storeForum));
}

/* ------------------------------------------------------------------ */
(async function main() {
  console.log('=== smoke-send：发送链路「绝不静默」回归 ===\n');
  await testFeedback();
  console.log('');
  await testPost();
  console.log('');
  await testHole();
  console.log('');
  testStatic();
  console.log('\n----------------------------------------');
  console.log(all ? ('全部通过：' + passed + ' 项') : ('有失败项，通过 ' + passed + ' 项'));
  process.exit(all ? 0 : 1);
})();
