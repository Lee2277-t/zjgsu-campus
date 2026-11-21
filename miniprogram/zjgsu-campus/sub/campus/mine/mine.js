// sub/campus/mine/mine.js —— 我发起的活动
//
// 这一页不只是「看看自己发过什么」。活动被举报自动下架之后，公开列表里就查不到了
// （云端过滤一次、本地读侧再过滤一次）。作者如果连这里都没有，那条活动就是彻底消失：
// 没有入口、没有原因、没有恢复按钮 —— 被误伤时连问都不知道问谁。
const eventApi = require('../../../utils/event.js');
const nav = require('../../../utils/nav.js');

Page({
  data: {
    items: [],
    loading: true
  },

  onShow() {
    // 每次回来都重算：刚从详情页恢复过一条，列表要立刻跟着变
    this.load();
  },

  async load() {
    let list = eventApi.getMyEvents();
    try {
      await eventApi.fetchEvents(1);
    } catch (e) {}
    // 对账：被下架的那条不在公开列表里，本地缓存还当它活着
    try {
      await eventApi.syncMine();
    } catch (e) {}
    list = eventApi.getMyEvents().map((e) => Object.assign({}, e, {
      typeLabel: eventApi.typeLabel(e.type),
      // WXML 里不能调方法，人数文案在这里算好
      countText: (Number(e.capacity) > 0
        ? (Number(e.joinedCount) || 0) + ' / ' + Number(e.capacity)
        : String(Number(e.joinedCount) || 0)) + ' 人报名'
    }));
    this.setData({ items: list, loading: false });
  },

  goDetail(e) {
    nav.go({ url: '/sub/campus/event/event?id=' + e.currentTarget.dataset.id });
  },

  goAdd() {
    nav.go({ url: '/sub/campus/add/add' });
  }
});
