// app.js
const cloud = require('./utils/cloud.js');
const privacy = require('./utils/privacy.js');
const weather = require('./utils/weather.js');
const report = require('./utils/report.js');
// 手动深浅色：必须在任何页面注册之前装上，见 utils/page-theme.js
const pageTheme = require('./utils/page-theme.js');

pageTheme.install();

// 应用说明的欢迎弹窗只弹一次，看没看过记在这个本机缓存键里
const GUIDE_KEY = 'zjgsu_guide_shown';

App({
  globalData: {
    // 主题色：浙商大蓝
    themeColor: '#1a5fb4',
    userInfo: null,
    openid: ''
  },

  onLaunch() {
    // 隐私授权：需要在收集信息前先得到用户同意，微信会回调过来
    privacy.setup();

    // 初始化一个本地模拟用户（无真实登录；云开发下 openid 用于区分“我的”）
    const user = wx.getStorageSync('zjgsu_user');
    if (user && user.nickName) {
      this.globalData.userInfo = user;
    } else {
      const defaultUser = {
        nickName: '浙小商',
        avatar: '',
        motto: '浙江工商大学 · 在读'
      };
      wx.setStorageSync('zjgsu_user', defaultUser);
      this.globalData.userInfo = defaultUser;
    }
    // 云开发提前初始化：原来要等第一次发帖/点赞时才 init，第一次点发布会多卡一下
    if (cloud.cfg.USE_CLOUD) cloud.ensureCloud();

    // 初始化存储（云模式下会把云端数据拉到本地缓存，页面仍读本地，无需改动）
    const store = require('./utils/store.js');
    store.initStore();

    // 云开发：异步获取 openid（开关关闭时自动跳过）
    // openid 是全校唯一的身份 ID，拿到之后顺手把「我」的资料登记到云端
    if (cloud.cfg.USE_CLOUD) {
      cloud.fetchOpenid().then((id) => {
        this.globalData.openid = id;
        if (!id) return;
        const last = wx.getStorageSync('zjgsu_openid');
        if (last && last !== id) {
          // 同一台设备切换微信账号：旧账号的资料、好友、聊天联系方式不能串给新账号。
          this.clearAccountCache();
          wx.setStorageSync('zjgsu_openid', id);
          wx.reLaunch({ url: '/pages/course/list/list' });
          return;
        }
        wx.setStorageSync('zjgsu_openid', id);
      });

      // 冷启动预热：云函数部署完的第一次调用要初始化 SDK，真机上常常超过默认的
      // 3 秒超时，用户碰到就是「点一下没反应」或直接 Timeout。这里在启动时空跑
      // 一次最轻的 whoami，把这次开销提前付掉（超时失败也无所谓，不影响任何功能）。
      wx.cloud.callFunction({ name: 'user', data: { action: 'whoami' } })
        .then((r) => {
          const w = r && r.result;
          if (w && w.deleted) {
            this.clearAccountCache();
            wx.setStorageSync('zjgsu_account_deleted', true);
          }
        })
        .catch(() => {});
    }

    // 天气在启动就预热：等弹窗要用的那一刻再发请求，多半赶不上（接口要跑一个来回），
    // 弹窗就会永远缺那句「明日天气是…」。提前发，弹窗时通常已经回来了
    this._weatherP = weather.fetchWeather().catch(() => null);

    this.showGuideOnce();
  },

  // 账号切换/注销后清理本机账号数据。保留引导、订阅状态和当前 openid，
  // 否则应用说明弹窗会反复出现，而资料/好友/私信缓存反而会串号。
  clearAccountCache() {
    let keys = [];
    try { keys = (wx.getStorageInfoSync().keys || []); } catch (e) { keys = []; }
    const keep = { zjgsu_openid: true, zjgsu_guide_shown: true, zjgsu_submsg_state: true };
    keys.filter((k) => String(k).indexOf('zjgsu_') === 0 && !keep[k]).forEach((k) => {
      try { wx.removeStorageSync(k); } catch (e) {}
    });
  },

  // 切回前台（冷启动时 onLaunch 之后紧跟着也是它）把 tabBar 上那枚红点重算一遍。
  // 帖子回复是纯本地算的，立刻就能画；私信那份要问云端，有 30 秒节流兜着，
  // 不会切一次问一次。整段包在 try 里 —— 红点只是提示，不能因为它让启动出问题。
  onShow() {
    // 晚 500ms 再画：冷启动那一刻 tabBar 还没构造出来，这时候 setTabBarBadge 会静默失败，
    // 红点得等用户自己进「我的」页才亮 —— 而「打开就看到有人回我」正是这枚红点的意义。
    // 等首页渲染完再画，一次就成。
    setTimeout(() => {
      try {
        require('./utils/unread.js').refreshBadge();
      } catch (e) { /* 红点失败不影响任何功能 */ }
    }, 500);
  },

  // 全局未捕获异常。这是**最该上报**的一类：它意味着代码走到了没人预料到的
  // 分支，而同学看到的往往只是「点了没反应」或者直接白屏 —— 光靠这句描述
  // 根本没法定位。以前这里什么都没有，真机上出了事只剩一句「有个同学说打不开」。
  onError(msg) {
    report.report('app.onError', msg);
  },

  // 未处理的 Promise 拒绝：async 函数里漏了 catch 时走这条路。
  // 它比 onError 更隐蔽 —— 既不弹窗也不红屏，只在真机上表现为「某个按钮突然失灵」，
  // 而开发者工具里常常复现不出来。基础库 2.10 起支持。
  onUnhandledRejection(res) {
    report.report('app.unhandledRejection', (res && res.reason) || res);
  },

  // 页面不存在：多半是跳转写错了路径，或者页面改过名但链接没跟着改。
  // 这类以前也是静默的，用户点了就卡在当前页，没有任何反馈。
  onPageNotFound(res) {
    report.report('app.pageNotFound', (res && res.path) || '（空路径）', {
      query: (res && res.query) || {}
    });
  },

  // 第一次打开小程序时提示一次「应用说明在哪」。
  // 只弹一次：点完就写进本机缓存，以后不再拦路 —— 每次打开都弹的欢迎窗最招人烦。
  // onLaunch 只在冷启动时跑（后台切回来走的是 onShow），所以切回来不会再弹一次。
  showGuideOnce() {
    let seen = false;
    try { seen = !!wx.getStorageSync(GUIDE_KEY); } catch (e) { seen = false; }
    if (seen) return;

    // 天气那句最多等 800ms：接口慢/没网时不能让欢迎窗跟着一起迟到。
    // 等不到就只说正事 —— 天气是锦上添花，弹窗本身才是主线
    const waitWeather = Promise.race([
      Promise.resolve(this._weatherP || null),
      new Promise((resolve) => setTimeout(() => resolve(null), 800))
    ]);

    // 延迟弹：onLaunch 时首页还在渲染，立刻弹窗会和页面动画、隐私授权窗撞在一起。
    // 隐私申请必须在延时之后再取，不能提前调用 whenSettled()：那时页面还没
    // onShow，pending 还是空的，会立刻 resolve，导致说明弹窗压在隐私弹窗上面。
    setTimeout(() => {
      const waitPrivacy = Promise.race([
        privacy.askOnEnter().catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 8000))
      ]);
      Promise.all([waitWeather, waitPrivacy]).then((res) => {
        const w = res[0];
        const base = '五个底部标签和五个小工具都是干什么的，都写在应用说明里了。在「我的」页点「应用说明」随时能翻。';
        // 拿到天气就多带一行「今日天气多云 18℃，明日天气晴 20℃，记得添衣哦~」。
        // 只有一天出得来也照常显示（接口偶尔只给今天），不会因此整句消失
        const line = (w && w.ok && w.sentence) ? ('\n\n' + w.sentence) : '';
        wx.showModal({
          title: '欢迎来到校园小站',
          content: base + line,
          confirmText: '去看看',
          cancelText: '知道了',
          success: (r) => {
            // 取消也算看过：不看的意愿同样值得尊重，别二次打扰
            try { wx.setStorageSync(GUIDE_KEY, 1); } catch (e) {}
            if (r.confirm) {
              wx.navigateTo({ url: '/pages/user/guide/guide' });
            }
          },
          fail: () => {}
        });
      });
    }, 1200);
  }
});
