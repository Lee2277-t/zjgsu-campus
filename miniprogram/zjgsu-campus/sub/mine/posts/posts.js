// sub/mine/posts/posts.js —— 我的帖子
//
// 以前这份列表长在「我的」页最底下。帖子攒到十几条，整页就被它撑到要划两屏
// 才够到底下的「应用说明」；而上方数字卡里的「我的帖子 11」又只是个死数字 ——
// 看得见数量，点不动。
//
// 现在数字卡直接点进这一页：需要动手的事（逐条删、清空、恢复被暂停展示的）
// 都收在这里，「我的」页回到一眼看完的长度。
//
// 新回复红点跟「我的」页共用同一份水位数据（utils/unread.js）。
// 所以从这里进详情看过留言、再退回来，列表上的数字和 tabBar 上那枚红点
// 是同一个来源，不会出现「列表说 3 条、红点说 5 条」这种打架的情况。
const store = require('../../../utils/store.js');
const userApi = require('../../../utils/user.js');
const unread = require('../../../utils/unread.js');
const nav = require('../../../utils/nav.js');
const pager = require('../../../utils/pager.js');

Page({
  data: {
    posts: [],
    // 分页：total 是我的全部帖子数，hasMore 决定触底还要不要再加一页
    total: 0,
    hasMore: false,
    // 只有真的分过页才显示「已经到底啦」（见 utils/pager.js 的 done）
    done: false,
    // 全部帖子的新回复合计，用来决定顶部那行小结要不要出现
    unreadTotal: 0
  },

  onShow() {
    this.load();
  },

  // 每次回到这页都重算：进详情页会推进已读水位，不重算的话刚清掉的红点还挂着
  load() {
    this.render(store.getMyPosts());
    this.pullCloud();
  },

  // 统一出口：不管数据来自本机还是云端，字段形状必须一样，
  // 否则「云端补齐的那批」会缺 canDelete / 摘要，列表一半能删一半不能
  render(raw) {
    const rm = unread.replyMap();
    const posts = (raw || []).map((p) => Object.assign({}, p, {
      // 这页里的东西全是自己的：本机那份由 getMyPosts 认领过，
      // 云端那份本来就按自己的 openid 查出来的
      canDelete: true,
      hidden: !!p.hidden,
      // WXML 的 {{}} 里做不了 map[p.id] 这种动态取值，只能在这里摊平
      unread: rm.map[p.id] || 0
    }));
    // 有回复的帖子排最前：这页是“处理新回复”的工作台，不是按发帖时间排的相册。
    posts.sort((a, b) => (Number(b.unread) || 0) - (Number(a.unread) || 0));
    // 用 keep 而不是 reset：这个列表每次 onShow 都要重算红点，
    // 但已经展开到第几页是用户划出来的进度，不该因为看了一条帖子就归零。
    const view = this.pg().keep(posts);
    this.setData({
      posts: view.list,
      total: view.total,
      hasMore: view.hasMore,
      done: view.done,
      unreadTotal: rm.total
    });
    // 顺手把 tabBar 上那枚汇总红点对齐。这页就是新回复的「首页」，
    // 进来一次算准它，比等用户切到别的 tab 再刷更及时。
    // refreshBadge 失败不影响列表本身 —— 红点只是提示，不阻断任何操作
    try {
      const r = unread.refreshBadge();
      if (r && r.catch) r.catch(() => {});
    } catch (e) { /* 红点算不出来不影响这页 */ }
  },

  // 本机只缓存最近 20 条（PAGE_SIZE），发帖多的人换过设备就会少一大截，
  // 所以再向云端要一份「我发的全部」（postsByAuthor 认 who===openid，
  // 匿名 / 树洞 / 被打码的都会还给我）。失败就保持本机那份，不弹错。
  pullCloud() {
    const oid = store.myOpenid();
    if (!oid) return;
    userApi.postsByAuthor(oid, 100).then((r) => {
      const cloud = (r && r.list) || [];
      if (!cloud.length || this._gone) return;
      // 先把云端评论数合并回本地，unread.replyMap 才能算出“这条有新回复”。
      store.applyCloudPostSummaries(cloud);
      const seen = {};
      cloud.forEach((p) => { seen[p.id] = true; });
      // 云端为准；本地只补「刚发还没同步上去」的那几条，否则新帖会闪一下没了
      const localOnly = store.getMyPosts().filter((p) => !seen[p.id]);
      this.render(cloud.concat(localOnly));
    }).catch(() => {});
  },

  // 一键已读：推进本机水位，并把同一批帖子的站内通知标为已读。
  // 这和“清空”是两件完全不同的事：只清提示，不删任何帖子。
  onReadAll() {
    if (!this.data.unreadTotal) return;
    const all = store.getMyPosts();
    const rm = unread.replyMap();
    // 只处理真正有未读的帖子：没有红点的帖子不需要再发一次通知已读请求。
    const list = all.filter((p) => (rm.map[p.id] || 0) > 0);
    unread.markAllSeenForPosts(list);
    const ids = list.map((p) => p.id).filter(Boolean);
    Promise.all(ids.map((id) => userApi.notifyReadByTarget(id).catch(() => null)))
      .then(() => {
        unread.refreshBadge(true);
        this.load();
        wx.showToast({ title: '新回复已全部标为已读', icon: 'success' });
      })
      .catch(() => {
        // 单条通知清理失败不影响本地水位；下次进详情仍会再对齐。
        unread.refreshBadge(true);
        this.load();
        wx.showToast({ title: '已在本地标为已读', icon: 'none' });
      });
  },

  onUnload() {
    // 页面已经走了：异步回来的云端结果不该再 setData
    this._gone = true;
  },

  goPost(e) {
    nav.go({ url: '/sub/forum/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  // 自己发的帖子被系统自动下架时，在这里直接恢复，不用去找审核员
  onRestore(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '恢复展示',
      content: '确认这条内容没有违规吗？恢复后其他同学就能看到。',
      success: (res) => {
        if (!res.confirm) return;
        // 先云端后本地：云端没改成时不能报「已恢复」（下次同步会变回已下架）
        store.restorePost(id).then((r) => {
          if (!r || !r.ok) {
            wx.showToast({ title: (r && r.msg) || '恢复失败，请稍后重试', icon: 'none' });
            return;
          }
          this.load();
          wx.showToast({ title: '已恢复', icon: 'success' });
        });
      }
    });
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除帖子',
      content: '删掉后其他人就看不到这条了，确定吗？',
      confirmColor: '#d9534f',
      success: async (res) => {
        if (!res.confirm) return;
        const r = await store.deletePost(id);
        if (!r || !r.ok) {
          wx.showToast({ title: (r && r.msg) || '删除失败，请稍后重试', icon: 'none' });
          return;
        }
        // 帖子没了，它那条已读水位也跟着清掉，免得这张表越用越长（见 utils/unread.js）
        unread.forgetPost(id);
        this.load();
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  // 分页器实例。必须挂在 this 上，不能挂到 Page() 那个对象字面量上 ——
  // 那是所有页面实例共享的原型，把状态放上去，第二次进这个页面会带着
  // 上一次的「已经展开到第 3 页」。
  pg() {
    return this._pager || (this._pager = pager.create());
  },

  onReachBottom() {
    if (!this.data.hasMore) return;
    const view = this.pg().more();
    // 到底了返回 null，直接退出（不退出会白跑一次 setData，底部字会闪一下）
    if (!view) return;
    this.setData({
      posts: view.list,
      hasMore: view.hasMore,
      total: view.total,
      done: view.done
    });
  },

  // 测试帖攒多了逐条删太麻烦，一键清空（本地缓存 + 云端一起删）
  onClearAll() {
    // ⚠️ 这里必须取**全量**，不能取 data.posts ——
    // 分页之后 data.posts 只是已经展开的那一截，照着它删会把没显示出来的帖子
    // 悄悄留下，而提示还写着「已清空」。确认框里的条数也必须用全量，
    // 否则「将删除你发布的 20 条」说的不是真的要删的数目。
    const list = this.pg().all();
    if (!list.length) return;
    wx.showModal({
      title: '清空我的帖子',
      content: '将删除你发布的 ' + list.length + ' 条帖子（云端也会一起清掉），确定吗？',
      confirmColor: '#d9534f',
      success: async (res) => {
        if (!res.confirm) return;
        // 逐条串行删：deletePost 已经是「先云端、后本地」，并发几十个云调用
        // 会撞并发上限，串行虽然慢一点但每条都有确定结果 —— 要数清哪几条没删掉。
        // 以前全都不看返回，云端失败的帖子下次同步又冒回来，提示却写着「已清空」
        wx.showLoading({ title: '删除中', mask: true });
        let failed = 0;
        for (let i = 0; i < list.length; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const r = await store.deletePost(list[i].id).catch(() => ({ ok: false }));
          if (r && r.ok) unread.forgetPost(list[i].id);
          else failed += 1;
        }
        this.load();
        if (failed) {
          wx.hideLoading();
          wx.showToast({ title: '有 ' + failed + ' 条没删掉，请重试', icon: 'none' });
        } else {
          wx.hideLoading();
          wx.showToast({ title: '已清空', icon: 'success' });
        }
      }
    });
  },

  // 清空之后一条不剩，这页就只剩顶栏了 —— 给个直接去发帖的出口
  goNewPost() {
    nav.go({ url: '/sub/forum/post/post' });
  }
});
