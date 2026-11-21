// pages/tool/resources/resources.js —— 学习资料共享
//
// 文件本体存云存储，云端只存元数据（resources 集合）。
// 下载走两条路：先试 wx.cloud.downloadFile（fileID 直连，不用配域名白名单），
// 失败再让云函数签临时链接兜底。哪条通了都能打开。
//
// 「感谢」是唯一的激励：个人主体不能做支付、不能搞积分提现，
// 用一句「感谢」把「白嫖党」变成「也会上传的人」最现实。
//
// 历年真题（185 份）就是走这条链路进来的：scripts/import-exam-papers.cjs
// 把它们按学生上传的格式批量写进 resources 集合。
// 所以「真题」这一档跟「笔记」「讲义」没有任何区别 ——
// 同一张表、同一个列表、同一条下载链路，页面里也没有为它留特例
const cloud = require('../../../utils/cloud.js');
const userApi = require('../../../utils/user.js');
const upload = require('../../../utils/upload.js');
const pager = require('../../../utils/pager.js');
const reportContent = require('../utils/report-content.js');

const CATS = ['笔记', '真题', '讲义', '其他'];
// 允许的资料后缀。一次最多选 9 个 —— 微信允许到 100，
// 但每份都要单独上传 + 发布，队列太长反而没人看得完
const EXTS = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'txt', 'zip'];
const MAX_FILE_SIZE = 20 * 1024 * 1024;

// 标题默认用文件名（去掉扩展名）。
// 学生选的文件名多半就是「中级财务会计期末重点.pdf」这种，
// 直接拿来当标题比让人再打一遍强；要改还能在队列里改。
// 文件名里的下划线换成空格：好多扫描件叫「xxx_期末_2023」，原样显示很糙
function titleFromName(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/_/g, ' ')
    .trim()
    .slice(0, 40);
}

// 从课程详情页跳过来时带这个参数，直接落在真题档（见 onLoad）
const PAPER_TAB = '真题';

Page({
  data: {
    cats: ['全部'].concat(CATS),
    category: '全部',
    catMap: {},
    list: [],
    // 分页：total 是筛完之后的总数，hasMore 决定触底还要不要再加一页
    total: 0,
    hasMore: false,
    // 只有真的分过页才显示「已经到底啦」（见 utils/pager.js 的 done）
    done: false,
    keyword: '',
    loading: true,
    uploading: false,
    // 上传进度（0-100）：大文件必须有，不然用户以为卡死了
    uploadPercent: 0,
    // 上传表单：分类 / 课程名 / 说明是整批共用的，所以留在 form 里
    form: { courseName: '', desc: '', category: '笔记' },
    // 待发队列：一次可以选多个文件，一个文件一条资料。
    // 标题在每个队列项里自己填（默认文件名），不再用上面那个共用的 title ——
    // 五个文件共用一个标题是没有意义的
    queue: [],
    catFormMap: {},
    showForm: false,
    // 审核员专属：待审核资料队列。普通用户不会请求这块数据。
    isMod: false,
    pendingList: [],
    pendingLoading: false
  },

  // ?tab=真题&course=某某：从课程详情页跳过来的，落在真题档并把课名填进搜索框。
  // 课名直接当关键词 —— 云端用 courseName / title 做匹配，
  // 而导入时课名就写在 title 里，这样跳过来看到的就是这门课的卷子
  onLoad(q) {
    const tab = (q && q.tab) === PAPER_TAB ? PAPER_TAB : '全部';
    const kw = String((q && q.course) || '').trim();
    this.setData({
      category: tab,
      catMap: this.buildCatMap(tab),
      catFormMap: this.buildCatFormMap('笔记'),
      keyword: kw
    });
    this.load();
    this.loadModState();
  },

  // 审核员身份以云端 whoami 为准。本地名单先亮一下，云端结果回来再覆盖；
  // 真正的权限仍在 resourceQueue / resourceReview 里复核。
  loadModState() {
    if (userApi.isModerator()) this.setData({ isMod: true });
    userApi.whoami().then((me) => {
      if (me && typeof me.isMod === 'boolean') this.setData({ isMod: !!me.isMod });
      if (this.data.isMod) this.loadPending();
    }).catch(() => {
      if (this.data.isMod) this.loadPending();
    });
  },

  async loadPending() {
    if (!this.data.isMod) return;
    this.setData({ pendingLoading: true });
    const r = await userApi.resourceQueue();
    const list = (r && r.list) || [];
    this.setData({ pendingList: list, pendingLoading: false });
  },

  // 分页器实例。必须挂在 this 上，不能挂到 Page() 那个对象字面量上 ——
  // 那是所有页面实例共享的原型，把状态放上去，第二次进这个页面会带着
  // 上一次的「已经展开到第 3 页」。
  pg() {
    return this._pager || (this._pager = pager.create());
  },

  buildCatMap(cur) {
    const m = {};
    this.data.cats.forEach((c) => { m[c] = c === cur; });
    return m;
  },

  buildCatFormMap(cur) {
    const m = {};
    CATS.forEach((c) => { m[c] = c === cur; });
    return m;
  },

  async load() {
    const list = await userApi.resourceList({
      category: this.data.category === '全部' ? '' : this.data.category,
      courseName: this.data.keyword
    });
    // 先把整批装饰好再交给分页器切页，而不是「切一页装饰一页」：
    // 后者在触底时会把上一页重新装饰一遍，一旦装饰逻辑改了，
    // 上下两页的同一条资料会长得不一样。
    const all = (list || []).map((r) => Object.assign({}, r, {
      // WXML 里不能调方法，这些派生字段都在这里算好
      catIcon: r.category === '笔记' ? 'notebook-pen' : (r.category === '真题' ? 'file-text' : (r.category === '讲义' ? 'book-open' : 'inbox')),
      ext: String(r.fileName || '').split('.').pop().toUpperCase() || '文件'
    }));
    // 切分类、改搜索词都要走 reset：换来的是全新一份列表，
    // 留着上一次的展开进度会出现「结果只有 3 条却直接全显示」
    const view = this.pg().reset(all);
    this.setData({
      list: view.list,
      total: view.total,
      hasMore: view.hasMore,
      // 只有真的分过页才显示「已经到底啦」（见 utils/pager.js 的 done）
      done: view.done,
      loading: false
    });
  },

  onReachBottom() {
    if (!this.data.hasMore) return;
    const view = this.pg().more();
    // 到底了 pager 会返回 null，这里必须直接退出：
    // 否则最后一次触底还会 setData 一次，底部那行会闪一下
    if (!view) return;
    this.setData({
      list: view.list,
      hasMore: view.hasMore,
      total: view.total,
      done: view.done
    });
  },

  onCategory(e) {
    const c = e.currentTarget.dataset.c || '全部';
    this.setData({ category: c, catMap: this.buildCatMap(c) });
    this.load();
  },

  onSearch(e) {
    const kw = e.detail.value;
    this.setData({ keyword: kw });
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.load(), 300);
  },

  /* ---------------- 上传 ---------------- */

  onToggleForm() {
    this.setData({ showForm: !this.data.showForm });
  },

  onInput(e) {
    const k = e.currentTarget.dataset.k;
    const form = Object.assign({}, this.data.form);
    form[k] = e.detail.value;
    this.setData({ form: form });
  },

  onFormCategory(e) {
    const c = e.currentTarget.dataset.c;
    const form = Object.assign({}, this.data.form, { category: c });
    this.setData({ form: form, catFormMap: this.buildCatFormMap(c) });
  },

  // 从聊天记录里选文件（PDF / Word / PPT 都能选），比相册更适合传资料。
  // 一次可以选多个 —— 期末整理资料往往是一批，让人一份份传是没道理的。
  //
  // 之前这里是 wx.chooseMessageFile({... fail: () => {} }) —— 失败被吞得干干净净，
  // 于是「点了选文件像点了块石头」。微信把这类接口归为隐私接口，
  // app.json 开了 __usePrivacyCheck__ 之后没授权会被直接拦下，
  // 现在统一走 utils/upload.js：先过隐私授权门，再逐级降级，失败必有可读原因。
  async chooseFile() {
    if (this.data.uploading) {
      wx.showToast({ title: '还在上传，稍等一下', icon: 'none' });
      return;
    }
    const r = await upload.pickFiles(EXTS, 9);
    if (!r.ok) {
      // 用户自己取消的不打扰
      if (r.canceled || !r.msg) return;
      wx.showToast({ title: r.msg, icon: 'none', duration: 2600 });
      return;
    }
    // 整批里有一个超大的就先说清楚是哪一个 ——
    // 只报「文件太大了」，用户不知道该换掉哪一个
    const big = r.files.filter((f) => f.size && f.size > MAX_FILE_SIZE);
    if (big.length) {
      wx.showToast({ title: '「' + big[0].name + '」超过 20MB', icon: 'none', duration: 2600 });
      return;
    }
    await this.uploadBatch(r.files);
  },

  // 串行上传而不是并发。资料常是几 MB 的 PDF，并发会把带宽摊薄，
  // 任何一份超时都更难复现；更关键的是「第 n/m 个」这个进度在并发下没有意义。
  // 上传成功的立刻进队列 —— 中途断网，前面传好的那些不会白传
  async uploadBatch(files) {
    if (!cloud.ensureCloud()) {
      wx.showToast({ title: '云存储未开启，传不了', icon: 'none' });
      return;
    }
    const total = files.length;
    this.setData({ uploading: true, uploadPercent: 0 });
    const queue = this.data.queue.slice();
    let failed = 0;

    for (let i = 0; i < total; i += 1) {
      const f = files[i];
      // 不带 mask：上传期间用户还想改分类、填课程名，蒙层会把整页锁死
      wx.showLoading({ title: '上传第 ' + (i + 1) + '/' + total + ' 个' });
      const ext = String(f.name || f.path || '').split('.').pop() || 'dat';
      let up;
      try {
        up = await upload.uploadFile(f.path, upload.cloudPathFor('resources', ext), (p) => {
          if (!p) return;
          this.setData({ uploadPercent: p });
        });
      } catch (e) {
        up = { ok: false, msg: '上传出错了' };
      }
      wx.hideLoading();

      if (!up || !up.ok || !up.fileID) {
        failed += 1;
        wx.showToast({
          title: '「' + String(f.name || '').slice(0, 10) + '」' + ((up && up.msg) || '上传失败'),
          icon: 'none',
          duration: 2600
        });
        continue;
      }
      queue.push({
        name: f.name || '',
        fileID: up.fileID,
        size: f.size || 0,
        // 文件名就是默认标题，省掉学生再打一遍
        title: titleFromName(f.name)
      });
      this.setData({ queue: queue });
    }

    this.setData({ uploading: false, uploadPercent: 0 });
    if (!failed) {
      wx.showToast({ title: '已就绪，确认后发布', icon: 'none' });
    } else if (!queue.length) {
      wx.showToast({ title: '一个都没传上去，再试一次', icon: 'none', duration: 2600 });
    }
  },

  // 队列里某一项改标题
  onQueueInput(e) {
    const i = Number(e.currentTarget.dataset.i);
    const q = this.data.queue.slice();
    if (!q[i]) return;
    q[i] = Object.assign({}, q[i], { title: e.detail.value });
    this.setData({ queue: q });
  },

  // 队列里某一项不想要了。文件已经传到云存储了，这里只是从待发队列里拿掉，
  // 不去删云端文件 —— 万一删错了，学生刚传的笔记就没了
  onQueueRemove(e) {
    const i = Number(e.currentTarget.dataset.i);
    const q = this.data.queue.slice();
    if (!q[i]) return;
    q.splice(i, 1);
    this.setData({ queue: q });
  },

  async onSubmit() {
    const f = this.data.form;
    const q = this.data.queue.filter((x) => x.fileID);
    if (!q.length) {
      wx.showToast({ title: '先选一个文件', icon: 'none' });
      return;
    }
    const blank = q.filter((x) => !String(x.title || '').trim());
    if (blank.length) {
      wx.showToast({ title: '给每份资料起个名字', icon: 'none', duration: 2200 });
      return;
    }

    // 逐个发布。批量上传的价值就在于「一次选一批」，
    // 所以这里也必须是一条条发出去，而不是只发第一个
    wx.showLoading({ title: '发布中（共 ' + q.length + ' 份）', mask: true });
    const done = [];
    let failed = 0;
    for (let i = 0; i < q.length; i += 1) {
      const item = q[i];
      const r = await userApi.resourceAdd({
        title: String(item.title).trim(),
        desc: f.desc,
        category: f.category,
        courseName: f.courseName,
        fileID: item.fileID,
        fileName: item.name,
        size: item.size
      });
      if (r && r.ok !== false) done.push(i);
      else failed += 1;
    }
    wx.hideLoading();

    // 只清掉发出去的那些，失败的留在队列里 —— 让人能接着重发，不用重新选文件。
    // 课程名和分类留着：同一批资料往往就是同一门课，再传一批时不用重选
    if (failed) {
      const left = this.data.queue.filter((x, i) => done.indexOf(i) < 0);
      this.setData({ queue: left });
      wx.showToast({
        title: '发出 ' + done.length + ' 份，' + failed + ' 份失败（还在列表里）',
        icon: 'none',
        duration: 3000
      });
    } else {
      this.setData({ queue: [], showForm: false, form: Object.assign({}, f, { desc: '' }) });
      wx.showToast({
        title: '已提交 ' + done.length + ' 份，审核通过后公开',
        icon: 'none',
        duration: 3000
      });
    }
    if (done.length) {
      this.load();
      if (this.data.isMod) this.loadPending();
    }
  },

  /* ---------------- 下载 / 感谢 ---------------- */

  async onOpen(e) {
    const item = this.data.list[e.currentTarget.dataset.i];
    return this.openItem(item);
  },

  onOpenPending(e) {
    const item = this.data.pendingList[e.currentTarget.dataset.i];
    return this.openItem(item);
  },

  async openItem(item) {
    if (!item) return;
    // 待审核 / 未通过的文件是审核员或作者在看，不计入公开浏览数
    if (!item.status || item.status === 'normal') {
      userApi.contentView('resource', item.id).catch(() => {});
    }
    wx.showLoading({ title: '打开中', mask: true });
    // 先直连 fileID：云开发通道，不需要配域名白名单
    let path = await wx.cloud.downloadFile({ fileID: item.fileID })
      .then((r) => r.tempFilePath)
      .catch(() => '');
    // 兜底：让云函数签一个临时链接（文件权限收紧时也打得开）
    if (!path) {
      const r = await userApi.resourceUrl(item.id);
      if (!r || !r.url) {
        wx.hideLoading();
        wx.showToast({ title: '这个文件打不开了', icon: 'none' });
        return;
      }
      const d = await wx.downloadFile({ url: r.url }).catch(() => null);
      path = d && d.tempFilePath ? d.tempFilePath : '';
    }
    wx.hideLoading();
    if (!path) {
      wx.showToast({ title: '下载失败', icon: 'none' });
      return;
    }
    wx.openDocument({
      filePath: path,
      fileType: this.guessType(item.fileName),
      showMenu: true,
      fail: () => wx.showToast({ title: '这个文件类型打不开', icon: 'none' })
    });
  },

  guessType(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'pdf';
    if (['doc', 'docx'].indexOf(ext) >= 0) return 'doc';
    if (['xls', 'xlsx'].indexOf(ext) >= 0) return 'xls';
    if (['ppt', 'pptx'].indexOf(ext) >= 0) return 'ppt';
    return '';
  },

  async onThanks(e) {
    const i = e.currentTarget.dataset.i;
    const item = this.data.list[i];
    if (!item || item.isMine) return;
    const r = await userApi.resourceThanks(item.id);
    if (r && r.ok !== false) {
      const list = this.data.list.slice();
      list[i] = Object.assign({}, item, {
        thanked: !!r.thanked,
        thanksCount: r.thanksCount || (item.thanked ? item.thanksCount - 1 : item.thanksCount + 1)
      });
      this.setData({ list: list });
    }
  },

  onReport(e) {
    const item = this.data.list[e.currentTarget.dataset.i];
    if (!item || item.isMine) return;
    reportContent.ask(item.id, 'resource', {
      openid: item.openid || '',
      onDone: (r) => { if (r && r.action === 'hide') this.load(); }
    });
  },

  onRemove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删掉这份资料？',
      content: '已经下载过的同学不受影响',
      success: async (r) => {
        if (!r.confirm) return;
        await userApi.resourceRemove(id);
        this.load();
        if (this.data.isMod) this.loadPending();
      }
    });
  },

  // 通过 / 驳回：审核动作不可逆，先二次确认；驳回必须留下原因给作者看。
  onApproveResource(e) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    wx.showModal({
      title: '通过这份资料？',
      content: '通过后会立即对所有同学公开。',
      confirmText: '通过',
      success: async (res) => {
        if (!res.confirm) return;
        const r = await userApi.resourceReview(id, 'approve', '');
        if (!r || r.ok === false) {
          wx.showToast({ title: (r && r.msg) || '审核没生效', icon: 'none' });
          return;
        }
        this.setData({ pendingList: this.data.pendingList.filter((x) => x.id !== id) });
        this.load();
        wx.showToast({ title: '已通过', icon: 'none' });
      }
    });
  },

  onRejectResource(e) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    wx.showModal({
      title: '驳回这份资料',
      content: '',
      editable: true,
      placeholderText: '填写原因，会通知上传者',
      confirmText: '驳回',
      confirmColor: '#d9534f',
      success: async (res) => {
        if (!res.confirm) return;
        const reason = String(res.content || '').trim();
        if (!reason) {
          wx.showToast({ title: '写一句驳回原因', icon: 'none' });
          return;
        }
        const r = await userApi.resourceReview(id, 'reject', reason);
        if (!r || r.ok === false) {
          wx.showToast({ title: (r && r.msg) || '审核没生效', icon: 'none' });
          return;
        }
        this.setData({ pendingList: this.data.pendingList.filter((x) => x.id !== id) });
        wx.showToast({ title: '已驳回', icon: 'none' });
      }
    });
  },

  onShareAppMessage() {
    return {
      title: '商砖小站 · 学长学姐的笔记和真题都在这儿',
      path: '/pages/tool/resources/resources'
    };
  }
});
