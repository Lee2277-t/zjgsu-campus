// components/ui/app-header/index.js
// 迁移自 src/components/ui/AppHeader.vue
// Web 版用 window.history.length 判断能不能返回；小程序用页面栈，
// 栈深 <= 1 说明是直接打开的（比如扫码 / 分享直达），这时给一个兜底首页。
//
// 关键修正（第 4 点：二级页顶部突兀显示时间和电量）：
//   以前这个组件自己画了一层「假状态栏」—— 时间、5G、电池图标，
//   而且它的高度恰好等于系统状态栏高度，等于**盖在系统画的状态栏上面**。
//   于是二级页顶部出现两组时间电量，颜色 / 字体 / 位置都对不上，
//   看起来就是「突兀的一条，跟背景割裂」。
//   小程序自定义导航时状态栏由系统绘制，页面只需要**占位**。
//   现在只保留 padding-top = statusBarHeight 的空白，不再伪造系统 UI。
//
// 配套：深底页面（树洞 / 盲盒）要在 page.json 里把 navigationBarTextStyle
// 设成 white，否则系统状态栏文字是黑的，压在深底上同样看不清。

const { system } = require('../../../utils/system.js');

Component({
  properties: {
    title: { type: String, value: '' },
    showBack: { type: Boolean, value: false },
    dark: { type: Boolean, value: false },
    // 背景色：默认白；深底页 / 有底纹的页传自己的底色进来，
    // 导航栏和页面才连成一片（以前写死 #ffffff，深底页顶部是白条，割裂感就来自这）
    bg: { type: String, value: '' },
    // 底部那条 1px 分割线：深底页和纯色页一般不要
    border: { type: Boolean, value: true }
  },

  data: {
    nav: {}
  },

  lifetimes: {
    attached() {
      this.setData({ nav: system() });
    }
  },

  methods: {
    onBack() {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack({ delta: 1 });
      } else {
        wx.switchTab({ url: '/pages/course/list/list' });
      }
      this.triggerEvent('back');
    }
  }
});
