// pages/user/chat/chat.js —— 和一位同学的私聊
//
// 没有实时推送：进入会话拉一次历史，之后每 20 秒拉一次**增量**，发一句话再同步一次。
// 校园里「我发完，对方过一会儿看到」足够用，实时通道要配消息服务，代价远大于收益。
//
// 长按一条消息可以复制 / 撤回（2 分钟内）/ 重发 / 举报，图片长按走同一套菜单。
// 举报的是「人」不是「某条消息」—— 私信骚扰是一串行为，单条截图说明不了什么，
// 服务端会把最近 10 条私信做成证据快照（见云函数 reportPerson）。
const chat = require('../../../utils/chat.js');
const notify = require('../utils/notify.js');
const nav = require('../../../utils/nav.js');
const userApi = require('../../../utils/user.js');
const upload = require('../../../utils/upload.js');
const feedback = require('../../../utils/feedback.js');
const cloud = require('../../../utils/cloud.js');
const unread = require('../../../utils/unread.js');
// 举报「人」的交互（理由菜单 + 补充说明 + 后果提示），和名片页共用同一份
const reportPerson = require('../utils/report-person.js');

// 一条消息最多几张图：再多就该拆成几条发，堆在一起对方也看不清
const MAX_IMG = 6;

// 撤回窗口，与服务端 RECALL_MS 同值。这里只决定长按菜单里「撤回」显不显示 ——
// 权威判定始终在云函数。本地最多慢一个轮询间隔（20 秒）才过期，
// 最坏的结果是点了之后收到一句「超过 2 分钟了」，绝不会真的撤回来
const RECALL_MS = 2 * 60 * 1000;

// 轮询间隔：15 秒太勤（挂在聊天页十分钟就是 40 次云函数调用），
// 30 秒对方回一句要等半分钟才冒出来，观感上像没发出去。20 秒是折中。
// 只在页面可见时跑（onShow 起、onHide 停），
// 用户点进名片页时聊天页只是被盖住、并没有销毁，那时继续轮询纯属白烧调用
const POLL_MS = 20000;

// 举报「人」的交互在 utils/report-person.js（与名片页共用）。
// 原来这份理由枚举在这里另抄了一份：两处各有一份，就一定会有一次只改一处，
// 而改漏的那次是「用户在界面上选了 A、库里记的是 B」—— 事后无从解释

// data-* 里放数组会被微信拼成逗号串，所以图片预览一律靠下标回查 this.data，
// 不依赖 dataset 里的数组本身
function pair(list, n) {
  return (Array.isArray(list) ? list : []).slice(0, n);
}

function clock(ts) {
  const d = Number(ts);
  if (!d) return '';
  const dt = new Date(d);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(dt.getHours()) + ':' + p(dt.getMinutes());
}

/* ---------------- 消息的界面形状 ---------------- */

// 云端只给原始字段（id / from / text / images / at），界面要的其余东西在这里补齐。
// 三个入口 —— 整段加载、轮询合并、发送回执 —— 必须走同一个函数：
// 各写一套的话，迟早出现「刚发出去那条没有撤回入口、退出重进又有了」这种偏差
function decorate(m, now) {
  const src = m || {};
  const at = Number(src.at) || 0;
  return Object.assign({}, src, {
    clock: clock(at),
    text: String(src.text || ''),
    // 老消息（图片功能上线前）没有 images 字段，统一补成空数组：
    // WXML 里 {{item.images.length}} 碰到 undefined 会渲染异常
    images: Array.isArray(src.images) ? src.images : [],
    // 系统消息（「你们已解除同学关系…」）单独一种样式，也不能被当成对方说的话
    sys: !!src.sys || String(src.from || '') === 'system',
    mine: !!src.mine,
    // 撤回入口只对「自己发的 + 已送达 + 2 分钟内」出现。
    // 未送达的不用撤回（对方根本没收到），撤回过的不用再撤回
    canRecall: !!src.mine && !src.recalled && !src.pending && !src.failed
      && !src.localOnly && at > 0 && (now - at) < RECALL_MS
  });
}

// 按 id 合并两批消息：云端那份覆盖本地（撤回之类的状态变化靠这一行同步过来），
// 云端没有的原样留着 —— 本地刚发出去还没落库的、以及被我删过的那批，都不该凭空消失。
// 不能整表替换：轮询只回增量，整表替换会把已有历史全丢掉
function mergeById(current, incoming) {
  const inc = {};
  incoming.forEach((m) => { if (m && m.id) inc[m.id] = m; });
  const known = {};
  const merged = (current || []).map((m) => {
    known[m.id] = true;
    return inc[m.id] || m;
  });
  incoming.forEach((m) => { if (m && !known[m.id]) merged.push(m); });
  return merged;
}

/* ---------------- 非好友的发送额度 ---------------- */

// 额度的权威判定在云函数（chatQuota），这里只负责把数字翻成人话。
// 文案在 JS 里拼：WXML 的 {{}} 不能调函数，也塞不下这种三四分支的句子
//
// 规则只有一条：加为好友之前双方各自最多 3 条，加为好友之后不限。
// 曾经还有一档「对方回过我就放宽到 20 条」，已去掉 —— 用户无法预知自己处在哪一档，
// 撞墙时也不知道该怎么做。现在只剩「还剩几条 / 发完了怎么办」两句话
function quotaText(q) {
  if (!q || q.isFriend) return '';
  if (q.left > 0) {
    return '你们还不是好友，你还能发 ' + q.left + ' 条（共 ' + q.limit + ' 条）。'
      + '加为好友之后就不限条数了。';
  }
  // 发完了：只说下一步能做什么。对方回没回过只影响前半句的安慰，不影响动作
  return '你的 ' + q.limit + ' 条消息已经发完了。'
    + (q.replied ? '对方也回过你了，' : '')
    + '加为好友之后可以继续聊。';
}

// 现在能不能发。三条短路都返回 true：云端没配额字段（旧版 / 断网）时一律放行 ——
// 与全站「云端不可用不能把用户锁死」的口径一致
function sendAllowed(q, blockedByMe, blockedByThem) {
  if (blockedByMe || blockedByThem) return false;
  if (!q || q.isFriend) return true;
  return Number(q.left) > 0;
}

// 不能发时输入区那块提示该说什么
function lockText(d) {
  if (d.blockedByMe) return '你已拉黑对方，解除后才能发送。';
  if (d.blockedByThem) return '对方设置了消息限制，你暂时发不出消息。';
  return quotaText(d.quota);
}

Page({
  data: {
    peer: '',
    peerName: '',
    // 我给对方起的备注名。有备注时标题优先用它 —— 会话列表里显示的就是备注名，
    // 点进来忽然换成本名，用户会以为自己点错了人
    alias: '',
    avatar: '',
    messages: [],
    input: '',
    loading: true,
    // 对方主动留了联系方式就展示出来，省得用户切出去找
    contact: '',
    contactLabel: '联系方式',
    scrollTo: '',
    // 滚到底要不要动画。第一次进会话是「跳」过去（不带动画），
    // 之后的新消息才是「滚」过去 —— 见 scrollToEnd
    scrollAnim: false,
    // 黑名单状态：我拉黑对方 / 对方拉黑我
    blockedByMe: false,
    blockedByThem: false,
    // 关系与额度：还不是好友时，我最多只能发 quota.limit 条（云函数判定）
    isFriend: true,
    quota: null,
    requested: false, // 我已经申请过、还在等对方回应
    // 对方申请了我、还没处理：这时按钮该是「同意加好友」而不是「申请加好友」，
    // 否则两人各发一条反向申请、谁也没按下去
    incomingRequest: null,
    quotaText: '', // 「还不是好友，还能发 2 条」这类提示，在 JS 里拼好
    canSend: true, // 额度用尽 / 任一方向拉黑时为 false，输入行整块换成引导
    lockText: '',
    // 会话级的请求箱状态（'' / 'accepted' / 'dismissed'）。
    // 陌生人的消息进请求箱，打开会话时要能就地「接受 / 忽略」，
    // 而不是让人退出去、到列表里再操作一遍
    reqState: '',
    isPendingReq: false,
    // 待发送的图片（已上传到云存储的 fileID）与上传进度
    pending: [],
    uploading: false,
    uploadPercent: 0,
    // 有新消息、但用户正在往上翻记录时，不把他一把拽到底 ——
    // 在底部浮一枚角标，点它才滚过去
    newHint: 0
  },

  onLoad(options) {
    this.peer = options.peer || '';
    this.lastAt = 0;
    this.atBottom = true;
    this.setData({ peer: this.peer, peerName: options.name || '' });
    // ⚠️ 这里以前直接调了 notify 的 request('chat')。onLoad 不是用户点击，
    //    微信只认 TAP 手势，调了也只会 fail（20004）—— 表现就是
    //    「私信通知的授权框从来没弹过」。授权挪到「发送」按钮上（见 onSendTap）：
    //    正在跟人说话的时候，正是最想收到回信提醒的时候。
    if (!this.peer) {
      this.setData({ loading: false });
      return;
    }
    this.load();
  },

  onShow() {
    if (!this.peer) return;
    // 从名片页退回来时对方可能刚换了资料
    this.load(true);
    this.startPoll();
  },

  onHide() {
    this.stopPoll();
  },

  /* ---------------- 轮询（没有 WebSocket 时的替代） ---------------- */

  startPoll() {
    this.stopPoll();
    this.pollTimer = setInterval(() => { this.poll(); }, POLL_MS);
  },

  stopPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  // 只拉 this.lastAt 之后的增量。关系状态（是否好友 / 额度 / 拉黑 / 请求箱）
  // 云端每次都完整回，所以顺带一起更新 —— 对方刚同意我的好友申请时，
  // 不用退出重进就能看到输入框解锁
  async poll() {
    if (!this.peer || this.polling) return;
    this.polling = true;
    const r = await chat.history(this.peer, this.lastAt);
    this.polling = false;
    if (!r || !Array.isArray(r.messages)) return;
    // 增量里一条新消息都没有也要落状态：对方可能刚同意好友、或者刚把我拉黑
    this.applyState(r, { full: false });
  },

  async load(silent) {
    if (!silent) this.setData({ loading: true });
    const r = await chat.history(this.peer);
    this.applyState(r, { full: true });
  },

  // 整段加载与轮询结果都从这里落下去。
  // 一次 setData 把整块状态写完：setData 是跨线程传输的，
  // 分几次调用等于把 messages 这个数组来回传几遍
  applyState(r, opts) {
    const full = !!(opts && opts.full);
    const raw = (r && r.messages) || [];
    const p = (r && r.peer) || {};
    const now = Date.now();
    const incoming = raw.map((m) => decorate(m, now));

    let messages;
    let arrived = 0;
    if (full) {
      // 云函数没部署（或那条消息还没落库）时，刚发出去的消息不在历史里 ——
      // 整表替换的话，用户眼前那条会凭空消失。把本地这些「云端还没确认」的接回去
      const serverIds = {};
      incoming.forEach((m) => { serverIds[m.id] = true; });
      const localOnly = (this.data.messages || [])
        .filter((m) => m && m.localOnly && !serverIds[m.id]);
      messages = incoming.concat(localOnly);
    } else {
      const prev = this.data.messages || [];
      messages = mergeById(prev, incoming);
      arrived = Math.max(0, messages.length - prev.length);
    }

    // 「已读」回执：只标在最后一条自己发的消息上。
    // 每条都标会把聊天页变成一排小字；而「对方看没看」只对最新那条有意义。
    // peerReadAt 是对方的阅读水位（服务端一直维护着，以前只是没回给前端）
    const peerReadAt = Number(r.peerReadAt) || 0;
    let lastMine = -1;
    messages.forEach((m, i) => { if (m && m.mine) lastMine = i; });
    messages = messages.map((m, i) => Object.assign({}, m, {
      showRead: i === lastMine,
      read: i === lastMine && !m.pending && !m.failed
        && Number(m.at) > 0 && Number(m.at) <= peerReadAt
    }));

    const blockedByMe = !!r.blockedByMe;
    const blockedByThem = !!r.blockedByThem;
    // 云端没给 quota（旧版云函数 / 断网）时留 null，下面一律按「不设限」处理
    const quota = r.quota || null;
    const isFriend = r.isFriend !== false;
    const reqState = String(r.reqState || '');

    // 对方先开口、我还没回过也没处理过 → 顶部挂一条「接受 / 忽略」。
    // 判定口径与聊天列表的请求箱完全一致（云函数 chatList 那三个条件），
    // 两边不一致的话会出现「列表里在请求箱、点进来却没有处理按钮」
    const last = messages[messages.length - 1] || {};
    const isPendingReq = !isFriend && String(last.from || '') === this.peer
      && reqState !== 'accepted' && reqState !== 'dismissed';

    // 增量水位只认「云端确认过」的消息：本地那些带 temp id 的（发送中 / 未送达 / 本地独有）
    // 时间戳可能比服务端给的略大，拿它们推水位会让轮询漏掉对方紧接着发来的那条
    if (messages.length) {
      this.lastAt = messages.reduce((mx, m) => (
        (m.pending || m.failed || m.localOnly) ? mx : Math.max(mx, Number(m.at) || 0)
      ), this.lastAt || 0);
    }

    // 注意这里**不**再清 input。原先每次 load 都清一次，而 load 在 onShow 也会跑 ——
    // 打了一半字出去看张图再回来，字就没了。输入框由 onInput / send 维护已经足够
    this.setData({
      messages: messages,
      loading: false,
      peerName: p.nickName || this.data.peerName,
      alias: p.alias || '',
      avatar: p.avatarUrl || '',
      contact: p.contactValue || '',
      contactLabel: p.contactType === 'wechat' ? '微信号' : (p.contactType === 'phone' ? '手机号' : (p.contactType === 'qq' ? 'QQ号' : '联系方式')),
      blockedByMe: blockedByMe,
      blockedByThem: blockedByThem,
      // 降级对象里没有 isFriend，取不到就当成好友（不锁）——
      // 云端不可用时本来就发不出去，再锁一层只会让人更困惑
      isFriend: isFriend,
      quota: quota,
      reqState: reqState,
      isPendingReq: isPendingReq,
      requested: !!r.requested,
      incomingRequest: r.incomingRequest || null,
      quotaText: quotaText(quota),
      canSend: sendAllowed(quota, blockedByMe, blockedByThem),
      lockText: lockText({ blockedByMe: blockedByMe, blockedByThem: blockedByThem, quota: quota })
    });

    // 滚不滚到底：整段刷新（刚进页面 / 从名片页回来）一定滚；
    // 轮询只在「用户本来就在底部」时滚。用户正往上翻记录时被一把拽到底，
    // 是聊天页最容易招人烦的一种行为，那种情况改浮角标
    const lastId = messages.length ? messages[messages.length - 1].id : '';
    if (full) {
      // 第一次进会话是「跳」到底（不带动画），之后每次整段刷新才是「滚」到底。
      // 区别不在终点，在过程：第一次要是滚过去，用户会看着整段历史倒着翻一遍
      const first = !this._jumped;
      this._jumped = true;
      this.scrollToEnd(lastId, { jump: first });
      return;
    }
    if (!arrived) return;
    if (this.atBottom === false) {
      this.setData({ newHint: (this.data.newHint || 0) + arrived });
      return;
    }
    this.setData({ newHint: 0 });
    this.scrollToEnd(lastId);
  },

  // 我们自己的程序化滚动也会触发 bindscroll，不区分的话会把 atBottom 打成 false，
  // 之后每一轮新消息就只会浮角标、再也不自动滚屏 —— 用户以为对方不回他了。
  //
  // opt.jump：**第一次**进会话时用，不带动画地直接落在最新一条。
  //   带动画的话，用户会亲眼看着历史从最早那条一路倒着翻到最新 ——
  //   「默认展示最新消息」这件事等于做到了，但过程全被看见了，
  //   看着像进错了会话或者列表在抽搐。之后的新消息才需要动画。
  //
  // 定位为什么分两步：scroll-into-view 认的是元素 id，**必须先渲染出来**才有得滚。
  //   刚进会话时 messages 还是空的、历史是异步回来的，同一个 setData 里
  //   同时写 messages 和 scrollTo，滚动条多半还停在旧高度上 —— 于是停在最早那条。
  //   所以内容先落，下一帧再给目标；再补一次兜底重设
  //   （值不变不会重新触发，得先清空再设）。代价只是两个空转的 nextTick
  scrollToEnd(id, opt) {
    const jump = !!(opt && opt.jump);
    this.atBottom = true;
    this.autoScroll = true;
    if (jump) this.setData({ scrollAnim: false });
    const set = () => {
      this.setData({ scrollTo: '' });
      if (wx.nextTick) wx.nextTick(() => this.setData({ scrollTo: id }));
      else setTimeout(() => this.setData({ scrollTo: id }), 30);
    };
    set();
    setTimeout(set, 180);
    setTimeout(() => {
      this.autoScroll = false;
      if (jump) this.setData({ scrollAnim: true });
    }, 620);
  },

  // 滚动位置只用来判断「用户在不在底部」，不参与渲染。
  // 判断错了也不丢消息 —— 最坏是角标该出现没出现，用户往上滚一下就看到了
  onScroll() {
    if (!this.autoScroll) this.atBottom = false;
  },

  onScrollToLower() {
    this.atBottom = true;
  },

  onJumpNew() {
    const msgs = this.data.messages;
    this.setData({ newHint: 0 });
    this.scrollToEnd(msgs.length ? msgs[msgs.length - 1].id : '');
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  /* ---------------- 发图片 ---------------- */

  // 选图走 utils/upload.js（隐私授权门 → chooseMedia → chooseImage 逐级降级），
  // 和发帖共用同一套，失败一律给一句人话，不再「点了没反应」
  async chooseImages() {
    if (this.data.blockedByMe) {
      feedback.toast('你已拉黑对方，解除后才能发图');
      return;
    }
    if (this.data.uploading) {
      feedback.toast('图片还在上传，稍等一下');
      return;
    }
    const rest = MAX_IMG - this.data.pending.length;
    if (rest <= 0) {
      feedback.toast('一条消息最多 ' + MAX_IMG + ' 张图');
      return;
    }
    const r = await upload.pickImages(rest);
    if (!r.ok) {
      // 用户自己从相册退出来不算错误，静默即可
      if (r.canceled || !r.msg) return;
      feedback.toast(r.msg);
      return;
    }
    // 选完就在后台压图（不 await）：真正上传时直接命中压缩缓存，省一次编解码
    upload.prewarm(r.files);
    this.uploadImages(r.files);
  },

  // 发 GIF：小程序不能直接读微信“表情收藏”面板，但可以从聊天文件选 .gif，
  // 或从相册选已保存的 GIF。上传时不做压缩，避免动图被转成静态图。
  async chooseGif() {
    if (this.data.blockedByMe) {
      feedback.toast('你已拉黑对方，解除后才能发 GIF');
      return;
    }
    if (this.data.uploading) {
      feedback.toast('图片还在上传，稍等一下');
      return;
    }
    if (this.data.pending.length >= MAX_IMG) {
      feedback.toast('一条消息最多 ' + MAX_IMG + ' 张图');
      return;
    }
    const r = await upload.pickGif(1);
    if (!r.ok) {
      if (r.canceled || !r.msg) return;
      feedback.toast(r.msg);
      return;
    }
    this.uploadImages(r.files);
  },

  // 上传：私信不做「存本机」的降级 —— 对方根本打不开我这台手机上的路径，
  // 那样的「发送成功」是自欺欺人，宁可当场说没传上去
  async uploadImages(files) {
    this.setData({ uploading: true, uploadPercent: 0 });
    // 进度只显示在「待发」那一栏里，不用 showLoading 蒙层：
    // 蒙层会把输入框挡死，用户感受到的是「点了图片后整页卡住」
    const report = (pct) => this.setData({ uploadPercent: pct });
    let ok = [];
    let failed = 0;
    try {
      if (!cloud.ensureCloud()) {
        failed = files.length;
      } else {
        const r = await upload.uploadMany(files, { prefix: 'chat', onProgress: report });
        ok = r.ok;
        failed = r.failed;
      }
    } catch (e) {
      console.error('[chat uploadImages] error:', e);
      failed = files.length;
    } finally {
      // 无论成败都要复位，否则「加图」按钮从此只剩一句提示，点不动
      this.setData({
        pending: pair(this.data.pending.concat(ok), MAX_IMG),
        uploading: false,
        uploadPercent: 0
      });
    }
    if (failed) feedback.toast(failed + ' 张没传上去，重新选一次');
  },

  onRemovePending(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    if (!(idx >= 0)) return;
    const next = this.data.pending.slice();
    next.splice(idx, 1);
    this.setData({ pending: next });
  },

  previewPending(e) {
    const urls = this.data.pending.slice();
    if (!urls.length) return;
    const idx = Number(e.currentTarget.dataset.idx) || 0;
    wx.previewImage({ current: urls[idx] || urls[0], urls: urls });
  },

  // 看大图：urls 用下标从 this.data.messages 里回查，
  // 不依赖 data-imgs（数组塞进 dataset 会被拼成逗号串，拿到的是一串字符而不是数组）
  previewMsg(e) {
    const mi = Number(e.currentTarget.dataset.idx);
    const msg = this.data.messages[mi];
    if (!msg) return;
    const urls = (msg.images || []).slice();
    if (!urls.length) return;
    const ii = Number(e.currentTarget.dataset.i) || 0;
    wx.previewImage({ current: urls[ii] || urls[0], urls: urls });
  },

  /* ---------------- 长按菜单：复制 / 撤回 / 重发 / 举报 ---------------- */

  // 菜单项按「这条消息此刻能做什么」现算，不做固定四项 ——
  // 给一个点了只会报错的按钮，比不给更糟。
  // 用 wx.showActionSheet 而不是自绘浮层：它是原生的，不用管定位与页面滚动，
  // 也不会像浮层那样挡住输入框
  msgMenu(e) {
    const mi = Number(e.currentTarget.dataset.idx);
    const msg = this.data.messages[mi];
    if (!msg || msg.sys) return;

    const acts = [];
    if (msg.text) acts.push('copy');
    if (msg.canRecall) acts.push('recall');
    if (msg.mine && msg.failed) acts.push('retry');
    if (!msg.mine) acts.push('report');
    if (!acts.length) return;

    const LABEL = { copy: '复制文字', recall: '撤回', retry: '重发', report: '举报这位同学' };
    wx.showActionSheet({
      itemList: acts.map((a) => LABEL[a]),
      success: (res) => {
        const a = acts[res.tapIndex];
        if (a === 'copy') this.copyMsg(msg);
        else if (a === 'recall') this.onRecall(msg);
        else if (a === 'retry') this.retryAt(mi);
        else if (a === 'report') this.onReport();
      }
    });
  },

  copyMsg(msg) {
    const t = String(msg.text || '').trim();
    if (!t) return;
    wx.setClipboardData({ data: t, success: () => feedback.toast('已复制') });
  },

  // 撤回：先确认再发请求，且**绝不本地先抹掉** ——
  // 本地抹掉而云端还在，对方看得到、我看不到，是最容易让人怀疑「我是不是记错了」的状态
  onRecall(msg) {
    if (!msg || !msg.id || this.recalling) return;
    wx.showModal({
      title: '撤回这条消息',
      // 把「不退额度」说明白：非好友的 3 条是反骚扰闸门，
      // 如果撤回能退款，就成了一条「发出去 → 撤回 → 再发」的无限通道
      content: '对方会看到「消息已撤回」。这条消息占用的发送条数不会退回。',
      confirmText: '撤回',
      confirmColor: '#d9534f',
      success: async (res) => {
        if (!res.confirm) return;
        this.recalling = true;
        const r = await chat.recall(this.peer, msg.id);
        this.recalling = false;
        if (!r || r.ok === false) {
          feedback.toast((r && r.msg) || '没撤回来，再试一次');
          return;
        }
        this.setData({
          messages: this.data.messages.map((m) => (
            m.id === msg.id
              ? Object.assign({}, m, { recalled: true, text: '', images: [], canRecall: false })
              : m
          ))
        });
      }
    });
  },

  // 举报「人」。交互、理由枚举、「不会自动封号」这句提示、以及证据快照的说明
  // 都在 utils/report-person.js 里，和名片页共用同一份 ——
  // 两处各写一份的话，文案早晚会漂移，而漂移的偏偏是后果说明那句
  onReport() {
    // 只能举报对方。理论上 peer 可能是我自己（从通知点进来），
    // 但那时的菜单里根本不该出现「举报」这一项 —— 模板用 wx:if 挡了，
    // 这里再挡一次是为了防住将来有人从别处调它
    if (!this.peer || this.peer === cloud.getOpenid()) return;
    reportPerson.ask('chat', this.peer, this.data.peerName || '');
  },

  /* ---------------- 请求箱：接受 / 忽略 ---------------- */

  // 接受 = 「我愿意收你的消息」，刻意**不顺手加好友**：
  // 加好友要交换联系方式，是另一件更重的事，混在一起用户不知道自己还答应了什么
  async onAcceptReq() {
    if (!this.peer || this.reqing) return;
    this.reqing = true;
    const r = await chat.accept(this.peer);
    this.reqing = false;
    if (r && r.ok === false) {
      feedback.toast(r.msg || '没成功，再点一次');
      return;
    }
    this.setData({ reqState: 'accepted', isPendingReq: false });
    feedback.toast('已接受');
  },

  async onDismissReq() {
    if (!this.peer || this.reqing) return;
    this.reqing = true;
    const r = await chat.dismiss(this.peer);
    this.reqing = false;
    if (r && r.ok === false) {
      feedback.toast(r.msg || '没成功，再点一次');
      return;
    }
    this.setData({ reqState: 'dismissed', isPendingReq: false });
    // 必须说清「这不是拉黑」：对方再发一条还会回来。
    // 不解释的话，下次它又冒出来时用户会以为功能坏了
    feedback.toast('已忽略，对方再发消息时会回来');
  },

  /* ---------------- 发送 ---------------- */

  async send() {
    const text = String(this.data.input || '').trim();
    const images = (this.data.pending || []).slice();
    // 文字和图片至少要有一样
    if ((!text && !images.length) || !this.peer) return;
    if (this.sending) return;
    if (this.data.uploading) {
      feedback.toast('图片还在上传，传完再发');
      return;
    }
    // 本地先拦一道：额度用尽或任一方向拉黑时根本别发。服务端那道闸门是一样的，
    // 这里拦是为了不让用户白打一段字、白等一个来回。
    // 走反馈层而不是裸调 wx.showToast —— 用户是打完字直接点发送，键盘正占着下半屏
    if (!this.data.canSend) {
      feedback.toast(this.data.lockText || '现在发不出去');
      return;
    }
    this.setData({ input: '', pending: [] });

    // 乐观更新：先把话摆上去，成败都是用户先看到反馈，再决定要不要重试
    const temp = decorate({
      id: 'tmp' + Date.now(),
      text: text,
      images: images,
      mine: true,
      at: Date.now(),
      pending: true
    }, Date.now());
    this.setData({ messages: this.data.messages.concat([temp]) });
    this.scrollToEnd(temp.id);

    this.sending = true;
    const r = await chat.send(this.peer, text, images);
    this.sending = false;

    if (r && r.ok === false) {
      // 走反馈层而不是裸调 wx.showToast：它会先收键盘再弹 ——
      // 用户是「打完字直接点发送」，键盘正占着下半个屏，裸调等于弹在键盘后面看不见
      feedback.toast(r.msg || '没发出去，试试再发一次');
      // 额度是在服务端扣的：被拒说明本地那份数字过期了（比如刚在别的设备上发过）。
      // 拿回执里那份把输入区一起锁掉，别让用户继续对着一个发不出去的框打字
      if (r.quota) this.applyQuota(r.quota);
      const next = this.data.messages.map((m) => (
        m.id === temp.id ? Object.assign({}, m, { pending: false, failed: true, canRecall: false }) : m
      ));
      this.setData({ messages: next });
      return;
    }
    // 「发出去了但图被云端丢了」：这种最需要说出来 ——
    // 用户以为图送到对方手里了，其实对方只看到半句
    if (r && r.warn) feedback.toast(r.warn, { duration: 4000 });

    // 云端把落库后的那条原样回了过来：用它替换掉临时这条，id / 时间就对齐了，
    // 后面刷新历史也不会「同一条消息出现两遍」
    const saved = (r && r.msg && r.msg.id)
      ? decorate(Object.assign({}, r.msg, { mine: true }), Date.now())
      : null;
    if (saved) {
      this.setData({
        messages: this.data.messages.map((m) => (m.id === temp.id ? saved : m))
      });
      // 回执里已经带了扣完的额度，直接落上去。
      // 这里刻意**不再**整段 load 一次：消息和额度都已经是最新的，
      // 为了刷新去搬一次 200 条历史纯属浪费，而且要等到下一帧才对齐（会闪回旧数字）。
      // 关系状态那一小块交给 20 秒一次的轮询去校准
      if (r.quota) this.applyQuota(r.quota);
      return;
    }
    // 云函数没部署：这条只在本地存在。标上 localOnly 保住它，
    // 并且**不能**再 load()，否则刚发出去的消息会被历史整表覆盖掉
    this.setData({
      messages: this.data.messages.map((m) => (
        m.id === temp.id
          ? Object.assign({}, m, { pending: false, localOnly: true, canRecall: false })
          : m
      ))
    });
  },

  retryMsg(e) {
    this.retryAt(Number(e.currentTarget.dataset.idx));
  },

  // 重发：复用这条消息里已经上传好的 fileID，不再重传一遍图片
  async retryAt(idx) {
    const msg = this.data.messages[idx];
    if (!msg || !msg.mine || this.retrying) return;
    this.retrying = true;
    this.setData({
      messages: this.data.messages.map((m) => (
        m.id === msg.id ? Object.assign({}, m, { pending: true, failed: false, canRecall: false }) : m
      ))
    });

    const r = await chat.send(this.peer, String(msg.text || ''), msg.images || []);
    this.retrying = false;

    if (r && r.ok === false) {
      feedback.toast(r.msg || '还是没发出去');
      if (r.quota) this.applyQuota(r.quota);
      this.setData({
        messages: this.data.messages.map((m) => (
          m.id === msg.id ? Object.assign({}, m, { pending: false, failed: true, canRecall: false }) : m
        ))
      });
      return;
    }
    if (r && r.warn) feedback.toast(r.warn, { duration: 4000 });
    const saved = (r && r.msg && r.msg.id)
      ? decorate(Object.assign({}, r.msg, { mine: true }), Date.now())
      : null;
    if (saved) {
      this.setData({
        messages: this.data.messages.map((m) => (m.id === msg.id ? saved : m))
      });
      if (r.quota) this.applyQuota(r.quota);
      return;
    }
    this.setData({
      messages: this.data.messages.map((m) => (
        m.id === msg.id
          ? Object.assign({}, m, { pending: false, localOnly: true, canRecall: false })
          : m
      ))
    });
  },

  onSendTap() {
    // 要「新私信」授权只能在这一帧（点击手势里），而且不能 await：
    // 发消息是即时的，不该先等用户把面板选完才发出去。
    // 节流在 maybeRequest 里（允许过 12h 内不再问，拒绝过 7 天内不问）
    notify.maybeRequest('chat');
    this.send();
  },

  // 回车即发送，手机上少点一下
  onConfirm() {
    this.send();
  },

  /* ---------------- 加好友与额度 ---------------- */

  // 把服务端给的额度落到界面上。quota / canSend / lockText / quotaText 必须一起改 ——
  // 只改数字不改 canSend，就会出现「显示还剩 0 条、输入框却还能打字」
  applyQuota(q) {
    if (!q) return;
    const blockedByMe = this.data.blockedByMe;
    const blockedByThem = this.data.blockedByThem;
    this.setData({
      quota: q,
      isFriend: !!q.isFriend,
      quotaText: quotaText(q),
      canSend: sendAllowed(q, blockedByMe, blockedByThem),
      lockText: lockText({ blockedByMe: blockedByMe, blockedByThem: blockedByThem, quota: q })
    });
  },

  // 从会话页发起加好友。额度用尽之后，这里是唯一的出口 ——
  // ⚠️ 这里刻意**不**走 utils/friend.js 的留言弹窗：会话里已经有上下文了
  // （对方刚看过我那 3 条消息），此时再让人重写一遍「我是谁、为什么找你」反而啰嗦，
  // 而「发不出去了」本身就是最清楚的理由。要附言的场景在名片页 / 搜索结果那两处。
  async onAddFriend() {
    if (!this.peer || this.data.requested || this.adding) return;
    this.adding = true;
    const r = await userApi.addRequest(this.peer, '');
    this.adding = false;
    if (r && r.ok === false) {
      feedback.toast(r.msg || '没发出去，再试一次');
      return;
    }
    this.setData({ requested: true });
    feedback.toast('已发出，等对方同意');
  },

  // 对方先申请了我：直接在这里同意，省得再切到「我的同学 → 请求」去操作一遍。
  // friendAccept 在一个事务里删申请 + 双向写关系（见云函数），
  // 成功后 isFriend 就成立，额度那道闸门自然不再拦
  async onAcceptFriend() {
    const req = this.data.incomingRequest;
    if (!req || !req.id || this.accepting) return;
    this.accepting = true;
    const r = await userApi.friendAccept(req.id);
    this.accepting = false;
    if (!r || r.ok === false) {
      feedback.toast((r && r.msg) || '没成功，再点一次');
      // 云端那条申请可能已被别处处理过，拉一次把状态对齐
      this.load(true);
      return;
    }
    this.setData({ incomingRequest: null });
    feedback.toast('已加为好友，可以随便聊了');
    this.load(true);
  },

  // 查看对方名片：从私聊直接跳同学名片，点开能看到对方公开的资料
  goCard() {
    if (!this.peer) return;
    nav.go({ url: '/pages/user/card/card?openid=' + this.peer });
  },

  // 拉黑 / 解除拉黑：单向关系，只影响我这一侧。拉黑后双方都不能再发新消息，历史保留。
  onToggleBlock() {
    if (!this.peer) return;
    if (this.data.blockedByMe) {
      userApi.unblock(this.peer).then(() => {
        this.setData({ blockedByMe: false });
        feedback.toast('已解除拉黑');
      });
      return;
    }
    wx.showModal({
      title: '拉黑对方',
      // 说清「拉黑」和「忽略消息请求」的区别：后者是软性的，对方再发还会回来；
      // 拉黑才是真的彻底断掉。这两个动作混在一起时，用户会用一个以为是另一个
      content: '拉黑后双方都不能再发送新消息，历史消息会保留。',
      confirmText: '拉黑',
      confirmColor: '#d9534f',
      success: (res) => {
        if (!res.confirm) return;
        userApi.block(this.peer).then(() => {
          this.setData({ blockedByMe: true });
          feedback.toast('已拉黑');
        });
      }
    });
  },

  copyContact() {
    if (!this.data.contact) return;
    wx.setClipboardData({
      data: this.data.contact,
      success: () => feedback.toast('已复制')
    });
  },

  // 退出会话时把小红点重算一遍：进这一页 = 读过了，tabBar 上的数字该跟着减
  onUnload() {
    this.stopPoll();
    unread.refreshBadge(true);
  }
});
