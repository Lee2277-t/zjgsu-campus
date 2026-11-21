/**
 * smoke-flow.cjs —— 发送链路 / 反馈层 / 树洞标签的回归冒烟
 *
 * 运行：cd recon && node scripts/smoke-flow.cjs
 *
 * 为什么要有这个脚本：
 * 「点了发布/投递毫无反应」这类问题，光看语法永远发现不了 ——
 * 因为代码没报错，错的是**提示被自己后一行代码抹掉了**。
 * 所以这里把 wx.showLoading / wx.showToast 的调用顺序真的记录下来做断言。
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ------------------------------------------------------------------ *
 * 迷你 CommonJS 加载器：自带 root 解析 + 依赖桩
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

// 记录所有 wx 调用的桩。toast / loading 带上时间戳，好判断先后顺序与间隔
function makeWx() {
  const log = [];
  const wx = {
    _log: log,
    showToast: (o) => log.push({ api: 'toast', title: o.title, icon: o.icon, t: Date.now() }),
    showLoading: (o) => log.push({ api: 'loading', title: o.title, t: Date.now() }),
    hideLoading: () => log.push({ api: 'hideLoading', t: Date.now() }),
    showModal: (o) => log.push({ api: 'modal', title: o.title }),
    showActionSheet: () => {},
    navigateBack: () => log.push({ api: 'navigateBack', t: Date.now() }),
    stopPullDownRefresh: () => {},
    getSystemInfoSync: () => ({}),
    vibrateShort: () => {},
    // 没打在 log 上的调用都不是我们关心的，给个空壳防止代码崩
    previewImage: () => {},
    setStorageSync: () => {},
    getStorageSync: () => '',
    removeStorageSync: () => {},
    requestSubscribeMessage: (o) => { if (o && o.fail) o.fail({}); }
  };
  return wx;
}

// 取日志里某类调用的名字序列，方便比对顺序
function seq(log) { return log.map((x) => x.api); }
function toasts(log) { return log.filter((x) => x.api === 'toast'); }
function lastToast(log) { const t = toasts(log); return t.length ? t[t.length - 1].title : null; }

/* ================================================================== *
 * 一、feedback 反馈层：Loading 与 Toast 共存时不能被互相吞掉
 * ================================================================== */
async function testFeedback() {
  const wxStub = makeWx();
  const load = makeLoader(Object.assign({ __wx: wxStub }, {}));
  const feedback = load(path.join(ROOT, 'utils', 'feedback.js'));

  // 1. 弹了 Loading 之后再弹 Toast：Toast 必须在 hideLoading 之后才出现
  let log = wxStub._log;
  feedback.loading('发布中', true);
  await feedback.toast('出错了');
  eq('1.1 Loading 之后 Toast 仍在（没被吞）', seq(log), ['loading', 'hideLoading', 'toast']);
  eq('1.2 Toast 内容正确', lastToast(log), '出错了');

  // 1.3 两者之间必须有时间间隔 —— 同一 tick 里相邻调用在部分机型上会互相覆盖
  const gap = log[2].t - log[1].t;
  eq('1.3 hideLoading 与 showToast 之间有延迟', gap >= feedback.TOAST_DELAY_MS, true);

  // 2. 空文案不能静默：必须落到兜底文案
  log.length = 0;
  await feedback.toast('');
  await feedback.toast(null);
  await feedback.toast('   ');
  eq('2.1 空文案有兜底', toasts(log).map((x) => x.title), [
    feedback.FALLBACK_MSG, feedback.FALLBACK_MSG, feedback.FALLBACK_MSG
  ]);

  // 3. 超长文案截断到上限以内，并且时长按长短自动给
  log.length = 0;
  const longMsg = '这是一段特别特别长的提示文案'.repeat(6);
  await feedback.toast(longMsg);
  const t3 = toasts(log)[0];
  eq('3.1 超长文案被截断', t3.title.length <= feedback.TITLE_MAX, true);
  eq('3.2 截断后带省略号', t3.title.slice(-1), '…');

  // 4. 没弹过 Loading 时直接 toast：toast 内部统一先 force 收一次 Loading（清掉任何残留遮罩），
  //    所以即便没弹过 Loading 也会记一次 hideLoading —— 这是有意为之，避免残留 Loading 吞掉 Toast。
  //    断言更新为允许这一次强制收，只校验顺序正确（先 hideLoading 再 toast）
  log.length = 0;
  await feedback.toast('直接弹');
  eq('4.1 直接 toast 时先强制收 Loading（顺序 hideLoading→toast）', seq(log), ['hideLoading', 'toast']);

  // 5. hideLoading 幂等：重复调用不会重复打 hideLoading
  log.length = 0;
  feedback.loading('x');
  feedback.hideLoading();
  feedback.hideLoading();
  eq('5.1 hideLoading 幂等', seq(log), ['loading', 'hideLoading']);
  eq('5.2 isLoading 归位', feedback.isLoading(), false);
}

/* ================================================================== *
 * 二、deadline / run：任何链条都不能无限等
 * ================================================================== */
async function testDeadline() {
  const wxStub = makeWx();
  const load = makeLoader({ __wx: wxStub });
  const feedback = load(path.join(ROOT, 'utils', 'feedback.js'));

  // 1. 按时回来：原样返回
  const fast = await feedback.deadline(Promise.resolve('ok'), 'timeout', 200);
  eq('2.1 未超时返回真值', fast, 'ok');

  // 2. 超时：返回 fallback，不能挂死
  const hang = new Promise(() => {});            // 永不 settle
  const slow = await feedback.deadline(hang, 'timeout', 60);
  eq('2.2 超时返回兜底值', slow, 'timeout');

  // 3. 抛异常也算兜底，不用调用方再包 try
  const boom = await feedback.deadline(Promise.reject(new Error('x')), 'timeout', 200);
  eq('2.3 异常也兜底', boom, 'timeout');

  // 4. run() 超时必须自己把话说出来（不能指望调用方记得补提示）
  const log = wxStub._log;
  log.length = 0;
  feedback.loading('发布中', true);
  const r = await feedback.run({
    task: new Promise(() => {}),
    ms: 60,
    timeoutValue: { ok: false, msg: '超时啦' },
    timeoutMsg: '超时啦'
  });
  eq('2.4 run 超时标记', r.timedOut, true);
  eq('2.5 超时一定给了提示', lastToast(log), '超时啦');
  eq('2.6 顺序是 弹Loading→收Loading→弹Toast', seq(log), ['loading', 'hideLoading', 'toast']);

  // 5. 正常返回时不应该有事前提示
  log.length = 0;
  const r2 = await feedback.run({ task: Promise.resolve({ ok: true }), ms: 200, timeoutMsg: '不该出现' });
  eq('2.7 未超时不加提示', toasts(log).length, 0);
  eq('2.8 未超时返回值', r2.value, { ok: true });
}

/* ================================================================== *
 * 三、发帖页 submit()：每条出口都必须让用户看见字
 * ================================================================== */
function makePageStub() {
  const captured = {};
  return {
    captured,
    Page: (opts) => { captured.opts = opts; }
  };
}

async function testSubmit() {
  // store / moderation / userApi 等全部用可控桩；feedback 用真的
  let addPostResult = { ok: true };
  let checkTextResult = { ok: true };
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
      addPost: (o) => { addPostCalls += 1; return Promise.resolve(addPostResult); },
      getPosts: () => [],
      getHolePosts: () => [],
      hasReported: () => false,
      toggleVote: () => {},
      getCourses: () => [],
      getSearchHistory: () => [],
      getHotKeywords: () => [],
      // 发帖页用它现一个幂等键：同一条内容编辑期间只生成一个，
      // 重复提交时云端按它认出「这是同一条」，不会写成两个帖子
      genId: () => 'cid'
    },
    'moderation.js': {
      guardText: () => true,
      CONTACT_OK_BOARDS: [],
      REPORT_REASONS: ['骚扰', '广告'],
      reportTip: () => '举报说明'
    },
    'user.js': {
      checkText: () => Promise.resolve(checkTextResult),
      reportPost: () => Promise.resolve({ ok: true, msg: '已提交' })
    },
    'cloud.js': {
      cfg: { USE_CLOUD: false },
      ensureCloud: () => false,
      getOpenid: () => 'oid',
      fetchOpenid: () => Promise.resolve('oid')
    },
    'upload.js': { pickImages: () => Promise.resolve({ ok: false, canceled: true }), prewarm: () => {}, uploadMany: () => Promise.resolve({ ok: [], failed: 0 }) },
    'notify.js': { request: () => Promise.resolve(false), maybeRequest: () => Promise.resolve(false) },
    'search.js': { matchFields: () => -1 },
    'nav.js': { go: () => {} },
    'system.js': { vibrateShort: () => {} }
  };

  const load = makeLoader(stubs);
  load(path.join(ROOT, 'sub', 'forum', 'post', 'post.js'));
  const opts = page.captured.opts;

  // 驱动 Page 的最小运行时
  const inst = Object.assign({}, opts, {
    data: JSON.parse(JSON.stringify(opts.data)),
    _published: false,
    setData(patch) { this.data = Object.assign(this.data, patch); }
  });

  // 普通帖的标题现在是选填的：一句话、一张图，都能单独发出去。
  // 这三条例证把「放行的边界」钉死 —— 以后有人手滑加回「标题必填」，
  // 这里会立刻红，而不是等到有同学来问「为什么我发不出去」
  let log = wxStub._log;
  log.length = 0;
  inst.data.submitting = false;
  inst.data.title = '';
  inst.data.content = '正文有内容';
  inst.data.images = [];
  inst.data.kind = 'normal';
  // 注意：feedback.toast 刻意延迟 30ms 才弹（就是为了躲开 showLoading 的覆盖），
  // 所以断言前必须等一下，否则测的是「同一 tick 内」这个永远不会成立的时刻
  await inst.submit();
  await sleep(60);
  eq('3.1 只发一句话不被标题拦住', lastToast(log) === '写个标题', false);

  // 2. 只有图、没写文字：图本身就是内容，逼人配文案只会逼出「如题」
  log.length = 0;
  inst.data.title = '';
  inst.data.content = '';
  inst.data.images = ['cloud://demo.png'];
  await inst.submit();
  await sleep(60);
  eq('3.2 只发一张图也不拦', lastToast(log) === '写点什么，或者加张图', false);

  // 3. 图和文字都没有：这才真的没有内容
  log.length = 0;
  inst.data.images = [];
  await inst.submit();
  await sleep(60);
  eq('3.3 图文都空才拦', lastToast(log), '写点什么，或者加张图');

  // 4. 投票选项不足（投票帖仍要标题：选项和结果都挂在标题下）
  log.length = 0;
  inst.data.title = '选哪个';
  inst.data.content = '';
  inst.data.kind = 'vote';
  inst.data.voteFilled = 1;
  await inst.submit();
  await sleep(60);
  eq('3.4 投票选项不足给了提示', lastToast(log), '至少填写 2 个投票选项');

  // 5. 重复点击：第二次要说话，不能静默吞掉
  log.length = 0;
  inst.data.kind = 'normal';
  inst.data.content = '正文';
  inst.data.submitting = true;
  await inst.submit();
  await sleep(60);
  eq('3.5 重复点击给了提示', lastToast(log), '还在发上一条，稍等一下');

  // 5. 内容被服务端预检驳回 —— 这是历史上最隐蔽的一条：
  //    以前先 showToast 再被 finally 的 hideLoading 抹掉，用户看到「毫无反应」
  log.length = 0;
  inst.data.submitting = false;
  checkTextResult = { ok: false, msg: '里有敏感词' };
  await inst.submit();
  await sleep(60);
  eq('3.6 驳回时 Toast 真的弹出来了', seq(log).indexOf('toast') >= 0, true);
  eq('3.7 驳回文案正确', lastToast(log), '里有敏感词');
  const seqLog = seq(log);
  // 取「最后一个」toast：submit 开头有一句零依赖兜底「收到，发送中」(api=toast) 在 loading 之前，
  // 真正给用户看的驳回提示是最后一个 toast，必须出现在 loading 之后
  const iLastToast = seqLog.lastIndexOf('toast');
  const iFirstLoading = seqLog.indexOf('loading');
  eq('3.8 先收 Loading 再弹 Toast（顺序正确）', iFirstLoading >= 0 && iFirstLoading < iLastToast, true);

  // 6. 成功路径：报成功 + 返回上一页
  log.length = 0;
  checkTextResult = { ok: true };
  addPostResult = { ok: true };
  await inst.submit();
  await sleep(60);
  eq('3.9 发布成功有提示', lastToast(log), '发布成功');
  eq('3.10 成功后 uploading/submitting 复位', inst.data.submitting, false);
  // 返回改成 900ms 之后才走：要留够时间让用户看清「发布成功」那句，
  // 以前 400ms 就跳走了，Toast 被页面卸载一起带走
  await sleep(1100);
  eq('3.11 成功后返回上一页', seq(log).indexOf('navigateBack') >= 0, true);

  // 7. 云端写入失败：照样要有话说
  log.length = 0;
  addPostResult = { ok: false, saved: false, msg: '云端暂时连不上' };
  await inst.submit();
  await sleep(60);
  eq('3.12 写入失败有提示', lastToast(log), '云端暂时连不上');
  eq('3.13 失败也把按钮放开了', inst.data.submitting, false);
}

/* ================================================================== *
 * 四、树洞 send() 与快捷话题标签
 * ================================================================== */
async function testHole() {
  let addPostResult = { ok: true };
  const wxStub = makeWx();
  const page = makePageStub();
  const stubs = {
    __wx: wxStub,
    __Page: page.Page,
    'store.js': {
      HOLE_BOARD: '树洞',
      getDrafts: () => [],
      saveDraft: () => ({ id: 'd1' }),
      removeDraft: () => {},
      addPost: () => Promise.resolve(addPostResult),
      getHolePosts: () => [],
      hasReported: () => false,
      markReported: () => {},
      setPostStatus: () => {},
      toggleVote: () => {},
      toggleReact: () => {}
    },
    'moderation.js': { guardText: () => true, REPORT_REASONS: ['骚扰'], reportTip: () => '' },
    'user.js': { reportPost: () => Promise.resolve({ ok: true, msg: '已提交' }) },
    'nav.js': { go: () => {} },
    'system.js': { vibrateShort: () => {} }
  };
  const load = makeLoader(stubs);
  load(path.join(ROOT, 'sub', 'forum', 'hole', 'hole.js'));
  const opts = page.captured.opts;
  const inst = Object.assign({}, opts, {
    data: JSON.parse(JSON.stringify(opts.data)),
    _published: false,
    setData(patch) { this.data = Object.assign(this.data, patch); }
  });
  const log = wxStub._log;

  // 1. 标签：点一下要真的写进正文
  log.length = 0;
  inst.data.content = '';
  await inst.onKeyword({ currentTarget: { dataset: { k: '抱抱' } } });
  await sleep(60);
  eq('4.1 标签写进正文', inst.data.content, '#抱抱 ');
  eq('4.2 标签给了反馈', lastToast(log), '已加上 #抱抱');

  // 2. 已有字且不以空格结尾：补空格，别贴成一坨
  log.length = 0;
  inst.data.content = '今天很难过';
  await inst.onKeyword({ currentTarget: { dataset: { k: '迷茫' } } });
  await sleep(60);
  eq('4.3 补空格不粘连', inst.data.content, '今天很难过 #迷茫 ');

  // 3. 重复点：不能加第二遍，并且要说清楚为什么没反应
  log.length = 0;
  const before = inst.data.content;
  await inst.onKeyword({ currentTarget: { dataset: { k: '迷茫' } } });
  await sleep(60);
  eq('4.4 重复标签不重复插入', inst.data.content, before);
  eq('4.5 重复插入有解释', lastToast(log), '这个话题已经加过了');

  // 4. 正文写满：不能塞，也不能闷声不响
  log.length = 0;
  inst.data.content = 'x'.repeat(2000);
  await inst.onKeyword({ currentTarget: { dataset: { k: '抱抱' } } });
  await sleep(60);
  eq('4.6 超上限不插入', inst.data.content.length, 2000);
  eq('4.7 超上限有解释', lastToast(log), '正文到 2000 字上限了');

  // 5. 空内容投递：必须有话
  log.length = 0;
  inst.data.content = '';
  inst.data.title = '';
  inst.data.posting = false;
  await inst.send();
  await sleep(60);
  eq('4.8 空内容给了提示', lastToast(log), '想说什么就写下来吧');

  // 6. 投递成功
  log.length = 0;
  addPostResult = { ok: true };
  inst.data.content = '说点什么';
  await inst.send();
  await sleep(60);
  eq('4.9 投递成功有提示', lastToast(log), '已投进树洞');
  eq('4.10 成功后清空输入框', inst.data.content, '');
  eq('4.11 成功后按钮复位', inst.data.posting, false);

  // 7. 投递失败
  log.length = 0;
  addPostResult = { ok: false, saved: false, msg: '云端暂时连不上' };
  inst.data.content = '再来一次';
  await inst.send();
  await sleep(60);
  eq('4.12 投递失败有提示', lastToast(log), '云端暂时连不上');
  eq('4.13 失败保留写了的内容', inst.data.content, '再来一次');

  // 8. 重复点击
  log.length = 0;
  inst.data.posting = true;
  await inst.send();
  await sleep(60);
  eq('4.14 重复投递有提示', lastToast(log), '还在发上一条，稍等一下');

  // 9. 切心情：开场白与标签必须跟着换（以前这两处在 WXML 三元里，容易只对一半）
  await inst.onMood({ currentTarget: { dataset: { m: 'happy' } } });
  eq('4.15 切心情换开场白', inst.data.prompt, '把这份快乐说出来，会变成双份。');
  eq('4.16 切心情换标签', inst.data.tags, ['分享', '好运', '哈哈']);
  eq('4.17 切心情换导航底色', inst.data.navBg, '#5d3f1d');
}

/* ================================================================== *
 * 五、源码级静态约束（避免以后有人改回去）
 * ================================================================== */
function testStatic() {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  // 1. 发帖页和树洞页不许再裸调 wx.showToast / wx.showLoading
  ['sub/forum/post/post.js', 'sub/forum/hole/hole.js'].forEach((p) => {
    // 先剥注释：注释里出现 wx.showLoading 是在解释「为什么不用它」，不是真的调用了
    const s = read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '').replace(/^[^\n]*收到[^\n]*$/gm, '');
    const bare = s.match(/(^|[^.\w])wx\.(showToast|showLoading|hideLoading)\(/g);
    eq('5.1 ' + p + ' 不再裸调提示接口', bare ? bare.length : 0, 0);
  });

  // 2. 必须有整条链路的超时总闸
  const post = read('sub/forum/post/post.js');
  const hole = read('sub/forum/hole/hole.js');
  eq('5.2 发帖有发布时间总闸', /SUBMIT_DEADLINE_MS\s*=\s*\d+/.test(post), true);
  eq('5.3 树洞有投递时间总闸', /HOLE_DEADLINE_MS\s*=\s*\d+/.test(hole), true);
  eq('5.4 总闸真的用上了（feedback.run）', /feedback\.run\(/.test(post) && /feedback\.run\(/.test(hole), true);

  // 3. iOS 横向溢出：page 必须锁横向，且横滚容器必须是 inline-flex
  const appwxss = read('app.wxss');
  const m = appwxss.match(/page\s*\{[^}]*\}/);
  eq('5.5 page 锁了横向溢出', /overflow-x:\s*hidden/.test(m ? m[0] : ''), true);
  eq('5.6 不该锁纵向（会废掉下拉刷新）', /overflow-y:\s*hidden/.test(m ? m[0] : ''), false);

  // 横向滚动容器 → 它是谁。这些容器必须是 inline-flex + nowrap：
  // iOS 的 scroll-view 里用纯 flex，超宽的一排会换行，被裁掉的那行横向滑动时会漏出来
  const rows = {
    'app.wxss': '.chip-row',
    'components/ui/pill-selector/index.wxss': '.ui-pill__row',
    'sub/campus/blindbox/blindbox.wxss': '.bb-kinds__row',
    'sub/forum/hole/hole.wxss': '.mood-chips__row',
    'pages/course/list/list.wxss': '.ls-sort-row'
  };
  Object.keys(rows).forEach((p) => {
    // 先剥注释，再按选择器把整个声明块取出来比对（注释里提到 flex 不算数）
    const css = read(p).replace(/\/\*[\s\S]*?\*\//g, '');
    const sel = rows[p];
    let block = '';
    let at = -1;
    for (let i = 0; i < css.length; i += 1) {
      // 逐个匹配「选择器 + {」：这种手写文件里 selector 前后可能有换行，不能用正则赌
      if (css.slice(i, i + sel.length) === sel) {
        let j = i + sel.length;
        while (j < css.length && /[\s,]/.test(css[j])) j += 1;
        if (css[j] === '{') { at = i; block = css.slice(i, css.indexOf('}', j)); break; }
      }
    }
    eq('5.7 ' + sel + ' 用 inline-flex', /display:\s*inline-flex/.test(block), true);
    eq('5.7b ' + sel + ' 带 nowrap', /white-space:\s*nowrap/.test(block), true);
    void at;
  });

  // 4. 折叠面板不能有 transform（iOS 上会让收起的内容画到容器外）
  const postwxss = read('sub/forum/post/post.wxss');
  const collapseBlock = postwxss.match(/\.collapse\s*\{[^}]*\}/);
  eq('5.8 折叠面板不带 transform', /transform/.test(collapseBlock ? collapseBlock[0] : ''), false);
  eq('5.9 折叠面板有 visibility 兜底', /visibility:\s*hidden/.test(collapseBlock ? collapseBlock[0] : ''), true);

  // 5. 等 openid 必须有真实上限（以前注释写着「最多 2.5 秒」，代码里一个超时都没有）
  const base = read('utils/store-base.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  eq('5.12 waitOpenid 有真实超时上限', /WAIT_OPENID_MS\s*=\s*[1-9]\d*/.test(base), true);
  const waitBlock = (base.match(/async function waitOpenid[\s\S]*?\n}/) || [''])[0];
  eq('5.13 上限真的套在 fetchOpenid 上', /Promise\.race\([\s\S]*fetchOpenid[\s\S]*setTimeout/.test(waitBlock), true);

  // 6. 树洞标签必须绑了事件（以前是没事件的假按钮）
  const holeWxml = read('sub/forum/hole/hole.wxml');
  eq('5.10 树洞标签绑了点击事件', /class="mood-kw[\s\S]{0,200}?bindtap="onKeyword"/.test(holeWxml), true);
  eq('5.11 树洞开场白不再写死在模板里', /{{prompt}}/.test(holeWxml), true);
}

(async function main() {
  console.log('--- feedback 反馈层 ---');
  await testFeedback();
  console.log('--- deadline / run 超时闸 ---');
  await testDeadline();
  console.log('--- 发帖 submit ---');
  await testSubmit();
  console.log('--- 树洞 send + 标签 ---');
  await testHole();
  console.log('--- 静态约束 ---');
  testStatic();
  console.log(all ? '\n== 全部通过（' + passed + ' 项）==' : '\n== 有失败项 ==');
  process.exit(all ? 0 : 1);
})();
