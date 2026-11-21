// sub/course/teacher/teacher —— 某位老师的评价页
//
// 老师评价没有独立入口（tabBar 满了），从课程详情页的「老师评价」进。
// 这里看的是这位老师在这门课上的口碑；同学写评价时补了任课老师，
// 别门课里出现的同名评价也会一并列出来，方便判断「是不是同一个人」。
const store = require('../../../utils/store.js');
const userApi = require('../../../utils/user.js');
const nav = require('../../../utils/nav.js');
const cloud = require('../../../utils/cloud.js');
const feedback = require('../../../utils/feedback.js');
const reportContent = require('../../utils/report-content.js');

Page({
  data: {
    showBackTop: true,
    name: '',
    // 自定义导航条（app-header）的标题，同一份名字不再调一次 setNavigationBarTitle
    navTitle: '老师评价',
    courseId: '',
    courseName: '',
    reviews: [],
    otherReviews: [],
    avg: 0,
    avgRound: 0,
    courseAvg: 0,
    scoredCount: 0,
    scoreCount: 0,
    count: 0,
    otherCount: 0,
    verified: false,
    college: '',
    loading: true,
    // 审核员才看得到「全部下架」：老师本人投诉到邮箱、核实之后用
    isMod: false,
    modBusy: false
  },

  onLoad(query) {
    this.setData({
      name: decodeURIComponent((query && query.name) || ''),
      courseId: (query && query.courseId) || ''
    });
    this.load();
  },

  onShow() {
    if (this.data.name) this.load();
  },

  onPullDownRefresh() {
    const done = () => { try { wx.stopPullDownRefresh(); } catch (e) {} };
    this.load().then(done).catch(done);
  },

  async load() {
    const name = this.data.name;
    if (!name) {
      this.setData({ loading: false });
      return;
    }
    // 身份能提前拿到就顺手拿到：审核员按钮要靠它判定。
    // 拿不到也不拖累整页（名单比对直接判否，按钮不出现）
    let oid = '';
    try {
      oid = cloud.getOpenid() || (await cloud.fetchOpenid().catch(() => '')) || '';
    } catch (e) { oid = cloud.getOpenid() || ''; }
    const here = store.getReviewsByTeacher(name, this.data.courseId);
    const all = store.getReviewsByTeacher(name, '');
    const other = all.filter((r) => r.courseId !== this.data.courseId);

    // 老师分和课程分分开算：课好老师差的情况很常见，混在一起这位老师就永远看不出问题。
    // 只统计 teacherScore>0 的那些（老评价没有这个字段，一律按没打分处理）。
    const scored = all.filter((r) => (Number(r.teacherScore) || 0) > 0);
    const avg = this.avgOf(scored.map((r) => Number(r.teacherScore) || 0));
    // 未评分（score=0）只展示正文，不能进入课程均分
    const courseAvg = this.avgOf(all
      .map((r) => Number(r.score) || 0)
      .filter((v) => v > 0));

    // 名录里查一下这位：官方名录抓下来的才打勾，同学自己加的不算
    let verified = false;
    let college = '';
    try {
      const list = await userApi.teacherList(name, '');
      const hit = list.filter((t) => t.name === name)[0];
      if (hit) { verified = true; college = hit.college || ''; }
    } catch (e) {}

    this.setData({
      navTitle: name || '老师评价',
      reviews: here.map((r) => this.decorateReview(r)),
      otherReviews: other.slice(0, 10).map((r) => this.decorateReview(r)),
      courseName: here.length && here[0].courseName ? here[0].courseName : '',
      avg: avg,
      avgRound: Math.round(avg),
      courseAvg: courseAvg,
      scoredCount: scored.length,
      scoreCount: all.length,
      count: here.length,
      otherCount: other.length,
      verified: verified,
      college: college,
      // 用真实 openid 判定（见 mine.js 的注释）：本地资料里的 openid 可能是
      // 换设备之前留下的旧值，拿它比对名单会误判
      isMod: userApi.isModerator({ openid: oid }),
      loading: false
    });
    wx.setNavigationBarTitle({ title: name });
  },

  /* ---------------- 举报评价 ---------------- */

  // 老师页以前一个举报入口都没有，而这里恰恰是全校骂人最集中的地方：
  // 同学刷到一条造谣的评价只能划走。两个列表（本课的 / 其他课的）共用这一个入口。
  //
  // ⚠️ 匿名评价照样能举报 —— 作者由云端按内容认定，前端拿不到 openid 也照样提交
  onReportReview(e) {
    const id = e.currentTarget.dataset.id;
    const rv = (this.data.reviews || []).concat(this.data.otherReviews || [])
      .filter((x) => x.id === id)[0];
    if (!rv || rv.isMine) return;
    reportContent.ask(id, 'review', {
      openid: rv.openid || '',
      // 服务端当场下架 / 删除时刷新，不然举报完内容还在，像是没生效
      onDone: (r) => {
        if (r.action === 'hide' || r.action === 'delete') this.load();
      }
    });
  },

  /* ---------------- 老师本人投诉的处理（仅审核员） ---------------- */

  // ⚠️ 这是不可撤销的批量动作，所以点下去先问一遍、说清后果。
  // 下架不是删除：原文一律保留，老师撤回投诉或学生申诉时可以直接恢复展示 ——
  // 正因为可逆，才敢做成一键
  onHideAllReviews() {
    const name = this.data.name;
    if (!name || this.data.modBusy) return;
    wx.showModal({
      title: '下架 ' + name + ' 的评价',
      content: '把这位老师名下所有评价一次性设为不展示。原文会全部保留，'
        + '老师撤回投诉或同学申诉时可以直接恢复。确定吗？',
      confirmText: '全部下架',
      confirmColor: '#e5484d',
      cancelText: '再想想',
      success: (res) => { if (res.confirm) this.doHideAll(); }
    });
  },

  async doHideAll() {
    this.setData({ modBusy: true });
    feedback.loading('正在下架…', true);
    try {
      const r = await userApi.teacherHideReviews(this.data.name, '老师本人投诉');
      if (!r || r.ok === false) {
        feedback.toast((r && r.msg) || '没下架成，请重试');
        return;
      }
      feedback.toast(r.msg || '已下架');
      this.load();
    } catch (e) {
      feedback.toast('网络不稳，还没下架');
    } finally {
      feedback.hideLoading();
      this.setData({ modBusy: false });
    }
  },

  // WXML 里不能四舍五入，展示用的数值在这里一次算好
  avgOf(list) {
    if (!list.length) return 0;
    return Math.round((list.reduce((s, v) => s + v, 0) / list.length) * 10) / 10;
  },

  // 一条评价里两档分并存：老师分和课程分，没打老师分的只显示课程分
  decorateReview(r) {
    const t = Number(r.teacherScore) || 0;
    const c = Number(r.score) || 0;
    return Object.assign({}, r, {
      // ⚠️ 少了这一条，卡片上的「举报」会连自己的评价也显示出来 ——
      // 自己举报自己，攒够两票还能把自己的评价自动下架
      isMine: store.isMineReview(r),
      hasTeacherScore: t > 0,
      hasCourseScore: c > 0,
      teacherStarOn: t,
      starOn: c,
      scoreText: t > 0 ? t.toFixed(1) : '',
      courseText: c > 0 ? c.toFixed(1) : ''
    });
  },

  goCourse(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    nav.go({ url: '/sub/course/detail/detail?id=' + id });
  },

  goReview() {
    // 没有课程上下文就别把人挡在门外 —— 老逻辑在这里弹一句「这门课没有对应的课程」
    // 然后什么都不做，点主按钮的人只会以为软件坏了。退化成「只评老师」照样能写
    if (!this.data.courseId || !this.data.courseName) {
      this.goReviewOnly();
      return;
    }
    // 老师名带过去：同学点的是「写对这位老师的评价」，
    // 到了页面还要他重新打一遍名字，等于把人挡在门外
    nav.go({
      url: '/sub/course/review/review?id=' + this.data.courseId
        + '&teacher=' + encodeURIComponent(this.data.name)
    });
  },

  // 独立入口（第 8 点）：只评老师，不挂课程。
  // 老路径要求必须有 courseId，从「老师评价」总榜点进来的人
  // （那里只有人名、没有课程）会被一句「这门课没有对应的课程」挡在门外
  goReviewOnly() {
    const name = String(this.data.name || '').trim();
    if (!name) {
      wx.showToast({ title: '这位老师的名字还没拿到', icon: 'none' });
      return;
    }
    nav.go({
      url: '/sub/course/review/review?mode=teacher&teacher=' + encodeURIComponent(name)
    });
  },

  onShareAppMessage() {
    const n = this.data.name || '老师';
    return {
      title: '商砖小站 · ' + n + ' 的课程评价',
      path: '/sub/course/detail/detail?id=' + this.data.courseId
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
