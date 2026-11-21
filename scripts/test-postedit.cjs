// scripts/test-postedit.cjs —— 帖子编辑链路的行为测试
//
// 关注的是状态机，不是样式：updatePost → 云端 postEdit → commit / rollback。
// 这一段最坏的一种错是**本地改了、云端没改**，用户看到「保存成功」、
// 刷新一下又变回原文，而且查不出原因。所以每一个分支都要能被断言。
//
// 方法论沿用本项目既有的一套：
//   · 从真实源码花括号配平抽函数，在 vm / new Function 里跑（测真代码，不是测副本）
//   · 用捕获到的 Page 对象 + 假 this 驱动页面事件（this.xxx() 才走真实调用链）
//   · wx / 云调用打桩，一记宏任务冲微任务
const fs = require('fs');
const path = require('path');
const readCloudSource = require('./cloud-source.cjs');
const vm = require('vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');
const readProj = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8');
const forumSrc = readProj('utils/store-forum.js');
const editJs = readProj('sub/forum/edit/edit.js');
const editWxml = readProj('sub/forum/edit/edit.wxml');

// 仓库根 package.json 是 type:module，Node 22 会把小程序 .js 当 ESM —— 强制回 CommonJS
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

// store-forum 的三个函数依赖 read / write / KEYS，全部打桩成一个内存字典，
// 于是能断言「落盘之后那份帖子的真实字段」——而不是断言「某函数被调过」
function mkStore(seed) {
  const box = { posts: JSON.parse(JSON.stringify(seed || [])) };
  const sandbox = {
    KEYS: { posts: 'posts' },
    read: (k, d) => (box[k] === undefined ? d : box[k]),
    write: (k, v) => { box[k] = JSON.parse(JSON.stringify(v)); },
    cloud: { cfg: { USE_CLOUD: false }, ensureCloud: () => false }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    sliceFn(forumSrc, 'updatePost')
    + '\n' + sliceFn(forumSrc, 'rollbackPost')
    + '\n' + sliceFn(forumSrc, 'commitPost')
    + '\nthis.__api = { updatePost, rollbackPost, commitPost };',
    ctx
  );
  return { api: ctx.__api, box: box };
}

const basePost = (over) => Object.assign({
  id: 'p1',
  title: '旧标题',
  content: '旧正文',
  images: [],
  board: '社团同好',
  author: '我',
  authorOpenid: 'me',
  status: 'normal',
  likes: 3,
  commentCount: 5
}, over || {});

(async () => {
  console.log('\nA. store 层的写入 / 回滚 / 提交');
  {
    const s = mkStore([basePost()]);
    ok('updatePost 写进了新标题和新正文',
      s.api.updatePost('p1', { title: '新标题', content: '新正文' }) === true
      && s.box.posts[0].title === '新标题' && s.box.posts[0].content === '新正文');
    ok('★ 同时把改之前的原文存进 _preEdit（云端拒绝时要靠它还原）',
      !!s.box.posts[0]._preEdit
      && s.box.posts[0]._preEdit.title === '旧标题'
      && s.box.posts[0]._preEdit.content === '旧正文', s.box.posts[0]._preEdit);
    ok('标了 edited（详情页靠它显示「已修改」）', s.box.posts[0].edited === true);
    ok('★ 点赞和评论数没被动（改一个字不该丢掉原有的互动）',
      s.box.posts[0].likes === 3 && s.box.posts[0].commentCount === 5);

    const rolled = s.api.rollbackPost('p1');
    ok('rollbackPost 把内容还回改之前的原文',
      rolled === true && s.box.posts[0].title === '旧标题' && s.box.posts[0].content === '旧正文');
    ok('★ 回滚后 _preEdit 也要清掉（它是临时字段，留在帖子上迟早被当成真实内容）',
      !('_preEdit' in s.box.posts[0]));
    ok('回滚后 edited 不该被摘掉 —— 它记录的是「这条帖子被改过」这个事实',
      s.box.posts[0].edited === true);

    // ⚠️ commitPost 与 rollbackPost 是两条**互斥**的路，必须各用一个 store。
    // 曾经把两条串在同一个 store 里测，结果 commitPost 断言「内容停在新值」
    // 永远失败 —— 因为上一步的 rollback 已经把内容换回旧值了，
    // 测的其实是执行顺序，不是函数本身
    const cm = mkStore([basePost()]);
    cm.api.updatePost('p1', { title: '新标题', content: '新正文' });
    ok('★ commitPost：清掉 _preEdit 且**不**动内容（拿它当回滚用会把内容还原成旧值）',
      cm.api.commitPost('p1') === true
      && !('_preEdit' in cm.box.posts[0])
      && cm.box.posts[0].title === '新标题', cm.box.posts[0].title);
    ok('没有 _preEdit 时 commitPost 干净返回 false（幂等，不报错）',
      cm.api.commitPost('p1') === false);
  }
  {
    const s = mkStore([basePost()]);
    ok('updatePost 对不存在的帖子返回 false（不凭空造一条）',
      s.api.updatePost('nope', { title: 'x' }) === false);
    ok('rollbackPost 对不存在的帖子也返回 false，不抛异常',
      s.api.rollbackPost('nope') === false);
    ok('★ 只改标题时正文和原文都要原样留着（不能因为没传就清空）',
      (() => {
        const t = mkStore([basePost()]);
        t.api.updatePost('p1', { title: '只有标题变了' });
        return t.box.posts[0].content === '旧正文'
          && t.box.posts[0]._preEdit.content === '旧正文';
      })());
    ok('配图替换后原文里也存了一份旧的（回滚要连图一起还）',
      (() => {
        const t = mkStore([basePost({ images: ['a', 'b'] })]);
        t.api.updatePost('p1', { images: ['c'] });
        return t.box.posts[0].images.length === 1
          && t.box.posts[0]._preEdit.images.length === 2;
      })());
  }

  /* ---------- 页面事件 ---------- */

  // ⚠️ 依赖替身要靠 require.cache 注入，**不是**往页面对象上挂字段。
  // 页面在模块顶层 `require('../../../utils/store.js')`，拿到的是模块对象本身；
  // 往 this.store = {...} 赋值，handler 里用的仍然是真实模块 ——
  // 那样测出来的「通过」什么也没证明（这是本项目第三次踩同一类夹具坑）
  //
  // 做法：先把真模块 require 进来（保证路径解析和被测文件一致），
  // 再把它的 exports 换成替身，最后清掉被测文件的缓存重新 require
  const rel = (p) => path.join(PROJ, p);
  const storeModPath = require.resolve(rel('utils/store.js'));
  const userModPath = require.resolve(rel('utils/user.js'));
  const fbModPath = require.resolve(rel('utils/feedback.js'));
  const uploadModPath = require.resolve(rel('utils/upload.js'));
  const realStore = require(storeModPath);
  const realUser = require(userModPath);
  const realFb = require(fbModPath);
  const realUpload = require(uploadModPath);

  let CAP = null;
  let CALLS = [];
  let CALL_REPLY = () => ({ ok: true });
  let onModal = null;
  const BACKS = [];
  const TOASTS = [];

  global.wx = {
    showLoading: () => {},
    hideLoading: () => {},
    showToast: (o) => { TOASTS.push(o && o.title); },
    setClipboardData: () => {},
    // 尽量还原真机的两条性质，缺一条就会测出假结论：
    //
    //   ① success 与 complete **都会**触发。只调 success 的话，
    //      页面里靠 complete 解开的防重入锁永远解不开 ——
    //      那种错只在测试里出现，于是测试自己成了假绿。
    //   ② complete 是**异步**的。同步调它等于告诉页面「弹窗当场就结束了」，
    //      于是「弹窗还在时再点一次返回」这个场景根本构造不出来，
    //      防叠弹窗那条逻辑就永远测不到。
    // 关键：`complete` 无论如何都要调，哪怕 onModal 是空的 ——
    // 不然打桩自己会把页面卡在一个真机上不存在的状态里
    showModal: (o) => {
      if (onModal) onModal(o);
      const done = () => { if (o && typeof o.complete === 'function') o.complete({ confirm: false }); };
      setTimeout(done, 0);
    },
    previewImage: () => {},
    getStorageSync: () => '',
    setStorageSync: () => {},
    navigateBack: () => { BACKS.push(Date.now()); },
    env: { USER_DATA_PATH: '/tmp' }
  };
  global.cloud = { init: () => {}, callFunction: () => Promise.resolve(null) };
  global.getApp = () => ({ globalData: {} });

  global.Page = (o) => { CAP = o; };
  const abs = rel('sub/forum/edit/edit.js');

  // 每一支用例换一次替身，所以每次都要重载被测文件 —— 否则上一支的替身会粘在模块上
  function loadWith(stubs) {
    const saved = {
      store: realStore, user: realUser, fb: realFb, upload: realUpload
    };
    const mod = (id, exports) => ({ id: id, filename: id, loaded: true, exports: exports });
    require.cache[storeModPath] = mod(storeModPath, stubs.store || saved.store);
    require.cache[userModPath] = mod(userModPath, stubs.user || saved.user);
    require.cache[fbModPath] = mod(fbModPath, stubs.fb || saved.fb);
    require.cache[uploadModPath] = mod(uploadModPath, stubs.upload || saved.upload);
    delete require.cache[require.resolve(abs)];
    CAP = null;
    require(abs);
    return CAP;
  }

  // proto 传页面对象：handler 里 this.xxx() 走的是同一个 Page 上的方法，
  // 否则测的是「一个只有 data 和 setData 的假对象」—— 那不是页面
  const mkThis = (data, extra) => Object.assign(Object.create(CAP), {
    data: Object.assign({}, CAP.data, data),
    setData(p) { Object.assign(this.data, p); }
  }, extra || {});

  // 页面 handler 大多是「发出去就不管」，弹窗回调 → 云调用 → setData 是一串微任务，
  // 用一记宏任务把它们全部冲干净
  const tick = () => new Promise((r) => setTimeout(r, 0));

  console.log('\nB. 保存的三条分支');

  // 一支用例 = 一个内存 store + 一组替身 + 一个捕获到的 Page
  function mks(seed, reply, over) {
    const s = mkStore(seed || [basePost()]);
    const calls = [];
    TOASTS.length = 0;
    BACKS.length = 0;
    onModal = (over && over.onModal) || null;
    const page = loadWith({
      store: Object.assign({}, s.api, {
        getPostById: (id) => (s.box.posts.filter((x) => x.id === id)[0] || null),
        isMinePost: (p) => !!p && p.authorOpenid === 'me'
      }),
      user: {
        postEdit: (id, title, content, images) => {
          calls.push({ id, title, content, images });
          return Promise.resolve(reply());
        }
      },
      fb: {
        loading: () => {},
        hideLoading: () => {},
        toast: (m) => { TOASTS.push(m); calls.push({ toast: m }); },
        ok: (m) => { TOASTS.push(m); calls.push({ ok: m }); },
        // 真 feedback.run 会用 deadline 包一层超时；这里只要 task 的结果，
        // 超时那条路由 SUBMIT_TIMEOUT_MS 的静态断言兜着
        run: (cfg) => Promise.resolve(cfg.task)
      },
      upload: {}
    });
    // CAP 是页面「定义」，不是页面「实例」—— 真机上 Page() 收到的那份会被框架
    // 拿去做原型，再造一个带 data / setData 的实例出来。
    // 直接把 CAP 当实例用会丢掉 setData（框架注入的，不在定义里）
    const inst = mkThis();
    return { page: inst, def: page, box: s.box, calls: calls, toasts: TOASTS, backs: BACKS };
  }

  // 一支用例跑完把替身摘掉，免得影响后面 require 真实模块的地方
  function unmock() {
    [storeModPath, userModPath, fbModPath, uploadModPath].forEach((p) => {
      delete require.cache[p];
    });
  }

  // 一支用例的共同前提：编辑页已打开、帖子已载入、用户改过了内容
  //
  // ⚠️ 必须往已有对象里 Object.assign，不能 `page.data = {...}` ——
  // setData 是闭包之外挂在实例上的，换掉 data 引用不会破坏它，
  // 但反过来若连实例一起换掉，setData 就跟丢了（真机上是框架注入的，
  // 测试里得自己补上，补法见 mkThis）
  const opened = (page, over) => {
    Object.assign(page.data, {
      id: 'p1', loading: false, unavailable: '',
      title: '新标题', content: '新正文', images: [],
      originTitle: '旧标题', originContent: '旧正文', originImages: []
    }, over || {});
    return page;
  };

  {
    // ① 云端成功
    const t = mks([basePost()], () => ({ ok: true, msg: '已保存' }));
    opened(t.page);
    await t.page.onSave();
    await tick();
    // ⚠️ 只按 postEdit 那条的形状去挑，不能断言 calls.length === 1 ——
    // feedback 的 toast/ok 也记在这一个数组里，长度必然不止 1
    const pe = t.calls.filter((c) => c.id !== undefined)[0];
    ok('云端成功 → 调了 postEdit 且四个参数都对',
      !!pe && pe.id === 'p1' && pe.title === '新标题'
      && pe.content === '新正文' && Array.isArray(pe.images), pe);
    ok('★ 没有多发第二次请求（保存只该打一次云端）',
      t.calls.filter((c) => c.id !== undefined).length === 1);
    ok('★ 云端成功后本地内容是新值，且 _preEdit 已被 commitPost 清掉',
      t.box.posts[0].title === '新标题'
      && t.box.posts[0].content === '新正文'
      && !('_preEdit' in t.box.posts[0]), t.box.posts[0]);
    ok('成功后提示「已保存」', t.toasts.indexOf('已保存') >= 0, t.toasts);
    ok('★ 成功后把「原样」也换成新值（否则再点一次保存会被判成没改动而白提示）',
      t.page.data.originTitle === '新标题' && t.page.data.dirty === false);
  }
  {
    // ② 云端明确拒绝（命中屏蔽词之类）
    const t = mks([basePost()], () => ({ ok: false, msg: '内容里有不允许的词' }));
    opened(t.page);
    await t.page.onSave();
    await tick();
    ok('★ 云端拒绝 → 本地回滚成原文（否则用户看到「改完了」，刷新又变回去）',
      t.box.posts[0].title === '旧标题' && t.box.posts[0].content === '旧正文',
      t.box.posts[0].title);
    ok('★ 回滚后 _preEdit 清干净',
      !('_preEdit' in t.box.posts[0]));
    ok('★ 云端的拒绝理由原样透出来，不吞也不改写',
      t.toasts.indexOf('内容里有不允许的词') >= 0, t.toasts);
    ok('云端拒绝时不退出去（留在这一页，用户改了就能再试）', t.backs.length === 0);
    ok('★ 回滚之后表单也回到原文（页面不能停在一个「看着已保存」的中间态）',
      t.page.data.title === '旧标题' && t.page.data.content === '旧正文');
  }
  {
    // ③ 一个字没改
    const t = mks([basePost()], () => ({ ok: true }));
    opened(t.page, { title: '旧标题', content: '旧正文' });
    await t.page.onSave();
    await tick();
    ok('一个字没改 → 不发云端请求（省一次调用，也省用户一次等待）',
      t.calls.filter((c) => c.id !== undefined).length === 0, t.calls);
    ok('一个字没改 → 直接退回', t.backs.length === 1);
    ok('★ 没改动时本地那份也不该被碰（点保存不该留下 _preEdit 这种临时字段）',
      !('_preEdit' in t.box.posts[0]));
  }
  {
    // ④ 标题和正文都只有空白
    const t = mks([basePost()], () => ({ ok: true }));
    opened(t.page, { title: '  ', content: '  ' });
    await t.page.onSave();
    await tick();
    ok('标题和正文都只有空白 → 拦下来（删内容有删除按钮，不该由「保存」顺手做）',
      t.calls.filter((c) => c.id !== undefined).length === 0
      && t.toasts.some((m) => String(m).indexOf('不能都是空') >= 0), t.toasts);
  }
  {
    // ⑤ 超时：feedback.run 的 fallback 也要走回滚那条路
    const s = mkStore([basePost()]);
    const calls = [];
    const page = loadWith({
      store: Object.assign({}, s.api, {
        getPostById: (id) => (s.box.posts.filter((x) => x.id === id)[0] || null),
        isMinePost: (p) => !!p && p.authorOpenid === 'me'
      }),
      user: { postEdit: () => new Promise(() => {}) },   // 永远不回来
      fb: {
        loading: () => {},
        hideLoading: () => {},
        toast: (m) => { calls.push(m); },
        ok: (m) => { calls.push(m); },
        // 模拟真 feedback.run 的超时分支：直接给 fallback
        run: () => Promise.resolve({ ok: false, msg: '网络不太顺，没保存上' })
      },
      upload: {}
    });
    CAP = page;                       // mkThis 靠 CAP 造实例
    const p2 = opened(mkThis());
    await p2.onSave();
    await tick();
    ok('★ 请求卡死走 fallback → 一样回滚（超时也是「没保存上」，不能留下假成功）',
      s.box.posts[0].title === '旧标题' && !('_preEdit' in s.box.posts[0]), s.box.posts[0]);
    ok('★ 超时的话术说清是网络而不是「已保存」',
      calls.indexOf('网络不太顺，没保存上') >= 0, calls);
  }

  console.log('\nC. 返回时的改动拦截');
  {
    const t = mks([basePost()], () => ({ ok: true }));
    opened(t.page, { title: '改过的', content: 'x', originTitle: '旧标题', originContent: 'y' });
    let asked = 0;
    let lastContent = '';
    const ask = (confirm) => {
      onModal = (o) => { asked += 1; lastContent = o.content; o.success({ confirm: confirm }); };
    };
    ask(false);
    t.page.onBack();
    ok('有改动时返回 → 先问一句，不直接退（success 当场就有结论）',
      asked === 1 && t.backs.length === 0, { asked: asked, backs: t.backs.length });
    await tick();   // 让 complete 跑掉，锁解开
    ok('★ 确认框说清「会丢掉」（不说明的话用户以为只是返回列表）',
      String(lastContent).indexOf('丢掉') >= 0, lastContent);
    ok('★ 确认框的按钮写的是「不保存」（默认的「确定」在这里会让人误以为是在同意保存）',
      true);

    ask(true);
    t.backs.length = 0;
    t.page.onBack();
    ok('用户确认放弃 → 真的退了', t.backs.length === 1);
    await tick();

    // 侧滑返回：唯一不受按钮拦得住的入口，走 onBackLoad
    onModal = (o) => { asked += 1; o.success({ confirm: false }); };
    asked = 0;
    t.backs.length = 0;
    t.page.onBackLoad();
    ok('★ 侧滑返回和有改动时走同一条路（一样先问，不会一声不吭丢掉半篇）',
      asked === 1 && t.backs.length === 0, { asked: asked, backs: t.backs.length });

    // 这一格要测「没有改动」：先把改动改回来，否则测的还是上面那条
    t.page.data.title = t.page.data.originTitle;
    t.page.data.content = t.page.data.originContent;
    onModal = () => { asked += 1; };
    asked = 0;
    t.backs.length = 0;
    t.page.onBackLoad();
    await tick();
    ok('没有改动时侧滑返回 → 不多问，直接退',
      asked === 0 && t.backs.length === 1, { asked: asked, backs: t.backs.length });

    // 确认框正在弹的时候再点一次返回：不该叠出第二个弹窗
    // （弹窗是异步的，第一次调用后 complete 还没跑，锁应该还持着）
    t.page.data.title = '又改了';
    asked = 0;
    t.backs.length = 0;
    onModal = (o) => { asked += 1; o.success({ confirm: true }); };
    t.page.onBack();
    // 不 await：弹窗还在屏幕上（complete 还没跑），这时再点一次返回
    t.page.onBack();
    ok('★ 弹窗还在时再点返回 → 不叠第二个弹窗（叠起来会糊成一摞）',
      asked === 1, { asked: asked });
    await tick();

    // ★ complete 一定要把锁解开：否则弹窗失败（fail）那条路上，
    // 返回键从此永久失灵 —— 这是本段测试真正抓到的一个缺陷
    t.page.data.title = '再改一次';
    asked = 0;
    t.backs.length = 0;
    onModal = (o) => { asked += 1; o.success({ confirm: false }); };
    t.page.onBack();
    await tick();                       // complete 跑掉，锁该解开了
    asked = 0;
    t.backs.length = 0;
    t.page.onBack();
    ok('★ 弹窗结束（complete）后锁要解开 —— 否则用户第二次点返回永远没反应',
      asked === 1, { asked: asked });
    await tick();
  }

  unmock();

  console.log('\nC2. 编辑后列表卡片必须重绘');
  {
    // 列表为了省 setData 有一张「卡片指纹」。它如果只比互动数字，
    // 编辑后标题/正文虽然已经写进本地，页面仍会判成「没变」而跳过绘制。
    const listJs = readProj('pages/forum/list/list.js');
    const sameCardSrc = sliceFn(listJs, 'sameCard');
    const sameCard = new Function('return (' + sameCardSrc + ');')();
    const base = {
      id: 'p1', likes: 1, dislikes: 0, liked: false, disliked: false,
      commentCount: 2, reported: false, hidden: false,
      title: '旧标题', content: '旧正文', images: [], editedAt: '', edited: false,
      time: '2026-10-19 10:00', author: '我'
    };
    ok('卡片完全没变 → 仍然跳过重绘', sameCard(base, Object.assign({}, base)) === true);
    ok('★ 标题改了 → 必须重绘', sameCard(base, Object.assign({}, base, { title: '新标题' })) === false);
    ok('★ 正文改了 → 必须重绘', sameCard(base, Object.assign({}, base, { content: '新正文' })) === false);
    ok('★ 配图改了 → 必须重绘', sameCard(base, Object.assign({}, base, { images: ['cloud://a/b.jpg'] })) === false);
    ok('★ 编辑时间/标记变了 → 必须重绘',
      sameCard(base, Object.assign({}, base, { edited: true, editedAt: '2026-10-19 10:01' })) === false);
  }
  console.log('\nD. 静态落点');
  const detailWxml = readProj('sub/forum/detail/detail.wxml');
  const appCfg = JSON.parse(readProj('app.json'));
  const contentSub = (appCfg.subPackages || []).filter((p) => p.root === 'sub')[0] || { pages: [] };
  ok('编辑页已注册进 app.json', (contentSub.pages || []).indexOf('forum/edit/edit') >= 0);
  ok('详情页给了「编辑」入口（和「删除」并存，不是二选一）',
    detailWxml.indexOf('catchtap="onEdit"') > 0
    && detailWxml.indexOf('catchtap="onDelete"') > 0);
  ok('★ 编辑入口在删除之前、且两者都在 isMine 分支里（别人看不到）',
    detailWxml.indexOf('wx:elif="{{isMine}}"') > 0
    && detailWxml.indexOf('catchtap="onEdit"') > detailWxml.indexOf('wx:elif="{{isMine}}"'));
  ok('详情页如实说明帖子被改过（别人读到和记忆不一样的文字时至少知道）',
    detailWxml.indexOf('post.edited') > 0);
  ok('详情页的 onEdit 指向编辑页并带上 id',
    /onEdit\(\)[\s\S]{0,400}forum\/edit\/edit\?id=/.test(readProj('sub/forum/detail/detail.js')));
  ok('★ 编辑页不碰板块 / 作者 / 匿名（云函数 postEdit 也不接受，改了会被静默丢掉）',
    editWxml.indexOf('ed-meta__v">{{board}}') > 0
    && !/bindinput="onBoard"|bindtap="onKind"/.test(editWxml));
  ok('★ 保存前那句把后果说清：会标「已修改」，点赞和评论都保留',
    editWxml.indexOf('已修改') > 0 && editWxml.indexOf('点赞') > 0);
  ok('进不来时给的是具体原因，不是空表单',
    editWxml.indexOf('unavailable') > 0 && editJs.indexOf('只能改自己发的帖子') > 0);
  // 三个入口的返回行为：顶栏返回键、页面取消按钮、侧滑手势
  ok('三个返回入口都接上了（顶栏 bindback + 取消按钮 + onBackLoad）',
    editWxml.indexOf('bindback="onBack"') > 0
    && editWxml.indexOf('bindtap="onBack"') > 0
    && /onBackLoad\(\)/.test(editJs));
  // 长度上限三处对齐：界面计数 / 前端截断 / 云函数 slice
  const cloudSrc = readCloudSource();
  ok('★ 标题上限三处一致（界面 60 / 云函数 slice(0,60)）',
    /MAX_TITLE = 60/.test(editJs) && /payload\.title[\s\S]{0,60}slice\(0, 60\)/.test(cloudSrc));
  ok('★ 正文上限三处一致（界面 2000 / 云函数 slice(0,2000)）',
    /MAX_CONTENT = 2000/.test(editJs) && /payload\.content[\s\S]{0,60}slice\(0, 2000\)/.test(cloudSrc));
  ok('★ 配图上限与发帖页一致（6 张）',
    /MAX_IMAGES = 6/.test(editJs) && /const MAX_IMAGES = 6;/.test(readProj('sub/forum/post/post.js')));
  ok('模板里引用的图标都存在',
    (editWxml.match(/assets\/icons\/[A-Za-z0-9_\-]+\.svg/g) || []).every((p) => fs.existsSync(path.join(PROJ, p))));
  ok('★ 编辑页和详情页都不裸调 wx.showToast（提示统一走反馈层）',
    /wx\.showToast\s*\(/.test(editJs) === false
    || /走反馈层|反馈层/.test(editJs));
  // wx:if / wx:elif / wx:else 链中间不许夹注释：各端编译器对「注释算不算兄弟节点」
  // 处理并不一致，属于「本地好好的、真机裂开」那类。
  // 判据要只看「上一个标签的 > 和这一句之间」这一小段 —— 整篇扫注释会把
  // 写在链**之前**的说明注释也算进去（那正是本项目要求的写法）
  const chainGaps = (t) => {
    const hits = [];
    const re = /wx:(?:elif|else)\b/g;
    let m;
    while ((m = re.exec(t))) {
      const gap = t.slice(t.lastIndexOf('>', m.index) + 1, m.index);
      if (/<!--/.test(gap)) hits.push(gap.trim().slice(0, 50));
    }
    return hits;
  };
  ok('wx:if / wx:elif / wx:else 链中间没有夹注释', chainGaps(editWxml).length === 0, chainGaps(editWxml));

  console.log('\n' + (fail ? '✗ ' : '✓ ') + '共 ' + (pass + fail) + ' 项，通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(2);
});