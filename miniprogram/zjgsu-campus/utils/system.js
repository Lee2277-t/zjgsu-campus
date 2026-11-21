// utils/system.js —— 自定义导航栏用到的系统信息
// 迁移自 Web 版 AppHeader.vue（window.innerHeight / 胶囊尺寸）。
// 小程序拿不到 window/document，改走系统信息 API + 胶囊 API。

let cached = null;

// ⚠️ wx.getSystemInfoSync 已被官方标记「废弃」：基础库 3.x 下每次启动都会在
// 调试器 Console 打一条黄色警告（就是那条 "wx.getSystemInfoSync is deprecated"）。
// 官方把它拆成了两个更细的 API：窗口尺寸 → wx.getWindowInfo，设备信息 → wx.getDeviceInfo。
// 这里优先用新 API，再把两边字段拼成原来那个 info 对象形状，所以下面全部取值逻辑
// 一行都不用改；老基础库（< 2.20.1）没有新 API 时自动退回旧的 getSystemInfoSync。
function readInfo() {
  try {
    if (wx.getWindowInfo) {
      const win = wx.getWindowInfo();
      const dev = wx.getDeviceInfo ? wx.getDeviceInfo() : {};
      return {
        statusBarHeight: win.statusBarHeight,
        windowWidth: win.windowWidth,
        windowHeight: win.windowHeight,
        safeArea: win.safeArea,
        platform: dev.platform,
      };
    }
  } catch (e) { /* 新 API 偶发失败就退回老 API，别让导航栏整个挂掉 */ }
  return wx.getSystemInfoSync();
}

function read() {
  try {
    const info = readInfo();
    const capsule = wx.getMenuButtonBoundingClientRect
      ? wx.getMenuButtonBoundingClientRect()
      : null;

    const statusBarHeight = info.statusBarHeight || 20;
    // 胶囊高度（没有胶囊时给一个 iPhone SE 的近似值）
    const capsuleHeight = capsule && capsule.height ? capsule.height : 32;
    const capsuleTop = capsule && capsule.top ? capsule.top : statusBarHeight + 4;

    return {
      statusBarHeight,
      capsuleHeight,
      capsuleTop,
      // 导航栏内容区高度：胶囊上下各留一点呼吸空间
      navBarHeight: (capsuleTop - statusBarHeight) * 2 + capsuleHeight,
      // 胶囊右边距，用来对齐标题位置
      capsuleRight: capsule && capsule.right ? info.windowWidth - capsule.right : 12,
      windowWidth: info.windowWidth || 375,
      windowHeight: info.windowHeight || 667,
      safeBottom: info.safeArea && info.safeArea.bottom
        ? Math.max(0, info.windowHeight - info.safeArea.bottom)
        : 0,
      platform: info.platform || 'devtools',
    };
  } catch (e) {
    return {
      statusBarHeight: 20,
      capsuleHeight: 32,
      capsuleTop: 24,
      navBarHeight: 44,
      capsuleRight: 12,
      windowWidth: 375,
      windowHeight: 667,
      safeBottom: 0,
      platform: 'devtools',
    };
  }
}

function system() {
  if (!cached) cached = read();
  return cached;
}

module.exports = {
  system,
  //  vibrate：把 VoteCard / 按钮的 navigator.vibrate 换成小程序官方 API
  vibrateShort() {
    try {
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light', fail() {} });
    } catch (e) { /* 不支持就算了，不能因为震动报错打断流程 */ }
  },
};
