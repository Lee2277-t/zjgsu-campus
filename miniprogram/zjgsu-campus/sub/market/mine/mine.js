// sub/market/mine/mine.js —— 我发布的信息
// 入口在列表页右上角；删除 / 标记解决这些操作都在详情页，这里只负责列出来。
const market = require('../../../utils/market.js');
const nav = require('../../../utils/nav.js');

Page({
  data: {
    items: [],
    loading: true
  },

  onShow() {
    this.load();
  },

  async load() {
    let list = market.getMyMarkets();
    try {
      await market.fetchMarkets(1);
    } catch (e) {}
    // 对账：被举报下架的那条不在公开列表里，本地缓存还当它活着 ——
    // 不对这一次，作者看到的会是一条「正常显示、点进去说不见了」的条目
    try {
      await market.syncMine();
    } catch (e) {}
    list = market.getMyMarkets();
    this.setData({ items: list, loading: false });
  },

  goDetail(e) {
    nav.go({ url: '/sub/market/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  goEdit() {
    nav.go({ url: '/sub/market/edit/edit' });
  }
});
