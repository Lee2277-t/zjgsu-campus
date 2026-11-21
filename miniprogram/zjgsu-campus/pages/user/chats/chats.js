// pages/user/chats/chats.js —— 私信会话列表
// 时间、未读这些展示用的字段都在 JS 里算好：WXML 的模板表达式不支持任何函数调用，
// 写成 {{formatTime(x)}} 会让整页渲染崩掉。
//
// 列表分两段（口径与云函数 chatList 完全一致）：
//   请求箱 requests —— 还不是好友、对方先开口、我从来没回过
//   主列表 list     —— 其余（好友，或我已经回过话的对话）
// 分成两段是为了让陌生人发来的广告不占主列表的第一格 —— 混在一起时，
// 用户点开看到的第一条就是广告，而这条会话从此永远挂在最上面。
const chat = require('../../../utils/chat.js');
const unread = require('../../../utils/unread.js');
const nav = require('../../../utils/nav.js');
const feedback = require('../../../utils/feedback.js');

// 每页条数。两段各自分页，不能共用 offset（见 utils/chat.js 的 listPage）。
// 30 条一页在「翻页次数」和「一次搬多少数据」之间取中：50 条时
// 每条还要带对方资料，校园网下第一屏就得等
const PAGE = 30;

// 列表页的轮询比会话页松：用户停在列表上是在挑会话，手上没有正在等的回信，
// 20 秒一次纯属浪费。30 秒足够让「对方刚回了我」及时冒出来
const POLL_MS = 30000;

// 相对时间：超过一天就显示日期，不然「刚刚 / 3 分钟前」看久了反而不知道是哪天
function ago(ts) {
  const d = Number(ts);
  if (!d) return '';
  const diff = Date.now() - d;
  if (diff < 0) return '';
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  const dt = new Date(d);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return (sameYear ? '' : dt.getFullYear() + '/')
    + (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
}

function cut(text) {
  const s = String(text || '');
  return s.length > 30 ? s.slice(0, 30) + '…' : s;
}

// 界面要的展示字段统一在这里补齐。两段列表走同一个函数 ——
// 各写一套的话，请求箱里那几行迟早少个时间或者少个首字头像
function decorate(list) {
  return (Array.isArray(list) ? list : []).map((c) => Object.assign({}, c, {
    timeText: ago(c.lastTime),
    lastTextCut: cut(c.lastText),
    // 头像首字也在这里算好：WXML 里写 {{nickName.charAt(0)}} 属于函数调用，会整页崩
    avatarText: String(c.nickName || '同').charAt(0)
  }));
}

Page({
  data: {
    list: [],
    requests: [],
    loading: true,
    // 请求箱默认收起，只在标题上给一个数字。
    // 默认展开的话，一条陌生人的广告会永远占住列表第一屏 —— 那正是要避免的事
    showRequests: false,
    requestTotal: 0,
    hasMore: false,
    requestHasMore: false,
    loadingMore: false,
    // degraded = 云端查询失败（≠ 真的没有会话）。两者必须分开显示：
    // 都显示成空列表的话，用户会以为自己的聊天记录被清空了
    degraded: false,
    offline: false,
    // 头像加载失败的 peer → true。列表里那一格退回首字母，
    // 不然地址过期时就是一排空圆框
    avaErr: {}
  },

  // 头像加载失败：按 peer 记一笔。一张图挂了不该牵动整轮列表重拉
  onAvaError(e) {
    const peer = e.currentTarget.dataset.peer;
    if (!peer || this.data.avaErr[peer]) return; // 已经在兜底了，别反复 setData
    this.setData({ ['avaErr.' + peer]: true });
  },

  onShow() {
    // 每次进都刷：从聊天页退回来时未读数应该已经清零了
    this.load(true);
    this.startPoll();
  },

  onHide() { this.stopPoll(); },
  onUnload() { this.stopPoll(); },

  // 轮询期间不显示骨架屏：用户已经在看列表了，再闪一次骨架比不刷新还难受
  startPoll() {
    this.stopPoll();
    this.pollTimer = setInterval(() => { this.load(true); }, POLL_MS);
  },

  stopPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  // silent = 后台刷新（轮询 / 下拉），不闪骨架屏、不动分页位置
  async load(silent) {
    if (!silent) this.setData({ loading: true });
    // 分页位置只在「整表重来」时归零：轮询刷新如果顺手把已翻的页丢掉，
    // 用户刚往下翻了两页就会被打回第一屏
    const r = await chat.listPage({ limit: PAGE, offset: 0 });
    this.offset = PAGE;
    this.reqOffset = PAGE;

    const list = decorate(r.list);
    const reqs = decorate(r.requests);
    // 请求箱里若有内容，收起时也要能看出有几条（requestTotal 来自云端，不受展开状态影响）
    const requestTotal = Number(r.requestTotal) || reqs.length;

    // 换过头像的那位顺手清掉失败记录：否则 TA 换了新头像，这边还会一直
    // 显示首字母，直到用户下次重进页面才恢复
    const avaErr = Object.assign({}, this.data.avaErr);
    const seenUrl = this._avaUrl || (this._avaUrl = {});
    list.concat(reqs).forEach((u) => {
      if (avaErr[u.peer] && seenUrl[u.peer] !== u.avatarUrl) delete avaErr[u.peer];
      seenUrl[u.peer] = u.avatarUrl;
    });

    this.setData({
      list: list,
      requests: reqs,
      requestTotal: Math.max(requestTotal, reqs.length),
      hasMore: !!r.hasMore,
      requestHasMore: !!r.requestHasMore,
      loading: false,
      loadingMore: false,
      degraded: !!r.degraded,
      offline: !!r.offline,
      avaErr: avaErr
    });

    // 每条的未读数就是刚从云端拿回来的最新值：顺手把「我的」tab 上那枚红点按这份数字重画。
    // 走 setChatUnread 而不是 refreshBadge —— 数据已经在手上了，没必要再问一次云端。
    // 请求箱里那些也算未读：光算主列表的话，一条被收进请求箱的新消息不会亮红点，
    // 两条都收进去时用户完全察觉不到有人找过他
    const sum = list.concat(reqs).reduce((s, c) => s + (Number(c.unread) || 0), 0);
    unread.setChatUnread(sum);
  },

  // 往下翻页。两段各自维护自己的 offset，共用的话一段翻完另一段会跟着跳
  async loadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return;
    this.setData({ loadingMore: true });
    const r = await chat.listPage({ limit: PAGE, offset: this.offset || PAGE });
    this.offset = (this.offset || PAGE) + PAGE;
    this.setData({
      list: this.data.list.concat(decorate(r.list)),
      hasMore: !!r.hasMore,
      loadingMore: false
    });
  },

  // 请求箱的「还有更多」：只有展开后才可能看到，所以单独给一个按钮而不是靠触底 ——
  // 请求箱在页面最上面，触底永远轮不到它
  async loadMoreReq() {
    if (this.data.loadingMore || !this.data.requestHasMore) return;
    this.setData({ loadingMore: true });
    const r = await chat.listPage({ limit: PAGE, offset: this.reqOffset || PAGE });
    this.reqOffset = (this.reqOffset || PAGE) + PAGE;
    this.setData({
      requests: this.data.requests.concat(decorate(r.requests)),
      requestHasMore: !!r.requestHasMore,
      loadingMore: false
    });
  },

  onReachBottom() {
    if (this.data.hasMore) this.loadMore();
  },

  toggleRequests() {
    this.setData({ showRequests: !this.data.showRequests });
  },

  openChat(e) {
    const d = e.currentTarget.dataset;
    nav.go({
      url: '/pages/user/chat/chat?peer=' + d.peer + '&name=' + (d.name || '')
    });
  },

  /* ---------------- 请求箱：接受 / 忽略 ---------------- */

  // 接受 = 「我愿意收你的消息」，刻意不顺手加好友（见云函数 chatAccept）。
  // 成功后整表重拉：这一行要从请求箱挪进主列表，本地自己搬容易漏掉排序
  async onAcceptReq(e) {
    const peer = e.currentTarget.dataset.peer;
    if (!peer || this.reqing) return;
    this.reqing = true;
    const r = await chat.accept(peer);
    this.reqing = false;
    if (r && r.ok === false) {
      feedback.toast(r.msg || '没成功，再点一次');
      return;
    }
    feedback.toast('已接受');
    this.load(true);
  },

  // 忽略 ≠ 拉黑：对方再发一条就会重新回到请求箱。
  // 这一点必须在提示里说清 —— 不说的话，用户下次看到它又冒出来会以为功能坏了
  async onDismissReq(e) {
    const peer = e.currentTarget.dataset.peer;
    if (!peer || this.reqing) return;
    this.reqing = true;
    const r = await chat.dismiss(peer);
    this.reqing = false;
    if (r && r.ok === false) {
      feedback.toast(r.msg || '没成功，再点一次');
      return;
    }
    feedback.toast('已忽略，对方再发消息时会回来');
    this.load(true);
  },

  /* ---------------- 长按会话：删除 ---------------- */

  // 删除会话（只删我这一侧）。用长按而不是行内放个删除按钮：
  // 列表里每行都挂一个删除键，误触率远高于长按，而删掉一段对话是有成本的。
  // 长按后直接进确认框、中间不再插一层原生菜单 —— 只有「删除」一个动作，
  // 多一层选择只是让人多点一次
  //
  // 请求箱里的行**不**给长按：那边已经有「接受 / 忽略」两个明确按钮，
  // 而「忽略」对一条请求的效果和「删除会话」是一样的，再给一套只是重复
  onLongPress(e) {
    const d = e.currentTarget.dataset;
    if (!d.peer) return;
    this.confirmRemove(d.peer, d.name);
  },

  confirmRemove(peer, name) {
    wx.showModal({
      title: '删除会话',
      // 说清「只删我这边」和「对方再发就回来」：不说明的话，
      // 用户会以为这段对话被彻底销毁了，或者反过来以为对方也看不到了
      content: '只会从你的列表里移除「' + (name || '这位同学') + '」，对方那边不受影响。'
        + '聊天记录不会删除，对方再发消息时这个会话会重新出现。',
      confirmText: '删除',
      confirmColor: '#d9534f',
      success: async (res) => {
        if (!res.confirm) return;
        const r = await chat.remove(peer);
        if (!r || r.ok === false) {
          feedback.toast((r && r.msg) || '没删掉，再试一次');
          return;
        }
        feedback.toast('已删除');
        this.load(true);
      }
    });
  },

  // 从通讯录里找人新开一段对话
  goFind() {
    nav.go({ url: '/pages/user/friends/friends?tab=search' });
  },

  // 申请列表：跳「我的同学 → 请求」页签
  goRequests() {
    nav.go({ url: '/pages/user/friends/friends?tab=requests' });
  },

  async onPullDownRefresh() {
    await this.load(true);
    wx.stopPullDownRefresh();
  }
});
