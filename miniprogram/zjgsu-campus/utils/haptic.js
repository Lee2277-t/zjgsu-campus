// utils/haptic.js —— 触感反馈（真机有效，开发者工具里是空操作，不影响调试）
//
// 定位：只给「事情已经成了、而且不可逆」的动作当家。
//   · 该震：发布（发出去了）、删除（删了）、举报（落到服务端了）
//   · 不该震：收藏、投票、点赞 —— 这些有即时可见的状态变化（图标填充 / 数字 +1），
//     再震一下就成了噪音。课堂、图书馆是这个 app 的高频场景，多加一处就多一处打扰。
//
// 为什么要开关：iOS 系统设置里关掉震动后 wx.vibrateShort 是**静默失效**的，
// 我们既查不到用户关没关，也没法区分「他关了」和「这机器不支持」。
// 所以只能把决定权交还给本人；默认开，是因为不震的用户本来也感知不到这个功能。
//
// 和 utils/feedback.js 的分工：feedback.buzz() 统一转发到这里，
// 保证「页面里所有震动」只有这一个开关，不会出现两套读法。
const KEY = 'zjgsu_haptic'; // storage key，值是字符串 '1' / '0'

let loaded = false;
let enabled = true;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const v = wx.getStorageSync(KEY);
    // 只有明确写过 '0' 才算关：没写过的用户一律按「开」处理，
    // 免得某次写失败把新用户默认静音了
    if (v === '0' || v === 0 || v === false) enabled = false;
  } catch (e) { /* storage 不可用就按默认开 */ }
}

/** 当前是否允许震动 */
function isEnabled() {
  load();
  return enabled;
}

/** 写入开关。同时更新内存里的值，本页面不用重读 storage */
function setEnabled(v) {
  enabled = !!v;
  loaded = true;
  try {
    wx.setStorageSync(KEY, enabled ? '1' : '0');
  } catch (e) { /* 存不下也算改了本次会话的 */ }
  return enabled;
}

function ok() {
  if (!isEnabled()) return;
  try {
    // type: 'light' 基础库 2.13.0+ 才认，旧机型走 fail 兜底，不报错
    if (typeof wx === 'undefined' || !wx.vibrateShort) return;
    wx.vibrateShort({ type: 'light', fail: () => {} });
  } catch (e) { /* 极旧基础库没有这个 API，静默跳过 */ }
}

module.exports = { ok, isEnabled, setEnabled, STORAGE_KEY: KEY };
