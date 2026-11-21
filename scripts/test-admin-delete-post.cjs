// scripts/test-admin-delete-post.cjs —— 审核员在帖子详情页直接删除
//
// 场景：管理员看到违规帖子，不必先「举报自己/别人 → 再去举报队列审核」，
// 在详情页就能直接删。这里钉住四件事：
//   ① 入口只对审核员、且不是作者本人时出现（作者已有普通「删除」）；
//   ② 点确认后走的是 store.deletePost(id, true)，不是举报；
//   ③ 云端失败时本地不删、不跳页，并显示真实原因；
//   ④ 云端成功后才返回，且云函数会连带清理留言和留言赞踩记录。
//
// 权限边界必须记住：按钮显隐只是体验，真正能不能删由云函数 delContent 再判一次。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const read = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8');
const detailJs = read('sub/forum/detail/detail.js');
const detailWxml = read('sub/forum/detail/detail.wxml');
const detailWxss = read('sub/forum/detail/detail.wxss');
const forumSrc = read('utils/store-forum.js');
const cloudSrc = require('./cloud-source.cjs')();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra))); }
};

// 从真实源码里按花括号配平取一段。跳过字符串 / 模板串 / 注释，避免注释里的
// 花括号把截取位置带偏（本项目的注释很密，这不是理论问题）。
function takeBlock(text, braceAt) {
  let depth = 0;
  for (let i = braceAt; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === q) break;
        i += 1;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i + 2);
      if (i < 0) break;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(braceAt, i + 1);
    }
  }
  throw new Error('花括号没有配平');
}

function sliceFunction(text, name) {
  const re = new RegExp('(^|\\n)(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(text);
  if (!m) throw new Error('找不到函数 ' + name);
  const brace = text.indexOf('{', m.index + m[0].length);
  return text.slice(m.index, brace) + takeBlock(text, brace);
}

function sliceMethod(text, name) {
  const re = new RegExp('\\n  ' + name + '\\s*\\(');
  const m = re.exec(text);
  if (!m) throw new Error('找不到方法 ' + name);
  const start = m.index + 1;
  const brace = text.indexOf('{', m.index + m[0].length);
  return text.slice(start, brace) + takeBlock(text, brace);
}

const methodText = sliceMethod(detailJs, 'onAdminDelete');

function pageHarness(opts) {
  const o = opts || {};
  const calls = { modals: [], toasts: [], loadings: [], hidings: 0, buzzes: 0, deletes: [], timers: [], backs: [], switches: [] };
  const store = {
    deletePost: (id, force) => {
      calls.deletes.push({ id: id, force: force });
      if (o.deleteThrows) return Promise.reject(new Error('network'));
      return Promise.resolve(o.deleteResult === undefined ? { ok: true } : o.deleteResult);
    }
  };
  const feedback = {
    loading: (...args) => calls.loadings.push(args),
    hideLoading: () => { calls.hidings += 1; },
    toast: (msg, opt) => calls.toasts.push({ msg: msg, opt: opt }),
    buzz: () => { calls.buzzes += 1; }
  };
  const wx = {
    showModal: (cfg) => calls.modals.push(cfg),
    navigateBack: (cfg) => calls.backs.push(cfg),
    switchTab: (cfg) => calls.switches.push(cfg)
  };
  const setTimeoutStub = (fn, ms) => { calls.timers.push({ fn: fn, ms: ms }); return calls.timers.length; };
  const fn = new Function('store', 'feedback', 'wx', 'setTimeout',
    'return ({' + methodText + '}).onAdminDelete;')(store, feedback, wx, setTimeoutStub);
  const page = {
    data: { isMod: o.isMod !== false, post: { id: 'p1' }, id: 'p1' },
    onAdminDelete: fn
  };
  return { page: page, calls: calls };
}

function storeHarness(cloudOk) {
  const box = {
    posts: [{ id: 'p1', openid: 'other', authorOpenid: 'other', title: '别人的帖子' }]
  };
  const tombstones = [];
  const cloudCalls = [];
  const sandbox = {
    KEYS: { posts: 'posts' },
    read: (key, dflt) => (box[key] === undefined ? dflt : JSON.parse(JSON.stringify(box[key]))),
    write: (key, value) => { box[key] = JSON.parse(JSON.stringify(value)); },
    myOpenid: () => 'me',
    addTombstone: (key, id) => tombstones.push({ key: key, id: id }),
    cloud: { cfg: { USE_CLOUD: true }, ensureCloud: () => true },
    require: (name) => {
      if (name !== './user.js') throw new Error('unexpected require ' + name);
      return {
        delContent: (type, id) => {
          cloudCalls.push({ type: type, id: id });
          return Promise.resolve(cloudOk === false ? { ok: false, msg: '没有权限删除这条内容' } : { ok: true });
        }
      };
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    sliceFunction(forumSrc, 'removeOnCloud') + '\n'
    + sliceFunction(forumSrc, 'deletePost') + '\n'
    + 'this.__api = { deletePost: deletePost };',
    sandbox
  );
  return { api: sandbox.__api, box: box, tombstones: tombstones, cloudCalls: cloudCalls };
}

(async () => {
  console.log('\nA. 入口与静态契约');
  ok('详情页有管理员删除入口', /catchtap="onAdminDelete"/.test(detailWxml));
  ok('入口只给审核员、且排除作者本人（作者已有普通删除）',
    /wx:if="\{\{isMod && !isMine\}\}"[^>]*catchtap="onAdminDelete"/.test(detailWxml));
  ok('入口用危险色样式，且该样式真实存在',
    /detail__op--warn/.test(detailWxml) && /\.detail__op--warn\s*\{/.test(detailWxss));
  ok('审核员身份由云函数 whoami 返回',
    /userApi\.whoami\(\)/.test(detailJs) && /me\.isMod/.test(detailJs));
  ok('管理员删除走 store.deletePost(id, true)，不是举报',
    /store\.deletePost\(this\.data\.id,\s*true\)/.test(methodText)
    && !/onReport|reportPost|report\s*\(/.test(methodText));
  ok('确认文案说清不可恢复、会删评论、会记审核日志',
    /不可恢复/.test(methodText) && /评论/.test(methodText) && /审核日志/.test(methodText));
  const delFn = (cloudSrc.match(/async function delContent\([\s\S]*?\n\}\n/) || [''])[0];
  ok('云端 delContent 仍会复核审核员权限',
    /const mod = await isModerator\(openid\)/.test(delFn)
    && /!mod && !isContentOwner/.test(delFn));
  ok('云端删帖会清理留言与留言赞踩',
    /COL_POST_COMMENTS\)\.where\(\{ postId: id \}\)\.remove/.test(cloudSrc)
    && /COL_COMMENT_VOTES\)\.where\(\{ postId: id \}\)\.remove/.test(cloudSrc));

  // 直删如果只删内容、不管举报，审核队列里会留下一行「内容已不存在」。
  // 管理员直删必须把 pending 的举报一起归档，帖子下面的留言举报也算在内。
  const archiveFn = (cloudSrc.match(/async function archivePendingReportsForDeleted\([\s\S]*?\n\}\n/) || [''])[0];
  ok('管理员直删会归档相关举报', /archivePendingReportsForDeleted\(openid, targetType, id/.test(cloudSrc));
  ok('归档只处理 pending，并写成 confirmed',
    /status:\s*'pending'/.test(archiveFn) && /status:\s*'confirmed'/.test(archiveFn));
  ok('删帖时连带归档该帖下的留言举报',
    /targetType:\s*'comment'[\s\S]{0,100}postId:\s*targetId/.test(archiveFn),
    '留言举报还挂在队列里，评论却已经随帖子删了');
  ok('归档后通知举报人',
    /pushNotify\(rec\.openid[\s\S]{0,180}管理员已删除该内容/.test(archiveFn));
  ok('作者自己删帖不冒充违规成立',
    /const archivedReports = mod/.test(cloudSrc) && /作者自己删帖不归档/.test(cloudSrc));

  console.log('\nB. 页面行为');
  {
    const h = pageHarness({ isMod: false });
    h.page.onAdminDelete();
    ok('非审核员点击 → 不弹确认框、不发删除请求',
      h.calls.modals.length === 0 && h.calls.deletes.length === 0, h.calls);
  }
  {
    const h = pageHarness({});
    h.page.onAdminDelete();
    const modal = h.calls.modals[0];
    const done = modal.success({ confirm: false });
    if (done && done.then) await done;
    ok('审核员点取消 → 不发删除请求', h.calls.deletes.length === 0);
  }
  {
    const h = pageHarness({ deleteResult: { ok: true } });
    h.page.onAdminDelete();
    const modal = h.calls.modals[0];
    ok('管理员看到的是二次确认，不是直接删', !!modal && modal.confirmText === '删除');
    await modal.success({ confirm: true });
    ok('★ 确认后调用 store.deletePost(id, true)（跳过前端作者校验）',
      h.calls.deletes.length === 1 && h.calls.deletes[0].id === 'p1' && h.calls.deletes[0].force === true,
      h.calls.deletes);
    ok('成功后才提示「已删除」', h.calls.toasts.some((t) => t.msg === '已删除'), h.calls.toasts);
    ok('成功后先留出提示时间，再返回', h.calls.timers.length === 1 && h.calls.backs.length === 0,
      { timers: h.calls.timers.length, backs: h.calls.backs.length });
    h.calls.timers[0].fn();
    ok('返回上一页', h.calls.backs.length === 1 && h.calls.backs[0].delta === 1, h.calls.backs);
    h.calls.backs[0].fail();
    ok('分享链接直接打开、没有上一页时回论坛列表',
      h.calls.switches.length === 1 && h.calls.switches[0].url === '/pages/forum/list/list', h.calls.switches);
  }
  {
    const h = pageHarness({ deleteResult: { ok: false, msg: '没有权限删除这条内容' } });
    h.page.onAdminDelete();
    await h.calls.modals[0].success({ confirm: true });
    ok('★ 云端失败：显示真实原因，不提示成功',
      h.calls.toasts.length === 1 && h.calls.toasts[0].msg === '没有权限删除这条内容', h.calls.toasts);
    ok('★ 云端失败：不跳页、不启动返回定时器',
      h.calls.backs.length === 0 && h.calls.timers.length === 0, h.calls);
  }
  {
    const h = pageHarness({ deleteThrows: true });
    h.page.onAdminDelete();
    await h.calls.modals[0].success({ confirm: true });
    ok('删除请求异常：收掉 Loading 并提示失败，不跳页',
      h.calls.hidings >= 1 && h.calls.toasts.some((t) => /删除失败/.test(t.msg))
      && h.calls.backs.length === 0 && h.calls.timers.length === 0, h.calls);
  }
  {
    const h = pageHarness({});
    h.page.onAdminDelete();
    h.page.onAdminDelete();
    ok('确认框还开着时连点 → 不叠第二个弹窗', h.calls.modals.length === 1, h.calls.modals.length);
    h.calls.modals[0].complete();
    h.page.onAdminDelete();
    ok('弹窗关闭后可以再次操作', h.calls.modals.length === 2, h.calls.modals.length);
  }

  console.log('\nC. store.deletePost 的强制删除与失败保护');
  {
    const s = storeHarness(true);
    const r = await s.api.deletePost('p1');
    ok('非作者、未带 force → 前端先拦住', r.ok === false && /只能删除自己/.test(r.msg), r);
    ok('被前端拦住时不会误调云端', s.cloudCalls.length === 0, s.cloudCalls);
  }
  {
    const s = storeHarness(true);
    const r = await s.api.deletePost('p1', true);
    ok('★ 审核员 force=true → 云端 delContent("post", id)',
      r.ok === true && s.cloudCalls.length === 1
      && s.cloudCalls[0].type === 'post' && s.cloudCalls[0].id === 'p1', s.cloudCalls);
    ok('★ 云端成功后才删除本地帖子并写墓碑',
      s.box.posts.length === 0 && s.tombstones.length === 1
      && s.tombstones[0].key === 'posts' && s.tombstones[0].id === 'p1', s);
  }
  {
    const s = storeHarness(false);
    const r = await s.api.deletePost('p1', true);
    ok('★ 云端失败 → 返回失败原因，本地帖子保留（不能造成「本机没了、别人还看得见」）',
      r.ok === false && /云端删除失败/.test(r.msg) && s.box.posts.length === 1 && s.tombstones.length === 0,
      { result: r, posts: s.box.posts.length, tombstones: s.tombstones.length });
  }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + '共 ' + (pass + fail) + ' 项，通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(2);
});