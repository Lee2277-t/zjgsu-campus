// sub/forum/detail/detail.js
const store = require('../../../utils/store.js');
const moderation = require('../../../utils/moderation.js');
const userApi = require('../../../utils/user.js');
const unread = require('../../../utils/unread.js');
const upload = require('../../../utils/upload.js');
const feedback = require('../../../utils/feedback.js');
const nav = require('../../../utils/nav.js');
const report = require('../../../utils/report.js');
const config = require('../../../utils/config.js');

// 一条留言最多几张图。和云函数侧的 COMMENT_IMG_MAX 对齐 ——
// 前端多收一张，用户选完、传完才会被云端退回，白等一轮上传
const MAX_IMG = 3;

// 留言装饰（赞踩状态 / 举报状态 / 回复层级 / 两级树）统一走 store：
// WXML 的 {{}} 里调不了函数（写了整页都会崩），这些标记必须在数据层算好再交给模板。
// 以前这份函数写在本页里，加进来四个交互之后它成了公共出口 ——
// 留在页面里就没法被行为测试覆盖（scripts/test-comment-actions.cjs 直接跑 store 那份）
const decorate = (post, isMine, expanded, isMod, protectMap) => store.decorateComments(post, isMine, expanded, isMod, protectMap);

Page({
  data: {
    id: '',
    post: null,
    commentText: '',
    // 已选待发的图片（本地临时路径）。上传在点「发送」时才做，
    // 所以撤掉一张就是纯粹地从数组里拿走，没有任何云端残留要清理
    pendingImages: [],
    // 上限也交给模板：WXML 的 {{}} 里读不到模块常量，
    // 之前只能把「3」写死在提示里，改上限时必然漏掉一处
    maxImg: MAX_IMG,
    // 上传中：挡住重复提交，同时把发送按钮变成「上传中」的样子
    uploading: false,
    postImages: [], // 已去掉云存储前缀的 fileID，直接给 image src 用
    isMine: false,
    // 审核员身份以云端 whoami 为准：决定详情页里是否出现「管理员删除」。
    // 本地名单只做首屏提前量，云端返回后再覆盖 —— 防止本地配置过期时把按钮露给非审核员
    isMod: false,
    // 审核员在详情页直接操作这条帖子：保护 / 置顶
    postGuarded: false,
    pinned: false,
    // 帖子作者头像加载失败：置 true 后退回文字头像（同一个道理，见 decorateComments）。
    // 每次 load 都要复位 —— 头像修好了、或者换了一条帖子，不能再挂着上一轮的失败标记
    postAvatarFailed: false,
    // 收藏和私信作者都要靠数据表达：模板里写不了函数
    favorited: false,
    // 有多少人看过（去重后的人数，云端算、不含作者）。
    // 它不光是给读者看的数字 —— 举报下架门槛也按这个数分档，
    // 所以详情页打开时必须上报一次（见 onLoad 的 contentView）。
    // 存的是**格式化好的文案**（'' = 不显示），不是原始数字：门槛判断放在 JS 里，
    // wxml 只认「有没有字」，免得模板和 JS 各写一遍同一个条件
    viewsText: '',
    canChat: false,
    // 首屏解析帖子前先显示加载态；大量留言的帖子不会让页面看起来卡死
    loading: true,
    // 内容被自动删除后：本地那份也跟着没，页面得给个说得清的收尾，不能继续挂着旧内容
    gone: false,
    // 按 id 压根没取到内容（被删/下架不是自己的/链接失效）。
    // 上一版这里什么都不做，页面就是一片空白、按钮也全无响应，用户只会以为程序坏了
    missing: false,
    // 哪些留言的二级回复被展开过：{ 留言id: true }。
    // 放在页面里而不是写回存储 —— 这是纯展示状态，换一种展开方式不该留下脏数据
    expanded: {},
    // 正在回复谁（null = 普通留言）。底栏据此变成「回复 @某某」并多一个取消入口
    replyTo: null,
    // 一条留言默认露几条二级回复。从数据层取而不是在模板里写死 3 ——
    // 改了常量模板跟不上，就会出现「明明还有回复，折叠按钮上写着 0」
    replyPreview: store.REPLY_PREVIEW
  },

  onLoad(options) {
    this.setData({ id: options.id, loading: true });
    this._skipShowLoad = true;
    // 先让页面渲染出加载态，再解析帖子与留言；首屏不会卡在 JS 同步执行里
    const run = () => this.load();
    if (wx.nextTick) wx.nextTick(run);
    else setTimeout(run, 0);
    // 审核员直删入口只认云端身份。本地名单先亮一下，whoami 回来后以云端结果为准；
    // 真正的权限仍在云函数 delContent 里复核，按钮显隐不是权限边界。
    if (userApi.isModerator()) this.setData({ isMod: true });
    userApi.whoami().then((me) => {
      if (me && typeof me.isMod === 'boolean') {
        this.setData({ isMod: !!me.isMod }, () => {
          if (this.data.isMod) this.loadModerationState();
        });
      }
    }).catch(() => {});
    // 上报一次浏览，顺手把「几个人看过」显示出来。
    //
    // 只在这里调、不在 onShow 里调：同一个人的重复打开服务端会去重，
    // 但每次 onShow 都发一次请求纯属浪费（从留言页返回也会触发 onShow）。
    // 失败静默 —— 记浏览失败不该影响看内容
    userApi.contentView('post', this.data.id).then((r) => {
      // 低于门槛不显示：一条内容写「3 人看过」，读者读到的不是「这条没人看」，
      // 而是「这个平台没人」。门槛定义在 config.VIEW_SHOW_MIN，三个详情页共用
      const v = Number(r && r.views) || 0;
      if (v >= config.VIEW_SHOW_MIN) this.setData({ viewsText: v + ' 人看过' });
    }).catch(() => {});
  },

  onShow() {
    if (this._skipShowLoad) {
      this._skipShowLoad = false;
      return;
    }
    this.load();
  },

  onPageScroll(e) {
    this._scrollTop = Math.max(0, Number(e && e.scrollTop) || 0);
  },

  // 与下拉刷新共用同一套刷新逻辑，解决部分机型手势无法触发的问题。
  manualRefresh() {
    this.load();
    this.syncComments(true).catch(() => {});
  },

  backTop() {
    wx.pageScrollTo({ scrollTop: 0, duration: 280 });
  },

  // 长按帖子/评论直接复制。user-select 提供系统选择菜单，
  // 这里再给一层兜底：部分机型上父级点击手势会吞掉长按选择事件。
  copyText(text) {
    const t = String(text || '').trim();
    if (!t) return;
    wx.setClipboardData({ data: t, success: () => feedback.toast('已复制') });
  },
  onCopyPostText() {
    const p = this.data.post || {};
    const text = [p.title, p.content].filter(Boolean).join('\n');
    this.copyText(text);
  },
  onCopyCommentText(e) {
    const id = String(e.currentTarget.dataset.id || '');
    const p = this.data.post || {};
    const hit = (p.comments || []).find((c) => c.id === id);
    this.copyText(hit && hit.content);
  },

  // 详情页审核操作：一次拉回全部保护记录，帖子 + 当前可见评论一起标记。
  loadModerationState() {
    if (!this.data.isMod || !this.data.id) return Promise.resolve();
    return userApi.protectList().then((r) => {
      const map = {};
      ((r && r.list) || []).forEach((x) => {
        map[String(x.targetType || 'post') + '_' + String(x.targetId || '')] = true;
      });
      this._protectMap = map;
      const post = store.getPostById(this.data.id);
      if (!post) return;
      this.setData({
        postGuarded: !!map['post_' + post.id],
        post: decorate(post, store.isMinePost(post), this.data.expanded, this.data.isMod, map)
      });
    }).catch(() => {});
  },

  onTogglePostProtect() {
    if (!this.data.isMod || !this.data.id) return;
    const on = !this.data.postGuarded;
    feedback.loading(on ? '保护中' : '处理中', true);
    userApi.protectSet('post', this.data.id, on, '').then((r) => {
      feedback.hideLoading();
      if (!r || r.ok === false) {
        feedback.toast((r && r.msg) || '操作失败');
        return;
      }
      this.setData({ postGuarded: on });
      feedback.toast(on ? '已保护这条帖子' : '已取消保护');
    }).catch(() => {
      feedback.hideLoading();
      feedback.toast('网络异常');
    });
  },

  onTogglePostPin() {
    if (!this.data.isMod || !this.data.id) return;
    const on = !this.data.pinned;
    feedback.loading(on ? '置顶中' : '处理中', true);
    store.setPostPinned(this.data.id, on, 0).then((r) => {
      feedback.hideLoading();
      if (!r || r.ok === false) {
        feedback.toast((r && r.msg) || '操作失败');
        return;
      }
      this.setData({ pinned: on });
      feedback.toast(on ? '已置顶' : '已取消置顶');
    }).catch(() => {
      feedback.hideLoading();
      feedback.toast('网络异常');
    });
  },

  onToggleCommentProtect(e) {
    if (!this.data.isMod) return;
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    const list = (this.data.post || {}).comments || [];
    const hit = list.find((c) => c.id === id);
    const on = !(hit && hit.protected);
    feedback.loading(on ? '保护中' : '处理中', true);
    userApi.protectSet('comment', id, on, '').then((r) => {
      feedback.hideLoading();
      if (!r || r.ok === false) {
        feedback.toast((r && r.msg) || '操作失败');
        return;
      }
      const map = Object.assign({}, this._protectMap || {});
      const key = 'comment_' + id;
      if (on) map[key] = true; else delete map[key];
      this._protectMap = map;
      const post = store.getPostById(this.data.id);
      if (!post) return;
      this.setData({ post: decorate(post, store.isMinePost(post), this.data.expanded, true, map) });
      feedback.toast(on ? '已保护这条评论' : '已取消保护');
    }).catch(() => {
      feedback.hideLoading();
      feedback.toast('网络异常');
    });
  },

  onPullDownRefresh() {
    // 详情页也要能手动刷新：评论是别人随时会追加的内容，
    // 30 秒节流只能挡住重复请求，不能要求用户退出去再点进来。
    // 先占住节流时间，避免 load() 再发一次普通评论请求；下面 force 会统一拉一次。
    this._cmtAt = Date.now();
    this.load();
    const done = () => {
      try { wx.stopPullDownRefresh(); } catch (e) { /* 基础库不支持时忽略 */ }
    };
    if (this.data.id) this.syncComments(true).then(done).catch(done);
    else done();
  },

  load() {
    const post = store.getPostById(this.data.id);
    if (post) {
      // 归属判定统一走 store.isMinePost（身份字段 + 老帖昵称兜底）
      const isMine = store.isMinePost(post);
      this.setData({
        post: decorate(post, isMine, this.data.expanded, this.data.isMod, this._protectMap),
        postGuarded: !!(this._protectMap && this._protectMap['post_' + post.id]),
        pinned: !!post.pinned,
        // 云存储 fileID 本身就能当 image 的 src 用
        postImages: post.images || [],
        isMine: isMine,
        postAvatarFailed: false,
        // 树洞帖没有「踩」：点赞在这页叫「抱抱」，按钮文案和数量含义随板块变
        isHole: post.board === '树洞',
        favorited: store.isFavorited('post', post.id),
        loading: false,
    // 只有不是自己的帖子才能「打招呼」，自己跟自己聊没意义
    canChat: !isMine && !!post.authorOpenid,
    // 「恢复展示」只有作者能点（云函数会拦，别人点了也只有一句提示）。
    // 但下架之后「举报」必须留给所有人 —— 这是第 4、5 票唯一进得去的口子
    canRestore: isMine
  });
      // 信息墙的标题栏应该叫主题，不然用户点进来以为走错页了
      wx.setNavigationBarTitle({ title: post.kind === 'topic' ? (post.board + ' · 信息墙') : post.board });
      // 树洞详情页是深底：系统状态栏（时间 / 电量）默认黑字，压在深底上看不清。
      // navigationBarTextStyle 写在 json 里是静态的（这一页深浅两种都有，写死必有一边错），
      // 只能运行时按当前帖子切换。自定义导航下这条 API 在部分机型会被忽略，
      // 忽略也只是维持默认色，不影响功能，所以失败静默。
      try {
        wx.setNavigationBarColor({
          frontColor: this.data.isHole ? '#ffffff' : '#000000',
          backgroundColor: this.data.isHole ? '#171438' : '#f5f7fa'
        });
      } catch (e) { /* 不支持就算了 */ }

      // 进详情页 = 这些留言我看过了：把自己的帖子那条已读水位推到当前条数，
      // 「我的」页里这条的红点随之消失（水位机制见 utils/unread.js）。
      // 只记自己的帖子 —— 那张水位表只为「我的帖子有没有人回」服务，
      // 逛别人的帖子也写一笔的话，这张表会随着浏览记录无限长下去。
      // load() 在 onShow 里也会跑，所以从别的页面回来时会自动重新对齐水位。
      if (isMine) {
        unread.markAllSeenFor(post);
        // 帖子红点清了，通知中心里同一帖的回复通知也要一起清；
        // 否则用户从「我的帖子」看完，回到「我的」还看到消息通知红点。
        userApi.notifyReadByTarget(post.id).catch(() => {});
        // tabBar 上那枚汇总红点也跟着改小：从「我的」列表点进来是最常见的路径，
        // 不清的话退回去还亮着，用户会以为没清掉
        unread.refreshBadge();
      }
      // 留言单独拉一次：帖子文档里已经不带留言了（见云函数 COL_POST_COMMENTS），
      // 本地这份是「上次打开时看到的」，别人这段时间发的新回复要靠它对齐
      this.syncComments();
      if (this.data.isMod) this.loadModerationState();
      return;
    }
    // 帖子取不到（被删 / 被下架且不是自己 / id 失效）时，不能让页面停在空白：
    // 正文空着、点赞收藏点了也没反应，看着就是程序坏了。这里必须给一句说清的话和一个出口
    this.setData({ gone: false, missing: true, loading: false });
  },

  // 从云端拉这一帖的留言，写回本地缓存后重绘。
  //
  // 为什么不在 onLoad 里只拉一次：onShow 在「从别处返回」时也会跑，
  // 而从别人主页回来正好是最需要看到新回复的时刻。但也不能每次都拉 ——
  // 30 秒的窗口足够挡住「返回又进去」的反复点击，又不至于让人等太久才看到新留言
  syncComments(force) {
    const now = Date.now();
    if (!force && this._cmtAt && now - this._cmtAt < 30000) return Promise.resolve();
    this._cmtAt = now;
    return userApi.commentList(this.data.id).then((r) => {
      // 拉失败（断网 / 云函数还是旧版）：留着本地那份，绝不清空 ——
      // 清空等于告诉用户「这条帖子没人留言」，而我们知道那不是真的
      if (!r || r.ok === false) return;
      store.applyCloudComments(this.data.id, r.comments || [], r.commentCount);
      const post = store.getPostById(this.data.id);
      if (!post) return;
      const mine = store.isMinePost(post);
      this.setData({ post: decorate(post, mine, this.data.expanded, this.data.isMod, this._protectMap) });
      // 云端的 commentCount 可能比本机旧值大：此时“进过详情”才算把新回复看过。
      // 如果只在 load() 开头按旧值推进水位，新拉到的几条会永远算未读。
      if (mine) {
        unread.markAllSeenFor(post);
        userApi.notifyReadByTarget(post.id)
          .then(() => unread.refreshBadge(true))
          .catch(() => unread.refreshBadge(true));
      }
    }).catch(() => {});
  },

  onFavorite() {
    const p = this.data.post || {};
    const r = store.toggleFavorite({ type: 'post', id: p.id, title: p.title || '' });
    if (!r.ok) return;
    this.setData({ favorited: !!r.favorited });
    wx.showToast({ title: r.favorited ? '已收藏' : '已取消收藏', icon: 'none' });
  },

  // vote-card 投出一票后回到这里：本地落库 + 刷新界面。
  // 组件只负责选和提交，记名/防重/截止判断都在 store.castVote 里
  onVoteCast(e) {
    const ids = (e.detail && e.detail.optionIds) || [];
    const r = store.castVote(this.data.id, ids);
    if (!r.ok) {
      wx.showToast({ title: r.msg || '投票没成功', icon: 'none' });
      this.load(); // 就地刷新：把「已结束 / 已投过」的真实状态摆回界面
      return;
    }
    this.load();
    wx.showToast({ title: '已投票', icon: 'success' });
  },

  goChat() {
    const p = this.data.post || {};
    if (!p.authorOpenid) {
      wx.showToast({ title: '这位同学还没有身份信息', icon: 'none' });
      return;
    }
    nav.go({
      url: '/pages/user/chat/chat?peer=' + p.authorOpenid + '&name=' + (p.author || '这位同学')
    });
  },

  onComment(e) {
    this.setData({ commentText: e.detail.value });
  },

  /* ---------------- 留言配图 ----------------
     信息墙最常见的留言是「群二维码 + 一句说明」—— 只让打字，这条信息根本传不出去。
     图片和文字一样走云函数（白名单、词表、频率闸都在那边），前端的活是
     「选 → 预览 → 上传 → 带着 fileID 一起提交」。 */

  // 选待发图片。上限和云端一致，选完立刻在后台预热压缩：
  // 从「选图」到「打完字点发送」通常有十几秒，压图正好在这段时间里做完
  chooseImages() {
    if (this.data.uploading) return;
    const left = MAX_IMG - (this.data.pendingImages || []).length;
    if (left <= 0) {
      feedback.toast('一条留言最多 ' + MAX_IMG + ' 张图');
      return;
    }
    upload.pickImages(left).then((r) => {
      if (!r || !r.ok) {
        // 用户自己退出相册不算失败 —— 弹一句「选图没成功」只会莫名其妙
        if (r && !r.canceled) feedback.toast((r && r.msg) || '选图没成功');
        return;
      }
      const next = (this.data.pendingImages || []).concat(r.files).slice(0, MAX_IMG);
      this.setData({ pendingImages: next });
      upload.prewarm(r.files);
    });
  },

  onRemovePending(e) {
    const i = Number(e.currentTarget.dataset.idx);
    const list = (this.data.pendingImages || []).slice();
    if (i < 0 || i >= list.length) return;
    list.splice(i, 1);
    this.setData({ pendingImages: list });
  },

  // 预览还没发出去的图：直接用本地临时路径，不用等上传
  previewPending(e) {
    const list = this.data.pendingImages || [];
    if (!list.length) return;
    const i = Number(e.currentTarget.dataset.idx) || 0;
    wx.previewImage({ current: list[i] || list[0], urls: list });
  },

  // 预览留言里的图。
  //
  // 按 id 回查而不是按下标：留言现在是两层（一级 + 挂在下面的二级回复），
  // 模板里的下标是**树里的位置**，而原始数据是一份扁平数组 ——
  // 有回复的时候两者对不上号，按下标取会取到别人的图
  previewCommentImages(e) {
    const d = e.currentTarget.dataset;
    const list = ((this.data.post || {}).comments) || [];
    const c = list.filter((x) => x.id === String(d.id || ''))[0] || {};
    const imgs = Array.isArray(c.images) ? c.images : [];
    if (!imgs.length) return;
    const i = Number(d.i) || 0;
    wx.previewImage({ current: imgs[i] || imgs[0], urls: imgs });
  },

  // 发一条留言：文字和图片至少有一个。
  //
  // 顺序是「先上传、再提交」，不是反过来：图片没传上去就不该提交 ——
  // 纯图留言会变成一条空白留言；图文留言则「提交成功」却少几张图。
  // 两种都是「我以为发了、别人看不到」，比直接报错更难发现
  async sendComment() {
    // 文本发送没有上传阶段那么长，但连点两次仍会生成两条不同 id 的评论，
    // 服务端通知也会跟着两条。这里在请求完成前锁住，避免“手快发两次”。
    if (this._sending || this.data.uploading) return;
    this._sending = true;
    const text = this.data.commentText.trim();
    const files = (this.data.pendingImages || []).slice();
    if (!text && !files.length) {
      feedback.toast('说点什么，或者加一张图');
      this._sending = false;
      return;
    }
    // 文字先过一遍词表：能当场拦下的，就别浪费一轮上传。
    // （信息墙上的留言过的是「全局词表」：这里不带板块参数，
    //   因为留言是留给所有同学看的公开信息，跟发在哪个板块无关）
    if (text && !moderation.guardText(text, '评论')) {
      this._sending = false;
      return;
    }

    let imgs = [];
    if (files.length) {
      this.setData({ uploading: true });
      feedback.loading('上传图片', true);
      const r = await upload.uploadMany(files, { prefix: 'comment' });
      feedback.hideLoading();
      this.setData({ uploading: false });
      imgs = ((r && r.list) || []).filter(Boolean);
      if (!imgs.length) {
        // 一张都没上去：不提交，图还留在待发条里，用户可以直接重试
        feedback.toast('图片没传上去，检查网络后再试');
        this._sending = false;
        return;
      }
      if (imgs.length < files.length) {
        // 部分成功：能发的先发出去，但要说清少了几张
        feedback.toast('有 ' + (files.length - imgs.length) + ' 张没传上去，先发这几张');
      }
    }

    // 回复：把「挂在谁下面 / 回复的是谁」一起交给数据层。
    // 层级归一化（三级折回二级）由 store.replyTargetOf 与云函数各算一遍，
    // 乐观显示的那条和云端 return 回来的那条会长得一模一样
    const rt = this.data.replyTo || null;
    const res = store.addComment(this.data.id, text, imgs, rt ? {
      parentId: rt.id,
      replyToOpenid: rt.openid || '',
      replyToAuthor: rt.author || ''
    } : null);
    if (!res || !res.comment) {
      feedback.toast('这条内容已经不在了');
      this._sending = false;
      this.load();
      return;
    }
    // 自己评论自己的帖子不是“别人回了我”：立刻把这条帖子的水位推进到当前评论数，
    // 否则退回「我的帖子」时会亮一个由自己产生的小红点。
    const freshAfterComment = store.getPostById(this.data.id);
    if (freshAfterComment && store.isMinePost(freshAfterComment)) {
      unread.markAllSeenFor(freshAfterComment);
      unread.refreshBadge();
    }
    this.setData({ commentText: '', pendingImages: [], replyTo: null });
    // 回复发出去之后要把父留言的回复区摊开：
    // 不然用户刚发的那条被折进「展开 N 条回复」里，看着像没发出去
    if (rt) {
      const exp = Object.assign({}, this.data.expanded);
      const root = String(res.comment.parentId || rt.id);
      exp[root] = true;
      this.setData({ expanded: exp });
    }
    // 只重算留言区，不重跑整页 load。整页 load 会让「回复对象 / 展开状态」
    // 和滚动位置一起回到起点，正是“发完像卡住、必须刷新”的来源。
    this.refreshComments(true);

    // 云端那一步的结果回来，才知道真的成了没有：
    // 被词表驳回、或云端是旧版云函数把图吞了，都得说清楚 ——
    // 不能像以前那样无条件报一句「评论成功」
    if (res.done && res.done.then) {
      res.done.then((r) => {
        if (r && r.ok === false) {
          this.refreshComments(true); // 本地那条已经被撤掉了，界面得跟着对齐
          feedback.toast(r.msg || '留言没发出去');
          this._sending = false;
          return;
        }
        if (r && r.warn) {
          this.refreshComments(true); // 图被云端吞了，本地的图也一并撤掉
          feedback.toast(r.warn);
          this._sending = false;
          return;
        }
        // 云端回执是同一条评论的权威版本：再拉一次留言，合并别人的新回复。
        this.refreshComments(true);
        if (r && r.ok !== false) this.syncComments(true);
        // 自己回复自己的帖子时，旧版云函数可能已经给自己写过通知；
        // 这条回复成功后顺手把同一帖的通知标已读，避免回完帖还亮红点。
        if (r && r.ok !== false && this.data.isMine) {
          const fresh = store.getPostById(this.data.id);
          if (fresh) unread.markAllSeenFor(fresh);
          userApi.notifyReadByTarget(this.data.id)
            .then(() => unread.refreshBadge(true))
            .catch(() => unread.refreshBadge(true));
        }
        feedback.ok(((this.data.post || {}).kind === 'topic') ? '留言成功'
          : (rt ? '回复成功' : '评论成功'));
        this._sending = false;
      }).catch(() => {
        this._sending = false;
        feedback.toast('网络不太稳，评论可能只保存在本机');
      });
    } else {
      this._sending = false;
    }
  },

  /* ---------------- 回复某条留言 ---------------- */

  // 点「回复」：底栏换成「回复 @某某」，并把光标交给输入框。
  //
  // 不弹输入框而复用底栏：评论区已经有一个常驻输入栏了，再弹一层既遮住
  // 被回复的那条（用户会忘记自己在回什么），也多一次键盘起落的等待
  onReplyComment(e) {
    const id = e.currentTarget.dataset.id || '';
    if (!id) return;
    const list = (this.data.post || {}).comments || [];
    const target = list.find((c) => c.id === id);
    if (!target) return;
    // 未登录（身份还没拿到）也能写：云端身份来自平台注入，跟本地有没有 openid 无关。
    // 但「回复的是谁」要靠 openid 记录 —— 拿不到就退化成只挂层级，不拦人
    this.setData({
      replyTo: {
        id: target.id,
        // 挂在哪条下面：回复二级时的挂载点由数据层折回一级，这里传的是「被点的那条」
        author: String(target.author || '这位同学'),
        openid: String(target.authorOpenid || '')
      }
    });
  },

  onCancelReply() {
    if (!this.data.replyTo) return;
    this.setData({ replyTo: null });
  },

  // 展开 / 收起一条留言下面的二级回复
  onToggleReplies(e) {
    const id = e.currentTarget.dataset.id || '';
    if (!id) return;
    const exp = Object.assign({}, this.data.expanded);
    if (exp[id]) delete exp[id];
    else exp[id] = true;
    this.setData({ expanded: exp });
    this.refreshComments();
  },

  /* ---------------- 留言的赞 / 踩 ---------------- */

  // 赞踩一条留言。
  //
  // 三件事都在数据层（store.toggleCommentVote）里做完，页面只负责刷新和说话：
  //   ① 互斥：一个人一格，换边是覆盖不是并存；
  //   ② 可取消：再点同一边就是收回；
  //   ③ 防重复：350ms 内的第二下既不动数据也不发请求，计数又是「基线 + 我这一票」
  //      算出来的纯函数，连点一百下也只等于一票。
  //
  // 断网时本地先生效、云端没记上 —— 这时候要说一句，不然用户以为这一票进去了，
  // 而服务端恰恰是靠数人头得出计数的
  onCommentVote(e) {
    const id = e.currentTarget.dataset.id || '';
    const k = String(e.currentTarget.dataset.k || '');
    if (!id || (k !== 'like' && k !== 'dislike')) return;
    const r = store.toggleCommentVote(this.data.id, id, k);
    if (!r) {
      feedback.toast('这条留言已经不在了');
      this.refreshComments();
      return;
    }
    // 连点被闸吃掉：不动数据、也不提示（提示会变成刷屏，比没反应更吵）
    if (r.throttled) return;
    this.refreshComments();
    if (!r.done) return;
    r.done.then((res) => {
      if (!res) return;
      if (res.ok === false) {
        this.refreshComments(); // 被明确拒绝的话，数据层已经把本地那一下撤回来了
        // 断网不弹提示：本地那一下还在，弹「失败」会让人以为没点上
        if (!res.offline) {
          feedback.toast(res.msg || '这一下没记到云端');
          report.report('comment.vote', res.msg || 'commentVote rejected', { commentId: id, kind: k });
        }
        return;
      }
      // 云端数完人头给出权威计数：刷新界面，让本地数字对齐全校的数字
      this.refreshComments();
    }).catch(() => {});
  },

  // 只重算留言区。
  // 不用整页 load()：它会把「展开到哪一层」「正在回复谁」一起清掉，
  // 而这两样恰恰是刚点完赞/刚回复完最不该丢的东西
  refreshComments(keepScroll) {
    const post = store.getPostById(this.data.id);
    if (!post) {
      this.setData({ gone: false, missing: true, loading: false });
      return false;
    }
    this.setData({
      post: decorate(post, store.isMinePost(post), this.data.expanded, this.data.isMod, this._protectMap)
    });
    if (keepScroll && this._scrollTop > 0 && wx.nextTick) {
      const top = this._scrollTop;
      wx.nextTick(() => {
        try { wx.pageScrollTo({ scrollTop: top, duration: 0 }); } catch (e) {}
      });
    }
    return true;
  },

  // 删一条留言。
  //
  // 弹确认是因为误删太容易：手滑点到就少了一条别人还需要的群号。
  // 服务端会再认一遍权限（留言人本人 / 帖主 / 审核员），这里只是别让人白删。
  onRemoveComment(e) {
    const commentId = e.currentTarget.dataset.id || '';
    if (!commentId) return;
    const p = this.data.post || {};
    const target = (p.comments || []).find((c) => c.id === commentId) || {};
    const who = (p.kind === 'topic' && p.isMine) ? '这条主题是你发的，' : '';
    wx.showModal({
      title: '删掉这条留言？',
      content: who + '「' + String(target.content || '').slice(0, 30) + '」删掉后就找不回来了。',
      success: (res) => {
        if (!res.confirm) return;
        // 先撤本地：界面立刻少一条，不用等云端转一圈。
        // 二级回复跟着一起没（store 里逐层收），不留「回复 @某某」却找不到原话的孤儿
        store.removeComment(this.data.id, commentId);
        feedback.buzz();
        wx.showToast({ title: '已删除', icon: 'success' });
        this.refreshComments();
        // 云端那份撤不掉也得说清楚，别让人以为「删了就是删了」
        userApi.removeComment(this.data.id, commentId).then((r) => {
          if (r && r.ok === false) {
            wx.showToast({ title: r.msg || '没能同步到云端', icon: 'none' });
            this.refreshComments();
          }
        }).catch(() => {});
      }
    });
  },

  // 举报一条留言。
  //
  // 删留言这事儿以前只有三档人能干（留言的人自己 / 帖主 / 审核员），
  // 可运营是一个人，不可能天天盯着每条留言。所以这里把举报通道也开出来：
  // 凑够人数服务端直接删，不用谁亲手点。
  //
  // 举报是有去有回的一条流程，所以落库之后要记下**处理状态**
  // （pending 待核实 / confirmed 已处理 / rejected 未成立），
  // 界面上写「已举报·待核实」。只把按钮变灰的话，举报的人不知道有没有人管
  async onReportComment(e) {
    const commentId = e.currentTarget.dataset.id || '';
    if (!commentId) return;
    const post = this.data.post || {};
    const target = (post.comments || []).find((c) => c.id === commentId) || {};
    if (!target.id) return;
    if (store.hasReportedComment(post.id, commentId)) {
      // 已经举报过：把当前状态说给他听，而不是一句「举报过了」把他顶回去 ——
      // 他想知道的是「我那次举报后来怎么样了」
      const st = store.commentReportOf(post.id, commentId);
      wx.showToast({ title: store.commentReportLabel(st && st.status) || '你已经举报过这条了', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: moderation.REPORT_REASONS,
      success: (res) => {
        const reason = moderation.REPORT_REASONS[res.tapIndex];
        wx.showModal({
          title: '举报：' + reason,
          content: moderation.reportTip(reason),
          placeholderText: '例如：这个是校外培训机构的招生群',
          editable: true,
          confirmColor: '#d9534f',
          success: async (m) => {
            if (!m.confirm) return;
            const r = await userApi.reportComment(post.id, commentId, reason, (m.content || '').slice(0, 200));
            // 断网时云端一条没写 —— 这时候绝不能记「已举报」，
            // 更不能提示「已提交」：服务端靠多人举报凑数才自动删，
            // 用户以为算上了自己这一票，之后什么也不会发生
            if (r && r.degraded) {
              wx.showToast({ title: '网络不太顺，没提交上', icon: 'none' });
              return;
            }
            // 落地了就记一笔：按钮变成「已举报·待核实」（或当场处置掉的「已处理」）
            store.markCommentReport(post.id, commentId, reason, (r && r.status) || 'pending');
            // 服务端当场判定：凑够人数这条留言已经没了
            // —— 本地那份也得跟着撤，否则页面上还挂着一条全校都看不到的东西
            if (r && r.removed) store.removeComment(post.id, commentId);
            this.refreshComments();
            wx.showToast({ title: (r && r.msg) || '已提交', icon: 'none' });
          }
        });
      },
      fail: () => {}
    });
  },

  onLike() {
    store.toggleVote(this.data.id, 'like');
    this.load();
  },

  // 点踩：和点赞互斥（云端会强制换边），再点一次取消
  onDislike() {
    store.toggleVote(this.data.id, 'dislike');
    this.load();
  },

  // 树洞三连（抱抱 / 递茶 / 摸摸头）：和列表页共用 store 里同一份记录，
  // 所以两边的高亮和数字永远一致，不需要跨页面传参
  onReact(e) {
    const k = String(e.currentTarget.dataset.k || '');
    if (!k) return;
    store.toggleReact(this.data.id, k);
    this.load();
  },

  goBack() {
    wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/forum/list/list' }) });
  },

  previewImages(e) {
    const list = e.currentTarget.dataset.imgs || [];
    if (!list.length) return;
    wx.previewImage({ current: list[0], urls: list });
  },

  // 举报：选完原因补一句说明（可留空），提交后由服务端当场决定处置动作
  onReport() {
    const post = this.data.post;
    const target = (post && post.authorOpenid) || '';
    if (!target) {
      wx.showToast({ title: '无法识别作者', icon: 'none' });
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
            const r = await userApi.reportPost(target, reason, (m.content || '').slice(0, 200), post.id, 'post');
            // 断网时云端一条没写。先判掉它 —— 不然下面那句「已提交」就成了谎报，
            // 而这条举报本该参与服务端的「多人凑数自动处置」
            if (r && r.degraded) {
              wx.showToast({ title: '网络不太顺，没提交上', icon: 'none' });
              return;
            }
            // 云端当场判定处置动作，本地缓存要跟着改，举报的人马上就能看到结果：
            //   hide    → 下架（还能恢复）
            //   delete  → 限时内多人举报，内容已经删了，本地那份也必须清掉，
            //             否则手机上还挂着一条云端已经不存在的内容
            if (r && r.action === 'hide') {
              store.setPostStatus(post.id, 'hidden');
              this.load();
            } else if (r && r.action === 'delete') {
              // 云端已经把它标记成 deleted，本地那份必须一起标掉，
              // 不然页面上还挂着一条全校都看不见的内容
              store.setPostStatus(post.id, 'deleted');
              this.load();
            }
            wx.showToast({ title: (r && r.msg) || '已提交', icon: 'none' });
          }
        });
      },
      fail: () => {}
    });
  },

  // 自己的内容被系统自动下架：给一个直接的恢复入口，不用去找审核员
  onRestore(e) {
    const id = e.currentTarget.dataset.id || this.data.id;
    wx.showModal({
      title: '恢复展示',
      content: '确认这条内容没有违规吗？恢复后其他同学就能看到。',
      success: (res) => {
        if (!res.confirm) return;
        // 先云端后本地（store.restorePost）：云端没改成时不报「已恢复」，
        // 否则下次同步会把内容又变回已下架
        store.restorePost(id).then((r) => {
          if (!r || !r.ok) {
            feedback.toast((r && r.msg) || '恢复失败，请稍后重试');
            return;
          }
          this.load();
          feedback.toast('已恢复', { icon: 'success' });
        });
      }
    });
  },

  onDelete() {
    wx.showModal({
      title: '删除帖子',
      content: '删掉后其他人就看不到这条了，确定吗？',
      confirmColor: '#d9534f',
      success: async (res) => {
        if (!res.confirm) return;
        // deletePost 现在是「先云端、后本地」并返回结果：
        // 云端没删掉时不能弹「已删除」，否则别人刷新还看得见
        const r = await store.deletePost(this.data.id);
        if (!r || !r.ok) {
          feedback.toast((r && r.msg) || '删除失败，请稍后重试');
          return;
        }
        // 删了就找不回来，震一下确认已经生效（Toast 要等反应一会儿才看得到）
        feedback.buzz();
        feedback.toast('已删除', { icon: 'success' });
        setTimeout(() => wx.navigateBack(), 200);
      }
    });
  },

  // 审核员直删：不经过「先举报、再审核」那一圈。
  //
  // 权限边界在云端：deletePost(id, true) 只是跳过前端的作者归属校验，
  // 云函数 delContent 仍会重新确认调用者是审核员，并连同留言、留言赞踩一起清理。
  onAdminDelete() {
    if (!this.data.isMod || !this.data.post || !this.data.id) return;
    if (this._adminDeleteBusy || this._adminDeleteAsk) return;
    this._adminDeleteAsk = true;
    wx.showModal({
      title: '管理员删除',
      content: '将直接删除这条帖子及其全部评论，删除后不可恢复。该操作会记入审核日志。',
      confirmText: '删除',
      confirmColor: '#d9534f',
      success: async (res) => {
        if (!res.confirm || !this.data.isMod || this._adminDeleteBusy) return;
        this._adminDeleteBusy = true;
        feedback.loading('删除中', true);
        try {
          const r = await store.deletePost(this.data.id, true);
          feedback.hideLoading();
          if (!r || !r.ok) {
            // 云端失败时本地不动，留在原页让审核员看清原因后重试
            feedback.toast((r && r.msg) || '删除失败，请稍后重试');
            return;
          }
          feedback.buzz();
          feedback.toast('已删除', { icon: 'success' });
          // 正常从列表进来就返回上一页；从分享链接直接打开时没有上一页，回论坛列表
          setTimeout(() => {
            wx.navigateBack({
              delta: 1,
              fail: () => wx.switchTab({ url: '/pages/forum/list/list' })
            });
          }, 200);
        } catch (e) {
          feedback.hideLoading();
          feedback.toast('删除失败，请稍后重试');
        } finally {
          this._adminDeleteBusy = false;
        }
      },
      complete: () => { this._adminDeleteAsk = false; }
    });
  },

  // 编辑自己的帖子。
  //
  // 为什么不复用「发帖」页而新开一个编辑页：发帖页的表单是一整套新建流程
  // （选板块、关联课程、草稿、发布后跳列表），而编辑时板块和课程都必须锁死 ——
  // 改内容却顺手把帖子挪到别的板块，等于一条帖子凭空消失在新板块的历史里。
  // 而 postEdit 也只接受 title / content / images，不接受 board
  //
  // 成本对比很清楚：编辑一个只有三栏的表单，比给发帖页塞满「哪些字段不可改」的分支少得多
  onEdit() {
    if (!this.data.isMine || !this.data.id) return;
    // 已删除的帖子不给改：它的内容早就从列表里消失了，改回来也只会让人困惑
    if (this.data.post && this.data.post.status === 'deleted') return;
    nav.go({ url: '/sub/forum/edit/edit?id=' + this.data.id });
  },

  // 点作者进名片：可以「想认识」，对方同意后才互相看到联系方式
  goAuthor(e) {
    const id = e.currentTarget.dataset.openid;
    if (!id) return;
    nav.go({ url: '/pages/user/card/card?openid=' + id });
  },

  // 点留言者的头像也进名片 —— 和作者那条入口同一个落点。
  //
  // 没有 openid 就静默返回，不弹提示：老留言（只有 _openid 之外的字段缺失）
  // 或者对方没登记过资料时，弹一句「进不去」只会让人以为是自己点错了，
  // 而实际上这里本来就没什么可看的
  // 点头像进名片。
  //
  // ⚠️ 以前只认 data-openid：自己刚发出去的那条留言是**先写本地**的，
  //    那一刻 openid 可能还是空的（没登录 / 还没拿到），于是自己那条头像
  //    点了完全没反应 —— 跟「头像坏了」长得一模一样。
  //    所以带上 mine 标记兜底：是自己写的，就去自己的名片页。
  //    「点了头像能看到自己」本来就该成立，不需要任何前提条件
  goCommenter(e) {
    // 匿名帖下不给名片入口。模板那边已经把 tap 收掉了，这里再拦一层 ——
    // 名片页就是真名 + 他发过的所有帖子，点进去等于当面把人认出来，
    // 前面把昵称换成代号就全白做了。
    //
    // 两道都要：模板管「看起来能不能点」，这里管「真点了会发生什么」。
    // 只做模板，任何一次复用（转发、分享、别处渲染这份数据）都会把门重新打开
    if (store.isAnonPost(this.data.post)) return;
    const d = e.currentTarget.dataset || {};
    const mine = d.mine === true || d.mine === 'true';
    const id = String(d.openid || '') || (mine ? String(store.myOpenid() || '') : '');
    if (!id) return;
    nav.go({ url: '/pages/user/card/card?openid=' + id });
  },

  // 头像加载失败（云存储读不到 / 文件已被删）→ 退回文字头像。
  // 不这么兜的话界面上留的是一个空圆框，跟「坏了」长得一模一样
  onPostAvatarError() {
    if (this.data.postAvatarFailed) return; // 已经在兜底了，别反复 setData
    this.setData({ postAvatarFailed: true });
  },

  // 头像加载失败 → 退回文字头像（两级共用这一个入口）。
  //
  // 写的是 commentTree 里的那条，不是扁平 comments 里的那条：
  // 树上的节点是数据的副本，setData 到 comments 上界面不会动 ——
  // 那就会出现「明明处理了，头像还是个空圆框」。
  // data-r 有值说明是二级回复（r 是它在 replies 里的下标）
  onCommentAvatarError(e) {
    const d = e.currentTarget.dataset;
    const p = Number(d.p);
    const r = Number(d.r);
    if (!(p >= 0)) return;
    const key = (r >= 0)
      ? 'post.commentTree[' + p + '].replies[' + r + '].avaErr'
      : 'post.commentTree[' + p + '].avaErr';
    this.setData({ [key]: true });
  },

  // 从课程讨论跳到课程详情页
  goCourse(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    nav.go({ url: '/sub/course/detail/detail?id=' + id });
  },

  /* ---------------- 分享 ---------------- */

  // 转发给朋友：对方点开直接落到这条帖子的详情页
  onShareAppMessage() {
    const p = this.data.post;
    const title = (p && p.title) ? p.title : '商砖小站';
    return {
      title: title + ' · 来自商砖小站',
      path: '/sub/forum/detail/detail?id=' + this.data.id,
      // 有配图就用第一张当分享卡的背景，比系统默认图好看得多
      imageUrl: (this.data.postImages && this.data.postImages[0]) || ''
    };
  },

  // 分享到朋友圈：query 带上帖子 id，别人点开就是这条内容
  onShareTimeline() {
    const p = this.data.post;
    return {
      title: (p && p.title ? p.title : '浙小商论坛') + ' · 校园生活都在这儿',
      query: 'id=' + this.data.id,
      imageUrl: (this.data.postImages && this.data.postImages[0]) || ''
    };
  }
});
