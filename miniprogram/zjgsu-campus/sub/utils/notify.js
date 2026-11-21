// utils/notify.js —— 订阅消息授权（一次性）
//
// 微信规定：小程序要先取得用户的一次性授权，云函数才能给他推一条通知。
// 所以这里是「要授权」，真正发消息在云函数里（cloudfunctions/user 的 sendSubMsg）。
//
// 模板 ID 填在 utils/config.js 的 SUBMSG 里（三个：comment / reply / chat）：
//   mp 后台 → 订阅消息 → 公共模板库 → 选用后复制模板 ID
// 没填就整段静默跳过，任何功能都不受影响。
//
// 只在「用户刚做完一件值得被通知的事」之后弹授权：
// 一进小程序就弹，通过率极低，还惹人烦。
//
// ⚠️ 微信限制：一次 requestSubscribeMessage 最多传 3 个模板 ID。
//    目前最多同时要 2 个（发帖后：帖子被留言 + 留言被回复），在限制内。
const cfg = require('../../utils/config.js');

// 认单个 kind，也认数组：发完帖一次把「帖子被留言」和「留言被回复」一起要了，
// 弹一次框比前后弹两次体验好，也不会因为第二次弹框把成功提示盖掉
function tmplIds(kind) {
  const s = (cfg && cfg.SUBMSG) || {};
  const kinds = Array.isArray(kind) ? kind : [kind];
  const out = [];
  kinds.forEach((k) => {
    const id = String(s[k] || '').trim();
    // 去重：同一个模板被填进两格时只问一次，否则微信会拒掉整次调用
    if (id && out.indexOf(id) < 0) out.push(id);
  });
  return out.slice(0, 3);
}

// 返回 Promise<是否全部同意>。没配模板 / 用户拒绝 都只是 false，不抛错。
// kinds 可以是 'chat'，也可以是 ['comment', 'reply']
function request(kind) {
  const ids = tmplIds(kind);
  if (!ids.length) return Promise.resolve(false);
  if (typeof wx === 'undefined' || !wx.requestSubscribeMessage) return Promise.resolve(false);
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: ids,
      success: (res) => {
        // 返回值是「模板ID: accept/reject/ban」，ban 表示被永久拒绝（在设置页关了）
        resolve(ids.every((id) => res && res[id] === 'accept'));
      },
      fail: () => resolve(false)
    });
  });
}

/* ---------------- 该不该在这时候问 ---------------- */

// ⚠️ 这个接口有个硬性前提：**必须由用户点击触发**。
//    在 onLoad / setTimeout / 网络回调里调，微信直接 fail（errCode 20004
//    "can only be invoked by user TAP gesture"），面板不出现、也不报错给用户。
//    所以所有调用点都必须写在 tap 处理函数的第一段同步代码里，不能 await 之后才调。
//
// 一次「允许」只能推一条消息（一次性订阅），额度不累积。
// 既不能问一次就再也不问（额度用完就收不到），也不能每次发帖都问（烦）。
// 折中：允许过 12 小时后再问一次（攒一条），拒绝过 7 天内不问，
// 被永久关掉（ban）的微信自己不会再弹，7 天后重试只是无副作用的探测。
const STATE_KEY = 'zjgsu_submsg_state';
const COOLDOWN = {
  accept: 12 * 3600 * 1000,
  reject: 7 * 24 * 3600 * 1000
};
// 「发帖前必须问一次」这条路上用的拒绝冷却。
// 为什么比上面的 7 天短这么多：上面那套节流是给「顺手问一句」的场景准备的，
// 而发帖是用户明确要发东西、明确需要后续通知的时刻 —— 一直不授权就等于
// 他发完帖永远收不到「有人回复你」。7 天太长了，一天一次是能接受的上限：
// 真不想收的人连点两次拒绝，一天之内不会被打扰第二次。
const FORCE_REJECT_COOLDOWN = 24 * 3600 * 1000;
// 面板被系统挂住时不能把发布流程一起拖死，超过这个时间就当没授权，继续干活
const ASK_TIMEOUT_MS = 4000;

function readState() {
  try {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return {};
    const s = wx.getStorageSync(STATE_KEY);
    return s && typeof s === 'object' ? s : {};
  } catch (e) {
    return {};
  }
}

function writeState(s) {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(STATE_KEY, s);
  } catch (e) { /* 存储满了也不影响功能，只是下次会多问一次 */ }
}

// 还要等多久才可以再问（毫秒，<=0 表示现在可以问）
//
// force=true 时按「发帖前的硬要求」算：
//   · 上次同意了 → 立刻可以再问。一次「允许」只够推一条消息，额度用完
//     就该再要一次；沿用 12 小时冷却的结果是「这个人今天已经授权过了，
//     所以他这次的帖子也别想要通知」—— 跟用户的诉求正好相反。
//   · 上次拒绝了 → 按 FORCE_REJECT_COOLDOWN（1 天）算，不再等 7 天。
function cooldownLeft(kind, now, force) {
  const st = readState();
  // ⚠️ kind 可能是数组（一次问多个模板）。数组当对象键会被强转成
  //    "comment,reply" 这种字符串，而写入时是**按单个 kind 各存一格**的 ——
  //    用数组去读永远读到 undefined，冷却形同虚设，每次发帖都弹一次面板。
  //    所以这里逐个 kind 查，取**最长的那个**等待时间：
  //    只要还有一个模板在冷却里，这一次就不问（否则会把用户刚拒绝过的
  //    那一项再端上来一次）。
  const kinds = Array.isArray(kind) ? kind : [kind];
  let left = 0;
  kinds.forEach((k) => {
    const s = st[k];
    if (!s) return;
    const isReject = s.res !== 'accept';
    const ms = force
      ? (isReject ? FORCE_REJECT_COOLDOWN : 0)
      : (COOLDOWN[s.res] || COOLDOWN.reject);
    if (!ms) return;
    const t = Math.max(0, (Number(s.at) || 0) + ms - (now || Date.now()));
    if (t > left) left = t;
  });
  return left;
}

// 同一时刻只允许一个授权面板（连点两下按钮会弹两次，第二次必被微信拒）
let asking = false;

// 带节流的授权请求。和 request 一样返回 Promise<是否全部同意>，从不 reject。
//
// opt.force：这是「发布前必须问」的场景（发帖），冷却规则见 cooldownLeft。
// 面板本身仍然只在用户的点击帧里才调得起来，所以调用点必须紧贴 tap，
// 前面不能有 await —— 这一点 force 改变不了。
function maybeRequest(kind, opt) {
  const force = !!(opt && opt.force);
  const ids = tmplIds(kind);
  if (!ids.length || asking) return Promise.resolve(false);
  if (cooldownLeft(kind, 0, force) > 0) return Promise.resolve(false);

  asking = true;
  const kinds = Array.isArray(kind) ? kind : [kind];

  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, record) => {
      if (done) return ok;
      done = true;
      asking = false;
      if (record) {
        const st = readState();
        kinds.forEach((k) => { st[k] = { at: Date.now(), res: ok ? 'accept' : 'reject' }; });
        writeState(st);
      }
      return ok;
    };

    const timer = setTimeout(() => resolve(finish(false, false)), ASK_TIMEOUT_MS);
    request(kind).then((ok) => {
      clearTimeout(timer);
      resolve(finish(ok, true));
    }, () => {
      clearTimeout(timer);
      resolve(finish(false, true));
    });
  });
}

module.exports = { request, maybeRequest, tmplIds, cooldownLeft, ASK_TIMEOUT_MS };
