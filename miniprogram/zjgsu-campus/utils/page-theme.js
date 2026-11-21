// utils/page-theme.js —— 给每个页面挂上「手动主题」的数据管道
//
// 背景见 utils/theme.js：强制深浅色只能靠 <page-meta page-style> 把 --c-* 令牌
// 以内联样式写到页面根节点上。也就是说，**每一个页面**都要有：
//   ① wxml 第一行一个 <page-meta page-style="{{themeStyle}}" />
//   ② data 里有一个 themeStyle
//   ③ onShow 时重算一次（用户可能刚在「我的」里切过）
//
// 41 个页面各抄一遍 ②③，一定会漏、也一定会有人忘了给新页面加。
// 所以这里统一接管 Page 的注册：包一层，把 themeStyle 塞进 data、
// 把 onShow 包一层重算 + 订阅变化。页面自己什么都不用写。
//
// 为什么可以直接改写全局的 Page：
//   小程序里 Page 是个全局函数，页面 js 在**首次导航时**才执行，
//   而 app.js 早就跑完了。所以在这里替换掉 Page，之后注册的每个页面
//   都会经过这一层。这是小程序里做「全局 mixin」的常规做法
//   （官方没有 Page.behaviors，只能这样）。
//
// 失败时必须是「静默降级」：拿不到 Page 就什么都不做，
// 页面照旧跟随系统 —— 大不了是「开关点了没反应」，
// 绝不能因为装不上这个补丁而让整个小程序起不来。
const theme = require('./theme.js');

let installed = false;

function install() {
  if (installed) return false;
  if (typeof Page !== 'function') return false;
  if (Page.__themePatched) { installed = true; return false; }

  const raw = Page;

  const patched = function (cfg) {
    const c = cfg || {};
    // 页面自己写了 themeStyle 就以它为准（目前没有，留个出口）
    if (!c.data || c.data.themeStyle === undefined) {
      c.data = Object.assign({ themeStyle: theme.pageStyle() }, c.data || {});
    }

    const onShow = c.onShow;
    const onHide = c.onHide;
    const onUnload = c.onUnload;
    // 只订阅「当前显示中」的那一页：后台页面没人看，
    // 给它们 setData 纯属浪费渲染层带宽
    let off = null;

    const apply = function () {
      const s = theme.pageStyle();
      if (s !== this.data.themeStyle) this.setData({ themeStyle: s });
      // 原生导航栏 / tabBar 不认 page-meta，页面展示时补一次。
      theme.applyNative();
    };

    c.onShow = function () {
      if (off) { off(); off = null; }
      apply.call(this);
      off = theme.onChange(() => apply.call(this));
      if (onShow) return onShow.apply(this, arguments);
      return undefined;
    };

    c.onHide = function () {
      if (off) { off(); off = null; }
      if (onHide) return onHide.apply(this, arguments);
      return undefined;
    };

    c.onUnload = function () {
      if (off) { off(); off = null; }
      if (onUnload) return onUnload.apply(this, arguments);
      return undefined;
    };

    return raw(c);
  };

  patched.__themePatched = true;

  try {
    Page = patched; // eslint-disable-line no-global-assign
    installed = true;
    return true;
  } catch (e) {
    // 严格模式下赋值全局会抛。退一步再试一次，还不行就安静放弃
    try {
      if (typeof globalThis !== 'undefined') {
        globalThis.Page = patched;
        installed = true;
        return true;
      }
    } catch (e2) { /* 放弃：页面继续跟随系统 */ }
    return false;
  }
}

module.exports = { install, isInstalled: () => installed };
