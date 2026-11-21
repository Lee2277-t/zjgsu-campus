// sub/forum/hole/hole —— 匿名树洞（独立区域）
//
// 和主论坛的区别：
//   1. 只显示「树洞」板块的帖子，主论坛（全部/各板块筛选）永远不混入；
//   2. 在这里发帖强制匿名：昵称换成「匿名·晚风」这样的随机代号（按帖子取，每条不同），
//      头像留空，连选择的机会都不给；
//   3. 没有板块选择、没有课程关联、没有配图 —— 降低表达门槛，只留文字。
//
// 排序和主论坛共用 store.getPosts 的那一套，只有四种（见下面 SORT_OPTIONS），
// 和主论坛看到的排序方式保持一致。
//
// 举报也跟主论坛完全一样：匿名是保护作者不被认出来，不是免罪牌。
// 树洞内容反而更容易出事（吐槽、爆料、人身攻击），更不能没有举报口。
const store = require('../../../utils/store.js');
const { vibrateShort } = require('../../../utils/system.js');
const moderation = require('../../../utils/moderation.js');
const userApi = require('../../../utils/user.js');
const nav = require('../../../utils/nav.js');
// 所有面向用户的提示统一走反馈层（先收 Loading 再隔一帧弹 Toast）。
// 树洞以前和发帖页是同一个毛病：某些分支里提示会被随后的 hideLoading 抹掉，
// 点「投进树洞」之后页面安静得像没听见
const feedback = require('../../../utils/feedback.js');

// 树洞只有四种排序：没有「最多踩」 —— 树洞里已经没有踩这个动作了（见 onPostVote），
// 留着一个排不出来的档位只会让同学以为排序坏了
const SORT_OPTIONS = [
  { k: 'latest', icon: 'clock', label: '最新' },
  { k: 'hot', icon: 'flame', label: '热门' },
  { k: 'likes', icon: 'heart', label: '最多赞' },
  { k: 'comments', icon: 'message-circle', label: '最多评论' }
];

// 心情 → 底色。与 hole.wxss 里 .hole-page--xxx 的 --hole-base 一一对应，
// 缺了这个映射，导航栏就会停在默认白，深底页顶部出现一条白条
const MOOD_BG = {
  calm: '#0b2944',
  happy: '#5d3f1d',
  sad: '#171438',
  angry: '#3c1018',
  awkward: '#292638',
  tired: '#222a24'
};

// 心情 → 一句话开场。
// 以前这几句是写在 WXML 里的六层三元表达式（一行 300 多字，改一个字要在层层括号里找），
// 挪到 JS 之后，改文案不用再碰模板，也没机会因为漏一层括号让整页表达式失效
const MOOD_PROMPT = {
  calm: '把今天轻轻放下，慢慢呼吸。',
  happy: '把这份快乐说出来，会变成双份。',
  sad: '不用马上振作，先在这里停一会儿。',
  angry: '把火气留在这里，说完会轻一点。',
  awkward: '大家都尴尬过，说出来就不只你一个。',
  tired: '累的时候不用解释，靠一会儿就好。'
};

// 心情 → 三个快捷话题标签。
// ⚠️ 这些标签以前是纯装饰：WXML 里压根没绑事件，看稿的人以为是能点的按钮，
// 点了当然没反应。现在点一下会把标签写进正文（见 onKeyword）
const MOOD_TAGS = {
  calm: ['放松', '治愈', '晚安'],
  happy: ['分享', '好运', '哈哈'],
  sad: ['难过', '迷茫', '抱抱'],
  angry: ['吐槽', '气死', '无语'],
  awkward: ['社死', '脚趾抠地', '裂开'],
  tired: ['累麻了', '碎碎念', '求安慰']
};

const DEFAULT_MOOD = 'sad';
const CONTENT_MAX = 2000;

// 投递整条链路的总闸：等 openid（≤6s）+ 写云端（≤12s）串起来最坏也要十几秒，
// 没有上限的话按钮会长久停在「投放中…」，和坏了没区别
const HOLE_DEADLINE_MS = 14 * 1000;
// 「投放中」超过这么久还没复位就强制放开按钮（比总闸宽 5 秒，只接总闸哑火的情况）。
// 用时间戳而不是定时器判断：真机切后台 / 锁屏时 setTimeout 会被系统暂停，
// 靠定时器复位的话用户回来后按钮会永久失灵
const HOLE_STUCK_MS = 14 * 1000;
// 慢的时候换一句文案：一直挂着同一句「投放中」，和死机看着一模一样
const HOLE_SLOW_MS = 4 * 1000;
// 看门狗：总闸再宽 8 秒，兜「一句话都没给用户」的极端情况
const WATCHDOG_MS = HOLE_DEADLINE_MS + 8 * 1000;

Page({
  data: {
    posts: [],
    sort: 'latest', // latest | hot | likes | dislikes | comments
    sortOptions: SORT_OPTIONS,
    content: '',
    title: '',
    posting: false,
    loading: true,
    // 此刻的心情：只影响顶部氛围层，不发进帖子内容
    mood: DEFAULT_MOOD,
    // 心情对应的一句话与三个标签：由 JS 算好（见 MOOD_PROMPT / MOOD_TAGS），
    // WXML 里不再叠六层三元
    prompt: MOOD_PROMPT[DEFAULT_MOOD],
    tags: MOOD_TAGS[DEFAULT_MOOD],
    // 导航栏底色跟着心情走：以前 app-header 写死白色（或 dark 的 #11142e），
    // 和 .hole-page 的底色对不上，顶部就是一条明显断层。
    // 这里的值必须和 hole.wxss 里 --hole-base 保持一致
    navBg: MOOD_BG[DEFAULT_MOOD],
    // 恢复的是哪条树洞草稿：发出去之后好把它撤掉
    draftId: ''
  },

  // 进页面就接上上次没说完的话：树洞的话往往是一口气写的，
  // 被打断再进来面对空框，多半就不想说了
  onLoad() {
    const last = store.getDrafts().find((x) => x.type === 'hole');
    if (last) {
      this.setData({
        draftId: last.id,
        title: last.title || '',
        content: last.content || ''
      });
    }
  },

  onShow() {
    // 兜底：重新进页面时如果「投放中」还挂着（上次提交被中断 / 切后台被暂停），
    // 顺手复位。这个状态只影响按钮，留着就是「怎么点都没反应」
    if (this.data.posting) {
      this.setData({ posting: false });
      feedback.hideLoading();
      feedback.toast('上一条没投完，已复位，可以再试');
    }
    this.load();
  },

  // 离开页面时自动存草稿，不用记得点任何按钮
  autoSaveDraft() {
    if (this._published) return;
    const d = this.data;
    const title = String(d.title || '').trim();
    const content = String(d.content || '').trim();
    if (!title && !content) {
      if (d.draftId) store.removeDraft(d.draftId);
      return;
    }
    const saved = store.saveDraft({ type: 'hole', title: title, content: content });
    if (saved && saved.id && saved.id !== d.draftId) this.setData({ draftId: saved.id });
  },

  onHide() { this.autoSaveDraft(); },
  onUnload() { this.autoSaveDraft(); },

  load() {
    // 带上「我举报过没有」：举报完按钮要变成「已举报」，
    // 否则用户以为没点上，一遍遍地戳（服务端本来就会去重，但界面得说实话）
    const posts = store.getHolePosts(this.data.sort).map((p) =>
      Object.assign({}, p, { reported: store.hasReported(p.id) })
    );
    this.setData({ posts: posts, loading: false });
  },

  onSortPick(e) {
    const sort = String(e.currentTarget.dataset.s || '');
    if (!sort || sort === this.data.sort) return;
    this.setData({ sort: sort });
    this.load();
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  // 树洞里没有「踩」：这里能点的只有「抱抱」。
  // 之前和主论坛一样有赞踩两颗按钮，但树洞是匿名说真心话的地方，
  // 「被踩」的反馈只会让人后悔说出来了；数据层 toggleVote 保留 dislike，
  // 主论坛还用，树洞页只是不再给它入口
  onPostVote(e) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    const r = store.toggleVote(id, 'like');
    if (!r) return;
    // 树洞热门同理：点完只改这一张卡，不重新排序
    const posts = (this.data.posts || []).map((p) => (
      p.id === id ? Object.assign({}, p, {
        likes: r.likes, dislikes: r.dislikes, liked: r.liked, disliked: r.disliked
      }) : p
    ));
    this.setData({ posts: posts });
  },

  // 树洞三连：抱抱 / 递茶 / 摸摸头。
  // 三个可以同时给（抱完再递茶很正常），各记各的；再点一次同一个是收回。
  // 计数和「我点过没」都由 store 统一算，详情页读的是同一份 ——
  // 详情页点了抱抱，回到这里立刻是亮着的，不需要额外的同步代码
  onReact(e) {
    const id = String(e.currentTarget.dataset.id || '');
    const k = String(e.currentTarget.dataset.k || '');
    if (!id || !k) return;
    store.toggleReact(id, k);
    // 重新读一遍列表：计数和「我点过没」都由 store 算好，
    // 页面上写死的任何增量都会和它打架。title / content 是独立字段，不受影响
    this.load();
  },

  // 举报树洞贴：和主论坛走同一个云函数，原因、判定、自动处置规则全都一样。
  // 匿名的只是「作者是谁」，内容照样要守规矩；而且树洞内容更容易出事，更不能没有举报口
  onReport(e) {
    const id = String(e.currentTarget.dataset.id || '');
    const target = String(e.currentTarget.dataset.openid || '');
    if (!id) return;
    if (store.hasReported(id)) {
      feedback.toast('你已经举报过这条了');
      return;
    }
    if (!target) {
      feedback.toast('这条内容太老了，缺作者信息没法举报');
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
            // 举报已经落到服务端了，本地记一笔，按钮立刻变「已举报」
            store.markReported(id);
            // 云端当场判定处置动作，本地镜像跟着改，举报的人马上能看到结果
            if (r && r.action === 'hide') {
              store.setPostStatus(id, 'hidden');
            } else if (r && r.action === 'delete') {
              store.setPostStatus(id, 'deleted');
            }
            this.load();
            // 举报落到服务端就撤不回来了：这时候给一个不看屏幕也收得到的确认
            feedback.buzz();
            feedback.toast((r && r.msg) || '已提交');
          }
        });
      },
      fail: () => {}
    });
  },

  onTitle(e) {
    this.setData({ title: e.detail.value });
  },

  onContent(e) {
    this.setData({ content: e.detail.value });
  },

  // 点快捷话题标签：把 #标签 写进正文。
  //
  // 以前这些标签是「长得像按钮的装饰」—— WXML 上没绑任何事件，
  // 看着能点、点下去纹丝不动，是典型的「假按钮」。
  // 现在点一下就真的把标签塞进输入框，并且一定给个反馈：
  // 重复点了说「已经加过了」，正文写满了说「到上限了」，不会有任何一种情况是无声的。
  onKeyword(e) {
    const kw = String(e.currentTarget.dataset.k || '').trim();
    if (!kw) return;
    vibrateShort();
    const tag = '#' + kw;
    const cur = String(this.data.content || '');
    if (cur.indexOf(tag) >= 0) {
      feedback.toast('这个话题已经加过了');
      return;
    }
    // 正文到上限时不再往里塞，但要说清楚为什么不塞 —— 默默不处理就是又一次「点了没反应」
    if (cur.length >= CONTENT_MAX) {
      feedback.toast('正文到 ' + CONTENT_MAX + ' 字上限了');
      return;
    }
    // 已经有字且不以空白结尾时补一个空格，避免贴成一坨
    const needSpace = cur.length > 0 && !/\s$/.test(cur);
    const next = (cur + (needSpace ? ' ' : '') + tag + ' ').slice(0, CONTENT_MAX);
    this.setData({ content: next });
    feedback.toast('已加上 ' + tag);
  },

  // 投递：board 固定「树洞」，anonymous 固定 true。
  // 服务端（云函数 postAdd）照样过屏蔽词和官方内容安全接口，匿名不是免罪牌
  // 手指落下：记起点，抬手时用来判断这是不是一次点击（见 onSendTouchEnd）
  onSendTouchStart(e) {
    const t = (e.touches && e.touches[0]) || {};
    this._touch = { x: t.clientX || 0, y: t.clientY || 0, t: Date.now() };
  },

  // 手指抬起：tap 没来就补一次投递。
  // 「按下去按钮变深，然后什么都没有」—— 变色是渲染层的行为，
  // 跟 JS 有没有收到这一下点击完全是两回事，真机上 tap 偶发丢失就长这样
  onSendTouchEnd(e) {
    const s = this._touch;
    this._touch = null;
    if (!s) return;
    const t = (e.changedTouches && e.changedTouches[0]) || {};
    const moved = Math.abs((t.clientX || 0) - s.x) + Math.abs((t.clientY || 0) - s.y);
    if (moved > 40 || Date.now() - s.t > 1500) return;   // 滑动 / 长按不算（40 比 24 更稳，少漏点击）
    if (Date.now() - (this._tapAt || 0) < 700) return;   // tap 已经来过
    this._tapAt = Date.now();
    this.send();
  },

  async send() {
    this._tapAt = Date.now();
    console.log('[zjgsu:hole] send 被触发', this._tapAt);
    // 零依赖兜底：feedback 模块极端情况没加载成功时，至少让用户看到「点到了」，
    // 同时作为区分「tap 没进 JS」还是「提示被吞」的诊断标记
    try { if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: '收到，投递中', icon: 'none', duration: 600 }); } catch (e) {}
    // 轻震动：唯一不会被 Loading / 键盘 / 系统弹窗吞掉的反馈，
    // 同时是判断「点击有没有进 JS」的分界线
    if (feedback && feedback.buzz) { try { feedback.buzz(); } catch (e) {} }
    else { try { if (typeof wx !== 'undefined' && wx.vibrateShort) wx.vibrateShort({ type: 'light' }); } catch (e) {} }
    // 上一次卡住时按钮会静默失灵，必须给个说法；
    // 卡太久（多半是切后台时定时器被系统暂停了）就直接放开让他重发，
    // 判断依据是「上次点击过去了多久」而不是定时器，定时器在后台不会响
    if (this.data.posting) {
      const stuckMs = Date.now() - (this._sendAt || 0);
      if (stuckMs > HOLE_STUCK_MS) {
        this.setData({ posting: false });
        feedback.hideLoading();
      } else {
        feedback.toast('还在发上一条，稍等一下');
        return;
      }
    }
    this._sendAt = Date.now();
    const title = String(this.data.title || '').trim();
    const content = String(this.data.content || '').trim();
    if (!title && !content) {
      feedback.toast('想说什么就写下来吧');
      return;
    }
    // 树洞里的「加微信」也放行：私事约见面、找人帮忙，本来就要留联系方式
    if (!moderation.guardText(content, '树洞', store.HOLE_BOARD)) return;

    this.setData({ posting: true });
    // 点下去立刻给反馈：以前树洞这儿什么都没有，只有按钮文案悄悄变成「投放中…」，
    // 慢一点的时候用户根本不确定自己点没点上
    feedback.loading('投放中', false);
    const slowTimer = setTimeout(() => {
      if (feedback.isLoading()) feedback.loading('网络有点慢，还没投出去…', false);
    }, HOLE_SLOW_MS);
    const wd = feedback.watchdog({ ms: WATCHDOG_MS, msg: '投递这条卡太久了，先看看网络' });
    let r = null;
    let timedOut = false;
    try {
      const run = await feedback.run({
        task: store.addPost({
          board: store.HOLE_BOARD,
          title: title.slice(0, 60),
          content: content.slice(0, CONTENT_MAX),
          anonymous: true
        }),
        ms: HOLE_DEADLINE_MS,
        // 到点没回来：addPost 一开头就把内容写进本地了，所以这句是实话
        timeoutValue: { ok: false, saved: false, msg: '这次超时了，话已经留在本机' },
        timeoutMsg: '这次超时了，话已经留在本机'
      });
      r = run.value || null;
      timedOut = run.timedOut;
      console.log('[zjgsu:hole] run 结束', { timedOut: timedOut, ok: !!(r && r.ok), 耗时: Date.now() - (this._sendAt || 0) });
    } catch (e) {
      // 云函数超时/崩溃：按钮必须放开，输入框里的字也必须还在
      r = { ok: false, saved: false, msg: '网络好像不太稳，内容先存在本机了' };
    } finally {
      clearTimeout(slowTimer);
      wd.cancel();
      feedback.hideLoading();
      this.setData({ posting: false });
    }

    // 刷新一次：云端存不住时内容还在本机，列表里应该看得到自己刚写的那条
    this.load();

    if (timedOut) return;   // run() 已经把话说过了
    if (!r || r.ok === false) {
      await feedback.toast((r && r.msg) || '没发出去，换个说法试试');
      return;
    }
    this.setData({ title: '', content: '' });
    // 发出去了：这条草稿的使命结束了，别再留到下次进页面
    this._published = true;
    try {
      if (this.data.draftId) store.removeDraft(this.data.draftId);
    } catch (e) {}
    await feedback.ok('已投进树洞');
  },

  // 切心情：氛围层 CSS 自己过渡 720ms，这里只换状态；
  // wx.vibrateShort 是小程序里唯一能碰到的震动反馈（Web 版的 navigator.vibrate 用不了）
  onMood(e) {
    const mood = String(e.currentTarget.dataset.m || '');
    if (!mood || mood === this.data.mood) return;
    vibrateShort();
    // 导航栏底色同步换，不然切心情后顶部那一条会留在旧颜色上；
    // 一句话开场和三个快捷话题也一并跟上（以前这两处在 WXML 里，改心情要改三处才对齐）
    this.setData({
      mood: mood,
      navBg: MOOD_BG[mood] || MOOD_BG[DEFAULT_MOOD],
      prompt: MOOD_PROMPT[mood] || MOOD_PROMPT[DEFAULT_MOOD],
      tags: MOOD_TAGS[mood] || MOOD_TAGS[DEFAULT_MOOD]
    });
  },

  goDetail(e) {
    nav.go({ url: '/sub/forum/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  onPullDownRefresh() {
    this.load();
    // eslint-disable-next-line no-undef
    wx.stopPullDownRefresh();
  },

  onShareAppMessage() {
    return {
      title: '商砖小站 · 匿名树洞，说点不敢说的',
      path: '/sub/forum/hole/hole'
    };
  }
});
