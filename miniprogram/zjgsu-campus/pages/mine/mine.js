// pages/mine/mine —— 我的
const store = require('../../utils/store.js');
const userApi = require('../../utils/user.js');
const cloud = require('../../utils/cloud.js');
const unread = require('../../utils/unread.js');
const privacy = require('../../utils/privacy.js');
const theme = require('../../utils/theme.js');
const nav = require('../../utils/nav.js');
const haptic = require('../../utils/haptic.js');
// 备忘连续天数：算法跟备忘页一致（今天没写就从昨天往前数）。
// 备忘录页自己算一份，这里只需要给入口卡片显示个数字，不必引入整个模块。
function calcStreak(dates) {
  if (!dates || !dates.length) return 0;
  const set = {};
  dates.forEach((d) => { set[d] = true; });
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const ds = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const cur = new Date();
  if (!set[ds(cur)]) {
    cur.setDate(cur.getDate() - 1);
    if (!set[ds(cur)]) return 0;
  }
  let n = 0;
  while (set[ds(cur)]) {
    n += 1;
    cur.setDate(cur.getDate() - 1);
  }
  return n;
}

/**
 * 「深色模式」那一行要的两样东西。
 *
 * darkOn 用「生效中的主题」而不是「用户选了什么」：没选过的时候开关也要
 * 如实显示系统当前的样子（深色系统里它就是开的），否则用户会觉得
 * 「明明是深的，开关却是关的」。themeAuto 只决定那行小字说什么。
 */
function themeSwitchState() {
  return { darkOn: theme.effective() === 'dark', themeAuto: theme.mode() === 'auto' };
}

Page({
  data: {
    user: {},
    myReviews: [],
    myPosts: [],
    friendCount: 0,
    reqCount: 0,
    hasContact: false,
    registered: false,
    isMod: false, // 在审核员白名单里才会出现「内容审核」入口
    // 触感反馈开关：默认开；关掉的人在课堂、图书馆里不会再被震到
    hapticOn: true,
    // 下面几项是「我的」页新加的入口数据
    unreadChat: 0,
    // 我的帖子被回复的总条数：只用来点亮「我的帖子」数字卡右上角那枚红点
    // （逐条的新回复数在 pages/mine/posts 里算，那边才是列表）
    unreadReplies: 0,
    favoriteCount: 0,
    draftCount: 0,
    // 「我的备忘」入口上的小提示：连续记了几天，没写过就是 0
    memoStreak: 0,
    // 深色模式开关（真值在 onShow 里按 theme 模块算，见文件末尾 themeSwitchState）
    themeAuto: true,
    darkOn: false,
    // 站内通知未读数。订阅消息是一次性的，通知中心是它的兜底
    unreadNotify: 0,
    // 注销冷静期：申请中就把它显示在入口行上。
    // 一个正在等 7 天的人，每次进来都该看见「还有几天」，而不是靠记忆
    cancelPending: false,
    cancelLeftDays: 0,
    // 头像地址在、图却加载不出来（过期 / 断网）。置 true 之后 wxml 退回首字母
    avaFail: false
  },

  onShow() {
    const base = store.getUser();
    // 开关以 haptic 模块读到的为准（别的页面也可能改过），每次进页面重读一次
    this.setData(Object.assign({ hapticOn: haptic.isEnabled() }, themeSwitchState()));
    // 个人资料以 user.js 为准（云端同步过的），store 里的昵称头像作为本地兜底
    const p = userApi.getMyProfile();
    const user = Object.assign({}, base, {
      nickName: p.nickName || base.nickName,
      avatar: p.avatarUrl || base.avatar,
      college: p.college || '',
      motto: p.motto || (p.contactType ? '联系方式：' + (userApi.CONTACT_LABEL[p.contactType] || '') : base.motto),
      avatarText: (p.nickName || base.nickName || '浙').charAt(0)
    });

    // canDelete 提前算好交给 wxml：早期发的帖/评价没有身份字段，也得能删
    const myReviews = store.getMyReviews().map((r) => {
      const c = store.getCourseById(r.courseId);
      // 「只评老师」那条没有课程，直接显示「老师评价 · XXX」，
      // 否则列表里一排「未知课程」，作者自己都认不出哪条是哪条
      const name = c ? c.name
        : (r.teacher ? '老师评价 · ' + r.teacher : '未知课程');
      return Object.assign({}, r, {
        courseName: name,
        starOn: r.score,
        canDelete: store.isMineReview(r)
      });
    });

    // 我的帖子被回复的条数：纯本地算（水位机制，见 utils/unread.js），
    // 不用等网络，进页面那一刻红点就在该在的位置上。
    // 这里只需要总数和列表长度 —— 逐条的 canDelete / 新回复数都在独立页里算，
    // 这页不渲染列表，就不该再算一遍那些字段
    const rm = unread.replyMap();
    const myPosts = store.getMyPosts();

    const oid = cloud.getOpenid() || p.openid || '';
    // 换了一张头像就重新给它一次机会；同一张失败过就保持兜底 ——
    // 否则每次进「我的」都要先闪一下空圆框再退回文字头像
    const avaFail = this._lastAva === user.avatar ? this.data.avaFail : false;
    this._lastAva = user.avatar;
    this.setData({
      user,
      avaFail,
      myReviews,
      myPosts,
      myOpenid: oid,
      registered: !!oid,
      // 比名单要用真实 openid（cloud.getOpenid()）优先 —— 本地资料里的
      // p.openid 可能是换微信 / 换环境之前留下的旧值，拿它比对会误判
      isMod: userApi.isModerator({ openid: oid }),
      unreadChat: this.data.unreadChat || 0,
      unreadReplies: rm.total,
      favoriteCount: store.getFavorites().length,
      draftCount: store.getDrafts().length,
      // 头像和昵称都没设定过就提示一下：同学按昵称找人，光靠默认名等于"隐身"
      profileIncomplete: !p.avatarUrl
    });
    this.refreshRelation();
    this.loadMemoStreak();
    // 首次进入时 openid 可能还没拿到，晚一点再刷一次：数字卡上的红点
    // 依赖「我的帖子有没有人回」，而这判定要认得出哪些帖子是自己的
    if (!oid) {
      setTimeout(() => {
        this.setData({
          myPosts: store.getMyPosts(),
          myOpenid: cloud.getOpenid() || ''
        });
      }, 600);
    }
  },

  // 头像加载失败：退回文字头像（和名片页、会话列表用的是同一套判断）
  onAvaError() {
    if (this.data.avaFail) return; // 已经在兜底了，别反复 setData
    this.setData({ avaFail: true });
  },

  // 好友数 / 待处理 / 私信未读：云函数没部署时静默跳过，不打断页面
  refreshRelation() {
    // 审核员状态以云端为准（环境变量 MODERATORS），本地 cfg 那份只是兜底。
    // 「内容审核 / 复制身份 ID / 环境自检」这三个开发向入口只有审核员看得到，
    // 普通同学的「我的」页里不该出现这些装修脚手架
    userApi.whoami()
      .then((w) => { if (w && w.isMod) this.setData({ isMod: true }); })
      .catch(() => {});
    // 身份是异步拿的：刚进页面那一刻多半还没回来，拿空 openid 去比名单，
    // 审核员自己的三个入口就会「时有时无」。等身份落地再补算一次
    const oidNow = cloud.getOpenid();
    const oidReady = oidNow ? Promise.resolve(oidNow) : cloud.fetchOpenid();
    oidReady.then((oid) => {
      if (oid && userApi.isModerator({ openid: oid })) this.setData({ isMod: true });
    }).catch(() => {});
    userApi.listFriends()
      .then((list) => { this.setData({ friendCount: (list || []).length }); })
      .catch(() => {});
    userApi.listRequests()
      .then((list) => { this.setData({ reqCount: (list || []).length }); })
      .catch(() => {});
    const p = userApi.getMyProfile();
    this.setData({ hasContact: !!p.contactValue });

    // 小红点：私信未读那份要走云端，跟上面算出来的帖子回复一起汇总到 tabBar 上。
    // force=true —— 用户正站在「我的」页看这份数字，不能给他 30 秒前的旧值
    unread.refreshBadge(true)
      .then((r) => {
        this.setData({
          unreadChat: r.chat,
          // 云端帖子摘要同步后，reply 才是“刚有人回复”的即时值；
          // 不能继续拿 onShow 刚开始那一眼的本地旧值。
          unreadReplies: Number(r.reply) || 0,
          // 通知未读也由 refreshBadge 一并拉取，避免同一次进页发两遍云函数。
          unreadNotify: Number(r.notify) || 0
        });
      })
      .catch(() => {});

    // 注销冷静期：和通知一样，都是不主动拉就不知道的状态。
    userApi.accountState()
      .then((r) => {
        if (!r || r.ok === false) return;
        this.setData({
          cancelPending: !!r.pending,
          cancelLeftDays: Number(r.leftDays) || 0
        });
      })
      .catch(() => {});
  },

  onSearch() {
    nav.go({ url: '/sub/search/search' });
  },

  onNotify() {
    nav.go({ url: '/pages/user/notify/notify' });
  },

  onAccount() {
    nav.go({ url: '/pages/user/account/account' });
  },

  onAbout() {
    nav.go({ url: '/pages/user/about/about' });
  },

  // 应用说明：这个小程序都能干什么。首次打开小程序会弹窗指过来一次
  onGuide() {
    nav.go({ url: '/pages/user/guide/guide' });
  },

  onChats() {
    nav.go({ url: '/pages/user/chats/chats' });
  },

  // 三个数字卡各自点进一个完整列表页。
  // 收藏本来就有独立页（pages/mine/favorites），评价与帖子这轮才拆出来 ——
  // 拆的理由不是「页面多好看」，而是数字卡本来就在报数，
  // 点一下就能看到那些数字指的是什么，比在页面底部再摆两份长列表直观得多
  onStatReviews() {
    nav.go({ url: '/sub/mine/reviews/reviews' });
  },

  onStatPosts() {
    nav.go({ url: '/sub/mine/posts/posts' });
  },

  onStatFavorites() {
    nav.go({ url: '/sub/mine/favorites/favorites' });
  },

  // 去树洞卡的入口已撤（见 mine.wxml 文件头说明）：树洞在论坛顶部有两处入口，
  // 「我的」页再放一个是重复，还把首屏往下顶。

  onDrafts() {
    nav.go({ url: '/sub/mine/drafts/drafts' });
  },

  // 我的备忘：连续天数取自本机缓存，读不到就显示「已连续 0 天」
  goMemo() {
    nav.go({ url: '/pages/tool/memo/memo' });
  },

  // 校园盲盒 / 漂流瓶：tabBar 满了，从「我的」页也能进
  goBlindbox() {
    nav.go({ url: '/sub/campus/blindbox/blindbox' });
  },

  loadMemoStreak() {
    const list = wx.getStorageSync('zjgsu_memos') || [];
    const dates = [];
    list.forEach((m) => {
      const d = String((m && m.date) || '');
      if (d && dates.indexOf(d) < 0) dates.push(d);
    });
    this.setData({ memoStreak: calcStreak(dates) });
  },

  // 天气卡已按需求从这一页撤掉（见 mine.wxml 文件头）。
  // utils/weather.js 本身还在：app.js 的欢迎弹窗会用一句天气，
  // 课程 / 校园页也各有各的展示，这里不再单独拉一次。

  // 深色模式开关。
  // 拨一下就是「明确选择」：不管系统是深是浅，从这一刻起都按这个来。
  // setDark 会写 storage 并通知所有页面重算 themeStyle，当前这一页
  // 因为挂了订阅（pages-theme 的 onShow 包装）会当场变色，不用退出去再进来
  onToggleDark(e) {
    const on = !!e.detail.value;
    theme.setDark(on);
    this.setData(themeSwitchState());
    // 顺手震一下：这个开关的效果是「整屏颜色变了」，但视线在开关上，
    // 一点触觉反馈能让人立刻确认这一下点到了（开关本身也有动画，双保险）
    if (haptic.isEnabled()) haptic.ok();
  },

  // 「清除本机缓存」：把本机所有 zjgsu_ 开头的缓存清干净再重进。
  // 只动本机 —— 云端那份数据不会被删。
  // 以前这里叫「演示模式 / 重置为初始状态」，那是给演示用的；
  // 真上架后每个用户都能点，措辞改成目的：解决本机缓存坏了导致的卡顿、数据错乱。
  // 触感反馈开关：写进 storage 的同时立刻试震一下，
  // 让用户当场知道「开了」意味着什么 —— 不用去点发布才知道
  onToggleHaptic(e) {
    const on = !!e.detail.value;
    haptic.setEnabled(on);
    this.setData({ hapticOn: on });
    if (on) haptic.ok();
  },

  onClearCache() {
    wx.showModal({
      title: '清除本机缓存',
      content: '会清掉这台手机上的帖子、评价、收藏、草稿和缓存记录。云端的数据不受影响。确定继续吗？',
      confirmColor: '#d9534f',
      success: (res) => {
        if (!res.confirm) return;
        let keys = [];
        try { keys = wx.getStorageInfoSync().keys || []; } catch (e) { keys = []; }
        keys.filter((k) => String(k).indexOf('zjgsu_') === 0).forEach((k) => {
          try { wx.removeStorageSync(k); } catch (e) {}
        });
        // zjgsu_haptic 也在被清的名单里。storage 没了但内存里还记着旧值，
        // 两边会不一致，这里按「清缓存 = 恢复默认」把它显式写回开启态
        haptic.setEnabled(true);
        this.setData({ hapticOn: true });
        wx.showToast({ title: '已重置', icon: 'success' });
        // 等 toast 露出再跳，否则进度一走人就看不到反馈了
        setTimeout(() => {
          wx.reLaunch({ url: '/pages/course/list/list' });
        }, 700);
      }
    });
  },

  // 隐私协议必须随时能翻到：微信在首次收集信息前会弹窗，但用户也该有主动查看的入口
  onOpenPrivacy() {
    privacy.openContract();
  },

  // 环境自检：内容发不出去时，先来这儿看看是「云函数没部署」还是「集合没建」。
  // 提示里能给出的信息有限，只有把缺失清单摆出来，用户才知道下一步该干什么。
  async onDiag() {
    wx.showLoading({ title: '检查中', mask: true });
    let r;
    try {
      r = await userApi.diagCloud();
    } catch (e) {
      r = null;
    } finally {
      wx.hideLoading();
    }
    if (!r || r.ok === false) {
      wx.showModal({
        title: '云函数连不上',
        content: '多半是 user 云函数还没重新部署。去开发者工具里右键 cloudfunctions/user → 上传并部署（云端安装依赖），然后再点一次「环境自检」。',
        showCancel: false
      });
      return;
    }
    const missing = Array.isArray(r.missing) ? r.missing : [];
    const lines = [];
    if (missing.length) {
      lines.push('还没创建的集合：' + missing.join('、'));
      lines.push('（在云开发控制台 → 数据库 → 新建集合，建好再重试）');
    } else {
      lines.push('数据库集合：齐全');
    }
    // 内容安全接口没开通只是「发不出通知和官方审核」，不影响发帖，但得说清楚
    lines.push('官方内容安全接口：' + (r.sec === 'ok' ? '正常' : (r.sec || '未开通')));
    if (r.secErr) lines.push('接口返回：' + String(r.secErr).slice(0, 60));
    wx.showModal({
      title: missing.length ? '有 ' + missing.length + ' 个集合没建' : '一切正常',
      content: lines.join('\n'),
      showCancel: false
    });
  },

  onEditProfile() {
    nav.go({ url: '/pages/user/profile/profile' });
  },

  onFriends() {
    nav.go({ url: '/pages/user/friends/friends' });
  },

  // 内容审核：入口只对审核员显示（wxml 那一行挂在 isMod 上）。
  // 曾经常显，理由是「想当审核员的人点进来看到引导卡」——但自助登记在云端
  // 已经关掉（SELF_ADMIN=false），这一行的实际效果只是给每个同学都摆了一个
  // 他用不上、还会让人猜疑的入口。真正的门禁一直在云函数（MODERATORS 环境变量）
  onModeration() {
    nav.go({ url: '/pages/admin/moderation/moderation' });
  },

  // 「还没拿到身份」警示条点下来去哪儿，分两种人给：
  //   审核员 → 环境自检，看缺哪个集合、云函数是不是没部署；
  //   同学   → 关于页。他不需要一份数据库缺失清单，只需要一个能说话的窗口
  //            （关于页里有联系方式）。以前一律跳自检，同学点开看到
  //            「login 云函数没部署」只会更懵 —— 那句话是写给开发看的
  onRegAlert() {
    if (this.data.isMod) return this.onDiag();
    return this.onAbout();
  },

  // 恢复展示 / 删除 / 清空 / 进详情这些操作都跟着列表搬去了
  // pages/mine/reviews 与 pages/mine/posts —— 操作跟着内容走。
  // 留一份在这儿的话，以后每加一个操作都要记得改两个页面，
  // 迟早会出现「这页能删、那页删了不刷新」这类分叉
});
