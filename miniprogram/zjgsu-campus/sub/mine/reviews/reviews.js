// sub/mine/reviews/reviews.js —— 我的课程评价
//
// 和「我的帖子」一样，这份列表原本长在「我的」页最底下，和帖子列表一起
// 把整页撑到两屏开外。现在数字卡「课程评价」直接点进来，删除操作也收在这里。
//
// 评价的存在意义是「给别人看」，所以这页的点击主路径是进课程 —— 自己回头
// 改主意了，也能直接删掉。删完课程页的均分会跟着变（store.removeReview 处理）。
const store = require('../../../utils/store.js');
const nav = require('../../../utils/nav.js');

Page({
  data: {
    reviews: []
  },

  onShow() {
    this.load();
  },

  load() {
    // canDelete 与课程名都要在这里算好：WXML 的 {{}} 里既调不了函数，
    // 也读不到「这条评价挂在哪个课程下」（评价只存了 courseId）
    const reviews = store.getMyReviews().map((r) => {
      const c = store.getCourseById(r.courseId);
      // 「只评老师」那条没有课程，显示「老师评价 · XXX」，
      // 否则列表里一排「未知课程」，作者自己都认不出哪条是哪条
      const name = c ? c.name
        : (r.teacher ? '老师评价 · ' + r.teacher : '未知课程');
      return Object.assign({}, r, {
        courseName: name,
        starOn: r.score,
        canDelete: store.isMineReview(r)
      });
    });
    this.setData({ reviews: reviews });
  },

  // 进课程详情。只评老师的那条没有 courseId，点了不该跳到 /course/detail?id= 这种坏链接
  goCourse(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) {
      wx.showToast({ title: '这条评价挂在老师名下，没有对应课程', icon: 'none' });
      return;
    }
    nav.go({ url: '/sub/course/detail/detail?id=' + id });
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除这条评价',
      content: '删掉后其他人就看不到这条了，确定吗？',
      confirmColor: '#d9534f',
      success: async (res) => {
        if (!res.confirm) return;
        // removeReview 现在是「先云端、后本地」并返回结果：
        // 云端没删掉就不能说「已删除」，否则别人那边还看得见这条评价
        const r = await store.removeReview(id);
        if (!r || !r.ok) {
          wx.showToast({ title: (r && r.msg) || '删除失败，请稍后重试', icon: 'none' });
          return;
        }
        this.load();
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  // 一条评价都没有时给的出口。课程列表是 tabBar 页，
  // navigateTo 跳不过去（会静默失败），必须走 switchTab
  goWrite() {
    wx.switchTab({ url: '/pages/course/list/list' });
  }
});
