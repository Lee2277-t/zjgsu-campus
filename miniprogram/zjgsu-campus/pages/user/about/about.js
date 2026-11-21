// pages/user/about —— 关于（版本号 / 免责声明 / 联系方式）
//
// 为什么需要这一页：出问题时让同学「报一下版本」，他无从可报 ——
// 版本号只在开发者工具里看得到。
//
// 这里显示的版本号有三个，别把它们搞混：
//   appVersion —— 小程序的线上版本（体验版会显示「体验版」）
//   cloudBuild —— 云端云函数跑的是哪一版（把「本地新、云端旧」这件事变成人话）
//   baseLibrary —— 基础库版本，某些渲染问题只在这个版本上出现
const nav = require('../../../utils/nav.js');
const userApi = require('../../../utils/user.js');
const cloud = require('../../../utils/cloud.js');

// 与云函数 BUILD / pages/campus/campus.js 的 CLOUD_BUILD 三处必须一致。
// 改云函数版本时这三处一起改 —— 只改一处的后果是「版本提示说云端是旧版」，
// 而云端其实已经是最新的，用户照着提示重新部署一遍，问题依旧
const EXPECT_BUILD = '2026-10-20.5';

Page({
  data: {
    appVersion: '',
    cloudBuild: '',
    cloudFeatures: [],
    baseLibrary: '',
    buildStale: false,
    checking: true,
    // 提示文案里的「期望版本」也从这里来：以前 WXML 里硬编码过一个旧版本号，
    // 云函数真的落后时，提示给出的期望值是错的，反而把人带偏
    expectBuild: EXPECT_BUILD,
    // ⚠️⚠️ 这个地址必须换成真实可用的邮箱，并长期保持有人查看。
    // 它是站外唯一的侵权投诉入口：民法典 1195 条给的「避风港」，
    // 前提是权利人能把通知递进来。写着一个没人看的假地址，
    // 等于对外宣称有通道、实际没有 —— 打起官司来这比不写更糟，
    // 它能证明「明知应当作为而未作为」。
    // 换成真实邮箱后，scripts/test-content-defense.cjs 那一条会自动转绿
    contact: 'contact@example.com',
    // 是否审核员。只决定「云函数版本 / 过期警告 / 能力清单」这三处显不显示 ——
    // 它们是施工期的自查件，对同学的用处为零
    isMod: false
  },

  onLoad() {
    this.fillLocal();
    this.checkCloud();
    this.checkMod();
  },

  // 审核员判定跟「我的」页同一口径：先本地名单（openid 还没回来时拿不到结果），
  // 再问云端 whoami 兜一遍 —— 名单是以云端的 MODERATORS 环境变量为准的
  checkMod() {
    const oid = cloud.getOpenid();
    if (oid && userApi.isModerator({ openid: oid })) this.setData({ isMod: true });
    userApi.whoami()
      .then((w) => { if (w && w.isMod) this.setData({ isMod: true }); })
      .catch(() => {});
  },

  // 本机就能拿到的三项：不依赖网络，先把它们显示出来，
  // 免得云端连不上时整页空白（而这一页恰恰是排查「连不上」的地方）
  fillLocal() {
    let appVersion = '';
    let baseLibrary = '';
    try {
      const info = wx.getAccountInfoSync();
      const mp = (info && info.miniProgram) || {};
      appVersion = mp.version || '开发版';
    } catch (e) {
      appVersion = '开发版';
    }
    try {
      const sdk = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync();
      baseLibrary = (sdk && sdk.SDKVersion) || '';
    } catch (e) {
      baseLibrary = '';
    }
    this.setData({ appVersion: appVersion, baseLibrary: baseLibrary });
  },

  checkCloud() {
    userApi.diagCloud().then((r) => {
      if (!r || r.ok === false) {
        this.setData({ checking: false, cloudBuild: '' });
        return;
      }
      const build = String(r.build || '');
      this.setData({
        checking: false,
        cloudBuild: build,
        cloudFeatures: Array.isArray(r.features) ? r.features : [],
        // 云端版本比本机期望的旧 → 提示「需要重新部署」，
        // 而不是让用户对着一个没有新功能的小程序猜哪里出了问题
        buildStale: !!build && build !== EXPECT_BUILD
      });
    }).catch(() => {
      this.setData({ checking: false });
    });
  },

  onCopyBuild() {
    const s = '小程序 ' + this.data.appVersion
      + ' / 云函数 ' + (this.data.cloudBuild || '未知')
      + ' / 基础库 ' + (this.data.baseLibrary || '未知');
    wx.setClipboardData({ data: s });
  },

  onCopyContact() {
    wx.setClipboardData({ data: this.data.contact });
  },

  onGuide() {
    nav.go({ url: '/pages/user/guide/guide' });
  }
});
