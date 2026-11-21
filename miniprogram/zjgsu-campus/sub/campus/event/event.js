// sub/campus/event/event.js —— 活动详情（报名 / 取消报名 / 删除）
//
// 报名是这个功能唯一有「可撤销副作用」的动作：
// 报名人数要加、取消要减，还不能在云函数挂掉时谎报成功——
// 谎报之后同学以为报上了，到现场才发现没进去，比直接报错难受得多。
const eventApi = require('../../../utils/event.js');
const store = require('../../../utils/store.js');
const userApi = require('../../../utils/user.js');
const moderation = require('../../../utils/moderation.js');
const feedback = require('../../../utils/feedback.js');
const config = require('../../../utils/config.js');
const nav = require('../../../utils/nav.js');
const markdown = require('../../utils/markdown.js');

Page({
  data: {
    id: '',
    ev: null,
    loading: true,
    joining: false,
    // 联系方式只有报过名 / 是自己发起的才显示：没报就能看号码，等于把私域流量公开
    contactVisible: false,
    // 只有招聘会能收藏。官网公告是看完就走的东西，收起来反而占地方
    favorited: false,
    notFound: false,
    // 自己这条被举报下架：只有作者看得到这一屏，别人打开是「找不到了」
    paused: false,
    // 浏览人数文案。低于门槛是空串（整行不显示），门槛见 config.VIEW_SHOW_MIN。
    // 由云函数回，不靠集合权限 —— 浏览记录里带 openid，不能公开
    viewsText: '',
    // 官网正文：云端抓取并转 Markdown，这里再转成 rich-text 节点
    articleNodes: [],
    articleLoading: false,
    articleError: ''
  },

  onLoad(query) {
    this.setData({ id: (query && query.id) || '' });
    this.load(true);
    // 上报一次浏览（一人一次、作者不计），顺手把「几个人看过」显示出来。
    // 活动被举报时下架门槛按「几个人看过」分档，没有分母的话
    // 三个人举报就能把一个两百人报名的活动收起来
    userApi.contentView('event', this.data.id).then((r) => {
      // 低于门槛不显示：小数字读起来不是「这个活动没人看」，是「这个平台没人」
      const v = Number(r && r.views) || 0;
      if (v >= config.VIEW_SHOW_MIN) this.setData({ viewsText: v + ' 人看过' });
    }).catch(() => {});
  },

  onShow() {
    // 兜底：如果遮罩还挂着（上次提交被中断），顺手收掉。
    // 残留的 showLoading 会盖住整屏，之后所有按钮都点不动 —— 正是「点了没反应」的经典成因。
    if (this.data.joining) {
      this.setData({ joining: false });
      wx.hideLoading();
      wx.showToast({ title: '上一步没走完，已复位', icon: 'none' });
      this.load(true);
    }
  },

  async load(showLoading) {
    const id = this.data.id;
    if (!id) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    // 本地已经有这条活动就先渲染，云端刷新放后台；点进详情不再先等一次网络。
    const local = eventApi.getEventById(id);
    if (local) this.decorate(local);
    if (showLoading && !local) wx.showLoading({ title: '加载中', mask: true });
    // 从云端重拉一遍：报名状态、人数都由服务端判定，本地缓存说了不算
    await eventApi.fetchEvents(1);
    // 顺便对账：被举报下架的活动不在公开列表里，本地缓存还当它活着。
    // 不对这一次，作者永远不知道自己那条已经被暂停展示了
    try {
      await eventApi.syncMine();
    } catch (e) {}
    wx.hideLoading();

    const ev = eventApi.getEventById(id);
    if (!ev) {
      // 自己发起的那条被下架了：公开查询一律 null（别人也不该看到），
      // 但作者必须进得来 —— 这一页是他唯一能看到原因、点恢复的地方
      const own = eventApi.getMineById(id);
      if (own && own.hidden === true) {
        this.decorate(own);
        return;
      }
      this.setData({ loading: false, notFound: true });
      return;
    }
    this.decorate(ev);
  },

  // WXML 里不能调方法，展示用的派生字段在这里一次算好
  decorate(ev) {
    const cap = Number(ev.capacity) || 0;
    const count = Number(ev.joinedCount) || 0;
    this.setData({
      ev: Object.assign({}, ev, {
        typeIcon: ev.official ? 'shield-check️' : eventApi.typeIcon(ev.type),
        typeLabel: ev.official ? '官方' : eventApi.typeLabel(ev.type),
        countText: cap > 0 ? (count + ' / ' + cap + ' 人已报名') : (count + ' 人已报名'),
        fullText: cap > 0 && count >= cap ? '人数已满' : '',
        // 官网抓下来的活动没有报名接口（发布方是学校，不走这套报名表），
        // 所以这类活动只给「看原文」的出口，不给「我要报名」的按钮
        official: !!ev.official
      }),
      // WXML 里不能调方法，展示用的派生字段在这里一次算好
      fullShown: !!(cap > 0 && count >= cap),
      // 自己被举报下架：内容照常展示给作者，顶上多一条说明 + 恢复按钮
      paused: ev.hidden === true,
      contactVisible: !!ev.joined || !!ev.isMine,
      favorited: ev.type === 'jobfair' && store.isFavorited('event', ev.id),
      loading: false
    });
    this.loadArticle(ev);
  },

  // 官网正文只在详情页按需拉取并缓存，不拖慢每天的列表同步。
  loadArticle(ev) {
    if (!ev || !ev.official || !ev.sourceUrl) return;
    if (this._articleId === ev.id && (this.data.articleLoading || this.data.articleNodes.length)) return;
    this._articleId = ev.id;
    this.setData({ articleLoading: true, articleError: '' });
    eventApi.fetchArticle(ev.id).then((r) => {
      if (this.data.id !== ev.id) return;
      if (!r || r.ok === false) {
        this.setData({
          articleLoading: false,
          articleError: (r && r.msg) || '官网正文暂时无法读取'
        });
        return;
      }
      const nodes = markdown.toNodes(r.markdown || '');
      this.setData({
        articleLoading: false,
        articleNodes: nodes,
        articleError: nodes.length ? '' : '官网正文为空'
      });
    }).catch(() => {
      this.setData({ articleLoading: false, articleError: '官网正文暂时无法读取' });
    });
  },

  goBack() {
    wx.navigateBack();
  },

  /* ---------------- 收藏 ---------------- */

  // 收藏这场招聘会。和校园页卡片上那处走同一个 store 开关：
  // 两处显示的状态必须一致，否则同学会以为收藏没生效。
  onFavorite() {
    const ev = this.data.ev || {};
    const r = store.toggleFavorite({
      type: 'event',
      id: ev.id,
      title: ev.title || '',
      when: ev.start || '',
      place: ev.location || ''
    });
    if (!r || !r.ok) {
      wx.showToast({ title: '没能收藏上', icon: 'none' });
      return;
    }
    this.setData({ favorited: !!r.favorited });
    wx.showToast({
      title: r.favorited ? '已收藏，去「我的收藏」里看' : '已取消收藏',
      icon: 'none'
    });
  },

  /* ---------------- 报名 ---------------- */

  async onJoin() {
    const ev = this.data.ev;
    if (!ev) return;
    if (this.data.joining) {
      wx.showToast({ title: '正在提交，稍等一下', icon: 'none' });
      return;
    }
    this.setData({ joining: true });
    wx.showLoading({ title: '提交中', mask: true });
    const r = await eventApi.joinEvent(ev.id);
    wx.hideLoading();
    if (!r || r.ok === false) {
      this.setData({ joining: false });
      wx.showToast({ title: (r && r.msg) || '报名失败', icon: 'none' });
      return;
    }
    this.setData({ joining: false });
    wx.showToast({ title: r.already ? '你已经报名了' : '报名成功', icon: 'success' });
    await this.load(false);
  },

  async onCancel() {
    const ev = this.data.ev;
    if (!ev) return;
    if (this.data.joining) {
      wx.showToast({ title: '正在提交，稍等一下', icon: 'none' });
      return;
    }
    const d = await new Promise((resolve) => {
      wx.showModal({
        title: '取消报名？',
        content: '名额会立刻让给其他同学，之后再报要重新点',
        confirmText: '取消报名',
        confirmColor: '#d9534f',
        success: (r) => resolve(r)
      });
    });
    if (!d || !d.confirm) return;

    this.setData({ joining: true });
    wx.showLoading({ title: '提交中', mask: true });
    const r = await eventApi.cancelJoin(ev.id);
    wx.hideLoading();
    if (!r || r.ok === false) {
      this.setData({ joining: false });
      wx.showToast({ title: (r && r.msg) || '取消失败', icon: 'none' });
      return;
    }
    this.setData({ joining: false });
    wx.showToast({ title: '已取消报名', icon: 'success' });
    await this.load(false);
  },

  /* ---------------- 举报 ---------------- */

  // 和帖子 / 闲置走同一条云端链路（report，targetType=event），
  // 所以多人举报阈值、内容保护、审核队列全部自动适用
  onReport() {
    const ev = this.data.ev || {};
    if (!ev.id || ev.isMine || ev.official) return;
    wx.showActionSheet({
      itemList: moderation.REPORT_REASONS,
      success: (res) => {
        const reason = moderation.REPORT_REASONS[res.tapIndex];
        wx.showModal({
          title: '举报：' + reason,
          content: moderation.reportTip(reason),
          placeholderText: '例如：这个活动在收费拉人',
          editable: true,
          confirmColor: '#d9534f',
          success: async (m) => {
            if (!m.confirm) return;
            const r = await userApi.reportPost(
              ev.openid || '', reason, (m.content || '').slice(0, 200), ev.id, 'event'
            );
            if (r && r.degraded) {
              feedback.toast('网络不太顺，没提交上');
              return;
            }
            feedback.toast((r && r.msg) || '已提交');
            if (r && (r.action === 'hide' || r.action === 'delete')) {
              eventApi.removeLocal(ev.id);
              setTimeout(() => wx.navigateBack(), 800);
            }
          }
        });
      },
      fail: () => {}
    });
  },

  /* ---------------- 恢复展示 ---------------- */

  // 自己被自动下架的活动：给一个直接恢复的入口。
  // 帖子 / 闲置详情都有这一手，活动以前只有「找不到了」——被误伤时连申诉对象都没有
  async onRestore() {
    const d = await new Promise((resolve) => {
      wx.showModal({
        title: '恢复展示',
        content: '确认这个活动没有违规吗？恢复后其他同学就能重新看到、继续报名。',
        success: (r) => resolve(r)
      });
    });
    if (!d || !d.confirm) return;
    const r = await eventApi.restoreEvent(this.data.id);
    if (!r || !r.ok) {
      feedback.toast((r && r.msg) || '恢复失败，请稍后重试');
      return;
    }
    feedback.toast('已恢复', { icon: 'success' });
    this.load(false);
  },

  /* ---------------- 删除 / 联系 ---------------- */

  async onRemove() {
    const ev = this.data.ev;
    if (!ev || !ev.isMine) return;
    const d = await new Promise((resolve) => {
      wx.showModal({
        title: '删除这个活动？',
        content: '报名记录会一起清掉，确认吗？',
        confirmText: '删除',
        confirmColor: '#d9534f',
        success: (r) => resolve(r)
      });
    });
    if (!d || !d.confirm) return;
    wx.showLoading({ title: '删除中', mask: true });
    const r = await eventApi.removeEvent(ev.id);
    wx.hideLoading();
    if (!r || r.ok === false) {
      wx.showToast({ title: (r && r.msg) || '删除失败', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已删除', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 600);
  },

  // 个人主体没有业务域名可配 web-view；正文已经在本页用 Markdown 展示，
  // 这里只复制原文链接，不再跳一个可能打不开的 web-view。
  onCopySource() {
    const ev = this.data.ev || {};
    const url = String(ev.sourceUrl || '');
    if (!url) {
      wx.showToast({ title: '这条没有原文链接', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '原文链接已复制', icon: 'none' })
    });
  },

  // 复制联系方式：报名的人总要能找到组织的人
  onCopyContact() {
    const ev = this.data.ev;
    if (!ev || !ev.contact) return;
    wx.setClipboardData({
      data: String(ev.contact),
      success: () => wx.showToast({ title: '已复制联系方式', icon: 'none' })
    });
  },

  onShareAppMessage() {
    const ev = this.data.ev || {};
    return {
      title: (ev.title ? '商砖小站 · ' + ev.title : '商砖小站 · 校园活动'),
      path: '/pages/campus/campus'
    };
  }
});
