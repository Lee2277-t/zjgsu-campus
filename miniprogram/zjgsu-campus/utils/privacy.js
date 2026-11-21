// utils/privacy.js —— 微信「用户隐私保护指引」授权
//
// 小程序里只要用到用户个人信息（昵称、头像、以及**选图 / 选文件**这类隐私接口），
// 就必须在 mp 后台如实填报《用户隐私保护指引》，并在首次收集前弹窗告知。
// app.json 里 __usePrivacyCheck__: true 打开这项检查，这里负责弹窗与跳转。
//
// 注意：mp 后台的填报动作仍需你本人去 mp.weixin.qq.com 完成，
// 只改代码不行——微信审核会看后台配置。
//
// ⚠️ 2026-09-29 重构的原因（值得记住的两个坑）：
//   1）原来是「被动触发」：只有当用户真正调用隐私接口（比如点「加图」）时，
//      微信才回调 onNeedPrivacyAuthorization，我们再 showModal。
//      但**在 App.onLaunch 阶段弹 showModal 极不可靠**——首页还没渲染完，
//      弹窗经常被吞掉或直接不显示。用户看到的就是：
//      「提示我要确定隐私协议，但根本没地方点同意」——接口还在那挂着等 resolve。
//      现在改成「进入首页就主动申请 + 用真正的自定义弹窗组件承载」。
//   2）系统弹窗 wx.showModal 只有两个按钮，塞不进「查看协议」入口（审核要求必须能打开协议）。
//      现在用组件：可点开《用户隐私保护指引》，同意按钮走微信官方的
//      <button open-type="agreePrivacyAuthorization">，点了就真的授权。

// ---------------------------------------------------------------------------
// 待处理的授权请求：微信把「放行函数」给我们，用户点完之后必须调它，
// 不调的话触发授权的那个接口（选图 / 选文件）会一直挂着，表现为「点了没反应」
// ---------------------------------------------------------------------------
let pending = null;   // { resolve, name }
let watcher = null;   // UI 层（隐私弹窗组件）注册的展示回调
let askedOnce = false; // 本次运行期是否已经主动问过一次
let entryPromise = null; // askOnEnter 的共享 Promise，app 与首页等同一件事
let waiting = [];     // whenSettled() 的等待者

function settleAll() {
  const list = waiting;
  waiting = [];
  list.forEach((fn) => fn());
}

function getPrivacyName() {
  return new Promise((resolve) => {
    if (!wx.getPrivacySetting) return resolve('用户隐私保护指引');
    wx.getPrivacySetting({
      resolveWithDetail: true,
      success: (res) => resolve(res.privacyContractName || '用户隐私保护指引'),
      fail: () => resolve('用户隐私保护指引')
    });
  });
}

// 是否已经授权过（授权状态由微信侧保留）
function isAuthorized() {
  return new Promise((resolve) => {
    if (!wx.getPrivacySetting) return resolve(true);
    wx.getPrivacySetting({
      resolveWithDetail: true,
      success: (res) => resolve(!res.needAuthorization),
      fail: () => resolve(true)
    });
  });
}

// 打开微信提供的协议原文页（微信托管，不用自己写网页）
function openContract() {
  // 提示走反馈层：裸调 wx.showToast 会被 Loading 抹掉 / 被键盘挡住
  const feedback = require('./feedback.js');
  wx.openPrivacyContract({
    fail: () => feedback.toast('协议页打不开')
  });
}

/* ---------------- UI 层对接 ---------------- */

// 兜底弹窗：只有在「组件没挂载」时才会走到这里（例如从非首页触发了隐私接口）。
// 宁可用系统弹窗，也绝不能把授权请求晾着——那等于把功能掐死。
function fallbackModal(resolve, name) {
  wx.showModal({
    title: '用户隐私保护提示',
    content: '使用前请先阅读并同意《' + name + '》。我们会按协议约定使用你的信息，不会向任何第三方提供。',
    confirmText: '同意并继续',
    cancelText: '暂不同意',
    success: (res) => {
      if (res.confirm) resolve();
      else resolve({ eventType: 'cancel' });
    },
    fail: () => resolve({ eventType: 'cancel' })
  });
}

// 微信需要授权时回调到这里：交给 UI 层，没有 UI 层就退回系统弹窗
function notify(resolve, name) {
  pending = { resolve: resolve, name: name };
  if (watcher) {
    try {
      watcher(name);
      return;
    } catch (e) { /* 组件出错也不能卡住授权 */ }
  }
  fallbackModal(resolve, name);
}

/**
 * 隐私弹窗组件调用：注册「要弹窗了」的回调。
 * @param {(name:string)=>void} cb
 */
function onAsk(cb) {
  watcher = cb;
}

function offAsk() {
  watcher = null;
}

/**
 * 用户在弹窗里点了「同意 / 暂不同意」，由组件调用。
 * 注：走官方按钮（open-type="agreePrivacyAuthorization"）时微信已自动完成授权，
 *     组件仍需调 answer(true) 来把弹窗状态和内部 pending 清理掉。
 */
function answer(ok) {
  const p = pending;
  pending = null;
  if (p && p.resolve) {
    try {
      if (ok) p.resolve();
      else p.resolve({ eventType: 'cancel' });
    } catch (e) {}
  }
  settleAll();
}

// 当前是否正在等用户表态（app 用来避免欢迎弹窗和隐私弹窗撞在一起）
function isAsking() {
  return !!pending;
}

// 等授权这件事有个结果（同意 / 拒绝 / 本来就不用授权）
function whenSettled() {
  if (!pending) return Promise.resolve(true);
  return new Promise((resolve) => waiting.push(resolve));
}

/* ---------------- 主动申请 ---------------- */

/**
 * 主动申请授权：不需要授权就立即返回 true；需要则触发微信的授权回调。
 * 这是「进入小程序就问一次」的关键——不再等到用户第一次点「加图」才被动弹。
 */
function requireIfNeeded() {
  if (!wx.getPrivacySetting || !wx.requirePrivacyAuthorize) {
    settleAll();
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    wx.getPrivacySetting({
      success: (res) => {
        if (!res || !res.needAuthorization) {
          settleAll();           // 本来就授权过：立刻放行，别让欢
          return resolve(true);  // 迎弹窗之类的流程空等
        }
        wx.requirePrivacyAuthorize({
          success: () => resolve(true),
          fail: () => resolve(false)
        });
      },
      fail: () => { settleAll(); resolve(true); }
    });
  });
}

/**
 * 进入小程序时问一次（幂等：本次运行期只主动问一次，切 tab 回来不再烦人）。
 * 用户若选了「暂不同意」，等他真正用到隐私接口时，微信会再次触发弹窗给他第二次机会。
 */
function askOnEnter() {
  if (entryPromise) return entryPromise;
  askedOnce = true;
  entryPromise = requireIfNeeded();
  return entryPromise;
}

function pendingName() {
  return (pending && pending.name) ? pending.name : '';
}

// 注册授权监听：需要授权时会被回调，弹窗后必须调 resolve 告诉用户的选择
function setup() {
  if (!wx.onNeedPrivacyAuthorization) return;
  wx.onNeedPrivacyAuthorization((resolve) => {
    getPrivacyName().then((name) => notify(resolve, name));
  });
}

module.exports = {
  getPrivacyName,
  isAuthorized,
  openContract,
  setup,
  onAsk,
  offAsk,
  answer,
  isAsking,
  whenSettled,
  requireIfNeeded,
  askOnEnter,
  pendingName
};
