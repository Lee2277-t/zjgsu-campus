// pages/forum/comment-appeal —— 留言申诉
//
// 这一页存在的理由只有一条：**自动处置必须有一个对手方**。
// 留言被多人举报删掉时，作者以前是完全静默的 —— 他下次打开只发现自己那条没了，
// 连「是被删了」还是「发失败了」都分不清，更没有地方说一句「你们判错了」。
//
// 所以这一页只做三件事：把被删的那条原文摆出来、说清是谁以什么理由删的、
// 收一段申诉理由交上去。它不承诺恢复 —— 申诉是放回人工队列，不是一键复活，
// 界面上也不能暗示「交了就没事了」
const userApi = require('../../../utils/user.js');
const feedback = require('../../../utils/feedback.js');
const report = require('../../../utils/report.js');

// 太短的申诉没法处理：「我没错」三个字，老师拿它跟留言原文对不上任何东西。
// 和云函数侧的校验保持一致，前端先拦一道，省得白跑一趟网络
const MIN_LEN = 10;
const MAX_LEN = 300;

Page({
  data: {
    postId: '',
    commentId: '',
    loading: true,
    submitting: false,
    // 拉不到 / 找不到 / 不是你的，三种必须分开说：
    // 一句「加载失败」会让「这条真没了」和「网络不好」长得一模一样
    error: '',
    info: null,
    text: '',
    minLen: MIN_LEN,
    maxLen: MAX_LEN,
    canSubmit: false
  },

  onLoad(q) {
    const query = q || {};
    this.setData({
      postId: String(query.postId || ''),
      commentId: String(query.commentId || '')
    });
    this.load();
  },

  load() {
    const cid = this.data.commentId;
    if (!cid) {
      this.setData({ loading: false, error: '链接不完整，找不到要申诉的留言' });
      return;
    }
    this.setData({ loading: true, error: '' });
    userApi.commentAppealInfo(this.data.postId, cid).then((r) => {
      if (!r || r.ok === false) {
        this.setData({
          loading: false,
          // 云端的 msg 已经区分了「找不到」和「不是你的」，直接用
          error: (r && r.msg) || '暂时读不到这条留言'
        });
        return;
      }
      this.setData({ loading: false, info: r });
    }).catch((e) => {
      // 只有意外才上报：断网是常见状态，不是 bug
      report.report('comment-appeal/load', e);
      this.setData({ loading: false, error: '网络不太顺，重试一次' });
    });
  },

  onInput(e) {
    const v = String((e.detail && e.detail.value) || '').slice(0, MAX_LEN);
    this.setData({ text: v, canSubmit: v.trim().length >= MIN_LEN });
  },

  onSubmit() {
    if (this.data.submitting) return;
    const text = String(this.data.text || '').trim();
    if (text.length < MIN_LEN) {
      feedback.toast('说说为什么觉得判错了（至少 ' + MIN_LEN + ' 个字）');
      return;
    }
    this.setData({ submitting: true });
    userApi.commentAppeal(this.data.commentId, text).then((r) => {
      this.setData({ submitting: false });
      if (!r || r.ok === false) {
        feedback.toast((r && r.msg) || '没提交上，再试一次');
        return;
      }
      feedback.ok((r && r.msg) || '申诉已提交');
      // 重新拉一次状态：页面上「还能申诉」要变成「已提交，等待复核」，
      // 不然用户会以为没成功，再点一次
      this.load();
    }).catch((e) => {
      report.report('comment-appeal/submit', e);
      this.setData({ submitting: false });
      feedback.toast('网络不太顺，没提交上');
    });
  },

  // 回帖子里看看：申诉的是那条留言所在的内容，
  // 用户常常需要回去确认「我到底说了什么」
  goPost() {
    if (!this.data.postId) return;
    wx.redirectTo({ url: '/sub/forum/detail/detail?id=' + encodeURIComponent(this.data.postId) });
  }
});
