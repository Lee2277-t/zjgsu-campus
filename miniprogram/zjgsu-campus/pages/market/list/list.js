// pages/market/list/list.js —— 失物招领 / 二手交易 列表
// 三个 tab 共用一套逻辑，只靠 type 切换；云端没部署时照常显示本地缓存。
//
// ⚠️ 性能要点（这一版专门改的，别改回去）：
//   1. **切 tab / 切分类不联网**。以前每次切换都 `await market.fetchMarkets(1)`，
//      一次云函数往返几百毫秒到几秒 —— 用户点一下分类要干等，这就是「切换卡顿」的
//      真正原因。现在只有「首次进入」和「下拉刷新」才联网，其余走本地缓存。
//   2. **结果缓存**。同一个 (tab + 分类 + 关键词 + 精准/模糊) 组合算过一次就存下来，
//      再切回来直接渲染，0 计算 0 请求。云端数据回来、或本地数据变了就整体作废。
//   3. **节流 300ms**。手指连点、胶囊组件连发 change 时不会在同一帧里跑两遍。
//   4. **分页渲染**。一屏只渲染 30 条，触底再往下加 —— 一次 setData 几百条是卡顿主因。
const market = require('../../../utils/market.js');
const nav = require('../../../utils/nav.js');
const perf = require('../../../utils/perf.js');

// 「全部」= TYPES 里没有的 key，getMarkets / searchMarkets 会原样返回全部类型
//
// 「课程互助」是一个**派生档**：数据层它仍是 type=sell + category=substitute。
// 为什么提成一级？同学的找法是「我要找课程互助 → 点顶上一排」，不会先点「闲置」、
// 再往下滑到第二排分类胶囊里找 —— 藏起来的分类等于没加。
// 提上来之后它有两条入口（这里 + 闲置下的分类胶囊），指向同一批数据，不冲突。
//
// 它的中文名直接取 CATEGORIES 里那一项的 label：顶上一排和发布页各写一个名字，
// 改中文时漏掉一边，就会变成「顶上叫课程互助、发布页叫代课」。
const PROMOTED_KEY = 'substitute';
const promotedLabel = (market.CATEGORIES.filter((c) => c.key === PROMOTED_KEY)[0] || {}).label
  || '课程互助';

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'lost', label: '寻物' },
  { key: 'found', label: '招领' },
  { key: 'sell', label: '闲置' },
  { key: 'substitute', label: promotedLabel }
];

// 派生档 → 真实 type。没登记的档原样返回（all 也算，取数时再判）
const TAB_TYPE = { substitute: 'sell' };
function typeOfTab(tab) {
  return TAB_TYPE[tab] || tab;
}

// 每页渲染多少条
const PAGE_STEP = 30;

// 胶囊组件要的是「值数组 + 值->中文 的映射」，页面只负责把 TABS 摊成这两个
const TAB_KEYS = TABS.map((t) => t.key);
const TAB_LABELS = (function () {
  const m = {};
  TABS.forEach((t) => { m[t.key] = t.label; });
  return m;
})();

// 选中态不能用 tab === 'lost' 这种判等来加 class（WXML 表达式能判等，但要写三遍），
// 统一转成 map：tabMap.lost 就是 true/false
function tabMap(tab) {
  const m = {};
  TABS.forEach((t) => { m[t.key] = t.key === tab; });
  return m;
}

// 闲置分类（教材专区只在「闲置」tab 出现）
//
// 课程互助已经从第二排提到顶上那一排了（见 TABS），这里要把它滤掉 ——
// 同一屏里同一个词出现两次（类型一个、分类一个），用户会以为它们筛的不是一回事
const CATS = [{ key: 'all', label: '全部', icon: '' }].concat(
  market.CATEGORIES.filter((c) => c.key !== PROMOTED_KEY)
);

// 分类胶囊同样要「值数组 + 值->中文」。以前这一档只在发布页有、浏览端没有入口，
// onCategory 一直是死代码 —— 填了分类却没人筛得出来，等于白填
const CAT_KEYS = CATS.map((c) => c.key);
const CAT_LABELS = (function () {
  const m = {};
  CATS.forEach((c) => { m[c.key] = c.label; });
  return m;
})();

function catMap(current) {
  const m = {};
  CATS.forEach((c) => { m[c.key] = c.key === current; });
  return m;
}

Page({
  data: {
    showBackTop: true,
    tabs: TABS,
    tabKeys: TAB_KEYS,
    tabLabels: TAB_LABELS,
    tab: 'all',
    tabMap: tabMap('all'),
    cats: CATS,
    catKeys: CAT_KEYS,
    catLabels: CAT_LABELS,
    category: 'all',
    catMap: catMap('all'),
    items: [],
    total: 0,
    keyword: '',
    // 精准 / 模糊：默认模糊
    searchMode: 'fuzzy',
    // 骨架屏：只在首屏出现（之后切换是本地计算，闪骨架屏反而更晃眼）
    loading: true,
    firstLoaded: false,
    noMore: false,
    // 云端这次没拉到（≠ 真的没有）。有它才能不把「读不到」说成「这里空空如也」
    netFail: false,
    netBusy: false,
  },

  onLoad(options) {
    // 结果缓存：切过的组合再切回来直接用
    this._listCache = perf.createCache(12);
    // 全站搜索的「查看更多闲置」把关键词带进来（load 读的是 this.data.keyword）
    const kw0 = String((options && options.kw) || '').trim();
    if (kw0) this.setData({ keyword: kw0 });
    this._renderCount = PAGE_STEP;
    // 翻页游标按 tab 分开记：不然在「全部」翻到第 3 页再切到「寻物」，
    // 会拿着 3 去要寻物的第 4 页，中间的整页就被跳过了
    this._cloudPage = {};
    // 每个 tab 各拉一次就够了：切回来走缓存，不再联网
    this._fetchedTypes = {};
    this.load({ force: true });
  },

  onShow() {
    // 全站搜索的「查看更多闲置」落在 tabBar 页上，switchTab 带不了 query，
    // 关键词是先投递到 storage 再在这里取走的（见 utils/nav.js takePending）。
    // 这一条必须自己触发重载：onLoad 已经按空关键词渲染过一轮了
    if (this.takeNavKeyword(nav.takePending(this.route))) {
      this.resetAndReload();
      return;
    }
    // 从发布页退回来时刷新（刚发的不该看不到）。
    // 注意：这里走的是本地缓存 —— 刚发布的条目 market.addMarket 已经写进本地了，
    // 所以只清结果缓存重新算一遍即可，不需要再等一次网络往返。
    if (this.data.firstLoaded) {
      this.resetAndReload();
    }
  },

  // 中转过来的关键词。返回是否真的写了，调用方据此决定要不要重载
  takeNavKeyword(q) {
    if (!q) return false;
    const kw = String(q.kw || '').trim();
    if (!kw) return false;
    this.setData({ keyword: kw });
    return true;
  },

  // 栈顶已经是本页时 nav.go 不会 switchTab，直接调这里带参数
  onTabParams(q) {
    if (this.takeNavKeyword(q)) this.resetAndReload();
  },

  onUnload() {
    if (this._timer) clearTimeout(this._timer);
  },

  /**
   * 取数据并渲染。
   * @param {{force?:boolean}} opts force=true 才联网（首次进入 / 下拉刷新）
   */
  async load(opts) {
    const o = opts || {};
    const key = this.cacheKey();

    // 命中缓存：不联网、不重算，直接出结果
    if (!o.force && this._listCache && this._listCache.has(key)) {
      this.render(this._listCache.get(key));
      return;
    }

    if (!this.data.firstLoaded) this.setData({ loading: true });

    // 联网时机只有三种：首次进入、下拉刷新、这个 tab 还没拉过。
    // 而且只拉「当前 tab 的类型」（类型下推到云端），不是每次都拉全类型再本地筛。
    if (o.force || !this._fetchedTypes[this.data.tab]) {
      // 派生档按它的真实 type 去拉：课程互助要先拉到「闲置」那一类，再在本地按分类筛
      const only = this.data.tab === 'all' ? '' : typeOfTab(this.data.tab);
      // 首屏有骨架屏、下拉刷新有系统动画，只有「切到一个还没拉过的 tab」要自己给个提示，
      // 否则用户点了寻物，列表半天没动静会以为没点上
      const needMask = this.data.firstLoaded && !o.force;
      if (needMask) wx.showLoading({ title: '加载中', mask: false });
      try {
        await market.fetchMarkets(1, only);
      } catch (e) { /* 云端不可用不影响本地缓存照常显示 */ }
      if (needMask) wx.hideLoading();
      this._fetchedTypes[this.data.tab] = Date.now();
      // 数据换过一轮，之前算出来的结果全部作废
      if (this._listCache) this._listCache.clear();
    }

    const list = this.computeList();
    if (this._listCache) this._listCache.set(key, list);
    this.render(list);
  },

  // 影响结果的所有条件都算进 key：漏一个就会出现「切了分类但列表没变」
  cacheKey() {
    const kw = String(this.data.keyword || '').trim();
    return [
      this.data.tab,
      this.data.tab === 'sell' ? this.data.category : '-',
      kw,
      this.data.searchMode
    ].join('|');
  },

  // 过滤只做这一遍：原来关键词和分类各写一次，云端拉完只补了关键词，
  // 分类筛选就被整份覆盖掉 —— 选了「教材」，一联网就混进数码和生活类
  computeList() {
    const tab = this.data.tab;
    const kw = String(this.data.keyword || '').trim();
    // 课程互助 = 闲置里 category=substitute 的那批，取数用 sell，筛完再按分类收口
    const type = typeOfTab(tab);
    const list = kw
      ? market.searchMarkets(type, kw, this.data.searchMode === 'exact')
      : market.getMarkets(type);
    if (tab === 'substitute') return market.filterByCategory(list, 'substitute');
    return tab === 'sell' ? market.filterByCategory(list, this.data.category) : list;
  },

  // 只渲染前 N 条：长列表一次 setData 几百条是最直接的卡顿来源
  render(list) {
    const n = this._renderCount || PAGE_STEP;
    const items = list.slice(0, n);
    this.setData({
      items: items,
      total: list.length,
      noMore: items.length >= list.length,
      loading: false,
      firstLoaded: true,
      netFail: market.fetchState().ok === false
    });
  },

  // 重试：强制重新拉一次当前 tab（跳过「这个 tab 拉过了」的缓存判断）
  async onRetryNet() {
    if (this.data.netBusy) return;
    this.setData({ netBusy: true });
    this._fetchedTypes[this.data.tab] = 0;
    if (this._listCache) this._listCache.clear();
    if (this._cloudPage) this._cloudPage[this.data.tab] = 1;
    try {
      await this.load({ force: true });
    } catch (e) { /* load 内部已容错 */ }
    this.setData({ netBusy: false });
  },

  // 换条件（切 tab / 切分类 / 改关键词）：回到第一页重新看
  resetAndReload() {
    if (this._listCache) this._listCache.clear();
    this._renderCount = PAGE_STEP;
    this.load();
  },

  // 节流 300ms + 同值直接忽略：连点不会在同一帧里跑两遍筛选
  onTab: perf.throttle(function (e) {
    const t = e.currentTarget.dataset.k;
    if (!t || t === this.data.tab) return;
    this.setData({
      tab: t,
      tabMap: tabMap(t),
      // 换 tab 时清掉关键词，避免「切到寻物还带着上次的搜索词」
      keyword: ''
    });
    this.resetAndReload();
  }, 300),

  // 胶囊组件回传的是 detail.value，包一层换成 onTab 认的 data-k，筛选逻辑就不必重写
  onPillChange(e) {
    this.onTab({ currentTarget: { dataset: { k: e.detail.value } } });
  },

  // 分类胶囊（只在「闲置」档显示）：同上一层的包法，直接复用 onCategory
  onCatPillChange(e) {
    this.onCategory({ currentTarget: { dataset: { c: e.detail.value } } });
  },

  onCategory: perf.throttle(function (e) {
    const c = e.currentTarget.dataset.c || 'all';
    if (c === this.data.category) return;
    this.setData({ category: c, catMap: catMap(c) });
    this.resetAndReload();
  }, 300),

  onSearch(e) {
    const kw = e.detail.value;
    this.setData({ keyword: kw });
    if (this._timer) clearTimeout(this._timer);
    // 防抖：每敲一个字都全量重算没必要，停手 250ms 再算
    this._timer = setTimeout(() => this.resetAndReload(), 250);
  },

  onSearchClear() {
    if (this._timer) clearTimeout(this._timer);
    this.setData({ keyword: '' });
    this.resetAndReload();
  },

  // 精准 / 模糊：和课程页、论坛页同一套
  onSearchMode(e) {
    const m = e.currentTarget.dataset.m;
    if (m === this.data.searchMode) return;
    this.setData({ searchMode: m });
    this.resetAndReload();
    wx.showToast({
      title: m === 'exact' ? '只找完全一致的' : '打错字也能找到',
      icon: 'none',
      duration: 1500
    });
  },

  // 触底：先把本地剩下的翻出来，本地看完了才向云端再要一页
  onReachBottom() {
    if (this.data.noMore) return;
    const list = (this._listCache && this._listCache.get(this.cacheKey())) || [];
    if ((this._renderCount || PAGE_STEP) < list.length) {
      this._renderCount = (this._renderCount || PAGE_STEP) + PAGE_STEP;
      this.render(list);
      return;
    }
    this.loadMore();
  },

  async loadMore() {
    if (this._loadingMore) return;
    this._loadingMore = true;
    wx.showLoading({ title: '加载中', mask: false });
    try {
      const cur = (this._cloudPage && this._cloudPage[this.data.tab]) || 1;
      const next = cur + 1;
      // 和首屏一样按真实 type 翻页：课程互助页翻的是「闲置」那一类，本地再按分类收口
      const only = this.data.tab === 'all' ? '' : typeOfTab(this.data.tab);
      const got = await market.fetchMarkets(next, only);
      if (!got) {
        // 云端真没了，别再让用户一直往下拖
        this.setData({ noMore: true });
        return;
      }
      this._cloudPage[this.data.tab] = next;
      if (this._listCache) this._listCache.clear();
      this._renderCount = (this._renderCount || PAGE_STEP) + PAGE_STEP;
      this.render(this.computeList());
    } catch (e) {
      this.setData({ noMore: true });
    } finally {
      wx.hideLoading();
      this._loadingMore = false;
    }
  },

  // 下拉刷新：这是唯一「主动联网」的入口（把最新一条拉回来）
  async onPullDownRefresh() {
    try {
      this._cloudPage = {};
      this._renderCount = PAGE_STEP;
      if (this._listCache) this._listCache.clear();
      await this.load({ force: true });
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  goDetail(e) {
    nav.go({ url: '/sub/market/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  goEdit() {
    const tab = this.data.tab;
    // 从「课程互助」档点发布：直接把 type=sell + category=substitute 带过去，
    // 让用户少点两下 —— 他在课程互助列表里点「＋」，要发的就是这一类信息。
    // 「全部」档不带 type（发布页默认寻物，和原来一致）
    const type = tab === 'all' ? '' : typeOfTab(tab);
    const cat = tab === 'substitute'
      ? 'substitute'
      : (tab === 'sell' && this.data.category !== 'all' ? this.data.category : '');
    const qs = [];
    if (type) qs.push('type=' + type);
    if (cat) qs.push('cat=' + cat);
    nav.go({ url: '/sub/market/edit/edit' + (qs.length ? '?' + qs.join('&') : '') });
  },

  myTap() {
    nav.go({ url: '/sub/market/mine/mine' });
  },

  goResources() {
    nav.go({ url: '/pages/tool/resources/resources' });
  },

  previewImages(e) {
    const urls = e.currentTarget.dataset.imgs || [];
    if (!urls.length) return;
    wx.previewImage({ current: urls[0], urls: urls });
  },

  onShareAppMessage() {
    return {
      title: '商砖小站 · 丢了的 / 捡到的 / 闲置的都在这儿',
      path: '/pages/market/list/list'
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
