// components/ui/privacy-modal/index.js
// 《用户隐私保护指引》授权弹窗。
//
// 为什么要单独做一个组件，而不是继续用 wx.showModal：
//   1）showModal 只有「确定 / 取消」两个按钮，塞不进「查看协议」入口，
//      而隐私弹窗必须让用户能打开《用户隐私保护指引》——这是审核要求；
//   2）之前在 App.onLaunch 阶段弹系统弹窗，首页还没渲染完，弹窗经常被吞掉，
//      用户看到的就是「提示要确定隐私协议，却没有可以点同意的地方」。
//
// 现在：组件挂在首页上（页面渲染完成后才可能弹），同意按钮用微信官方的
// <button open-type="agreePrivacyAuthorization"> —— 用户点一下，微信侧真的完成授权，
// 不用我们手动 resolve，也不会出现「点了但没授权成功」的尴尬。
const privacy = require('../../../utils/privacy.js');

Component({
  data: {
    show: false,
    name: '用户隐私保护指引'
  },

  lifetimes: {
    attached() {
      // 微信需要授权时会回调这里：把弹窗亮出来，等用户表态
      this._onAsk = (name) => {
        this.setData({ show: true, name: name || '用户隐私保护指引' });
      };
      privacy.onAsk(this._onAsk);
    },
    detached() {
      privacy.offAsk();
      this._onAsk = null;
    }
  },

  // ⚠️ 页面可见性很关键：tabBar 页面切换时页面**不会销毁**，组件一直挂着。
  // 不管可见性的话，用户在「发帖页」点加图触发授权时，弹窗会显示在**看不见的首页**上 ——
  // 又变回「提示要确定隐私协议，却没地方点同意」。
  // 所以只在自己所在页面处于前台时接管弹窗；页面一隐藏就交还给 privacy.js，
  // 那里会退回系统弹窗（系统弹窗一定出现在当前页面上，看得见）。
  pageLifetimes: {
    show() {
      if (this._onAsk) privacy.onAsk(this._onAsk);
      // 用户可能在弹窗还挂着时点进了「应用说明」等页面；回来时 pending
      // 仍在，但 show 已被 hide() 收起。这里必须重新亮出来，否则授权
      // 请求会一直悬着，头像/选图等隐私接口再也点不动。
      if (privacy.isAsking()) {
        this.setData({
          show: true,
          name: privacy.pendingName() || '用户隐私保护指引'
        });
      }
    },
    hide() {
      privacy.offAsk();
      // 切走时若弹窗还开着就收起来，别在后台页面里留一个看不见的弹窗
      if (this.data.show) this.setData({ show: false });
    }
  },

  methods: {
    // 官方按钮：微信已在这一步完成授权，我们只需要收起弹窗并清理内部状态
    onAgree(e) {
      privacy.answer(true);
      this.setData({ show: false });
    },

    // 万一按钮的授权事件没触发（极老的微信版本），兜底也把「同意」传达出去
    onAgreeTap() {
      privacy.answer(true);
      this.setData({ show: false });
    },

    onDeny() {
      privacy.answer(false);
      this.setData({ show: false });
      wx.showToast({ title: '未同意则无法使用选图等功能', icon: 'none', duration: 2000 });
    },

    openContract() {
      privacy.openContract();
    },

    // 遮罩本身不拦截：隐私弹窗必须等用户明确表态，点空白处不给过，
    // 否则用户会莫名「被同意」或「被拒绝」
    noop() {}
  }
});
