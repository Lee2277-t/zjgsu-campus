// sub/campus/webview —— 学校官网原文。只允许 zjgsu.edu.cn 及其子域名。
const official = require('../../../utils/official.js');

Page({
  data: {
    url: '',
    title: '',
    invalid: false,
    failed: false
  },

  onLoad(options) {
    const raw = String((options && options.url) || '');
    let url = '';
    try { url = decodeURIComponent(raw); } catch (e) { url = raw; }
    const title = String((options && options.title) || '官网原文');
    if (!official.isOfficialUrl(url)) {
      this.setData({ invalid: true, url: '', title: title });
      this.copy(url);
      return;
    }
    this.setData({ url: url, title: title });
    wx.setNavigationBarTitle({ title: title || '官网原文' });
  },

  copy(url) {
    const s = String(url || '');
    if (!s) return;
    wx.setClipboardData({
      data: s,
      success: () => wx.showToast({ title: '链接已复制，可到浏览器打开', icon: 'none' })
    });
  },

  onError() {
    if (this.data.failed) return;
    this.setData({ failed: true });
    this.copy(this.data.url);
    wx.showModal({
      title: '官网页面打不开',
      content: '可能是业务域名还没配置好。链接已复制，可以先到浏览器查看。',
      showCancel: false
    });
  },

  onCopy() {
    this.copy(this.data.url || '');
  },

  goBack() {
    wx.navigateBack();
  }
});