// pages/search —— 跨模块统一搜索
//
// 为什么要有：课程 / 论坛 / 闲置 / 活动 / 同学各自有搜索，但入口分散在五个 tab 里。
// 想找「上次看到的那个兼职帖」得先猜它在哪个 tab —— 而用户记住的往往是内容，
// 不是它属于哪个栏目。
//
// 三条实现约束：
//   1) 各模块的列表都是本地缓存镜像（云端同步写回来的），所以这里**只搜本地**，
//      不联网、不等待 —— 搜一个字就出结果，输入过程本身就是检索过程。
//      代价是「刚发布还没同步上」的那条搜不到，而这个窗口只有几秒。
//   2) 匹配一律走 utils/search.js 那一套四级降级，和站内其它搜索完全一致 ——
//      同样是「打错一个字」，在这一页能搜到、在论坛页搜不到，是最让人困惑的一种不一致。
//   3) 结果分组展示、每组限 5 条并显示总数。「搜到 300 条课程」没有意义，
//      用户要的是「看前几条里有没有我要的那个」。
const nav = require('../../utils/nav.js');
const store = require('../../utils/store.js');
const market = require('../../utils/market.js');
const event = require('../../utils/event.js');
const userApi = require('../../utils/user.js');
const searchCore = require('../../utils/search.js');

// 每组最多展示几条。总数照实显示在组标题上，用户据此决定要不要去那个 tab 继续翻
const GROUP_MAX = 5;

Page({
  data: {
    keyword: '',
    searched: false,
    groups: [],
    history: [],
    hot: [],
    searching: false
  },

  onLoad() {
    this.setData({
      history: store.getSearchHistory(),
      hot: store.getHotKeywords()
    });
  },

  onInput(e) {
    const kw = e.detail.value;
    this.setData({ keyword: kw });
    // 输入即搜：本地检索没有网络成本，等用户按回车反而多一步
    this.run(kw, false);
  },

  onSubmit() {
    this.run(this.data.keyword, true);
  },

  onTapKeyword(e) {
    const kw = e.currentTarget.dataset.kw;
    this.setData({ keyword: kw });
    this.run(kw, true);
  },

  onClear() {
    this.setData({ keyword: '', groups: [], searched: false });
  },

  onClearHistory() {
    this.setData({ history: store.clearSearchHistory() });
  },

  // record=true 时才写检索历史：输入过程中每个中间状态都记一条，
  // 历史里会塞满「高」「高等」「高等数」这种半成品，真正的词反而被挤掉
  run(raw, record) {
    const kw = String(raw || '').trim();
    if (!kw) {
      this.setData({ groups: [], searched: false });
      return;
    }
    if (record) this.setData({ history: store.pushSearchHistory(kw) });

    this.setData({ searched: true, searching: true });
    const groups = [];
    const lv = (texts) => searchCore.matchFields(texts, kw);

    // ---- 课程 ----
    const courses = (store.getCourses() || [])
      .map((c) => ({ c: c, lv: lv([c.name, c.code, c.college, c.ctype]) }))
      .filter((x) => x.lv >= 0)
      .sort((a, b) => a.lv - b.lv)
      .map((x) => ({
        id: x.c.id,
        title: x.c.name,
        sub: [x.c.code, x.c.college, x.c.ctype].filter(Boolean).join(' · '),
        go: '/sub/course/detail/detail?id=' + x.c.id
      }));
    push(groups, '课程', courses, 'course');

    // ---- 论坛 ----
    const posts = (store.searchPosts(kw) || []).map((p) => ({
      id: p.id,
      // 普通帖现在可以没有标题：回退顺序 标题 → 正文开头 → 「（图片）」。
      // 只发了一张图的帖子在搜索结果里显示「（无标题）」，看着像数据坏了
      title: p.title || (p.content || '').slice(0, 24)
        || ((p.images && p.images.length) ? '（图片）' : '（无标题）'),
      sub: [p.board, p.author, p.time].filter(Boolean).join(' · '),
      go: '/sub/forum/detail/detail?id=' + p.id
    }));
    push(groups, '帖子', posts, 'forum');

    // ---- 闲置 ----
    const items = (market.searchMarkets('', kw) || []).map((m) => ({
      id: m.id,
      title: m.title,
      sub: [market.typeLabel(m.type), m.location, m.time].filter(Boolean).join(' · '),
      go: '/sub/market/detail/detail?id=' + m.id
    }));
    push(groups, '闲置', items, 'market');

    // ---- 活动 ----
    // 活动模块没有自己的搜索函数（本地列表量级不大），用同一个内核就地筛
    const events = (event.getEvents() || [])
      .map((e) => ({ e: e, lv: lv([e.title, e.desc, e.location, e.type]) }))
      .filter((x) => x.lv >= 0)
      .sort((a, b) => a.lv - b.lv)
      .map((x) => ({
        id: x.e.id,
        title: x.e.title,
        sub: [event.typeLabel(x.e.type), x.e.location, x.e.start].filter(Boolean).join(' · '),
        go: '/sub/campus/event/event?id=' + x.e.id
      }));
    // 活动这一组不给「更多」：校园页没有一个「按关键词过滤的活动列表」，
    // 跳过去只会是个不带筛选的完整列表 —— 那比不给入口更让人困惑
    push(groups, '校园活动', events, 'campus', true);

    // ---- 同学 ----
    // 唯一一个走云端的：同学资料不在本机，本地没有可搜的镜像。
    // 失败就这一组空着，其余四组的本地结果照常显示 ——
    // 云端抖一下不该让整页变成「什么都没找到」
    this.setData({ groups: groups.slice() });
    userApi.search(kw).then((list) => {
      const people = (list || []).map((u) => ({
        id: u.openid,
        title: u.nickName || '某位同学',
        sub: [u.college, u.motto].filter(Boolean).join(' · '),
        go: '/pages/user/card/card?openid=' + u.openid
      }));
      const next = this.data.groups.filter((g) => g.key !== 'profile');
      if (people.length) {
        next.splice(next.length, 0, {
          key: 'profile', title: '同学', icon: 'user-round', total: people.length,
          more: people.length > GROUP_MAX, items: people.slice(0, GROUP_MAX)
        });
      }
      this.setData({ groups: next, searching: false });
    }).catch(() => {
      this.setData({ searching: false });
    });
  },

  onTapItem(e) {
    const url = e.currentTarget.dataset.go;
    if (url) nav.go({ url: url });
  },

  onMore(e) {
    const key = e.currentTarget.dataset.key;
    const kw = encodeURIComponent(this.data.keyword);
    // 「更多」不是跳一个统一的结果页，而是跳回那个模块自己的列表并把关键词带过去 ——
    // 那边的筛选、排序、分页都是现成的，再做一个统一结果页等于把五套列表各抄一遍。
    // 三个目标都是 tabBar 页：nav.go 会用 switchTab，并把 ?kw= 投递给目标页的 onShow
    // （switchTab 本身带不了参数，见 utils/nav.js）。校园页没有按词过滤的活动列表，
    // 所以这里没有 campus 这一项 —— 它的结果组本来也不给「更多」。
    const map = {
      course: '/pages/course/list/list?kw=' + kw,
      forum: '/pages/forum/list/list?kw=' + kw,
      market: '/pages/market/list/list?kw=' + kw
    };
    if (map[key]) nav.go({ url: map[key] });
  }
});

// 组装一个结果分组。空组直接不 push —— 列表里挂着「课程 0 条」只是噪音
function push(groups, title, items, key, noMore) {
  if (!items.length) return;
  const ICON = { course: 'book-open', forum: 'message-circle', market: 'shopping-bag', campus: 'map-pin' };
  groups.push({
    key: key,
    title: title,
    icon: ICON[key] || 'search',
    total: items.length,
    more: !noMore && items.length > GROUP_MAX,
    items: items.slice(0, GROUP_MAX)
  });
}
