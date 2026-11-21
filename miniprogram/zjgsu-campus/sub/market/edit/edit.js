// sub/market/edit/edit.js —— 发布失物 / 招领 / 二手
// 图片必须上传到云存储换成 fileID：本地临时路径换设备就没了，别人也打不开。
const cloud = require('../../../utils/cloud.js');
const feedback = require('../../../utils/feedback.js');
const market = require('../../../utils/market.js');
const store = require('../../../utils/store.js');
const upload = require('../../../utils/upload.js');

const MAX_IMAGES = 6;
// 「我要发的是」四档。前三档和云端 MARKET_TYPES 一一对应，第四档是**派生档**：
// 课程互存在库里仍是 type=sell + category=substitute（云端 type 白名单只有三种，
// 硬加一种就得让云函数、筛选、统计全跟着改），只是发布时给它一个自己的入口 ——
// 让同学在「我要发的是」这一步就能选到，而不是先点闲置、再往下找分类。
const TYPES = [
  { key: 'lost', label: '我丢了东西', icon: 'search' },
  { key: 'found', label: '我捡到东西', icon: 'inbox' },
  { key: 'sell', label: '闲置分享', icon: 'shopping-bag️' },
  { key: 'substitute', label: '课程互助', icon: 'users-round' }
];

// 课程互存的分类 key，只在这里出现一次：顶上那一格、分类胶囊、落库都用它
const SUBSTITUTE_CAT = 'substitute';

// 分类胶囊里不再重复「课程互助」—— 它已经是顶上一格了，同一屏出现两次
// 会让人以为两个选的是不同的东西（列表页的筛选栏也是同一个处理）
const CATS = market.CATEGORIES.filter((c) => c.key !== SUBSTITUTE_CAT);

function catMap(current) {
  const m = {};
  market.CATEGORIES.forEach((c) => { m[c.key] = c.key === current; });
  return m;
}

Page({
  data: {
    types: TYPES,
    // type 是**落库**用的（只有 lost / found / sell 三种，云端按它校验）
    type: 'lost',
    // pickType 是**界面**上的那四格之一。课程互助时 type 仍是 sell，
    // 所以光看 type 分不出「闲置分享」和「课程互助」哪一格该亮，得单独记一个
    pickType: 'lost',
    typeMap: { lost: true, found: false, sell: false, substitute: false },
    title: '',
    desc: '',
    location: '',
    price: '',
    contact: '',
    contactType: 'phone',
    contactTypes: [
      { key: 'phone', label: '手机号' },
      { key: 'wechat', label: '微信号' },
      { key: 'qq', label: 'QQ号' },
      { key: 'other', label: '其他' }
    ],
    contactTypeMap: { phone: true, wechat: false, qq: false, other: false },
    images: [],
    uploading: false,
    showPrice: false,
    // 闲置分类（教材 / 数码 / 生活 / 其他）+ 教材对应的课程名
    cats: CATS,
    category: 'other',
    catMap: catMap('other'),
    courseName: '',
    showCategory: false
  },

  onLoad(options) {
    const t = options.type || 'lost';
    if (market.TYPES[t]) this.setType(t);
    // 从列表页「课程互助」那一档点「＋」进来：直接点亮顶上那一格。
    // 不带这个参数时保持原样 —— 默认「我丢了东西」，分类默认「其他」
    const cat = String(options.cat || '');
    if (cat === SUBSTITUTE_CAT) {
      this.setType(SUBSTITUTE_CAT);
    } else if (cat && market.CATEGORIES.some((c) => c.key === cat)) {
      this.setData({ category: cat, catMap: catMap(cat) });
    }
    // 带上自己的联系方式默认值，减少一次输入
    const u = store.getUser();
    if (u && u.nickName) this.setData({ contact: u.contact || '' });

    // 从草稿箱进来：草稿里的联系方式要覆盖上面的默认值，所以放在它后面
    if (options.draftId) {
      const d = store.getDraft(options.draftId);
      if (d) {
        if (market.TYPES[d.board]) this.setType(d.board);
        // 草稿里记着分类：课程互助的那篇要回到「课程互助」那一格，
        // 不能只按 board=sell 恢复成普通闲置
        if (d.category === SUBSTITUTE_CAT) this.setType(SUBSTITUTE_CAT);
        this.setData({
          title: d.title || '',
          desc: d.content || '',
          location: d.location || '',
          price: d.price || '',
          contact: d.contact || ''
        });
      }
    }
  },

  // 选中「我要发的是」里的某一格。
  // 课程互助不是第四种 type，它是「闲置 + 分类=课程互助」的一个入口，
  // 所以这里把界面态（pickType）和落库态（type）分开写：
  //   · type 只会是 lost / found / sell（云端白名单就这三种）
  //   · pickType 才是那四格里亮哪一格
  setType(t) {
    const chip = TYPES.some((x) => x.key === t) ? t : 'lost';
    const isSub = chip === SUBSTITUTE_CAT;
    // 课程互助落库是 sell：云端按 MARKET_TYPES 校验，多一种 type 会静默变「寻物」
    const real = isSub ? 'sell' : chip;

    const typeMap = {};
    TYPES.forEach((x) => { typeMap[x.key] = x.key === chip; });
    const contactTypeMap = {};
    const ct = this.data.contactType;
    ['phone', 'wechat', 'qq', 'other'].forEach((k) => { contactTypeMap[k] = k === ct; });

    // 从课程互助切回闲置分享时把分类退回「其他」：
    // 不然顶上亮着「闲置分享」、下面分类亮着「课程互助」，两个自相矛盾
    let category = this.data.category;
    if (isSub) category = SUBSTITUTE_CAT;
    else if (category === SUBSTITUTE_CAT) category = 'other';

    this.setData({
      type: real,
      pickType: chip,
      typeMap,
      contactTypeMap,
      // 课程互助没有「参考价」，也不需要再选分类（分类就是它自己）
      showPrice: real === 'sell' && !isSub,
      showCategory: real === 'sell' && !isSub,
      category,
      catMap: catMap(category)
    });
  },

  onCategory(e) {
    const k = e.currentTarget.dataset.k || 'other';
    this.setData({ category: k, catMap: catMap(k) });
  },

  onType(e) {
    this.setType(e.currentTarget.dataset.k);
  },

  onContactType(e) {
    const k = e.currentTarget.dataset.k;
    const contactTypeMap = {};
    ['phone', 'wechat', 'qq', 'other'].forEach((x) => { contactTypeMap[x] = x === k; });
    this.setData({ contactType: k, contactTypeMap });
  },

  onInput(e) {
    const k = e.currentTarget.dataset.k;
    const patch = {};
    patch[k] = e.detail.value;
    this.setData(patch);
  },

  /* ---------------- 图片 ---------------- */

  // 选图统一走 utils/upload.js：隐私授权门 → chooseMedia → chooseImage 逐级降级，
  // 失败一定给可读原因。以前这里是全项目唯一绕过统一层的地方
  // （自己写 chooseMedia + fail: () => {}），隐私未授权时点「加图」纯静默。
  async chooseImages() {
    if (this.data.uploading) return;
    const rest = MAX_IMAGES - this.data.images.length;
    if (rest <= 0) {
      wx.showToast({ title: '最多 ' + MAX_IMAGES + ' 张', icon: 'none' });
      return;
    }
    const r = await upload.pickImages(rest);
    if (!r.ok) {
      // 用户自己退出相册不打扰；其余情况给一句能照着做的原因
      if (r.canceled || !r.msg) return;
      wx.showToast({ title: r.msg, icon: 'none', duration: 2600 });
      return;
    }
    // 后台预热压缩：用户还要填标题、描述、价格，压缩趁这段时间做完
    upload.prewarm(r.files);
    this.uploadImages(r.files);
  },

  async uploadImages(files) {
    if (!cloud.ensureCloud()) {
      wx.showToast({ title: '云存储未开启，图片这次发不出去', icon: 'none' });
      return;
    }
    this.setData({ uploading: true });
    // 不带 mask：带上会挡住输入，用户选完图想接着填描述却被蒙层挡几秒，
    // 那种「卡住」的体感比真的慢还难受。百分比照常显示，只是不锁屏
    wx.showLoading({ title: '上传中 0%' });
    try {
      // 走统一上传层：先按需压缩（大图降分辨率 + 70% 质量）→ 并发 3 个一组传 →
      // 超时按体积动态给（小图早失败、大文件不误杀）。
      // 以前这里是全项目唯一裸调 wx.cloud.uploadFile 的地方：没有超时、没有压缩、
      // 没有进度，一张大图卡住就一直转圈，也没有失败原因。
      const r = await upload.uploadMany(files, {
        prefix: 'market',
        onProgress: (pct) => wx.showLoading({ title: '上传中 ' + pct + '%' })
      });
      const done = r.ok;
      wx.hideLoading();
      this.setData({ images: this.data.images.concat(done), uploading: false });
      if (files.length && !done.length) {
        wx.showToast({ title: '图片上传失败，仍可发布', icon: 'none' });
      } else if (r.failed) {
        wx.showToast({ title: r.failed + ' 张没传上去，其余已就绪', icon: 'none', duration: 2200 });
      }
    } catch (e) {
      // 兜底：无论出什么错都要收掉遮罩，否则整页按钮全部失灵
      wx.hideLoading();
      this.setData({ uploading: false });
      wx.showToast({ title: '图片上传出错，仍可发布', icon: 'none' });
    }
  },

  removeImage(e) {
    const i = e.currentTarget.dataset.i;
    const images = this.data.images.slice();
    images.splice(i, 1);
    this.setData({ images });
  },

  /* ---------------- 保存 ---------------- */

  async onSubmit() {
    if (this.data.uploading) {
      wx.showToast({ title: '图片还在上传', icon: 'none' });
      return;
    }
    const d = this.data;
    if (!d.title.trim()) {
      wx.showToast({ title: '标题不能为空', icon: 'none' });
      return;
    }
    if (!d.contact.trim()) {
      wx.showToast({ title: '留个联系方式，别人才找得到你', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '发布中', mask: true });
    const r = await market.addMarket({
      type: d.type,
      title: d.title,
      desc: d.desc,
      location: d.location,
      // 没显示参考价的时候一律不带上：课程互助/寻物/招领都不该带价格，
      // 否则用户先在闲置档填了 ¥、再切到别的档，那串数字会跟着发出去
      price: d.showPrice ? d.price : '',
      contact: d.contact,
      contactType: d.contactType,
      category: d.type === 'sell' ? d.category : 'other',
      // 课程名只属于「教材」那一档（列表里显示成「教材 · 高等数学」）：
      // 切到数码 / 生活 / 课程互助之后，之前给教材填的课名不能跟着发出去
      courseName: d.category === 'book' ? d.courseName : '',
      images: d.images,
      author: store.getUser().nickName
    });
    // 云端没接受就不说「已发布」—— 以前这里无条件弹成功，
    // 结果发出去的东西只有本机看得见，别人永远刷不到。
    // feedback.toast 会先把 Loading 收掉再弹（同时弹会互相覆盖，等于没提示）
    if (!r || !r.ok) {
      feedback.toast((r && r.msg) || '发布失败，请稍后重试');
      return;
    }
    feedback.toast('已发布', { icon: 'success' });
    setTimeout(() => wx.navigateBack(), 600);
  },

  // 草稿：写一半退出去，回来还在
  async onDraft() {
    const d = this.data;
    if (!store.hasDraftText({ title: d.title, content: d.desc })) return;
    store.saveDraft({
      type: 'market',
      board: d.type,
      // 分类要一起存：课程互助的 board 也是 sell，只存 board 的话
      // 草稿恢复回来会变成普通「闲置分享」，那一格亮错了
      category: d.category,
      title: d.title,
      content: d.desc,
      location: d.location,
      price: d.showPrice ? d.price : '',
      contact: d.contact
    });
    wx.showToast({ title: '草稿已保存', icon: 'success' });
  }
});
