// pages/tool/places/places.js —— 校园地点
//
// 不做底图，只做「地点列表 + 一键在地图里看」：
//   ① 手画底图要找图、要标注，成本高还容易过期；
//   ② 经纬度一律用 wx.chooseLocation 在真实地图上点出来，
//      手写坐标一定会偏，openLocation 会把同学导航到隔壁学校去。
const userApi = require('../../../utils/user.js');
// 搜索口径与校园页那一档共用一份，别在这儿重写一遍
const placeSearch = require('../../../utils/place-search.js');

const CATS = ['教学楼', '食堂', '宿舍', '快递', '运动', '其他'];

// chooseLocation 失败原因翻译成人话。
// 这个接口要真机可用，缺一不可：
//   ① app.json 的 requiredPrivateInfos 里声明 "chooseLocation"；
//   ② app.json 的 permission.scope.userLocation 里写清用途（desc）——
//      少了这条，微信会直接弹「需要在 app.json 中声明 permission scope.userLocation 字段」，
//      而且连授权框都不给你弹，功能根本用不了；
//   ③ mp 后台「开发管理 → 接口设置」开通位置相关接口；
//   ④ 用户在弹窗里同意（走 utils/privacy.js 的授权链路）。
// 任何一条缺了，失败信息都塞在 errMsg 里，这里统一翻成人话。
// 详见 ../../../../docs/miniprogram-docs/PRIVACY-CHECKLIST.md。
function locateReason(err) {
  const m = String((err && err.errMsg) || err || '').toLowerCase();
  if (m.indexOf('requiredprivateinfos') >= 0) return '选择位置功能暂不可用，请反馈给管理员';
  // 工程侧漏声明：这不是用户能修的，别把工程 bug 说成「你没给权限」
  if (m.indexOf('app.json') >= 0 || m.indexOf('scope.userlocation') >= 0) {
    return '定位功能暂不可用，请联系管理员';
  }
  if (m.indexOf('privacy') >= 0) return '需要先同意隐私保护指引才能选择位置';
  if (m.indexOf('auth') >= 0 || m.indexOf('permission') >= 0) return '没拿到位置权限，去微信设置里开一下';
  if (m.indexOf('not support') >= 0) return '这台设备的微信版本太老，用不了地图选点';
  return '地图没打开，稍后再试';
}

// 关键词匹配：名字 / 简介 / 地址 / 分类，四个字段任一命中就算。
// 空格分开的多个词要**每个都**命中 —— 「2号 教学楼」本来就该找到「2 号教学楼」，
// 只认第一个词的话，这种最顺手的输入方式反而搜不到。
// 统一转小写：楼栋里的字母（A 座）和英文缩写，两种输入习惯都得能命中。
//
// 匹配口径本身在 utils/place-search.js —— 校园页那一档也在用它，
// 两处各写一份就会出现「同一个词，两个页面搜出来的不一样」

// 分类 → 卡片图标，写在这里是为了让「列表」和「地图标记」用同一套口径
function catIconOf(p) {
  return p.category === '教学楼' ? 'graduation-cap' : (p.category === '食堂' ? 'utensils'
    : (p.category === '宿舍' ? 'home' : (p.category === '快递' ? 'inbox'
      : (p.category === '运动' ? 'dumbbell' : 'pin'))));
}

Page({
  data: {
    cats: ['全部'].concat(CATS),
    category: '全部',
    catMap: {},
    list: [],
    loading: true,
    // 搜索框。关键词与分类**互斥**：有词时跨全部分类找，
    // 因为想找「2 号教学楼」的人不会先想它属于哪个分类。
    keyword: '',
    hasKeyword: false,
    // 地图中心单独存，不直接用 list[0]：
    // 没搜到结果时地图不该跟着空掉，还停在原来的位置（见 applyFilter）
    mapCenter: { latitude: 0, longitude: 0 },
    // 库里到底有没有地点。地图的显隐看这个，不看当前筛选结果
    hasAny: false,
    showForm: false,
    form: { name: '', category: '其他', desc: '', address: '', latitude: 0, longitude: 0 },
    catFormMap: {},
    picked: false,
    // 地图标记由 load() 从 list 的经纬度算出来；markerId 和 list 下标一一对应
    markers: [],
    // 半屏抽屉：点列表项 / 点地图标记时打开，里面选「步行路线 / 呼叫校车」
    navOpen: false,
    sheetPlace: null,
    // 有 add=1 进来时才置真：保存成功后自动退回上一页。
    // 从校园页 ➕ 进来的人是「补一个就走」，加完停在这张空表单上等于没走完
    backOnSave: false,
    // 地图上要不要画「你在哪儿」那个点。默认不画 —— map 的 show-location
    // 一渲染就去要位置权限，第一次进来的人还没点任何东西就被弹一个授权框。
    // 已经授过权的（比如刚用地图选过点）才打开，见 checkLocAuth
    showLoc: false
  },

  onLoad(options) {
    const q = options || {};
    // 「补充一个地点」这张卡自己也在本页，从别处带着 add=1 进来就替他摊开，
    // 省掉「先找到入口、再点开」那两步
    const open = String(q.add) === '1';
    // 分类跟着来源页当前选的那一栏走。不在既定六个分类里的参数一律不认 ——
    // catFormMap 是按 CATS 建的下标 map，塞个没见过的字符串进去会全都不选中
    const cat = CATS.indexOf(q.cat) >= 0 ? q.cat : '其他';
    this.setData({
      catMap: this.buildMap('全部', this.data.cats),
      catFormMap: this.buildMap(cat, CATS),
      showForm: open,
      backOnSave: open,
      form: Object.assign({}, this.data.form, { category: cat })
    });
    this.load();
    this.checkLocAuth();
    if (open) setTimeout(() => this.scrollFormIntoView(), 320);
  },

  // 静默查一次位置授权，**不弹任何框**：已授权就把定位点打开，
  // 没授过就保持关闭，等他自己去地图选点（那一刻微信会正式问他一次）。
  // 为什么不用 wx.getLocation 来判断：那是一次真正的定位调用，
  // 既要多声明一个 getLocation，又会在用户没点任何东西时就去读位置。
  checkLocAuth() {
    if (!wx.getSetting) return;
    wx.getSetting({
      success: (res) => {
        const granted = !!(res && res.authSetting && res.authSetting['scope.userLocation']);
        if (granted) this.setData({ showLoc: true });
      },
      fail: () => { /* 查不到就当没授权，不影响任何功能 */ }
    });
  },

  // 表单在页面里排在地图和分类/列表之间，从校园页 ➕ 进来的人落在页头，
  // 一眼看到的是地图而不是要填的东西 —— 直接替他滚过去。
  // 自己在本页点「补充一个地点」时不滚：那一眼看到的就是他自己点的按钮，
  // 滚一下反而会把刚看的位置挪走。
  scrollFormIntoView() {
    if (!wx.createSelectorQuery) return;
    wx.createSelectorQuery()
      .select('.pl-form')
      .boundingClientRect()
      .selectViewport()
      .scrollOffset()
      .exec((res) => {
        const box = res && res[0];
        if (!box) return; // 表单没渲染出来就算了，不值得为它把页面搞崩
        const cur = (res[1] && res[1].scrollTop) || 0;
        wx.pageScrollTo({ scrollTop: cur + box.top - 12, duration: 200 });
      });
  },

  buildMap(cur, list) {
    const m = {};
    (list || []).forEach((c) => { m[c] = c === cur; });
    return m;
  },

  // 一次把全量拉回来（云端上限 100 条，校园地点远不到这个量级），
  // 分类和关键词都留在本地过，好处有两个：
  //   ① 搜索不会被当前分类卡住；
  //   ② 切分类不用再发一次请求，按一下就换。
  async load() {
    this.setData({ loading: true });
    const list = await userApi.placeList('', '');
    this._all = list || [];
    this.applyFilter();
  },

  applyFilter() {
    const all = this._all || [];
    const kw = String(this.data.keyword || '').trim();
    // 「有关键词就跨分类」这条口径在 filterPlaces 里，校园页那一档用的是同一个函数
    const list = placeSearch.filterPlaces(all, this.data.category, kw)
      .map((p) => Object.assign({}, p, { catIcon: catIconOf(p) }));

    // 有结果就对准第一条，一条都没有就退回全量的第一条：
    // 地图是这一页的锚点，不该因为一次没搜到就整块变空
    const anchor = list[0] || all[0] || null;
    this.setData({
      list: list,
      hasAny: all.length > 0,
      mapCenter: {
        latitude: Number(anchor && anchor.latitude) || 0,
        longitude: Number(anchor && anchor.longitude) || 0
      },
      loading: false,
      markers: this.buildMarkers(list)
    });
    // 本地数据为空 / 搜索零命中时，向云端按关键词再查一次。
    // 这样即使首屏 placeList 没拉下来，输入关键词仍然有救。
    if (kw && !list.length && this._kwTried !== kw) this.fetchRemoteKeyword(kw);
  },

  fetchRemoteKeyword(kw) {
    if (this._kwFetching === kw) return;
    this._kwFetching = kw;
    this._kwTried = kw;
    if (this._kwTimer) clearTimeout(this._kwTimer);
    this._kwTimer = setTimeout(async () => {
      const remote = await userApi.placeList('', kw);
      if (String(this.data.keyword || '').trim() !== kw) return;
      if (remote && remote.length) {
        const map = {};
        (this._all || []).forEach((p) => { if (p && (p.id || p.name)) map[p.id || p.name] = p; });
        remote.forEach((p) => { if (p && (p.id || p.name)) map[p.id || p.name] = p; });
        this._all = Object.keys(map).map((k) => map[k]);
        this._kwFetching = '';
        this.applyFilter();
      } else {
        this._kwFetching = '';
      }
    }, 300);
  },

  // map 组件的 markers 只认数字 id，所以这里用「下标 + 1」当 markerId，
  // onMarkerTap 再按这个 id 反查回地点
  buildMarkers(list) {
    return (list || []).map((p, i) => ({
      id: i + 1,
      latitude: Number(p.latitude) || 0,
      longitude: Number(p.longitude) || 0,
      name: p.name || '',
      width: 32,
      height: 32
    })).filter((m) => m.latitude && m.longitude);
  },

  placeByMarkerId(markerId) {
    const p = this.data.list[Number(markerId) - 1];
    return p || null;
  },

  openSheet(p) {
    if (!p) return;
    this.setData({ sheetPlace: p, navOpen: true });
  },

  onCategory(e) {
    const c = e.currentTarget.dataset.c || '全部';
    // 点分类 = 回到「按分类浏览」，顺手把搜索词清掉。
    // 不清的话会出现：点了「食堂」，列表却还是刚才搜出来的那几个，
    // 看不出到底是谁在起作用
    this.setData({
      category: c,
      catMap: this.buildMap(c, this.data.cats),
      keyword: '',
      hasKeyword: false
    });
    this.applyFilter();
  },

  /* ---------------- 搜索 ---------------- */

  // 本地过滤，不发请求 —— 全量已经在 _all 里了，再问一次云端纯属白等
  onKeyword(e) {
    const kw = String((e && e.detail && e.detail.value) || '');
    this.setData({ keyword: kw, hasKeyword: !!kw.trim() });
    this.applyFilter();
  },

  onClearKeyword() {
    this.setData({ keyword: '', hasKeyword: false });
    this.applyFilter();
  },

  // 点键盘上的「搜索」：收起键盘，再把列表滚到眼前。
  // 不收的话键盘占掉下半屏，输完看不见结果，等于白搜
  onSearchConfirm() {
    if (wx.hideKeyboard) wx.hideKeyboard({ fail: () => {} });
    this.scrollListIntoView();
  },

  scrollListIntoView() {
    if (!wx.createSelectorQuery) return;
    wx.createSelectorQuery()
      .select('.pl-head')
      .boundingClientRect()
      .selectViewport()
      .scrollOffset()
      .exec((res) => {
        const box = res && res[0];
        if (!box) return; // 没搜到时列表头不渲染，这时不动
        const cur = (res[1] && res[1].scrollTop) || 0;
        wx.pageScrollTo({ scrollTop: cur + box.top - 12, duration: 200 });
      });
  },

  /* ---------------- 添加 ---------------- */

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
    this.setData({ form: form, catFormMap: this.buildMap(c, CATS) });
  },

  // 在真实地图上选点：经纬度由地图给出，绝不用手填
  pickLocation() {
    wx.chooseLocation({
      success: (res) => {
        const form = Object.assign({}, this.data.form, {
          latitude: res.latitude,
          longitude: res.longitude,
          address: res.address || '',
          name: this.data.form.name || res.name || ''
        });
        this.setData({ form: form, picked: true });
        // 走完这一步，位置权限一定是给了的（选点本身就要），
        // 顺手把地图上的定位点亮起来 —— 用户刚表达过「我要用位置」，
        // 这时候显示自己的位置正是他想要的，也不用再多问一次
        if (!this.data.showLoc) this.setData({ showLoc: true });
      },
      // 以前这里是 fail: () => {} —— 没声明 requiredPrivateInfos、后台没开通位置接口、
      // 隐私未授权，全被吞掉，用户点「在地图上选位置」就是"点了没反应"。
      // 现在：用户自己取消不打扰，其余一律给可读原因，原始 errMsg 进日志便于排查。
      fail: (err) => {
        const raw = String((err && err.errMsg) || '');
        if (raw.toLowerCase().indexOf('cancel') >= 0) return;
        console.error('[places] chooseLocation failed:', raw);
        wx.showToast({ title: locateReason(err), icon: 'none', duration: 2600 });
      }
    });
  },

  async onSubmit() {
    const f = this.data.form;
    if (!f.name.trim()) {
      wx.showToast({ title: '地点名字得写一下', icon: 'none' });
      return;
    }
    if (!f.latitude || !f.longitude) {
      wx.showToast({ title: '点上面那行，在地图上选一下位置', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '保存中', mask: true });
    const r = await userApi.placeAdd({
      name: f.name.trim(),
      category: f.category,
      desc: f.desc,
      address: f.address,
      latitude: f.latitude,
      longitude: f.longitude
    });
    wx.hideLoading();
    if (!r || r.ok === false) {
      wx.showToast({ title: (r && r.msg) || '保存失败', icon: 'none' });
      return;
    }
    wx.showToast({ title: '已添加', icon: 'success' });

    // 从 ➕ 进来的，加完直接退回去：他要的结果在上一页的列表里，
    // 留在这儿只会看到一张刚填完的空表单。上一页（校园页）自己会重拉。
    // fail 兜住没有上一页可退的情况（比如分享直接进来），那种就正常收表单
    if (this.data.backOnSave) {
      setTimeout(() => wx.navigateBack({
        fail: () => {
          // 没有上一页可退（分享链接直接进来）时别把人丢在成功提示后面：
          // 收好表单、退回「这一页自己继续加」的状态
          this.setData({ backOnSave: false });
          this.resetForm();
          this.load();
        }
      }), 600);
      return;
    }

    this.resetForm();
    this.load();
  },

  resetForm() {
    this.setData({
      showForm: false,
      picked: false,
      form: { name: '', category: '其他', desc: '', address: '', latitude: 0, longitude: 0 },
      catFormMap: this.buildMap('其他', CATS)
    });
  },

  /* ---------------- 使用 ---------------- */

  // 点列表里的「导航」：不再直接跳地图，先弹抽屉让同学自己选到达方式
  onOpen(e) {
    this.openSheet(this.data.list[e.currentTarget.dataset.i]);
  },

  // 点地图上的标记：同上，弹同一个抽屉
  onMarkerTap(e) {
    this.openSheet(this.placeByMarkerId(e.markerId));
  },

  onSheetClose() {
    this.setData({ navOpen: false });
  },

  // 步行路线还是走 openLocation —— 微信内置地图能直接算步行路径，
  // 比在小程序里塞一个只会转圈的路径页靠谱
  onWalkRoute() {
    const p = this.data.sheetPlace;
    if (!p) return;
    wx.openLocation({
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
      name: p.name,
      address: p.address || p.desc || '',
      scale: 18
    });
  },

  // 校车热线要走审核才能接进小程序，没配好之前不说假话，只给一个明确的出口
  onCallBus() {
    const hotline = String(this.data.busHotline || '').replace(/\s/g, '');
    if (!hotline) {
      wx.showToast({ title: '校车热线待配置，先用上面的地图导航过去', icon: 'none', duration: 2600 });
      return;
    }
    wx.makePhoneCall({ phoneNumber: hotline, fail: () => {} });
  },

  onRemove(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删掉这个地点？',
      success: async (r) => {
        if (!r.confirm) return;
        await userApi.placeRemove(id);
        this.load();
      }
    });
  },

  onShareAppMessage() {
    return {
      title: '商砖小站 · 校园地点速查（教学楼/食堂/快递点）',
      path: '/pages/tool/places/places'
    };
  }
});
