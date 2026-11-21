// pages/campus/campus.js —— 校园 Tab（活动信息 / 校历 / 地点地图）
//
// 这三个东西为什么挤在一个页面里：它们都是「每周瞄一眼」的信息，
// 各占一个 tab 的话，四个 tab 已经把微信的五个位置用掉五分之四，
// 剩下的位置得留给主内容。所以这里用页内分段切换，一个位置装三块。
//
// 校历、地点的读取复用 utils/user.js 里现成的接口（跟 pages/tool 那两个页面同一份数据），
// 这里只做展示；要改校历 / 补地点，仍然进「校历」「校园地点」两个完整页
// （那两页有地图选点、审核员编辑这些用不上的复杂逻辑，不往这里搬）。
const eventApi = require('../../utils/event.js');
const userApi = require('../../utils/user.js');
const nav = require('../../utils/nav.js');
const store = require('../../utils/store.js');
const pager = require('../../utils/pager.js');
const report = require('../../utils/report.js');
// 地点搜索的口径跟 pages/tool/places 完整页共用一份，
// 两处各写一份会出现「同一个词，两个页面搜出来的不一样」
const placeSearch = require('../../utils/place-search.js');

const TABS = [
  { key: 'events', label: '活动信息' },
  { key: 'calendar', label: '校历' },
  { key: 'places', label: '地点地图' }
];

function tabMap(cur) {
  const m = {};
  TABS.forEach((t) => { m[t.key] = t.key === cur; });
  return m;
}

// 地点分类，跟 pages/tool/places 保持一致
const PLACE_CATS = ['教学楼', '食堂', '宿舍', '快递', '运动', '其他'];

// 期望云端跑的是哪一版 user 云函数。跟 cloudfunctions/user/index.js 里的 BUILD
// 必须**一起改** —— 它唯一的用途是：同步回执里没有招聘会字段时，能告诉同学
// 「云端还是旧版，去重新部署」，并且给一个可核对的版本号（工具里 diag 能查到的就是它）。
// 前端是保存即生效、云函数要手动部署，两者异步产生的「本地新 / 云端旧」
// 是这个项目踩过最多次、也最难看出来的坑。
const CLOUD_BUILD = '2026-10-20.5';

// 倒计时天数：WXML 的 {{}} 里不能调方法，天数必须在这里算好
function daysNum(date) {
  const target = new Date(String(date || '').replace(/-/g, '/') + ' 00:00:00');
  if (isNaN(target.getTime())) return 99999;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function daysText(date) {
  const n = daysNum(date);
  if (n === 99999) return '';
  if (n > 0) return '还有 ' + n + ' 天';
  if (n === 0) return '就是今天';
  return '已过去 ' + Math.abs(n) + ' 天';
}

// 招聘会的举办状态。WXML 里塞不下「已结束 / 就是今天 / 还有 N 天」这几层判断，
// 在这里算成一个字符串。
// 用**结束时间**判「已结束」，不是开始时间：双选会一开就是一下午，
// 拿开始时间比的话，下午两点刚开始就被标成「已结束」，同学会以为自己错过了。
function jobStateText(e) {
  if (e.type !== 'jobfair') return '';
  const end = Number(e.jobEndTs) || Number(e.jobTs) || 0;
  if (end && end < Date.now()) return '已结束';
  const n = daysNum(e.date);
  if (n === 99999) return '';
  if (n === 0) return '就是今天';
  // 一个月以上的先不报天数：说「还有 87 天」既不紧迫也没人会记，白白占地方
  if (n > 0 && n <= 30) return '还有 ' + n + ' 天';
  return '';
}

// 「全部 / 学校官网」这两档里，招聘会只先露几条，剩下的靠一行「还有 N 场」引到
// 「招聘会」那一档去看。为什么不一屏铺完：招聘会 / 宣讲会一条动辄几十场
// （秋招期间光宣讲会就有三十来场），全铺进官网列表，同学要划过三十张卡
// 才看得到真正新发的通知 —— 反倒是把「官网发布」这件事给埋了。
Page({
  data: {
    showBackTop: true,
    tabs: TABS,
    tab: 'events',
    tabMap: tabMap('events'),
    loaded: { events: false, calendar: false, places: false },

    /* 活动信息 */
    events: [],
    eventLoading: true,
    eventCount: 0,
    officialEvents: [],
    studentEvents: [],
    officialCount: 0,
    studentCount: 0,
    // 官方活动 / 同学组织的分开看：这是两类性质完全不同的东西，
    // 挤在一起，同学想找学校发的通知得从头翻
    evFilter: 'all',
    evFilterOpen: false,
    shownOfficial: [],
    // shownOfficial 是上面两块拼起来的总数（判空用），这两份是分开渲染用的
    shownJobs: [],
    shownNotices: [],
    shownStudent: [],
    // 同学发起那一块的分页状态。为什么只有这一块分页：
    // 官网那两块各有自己的收口办法 —— 招聘会靠「只露 5 条 + 还有 N 场」引到
    // 专门那一档，公告靠 7 天窗口卡着，秋招旺季也就十几条。
    // 只有同学发起的活动是真的会一直涨（毕业季一天十几条），
    // 一次全渲染会掉帧，分页是给它准备的。
    studentHasMore: false,
    studentDone: false,
    // 招聘会是官网发布里的独立类别：找工作的人只想看这一类
    jobfairCount: 0,
    // 「全部 / 官网」档里被收起来的招聘会条数，>0 时列表末尾出现「还有 N 场」
    jobfairMore: 0,
    lastSync: '',
    syncing: false,
    // 活动这次没拉到（≠ 没人发活动）。只在一条都渲染不出来时置真
    netFail: false,
    netBusy: false,

    /* 校历 */
    calList: [],
    calNext: '',

    /* 地点地图 */
    placeCats: ['全部'].concat(PLACE_CATS),
    placeCat: '全部',
    placeCatMap: {},
    placeList: [],
    placeLoading: true,
    // 搜索跟完整页同一套口径（utils/place-search.js）。
    // 关键词和分类互斥：有词时跨分类找，想找「2 号教学楼」的人
    // 不会先想它属于哪个分类
    placeKeyword: '',
    hasPlaceKeyword: false,
    // 从「添加地点」页退回来时要不要重拉一次。只在点右下角 ➕ 时置真：
    // 地点不像活动那样需要实时，每次进校园页都拉一遍纯属浪费
    placeDirty: false
  },

  onLoad() {
    this.setData({ placeCatMap: this.buildPlaceCatMap('全部') });
    this.safeLoadEvents();
    this._skipShowLoad = true;
    // 悄咪咪补一次同步：定时的管每天 07:30，白天打开小程序的人也该看到最新的活动。
    // 排在列表加载之后，不挡首屏、不弹任何东西，失败就当没发生过。
    if (this.needAutoSync()) setTimeout(() => this.autoSync(), 1200);
  },

  onShow() {
    const skip = !!this._skipShowLoad;
    this._skipShowLoad = false;
    // 从发布活动页 / 活动详情页退回来时刷新，刚发的不该看不到
    if (!skip && this.data.loaded.events) this.safeLoadEvents();
    // 加完地点退回来同样要重拉，否则「已添加」之后列表里还是没有。
    // 拉完就把旗子放倒 ——  campus 页自己切机、切前台也会走 onShow
    if (this.data.placeDirty) {
      this.setData({ placeDirty: false });
      if (this.data.loaded.places) this.loadPlaces();
    }
  },

  // 下拉刷新：只重拉列表，不触发「抓官网」那种重活 ——
  // 用户往下拽是想看见最新的内容，不是想让服务器去爬站。
  //
  // ⚠️ 这个页面 json 里开着 enablePullDownRefresh，却**没有**对应的
  //    onPullDownRefresh。微信只负责把那三个点弹出来，收尾要自己调 stop，
  //    少一个的表现就是「下拉之后一直转，等半天也不停」。
  //    这类「开了不接」的口子最容易被漏：不报错、不白屏，
  //    只有一个永远停不下来的转圈。收尾一律放 finally，
  //    中间任何一步抛错都不会把动画留在屏幕上
  async onPullDownRefresh() {
    try {
      await this.safeLoadEvents();
    } catch (e) { /* loadEvents 自己容错 */ }
    wx.stopPullDownRefresh();
  },

  buildPlaceCatMap(cur) {
    const m = {};
    this.data.placeCats.forEach((c) => { m[c] = c === cur; });
    return m;
  },

  /* ---------------- 分段切换 ---------------- */

  onTab(e) {
    const k = e.currentTarget.dataset.k;
    if (k === this.data.tab) return;
    this.setData({ tab: k, tabMap: tabMap(k) });
    // 懒加载：点到哪块才去拉哪块的数据，首屏不用等三个接口
    if (k === 'calendar' && !this.data.loaded.calendar) this.loadCalendar();
    if (k === 'places' && !this.data.loaded.places) this.loadPlaces();
  },

  /* ---------------- 活动信息 ---------------- */

  // resetPage = true 表示分类筛选刚变过，同学发起那一块的分页要归零
  // （见 onEvFilter）。平时刷新（轮询、同步完）保留用户已经展开的进度。
  // 任何异常都必须把加载态收起来：否则校园页会停在骨架屏/空白上，
  // 用户看到的就是“校园界面打不开”。错误交给下面的 net-tip。
  safeLoadEvents(resetPage) {
    return Promise.resolve(this.loadEvents(resetPage)).catch(() => {
      this.setData({ eventLoading: false, netFail: true });
    });
  },
  async loadEvents(resetPage) {
    let list = [];
    let netFail = false;
    try { list = eventApi.getEvents(); } catch (e) { netFail = true; }
    if (!Array.isArray(list)) list = [];
    try {
      const n = await eventApi.fetchEvents(1);
      if (n) list = eventApi.getEvents();
      netFail = eventApi.fetchState().ok === false;
    } catch (e) {
      netFail = true;
    }
    const decorated = list.map((e) => Object.assign({}, e, {
      typeIcon: e.official ? 'shield-check️' : eventApi.typeIcon(e.type),
      typeLabel: e.official ? '官方' : eventApi.typeLabel(e.type),
      // 招聘会卡片上的类别标签。云端按栏目标好了（双选会 / 宣讲会 / 大型招聘会…），
      // 老库里没有 jobKind 的条目兜底成「招聘会」，不至于空一格
      jobKind: e.jobKind || eventApi.typeLabel(e.type),
      // 人数上限：写了就显示「已报名 3/20」，没写就不显示，免得看着像限制人数
      countText: e.capacity > 0 ? ('已报名 ' + (e.joinedCount || 0) + '/' + e.capacity) : ('' + (e.joinedCount || 0) + ' 人已报名'),
      // 招聘会的举办状态（已结束 / 就是今天 / 还有 N 天）；别的类型是空串
      jobState: jobStateText(e),
      // 收藏状态。只有招聘会给这个入口：官网公告是「看完就走」的通知，
      // 收藏它没有意义；招聘会是要记着哪天去现场的那种，才值得收。
      // 收藏里存的是活动 id，「我的收藏」页会跳回活动详情页
      favorited: e.type === 'jobfair' && store.isFavorited('event', e.id)
    }));

    // 官网那条和同学自己发的那条分开摆：官网活动按活动日期排、同学活动按发布时间排，
    // 混在一条列表里官网那批会被旧时间的自己沉到底，音乐节、体育节就看不见了。
    // 官方块永远在最上面，也顺带回答了「哪些是学校发的、哪些是同学发的」。
    //
    // 「官网条目只留最近 7 天」这条，两类东西的口径不一样：
    //   公告  ── 按**发布时间**算。通知是「今天发、今天看」，旧通知挂着只会顶掉新消息；
    //   招聘会 ── 按**举办日期**算（jobTs）。招聘会提前一两个月就公布，也按发布日卡的话，
    //             12 月的秋招会在 10 月中旬凭空消失 —— 而那正是最该看到它的时候。
    //             云端采集用的是同一个口径，两边必须一致，否则会出现
    //             「库里存着、界面上却不显示」这种最难查的偏差。
    const weekAgo = Date.now() - 7 * 86400000;
    const inWindow = (e) => {
      const ts = e.type === 'jobfair'
        ? (Number(e.jobTs) || Number(e.at) || 0)
        : (Number(e.at) || 0);
      return ts >= weekAgo;
    };
    const official = decorated.filter((e) => e.official === true && inWindow(e));
    const student = decorated.filter((e) => e.official !== true);
    // 官网发布里的「招聘会」子类。云端按就业网的栏目直接标的类（宣讲会 / 双选会…），
    // 不用再猜标题 —— 招聘会卡片的类别标签就是云端存下来的 jobKind。
    // 按**举办日期升序**：最近要办的排最前。别的官网条目按发布时间倒序（最新通知优先），
    // 招聘会反过来才对 —— 同学打开是找「接下来有哪场」，不是看「最近公布了哪条」。
    // （filter 返回的是新数组，这里 sort 不会动到上面那两个）
    const jobfair = official.filter((e) => e.type === 'jobfair')
      .sort((a, b) => (Number(a.jobTs) || 0) - (Number(b.jobTs) || 0));

    // 当前选中的分类决定实际渲染哪几块。
    // 「官网」这一档里，招聘会单独排在前面（升序 = 最近要办的在前），公告跟在后面
    //（降序 = 最新发布的在前）：它们的时间压根不是一回事 —— 一个是「什么时候办」、
    // 一个是「什么时候发」，混着按同一个字段排，两边都不对。
    const f = this.data.evFilter;
    const notices = official.filter((e) => e.type !== 'jobfair');
    const wantAll = (f === 'all' || f === 'official');
    const jobfairShown = jobfair;
    const showOfficial = (f === 'student') ? [] : jobfairShown.concat(wantAll ? notices : []);
    const showStudent = (f === 'all' || f === 'student') ? student : [];
    const studentView = resetPage ? this.pg().reset(showStudent) : this.pg().keep(showStudent);

    this.setData({
      events: decorated,
      officialEvents: official,
      studentEvents: student,
      shownOfficial: showOfficial,
      // 只为了在模板里知道「招聘会露了几条」—— 露完最后一条就插一行「还有 N 场」，
      // 把剩下的引到「招聘会」那一档去（见 wxml 的 block wx:for）
      shownJobs: jobfairShown.length,
      shownStudent: studentView.list,
      studentHasMore: studentView.hasMore,
      studentDone: studentView.done,
      eventLoading: false,
      // 「全部」的计数 = 官网（窗口内）+ 同学发起，必须跟下面两个数能对上。
      // 之前写 list.length（含被窗口滤掉的旧官网通知），出现
      // 「全部 40 / 官网 17 / 同学 0」这种加不起来的怪数
      eventCount: official.length + student.length,
      officialCount: official.length,
      studentCount: student.length,
      jobfairCount: jobfair.length,
      // 「还有 N 场」只在收起来的那两档里出现；点进「招聘会」档后它就是 0
      jobfairMore: 0,
      lastSync: this.readSyncTime(),
      // 没读到 ≠ 真的没有活动。有缓存内容时照常显示列表，
      // 一条都没有时由 net-tip 顶上说清「是没拉到，不是没人发」
      netFail: netFail && decorated.length === 0,
      loaded: Object.assign({}, this.data.loaded, { events: true })
    });
  },

  // 活动分类：全部 / 官网发布 / 招聘会 / 同学发起
  onToggleEvFilter() {
    this.setData({ evFilterOpen: !this.data.evFilterOpen });
  },

  onEvFilter(e) {
    const f = e.currentTarget.dataset.f || 'all';
    if (f === this.data.evFilter) return;
    this.setData({ evFilter: f, evFilterOpen: false });
    // 传 true：切分类等于换了一份列表，同学发起那块的分页要归零。
    // 不归零的话，从「全部」切到「同学发起」会带着上一份的展开进度，
    // 第一屏就该出现的活动被推进了后面几页里
    this.loadEvents(true);
  },

  // 分页器实例（同学发起那一块用）。必须挂在 this 上，不能挂到 Page() 那个
  // 对象字面量上 —— 那是所有页面实例共享的原型，状态放上去会跨进页面残留。
  pg() {
    return this._pager || (this._pager = pager.create());
  },

  // 触底：只在「活动信息」这一档、且同学发起那块还有没显示的时加载。
  // 校历 / 地点地图两档是另外两个 tab，各有自己的长度，不受这里影响
  onReachBottom() {
    if (this.data.tab !== 'events') return;
    if (!this.data.studentHasMore) return;
    const view = this.pg().more();
    // 到底了返回 null，直接退出（不退出会白跑一次 setData，底部字会闪一下）
    if (!view) return;
    this.setData({
      shownStudent: view.list,
      studentHasMore: view.hasMore,
      studentDone: view.done
    });
  },

  /* ---------------- 收藏招聘会 ---------------- */

  // 为什么是「收藏」而不是「加进校历 + 提醒」：
  //   校历在这个项目里是教务处级别的学期节点（开学、考试、放假），
  //   往里塞一场宣讲会，会把节点列表污染成信息流 —— 到时候
  //   「校历」这个入口答的就不是「这学期什么时候开学」而是「今天有什么会」。
  //   而同学看到一场招聘会的真实动机就是「记着哪天去」，收藏正好对上。
  //   官网上一整屏都是通知和会，收藏只给招聘会这一个类，也是这个原因。

  // 收藏一场招聘会。跟课程、帖子那两处走同一份 store，不另起一套开关逻辑 ——
  // 三处的「点了之后界面怎么变」必须一致，否则同学会以为收藏有 bug。
  // 只改这张卡片自己的 favorited，不整页重跑 loadEvents：重跑会重新拉云端，
  // 收藏这种纯本地动作不该让人等网络。
  onFavEvent(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const list = this.data.shownOfficial || [];
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const item = list[idx];
    const r = store.toggleFavorite({
      type: 'event',
      id: item.id,
      title: item.title || '',
      // 时间和地点一起存快照：官网活动只在窗口内，出了窗口列表里就没有这一条了，
      // 到时候「我的收藏」里至少还看得见是哪一场、在哪办
      when: item.start || '',
      place: item.location || ''
    });
    if (!r || !r.ok) {
      wx.showToast({ title: '没能收藏上', icon: 'none' });
      return;
    }
    // 只改这一张卡片的字段。setData 的路径写法要带中括号，否则整页重渲染，
    // 列表会重新闪一下 —— 收藏这种纯本地动作不该让人看见列表跳。
    this.setData({ ['shownOfficial[' + idx + '].favorited']: !!r.favorited });
    wx.showToast({ title: r.favorited ? '已收藏，去「我的收藏」里看' : '已取消收藏', icon: 'none' });
  },

  // 同步时间只记在本地：同学点「更新」之后想知道官网那批数据有多旧
  readSyncTime() {
    try {
      const v = wx.getStorageSync('zjgsu_events_synced_at');
      return v ? String(v) : '';
    } catch (e) {
      return '';
    }
  },

  async writeSyncTime() {
    try {
      wx.setStorageSync('zjgsu_events_synced_at', eventApi.nowText());
      wx.setStorageSync('zjgsu_events_synced_ts', Date.now());
    } catch (e) {}
  },

  // 距上次同步超过 12 小时，就自动再抓一次
  needAutoSync() {
    const ts = Number(wx.getStorageSync('zjgsu_events_synced_ts')) || 0;
    return !ts || (Date.now() - ts) > 12 * 3600 * 1000;
  },

  async autoSync() {
    const r = await userApi.eventSync();
    if (!r || r.ok === false) return; // 抓不到就等下一次，不弹窗打扰同学
    await this.writeSyncTime();
    this.safeLoadEvents();
  },

  // net-tip 上的重试：只重拉活动列表，不触发「抓官网」那种重活 ——
  // 用户点它是想看见内容，不是想让服务器去爬站
  async onRetryNet() {
    if (this.data.netBusy) return;
    this.setData({ netBusy: true });
    try {
      await this.safeLoadEvents();
    } catch (e) { /* loadEvents 自己容错 */ }
    this.setData({ netBusy: false });
  },

  // 手动触发一次官网同步。云函数里有定时触发器每天自动跑（每天 07:30），
  // 但这个按钮还是要有：定时任务没生效时，同学能自己点一下。
  async onSync() {
    if (this.data.syncing) {
      wx.showToast({ title: '正在同步，稍等一下', icon: 'none' });
      return;
    }
    this.setData({ syncing: true });
    wx.showLoading({ title: '正在抓官网', mask: true });
    const r = await userApi.eventSync();
    wx.hideLoading();
    this.setData({ syncing: false });
    if (!r || r.ok === false) {
      // 官网挂了 / 超时 / 云函数版本太老，都得让同学看得懂
      wx.showModal({
        title: '同步失败',
        content: (r && r.msg) || '官网暂时打不开，可以稍后再试。已配置每天自动同步一次，明天再看。',
        showCancel: false
      });
      return;
    }
    await this.writeSyncTime();
    // 出问题时不再只弹一句「新增 0 条」—— 那句话把「官网挂了」「云端是旧版」
    // 「接口通了但没数据」三种完全不同的故障说成一个样子，只能反过来猜。
    // 现在能把每条通道各自的战果报出来，一次就看出是哪一环断了。
    const trouble = this.syncTrouble(r);
    if (trouble) {
      wx.showModal({ title: '同步完成，但有情况', content: trouble, showCancel: false });
    } else {
      wx.showToast({
        title: '新增 ' + (r.added || 0) + ' 条，更新 ' + (r.updated || 0) + ' 条',
        icon: 'none',
        duration: 2200
      });
    }
    this.safeLoadEvents();
  },

  // 同步回执 → 一句人话（没问题就返回空串）。
  // 三种故障分得清是关键：它们从界面上看都是「招聘会 0 条」，但要做的事完全不同 ——
  //   ① 回执里没有 jobfair 字段 → 云端跑的是旧版云函数，去重新部署；
  //   ② 有字段但某条通道 ok:false → 官网接口没回，那是源的问题，等它自己好；
  //   ③ 都 ok → 这个季节本来就没有场次（寒暑假很常见），什么都别做。
  syncTrouble(r) {
    const jf = r && r.jobfair;
    if (!jf || !jf.channels) {
      // 「云端跑旧版」这条路要上报：界面上只有主动点了「更新」的人才能看到
      // 下面这句提示，而不点的人是绝大多数 —— 他们那边这个问题会一直挂着，
      // 开发者却以为功能已经上线了。这正是本项目踩过最多次、也最难查的一类问题
      // （前端保存即生效、云函数要手动部署，两边天然不同步）。
      report.report('campus.cloudBuildStale', '云端云函数版本落后于前端', {
        expect: CLOUD_BUILD
      });
      return '招聘会没同步上。\n\n云端云函数还是旧版（新版是 ' + CLOUD_BUILD + '），'
        + '它不认识招聘会这条通道，也不会把招聘会标进「招聘会」分类。\n\n'
        + '请在开发者工具里右键 cloudfunctions/user → 上传并部署（云端安装依赖），'
        + '再点一次「更新」。';
    }
    const bad = jf.channels.filter((c) => !c.ok);
    if (!bad.length) return '';
    return '这几条通道没抓到数据：\n'
      + bad.map((c) => '· ' + c.label + '：官网接口没返回').join('\n')
      + '\n\n其余通道正常。就业网在改版或临时维护时就是这样，过一阵再点「更新」通常就回来了。';
  },

  // 官方活动跳官网原文：出处必须能追溯，不然就是无从查证的转载。
  // 小程序里没法直接开外链（要配业务域名），所以给链接 + 复制到剪贴板两条路。
  // 按 id 查而不是按下标查：招聘会和公告现在是两个 wx:for 分开渲染的，
  // 下标只在各自的循环里成立，拿它去索引整体列表必然串行。
  onOfficial(e) {
    const id = e.currentTarget.dataset.id;
    const ev = (this.data.events || []).find((x) => x.id === id);
    if (!ev || !ev.sourceUrl) return;
    // 个人主体没有业务域名可配 web-view；正文在活动详情页内用 Markdown 展示，
    // 这里统一只复制原文链接，避免审核时出现「此页面无法打开」。
    wx.setClipboardData({
      data: ev.sourceUrl,
      success: () => wx.showToast({ title: '原文链接已复制', icon: 'none' })
    });
  },

  goEvent(e) {
    nav.go({ url: '/sub/campus/event/event?id=' + e.currentTarget.dataset.id });
  },

  goAddEvent() {
    nav.go({ url: '/sub/campus/add/add' });
  },

  // 我发起的活动：被举报暂停展示的那些只有这一条路进得去（列表里已经没有它们了）
  goMineEvents() {
    nav.go({ url: '/sub/campus/mine/mine' });
  },

  /* ---------------- 校历 ---------------- */

  async loadCalendar() {
    let list = await userApi.calendarList();
    const decorated = (list || []).map((it) => Object.assign({}, it, {
      days: daysNum(it.date),
      daysText: daysText(it.date),
      past: daysNum(it.date) < 0,
      typeIcon: it.type === 'exam' ? 'file-text' : (it.type === 'term' ? 'graduation-cap' : 'pin')
    })).sort((a, b) => a.days - b.days);
    const next = decorated.filter((d) => d.days >= 0)[0];
    this.setData({
      calList: decorated,
      calNext: next ? (next.name + ' · ' + next.daysText) : '近期没有安排',
      loaded: Object.assign({}, this.data.loaded, { calendar: true })
    });
  },

  goCalendarFull() {
    nav.go({ url: '/pages/tool/calendar/calendar' });
  },

  /* ---------------- 地点地图 ---------------- */

  // 一次拉全量（云端上限 100 条，校园地点远不到这个量级），分类和关键词都留在本地过：
  // 这样切分类、边输边搜都是瞬时的，不用每按一下等一次网络
  async loadPlaces() {
    const all = await userApi.placeList('');
    this._allPlaces = all || [];
    this.applyPlaceFilter();
    this.setData({
      loaded: Object.assign({}, this.data.loaded, { places: true })
    });
  },

  applyPlaceFilter() {
    const kw = String(this.data.placeKeyword || '').trim();
    const list = placeSearch.filterPlaces(this._allPlaces || [], this.data.placeCat, kw);
    this.setData({
      placeList: list,
      placeLoading: false
    });
    if (kw && !list.length && this._placeKwTried !== kw) this.fetchRemotePlaceKeyword(kw);
  },

  // 本地地点列表没拉下来 / 搜不到时，再向云端按关键词查一次。
  // 和完整地点页共用 placeList 的 keyword 参数，避免两页结果不一致。
  fetchRemotePlaceKeyword(kw) {
    if (this._placeKwFetching === kw) return;
    this._placeKwFetching = kw;
    this._placeKwTried = kw;
    if (this._placeKwTimer) clearTimeout(this._placeKwTimer);
    this._placeKwTimer = setTimeout(async () => {
      const remote = await userApi.placeList('', kw);
      if (String(this.data.placeKeyword || '').trim() !== kw) return;
      if (remote && remote.length) {
        const map = {};
        (this._allPlaces || []).forEach((p) => { if (p && (p.id || p.name)) map[p.id || p.name] = p; });
        remote.forEach((p) => { if (p && (p.id || p.name)) map[p.id || p.name] = p; });
        this._allPlaces = Object.keys(map).map((k) => map[k]);
        this._placeKwFetching = '';
        this.applyPlaceFilter();
      } else {
        this._placeKwFetching = '';
      }
    }, 300);
  },

  onPlaceCat(e) {
    const c = e.currentTarget.dataset.c || '全部';
    if (c === this.data.placeCat) return;
    // 点分类 = 回到「按分类浏览」，把搜索词一起清掉。
    // 不清的话会出现「点了食堂，列表却还是刚才搜出来的那几个」，
    // 看不出到底是谁在起作用
    this.setData({
      placeCat: c,
      placeCatMap: this.buildPlaceCatMap(c),
      placeKeyword: '',
      hasPlaceKeyword: false
    });
    this.applyPlaceFilter();
  },

  /* ---------------- 地点搜索 ---------------- */

  // 本地过滤，不发请求 —— 全量已经在 _allPlaces 里了
  onPlaceKeyword(e) {
    const kw = String((e && e.detail && e.detail.value) || '');
    this.setData({ placeKeyword: kw, hasPlaceKeyword: !!kw.trim() });
    this.applyPlaceFilter();
  },

  onPlaceKeywordClear() {
    this.setData({ placeKeyword: '', hasPlaceKeyword: false });
    this.applyPlaceFilter();
  },

  // 点键盘上的「搜索」先把键盘收起来：这一档的列表就在下面，
  // 不收的话键盘盖住半屏，输完看不见结果
  onPlaceSearchConfirm() {
    if (wx.hideKeyboard) wx.hideKeyboard({ fail: () => {} });
  },

  // 唤起微信内置地图：位置在这里看、导航在这里叫
  onPlaceOpen(e) {
    const p = this.data.placeList[e.currentTarget.dataset.i];
    if (!p) return;
    wx.openLocation({
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
      name: p.name,
      address: p.address || p.desc || '',
      scale: 18
    });
  },

  goPlacesFull() {
    nav.go({ url: '/pages/tool/places/places' });
  },

  // 右下角 ➕：地点地图这一档的「加一个」快捷键，位置、手势跟活动那一档一致。
  //
  // 为什么这一步值得做成悬浮按钮：添加入口原本排到完整页的第四屏
  // （地图 + 分类 + 地点列表之后），真要补地点的人 ——
  // 多半正站在那个怎么都找不到的快递点前 —— 划不到那儿，
  // 而且划到了还要再点一下才把表单摊开，一共三步。
  //
  // add=1 让表单落地即在填；cat 跟着校园页当前选的分类走：
  // 正在看「快递」那一栏时点 ➕，想加的八成就是个新快递点，
  // 分类替他选好比让他从六个里再挑一遍快。
  goAddPlace() {
    const cat = this.data.placeCat;
    const q = cat && cat !== '全部' ? ('&cat=' + encodeURIComponent(cat)) : '';
    this.setData({ placeDirty: true });
    nav.go({ url: '/pages/tool/places/places?add=1' + q });
  },

  onShareAppMessage() {
    return {
      title: '商砖小站 · 校园活动 + 校历倒计时 + 地点地图',
      path: '/pages/campus/campus'
    };
  },

  // 浮动回到顶部：默认亮出，越过一小段距离后继续显示；只在回到顶部后隐藏。
  onPageScroll(e) {
    const show = (Number(e && e.scrollTop) || 0) > 120;
    if (show !== this.data.showBackTop) this.setData({ showBackTop: show });
  },

  // 页面级回到顶部：不经过自定义组件的 visible 状态，按钮始终可点。
  // 与下拉刷新共用同一套刷新逻辑，解决部分机型手势无法触发的问题。
  manualRefresh() {
    this.onPullDownRefresh();
  },

  backTop() {
    wx.pageScrollTo({ scrollTop: 0, duration: 280 });
  },
});
