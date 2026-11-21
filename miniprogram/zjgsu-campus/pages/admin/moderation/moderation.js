// pages/admin/moderation —— 内容审核
//
// 设计前提：日常绝大部分举报由服务端自动处理（达到阈值就下架），
// 这里只处理「系统拿不准」的少数，并且一律用批量按钮，不做逐条判断。
//
//  1. 想进本页面，得先把自己的身份 ID 填进云函数环境变量 MODERATORS
//     （「我的」页里有「复制我的身份 ID」），填完重新部署云函数
//  2. 若提示「缺少集合」，按提示去云开发控制台建一下（建完回来刷新即可）
//  3. 队列清空后，日常基本不用再管
const store = require('../../../utils/store.js');
const market = require('../../../utils/market.js');
const eventApi = require('../../../utils/event.js');
const userApi = require('../../../utils/user.js');
const cloud = require('../../../utils/cloud.js');
const CFG = require('../../../utils/config.js');
const feedback = require('../../../utils/feedback.js');

// 「观察期」这三个字在服务端和前端各写了一份，这里取前端那一份当展示文案
const ABUSER_BADGE = (CFG && CFG.MODERATION && CFG.MODERATION.ABUSER_BADGE) || '观察期';

// 环境自检结果缓存：云函数默认超时 3 秒，反复进出页面跑全量自检容易撞上
// 真机上的 Timeout。5 分钟内直接复用上一次的结果，下拉刷新才强制重跑。
const DIAG_CACHE_MS = 5 * 60 * 1000;
const DIAG_KEY = 'zjgsu_mod_diag';

// 自检发现缺什么，直接说人话，别让用户对着报错猜
const DIAG_HINT = {
  users: '数据库还没建「用户库」，个人资料用不了。',
  posts: '数据库还没建「帖子库」，论坛用不了。',
  reviews: '数据库还没建「评价库」，课程评价用不了。',
  contacts: '数据库还没建「好友库」，同学广场用不了。',
  reports: '数据库还没建「举报库」，举报功能用不了。',
  admins: '数据库还没建「审核员名册」，自助登记审核员用不了。',
  favs: '数据库还没建「收藏库」，收藏用不了。',
  market: '数据库还没建「失物招领库」，失物招领用不了。',
  chats: '数据库还没建「私信库」，私信用不了。',
  resources: '数据库还没建「学习资料库」，学习资料用不了。',
  calendar: '数据库还没建「校历库」，校历倒计时用不了。',
  places: '数据库还没建「校园地点库」，校园地图用不了。',
  memos: '数据库还没建「备忘录库」（集合名 memos），我的备忘用不了。',
  app_config: '数据库还没建「配置库」（集合名 app_config），改动通知模板 ID、一键导入校历会失败。'
};

Page({
  data: {
    // 三个分区：举报队列 / 置顶管理 / 通知与数据
    tab: 'reports',
    // 举报这一屏的两个视角：待处理 / 已处置。
    // 不新开一个顶部分区是有原因的：顶部已经四段，320px 上再加一段就换行了
    view: 'pending',
    queue: [],
    // 待处理的留言申诉。和举报同屏（见 loadQueue 的注释）
    appeals: [],
    // 已处置归档（确认 / 驳回之后回看）。平常用不上，被追问时是唯一的凭据
    archive: [],
    archiveScope: 'all',
    archiveLoading: false,
    // 勾选是按「内容」算的（一条内容一行），而 submitted 的是这一行的全部举报 id。
    // 两个数字不是一回事，所以选中数单独记一个，别拿 checked.length 去显示
    checkedCount: 0,
    checked: [],
    checkedMap: {},
    pending: 0,
    hasAbuse: false,     // 队列里有没有「观察期」的票，需要你亲自判
    abuseBadge: ABUSER_BADGE,
    myOpenid: '',
    isMod: false,
    // 诊断用：前端名单（config.js）认不认当前 ID / 云函数到底答没答复。
    // 「配了 MODERATORS 还说不是审核员」的问题，十有八九能从这两行看出卡在哪一环
    localOk: false,
    diagDone: false,
    diagHint: '',
    loading: true,
    tip: '',
    needSetup: false,   // 环境没就绪（集合没建 / 云函数没部署）
    setupSteps: [],
    // 置顶管理
    pinList: [],
    pinnedOrder: [],
    pinnedCount: 0,
    // 置顶列表的搜索词：帖子多了以后靠翻找置顶目标不现实，
    // 输入关键词即可模糊筛选（走论坛同一套搜索内核）
    pinKeyword: '',
    // 已保护的内容（帖子 / 留言）。保护 = 举报留痕但不进普通队列，
    // 但人工审核照样能处理 —— 它是给好内容挡「凑人数」，不是免检
    protect: [],
    // 封禁名册（卖片 / 代写这类账号）
    banList: [],
    banView: [],
    banLoading: false,
    banKeyword: '',
    // 通知设置（订阅消息模板 ID）：三个模板对应三种不同通知，各一格
    submsg: { comment: '', reply: '', chat: '' },
    submsgInput: { comment: '', reply: '', chat: '' },
    submsgFromEnv: { comment: false, reply: false, chat: false },
    cfgTip: '',
    // 屏蔽词：内置那份只看不改（它写死在云函数里，清空自配词也还在）。
    // 自配词是「诽谤老师」这类场景唯一的免改代码入口
    builtinWords: [],
    wordsText: '',
    wordsTip: ''
  },

  onShow() {
    const oid = cloud.getOpenid() || '';
    this.setData({
      myOpenid: oid,
      // 前端名单（config.js）认不认当前 ID。和云函数侧的判定分开摆，
      // 两边不一致就是「环境变量没生效」，一致但不认就是「ID 本身配错了」
      localOk: !!oid && userApi.isModerator({ openid: oid })
    });
    this.refreshDiagHint();
    // 先跑快通道（身份 + 举报队列），全量自检放后台：
    // 每次进页面都跑一遍 9 个集合的探测，真机上会撞云函数 3 秒超时
    this.loadQueue();
    this.checkEnv();
    // 进通知分区时才拉配置，别的分区不多这一趟网络请求
    if (this.data.tab === 'notice') this.loadCfg();
    if (this.data.tab === 'pin') this.loadPinList();
    if (this.data.tab === 'ban') this.loadBanList();
  },

  // 把「前端名单 vs 云函数」两边的判定合成一句人话，写进引导卡。
  // 只有两边都认时才用不上这段话（那时页面走绿条分支）
  refreshDiagHint() {
    const oid = this.data.myOpenid;
    const localOk = !!this.data.localOk;
    const cloudOk = !!this.data.isMod;   // isMod 由 whoami / diag 写入，都是云函数侧的判定
    const done = !!this.data.diagDone;   // 云函数到底有没有答话
    let hint = '';
    if (!oid) {
      hint = '身份还没拿到，多半是 login 云函数没部署：右键 cloudfunctions/login →「上传并部署：云端安装依赖」。';
    } else if (localOk && !cloudOk) {
      hint = done
        ? '前端名单里有你，但云函数还不认 —— 说明环境变量 MODERATORS 没保存上，或改了没重新部署。去控制台核对值（区分大小写），保存后右键 user 云函数 →「上传并部署」，再下拉刷新本页。'
        : '云函数还在应答，等一秒再看…';
    } else if (!localOk && cloudOk) {
      hint = '云函数已经认你了。回到「我的」页重新进来一次就全绿了。';
    } else if (!localOk && !cloudOk) {
      hint = done
        ? '两边名单都没有你当前这串 ID —— 常见于换过微信登录开发者工具 / 换过云环境，openid 变了。把上面这串新 ID 重新填进环境变量 MODERATORS（区分大小写），保存后重新部署 user。'
        : '云函数还没连上：右键 cloudfunctions/user →「上传并部署：云端安装依赖」，部署完下拉刷新。';
    }
    this.setData({ diagHint: hint });
  },

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab: tab, cfgTip: '' });
    // 切过去才加载对应分区的数据，页面首屏少两个请求
    if (tab === 'notice') this.loadCfg();
    if (tab === 'pin') this.loadPinList();
    if (tab === 'ban') this.loadBanList();
    if (tab === 'reports' && this.data.view === 'archive') this.loadArchive();
  },

  // 待处理 / 已处置 两个视角切换。
  // 切到已处置才去拉归档：它是低频操作，没必要每次进页面都多一次请求
  switchView(e) {
    const view = e.currentTarget.dataset.view === 'archive' ? 'archive' : 'pending';
    if (view === this.data.view) return;
    this.setData({ view: view });
    if (view === 'archive') this.loadArchive();
  },

  // 归档筛选：全部 / 已确认 / 已驳回。
  // 「已确认」是应诉时最要紧的那一档（证明跳过什么），「驳回」用来复核误判
  onArchiveScope(e) {
    const scope = String(e.currentTarget.dataset.scope || 'all');
    if (scope === this.data.archiveScope) return;
    this.setData({ archiveScope: scope });
    this.loadArchive();
  },

  // 已处置归档。云端按内容合并（一条内容一行），结果取最新那次处置
  loadArchive() {
    if (!this.data.isMod) {
      this.setData({ archive: [], archiveLoading: false });
      return Promise.resolve();
    }
    const scope = this.data.archiveScope === 'all' ? '' : this.data.archiveScope;
    this.setData({ archiveLoading: true });
    return userApi.reportArchive(scope).then((r) => {
      const list = (r && r.list) || [];
      this.setData({ archive: list, archiveLoading: false });
    }).catch(() => {
      this.setData({ archiveLoading: false });
      feedback.toast('读取归档失败，稍后重试');
    });
  },

  /* ---------------- 置顶管理 ---------------- */

  // 把「已保护」的名单套到列表上。
  //
  // 保护关系存在独立集合里，队列和置顶列表拿到的都只是 id —— 在 WXML 里
  // 拼 key 再查表这种活干不了（模板表达式只认简单运算），所以必须在这里合一次。
  // protect 显式传进来是为了避开「setData 还没落地就读 this.data」的时序坑：
  // loadQueue 里 protect 和 queue 是同一次 setData 写下去的
  markGuarded(list, protect) {
    const src = protect || this.data.protect || [];
    const map = {};
    src.forEach((r) => {
      map[String(r.targetType || '') + '_' + String(r.targetId || '')] = true;
    });
    return (list || []).map((x) => Object.assign({}, x, {
      guarded: !!map[String(x.targetType || 'post') + '_' + String(x.targetId || x.id || '')]
    }));
  },

  // 保护 / 取消保护。只有审核员能调，云端会再验一次
  toggleProtect(e) {
    const d = e.currentTarget.dataset;
    if (!this.data.isMod) {
      feedback.toast('还不是审核员');
      return;
    }
    const type = d.type === 'comment' ? 'comment' : 'post';
    const id = String(d.id || '');
    // data-* 一律走字符串：布尔在 dataset 里有时会被转成 'false' 字符串，
    // 那 'false' 是个真值 —— 用 '0' / '1' 传就不会有这种歧义
    const on = String(d.on) !== '0';
    if (!id) return;
    const what = type === 'comment' ? '这条留言' : '这条帖子';

    wx.showModal({
      title: on ? '保护' + what + '？' : '取消保护？',
      content: on
        // 一定要说清「保护不是免检」：运营最容易误解的就是这一点，
        // 以为护住之后连真违规也删不掉了
        ? '保护后，举报会留痕，但不会自动下架，也不会进入普通审核队列；可以和置顶同时生效，需要你直接处理。'
        : '取消后，它重新按举报人数走自动处置。',
      confirmText: on ? '保护' : '取消保护',
      success: (m) => {
        if (!m.confirm) return;
        userApi.protectSet(type, id, on, '').then((r) => {
          if (!r || r.ok === false) {
            feedback.toast((r && r.msg) || '没设上');
            return;
          }
          feedback.toast(r.msg || (on ? '已保护' : '已取消保护'));
          this.refreshProtect();
          // 置顶列表里那条的保护态也要跟着变
          this.loadPinList();
        }).catch(() => feedback.toast('网络异常'));
      }
    });
  },

  // 只刷新保护名单，不动整页骨架 —— toggleProtect 之后走这里，
  // 走 loadQueue 的话整屏会闪一次 loading，正在看的举报卡会被抽走
  refreshProtect() {
    return userApi.protectList().then((pl) => {
      const protect = (pl && pl.list) || [];
      this.setData({
        protect: protect,
        queue: this.markGuarded(this.data.queue, protect),
        pinList: this.markGuarded(this.data.pinList, protect)
      });
    }).catch(() => {});
  },

  loadPinList() {
    const kw = String(this.data.pinKeyword || '').trim();
    const all = store.getPosts({ sort: 'latest' }) || [];
    // 已置顶的按自定义 pinOrder 单独取：它们可能是很老的一条，
    // 用「最近 30 条」一刀切会漏掉，也不能让管理页自己按时间重排。
    const pinned = store.getPosts({ sort: 'pinned' }) || [];

    let list;
    if (kw) {
      // 有关键词：走论坛列表同一套模糊搜索内核（标题 / 正文 / 板块 / 作者任一命中，
      // 打错字也认），命中范围是**全量本地缓存**，不受「最近 30 条」的限制 ——
      // 否则运营想置顶一条两周前的好帖，怎么搜都搜不到，只能靠往下翻
      list = pinned.concat(store.searchPosts(kw) || []);
    } else {
      list = pinned.concat(all).slice(0, 30);
    }

    // 去重（已置顶的帖可能同时被搜索命中），并保持「置顶在前」的顺序
    const seen = {};
    const items = [];
    list.forEach((p) => {
      if (!p || !p.id || seen[p.id]) return;
      seen[p.id] = true;
      items.push({
        id: p.id,
        title: p.title || '（无标题）',
        board: p.board,
        pinned: !!p.pinned,
        pinOrder: Number(p.pinOrder) || 0,
        // 到期时间要带到界面上：「已置顶」三个字看不出是今天到期还是明年到期，
        // 看不见期限就不会有人去续，最后是一堆「怎么突然掉了」
        pinUntil: Number(p.pinUntil) || 0,
        pinText: this.pinTextOf(p),
        likes: p.likes || 0,
        comments: Number(p.commentCount) || (p.comments || []).length,
        time: p.time
      });
    });

    this.setData({
      // 保护态一起合进来，这一行右边两个按钮（保护 / 置顶）都能显示当前状态
      pinList: this.markGuarded(items),
      // 顺序卡只列置顶帖，顺序与论坛「置顶」列表完全一致。
      pinnedOrder: items.filter((p) => p.pinned).map((p, i) => ({
        id: p.id, title: p.title, rank: i + 1
      })),
      pinnedCount: pinned.length
    });
  },

  // 置顶剩余时间的人话版本
  pinTextOf(p) {
    if (!p || !p.pinned) return '';
    const until = Number(p.pinUntil) || 0;
    if (!until) return '永久';
    const left = until - Date.now();
    if (left <= 0) return '已到期';
    const days = Math.ceil(left / 86400000);
    if (days <= 1) return '今天到期';
    return days + ' 天后到期';
  },

  // 置顶顺序调整：只交换相邻两条，保存成功后整页重读，保证云端和本机同序。
  movePin(e) {
    const id = String(e.currentTarget.dataset.id || '');
    const delta = Number(e.currentTarget.dataset.delta) || 0;
    const list = (this.data.pinnedOrder || []).slice();
    const from = list.findIndex((x) => x.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length || !delta) return;
    const tmp = list[from];
    list[from] = list[to];
    list[to] = tmp;
    this.setData({ pinnedOrder: list.map((x, i) => Object.assign({}, x, { rank: i + 1 })) });
    store.setPinOrder(list.map((x) => x.id)).then((r) => {
      if (!r || r.ok === false) {
        feedback.toast((r && r.msg) || '顺序没保存，稍后重试');
        this.loadPinList();
        return;
      }
      feedback.toast('置顶顺序已保存');
      this.loadPinList();
    }).catch(() => {
      feedback.toast('网络异常，顺序没保存');
      this.loadPinList();
    });
  },

  onPinKeyword(e) {
    this.setData({ pinKeyword: e.detail.value });
    this.loadPinList();
  },

  clearPinKeyword() {
    this.setData({ pinKeyword: '' });
    this.loadPinList();
  },

  // 置顶时长预设（单位：天，0 = 永久）。
  //
  // 为什么是这几个数字而不是「随便填」：给运营一个选择器，比给一个输入框好 ——
  // 输入框里填「30」和「30天」和「一个月」会有三种结果。
  // 顺序按常用度排：1 天 / 2 天是活动、寻物这类短时效，30 天是公告
  PIN_DAYS_NEW: [1, 2, 7, 30, 90, 0],
  // 已置顶的再点，只给「取消」和几个常用的改期选项 —— 一次列 7 项会被
  // showActionSheet 截断（上限 6 项），所以两套预设分开
  PIN_DAYS_EDIT: [1, 7, 30, 0],

  async togglePin(e) {
    if (!this.data.isMod) {
      wx.showToast({ title: '还不是审核员，先登记一下', icon: 'none' });
      return;
    }
    const id = e.currentTarget.dataset.id;
    const item = (this.data.pinList || []).find((p) => p.id === id);
    if (!id || !item) return;
    if (item.pinned) {
      // 已置顶：先问是取消还是改个期限。
      // 直接点一下就取消太危险 —— 置顶是运营位，误触一次可能让一条公告消失半天
      wx.showActionSheet({
        itemList: ['取消置顶', '改为 1 天', '改为 7 天', '改为 30 天', '改为永久'],
        success: (r) => {
          if (r.tapIndex === 0) {
            this.applyPin(id, false, 0);
            return;
          }
          this.applyPin(id, true, this.PIN_DAYS_EDIT[r.tapIndex - 1] || 0);
        },
        fail: () => {}
      });
      return;
    }

    wx.showActionSheet({
      itemList: ['置顶 1 天', '置顶 2 天', '置顶 7 天', '置顶 30 天', '置顶 90 天', '永久置顶'],
      success: (r) => this.applyPin(id, true, this.PIN_DAYS_NEW[r.tapIndex] || 0),
      fail: () => {}
    });
  },

  // 真正落地的那一步。把「选了多少天」换算成绝对时间戳再交给数据层 ——
  // 传天数的话，云端和前端的「一天」定义迟早会不一致
  applyPin(id, pin, days) {
    const item = (this.data.pinList || []).find((p) => p.id === id) || {};
    const wasPinned = !!item.pinned;
    const PIN_MAX = 10;
    // 只有「从未置顶变成置顶」才占名额。给已置顶的改期不该被自己的名额挡住
    if (pin && !wasPinned && this.data.pinnedCount >= PIN_MAX) {
      feedback.toast('最多只能置顶 ' + PIN_MAX + ' 条帖子');
      return;
    }
    const until = pin && days > 0 ? Date.now() + days * 86400000 : 0;
    wx.showLoading({ title: '处理中', mask: true });
    store.setPostPinned(id, pin, until).then((r) => {
      wx.hideLoading();
      if (!r || r.ok === false) {
        feedback.toast((r && r.msg) || '操作失败');
        this.loadPinList();
        return;
      }
      feedback.toast(r.msg || (pin ? '已置顶' : '已取消置顶'));
      this.loadPinList();
    }).catch(() => {
      wx.hideLoading();
      feedback.toast('网络异常');
    });
  },

  /* ---------------- 账号封禁 ---------------- */

  // 封禁名册：进「封禁」分区时拉一次。云端会再验一遍审核员身份
  loadBanList() {
    if (!this.data.isMod) {
      this.setData({ banList: [], banView: [], banLoading: false });
      return Promise.resolve();
    }
    this.setData({ banLoading: true });
    return userApi.banList().then((r) => {
      // 头像首字在这里算好：WXML 的 {{}} 里不能调函数，写 nickName.charAt(0) 会整页渲染崩掉
      const list = ((r && r.list) || []).map((b) => Object.assign({}, b, {
        avatarText: String(b.nickName || '同').charAt(0)
      }));
      this.setData({ banList: list, banLoading: false });
      this.applyBanFilter();
    }).catch(() => {
      this.setData({ banLoading: false });
    });
  },

  onBanKeyword(e) {
    this.setData({ banKeyword: e.detail.value });
    this.applyBanFilter();
  },

  // 封的人多了也要能一眼找到某一个：昵称 / 学院 / 封禁理由 / openid 任一包含即命中。
  // 这里用最朴素的包含匹配就够了 —— 名册是「我自己封过谁」，量级很小
  applyBanFilter() {
    const kw = String(this.data.banKeyword || '').trim().toLowerCase();
    const all = this.data.banList || [];
    if (!kw) {
      this.setData({ banView: all });
      return;
    }
    this.setData({
      banView: all.filter((b) => [b.nickName, b.college, b.reason, b.openid]
        .map((x) => String(x || '').toLowerCase()).join(' ').indexOf(kw) >= 0)
    });
  },

  // 从举报卡片进入被举报人的名片页。名片页已有审核员专用封禁区，
  // 这样能在看过主页内容后再决定是否封号，而不是只看一条举报就下手。
  openReportedUser(e) {
    const item = e.currentTarget.dataset.item || {};
    const openid = String(item.targetOpenid || '');
    if (!openid) return;
    wx.navigateTo({
      url: '/pages/user/card/card?openid=' + encodeURIComponent(openid),
      fail: () => feedback.toast('主页打不开，请稍后再试')
    });
  },

  // 从举报卡片直接封号：审核员看到一条卖片帖，最有用的动作不是删帖
  // （删了他再发一条），而是把这个账号停掉
  banFromReport(e) {
    const item = e.currentTarget.dataset.item || {};
    this.confirmBan(item.targetOpenid, item.targetNick);
  },

  banFromList(e) {
    const openid = e.currentTarget.dataset.openid;
    const nick = e.currentTarget.dataset.nick;
    this.confirmBan(openid, nick);
  },

  // 封禁要填原因：名册要留痕，换个人接手能看懂当初为什么封。
  // 用可编辑的 Modal 收一句原因，取消/留空就按「发布违规内容」记默认值
  confirmBan(openid, nick) {
    if (!this.data.isMod) {
      wx.showToast({ title: '还不是审核员，先登记一下', icon: 'none' });
      return;
    }
    if (!openid) {
      wx.showToast({ title: '认不出这个作者的身份', icon: 'none' });
      return;
    }
    const who = nick || '这位同学';
    wx.showModal({
      title: '封禁「' + who + '」',
      content: '被封禁的账号不能再发帖、评论、发私信或互动（浏览不受影响）。\n理由会记进封禁名册，方便以后追溯或解封：',
      placeholderText: '例如：发布售卖违规视频的广告',
      editable: true,
      confirmText: '封禁',
      confirmColor: '#d9534f',
      success: (res) => {
        if (!res.confirm) return;
        const reason = String(res.content || '').trim().slice(0, 60);
        wx.showLoading({ title: '封禁中', mask: true });
        userApi.banUser(openid, reason).then((r) => {
          wx.hideLoading();
          if (!r || r.ok === false) {
            wx.showToast({ title: (r && r.msg) || '封禁失败，再试一次', icon: 'none', duration: 2500 });
            return;
          }
          wx.showToast({ title: '已封禁该账号', icon: 'success' });
          // 名册和队列都可能受影响，顺手都刷新一下
          this.loadBanList();
          this.loadQueue();
        }).catch(() => {
          wx.hideLoading();
          wx.showToast({ title: '封禁失败，再试一次', icon: 'none' });
        });
      }
    });
  },

  onUnban(e) {
    const openid = e.currentTarget.dataset.openid;
    const nick = e.currentTarget.dataset.nick || '这位同学';
    if (!openid) return;
    wx.showModal({
      title: '解除封禁',
      content: '解除后「' + nick + '」可以重新发帖和互动。确定吗？',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中', mask: true });
        userApi.unbanUser(openid).then((r) => {
          wx.hideLoading();
          if (!r || r.ok === false) {
            wx.showToast({ title: (r && r.msg) || '解除失败，再试一次', icon: 'none' });
            return;
          }
          wx.showToast({ title: '已解除', icon: 'success' });
          this.loadBanList();
        }).catch(() => {
          wx.hideLoading();
          wx.showToast({ title: '解除失败，再试一次', icon: 'none' });
        });
      }
    });
  },

  /* ---------------- 通知设置（订阅消息模板 ID） ---------------- */

  // 模板 ID 从云端读（审核员存到 app_config 集合），读不到就是还没配
  loadCfg() {
    userApi.cfgGet().then((r) => {
      if (!r) return;
      const words = r.words || [];
      this.setData({
        submsg: r.submsg || { comment: '', reply: '', chat: '' },
        submsgFromEnv: r.fromEnv || { comment: false, reply: false, chat: false },
        // 内置那份列出来只是为了让审核员知道「老词早就在拦了」，
        // 否则他会以为词表是空的，自己加完发现没变化，判定配置没生效
        builtinWords: r.builtinWords || [],
        wordsText: words.join(' ')
      });
      const ids = r.submsg || {};
      // 已配的先带出来，审核员不用重新粘贴一遍
      this.setData({
        submsgInput: {
          comment: String(ids.comment || ''),
          reply: String(ids.reply || ''),
          chat: String(ids.chat || '')
        }
      });
    }).catch(() => {});
  },

  onCfgInput(e) {
    const k = e.currentTarget.dataset.k || '';
    const input = Object.assign({}, this.data.submsgInput);
    input[k] = e.detail.value;
    this.setData({ submsgInput: input, cfgTip: '' });
  },

  saveCfg() {
    if (!this.data.isMod) {
      wx.showToast({ title: '还不是审核员', icon: 'none' });
      return;
    }
    const submsg = {
      comment: String((this.data.submsgInput.comment || '').trim()),
      reply: String((this.data.submsgInput.reply || '').trim()),
      chat: String((this.data.submsgInput.chat || '').trim())
    };
    if (!submsg.comment && !submsg.reply && !submsg.chat) {
      this.setData({ cfgTip: '三个都留空 = 关闭订阅消息提醒，其他功能不受影响。' });
      return;
    }
    wx.showLoading({ title: '保存中', mask: true });
    userApi.cfgSave(submsg).then((r) => {
      wx.hideLoading();
      if (!r || r.ok === false) {
        wx.showToast({ title: (r && r.msg) || '保存失败', icon: 'none' });
        return;
      }
      this.setData({ cfgTip: r.msg || '已保存', submsg: submsg });
      wx.showToast({ title: '已保存', icon: 'success' });
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '保存失败', icon: 'none' });
    });
  },

  /* ---------------- 屏蔽词（诽谤类） ---------------- */

  // 空格 / 逗号 / 顿号都认：从表格里复制出来的一列词直接粘进来就能用，
  // 不用先替分隔符。服务端那头会再做一次同样的切分，这里切不切都行，
  // 但先切好能在保存前就把条数算出来给审核员看
  onWordsInput(e) {
    this.setData({ wordsText: e.detail.value || '', wordsTip: '' });
  },

  saveWords() {
    if (!this.data.isMod) {
      feedback.toast('还不是审核员');
      return;
    }
    const raw = String(this.data.wordsText || '');
    const words = raw.split(/[\s,，、;；]+/)
      .map((w) => String(w || '').trim())
      .filter(Boolean);
    if (words.length > 200) {
      this.setData({ wordsTip: '最多 200 个词，现在是 ' + words.length + ' 个，先删掉一些' });
      return;
    }
    // 单个词超过 12 字：云函数那边会直接丢掉，不如在这里就说清楚，
    // 免得保存完发现那几个词没生效
    const tooLong = words.filter((w) => w.length > 12);
    if (tooLong.length) {
      this.setData({ wordsTip: '这些词超过 12 个字，会被丢掉：' + tooLong.slice(0, 3).join('、') });
      return;
    }
    feedback.loading('保存中', true);
    userApi.cfgSaveWords(words).then((r) => {
      feedback.loading(false);
      if (!r || r.ok === false) {
        feedback.toast((r && r.msg) || '保存失败');
        return;
      }
      feedback.toast('已保存 ' + words.length + ' 个词，最多 5 分钟后生效');
      this.setData({ wordsTip: '' });
      // 保存完立刻拉一次：内置词会被服务端去重剔掉，
      // 界面上要显示的是「真正生效的那些」，不是刚才粘进去的原文
      this.loadCfg();
    }).catch(() => {
      feedback.loading(false);
      feedback.toast('保存失败');
    });
  },

  // 「该加什么、绝不该加什么」必须写在这个按钮旁边 ——
  // 词表加到一半最容易犯的错，是把正常的教学评价也加进去
  wordsGuide() {
    wx.showModal({
      title: '诽谤类词怎么加',
      content: '加「对人不对事」的：垃圾老师、误人子弟、师德败坏、收礼、潜规则、'
        + '靠关系、泄题、歧视学生。\n\n绝不加「讲课差、给分低、作业多、点名严」——'
        + '那些是正常教学评价，拦了它们，课程评价这个功能本身就废了。'
        + '区别只有一条：说的是「课/事」（不拦）还是「人」（拦）。',
      showCancel: false
    });
  },

  copyTemplateGuide() {
    wx.showModal({
      title: '去哪拿模板 ID',
      content: 'mp 后台 → 功能 → 订阅消息 → 公共模板库，按用途各选一个：帖子被留言用「留言回复通知」、留言被回复用「评论回复通知」、私信用「新信件提醒」。关键词顺序见上方说明（顺序就是字段编号，提交后锁死）。提交后在「我的模板」→ 详情里复制模板 ID，粘回上面的输入框保存即可。',
      showCancel: false
    });
  },

  /* ---------------- 官方校历一键导入 ---------------- */

  importCalendar() {
    if (!this.data.isMod) {
      wx.showToast({ title: '还不是审核员', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '导入官方校历',
      content: '会用教务处 2026-2027 学年第一学期的时间节点整体替换现有校历（期中、四六级、考研、期末、寒暑假）。确定吗？',
      success: (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '导入中', mask: true });
        userApi.calendarReset().then((r) => {
          wx.hideLoading();
          wx.showToast({
            title: (r && r.ok) ? '已导入官方校历' : ((r && r.msg) || '导入失败'),
            icon: 'none'
          });
        }).catch(() => {
          wx.hideLoading();
          wx.showToast({ title: '导入失败，稍后再试', icon: 'none' });
        });
      }
    });
  },

  // 环境自检：云函数能不能通 + 集合齐不齐 + 我算不算审核员。
  // force = 下拉刷新进来，跳过缓存强制重跑 —— 刚在控制台改完 MODERATORS /
  // 建完集合的人靠它立刻看到新状态，不能再吃 5 分钟的旧缓存
  checkEnv(force) {
    // 云函数默认超时 3 秒，自检要探一遍集合，反复进出页面最容易撞上真机上的
    // Timeout。跑通过的结果在本机缓存 5 分钟，下拉刷新强制重跑。
    let cached = null;
    if (!force) {
      try {
        const c = wx.getStorageSync(DIAG_KEY);
        if (c && c.at && Date.now() - c.at < DIAG_CACHE_MS) cached = c.value;
      } catch (e) { cached = null; }
    }

    if (cached) {
      this.applyDiag(cached);
      return Promise.resolve(cached.missing || []);
    }

    return userApi.diagCloud()
      .then((d) => {
        if (d && d.ok !== false) {
          try { wx.setStorageSync(DIAG_KEY, { at: Date.now(), value: d }); } catch (e) {}
          this.applyDiag(d);
        }
        return (d && d.missing) || [];
      })
      .catch(() => {
        // 云函数根本没部署：整个页面只能显示「先去部署云函数」
        this.setData({
          loading: false,
          needSetup: true,
          tip: '云函数还没部署。在开发者工具里右键 cloudfunctions\\user →「上传并部署：云端安装依赖」，部署完回来刷新这个页面就行。'
        });
        return null;
      });
  },

  // 把自检结果写进页面：集合有没有建 + 我算不算审核员。
  // whoami 和 diag 是并行发的两个请求，谁后到谁说了算 —— 但 diag 晚到且确认
  // 「你是审核员」时，必须把 whoami 早先留下的「还不是审核员」黄条一起收掉，
  // 不然页面会出现绿条「你是审核员」和黄条「还不是」同时挂着的精分现场
  applyDiag(d) {
    const missing = (d && d.missing) || [];
    const mod = !!(d && d.isMod);
    this.setData({
      isMod: mod,
      diagDone: true,
      needSetup: missing.length > 0 || !mod,
      setupSteps: missing.map((n) => DIAG_HINT[n] || '数据库还没建「' + n + '」集合。'),
      tip: mod ? '' : this.data.tip
    });
    this.refreshDiagHint();
  },

  loadQueue() {
    this.setData({ loading: true });
    // 申诉和举报一起拉：申诉是「自动处置被人质疑」，它天然属于这一屏 ——
    // 单独开一个 tab 的话，最后一个分段在 320px 上会挤成两行，
    // 而且审核员切来切去最容易漏掉的就是它
    Promise.all([userApi.whoami(), userApi.getModerationQueue(), userApi.appealQueue(), userApi.protectList()])
      .then(([me, q, ap, pl]) => {
        const isMod = !!(me && me.isMod);
        const list = (q && q.list) || [];
        const appeals = (ap && ap.list) || [];
        const protect = (pl && pl.list) || [];
        // 保护状态要合并进队列的每一条：审核员看到一条被举报的留言，
        // 得能立刻知道「这条已经护着了」，否则会以为还得再点一次
        this.setData({
          isMod: isMod,
          diagDone: true,
          queue: isMod ? this.markGuarded(list) : [],
          appeals: isMod ? appeals : [],
          protect: isMod ? protect : [],
          // 队列里有没有「观察期」那种需要人工判的票。WXML 里跑不了数组方法，
          // 所以这个标记得在这儿算好
          hasAbuse: isMod ? list.some((x) => x.reviewOnly) : false,
          pending: isMod ? list.length : 0,
          loading: false,
          tip: isMod
            ? ''
            : (this.data.needSetup ? '' : '当前账号还不是审核员。云端已关闭自助登记，请把上面复制到的身份 ID 填进云函数的 MODERATORS 环境变量。')
        });
        this.refreshDiagHint();
        // 停在「已处置」那一屏时刷新页面：队列拉完知道自己是审核员了，
        // 归档也能拉了（之前 isMod 是 false，拉不动）
        if (isMod && this.data.view === 'archive') this.loadArchive();
      })
      .catch(() => {
        this.setData({ loading: false, tip: '读取队列失败，稍后下拉重试。' });
        this.refreshDiagHint();
      });
  },


  onPullDownRefresh() {
    // eslint-disable-next-line no-undef
    wx.stopPullDownRefresh();
    this.checkEnv(true).then(() => this.loadQueue());
  },

  // 申诉通过：把那条留言恢复回去。
  //
  // 只给「恢复」不给「驳回」：驳回就是不处理，它自己会一直待在那儿；
  // 只有「发现判错了」才需要一个动作。多一个驳回按钮只是多一次点击
  onRestoreAppeal(e) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    wx.showModal({
      title: '恢复这条留言？',
      content: '恢复后它会重新出现在原帖下面，所有同学都能看到。',
      confirmText: '恢复',
      success: (m) => {
        if (!m.confirm) return;
        userApi.commentRestore(id).then((r) => {
          if (!r || r.ok === false) {
            feedback.toast((r && r.msg) || '没恢复成功');
            return;
          }
          feedback.ok('已恢复');
          this.loadQueue();
        }).catch(() => {
          feedback.toast('网络不太顺，没恢复');
        });
      }
    });
  },

  // 勾选是按**内容**来的：一条内容一行，勾上就等于把这一行的全部举报都算上。
  // 以前一行一条举报，勾选就是那个举报本身；现在必须把 repIds 一起带上，
  // 否则「驳回已选」只会驳回其中一票，同一条内容剩下的票还留在队列里 ——
  // 审核员会以为操作没生效，反复点
  toggleCheck(e) {
    const key = String(e.currentTarget.dataset.key || '');
    if (!key) return;
    const item = (this.data.queue || []).filter((x) => x.gkey === key)[0];
    if (!item) return;
    const ids = (item.repIds && item.repIds.length) ? item.repIds : [item.repId];

    const checked = this.data.checked.slice();
    const checkedMap = Object.assign({}, this.data.checkedMap);
    if (checkedMap[key]) {
      delete checkedMap[key];
      // 从已选里摘掉这一行的所有举报
      for (let i = checked.length - 1; i >= 0; i--) {
        if (ids.indexOf(checked[i]) >= 0) checked.splice(i, 1);
      }
    } else {
      checkedMap[key] = true;
      ids.forEach((id) => { if (checked.indexOf(id) < 0) checked.push(id); });
    }
    // 注意 wxml 里不能用 checked.indexOf()（不支持函数调用，整页会崩），
    // 渲染层判断一律走 checkedMap
    this.setData({
      checked: checked,
      checkedMap: checkedMap,
      checkedCount: Object.keys(checkedMap).length
    });
  },

  // 最常用的一刀切：队列里全驳回，同时把自动下架的内容恢复展示
  rejectAll() {
    const n = this.data.pending;
    if (!n) {
      wx.showToast({ title: '队列是空的', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '批量驳回',
      content: '把 ' + n + ' 条待处理举报全部判定为「证据不足」？被自动下架的内容会一并恢复展示。',
      confirmColor: '#1a5fb4',
      success: (res) => {
        if (!res.confirm) return;
        userApi.resolveReports([], 'reject', true)
          .then((r) => {
            if (!r || r.ok === false) {
              wx.showToast({ title: (r && r.msg) || '驳回失败，再试一次', icon: 'none', duration: 2600 });
              return;
            }
            const n = Number(r.handled) || 0;
            wx.showToast({
              title: n ? '已驳回 ' + n + ' 条' : ((r && r.msg) || '没有可驳回的举报'),
              icon: n ? 'success' : 'none',
              duration: n ? 1800 : 2400
            });
            this.setData({ checked: [], checkedMap: {}, checkedCount: 0 });
            this.loadQueue();
          })
          .catch(() => wx.showToast({ title: '操作失败', icon: 'none' }));
      }
    });
  },

  // 只驳回勾选出来的那几条（同一条内容的多张票一起清掉）
  rejectChecked() {
    const ids = this.data.checked;
    const n = this.data.checkedCount || 0;
    if (!ids.length) {
      wx.showToast({ title: '先勾选要驳回的', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '批量驳回',
      // 说「几条内容」而不是「几条举报」：勾选的单位是内容，
      // 一条内容可能压着 3 张票，报张数会让人以为选多了
      content: '把勾选的 ' + n + ' 条内容判定为「证据不足」？',
      confirmColor: '#1a5fb4',
      success: (res) => {
        if (!res.confirm) return;
        userApi.resolveReports(ids, 'reject')
          .then((r) => {
            if (!r || r.ok === false) {
              wx.showToast({ title: (r && r.msg) || '驳回失败，再试一次', icon: 'none', duration: 2600 });
              return;
            }
            const n = Number(r.handled) || 0;
            wx.showToast({
              title: n ? '已驳回 ' + n + ' 条' : ((r && r.msg) || '没有可驳回的举报'),
              icon: n ? 'success' : 'none',
              duration: n ? 1800 : 2400
            });
            this.setData({ checked: [], checkedMap: {}, checkedCount: 0 });
            this.loadQueue();
          })
          .catch(() => wx.showToast({ title: '操作失败', icon: 'none' }));
      }
    });
  },

  // 确认违规：内容直接删除，不可恢复
  confirmOne(e) {
    const item = e.currentTarget.dataset.item;
    wx.showModal({
      title: '确认违规',
      content: '确认这条属于违规内容？确认后将被删除，不可恢复。',
      confirmColor: '#d9534f',
      success: (res) => {
        if (!res.confirm) return;
        // 这一行的票要一起结掉：只确认其中一张，同一条内容剩下的举报还挂在队列里，
        // 内容却已经删了 —— 下一条点进来只会看到「内容已不存在」
        const ids = (item.repIds && item.repIds.length) ? item.repIds : [item.repId];
        userApi.resolveReports(ids, 'confirm')
          .then(() => {
            // 本地缓存同步删掉，免得审核员在自己手机上还看到
            if (item.targetType === 'review') {
              const reviews = wx.getStorageSync('zjgsu_reviews') || [];
              wx.setStorageSync('zjgsu_reviews', reviews.filter((r) => r.id !== item.targetId));
            } else if (item.targetType === 'market') {
              // 闲置：云端打的是 hidden 标记，本机这份直接摘掉，
              // 否则下次进列表还能看见一条已经处置过的
              market.removeLocal(item.targetId);
            } else if (item.targetType === 'event') {
              eventApi.removeLocal(item.targetId);
            } else {
              // 服务端已经按这条举报把帖子删了，这里只是清本机缓存；
              // deletePost 现在返回 Promise，吞掉异常别让审核页卡住
              store.deletePost(item.targetId, true).catch(() => {});
            }
            wx.showToast({ title: '已删除', icon: 'success' });
            this.setData({ checked: [], checkedMap: {}, checkedCount: 0 });
            this.loadQueue();
          })
          .catch(() => wx.showToast({ title: '操作失败', icon: 'none' }));
      }
    });
  },

  // 审核员手动恢复一条
  restoreOne(e) {
    const item = e.currentTarget.dataset.item;
    userApi.setContentStatus(item.targetId, 'normal', item.targetType)
      .then((r) => {
        wx.showToast({ title: (r && r.msg) || '已恢复', icon: 'success' });
        this.loadQueue();
      })
      .catch(() => wx.showToast({ title: '操作失败', icon: 'none' }));
  },

  // 把当前身份 ID 复制出来，万一哪天需要贴到代码里
  onCopyOpenid() {
    const oid = this.data.myOpenid;
    if (!oid) return;
    wx.setClipboardData({
      data: oid,
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    });
  }
});
