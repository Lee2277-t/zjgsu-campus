// pages/user/friends —— 我的同学
// 四个页签：同学（可看联系方式 + 解除）/ 申请（别人申请我 + 我发出的）/ 找同学 / 黑名单。
//
// 「加好友」「解除好友」「撤销申请」在这里都有落点，但本页**不是**它们的专属入口 ——
// 前两个的交互（留言弹窗、二次确认、文案）都在 utils/friend.js，
// 名片页、私信页用的是同一份实现，改一处三处一起生效。
//
// 「加好友」直接长在搜索结果的行上（不用先点进名片再点一次）；
// 「解除好友」长在同学名单的行上，和黑名单页签的「解除」同一个位置。
//
// 「我发出的申请」为什么和「收到的请求」合成一个页签：两个方向说的是同一件事
// （一段还没成立的申请），分成两个页签时用户经常只看到一个方向，
// 而「我申请了他、他一直没理我」正是最需要有个出口（撤销）的那一半。
//
// 这一版把「好友申请」整条链路重做过一遍，原因见下面三处注释，
// 对应的现象分别是：申请收不到、点了同意人没加上、得手动退出重进才刷新。
const userApi = require('../../../utils/user.js');
const nav = require('../../../utils/nav.js');
// 加好友 / 解除好友的交互与文案，三个落点共用（见该文件头注释）
const friend = require('../utils/friend.js');
// 提示统一走反馈层：裸调 wx.showToast 会被同一时刻的 Loading 抹掉，也会被键盘挡住
const feedback = require('../../../utils/feedback.js');
// 好友列表里的搜索和「找同学」共用同一个匹配内核：打错一个字也找得到，
// 两处的判定口径一致，用户不会觉得「同样是搜人，怎么一个行一个不行」
const searchCore = require('../../../utils/search.js');
// 同学名单分页。这个页每 6 秒轮询一次，分页必须用 keep 而不是 reset ——
// 否则用户正翻到第 3 页，一次后台刷新就把他弹回顶部了（见 applyFriendFilter）
const pager = require('../../../utils/pager.js');

// WXML 的 {{}} 表达式里不能调用函数（连 Page 里定义的方法也不行），
// 所以头像首字、联系方式标签这些都得先在 JS 里算好，模板只负责展示。
function decorate(f) {
  const name = f.nickName || '';
  return Object.assign({}, f, {
    avatarText: name ? name.charAt(0) : '同',
    contactText: userApi.CONTACT_LABEL[f.contactType] || '联系方式'
  });
}

// 轮询间隔：申请是别人发起的，小程序没有推送通道，只能定时问一次。
// 6 秒是「够及时又不烧云函数调用次数」的折中：页面在后台就停掉（见 onHide）。
const POLL_MS = 6000;

// 备注名上限，与云函数 friendAlias 的 slice(0,20) 对齐。
// 前端先截一刀只是因为「打了 40 个字、保存完只剩 20 个」比「当场就截断」更让人意外
const ALIAS_MAX = 20;

// 搜索结果那一行右侧该显示什么，取决于当前关系：
//   已经是同学     → 「已是同学」（不给按钮：点下去只会收到一句「你们已经是好友啦」）
//   我已经申请过   → 「已申请」（同理，重复申请服务端也会拒）
//   其余           → 「加好友」按钮
// 所以每次刷新都要把这两份集合算出来，和「同学」「申请」两个列表同一份口径。
// 直接用 decorate 再包一层：decorate 是幂等的（只补 avatarText / contactText），
// 重复调用不会把已经装饰过的行弄坏，所以刷新时可以无脑重算
function flagResult(f, friendSet, outSet) {
  return decorate(Object.assign({}, f, {
    isFriend: !!friendSet[f.openid],
    requested: !!outSet[f.openid]
  }));
}

Page({
  data: {
    tab: 'friends',
    friends: [],
    // 好友列表的本地筛选视图。「同学」页签渲染的是它，不是 friends 本身 ——
    // 搜索只是筛选已经拉回来的这一份，不联网（好友量级几百条，内存里过一遍是零成本）
    // ⚠️ 分页之后它是「已经展开的那一截」，要显示命中的总条数请用 friendTotal
    friendView: [],
    // 筛完之后的命中总数（不是已显示条数）。「在 80 位同学里找到 12 位」
    // 这句话里的 12 必须是它 —— 用 friendView.length 的话会随滚动变化
    friendTotal: 0,
    friendHasMore: false,
    // 只有确实分过页才显示「已经到底啦」：好友就 8 个人时不该多这一行
    friendDone: false,
    friendKeyword: '',
    requests: [],
    outgoing: [],
    blocks: [], // 我拉黑的人
    keyword: '',
    results: [],
    searching: false,
    // 找同学也支持「精准 / 模糊」：名字打错一个字就搜不到人，
    // 在找人这件事上最让人以为小程序坏了
    searchMode: 'fuzzy',
    // 刷新中：下拉 / 轮询都会短暂置起，给个可见的反馈，别让人以为卡住了
    refreshing: false,
    // 上一次刷新时刻，显示成「刚刚更新 HH:MM」
    updatedAt: '',
    // 云端连不上时如实说一声（之前静默失败，用户只看到列表一直是空的）
    offline: false
  },

  onLoad(options) {
    // 支持 ?tab=search / ?tab=requests 深链：从「私信 → 找同学/申请列表」跳过来时直接落到对应页签
    const t = options && options.tab;
    if (t === 'friends' || t === 'requests' || t === 'search' || t === 'blocked') {
      this.setData({ tab: t });
    }
  },

  onShow() {
    this._hidden = false;
    this.reloadAll();
    this.startPoll();
  },

  onHide() {
    // 页面压到后面就别再烧云函数调用次数：回前台（onShow）会立刻重拉一次 + 重新开始轮询
    this._hidden = true;
    this.stopPoll();
  },

  onUnload() {
    this.stopPoll();
  },

  onPullDownRefresh() {
    this.reloadAll().then(() => wx.stopPullDownRefresh());
  },

  // 轮询：别人发给我的申请不会自己冒出来，停在页面上就只能等下一次进页面。
  // 之前完全没有轮询，用户看到的就是「对方说发了，我这儿一直空白」。
  startPoll() {
    this.stopPoll();
    this._poll = setInterval(() => {
      // 页面已经不在前台就别浪费调用次数
      if (this._hidden) return;
      this.reloadAll(true);
    }, POLL_MS);
  },

  stopPoll() {
    if (this._poll) {
      clearInterval(this._poll);
      this._poll = null;
    }
  },

  // silent = 轮询触发的刷新：不弹「刷新中」，只有用户主动下拉才弹
  reloadAll(silent) {
    if (this._reloading) return Promise.resolve();
    this._reloading = true;
    if (!silent) this.setData({ refreshing: true });
    // 先用上一次名单把页面铺出来，云端刷新回来再覆盖；不再每次进页都先等一圈网络。
    if (!this.data.friends.length) {
      const cached = userApi.cachedFriends();
      if (cached.length) {
        this.setData({ friends: cached.map(decorate) });
        this.applyFriendFilter();
      }
    }

    const jobs = [
      userApi.listFriends().then((list) => {
        const rows = list || [];
        this._friendSet = {};
        rows.forEach((f) => { if (f.openid) this._friendSet[f.openid] = true; });
        this.setData({ friends: rows.map((f) => decorate(f)) });
        // 好友一变，筛选结果也要跟着重算（否则搜索框里还写着词、列表却是旧的一份）
        this.applyFriendFilter();
      }),
      // 请求和同学列表一起拉：同意成功之后要「申请消失 + 新同学出现」同时发生
      userApi.listRequests().then((list) => {
        this.setData({ requests: (list || []).map((f) => decorate(f)) });
      }),
      userApi.listOutgoing().then((list) => {
        const rows = list || [];
        this._outSet = {};
        rows.forEach((o) => { if (o.toOpenid) this._outSet[o.toOpenid] = true; });
        this.setData({ outgoing: rows.map((o) => decorate(o)) });
      }),
      userApi.listBlocks().then((list) => {
        const rows = list || [];
        // 黑名单也存一份集合：同学名单那一列要据此标「已拉黑」——
        // 不标的话，用户会以为「是同学」就等于「能互相看到联系方式」，
        // 而拉黑之后这两件事其实已经不一致了
        this._blockSet = {};
        rows.forEach((b) => { if (b.openid) this._blockSet[b.openid] = true; });
        this.setData({ blocks: rows.map((b) => decorate(b)) });
        this.decorateBlocks();
      })
    ];
    if (this.data.keyword) jobs.push(this.doSearch());

    return Promise.all(jobs).then(() => {
      // 两份集合都到位了，把搜索结果那几行和同学名单的状态重算一遍 ——
      // 谁先回来是不确定的（doSearch 也可能比 listFriends 先回），
      // 所以标记一律在「全部完成之后」统一算一次，不在各自的 then 里算
      this.applyFriendFilter();
      this.decorateBlocks();
      if (this.data.results.length) {
        this.setData({ results: this.flagResults(this.data.results) });
      }
      const d = new Date();
      const p = (n) => (n < 10 ? '0' + n : '' + n);
      this.setData({
        refreshing: false,
        updatedAt: p(d.getHours()) + ':' + p(d.getMinutes()),
        // 云端不可用时 listFriends / listRequests 都会回落到本机缓存，
        // 这里没法分辨「真的没有」和「拉不到」，所以只在一条都没有时给个软提示
        offline: this.data.friends.length === 0 && this.data.requests.length === 0
      });
    }).catch(() => {
      this.setData({ refreshing: false });
    }).then(() => {
      this._reloading = false;
    });
  },

  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab });
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  /* ---------------- 好友列表内搜索 ---------------- */

  // 好友多了以后，一屏一屏往下翻着找人是很折磨人的事。
  // 这里只筛「已经拉回来的好友」，不发请求 —— 好友量和联系人一样是几十上百的量级，
  // 本地过一遍毫无压力，且断网也能用（云端那份拉不到时列表还有缓存）
  // 搜的时候页码必须归零：搜「张」只剩 4 个结果，却还按上一次的
  // 「已经展开到第 3 页」去切，界面会直接显示全部 4 条、底部写着加载中
  onFriendKeyword(e) {
    this.setData({ friendKeyword: e.detail.value });
    this.applyFriendFilter(true);
  },

  clearFriendKeyword() {
    this.setData({ friendKeyword: '' });
    this.applyFriendFilter(true);
  },

  // 昵称、学院、签名、联系方式都算命中项：同学找人多半记得其中一样。
  // 主字段是昵称（只有它享受「打错字也认」的放宽），其余字段按「包含」认，
  // 否则搜一个「计算机」会把整个学院的人全捞出来，等于没搜
  //
  // resetPage = true 表示「筛选条件变了」，页码归零（见 onFriendKeyword）。
  // 默认 false：这个页每 6 秒轮询刷新一次数据，那种刷新必须保留用户已经
  // 展开到第几页，否则他正在翻名单时被后台刷新弹回顶部 —— 分页就成了添乱。
  applyFriendFilter(resetPage) {
    // 顺手补上「已拉黑」标记。放在这里而不是 decorate 里：decorate 是
    // 「一个人的资料长什么样」（跟关系无关），拉黑是关系，两件事分开算，
    // 才能保证「刷新任何一份数据之后重算一次就一致」
    const blockSet = this._blockSet || {};
    const kw = String(this.data.friendKeyword || '').trim().toLowerCase();
    const all = (this.data.friends || []).map((f) => Object.assign({}, f, {
      blocked: !!blockSet[f.openid]
    }));
    if (!kw) {
      this.setData(this.friendPageData(this.friendPager(all, resetPage)));
      return;
    }
    const hit = [];
    all.forEach((f) => {
      const lv = searchCore.matchFields(
        [f.nickName, f.college, f.motto, f.contactValue, f.contactText],
        kw
      );
      // 主字段没中时退一步：昵称 / 学院 / 签名 / 联系方式任一「包含」也算搜到
      let level = lv;
      if (level < 0) {
        const bag = [f.nickName, f.college, f.motto, f.contactValue, f.contactText]
          .map((x) => String(x || '').toLowerCase()).join(' ');
        if (kw && bag.indexOf(kw) >= 0) level = searchCore.MATCH_RANK.contain;
      }
      if (level >= 0) hit.push({ f: f, lv: level });
    });
    // 命中越准的越靠前：名字完全对得上的排第一
    hit.sort((a, b) => a.lv - b.lv);
    this.setData(this.friendPageData(this.friendPager(hit.map((x) => x.f), resetPage)));
  },

  // 分页器实例。必须挂在 this 上，不能挂到 Page() 那个对象字面量上 ——
  // 那是所有页面实例共享的原型，状态放上去会跨进页面残留。
  pg() {
    return this._pager || (this._pager = pager.create());
  },

  // 筛选后的名单交给分页器。resetPage 决定归零还是保留展开进度
  // （为什么默认是保留，见 applyFriendFilter 的注释）
  friendPager(list, resetPage) {
    return resetPage ? this.pg().reset(list) : this.pg().keep(list);
  },

  // 分页结果落到 data 上。两条分支（没搜 / 搜了）和触底都走这一个出口，
  // 免得一处加了字段、另一处漏掉，出现「搜完之后底部状态不更新」
  friendPageData(view) {
    return {
      friendView: view.list,
      friendTotal: view.total,
      friendHasMore: view.hasMore,
      // 只有确实分过页才显示「已经到底啦」：好友就 8 个人时不该多这一行
      friendDone: view.done
    };
  },

  // 触底只在「同学」这一档生效：另外三档（申请 / 找同学 / 黑名单）
  // 条数本来就少，加一排「加载更多」反而是噪音
  onReachBottom() {
    if (this.data.tab !== 'friends') return;
    if (!this.data.friendHasMore) return;
    const view = this.pg().more();
    // 到底了 pager 返回 null，直接退出。不退出的话最后一次触底会白跑一次
    // setData，界面上那行字会闪一下
    if (!view) return;
    this.setData(this.friendPageData(view));
  },

  // 黑名单那一列反过来标「也是同学」。
  // 为什么要标：解除拉黑和解除好友是两个不同的动作，而「拉黑过的人是不是还
  // 在我同学名单里」用户往往记不清 —— 不标的话，他会在黑名单里解除拉黑、
  // 然后奇怪「怎么他还能看到我的联系方式」，其实两人本来就是同学，只是被拉黑了
  decorateBlocks() {
    const fs = this._friendSet || {};
    this.setData({
      blocks: (this.data.blocks || []).map((b) => Object.assign({}, b, {
        isFriend: !!fs[b.openid]
      }))
    });
  },

  // 给搜索结果补上「我和他是什么关系」——「加好友」按钮该不该出现在这一行，
  // 靠的就是这两个标记（见 flagResult）。每处写一遍 map 的话，
  // 迟早出现「doSearch 算了标记、轮询刷新时忘了算」，按钮在那里一闪一闪
  flagResults(list) {
    const fs = this._friendSet || {};
    const os = this._outSet || {};
    return (list || []).map((f) => flagResult(f, fs, os));
  },

  doSearch() {
    const kw = this.data.keyword.trim();
    if (!kw) {
      this.setData({ results: [] });
      return Promise.resolve();
    }
    this.setData({ searching: true });
    return userApi.search(kw, this.data.searchMode === 'exact').then((list) => {
      this.setData({ results: this.flagResults(list), searching: false });
      if (!list || list.length === 0) {
        feedback.toast('没找到，换个昵称试试');
      }
    }).catch(() => {
      this.setData({ searching: false });
    });
  },

  // 切「精准 / 模糊」：名字要真的一样才算，还是打错字也认。
  // 切完立刻按新档位重搜一次，不然按钮看着点了没反应
  onSearchMode(e) {
    const m = e.currentTarget.dataset.m;
    if (m === this.data.searchMode) return;
    this.setData({ searchMode: m });
    if (String(this.data.keyword || '').trim()) this.doSearch();
    feedback.toast(m === 'exact' ? '只找名字完全一样的' : '打错字也能找到', { duration: 1500 });
  },

  // 好友头像加载失败：只把这一行的 avaErr 标记上，模板自动退回文字头像。
  onFriendAvatarError(e) {
    const openid = String((e.currentTarget.dataset && e.currentTarget.dataset.openid) || '');
    if (!openid) return;
    const friends = (this.data.friends || []).map((f) => (
      f.openid === openid ? Object.assign({}, f, { avaErr: true }) : f
    ));
    this.setData({ friends: friends });
    this.applyFriendFilter();
  },
  goCard(e) {
    const openid = e.currentTarget.dataset.openid;
    if (!openid) {
      feedback.toast('这位同学还没登记资料');
      return;
    }
    nav.go({ url: '/pages/user/card/card?openid=' + openid });
  },

  // 同意好友申请。
  //
  // 之前这里只要云函数返回就当成功（连「云端没响应」都被兜成 {ok:true}），
  // 于是「点了同意 → 提示已通过 → 申请还在、人也没加上」。现在：
  //   ① 先上锁，连点只处理一次；
  //   ② 只有云端明确回 ok:true 才撤掉这一行；
  //   ③ 成功后立刻重拉「同学 + 申请」两份列表，并切到同学页把新同学亮出来。
  onAccept(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this._busyId) return;
    const req = this.data.requests.filter((r) => r.id === id)[0];
    this._busyId = id;
    wx.showLoading({ title: '处理中', mask: true });
    userApi.friendAccept(id).then((r) => {
      wx.hideLoading();
      this._busyId = '';
      if (!r || r.ok === false) {
        // 不撤行、不谎报：申请还在那儿，用户可以再点一次
        feedback.toast((r && r.msg) || '通过失败，再点一次', { duration: 2500 });
        // 云端那条可能已经被别处处理掉了，顺手拉一次把状态对齐
        this.reloadAll(true);
        return;
      }
      // 乐观更新：先把这一行从待处理里拿掉，界面立刻有回应
      this.setData({ requests: this.data.requests.filter((x) => x.id !== id) });
      const nick = (r.friend && r.friend.nickName) || (req && req.nickName) || '这位同学';
      feedback.ok('已加为同学：' + nick, { duration: 2200 });
      // 云端已在一个事务里删掉申请 + 双向写关系，这里把两份列表都刷新一遍，
      // 「申请消失」和「新同学出现」同时发生，不需要退出重进
      this.reloadAll(true).then(() => {
        const found = this.data.friends.some((f) => f.openid === (r.friendOpenid || ''));
        if (found) this.setData({ tab: 'friends' });
      });
    }).catch(() => {
      wx.hideLoading();
      this._busyId = '';
      feedback.toast('操作失败，再试一次');
    });
  },

  onReject(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this._busyId) return;
    this._busyId = id;
    wx.showLoading({ title: '处理中', mask: true });
    userApi.friendReject(id).then((r) => {
      wx.hideLoading();
      this._busyId = '';
      if (!r || r.ok === false) {
        feedback.toast((r && r.msg) || '操作失败，再试一次');
        return;
      }
      this.setData({ requests: this.data.requests.filter((x) => x.id !== id) });
      feedback.toast('已忽略');
    }).catch(() => {
      wx.hideLoading();
      this._busyId = '';
      feedback.toast('操作失败，再试一次');
    });
  },

  onUnblock(e) {
    const openid = e.currentTarget.dataset.openid;
    if (!openid || this._friendBusy) return;
    wx.showModal({
      title: '解除拉黑',
      content: '解除后这名同学可以重新给你发请求，你也能发消息给他。',
      success: (res) => {
        if (!res.confirm) return;
        this._friendBusy = true;
        userApi.unblock(openid).then((r) => {
          this._friendBusy = false;
          // 云端失败时绝不先撤行再提示成功：那样用户会以为解开了，
          // 而对方其实仍然发不出消息，下一次尝试更费劲
          if (r && r.ok === false) {
            feedback.toast(r.msg || '没解除，再试一次');
            return;
          }
          feedback.ok('已解除');
          this.reloadAll(true);
        }).catch(() => {
          this._friendBusy = false;
          feedback.toast('没解除，再试一次');
        });
      }
    });
  },

  // 加好友：直接长在搜索结果那一行上。
  // 搜到人正是想加好友的那一刻，先点进名片再点一次按钮是白走一步 ——
  // 而这一步正是「找不到加好友在哪」的常见来源。
  // 动作本身和名片页共用 utils/friend.js（留言弹窗 + 文案），没有第二份实现
  onAddFriend(e) {
    const openid = e.currentTarget.dataset.openid;
    if (!openid || this._friendBusy) return;
    this._friendBusy = true;
    friend.ask(openid).then((r) => {
      this._friendBusy = false;
      if (!r || r.canceled || r.ok === false) return;
      // 立刻把这一行标成「已申请」，不等下一次轮询 —— 6 秒里按钮还在原地，
      // 用户会以为没点成功，然后点第二次（第二次反而会被服务端拒）
      const os = this._outSet || (this._outSet = {});
      os[openid] = true;
      this.setData({ results: this.flagResults(this.data.results) });
    });
  },

  // 解除好友：长在同学名单的行上（和黑名单页签的「解除」同一个位置），
  // 不另开「好友管理」页。二次确认里带对方名字、写清后果，见 utils/friend.js
  onRemoveFriend(e) {
    const ds = e.currentTarget.dataset;
    if (!ds.openid || this._friendBusy) return;
    this._friendBusy = true;
    friend.remove(ds.openid, ds.name || '').then((r) => {
      this._friendBusy = false;
      if (!r || r.canceled || r.ok === false) return;
      // 不许「先本地撕掉那一行」：整表重拉一次，同学名单、申请、搜索结果
      // 三处一起对齐。少刷一处就会出现「名单里没了，搜索里还写着已是同学」
      this.reloadAll(true);
    });
  },

  /* ---------------- 我发出的申请 ---------------- */

  // 撤销申请。没有这个出口的话，申请发出去之后界面只剩一句「已申请，等对方回应」，
  // 发错人了、觉得唐突了、想换句话重发，都只能干等对方处理。
  // 撤销会连 24 小时冷却一起清掉（冷却记在那条记录上），所以撤销之后能立刻重发
  onCancelRequest(e) {
    const ds = e.currentTarget.dataset;
    if (!ds.openid || this._friendBusy) return;
    wx.showModal({
      title: '撤销申请',
      content: '撤销后' + (ds.name ? '「' + ds.name + '」' : '对方') + '就不会再看到这条申请，你可以随时重新申请。',
      confirmText: '撤销',
      success: (res) => {
        if (!res.confirm) return;
        this._friendBusy = true;
        userApi.friendCancel(ds.id || '', ds.openid).then((r) => {
          this._friendBusy = false;
          if (!r || r.ok === false) {
            feedback.toast((r && r.msg) || '没撤回来，再试一次');
            return;
          }
          feedback.toast('已撤销');
          this.reloadAll(true);
        }).catch(() => {
          this._friendBusy = false;
          feedback.toast('没撤回来，再试一次');
        });
      }
    });
  },

  // 给同学设备注名。备注只写「我这一侧」的 friends 记录 ——
  // 一旦写进对方的 users 文档，全校都会看到我给他起的外号。
  // 标题里点明「只有你看得到」，否则没人敢给同学起名字
  onSetAlias(e) {
    const ds = e.currentTarget.dataset;
    if (!ds.openid || this._friendBusy) return;
    wx.showModal({
      title: '备注名（只有你看得到）',
      editable: true,
      placeholderText: '留空就恢复成 TA 自己的昵称',
      content: String(ds.alias || ''),
      success: (res) => {
        if (!res.confirm) return;
        // 先截断再提交：云函数也会截（slice(0,20)），但「打了 40 个字保存完只剩 20 个」
        // 比「当场就截断」更让人意外
        const val = String(res.content || '').trim().slice(0, ALIAS_MAX);
        this._friendBusy = true;
        userApi.friendAlias(ds.openid, val).then((r) => {
          this._friendBusy = false;
          if (!r || r.ok === false) {
            feedback.toast((r && r.msg) || '没保存，再试一次');
            return;
          }
          feedback.toast(val ? '已设置备注' : '已恢复原名');
          // 整表重拉：备注名到了服务端才会覆盖 nickName，本地改显示会与
          // 「搜索 / 名片页 / 私信标题」三处的口径不一致
          this.reloadAll(true);
        }).catch(() => {
          this._friendBusy = false;
          feedback.toast('没保存，再试一次');
        });
      }
    });
  },

  // 长按同学行：设置备注 / 解除好友。
  // 备注走长按而不占一行位置：解除好友已经在那行了，再塞一个「备注」就是每行三个控件，
  // 误触率明显上升 —— 而备注是低频、可反悔的动作，藏一层没有代价
  onLongPressFriend(e) {
    const ds = e.currentTarget.dataset;
    if (!ds.openid || this._friendBusy) return;
    const cur = String(ds.alias || '').trim();
    const items = [
      cur ? '改备注名（当前：' + cur + '）' : '设置备注名',
      '解除好友'
    ];
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        if (res.tapIndex === 0) this.onSetAlias(e);
        else if (res.tapIndex === 1) this.onRemoveFriend(e);
      }
    });
  },

  onEditProfile() {
    nav.go({ url: '/pages/user/profile/profile' });
  }
});
