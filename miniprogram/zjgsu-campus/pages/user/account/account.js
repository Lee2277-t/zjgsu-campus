// pages/user/account —— 账号与数据（注销 / 本机缓存 / 隐私）
//
// 微信对「收集了用户信息的小程序」要求提供删除途径，这一页就是那个途径。
//
// 三个决定写死在文案里，改代码前先读一遍：
//   1) 7 天冷静期。注销入口藏在「我的」页里，属于最容易误触的那一类，
//      而反悔成本极高（好友、聊天记录一次性全没）。提交之后随时可以撤销。
//   2) 内容匿名化保留，关系与私人数据真删。论坛是一串互相咬合的对话，
//      把一个人的帖子和评论整个抽走，剩下的回复会失去上下文
//      （「楼上说得对」指向空气）。而私信、好友、收藏、备忘不承载公共讨论，
//      留着只是让死人占位。
//   3) 二手闲置 / 学习资料**真删**（连文件一起）。它们是交易与资源信息，
//      作者联系不上的挂单只会让买家反复碰壁。
const nav = require('../../../utils/nav.js');
const userApi = require('../../../utils/user.js');
const privacy = require('../../../utils/privacy.js');
// 提示统一走反馈层：裸调 wx.showToast 会被同一时刻的 Loading 抹掉
const feedback = require('../../../utils/feedback.js');

Page({
  data: {
    loading: true,
    // 注销状态：{ pending, leftDays, dueText }
    cancel: { pending: false },
    // 云端读不到时置真：这时候不能显示「没有申请中」——
    // 那是一个我们并不知道结论的判断
    unknown: false,
    busy: false
  },

  onLoad() {
    this.load();
  },

  // 从系统设置返回时重新拉一次：用户可能在别处撤销过
  onShow() {
    if (!this.data.loading) this.load();
  },

  load() {
    return userApi.accountState().then((r) => {
      // null（云函数没响应）与 {pending:false} 必须分得开。
      // 都当「没有注销」的话，一个正在冷静期里的人会以为自己的申请丢了，
      // 于是再提交一次 —— 到期时间被往后推了 7 天，而他从头到尾没做错什么
      if (!r || r.ok === false) {
        this.setData({ loading: false, unknown: true });
        return;
      }
      this.setData({ loading: false, unknown: false, cancel: r });
    }).catch(() => {
      this.setData({ loading: false, unknown: true });
    });
  },

  onCancel() {
    if (this.data.busy) return;
    wx.showModal({
      title: '注销账号',
      content: '提交后进入 7 天冷静期，期间随时可以撤销。\n\n'
        + '到期后会删除：你的资料、好友关系、私信、收藏、备忘、拉黑名单、'
        + '发布的二手闲置与学习资料。\n\n'
        + '你的帖子与评论会保留，但作者显示为「已注销用户」。',
      confirmText: '申请注销',
      confirmColor: '#d9534f',
      success: (res) => {
        if (!res.confirm) return;
        this.submit();
      }
    });
  },

  submit() {
    this.setData({ busy: true });
    feedback.loading('提交中');
    userApi.accountCancel('').then((r) => {
      feedback.hideLoading();
      this.setData({ busy: false });
      if (!r || r.ok === false) {
        feedback.toast((r && r.msg) || '提交失败，稍后再试');
        return;
      }
      feedback.ok('已提交，7 天内可撤销');
      this.load();
    }).catch(() => {
      feedback.hideLoading();
      this.setData({ busy: false });
      feedback.toast('网络不太顺，再试一次');
    });
  },

  onUndo() {
    if (this.data.busy) return;
    wx.showModal({
      title: '撤销注销',
      content: '撤销之后账号照常使用，这次注销申请会被丢弃。',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ busy: true });
        feedback.loading('处理中');
        userApi.accountCancelUndo().then((r) => {
          feedback.hideLoading();
          this.setData({ busy: false });
          if (!r || r.ok === false) {
            feedback.toast((r && r.msg) || '取消失败，再试一次');
            return;
          }
          feedback.ok('已撤销');
          this.load();
        }).catch(() => {
          feedback.hideLoading();
          this.setData({ busy: false });
          feedback.toast('网络不太顺，再试一次');
        });
      }
    });
  },

  // 本机缓存：只动这台手机，云端那份不受影响。
  // 「清除缓存」和「注销账号」放在同一页是有意的 —— 用户想「清掉重来」时，
  // 最常见的误判就是以为清缓存等于清账号，看到两个选项在一起就不会搞错
  onClearCache() {
    wx.showModal({
      title: '清除本机缓存',
      content: '会清掉这台手机上的帖子、评价、收藏、草稿和缓存记录。云端数据不受影响。',
      confirmColor: '#d9534f',
      success: (res) => {
        if (!res.confirm) return;
        let keys = [];
        try { keys = wx.getStorageInfoSync().keys || []; } catch (e) { keys = []; }
        keys.filter((k) => String(k).indexOf('zjgsu_') === 0).forEach((k) => {
          try { wx.removeStorageSync(k); } catch (e) {}
        });
        feedback.ok('已清除');
        setTimeout(() => { wx.reLaunch({ url: '/pages/course/list/list' }); }, 700);
      }
    });
  },

  onPrivacy() {
    privacy.openContract();
  },

  onGuide() {
    nav.go({ url: '/pages/user/guide/guide' });
  }
});
