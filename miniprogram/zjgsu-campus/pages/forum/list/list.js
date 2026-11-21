// pages/forum/list/list.js
// 分页：一次只渲染一页，触底再要下一页；没有更多了才回头让云端多给一页。
const store = require('../../../utils/store.js');
const moderation = require('../../../utils/moderation.js');
const userApi = require('../../../utils/user.js');
const nav = require('../../../utils/nav.js');
const perf = require('../../../utils/perf.js');
const haptic = require('../../../utils/haptic.js');
// 全站同一套精准 / 模糊内核：帖子标题打错字也该搜得到

const COURSE_BOARD = '课程评价';
const PAGE_SIZE = store.PAGE.SIZE;

// 排序档位：加一档就得在 store.getPosts 里有对应的排法，否则切过去是「没反应」。
// 图标路径直接写进数据（iconSrc）：WXML 的 {{}} 里调不了方法，嵌套三元
// 写在模板里既难读又容易括号错配（历史上 vote-card 空白 bug 同源），所以在这里算好
const SORT_OPTIONS = [
  { k: 'pinned', icon: 'pin', label: '置顶', iconSrc: '/assets/icons/pin--muted.svg' },
  { k: 'latest', icon: 'clock', label: '最新', iconSrc: '/assets/icons/clock--muted.svg' },
  { k: 'hot', icon: 'flame', label: '热门', iconSrc: '/assets/icons/flame--brand.svg' },
  { k: 'likes', icon: 'thumbs-up', label: '最多赞', iconSrc: '/assets/icons/thumbs-up--brand600.svg' },
  { k: 'dislikes', icon: 'thumbs-down', label: '最多踩', iconSrc: '/assets/icons/thumbs-down--muted.svg' },
  { k: 'comments', icon: 'message-circle', label: '最多留言', iconSrc: '/assets/icons/message-circle--muted.svg' }
];

// 卡片「指纹」：判断列表里某张卡需不需要重绘。
// 不能只比 id —— 赞 / 踩 / 留言数 / 举报态都是「id 不变、内容原地变」的字段。
// 列表里点一下赞，id 没变，只比 id 的旧逻辑就会判成「内容没变」→ 跳过 setData，
// 界面永远不动，表现就是「赞踩点不动，只能进详情」。任一互动字段变了才算「要重绘」。
function sameCard(a, b) {
  return a.id === b.id
    && a.likes === b.likes
    && a.dislikes === b.dislikes
    && !!a.liked === !!b.liked
    && !!a.disliked === !!b.disliked
    && a.commentCount === b.commentCount
    && !!a.reported === !!b.reported
    && !!a.hidden === !!b.hidden
    // 编辑只改这些字段，互动计数可以完全不变。漏比它们的话，
    // 返回列表时会判成「这张卡没变」而跳过 setData —— 标题和正文还是旧的，
    // 用户只能重启/重新进入页面才看得到修改。
    && String(a.title || '') === String(b.title || '')
    && String(a.content || '') === String(b.content || '')
    && JSON.stringify(a.images || []) === JSON.stringify(b.images || [])
    && String(a.editedAt || '') === String(b.editedAt || '')
    && !!a.edited === !!b.edited
    && String(a.time || '') === String(b.time || '')
    && String(a.author || '') === String(b.author || '');
}

Page({
  data: {
    showBackTop: true,
    posts: [],
    board: '全部',
    boards: ['全部'],
    sort: 'pinned', // pinned | latest | hot | likes | dislikes | comments
    sortOptions: SORT_OPTIONS,
    isCourseBoard: false,
    courseFilter: [], // [{ courseId, courseName, count }]
    courseId: '', // 当前筛选的课程，空串表示不限
    rendered: 0, // 已经渲染出来的条数
    noMore: false,
    refreshing: false,
    // 搜索相关：keyword 是输入框里的原文，searching 是「正在按关键词展示结果」
    keyword: '',
    searching: false,
    // 输入框是否聚焦：最近搜索这段只在聚焦时展开，平时让位给帖子列表
    searchFocus: false,
    // 搜过一次（结果已渲染）：只用来区分「搜不到」和「这个板块本来就没帖子」
    searched: false,
    resultCount: 0,
    // 精准 / 模糊：默认模糊，打错字也搜得到
    searchMode: 'fuzzy',
    searchHistory: [],
    hotKeywords: [],
    // 热门话题 / 板块默认收起，首屏只留必要的一行
    topicOpen: false,
    boardExpanded: false,
    boardShown: [],
    // 卡片上点「分享」时记下这条帖子，系统菜单的转发会优先转发它
    sharePost: null,
    // 骨架屏与断网提示：加载态和空态都要有，别让用户在白屏上猜发生了什么
    loading: true,
    offline: false,
    // 云端这次没读到（和 offline 是两回事：offline 看设备网络，netFail 看同步结果）。
    // 有它才能把「真的没有帖子」和「这次没拉到」说成两句话
    netFail: false,
    netBusy: false,
    // 被举报暂停展示的内容条数。不进主列表，但要给同学一个能进来的口子 ——
    // 藏起来之后没人看得见，作者不知道发生了什么，别人也补不了举报
    hiddenCount: 0,
  },

  onLoad(options) {
    // 筛选结果缓存：切过的「板块 × 排序 × 课程」组合再切回来直接用，
    // 不必每次都把几百条帖子重新过滤 + 排序一遍（这是切板块发涩的主要来源）
    this._listCache = perf.createCache(12);
    const boardNames = store.getBoards().map((b) => b.name);
    const boards = ['全部'].concat(boardNames);
    const boardShown = boards.slice(0, 5);
    // 全站搜索的「查看更多帖子」把关键词带进来。
    // load() 里第一件事就是判 this.data.keyword，所以要在它之前 setData
    const kw0 = String((options && options.kw) || '').trim();
    this.setData({
      boards: boards,
      boardShown: boardShown,
      searchHistory: store.getSearchHistory(),
      hotKeywords: store.getHotKeywords(),
      keyword: kw0,
      searching: !!kw0
    });
    this.checkNetwork();
    this.load();
    this.syncPinned();
    this._skipShowLoad = true;
  },

  // 缓存键：三个筛选条件漏一个就会出现「切了板块但列表没变」
  listKey() {
    return [this.data.board, this.data.sort, this.data.courseId].join('|');
  },

  // 取「当前筛选条件下」的帖子：命中缓存直接返回，否则算一遍并存起来
  getList() {
    const key = this.listKey();
    const hit = this._listCache && this._listCache.get(key);
    if (hit) return hit;
    const list = store.getPosts({
      board: this.data.board,
      sort: this.data.sort,
      courseId: this.data.courseId
    });
    if (this._listCache) this._listCache.set(key, list);
    return list;
  },

  // 数据被改过（点赞 / 举报 / 拉了新一页）就必须作废，否则会看到旧内容
  invalidate() {
    if (this._listCache) this._listCache.clear();
  },

  // 断网时列表照常显示缓存，但要说明一句「这可能是旧的」，
  // 否则用户会以为内容就这么少了
  checkNetwork() {
    wx.onNetworkStatusChange((res) => {
      this.setData({ offline: !res.isConnected });
    });
    try {
      wx.getNetworkType({
        success: (res) => this.setData({ offline: res.networkType === 'none' })
      });
    } catch (e) {}
  },

  onShow() {
    // 全站搜索的「查看更多帖子」落在 tabBar 页上，switchTab 带不了 query，
    // 关键词是先投递到 storage 再在这里取走的（见 utils/nav.js takePending）
    const pending = nav.takePending(this.route);
    this.takeNavKeyword(pending);
    const skip = this._skipShowLoad && !pending;
    this._skipShowLoad = false;
    if (skip) return;
    // 从详情页 / 发帖页退回来：帖子内容可能变过（点了赞、新发了帖），
    // 缓存整体作废一次，之后在本页内切板块就都是命中缓存
    this.invalidate();
    this.load();
    this.syncPinned();
  },

  // 置顶帖独立补拉：普通信息流只拉最新一页。
  syncPinned() {
    const now = Date.now();
    if (this._pinSyncAt && now - this._pinSyncAt < 60000) return;
    this._pinSyncAt = now;
    if (typeof store.fetchPinnedPostsFromCloud !== 'function') return;
    store.fetchPinnedPostsFromCloud().then((ok) => {
      if (!ok || this._gone) return;
      this.invalidate();
      this.load();
    }).catch(() => {});
  },

  // 中转过来的关键词。空值不动现有条件 —— 别把用户自己输的词清掉
  takeNavKeyword(q) {
    if (!q) return;
    const kw = String(q.kw || '').trim();
    if (!kw) return;
    this.setData({ keyword: kw, searching: true });
  },

  // 栈顶已经是本页时 nav.go 不会 switchTab，直接调这里带参数
  onTabParams(q) {
    this.takeNavKeyword(q);
    this.invalidate();
    this.load();
  },


  load() {
    // 搜索态下 load 必须走搜索，否则触底加载会把「搜出来的结果」换成不带关键词的完整列表
    if (this.data.keyword && this.data.keyword.trim()) {
      this.runSearch(this.data.keyword);
      return;
    }
    // 走缓存：同一组筛选条件只算一次
    const posts = this.getList();

    // 「课程评价」板块：按课程把帖子汇总，方便一门一门看
    let isCourseBoard = false;
    let courseFilter = [];
    if (this.data.board === COURSE_BOARD) {
      isCourseBoard = true;
      // 没选具体课程时，上面那次查询已经是这个板块的全量了 —— 直接复用，
      // 别再跑一遍 getPosts（原来这里是无条件二次全量查询，等于每次都算两遍）
      const all = this.data.courseId
        ? store.getPosts({ board: COURSE_BOARD, sort: 'latest', courseId: '' })
        : posts;
      const map = {};
      all.forEach((p) => {
        if (!p.courseId) return;
        if (!map[p.courseId]) {
          map[p.courseId] = {
            courseId: p.courseId,
            courseName: p.courseName || '未命名课程',
            count: 0
          };
        }
        map[p.courseId].count += 1;
      });
      courseFilter = Object.keys(map).map((k) => map[k]);
    }

    // 带上「我举报过没有」：已举报的按钮要变灰，不然用户以为没点上会一直戳
    const marked = posts.map((p) => Object.assign({}, p, { reported: store.hasReported(p.id) }));

    const total = posts.length;
    const rendered = Math.min(total, this.data.rendered || PAGE_SIZE);
    const next = {
      rendered,
      total,
      noMore: rendered >= total,
      isCourseBoard,
      courseFilter,
      courseId: this.data.courseId,
      hiddenCount: store.getHiddenPosts().length,
      // 只有「没读到」才把空态让给 net-tip；同步正常时它的 ok 不是 false
      netFail: store.syncState().ok === false
    };
    // 列表内容没变就别重刷整个列表：每次从详情页/发帖页退回来都会走这里，
    // 全量 setData 在低端机上就是「卡顿」的来源。
    // 「没变」用 sameCard 逐张比（含赞/踩/留言数/举报态），不是只比 id ——
    // 否则「在列表里点了个赞」这种 id 不变、内容原地变的更新会被误判成没变化，
    // 跳过 setData 后界面不刷新，看着就像按钮点不动。
    const old = this.data.posts || [];
    const same = old.length === rendered && old.every((p, i) => sameCard(p, marked[i]));
    if (!same) next.posts = marked.slice(0, rendered);
    next.loading = false;
    this.setData(next);
  },

  // 重试同步。失败也不弹 toast：net-tip 自己不消失就是最准确的反馈，
  // 再叠一句「还是连不上」只是噪音
  async onRetryNet() {
    if (this.data.netBusy) return;
    this.setData({ netBusy: true });
    try {
      await store.syncNow();
    } catch (e) { /* syncNow 自己吞错，这里只是兜底 */ }
    this.invalidate();
    this.load();
    this.setData({ netBusy: false });
  },

  /* ---------------- 搜索 ---------------- */

  // 输入防抖：每敲一个字都去全表扫一遍没必要，停手 200ms 再算
  onSearchInput(e) {
    const kw = e.detail.value;
    this.setData({ keyword: kw });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.runSearch(kw), 200);
  },

  // 回车 / 点「搜索」：记进历史，并立刻出结果
  onSearchConfirm() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    const kw = String(this.data.keyword || '').trim();
    this.setData({
      searchHistory: kw ? store.pushSearchHistory(kw) : store.getSearchHistory()
    });
    this.runSearch(this.data.keyword);
  },

  // 最近搜索：聚焦展开、失焦收起。
  // 收起要延后 300ms —— input 的 blur 一定早于 chip 的 tap 到达，
  // 立刻 wx:if 掉的话节点已经不在渲染树上，点历史词会没反应。
  // 300 而不是 260：慢手速的同学从放下搜索框到点中 chip 可能要 200 多毫秒，
  // 留够余量比省那 40ms 重要（这段本来就是给人点词用的）。
  onSearchFocus() {
    if (this._blurTimer) {
      clearTimeout(this._blurTimer);
      this._blurTimer = null;
    }
    this.setData({ searchFocus: true });
  },

  onSearchBlur() {
    if (this._blurTimer) clearTimeout(this._blurTimer);
    this._blurTimer = setTimeout(() => {
      this._blurTimer = null;
      this.setData({ searchFocus: false });
    }, 300);
  },

  onClearSearch() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this.setData({ keyword: '', searching: false, resultCount: 0, sharePost: null });
    this.load();
  },

  // 精准 / 模糊：和课程页同一套内核，同学打错字也搜得到帖子
  onSearchMode(e) {
    const m = e.currentTarget.dataset.m;
    if (m === this.data.searchMode) return;
    this.setData({ searchMode: m });
    if (String(this.data.keyword || '').trim()) this.runSearch(this.data.keyword);
    wx.showToast({
      title: m === 'exact' ? '只找完全一致的' : '打错字也能找到',
      icon: 'none',
      duration: 1500
    });
  },

  onTapHistory(e) {
    const kw = e.currentTarget.dataset.k || '';
    this.setData({ keyword: kw });
    this.onSearchConfirm();
  },

  onClearHistory() {
    this.setData({ searchHistory: store.clearSearchHistory() });
  },

  async runSearch(keyword) {
    const kw = String(keyword || '').trim();
    if (!kw) {
      this.setData({ searching: false, searched: false, resultCount: 0 });
      this.load();
      return;
    }
    this.setData({ searching: true });

    const exact = this.data.searchMode === 'exact';
    let list = store.searchPosts(kw, exact);

    // 本地缓存只是最近几页（分页拉取），结果太少时再向云端多要三页，
    // 否则会出现「库里明明有这条，搜出来是空的」
    if (list.length < 5 && this._deepFor !== kw + '|' + (exact ? 'e' : 'f')) {
      this._deepFor = kw + '|' + (exact ? 'e' : 'f');
      await store.fetchPostsFromCloud(3);
      list = store.searchPosts(kw, exact);
    }

    const rendered = Math.min(list.length, PAGE_SIZE);
    this.setData({
      posts: list.slice(0, rendered),
      total: list.length,
      rendered,
      noMore: rendered >= list.length,
      resultCount: list.length,
      isCourseBoard: false,
      courseFilter: [],
      // 结果出来了就退出「搜索态」，否则板块栏 / 排序栏 / 树洞入口全被 wx:if 藏掉，
      // 搜完一次就只能盯着结果，切不了板块也换不了排序
      searching: false,
      // 但「空态文案」还得分得清：搜不到 ≠ 这个板块本来就没帖子
      searched: true
    });
  },

  /* ---------------- 分享 ---------------- */

  // 点卡片上的「分享」：先把这条帖记下来，转发时转发它而不是整个论坛
  // 用 _shareTarget 而不是 data：setData 是异步的，转发面板读 data 可能还没刷上去
  // 长按帖子卡复制标题和正文；列表卡片本身仍可点进详情。
  onCopyPost(e) {
    const id = String(e.currentTarget.dataset.id || '');
    const p = (this.data.posts || []).find((x) => x.id === id);
    if (!p) return;
    const text = [p.title, p.content].filter(Boolean).join('\n').trim();
    if (!text) return;
    wx.setClipboardData({ data: text, success: () => wx.showToast({ title: '已复制', icon: 'none' }) });
  },

  onSharePost(e) {
    const id = e.currentTarget.dataset.id;
    const p = (this.data.posts || []).find((x) => x.id === id);
    const target = p ? { id: p.id, title: p.title, image: (p.images && p.images[0]) || '' } : null;
    this._shareTarget = target;
    this.setData({ sharePost: target });
  },

  // 右上角系统菜单「转发给朋友」：有选中帖子就转发那条，否则转发整个论坛
  onShareAppMessage() {
    const p = this._shareTarget || this.data.sharePost;
    if (p && p.id) {
      return {
        title: (p.title || '一条来自论坛的帖子') + ' · 商砖小站',
        path: '/sub/forum/detail/detail?id=' + p.id,
        imageUrl: p.image || ''
      };
    }
    return {
      title: '商砖小站 · 找同伴、发吐槽、查课程评价',
      path: '/pages/forum/list/list'
    };
  },

  // 分享到朋友圈：简单模式，点开对方进入的就是这条帖子
  onShareTimeline() {
    const p = this._shareTarget || this.data.sharePost;
    return {
      title: (p && p.title ? p.title : '商砖小站 · 校园生活都在这儿'),
      query: p && p.id ? 'id=' + p.id : '',
      imageUrl: (p && p.image) || ''
    };
  },

  onToggleTopics() {
    this.setData({ topicOpen: !this.data.topicOpen });
  },

  onToggleBoards() {
    const expanded = !this.data.boardExpanded;
    const all = this.data.boards || [];
    this.setData({
      boardExpanded: expanded,
      boardShown: expanded ? all : all.slice(0, 5)
    });
  },

  // 节流 300ms：手指连点板块不会在同一帧里跑两遍「过滤 + 排序 + setData」
  onBoard: perf.throttle(function (e) {
    const board = e.currentTarget.dataset.b;
    if (!board || board === this.data.board) return;
    // 换板块时清掉课程筛选，避免残留上一次的选中项；
    // 收起分类时把当前板块保留在首屏，否则选中项会消失在“更多”里。
    const all = this.data.boards || [];
    const preview = all.slice(0, 5);
    if (preview.indexOf(board) < 0 && preview.length) preview[preview.length - 1] = board;
    this.setData({
      board: board,
      courseId: '',
      rendered: 0,
      boardExpanded: false,
      boardShown: preview
    });
    this.invalidate();
    // 别人刚发的帖子可能还没同步到本机；切板块时补拉最新一页。
    // 15 秒内只补一次，失败就用本地缓存，不能因为网络问题让切换失效。
    const now = Date.now();
    const last = Number(this._boardSyncAt) || 0;
    const finish = () => this.load();
    if (last && now - last < 15000) { finish(); return; }
    this._boardSyncAt = now;
    Promise.resolve(store.loadMorePosts(true)).catch(() => false).then(finish);
  }, 300),

  // 「最新 / 热门 / 最多赞 …」切换：直接指定要哪个，不再来回翻转
  onSortPick: perf.throttle(function (e) {
    const sort = String(e.currentTarget.dataset.s || '');
    if (!sort || sort === this.data.sort) return;
    // 排序变了就是一份新的列表：必须回到第一页并回到顶部，
    // 否则用户还停在上一档的第 3 屏，会以为“切了排序但列表没变”。
    this.invalidate();
    this.setData({ sort, rendered: 0 }, () => {
      this.load();
      wx.pageScrollTo({ scrollTop: 0, duration: 0 });
    });
  }, 300),

  // 列表上直接点赞 / 点踩，不进详情页。
  // 这里只记本地那一下（点完马上变色），云端值回来会被覆盖成权威值
  onPostVote(e) {
    const id = String(e.currentTarget.dataset.id || '');
    const kind = e.currentTarget.dataset.v === 'dislike' ? 'dislike' : 'like';
    if (!id) return;
    const r = store.toggleVote(id, kind);
    if (!r) return;
    // 只改这一张卡的数字和高亮，不重新排序：热门列表不会因为点了一下就跳位
    this.invalidate();
    const posts = (this.data.posts || []).map((p) => (
      p.id === id ? Object.assign({}, p, {
        likes: r.likes, dislikes: r.dislikes, liked: r.liked, disliked: r.disliked
      }) : p
    ));
    this.setData({ posts: posts });
  },

  // 进匿名树洞：独立页面，强制匿名
  goHole() {
    nav.go({ url: '/sub/forum/hole/hole' });
  },

  // 校园盲盒 / 漂流瓶：tabBar 满了，入口放论坛页树洞下面（都是匿名说心里话的场景）
  goBlindbox() {
    nav.go({ url: '/sub/campus/blindbox/blindbox' });
  },

  // 被举报暂停展示的内容：单独一页，能看也能继续举报
  goHidden() {
    nav.go({ url: '/pages/forum/hidden/hidden' });
  },

  // 节流 300ms：连点不同课程也不会重复跑筛选
  onCourseFilter: perf.throttle(function (e) {
    this.setData({ courseId: e.currentTarget.dataset.c || '', rendered: 0 });
    this.load();
  }, 300),

  // 下拉手势在部分机型可能被页面结构吞掉，按钮走同一套刷新核心。
  manualRefresh() {
    if (this.data.refreshing) return;
    this.setData({ refreshing: true });
    this.runRefresh().then(() => this.setData({ refreshing: false }))
      .catch(() => this.setData({ refreshing: false }));
  },

  async runRefresh() {
    await store.loadMorePosts(true);
    this.setData({ rendered: 0, noMore: false });
    this.invalidate();
    this.load();
  },

  // 下拉刷新：重新拉云端数据后再渲染
  async onPullDownRefresh() {
    if (this.data.refreshing) return;
    this.setData({ refreshing: true });
    try {
      await this.runRefresh();
    } finally {
      this.setData({ refreshing: false });
      wx.stopPullDownRefresh();
    }
  },

  // 触底加载：先吃本地剩下的，不够了才向云端要
  async onReachBottom() {
    const total = this.data.total || 0;
    if (this.data.noMore) return;
    if (this.data.rendered < total) {
      this.setData({ rendered: Math.min(total, this.data.rendered + PAGE_SIZE) });
      this.load();
      return;
    }
    const more = await store.loadMorePosts();
    if (more) {
      // 拉到了新一页，从第一页重新渲染，露出最新的内容
      this.setData({ rendered: 0, noMore: false });
      // 数据多了一批，缓存作废
      this.invalidate();
    } else {
      // 云端真没了，别再让用户一直往下拖
      this.setData({ noMore: true });
    }
    this.load();
  },

  goDetail(e) {
    nav.go({ url: '/sub/forum/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  // 从帖子跳到该课程详情页（看看这门课的评分与评价）
  goCourse(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    nav.go({ url: '/sub/course/detail/detail?id=' + id });
  },

  goPost() {
    nav.go({ url: '/sub/forum/post/post' });
  },

  // 列表上直接举报，不用先点进详情。
  // 和详情页那份走的是同一个云函数、同一套判定和自动处置规则
  onReportPost(e) {
    const id = String(e.currentTarget.dataset.id || '');
    const target = String(e.currentTarget.dataset.openid || '');
    if (!id) return;
    if (store.hasReported(id)) {
      wx.showToast({ title: '你已经举报过这条了', icon: 'none' });
      return;
    }
    if (!target) {
      wx.showToast({ title: '这条内容太老了，缺作者信息没法举报', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: moderation.REPORT_REASONS,
      success: (res) => {
        const reason = moderation.REPORT_REASONS[res.tapIndex];
        wx.showModal({
          title: '举报：' + reason,
          content: moderation.reportTip(reason),
          placeholderText: '例如：这条在推销校外培训班',
          editable: true,
          confirmColor: '#d9534f',
          success: async (m) => {
            if (!m.confirm) return;
            const r = await userApi.reportPost(target, reason, (m.content || '').slice(0, 200), id, 'post');
            // 已经落到服务端了，本地记一笔，按钮立刻变成「已举报」
            store.markReported(id);
            // 云端当场判定处置动作，本地镜像跟着改
            if (r && r.action === 'hide') store.setPostStatus(id, 'hidden');
            else if (r && r.action === 'delete') store.setPostStatus(id, 'deleted');
            // 举报态 / 显示状态变了，缓存作废
            this.invalidate();
            this.load();
            // 举报已经落到服务端、撤不回来了，给一句具体的动作确认
            haptic.ok();
            wx.showToast({ title: (r && r.msg) || '已提交', icon: 'none', duration: 2500 });
          }
        });
      },
      fail: () => {}
    });
  },

  previewImages(e) {
    const list = e.currentTarget.dataset.imgs || [];
    if (!list.length) return;
    wx.previewImage({ current: list[0], urls: list });
  },

  // 浮动回到顶部：默认亮出，越过一小段距离后继续显示；只在回到顶部后隐藏。
  onPageScroll(e) {
    const show = (Number(e && e.scrollTop) || 0) > 120;
    if (show !== this.data.showBackTop) this.setData({ showBackTop: show });
  },

  // 页面级回到顶部：不经过自定义组件的 visible 状态，按钮始终可点。
  backTop() {
    wx.pageScrollTo({ scrollTop: 0, duration: 280 });
  },
});
