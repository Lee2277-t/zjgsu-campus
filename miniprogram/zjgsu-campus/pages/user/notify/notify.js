// pages/user/notify —— 消息通知（站内通知中心）
//
// 为什么需要它：订阅消息是一次性的，用户点一次授权只能推一条，之后就再也不会响。
// 而「谁申请加我」「谁解除了好友」「我举报的内容有没有被处理」这些事，
// 没有通知中心就完全无处可查 —— 用户只能靠自己反复进各个页面碰运气。
//
// 三种类型各有去处，跳转目标一律由服务端下发（page 字段）：
//   服务端比前端更清楚「这条通知对应哪个页面」，
//   把映射写在前端的话，服务端以后加一种通知，前端就必须跟着发版。
const nav = require('../../../utils/nav.js');
const userApi = require('../../../utils/user.js');
const feedback = require('../../../utils/feedback.js');
const unread = require('../../../utils/unread.js');

// 图标按类型分。不用 emoji：通知列表一屏能放十几条，
// emoji 的尺寸和基线在不同机型上漂得厉害，整列看着是歪的
const ICONS = {
  reply: 'message-circle',
  friendReq: 'users-round',
  friendAccept: 'users-round',
  unfriend: 'users-round',
  report: 'shield-check',
  // 留言被移除 / 申诉有结果：用盾牌而不是铃铛 ——
  // 这两类通知不是「有人找你」，是「你的东西被处理了」，语气完全不同
  comment_removed: 'shield-check'
};

// 兼容分包迁移前已经落库的旧通知：旧路径仍然映射到新分包路径。
const LEGACY_PAGE_PREFIXES = [
  ['pages/course/detail/', 'sub/course/detail/'],
  ['pages/forum/detail/', 'sub/forum/detail/'],
  ['pages/market/detail/', 'sub/market/detail/'],
  ['pages/campus/event/', 'sub/campus/event/']
];
function normalizeStoredPage(page) {
  const raw = String(page || '').replace(/^\/+/, '');
  for (const pair of LEGACY_PAGE_PREFIXES) {
    if (raw.indexOf(pair[0]) === 0) return pair[1] + raw.slice(pair[0].length);
  }
  return raw;
}

// 每页条数。以前固定 50 条一次拉完，再多就永远看不到 ——
// 服务端现在支持 skip，触底可以继续往下翻（窗口上限 100 条）
const PAGE = 20;

Page({
  data: {
    loading: true,
    list: [],
    unread: 0,
    // 云端读不到（云函数没部署 / 查询失败）时为真。
    // 这时候不能显示「暂无通知」—— 那是一个我们并不知道结论的判断
    degraded: false,
    offline: false,
    // 还有更早的通知没拉下来（服务端算的是窗口内的剩余条数）
    hasMore: false,
    // 触底加载中：防止一划到底连发五次请求
    loadingMore: false
  },

  onLoad() {
    this.load(true);
  },

  onShow() {
    if (!this.data.loading) this.load(true);
  },

  // 下拉刷新：页面 json 里开了 enablePullDownRefresh，
  // 以前文案写着「下拉重试」却根本没监听这个事件，拉了没反应
  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  // 触底继续翻。只有服务端说还有更多时才发请求
  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.load(false);
  },

  // reset=true 从头拉（首次进入 / 下拉刷新 / 重试），false 表示往下接一页
  load(reset) {
    const from = reset ? 0 : this.data.list.length;
    if (!reset) this.setData({ loadingMore: true });
    return userApi.notifyList(PAGE, from).then((r) => {
      if (!r || r.ok === false) {
        // 翻页失败不清空已经显示的内容，只把「加载中」收起来
        this.setData({ loading: false, loadingMore: false, offline: reset, degraded: false });
        return;
      }
      const rows = (r.list || []).map((n) => ({
        id: n.id,
        type: n.type,
        eventKey: n.eventKey || '',
        title: n.title,
        body: n.body,
        page: n.page,
        read: !!n.read,
        time: n.time,
        icon: ICONS[n.type] || 'bell'
      }));
      // 分页拼接按 id 去重；旧版本的通知没有 eventKey，再用语义键兜底，
      // 避免同一条回复显示成两张一模一样的卡。
      const seen = {};
      const list = (reset ? rows : this.data.list.concat(rows)).filter((n) => {
        const semantic = n.eventKey || [n.type, n.targetId, n.title, n.body, n.time].join('|');
        if (seen[n.id] || seen[semantic]) return false;
        seen[n.id] = true;
        seen[semantic] = true;
        return true;
      });
      this.setData({
        loading: false,
        loadingMore: false,
        offline: false,
        degraded: !!r.degraded,
        list: list,
        unread: Number(r.unread) || 0,
        hasMore: !!r.hasMore
      });
      // 通知中心的未读数就是 tabBar 红点的一部分；拉到新结果时同步过去，
      // 不要等用户再切一次「我的」才更新。
      if (!r.degraded) unread.setNotifyUnread(r.unread);
    }).catch(() => {
      this.setData({ loading: false, loadingMore: false, offline: reset });
    });
  },

  onTap(e) {
    const i = Number(e.currentTarget.dataset.i);
    const n = this.data.list[i];
    if (!n) return;
    // 先本地标已读再跳：等云端回执回来才变灰的话，跳转已经把这一页挡住了，
    // 用户回来看到它还是未读，会以为「点了没用」
    if (!n.read) {
      this.markRead(i);
      userApi.notifyRead(n.id).catch(() => {});
    }
    if (n.page) nav.go({ url: '/' + normalizeStoredPage(String(n.page)).replace(/^\//, '') });
  },

  markRead(i) {
    const list = this.data.list.slice();
    if (!list[i] || list[i].read) return;
    list[i] = Object.assign({}, list[i], { read: true });
    const nextUnread = Math.max(0, this.data.unread - 1);
    this.setData({ list: list, unread: nextUnread });
    unread.setNotifyUnread(nextUnread);
  },

  onReadAll() {
    if (!this.data.unread) return;
    const list = this.data.list.map((n) => Object.assign({}, n, { read: true }));
    this.setData({ list: list, unread: 0 });
    unread.setNotifyUnread(0);
    userApi.notifyRead('').then((r) => {
      if (r && r.ok === false) {
        // 云端没标成功就把本地那份还原 —— 谎报「全部已读」而云端还是未读，
        // 下次进页面红点又冒出来，用户会以为这一页坏了
        feedback.toast('云端没响应，稍后重试');
        this.load(true);
      } else {
        feedback.ok('已全部标为已读');
      }
    }).catch(() => {
      feedback.toast('云端没响应，稍后重试');
      this.load(true);
    });
  },

  onRetry() {
    this.setData({ loading: true, offline: false, degraded: false });
    this.load(true);
  }
});
