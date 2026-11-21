// pages/forum/edit —— 改自己发的帖子
//
// 为什么不复用「发布内容」页：发帖是一整套新建流程（选板块、关联课程、草稿、
// 发布后跳列表），而编辑时这三样都必须锁死 —— 改内容却顺手把帖子挪到别的板块，
// 等于这条帖子凭空从原板块的历史里消失了。云函数 postEdit 也只接受
// 标题 / 正文 / 配图，不接受板块，是同一个道理。
//
// 所以这里是一个独立的小表单：三栏 + 保存，只做这一件事。
//
// 顺序是「本地先写、云端再写」：用户改这个页面的动机就是修一个错字，
// 「改了立刻看到」比「先等云端」重要。代价是要处理云端拒绝（命中屏蔽词之类）——
// 那时把原文还回去，并把拒绝理由原样说出来，不能让页面停在一个
// 「本地已改、云端没改」的中间态。
const store = require('../../../utils/store.js');
const userApi = require('../../../utils/user.js');
const upload = require('../../../utils/upload.js');
const feedback = require('../../../utils/feedback.js');
const cloud = require('../../../utils/cloud.js');

// 与发帖页 / 云函数三处对齐。任何一处单独改，界面上就会出现
// 「打了 45 个字点保存、云端只存了 40 个」或者「存了 45 个、刷新后变 40 个」
const MAX_TITLE = 60;
const MAX_CONTENT = 2000;
const MAX_IMAGES = 6;

// 整条提交链路的硬上限。改帖子不着急，慢一点没关系；
// 无上限的话用户会对着「保存中」一直等，而那和卡死没有区别
const SUBMIT_TIMEOUT_MS = 12000;

// 本次进来有没有真的改动过。用它决定「没改就退出」时能不能直接走 ——
// 进了编辑页什么都不改就退出去，不该被拦一次
function changedOf(data) {
  return String(data.title || '') !== String(data.originTitle || '')
    || String(data.content || '') !== String(data.originContent || '')
    || JSON.stringify((data.images || []).slice()) !== JSON.stringify((data.originImages || []).slice());
}

Page({
  data: {
    id: '',
    title: '',
    content: '',
    images: [],
    // 进来时的原样，留作「有没有改」的判据和云端拒绝时的回滚来源
    originTitle: '',
    originContent: '',
    originImages: [],
    // 这条帖子是什么信息（板块、作者、发布时间）—— 只展示、不可改。
    // 说清楚「不可改」比不给看强：用户至少知道东西还在
    board: '',
    author: '',
    time: '',
    // 表单状态
    leftTitle: MAX_TITLE,
    leftContent: MAX_CONTENT,
    dirty: false,
    saving: false,
    uploading: false,
    uploadPercent: 0,
    imagesLocal: false,
    // 帖子已经不在 / 不是我的：给一个明确说明，而不是一个空表单
    unavailable: '',
    loading: true
  },

  onLoad(options) {
    const id = (options && options.id) || '';
    if (!id) {
      this.setData({ unavailable: '没有指定要改哪条帖子', loading: false });
      return;
    }
    this.setData({ id: id });
    this.load();
  },

  load() {
    const p = store.getPostById(this.data.id);
    // 拿不到有两种可能：帖子真没了（别人删了 / 24 小时自动删），
    // 或者本地缓存里本来就没有（比如从别人分享的链接直接点进来）。
    // 两种都说成「帖子不在了」会误导 —— 后者其实刷新一下就好
    if (!p) {
      this.setData({ loading: false, unavailable: '这条帖子不在本机，可能已经被删除或下架了' });
      return;
    }
    if (!store.isMinePost(p)) {
      this.setData({ loading: false, unavailable: '只能改自己发的帖子' });
      return;
    }
    if (p.status === 'deleted') {
      this.setData({ loading: false, unavailable: '这条帖子已经被删除了' });
      return;
    }
    const title = String(p.title || '');
    const content = String(p.content || '');
    const images = (p.images || []).slice();
    this.setData({
      title: title,
      content: content,
      images: images,
      originTitle: title,
      originContent: content,
      originImages: images,
      board: String(p.board || ''),
      author: String(p.author || p.authorName || ''),
      time: String(p.time || ''),
      leftTitle: MAX_TITLE - title.length,
      leftContent: MAX_CONTENT - content.length,
      // 图片里有本机路径（云存储没开通时发的）要说清楚，否则改完刷新图就没了
      imagesLocal: images.some((x) => String(x).indexOf('cloud://') !== 0),
      dirty: false,
      loading: false
    });
  },

  onTitle(e) {
    const v = String(e.detail.value || '').slice(0, MAX_TITLE);
    this.setData({ title: v, leftTitle: MAX_TITLE - v.length });
    this.markDirty();
  },

  onContent(e) {
    const v = String(e.detail.value || '').slice(0, MAX_CONTENT);
    this.setData({ content: v, leftContent: MAX_CONTENT - v.length });
    this.markDirty();
  },

  // 「未保存」只在这一处判定。别在每个 onXxx 里各写一遍 ——
  // 漏一处就会退不出去，或者反过来该拦的没拦
  markDirty() {
    const dirty = changedOf(this.data);
    if (dirty !== this.data.dirty) this.setData({ dirty: dirty });
  },

  /* ---------------- 配图 ---------------- */

  async chooseImages() {
    if (this.data.uploading) {
      feedback.toast('图片还在上传，稍等一下');
      return;
    }
    const rest = MAX_IMAGES - this.data.images.length;
    if (rest <= 0) {
      feedback.toast('最多 ' + MAX_IMAGES + ' 张');
      return;
    }
    const r = await upload.pickImages(rest);
    if (!r.ok) {
      // 用户自己从相册退出来不算错误
      if (r.canceled || !r.msg) return;
      feedback.toast(r.msg);
      return;
    }
    upload.prewarm(r.files);
    await this.uploadImages(r.files);
  },

  async uploadImages(files) {
    const n = files.length;
    if (!n) return;
    this.setData({ uploading: true, uploadPercent: 0 });
    const report = (pct) => this.setData({ uploadPercent: pct });
    let done = [];
    let localHit = 0;
    try {
      const cloudOk = cloud.cfg.USE_CLOUD && cloud.ensureCloud();
      if (cloudOk) {
        const r = await upload.uploadMany(files, { prefix: 'forum', onProgress: report });
        done = r.ok;
      } else {
        // 云存储没开通就一份都不传：传一遍必然失败，白等几十秒
        done = files.slice();
      }
      localHit = done.filter((x) => String(x).indexOf('cloud://') !== 0).length;
    } catch (e) {
      console.error('[edit] uploadImages error:', e);
    } finally {
      // 无论成败都要复位：不复位的话「加图」按钮从此只剩提示，点不动
      const images = this.data.images.concat(done).slice(0, MAX_IMAGES);
      this.setData({
        images: images,
        imagesLocal: this.data.imagesLocal || localHit > 0,
        uploading: false,
        uploadPercent: 0
      });
      this.markDirty();
    }
    if (localHit) {
      feedback.toast(localHit + ' 张没传到云端，只存在本机，别人看不到');
    } else if (!done.length && files.length) {
      feedback.toast('图片没加上，正文和标题还能正常保存');
    }
  },

  removeImage(e) {
    const i = Number(e.currentTarget.dataset.i);
    if (!(i >= 0)) return;
    const images = this.data.images.slice();
    images.splice(i, 1);
    this.setData({ images: images });
    this.markDirty();
  },

  previewImage(e) {
    const list = this.data.images || [];
    if (!list.length) return;
    wx.previewImage({ current: e.currentTarget.dataset.src, urls: list });
  },

  /* ---------------- 保存 ---------------- */

  async onSave() {
    if (this.data.saving || this.data.loading || this.data.unavailable) return;
    const title = String(this.data.title || '').trim();
    const content = String(this.data.content || '').trim();
    // 两个都空等于把这条帖子删了 —— 但用户想要删的话有删除按钮，
    // 而「保存」在这里的含义是改内容，不是删内容
    if (!title && !content) {
      feedback.toast('标题和正文不能都是空的');
      return;
    }
    if (!changedOf(this.data)) {
      // 没改就不要跑一趟云端，也不要打扰用户：直接退出去就是对的
      feedback.toast('没有改动');
      wx.navigateBack();
      return;
    }

    // 本地先落：用户改这个页面就是来修一个错字的，「保存完立刻能看到」比
    // 「先等一趟云端往返」重要。updatePost 同时把原文存进 _preEdit，
    // 云端拒绝时用它回滚
    store.updatePost(this.data.id, { title: title, content: content, images: this.data.images });
    this.setData({ saving: true });
    feedback.loading('保存中');
    try {
      const r = await feedback.run({
        ms: SUBMIT_TIMEOUT_MS,
        task: userApi.postEdit(this.data.id, title, content, this.data.images),
        fallback: { ok: false, msg: '网络不太顺，没保存上' }
      });
      if (!r || r.ok === false) {
        // 云端没改成功就把本地还回去。不还的话用户会看到「改完了」，
        // 刷新一下又变回原文 —— 那比直接不让保存更难理解
        store.rollbackPost(this.data.id);
        this.load();
        feedback.toast((r && r.msg) || '没保存上，再试一次', { duration: 2600 });
        return;
      }
      // 撤掉回滚用的原文。⚠️ 不能拿 rollbackPost 代替 ——
      // 那会把内容**还原成旧值**，恰好和想要的相反
      store.commitPost(this.data.id);
      this.setData({
        originTitle: title,
        originContent: content,
        originImages: (this.data.images || []).slice(),
        dirty: false
      });
      feedback.ok('已保存');
      // 留 600ms 让「已保存」这条提示被看见再退（feedback 有延迟 + 停留）
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      console.error('[edit] onSave error:', e);
      store.rollbackPost(this.data.id);
      this.load();
      feedback.toast('没保存上，再试一次');
    } finally {
      feedback.hideLoading();
      this.setData({ saving: false });
    }
  },

// 有没改动就退 —— 直接按返回键会丢掉刚打的字，而这类损失用户根本没法察觉。
// 三个入口都得拦：顶栏返回键、页面自己的「取消」按钮、以及手机上的侧滑手势。
// 只拦前两个的话，习惯侧滑的用户会一次都没提示就丢掉半篇
onBack() {
    if (this.data.saving) {
      feedback.toast('正在保存，稍等一下');
      return;
    }
    if (!changedOf(this.data)) {
      wx.navigateBack();
      return;
    }
    // 正在弹确认框时再点一次返回：这次直接走，别叠出第二个弹窗
    if (this._asking) {
      return;
    }
    this._asking = true;
    wx.showModal({
      title: '不保存了吗',
      content: '改了的东西会丢掉。',
      confirmText: '不保存',
      confirmColor: '#dd4b55',
      success: (res) => {
        if (!res.confirm) return;
        // 这里不用回滚：保存的顺序是「本地先写、云端后写」，
        // 还没点过保存的话本地那份就没动过。
        // 唯一动过的是上传途中加进来的图 —— 那些只进了 this.data.images，
        // upload 不会自己写进 store，所以不保存就退出不会留下垃圾
        wx.navigateBack();
      },
      // complete 才是解锁的正确位置：success 只在用户「有结论」时跑，
      // 而 showModal 还有一个 fail（弹不出来）。若在 success 里解锁，
      // 弹窗失败这条路上这把锁会永久留下，返回键从此再也不管用
      complete: () => { this._asking = false; }
    });
  },

  // 侧滑 / 物理返回键的拦截点。
  //
  // 拦截的做法是：把这次返回「吃掉」（什么都不做），然后改走 onBack ——
  // 用户没改东西时立刻退回，有改动才弹确认。等价于把系统默认行为接管过来，
  // 而不是另开一条只在某个按钮上生效的路
  onBackLoad() {
    this.onBack();
  }
});