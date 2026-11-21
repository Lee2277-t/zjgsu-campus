// pages/forum/hidden —— 被举报暂停展示的内容
//
// 这个页面存在的理由：**让人看得到「为什么没了」**。
//
// 一条内容被举报到门槛就自动下架，会从所有公开列表里消失。藏起来是它该做的，
// 可是藏了之后学校里没人再看得见它 —— 作者不知道发生了什么，
// 想补一句「我也觉得有问题」的同学也找不到地方。
// 所以下架的内容留一个人人都能进的出口：进来能看、能申诉，也能继续举报
// （多出来的票不再触发自动删除，但会作为审核员判断的分量留在队列里）。
const store = require('../../../utils/store.js');
const nav = require('../../../utils/nav.js');

Page({
  data: {
    posts: [],
    loading: true
  },

  onShow() {
    this.load();
  },

  load() {
    // 每次进来都重取：上一条刚被删掉，列表得跟着变，不然会残留一条已经没了的内容
    const posts = store.getHiddenPosts();
    this.setData({ posts, loading: false });
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id || '';
    if (!id) return;
    nav.go({ url: '/sub/forum/detail/detail?id=' + id });
  },

  onPullDownRefresh() {
    this.load();
    wx.stopPullDownRefresh();
  }
});
