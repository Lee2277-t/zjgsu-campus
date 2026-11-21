// components/ui/back-top/index.js
Component({
  properties: {
    visible: { type: Boolean, value: false },
    bottom: { type: String, value: '180rpx' }
  },
  methods: {
    onTap() {
      wx.pageScrollTo({ scrollTop: 0, duration: 260 });
    }
  }
});
