// utils/theme.js —— 深浅色偏好的唯一出口（跟随系统 / 强制浅色 / 强制深色）
//
// 为什么要有这个文件：
// 小程序原本只有「跟随系统」一条路 —— app.wxss 里用
// @media (prefers-color-scheme: dark) 重定义色值令牌，系统切了页面就跟着切。
// 但用户在「我的」里点的那一下，需要**脱离系统**：系统是浅的我也要深，
// 系统是深的我也要浅。平台没有提供「强制某个主题」的 API
// （wx.setTheme 不存在，theme.json 也只认系统那一套），
// 所以只能自己接管：把 --c-* 令牌以**内联样式**写到页面根节点上。
//
// 内联样式优先级高于 page{} 和 @media 里的同名声明，所以只要每个页面
// 都挂一个 <page-meta page-style="{{themeStyle}}" />，就能盖住系统那一套。
//
// 原生导航栏 / tabBar 在系统浅色、用户强制深色时不会自动跟着页面变，
// 所以 setMode 和每个页面 onShow 时再调一次 wx.setNavigationBarColor /
// wx.setTabBarStyle；失败静默，页面内容仍然由 page-meta 保证正确。
//
// mode 三态：
//   'auto'  没选过：完全交给系统（不注入任何样式，零开销）
//   'dark'  强制深色
//   'light' 强制浅色
//
// 存的是用户的**选择**，不是「当前是深还是浅」：选择要跟着账号走很久，
// 而系统的深浅随时会变。把两者混成一个布尔值，切一次系统主题就把用户的
// 选择覆盖掉了。

const KEY = 'zjgsu_theme_mode';

// 需要覆盖的令牌 = 深浅两套取值不同的那些。
// 尺度令牌（--fs-* / --sp-* / --r-* / --hit*）深浅同值，不用重复；
// --sh-* 引用的是 --c-shadow*，跟着变，也不用重复。
//
// ⚠️ 这两份色值与 app.wxss 的 page{} 和 @media (prefers-color-scheme: dark)
//    必须完全一致。抄错一个值，表现就是「手动切深色后某一处颜色和系统深色不一样」，
//    而且极难发现。scripts/check-theme.cjs 会逐个比对，改色板时两边一起改。
const LIGHT = {
  '--c-bg': '#f5f7fa',
  '--c-card': '#ffffff',
  '--c-sunken': '#f6f8fb',
  '--c-fill': '#eef1f6',
  '--c-line': '#e8edf5',
  '--c-disabled': '#b9c6d8',
  '--c-text': '#172033',
  '--c-muted': '#6f7b91',
  '--c-faint': '#98a3b8',
  '--c-on-strong': '#ffffff',
  '--c-shadow': 'rgba(0, 0, 0, 0.05)',
  '--c-shadow-lift': 'rgba(23, 32, 51, 0.14)',
  '--c-shadow-brand': 'rgba(43, 90, 237, 0.18)',
  '--c-brand-line': '#dce7ff',
  '--c-handle': '#e0e5ee',
  '--c-bg-blur': 'rgba(245, 247, 250, 0.94)',
  '--c-bg-blur-line': 'rgba(255, 255, 255, 0.8)',
  '--c-over': '#ffffff',
  '--c-over-text': '#172033',
  '--c-brand': '#2b5aed',
  '--c-brand-deep': '#2047c9',
  '--c-brand-soft': '#eff4ff',
  '--c-forum': '#7357ff',
  '--c-forum-soft': '#f1edff',
  '--c-market': '#f58a32',
  '--c-market-deep': '#d9731f',
  '--c-market-soft': '#fff3e9',
  '--c-campus': '#19a66a',
  '--c-campus-deep': '#128a56',
  '--c-campus-soft': '#e9f8f1',
  '--c-profile': '#2f9fd6',
  '--c-profile-soft': '#e7f5fd',
  '--c-danger': '#dd4b55',
  '--c-danger-soft': '#fff0f1',
  '--c-amber': '#d98c0b',
  '--c-amber-deep': '#a86a1c',
  '--c-amber-soft': '#fff8e6',
  '--c-hero-from': '#2f9fd6',
  '--c-hero-to': '#2b5aed',
  '--c-hole-from': '#7357ff',
  '--c-hole-to': '#4a3bb8',
  '--c-bottle-from': '#0e7c86',
  '--c-bottle-to': '#2fa8b5'
};

const DARK = {
  '--c-bg': '#0d1117',
  '--c-card': '#161b22',
  '--c-sunken': '#1c2128',
  '--c-fill': '#22272e',
  '--c-line': '#2d333b',
  '--c-disabled': '#3a4250',
  '--c-text': '#e6edf3',
  '--c-muted': '#9198a1',
  '--c-faint': '#6e7681',
  '--c-on-strong': '#ffffff',
  '--c-shadow': 'rgba(0, 0, 0, 0.45)',
  '--c-shadow-lift': 'rgba(0, 0, 0, 0.5)',
  '--c-shadow-brand': 'rgba(109, 141, 255, 0.28)',
  '--c-brand-line': '#2c3a5e',
  '--c-handle': '#3a4250',
  '--c-bg-blur': 'rgba(13, 17, 23, 0.94)',
  '--c-bg-blur-line': 'rgba(255, 255, 255, 0.06)',
  '--c-over': '#ffffff',
  '--c-over-text': '#172033',
  '--c-brand': '#6d8dff',
  '--c-brand-deep': '#9db4ff',
  '--c-brand-soft': '#1a2338',
  '--c-forum': '#9b85ff',
  '--c-forum-soft': '#241f3d',
  '--c-market': '#ff9d52',
  '--c-market-deep': '#f0a566',
  '--c-market-soft': '#33261a',
  '--c-campus': '#3fd08f',
  '--c-campus-deep': '#56dda3',
  '--c-campus-soft': '#142e26',
  '--c-profile': '#5cb8e8',
  '--c-profile-soft': '#142c38',
  '--c-danger': '#f26d73',
  '--c-danger-soft': '#331c1f',
  '--c-amber': '#eaa83c',
  '--c-amber-deep': '#d99a3f',
  '--c-amber-soft': '#33291a',
  '--c-hero-from': '#1b2c42',
  '--c-hero-to': '#202a52',
  '--c-hole-from': '#2b2349',
  '--c-hole-to': '#1a1938',
  '--c-bottle-from': '#12363b',
  '--c-bottle-to': '#17434a'
};

function palettes() { return { light: LIGHT, dark: DARK }; }

/** 把一份色板摊成内联样式串。顺序固定，便于调试时肉眼比对 */
function styleOf(mode) {
  const map = mode === 'dark' ? DARK : (mode === 'light' ? LIGHT : null);
  if (!map) return '';
  return Object.keys(map).map((k) => k + ':' + map[k]).join(';');
}

/* ---------------- 系统主题 ---------------- */

// 系统当前是不是深色。取不到就当浅色 —— 不能因为读不到系统主题就整站变黑
function systemDark() {
  try {
    if (typeof wx === 'undefined' || !wx.getSystemInfoSync) return false;
    return String(wx.getSystemInfoSync().theme || '') === 'dark';
  } catch (e) {
    return false;
  }
}

/* ---------------- 用户选择 ---------------- */

function mode() {
  try {
    if (typeof wx === 'undefined' || !wx.getStorageSync) return 'auto';
    const v = String(wx.getStorageSync(KEY) || '');
    return v === 'dark' || v === 'light' ? v : 'auto';
  } catch (e) {
    return 'auto';
  }
}

// 生效中的主题：有明确选择就听选择，否则听系统。
// 页面上的开关读的是它 —— 用户看到开关的状态必须等于屏幕上的样子
function effective() {
  const m = mode();
  if (m === 'dark' || m === 'light') return m;
  return systemDark() ? 'dark' : 'light';
}

// 当前页面该注入的样式串。auto 返回空串：不插手，交给 @media，
// 这样系统切换时不需要任何 JS 参与，也不会多一层内联样式
function pageStyle() {
  const m = mode();
  return m === 'auto' ? '' : styleOf(m);
}

// 让原生导航栏和 tabBar 也跟随手动主题。微信原生控件不受 page-meta 影响，
// 只能用运行时 API 补；自定义导航页面调用失败时静默忽略。
function applyNative() {
  const dark = effective() === 'dark';
  const bg = dark ? '#161b22' : '#ffffff';
  const color = dark ? '#6e7681' : '#98a3b8';
  const selected = dark ? '#6d8dff' : '#2b5aed';
  try {
    if (wx.setNavigationBarColor) {
      wx.setNavigationBarColor({
        frontColor: dark ? '#ffffff' : '#000000',
        backgroundColor: bg,
        animation: { duration: 0, timingFunc: 'linear' }
      });
    }
  } catch (e) { /* 自定义导航页可能不支持 */ }
  try {
    if (wx.setTabBarStyle) {
      wx.setTabBarStyle({
        color: color,
        selectedColor: selected,
        backgroundColor: bg,
        borderStyle: dark ? 'black' : 'white'
      });
    }
  } catch (e) { /* 非 tabBar 页忽略 */ }
}

/* ---------------- 变更通知 ---------------- */

// 页面在自己 onShow 里重读就够了（切回页面必然触发 onShow）。
// 但「我的」页是当面切换的，必须当场变 —— 所以留一个订阅口，
// 由那一页自己 setData。不做全局广播：一个页面改主题、
// 其它页面在后台跟着 setData 是纯浪费
const listeners = [];

function onChange(fn) {
  if (typeof fn !== 'function') return function () {};
  listeners.push(fn);
  return function () {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

function emit() {
  listeners.slice().forEach((fn) => {
    try { fn(); } catch (e) { /* 某一个页面出错不该连累其它页面 */ }
  });
}

/**
 * 设置偏好并立即通知。
 * @param {'auto'|'dark'|'light'} m
 * @returns {string} 生效中的主题
 */
function setMode(m) {
  const v = m === 'dark' || m === 'light' ? m : 'auto';
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(KEY, v);
  } catch (e) { /* 存储失败就当这次选择没记住，界面照样切 */ }
  emit();
  applyNative();
  return effective();
}

/** 「我的」页那个开关：开 = 深色，关 = 浅色（都会变成明确选择，不再跟随系统） */
function setDark(on) {
  return setMode(on ? 'dark' : 'light');
}

module.exports = {
  KEY,
  mode,
  effective,
  systemDark,
  pageStyle,
  applyNative,
  styleOf,
  palettes,
  onChange,
  setMode,
  setDark
};
