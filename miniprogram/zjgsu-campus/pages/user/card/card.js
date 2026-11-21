// pages/user/card —— 同学名片
// 别人能在我这里看到多少，取决于我们之间的「关系」：
//   陌生人 → 只有昵称头像；点了「加好友」→ 等对方同意；同意后 → 才能看到联系方式。
//
// 这张名片是「加好友」的主要触发点，但**不是它的独立入口** ——
// 加好友的动作本身在 utils/friend.js（留言弹窗 + 文案），
// 找同学的搜索结果、私信发满 3 条之后用的是同一份实现。
const userApi = require('../../../utils/user.js');
const cloud = require('../../../utils/cloud.js');
const nav = require('../../../utils/nav.js');
const store = require('../../../utils/store.js');
// 加好友 / 解除好友的交互（留言弹窗、二次确认）统一在这里，见 utils/friend.js 的注释
const friend = require('../utils/friend.js');
// 举报「人」的交互（选理由 + 补充说明 + 后果提示）在这里，私信页用的是同一份
const reportPerson = require('../utils/report-person.js');
// 提示统一走反馈层：裸调 wx.showToast 会被同一时刻的 Loading 抹掉，也会被键盘挡住
const feedback = require('../../../utils/feedback.js');

// 历史发帖一次列几条。和云函数侧的 AUTHOR_POSTS_MAX 对齐：
// 本地兜底那份不能比云端还多，否则会出现「云端结果回来反而变少了」的怪像
const POSTS_MAX = 20;

// 还没加好友时每人能发几条。数值只有一处定义（utils/friend.js），
// 前端这些数字只是说给用户听的，真正的闸门在云端 STRANGER_QUOTA ——
// 这里写大了不会放宽任何限制，只会让人以为「还能发」然后被打回来
const STRANGER_QUOTA = friend.STRANGER_QUOTA;

// 列表只留这几个字段。帖子正文动辄上千字，20 条一起塞进 data 会让 setData
// 的载荷白白大出一大截 —— setData 是跨线程传输的，越大越卡，
// 而列表上一个字的正文都不显示
function pickPost(p) {
  return {
    id: String(p.id || ''),
    title: String(p.title || '（无标题）'),
    board: String(p.board || ''),
    time: String(p.time || ''),
    hidden: !!p.hidden,
    // 限时置顶到点即失效。名片页不走 decoratePost，所以这里调同一个判断，
    // 免得「论坛里已经不顶了、名片上还挂着置顶徽标」这种前后不一致
    pinned: store.pinAliveNow(p),
    likes: Number(p.likes) || 0,
    commentCount: Number(p.commentCount) || 0
  };
}

// 关系状态条的三行文案。放在一起算而不是散在模板的 {{}} 里：
// 「是什么关系」和「接下来会怎样」必须来自同一处判断，
// 拆开写就会出现「标题说已是同学、副标题还在说配额」这种自相矛盾的界面
//
// 优先级是有讲究的：拉黑 > 好友 > 已申请 > 陌生人。
// 拉黑排在最前，是因为被拉黑时后面那些描述全都不成立了 ——
// 而这时页面最需要让用户知道「怎么解开」，所以下面那张卡片会改成「解除拉黑」
function relOf(state) {
  if (state.blockedMe) {
    return {
      icon: '/assets/icons/shield--danger.svg',
      title: '你已拉黑 TA',
      sub: 'TA 发不出请求给你，也不会出现在你的提醒里。'
    };
  }
  if (state.isFriend) {
    return {
      icon: '/assets/icons/users-round--profile.svg',
      title: '你们是同学',
      sub: '你们能互相看到联系方式，私信不限条数。'
    };
  }
  if (state.waiting) {
    return {
      icon: '/assets/icons/clock--muted.svg',
      title: '你已申请，等对方通过',
      sub: '通过之后你们就能互相看到联系方式。'
    };
  }
  return {
    icon: '/assets/icons/users-round--campus.svg',
    title: '你们还不是同学',
    // 配额先说在前面：等用户打完字才被拒，额度已经浪费在他以为不会失败的动作上
    sub: '互相最多发 ' + STRANGER_QUOTA + ' 条消息；加为同学之后不限条数。'
  };
}

Page({
  data: {
    openid: '',
    isMe: false,
    isFriend: false,
    waiting: false,
    profile: null,
    // 我给他起的备注名（只有我这一侧可见）。模板里把它排在原名之上 ——
    // 名单、私信标题、名片三处用同一个名字才不会显得像三个人
    alias: '',
    contactLabel: '',
    // 我发出的申请里附的那句话（等待态要显示出来，否则用户不记得自己写过什么）
    msg: '',
    blockedMe: false, // 我拉黑了 TA
    blockedByThem: false, // TA 拉黑了我，我发不出请求
    // TA 的历史发帖：先本地兜底上屏，云端结果回来再覆盖（见 loadPosts）
    posts: [],
    // 管理操作（仅审核员、且看的不是自己）
    isMod: false,
    ban: null, // TA 的封禁状态，null = 没被封
    // 还没加好友时的消息条数上限，只用于文案
    strangerQuota: STRANGER_QUOTA,
    // 关系状态条（图标 + 两行文案），由 relOf() 一次算出，见该函数说明
    relIcon: '',
    relTitle: '',
    relSub: '',
    // 头像地址在、图却加载不出来（过期 / 断网）。置 true 之后 wxml 退回首字母
    avaFail: false
  },

  // 关系相关的每一次变化都走这里重算状态条。
  // 散在各处 setData 里各写一遍的话，迟早有一处漏 —— 而漏掉的后果
  // 不是样式不对，是「标题说已是同学、副标题还在讲配额」这种自相矛盾
  applyRel(patch) {
    const st = Object.assign({
      blockedMe: this.data.blockedMe,
      isFriend: this.data.isFriend,
      waiting: this.data.waiting
    }, patch || {});
    const rel = relOf(st);
    this.setData(Object.assign({
      relIcon: rel.icon,
      relTitle: rel.title,
      relSub: rel.sub
    }, patch || {}));
  },

  // 头像加载失败：退回文字头像。判断写的是「地址在 + 图出来了」，
  // 只看地址在的话，图裂时就是一个空圆框
  onAvaError() {
    if (this.data.avaFail) return;
    this.setData({ avaFail: true });
  },

  onLoad(options) {
    const openid = options && options.openid ? options.openid : '';
    this.setData({ openid: openid });
    this.load();
  },

  onShow() {
    this.load();
  },

  load() {
    const openid = this.data.openid;
    if (!openid) {
      feedback.toast('缺少身份参数');
      return;
    }
    const myOpenid = cloud.getOpenid() || (userApi.getMyProfile().openid || '');
    this.setData({ isMe: !!myOpenid && myOpenid === openid });

    userApi.getProfile(openid).then((r) => {
      const res = r || {};
      // 没填过资料不等于没有主页：用默认名片渲染，备注/封禁/返回都还能用。
      const p = res.profile || {
        openid: openid,
        nickName: '浙小商',
        avatarUrl: '',
        college: '',
        motto: '',
        profileIncomplete: true
      };
      const decorated = Object.assign({}, p, {
        avatarText: (p.nickName || '').charAt(0) || '同'
      });
      // 云端旧版可能把 profile 丢了；本机好友缓存还能判断关系，备注按钮不能因此消失。
      const localFriend = userApi.isFriend(openid);
      this.applyRel({
        isFriend: !!res.isFriend || localFriend,
        alias: p.alias || ''
      });
      this.setData({
        profile: decorated,
        // 换了个人就重新给头像一次机会，别把上一位的失败状态带过来
        avaFail: false,
        contactLabel: userApi.CONTACT_LABEL[p.contactType] || '联系方式'
      });
    });

    // 看自己的名片时后面这些全都不成立（不会给自己发申请、不会拉黑自己），
    // 还照发就是白白烧四次云函数调用。历史发帖是唯一还要的，所以只放它过去
    if (this.data.isMe) {
      this.loadPosts();
      return;
    }

    // 我已经发出过请求但还没被处理
    userApi.listOutgoing().then((list) => {
      const hit = (list || []).find((x) => x.toOpenid === openid);
      this.applyRel({ waiting: !!hit, msg: hit ? hit.message : '' });
    }).catch(() => {});

    // 拉黑状态：双向都要看，单向也不让你继续打扰
    userApi.listBlocks().then((list) => {
      const arr = list || [];
      this.applyRel({ blockedMe: arr.some((b) => b.openid === openid) });
    }).catch(() => {});
    // 我拉黑的方向是 blocks[me→them]，对方拉黑我则是 them→me，
    // 后者靠 addRequest 在服务端拦；这里只做展示提示。

    this.loadPosts();
  },

  /* ---------------- TA 的历史发帖 ---------------- */

  // 顺序是「本地先上屏 → 云端回来覆盖」：本地是同步读缓存，落屏是瞬间的；
  // 云端要走一次云函数调用，先等它的话整块区域要空白一秒多。
  // 但云端那份才是准的 —— 本地缓存只有最近 20 条帖子（PAGE_SIZE），
  // 发得多的人用本地算会显示少。
  loadPosts() {
    const openid = this.data.openid;
    if (!openid) return;
    const local = store.getPostsBy(openid).slice(0, POSTS_MAX).map(pickPost);
    // 只在还没有数据时用本地那份顶上。从详情页返回也会再走一次 load()，
    // 那会儿 posts 里已经是云端结果了，再拿本地覆盖一次会让列表先变少再变多，白闪一下
    if (!this.data.posts.length && local.length) this.setData({ posts: local });

    userApi.postsByAuthor(openid).then((r) => {
      // r 为 null = 云函数没部署 / 断网：留着本地那份，别把页面清空
      if (!r || !Array.isArray(r.list)) return;
      this.setData({
        posts: r.list.map(pickPost),
        // 顺手接住管理员身份：whoami 和这条是并行发的，谁先回来都算数
        isMod: this.data.isMod || !!r.isMod
      });
    }).catch(() => {});
  },

  // 我是不是审核员：以云函数的 whoami 为准。
  // 前端的 cfg.MODERATORS 只管「我的」页那几个入口显不显示，那是展示；
  // 「能不能封人」是权限，不能拿一份本地名单当依据。
  loadMod() {
    // onLoad / onShow 都会走 load()，问一遍就够
    if (this.modAsked) return;
    this.modAsked = true;
    userApi.whoami().then((me) => {
      if (!me || !me.isMod) return;
      this.setData({ isMod: true });
      this.loadBanState();
    }).catch(() => {});
  },

  // TA 现在是不是被封着。走 banList 而不是新开一个「查某人封禁状态」的 action：
  // 名册最多 50 条，够名片页用，为一行状态多养一个接口不划算。
  // 非审核员调 banList 会被服务端直接拒，所以这条链只在 isMod 成立后才走
  loadBanState() {
    userApi.banList().then((r) => {
      const hit = ((r && r.list) || []).filter((b) => b.openid === this.data.openid)[0];
      this.setData({ ban: hit || null });
    }).catch(() => {});
  },

  goPost(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    nav.go({ url: '/sub/forum/detail/detail?id=' + id });
  },

  /* ---------------- 管理操作（仅审核员） ---------------- */

  // 封号：原因可编辑，默认填上最常见的那一类。
  // 和审核页的封号入口走同一个云函数接口，行为完全一致 ——
  // 两处各写一套「封号前后做了什么」迟早不一致
  onBan() {
    const openid = this.data.openid;
    if (!openid || !this.data.isMod || this.data.isMe) return;
    wx.showModal({
      title: '封禁这个账号',
      editable: true,
      placeholderText: '封禁原因（会展示给被封的人）',
      content: '卖片 / 广告',
      confirmText: '封禁',
      confirmColor: '#dd4b55',
      success: (res) => {
        if (!res.confirm) return;
        // 输入框被清空时不硬塞空原因：封禁名册上写「未填原因」，
        // 下一个人接手根本不知道前任为什么封
        const reason = String(res.content || '').trim() || '卖片 / 广告';
        userApi.banUser(openid, reason).then((r) => {
          if (r && r.ok === false) { feedback.toast(r.msg || '没封成'); return; }
          feedback.toast('已封禁');
          this.loadBanState();
        }).catch(() => feedback.toast('网络不太顺，再试一次'));
      }
    });
  },

  onUnban() {
    const openid = this.data.openid;
    if (!openid || !this.data.isMod) return;
    wx.showModal({
      title: '解除封禁',
      content: '解除后 TA 可以重新发帖、评论和私信。',
      confirmText: '解除',
      success: (res) => {
        if (!res.confirm) return;
        userApi.unbanUser(openid).then((r) => {
          if (r && r.ok === false) { feedback.toast(r.msg || '没解成'); return; }
          feedback.toast('已解除封禁');
          this.loadBanState();
        }).catch(() => feedback.toast('网络不太顺，再试一次'));
      }
    });
  },

  // 加好友。留言收进弹窗里填（见 utils/friend.js 注释）：
  // 原来页面里摆着「附一句留言」这个独立按钮，等于给加好友多加了一道工序
  onRequest() {
    const openid = this.data.openid;
    if (!openid || this.requesting) return;
    this.requesting = true;
    friend.ask(openid).then((r) => {
      this.requesting = false;
      // 用户自己取消的不算状态变化，什么都不动
      if (!r || r.canceled || r.ok === false) return;
      this.applyRel({ waiting: true });
      // 留言内容从云端那条申请上取回来，不本地拼 —— 服务端会 slice(0,50)，
      // 本地拼的可能是被截断前的原文，显示出来和对方看到的不是一份
      userApi.listOutgoing().then((list) => {
        const hit = (list || []).find((x) => x.toOpenid === openid);
        this.applyRel({ msg: hit ? hit.message : '' });
      }).catch(() => {});
    });
  },

  // 解除好友。二次确认在 utils/friend.js 里（带对方名字、写清后果），
  // 这里只负责把本地状态改对 —— 不改成游客态的话，页面会继续显示联系方式，
  // 而云端其实已经按陌生人返回了，下次刷新才「突然」消失
  onUnfriend() {
    const openid = this.data.openid;
    if (!openid || this.unfriending) return;
    const nick = this.data.profile ? (this.data.profile.nickName || '') : '';
    this.unfriending = true;
    friend.remove(openid, nick).then((r) => {
      this.unfriending = false;
      if (!r || r.canceled || r.ok === false) return;
      // 先把状态改对：联系方式那块要立刻收掉，陌生人那组按钮要出来。
      // 只靠 load() 的话要等一次往返，这一帧里页面还在显示已经失效的联系方式
      this.applyRel({ isFriend: false, waiting: false, msg: '', blockedMe: false });
      // 整页重拉一次：云端已经按陌生人返回了，本地状态要和它对齐
      this.load();
    });
  },

  // 去私信。带上昵称，会话页顶部就不用干等云端资料回来才有标题。
  // 昵称不 encode：和 chats.js 的 openChat 保持一致 —— 那边一直没编码也能跑，
  // 这里单独编一次反而会出现「同一个页面两种传参口径」，出问题时不知道该查哪边
  onChat() {
    const openid = this.data.openid;
    if (!openid) return;
    const name = this.data.profile ? (this.data.profile.nickName || '') : '';
    nav.go({ url: '/pages/user/chat/chat?peer=' + openid + '&name=' + name });
  },

  onCopy(e) {
    const v = e.currentTarget.dataset.v || '';
    if (!v) return;
    wx.setClipboardData({ data: String(v) });
  },

  onToggleBlock() {
    const openid = this.data.openid;
    if (!openid || this.data.isMe) return;
    if (!this.data.blockedMe) {
      wx.showModal({
        title: '拉黑这位同学',
        content: '拉黑后 TA 再也发不出请求，你也不会再看到 TA 的留言。\n\n'
          + '这只是关上门，不是举报。如果 TA 有骚扰、冒充之类的行为，'
          + '请用下面的「举报」—— 那一条会真的进管理员的队列。',
        confirmText: '拉黑',
        confirmColor: '#dd4b55',
        success: (res) => {
          if (!res.confirm) return;
          userApi.block(openid).then((r) => {
            // 云端明确失败时不改本地状态：界面先「拉黑成功」而云端什么都没写，
            // 用户会以为挡住了，其实消息照旧能发进来
            if (r && r.ok === false) { feedback.toast(r.msg || '没拉黑成，再试一次'); return; }
            this.applyRel({ blockedMe: true });
            feedback.ok('已拉黑');
          }).catch(() => feedback.toast('没拉黑成，再试一次'));
        }
      });
      return;
    }
    wx.showModal({
      title: '解除拉黑',
      content: '解除后可以重新收到 TA 的请求，也能发消息给他。',
      success: (res) => {
        if (!res.confirm) return;
        userApi.unblock(openid).then((r) => {
          if (r && r.ok === false) { feedback.toast(r.msg || '没解除，再试一次'); return; }
          this.applyRel({ blockedMe: false });
          feedback.ok('已解除');
        }).catch(() => feedback.toast('没解除，再试一次'));
      }
    });
  },

  // 好友名片里直接改备注，不再要求用户记住“长按列表”这个隐藏入口。
  onEditAlias() {
    if (!this.data.isFriend || !this.data.openid) return;
    const cur = String(this.data.alias || '').trim();
    wx.showModal({
      title: '备注名（只有你看得到）',
      editable: true,
      content: cur,
      placeholderText: '留空就恢复成 TA 自己的昵称',
      success: (res) => {
        if (!res.confirm) return;
        const val = String(res.content || '').trim().slice(0, 20);
        userApi.friendAlias(this.data.openid, val).then((r) => {
          if (!r || r.ok === false) {
            feedback.toast((r && r.msg) || '没保存，再试一次');
            return;
          }
          feedback.toast(val ? '已设置备注' : '已恢复原名');
          this.load();
        }).catch(() => feedback.toast('没保存，再试一次'));
      }
    });
  },
  onEditMine() {
    nav.go({ url: '/pages/user/profile/profile' });
  },

  /* ---------------- 举报 ---------------- */

  // 举报这个人。理由菜单、补充说明框、以及「不会自动封号」这句提示
  // 都在 utils/report-person.js 里（私信页共用同一份），这里只发起
  //
  // 不给自己的入口加这个按钮：自己举报自己没有意义，而云端也会拒。
  // 模板里已经用 wx:if="{{!isMe}}" 挡住了，这里再挡一次是为了将来有人
  // 在别处复用这个方法时不会漏
  onReport() {
    if (this.data.isMe) return;
    const openid = this.data.openid;
    if (!openid) return;
    const nick = (this.data.alias || (this.data.profile && this.data.profile.nickName) || '');
    reportPerson.ask('profile', openid, nick);
  }
});
