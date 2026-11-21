// sub/mine/favorites/favorites.js —— 我的收藏
// 收藏里存的是「类型 + id」，页面负责把 id 还原成能点进去的内容。
// 内容被删掉之后 id 还在列表里，这里要能安静地跳过，而不是显示一堆打不开的死链接。
const store = require('../../../utils/store.js');
const market = require('../../../utils/market.js');
const eventApi = require('../../../utils/event.js');
const nav = require('../../../utils/nav.js');

// 页签顺序 = 收藏类型的枚举顺序。改这里就要同步改 load() 里的还原分支，
// 少一个类型不会有任何报错，只是那一类永远为空 —— 所以枚举集中在这个文件里。
const TABS = [
  { k: 'all', label: '全部' },
  { k: 'course', label: '课程' },
  { k: 'post', label: '帖子' },
  { k: 'market', label: '失物闲置' },
  { k: 'event', label: '招聘会' }
];

// 类型 → 卡片上那个小标签的文字。放在 JS 里算而不是在模板里套三元：
// 模板里那种「market ? A : post ? B : ...」的写法，加到第四种类型就会静默
// 落到最后一个分支上 —— 招聘会会被标成「课程」，还不报错。
const TYPE_LABEL = {
  course: '课程',
  post: '帖子',
  review: '评价',
  market: '失物闲置',
  event: '招聘会'
};

Page({
  data: {
    items: [],
    loading: true,
    tab: 'all',
    tabMap: {},
    countText: ''
  },

  onShow() {
    this.load();
  },

  load() {
    const favs = store.getFavorites();
    const items = [];
    favs.forEach((f) => {
      let it = null;
      if (f.type === 'course') {
        const c = store.getCourseById(f.id);
        if (c) it = { key: f.id, type: 'course', title: c.name, desc: c.college, url: '/sub/course/detail/detail?id=' + f.id };
      } else if (f.type === 'post') {
        const p = store.getPostById(f.id);
        if (p) it = { key: f.id, type: 'post', title: p.title, desc: p.content, url: '/sub/forum/detail/detail?id=' + f.id };
      } else if (f.type === 'review') {
        const r = store.getReviewById(f.id);
        // 评价本身没有独立页面，跳回它所属的课程
        if (r) it = { key: f.id, type: 'review', title: r.content, desc: '来自 5 分评价', url: '/sub/course/detail/detail?id=' + r.courseId };
      } else if (f.type === 'market') {
        const m = market.getMarketById(f.id);
        if (m) it = { key: f.id, type: 'market', title: m.title, desc: m.desc, url: '/sub/market/detail/detail?id=' + m.id };
      } else if (f.type === 'event') {
        // 招聘会这一类**不能**因为查不到就跳过。官网活动只在窗口内
        // （招聘会按举办日期、公告按发布时间），一场秋招宣讲会完全可能在
        // 同学点开收藏之前就从列表里滚掉了 —— 那时这里如果安静地跳过，
        // 同学会以为是自己收藏没保存上。
        // 所以退回收藏时存的快照：打不开也要让他看见是哪一场、在哪办。
        const ev = eventApi.getEventById(f.id);
        const when = ev ? (ev.start || '') : (f.when || '');
        const place = ev ? (ev.location || '') : (f.place || '');
        const bits = [when, place].filter(Boolean);
        it = {
          key: f.id,
          type: 'event',
          title: (ev && ev.title) || f.title || '（这条活动的标题没存下来）',
          desc: bits.join(' · '),
          url: '/sub/campus/event/event?id=' + f.id,
          // 活动已经不在列表里 → 点进去只会看到「这个活动找不到了」。
          // 提前标出来，别让人以为收藏坏了又白点一次
          gone: !ev
        };
      }
      if (it) {
        it.typeLabel = TYPE_LABEL[it.type] || '';
        items.push(it);
      }
    });

    const tab = this.data.tab;
    const show = tab === 'all' ? items : items.filter((x) => x.type === tab);
    this.setData({
      items: show,
      tabMap: this.buildTabMap(tab),
      loading: false,
      countText: items.length ? items.length + ' 项收藏' : ''
    });
  },

  buildTabMap(cur) {
    const m = {};
    TABS.forEach((t) => { m[t.k] = t.k === cur; });
    return m;
  },

  onTab(e) {
    const t = e.currentTarget.dataset.k;
    this.setData({ tab: t, tabMap: this.buildTabMap(t) });
    this.load();
  },

  open(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    nav.go({ url: url });
  },

  async unfavorite(e) {
    const d = e.currentTarget.dataset;
    store.removeFavorite(d.type, d.id);
    this.load();
  }
});
