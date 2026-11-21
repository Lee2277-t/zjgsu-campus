// utils/feedback.js —— 用户反馈的唯一出口（Toast / Loading / 提交链超时 / 看门狗）
//
// 为什么要有这个文件：本项目里出现过多次「用户点了按钮，页面毫无反应」，
// 而逐条查下来都不是业务逻辑错了，是**反馈本身被吞掉了**：
//
//   ① wx.showLoading 和 wx.showToast 共用同一块系统视图。
//      只要在一个 tick 里先 showToast 再 hideLoading（或两者紧挨着），
//      后执行的那个会把前一个抹掉 —— 用户看到的就是「什么都没发生」。
//      微信官方只说了「同时只能存在一个」，没说这是在部分机型/部分基础库上才严格生效，
//      所以它表现为「多机型偶发」，最难复现。
//      本文件的 toast() 统一「先收 Loading → 隔一帧再弹 Toast」，从根上避开。
//
//   ② 异步链条没有硬上限。发帖链路最坏要好几段等待
//      （内容预检 + 等 openid + 写云端），任何一段卡住就会让用户对着「发布中」干等，
//      观感和卡死没有区别。这里提供 deadline() / run()，给整条链路一个总闸。
//
//   ③ 键盘挡住 Toast（2026-09-29 补）。真机上用户是「打完字直接点发送」，
//      这时软键盘还占着下半个屏幕，Toast 弹在它后面 —— 提示其实弹了，用户一个字没看到，
//      结论就是「点了没反应」。所以 toast() 一律先把键盘收掉再弹。
//
//   ④ 切后台 / 锁屏时 setTimeout 会被系统暂停（2026-09-29 补）。
//      链路里的超时总闸、以及页面里「发布中…」的复位都挂在 setTimeout 上，
//      一旦中途切后台，这些定时器可能永远不跑 —— 回来之后按钮永久失灵。
//      光靠定时器救不回来，所以这里提供 watchdog()，并且页面侧要用
//      「点击时间戳」而不是「定时器」来判断状态是不是过期了（见 post.js / hole.js）。
//
// 约定：页面里所有 wx.showToast / wx.showLoading 都改走这里，别再裸调 wx。

// Loading 收起来之后，隔多久再弹 Toast。
// 30ms 是实测够用的下限：Loading 的消失动画要占一帧，同时调用会互相覆盖；
// 再长用户就开始觉得「迟钝」。
const TOAST_DELAY_MS = 30;

// 震动统一转发给 haptic，让它那一个开关管住全站 ——
// 这里自己再实现一遍的话，用户在「我的」里关掉开关就管不住 feedback.buzz() 了
const haptic = require('./haptic.js');

// Toast 正文上限。微信自己会在超出后截断并加省略号（7 个汉字左右一行，最多两行），
// 但截断点是没保证的；这里主动收到一个稳定的长度，并按长短给不同的停留时间，
// 免得一句话没读完就没了。
const TITLE_MAX = 30;
const DUR_SHORT = 1800;
const DUR_LONG = 3000;

// 兜底文案：任何走 toast() 的路径都必须让**用户看到字**，
// 绝不允许出现「有错误但没话说」的静默失败
const FALLBACK_MSG = '没成功，再试一次';

// 记录当前是否挂着 Loading，供 toast() 决定要不要先收。
// 不用 wx 自己的状态查询（没有这个接口），自己记账最可靠
let loadingOn = false;

// 最后一次「结论性反馈」（Toast）的时间戳。
// 只统计 Toast 不统计 Loading：Loading 只说明「还在跑」，
// 看门狗要盯的是「整件事有没有一个交代」。
let lastToastAt = 0;

function truth(msg) {
  const s = String(msg === undefined || msg === null ? '' : msg).trim();
  return s || FALLBACK_MSG;
}

// 收起软键盘。
// 键盘弹着的时候 Toast 会被挡在后面（真机上最常见的一种「毫无反应」），
// 所以弹提示之前先把它收掉。没有键盘时这个调用是空操作，不会有副作用。
//
// ⚠️ 2026-10-17：「空操作」只是逻辑上没有副作用，体感上不是。
//   wx.hideKeyboard() 会真的驱动一次键盘收起动画（真机上 200~300ms），
//   而这期间弹出层的位置和页面可视区都在变 —— 用户说的「反馈框弹得好慢」
//   主要就是它。以前是无条件调用：哪怕当前页面根本没有输入框、键盘压根没出来，
//   也照样走一遍这条桥。现在先跟踪键盘状态，没弹起来就不调。
//
// 跟踪手段用 wx.onKeyboardHeightChange（基础库 2.7.0+，本项目 libVersion 3.5.0）。
// 拿不到这个接口时（极旧基础库 / 测试桩）退回老行为：一律收一次，
// 宁可慢一点，也不能让 Toast 被键盘挡住。
let keyboardOn = false;
let canTrackKeyboard = false;
try {
  if (typeof wx !== 'undefined' && wx.onKeyboardHeightChange) {
    wx.onKeyboardHeightChange((res) => {
      keyboardOn = (Number(res && res.height) || 0) > 0;
    });
    canTrackKeyboard = true;
  }
} catch (e) { canTrackKeyboard = false; }

/**
 * @returns {boolean} 这次是否真的调了「收键盘」—— toast() 据此决定要不要等一帧
 */
function hideKeyboard() {
  // 能跟踪且明确知道键盘没弹：直接返回，省掉一次桥调用和它的动画
  if (canTrackKeyboard && !keyboardOn) return false;
  try {
    if (typeof wx !== 'undefined' && wx.hideKeyboard) wx.hideKeyboard();
  } catch (e) { /* 收不掉也不能不弹提示 */ }
  if (canTrackKeyboard) keyboardOn = false;
  // 跟踪不了的时候我们并不知道有没有真的收掉，按「收了」算，保守等一帧
  return true;
}

/**
 * 轻震动一下。
 *
 * 这是唯一一个「不依赖任何视图层」的反馈：Toast 会被 Loading 吞、会被键盘挡、
 * 会被系统弹窗盖，震动不会。点下去立刻震一下，用户至少知道「程序收到这一下点击了」——
 * 排查「按下去有变色、之后毫无反应」时，它也是最好的分界线：
 * 有震动 = JS 跑起来了，问题在后面；没震动 = 点击事件根本没进 JS。
 */
function buzz() {
  // 开关在 haptic 里读：用户在「我的」页关掉之后，所有走 feedback.buzz() 的地方
  // 一起静音，不需要每个调用点再判一次
  haptic.ok();
}

// 最后一道兜底：连 wx.showToast 都失败（极少数机型 / 基础库异常）时，
// 用 Modal 也要把这句话送到用户眼前。宁可打扰，不可沉默
function fallbackModal(text) {
  try {
    if (typeof wx === 'undefined' || !wx.showModal) return;
    wx.showModal({
      title: text,
      content: '',
      showCancel: false,
      confirmText: '知道了'
    });
  } catch (e) { /* 到这一步确实没办法了 */ }
}

/** 弹 Loading。mask 默认不开 —— 有输入框的页面一开就把人锁死了 */
function loading(title, mask) {
  try {
    if (typeof wx === 'undefined' || !wx.showLoading) return;
    wx.showLoading({
      title: String(title || '处理中'),
      mask: !!mask
    });
    loadingOn = true;
  } catch (e) {
    loadingOn = false;
  }
}

/**
 * 收 Loading。重复调用无害（有些版本 wx.hideLoading 空调用会报 void 调用记录）
 *
 * @param {boolean} force 强行收：不管自己有没有记账，都调一次 wx.hideLoading。
 *   为什么要这个：记账只记**本文件**弹的 Loading。要是别处（或上次会话）留下了一个
 *   没收掉的 Loading，记账是 false 而系统层还挂着 —— 这时 showToast 会被它吃掉，
 *   用户看到的就是「点了按钮，什么都没发生」。所以弹提示前一律 force 收一次。
 */
function hideLoading(force) {
  if (!loadingOn && !force) return;
  try {
    if (typeof wx !== 'undefined' && wx.hideLoading) wx.hideLoading();
  } catch (e) { /* 收不掉也不该影响后续提示 */ }
  loadingOn = false;
}

/**
 * 弹 Toast。
 *
 * 关键实现：先把 Loading 收掉、键盘收掉，再隔一帧弹 —— 直接弹会被 Loading（或随后的
 * hideLoading）吞掉，这是本项目历史上「点了发布/投递毫无反应」的直接成因。
 *
 * @param {string} msg 提示文案，为空会自动兜底
 * @param {{duration?:number, icon?:string, delay?:number}} opt
 * @returns {Promise<void>} 真正弹出来之后才 resolve（方便脚本验证）
 */
function toast(msg, opt) {
  const o = opt || {};
  const text = truth(msg);
  const title = text.length > TITLE_MAX ? text.slice(0, TITLE_MAX - 1) + '…' : text;
  const duration = Number(o.duration) || (text.length > 12 ? DUR_LONG : DUR_SHORT);

  // force：见 hideLoading 的说明。有别的 Loading 挂在系统上时，
  // showToast 会被它吃掉 —— 这是「提示明明调了却看不见」的最后一条暗道
  const hadLoading = loadingOn;
  hideLoading(true);
  // 键盘挡 Toast：先收键盘，再等一帧（键盘收起也要占一帧），最后弹
  const hidKeyboard = hideKeyboard();
  // 那 30ms 是为了让「消失的动作」先落地，避免两个系统弹层互相覆盖。
  // 没有 Loading 要收、键盘也没弹起来时，没有任何东西需要等 ——
  // 以前无条件等一帧，点一下按钮到看见提示中间平白多半拍，
  // 在一堆轻提示连着弹的场景里就是肉眼可见的「慢」
  const settle = hadLoading || hidKeyboard;
  const delay = o.delay === undefined ? (settle ? TOAST_DELAY_MS : 0) : (Number(o.delay) || 0);
  return new Promise((resolve) => {
    setTimeout(() => {
      let shown = false;
      try {
        if (typeof wx === 'undefined' || !wx.showToast) { resolve(); return; }
        wx.showToast({
          title: title,
          icon: o.icon === undefined ? 'none' : o.icon,
          duration: duration
        });
        shown = true;
      } catch (e) { /* 弹窗失败也不能把调用方的流程打断 */ }
      lastToastAt = Date.now();
      if (!shown) fallbackModal(title);
      resolve();
    }, delay);
  });
}

/** 成功提示的快捷方式（带对勾） */
function ok(msg, opt) {
  return toast(msg, Object.assign({ icon: 'success', duration: 1800 }, opt || {}));
}

/**
 * 给任意异步操作加一个硬上限：到点还没回来就按 fallback 处理，绝不让调用方无限等。
 *
 * 注意是 resolve 而不是 reject —— 调用方的 await 不用再包 try，
 * 「超时」和「成功/失败」在同一条逻辑里处理，少一层漏写的可能。
 *
 * @param {Promise} promise
 * @param {*} fallback 超时（或异常）时返回的值
 * @param {number} ms 上限毫秒数
 */
function deadline(promise, fallback, ms) {
  let timer = null;
  let done = false;
  let settle;
  const gate = new Promise((resolve) => { settle = (v) => { done = true; if (timer) clearTimeout(timer); resolve(v); }; });
  timer = setTimeout(() => { if (!done) settle(fallback); }, ms);
  Promise.resolve(promise).then((v) => { if (!done) settle(v); }, () => { if (!done) settle(fallback); });
  return gate;
}

/**
 * 把一段异步流程包成「一定有反馈」：
 * 成功走返回值，失败/超时统一落到「超时须知会用户」这条路上。
 *
 * 这样页面里的提交函数就不必自己记着「每个 return 分支都要弹提示」——
 * 漏一个分支，就是一次「点了没反应」。
 *
 * @param {{task:Promise, ms:number, timeoutMsg:string, timeoutValue:*}} cfg
 * @returns {Promise<{value:*, timedOut:boolean}>}
 */
async function run(cfg) {
  const c = cfg || {};
  const limit = Number(c.ms) || 0;
  let timedOut = false;
  let value;
  if (limit > 0) {
    value = await deadline(c.task, undefined, limit);
    // 用 undefined 当「超时标记」：正常业务的返回值不会是 undefined（哪怕是也当超时提示，损失可接受）
    if (value === undefined) {
      timedOut = true;
      value = c.timeoutValue;
      await toast(c.timeoutMsg || '处理时间有点长，稍后再看看');
    }
  } else {
    value = await Promise.resolve(c.task).catch(() => null);
  }
  return { value: value, timedOut: timedOut };
}

/**
 * 看门狗：一条提交链跑起来之后，如果到了 ms 毫秒还**没有给出任何结论**（成功/失败/超时的
 * 提示都算结论），就自己站出来说一句话并收掉 Loading。
 *
 * 它是「总闸之上的总闸」。run() 那个总闸靠 setTimeout，而真机切后台/锁屏时
 * setTimeout 会被系统暂停，总闸可能永远不响；看门狗同样可能被暂停，
 * 但只要回到了前台它就会补上那句话 —— 用户至少不会对着一个永远转的蒙层发呆。
 *
 * 用法：
 *   const wd = feedback.watchdog({ ms: 30000, msg: '…' });
 *   ...  // 链路结束（无论成败）
 *   wd.cancel();
 *
 * @param {{ms?:number, msg?:string}} opt
 * @returns {{cancel:Function}}
 */
function watchdog(opt) {
  const o = opt || {};
  const ms = Number(o.ms) || 30 * 1000;
  const msg = o.msg || '这条卡太久了，先看看网络';
  const base = lastToastAt;   // 起跑前的「最后结论时间」
  const timer = setTimeout(() => {
    // 期间给过任何结论（成功/失败/超时提示）就不再打扰
    if (lastToastAt > base) return;
    hideLoading();
    toast(msg, { duration: 3000 });
  }, ms);
  return { cancel: () => clearTimeout(timer) };
}

module.exports = {
  loading,
  hideLoading,
  hideKeyboard,
  buzz,
  toast,
  ok,
  deadline,
  run,
  watchdog,
  isLoading: () => loadingOn,
  // 键盘当前是否弹着（能跟踪时才有意义）。测试据此断言「没弹键盘就不该多等一帧」
  isKeyboardUp: () => keyboardOn,
  canTrackKeyboard: () => canTrackKeyboard,
  // 最后一次结论性反馈的时间戳：页面用它判断「上次点击是不是过期了」
  lastFeedbackAt: () => lastToastAt,
  // 常量导出出来，脚本里好断言，也让「为什么要延迟 30ms」有个地方解释
  TOAST_DELAY_MS,
  TITLE_MAX,
  FALLBACK_MSG
};
