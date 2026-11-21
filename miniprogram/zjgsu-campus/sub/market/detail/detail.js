// sub/market/detail/detail.js —— 失物招领 / 二手 详情
// 这一页真正的目的只有一个：让丢东西和捡到东西的人能联系上。
// 所以联系方式要显眼，联系不上就退一步给「打个招呼」——直接进私信。
const feedback = require('../../../utils/feedback.js');
const market = require('../../../utils/market.js');
const nav = require('../../../utils/nav.js');
const userApi = require('../../../utils/user.js');
const moderation = require('../../../utils/moderation.js');
const config = require('../../../utils/config.js');

Page({
  data: {
    item: null,
    loading: true,
    loadingText: '加载中…',
    // 自己这条被举报下架了：内容照常展示，但顶上多一条说明 + 恢复按钮。
    // 别人看到的仍然是「这条记录不见了」
    paused: false,
    // 浏览人数文案。低于门槛是空串（整行不显示），门槛见 config.VIEW_SHOW_MIN。
    // 由云函数回，不靠集合权限 —— content_views 一行一个浏览者、带 openid，不能直连读
    viewsText: ''
  },

  onLoad(options) {
    this.id = options.id || '';
    this.load();
    // 上报一次浏览（一人一次、作者不计），顺手把「几个人看过」显示出来。
    // 这条记录被举报时，下架门槛按「几个人看过」分档 —— 没这个分母，
    // 热门的闲置也只是三个人举报就会被收起来。失败静默，不影响看内容
    userApi.contentView('market', this.id).then((r) => {
      // 低于门槛不显示：小数字读起来不是「这条没人看」，是「这个平台没人」
      const v = Number(r && r.views) || 0;
      if (v >= config.VIEW_SHOW_MIN) this.setData({ viewsText: v + ' 人看过' });
    }).catch(() => {});
  },

  onShow() {
    // 从私信返回时状态可能已经变了（对方已解决）
    if (this.id) this.load();
  },

  async load() {
    if (!this.id) {
      this.setData({ loading: false, loadingText: '这条记录不存在' });
      return;
    }
    // 先吃本地缓存，别让用户对着空白等网络。
    // 这里要连「自己那条已下架」的一起取：别人打开只会看到「不见了」，
    // 作者得能看到内容 + 一句说明 + 恢复按钮，否则被误伤时完全没有出口
    const local = market.getMarketById(this.id) || market.getMineById(this.id);
    if (local) this.setData({ item: local, paused: local.hidden === true, loading: false });

    // 再拉一次云端：状态（已解决）可能被别人改过
    try {
      await market.fetchMarkets(1);
    } catch (e) {}
    // 顺手对账：被下架的那条不在公开列表里，只能靠云端告诉我「它现在是什么状态」
    try {
      await market.syncMine();
    } catch (e) {}
    const fresh = market.getMarketById(this.id);
    const own = market.getMineById(this.id);
    // 拉取成功但这条不见了 = 已被下架 / 删除（发帖人删了、被举报处置了）。
    // 这时候不能退回 local 继续展示 —— 那等于让本机缓存把「已处置」的内容复活。
    // 只有「拉取失败」才用缓存兜底
    const fetchedOk = market.fetchState().ok !== false;
    const shown = fresh || own || (fetchedOk ? null : local);
    this.setData({
      item: shown,
      paused: !!(shown && shown.hidden === true),
      loading: false,
      loadingText: '这条记录不见了'
    });
    if (shown) {
      wx.setNavigationBarTitle({ title: market.typeLabel(shown.type) + '详情' });
    }
  },

  copyContact() {
    const c = (this.data.item && this.data.item.contact) || '';
    if (!c) {
      wx.showToast({ title: '发布者没留联系方式', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: c,
      success: () => wx.showToast({ title: '联系方式已复制', icon: 'success' })
    });
  },

  // 直接进私信：比切出去翻通讯录快一步
  goChat() {
    const it = this.data.item || {};
    const name = it.author || '这位同学';
    if (!it.openid) {
      wx.showToast({ title: '暂时联系不上发布者', icon: 'none' });
      return;
    }
    nav.go({ url: '/pages/user/chat/chat?peer=' + it.openid + '&name=' + name });
  },

  async onDone() {
    const it = this.data.item || {};
    if (!it.isMine) return;
    const r = await market.markDone(it.id);
    if (!r || !r.ok) {
      feedback.toast((r && r.msg) || '操作失败，请稍后重试');
      return;
    }
    this.load();
    // 用云端确认后的状态说话：以前读的是点击前那份 it.done，
    // 于是「标记为解决」弹的永远是「已重新开放」，正好相反
    feedback.toast(r.item && r.item.done ? '已标记为解决' : '已重新开放', { icon: 'success' });
  },

  onDelete() {
    const it = this.data.item || {};
    wx.showModal({
      title: '删除这条',
      content: '删掉之后其他人就看不到了，确定吗？',
      confirmColor: '#d9534f',
      success: async (res) => {
        if (!res.confirm) return;
        const r = await market.removeMarket(it.id);
        if (!r || !r.ok) {
          feedback.toast((r && r.msg) || '删除失败，请稍后重试');
          return;
        }
        wx.navigateBack();
      }
    });
  },

  // 举报这条闲置。走的是和帖子同一条云端链路（report，targetType=market），
  // 所以多人举报的阈值、内容保护、审核队列全都自动适用 ——
  // 以前闲置根本没有举报入口，遇到「二手区刷屏卖假货」只能干看着
  onReport() {
    const it = this.data.item || {};
    if (!it.id || it.isMine) return;
    wx.showActionSheet({
      itemList: moderation.REPORT_REASONS,
      success: (res) => {
        const reason = moderation.REPORT_REASONS[res.tapIndex];
        wx.showModal({
          title: '举报：' + reason,
          content: moderation.reportTip(reason),
          placeholderText: '例如：这条在卖校外培训班的名额',
          editable: true,
          confirmColor: '#d9534f',
          success: async (m) => {
            if (!m.confirm) return;
            const r = await userApi.reportPost(
              it.openid || '', reason, (m.content || '').slice(0, 200), it.id, 'market'
            );
            // 断网时云端一条没写：绝不能提示「已提交」。
            // 自动处置靠多人凑票，用户以为算上了自己这一票，之后什么也不会发生
            if (r && r.degraded) {
              feedback.toast('网络不太顺，没提交上');
              return;
            }
            feedback.toast((r && r.msg) || '已提交');
            // 云端当场判定了下架 / 删除：本机这份也摘掉，别让缓存把已处置的内容留着
            if (r && (r.action === 'hide' || r.action === 'delete')) {
              market.removeLocal(it.id);
              setTimeout(() => wx.navigateBack(), 800);
            }
          }
        });
      },
      fail: () => {}
    });
  },

  // 自己被自动下架的那条：给一个直接的恢复入口，不用去找审核员。
  // 帖子详情早就有这个按钮，闲置以前只有「不见了」——被误伤的同学连问都不知道问谁
  onRestore() {
    wx.showModal({
      title: '恢复展示',
      content: '确认这条内容没有违规吗？恢复后其他同学就能重新看到。',
      success: async (m) => {
        if (!m.confirm) return;
        const r = await market.restoreMarket(this.id);
        if (!r || !r.ok) {
          feedback.toast((r && r.msg) || '恢复失败，请稍后重试');
          return;
        }
        feedback.toast('已恢复', { icon: 'success' });
        this.load();
      }
    });
  },

  previewImages(e) {
    const urls = e.currentTarget.dataset.imgs || [];
    if (!urls.length) return;
    wx.previewImage({ current: urls[0], urls: urls });
  },

  onShareAppMessage() {
    const it = this.data.item || {};
    const imgs = it.images || [];
    return {
      title: (it.title || '一条校园信息') + ' · 商砖小站',
      path: '/sub/market/detail/detail?id=' + this.id,
      imageUrl: imgs[0] || ''
    };
  },

  onShareTimeline() {
    const it = this.data.item || {};
    return { title: it.title || '商砖小站 · 失物招领与闲置分享', query: 'id=' + this.id };
  }
});
