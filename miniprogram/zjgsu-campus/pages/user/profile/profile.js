// pages/user/profile —— 我的个人资料
// 这里填什么 = 别人能看到的全部。联系方式不填就谁也看不到。
const store = require('../../../utils/store.js');
const userApi = require('../../../utils/user.js');
const cloud = require('../../../utils/cloud.js');
const privacy = require('../../../utils/privacy.js');
const upload = require('../../../utils/upload.js');
const haptic = require('../../../utils/haptic.js');

const CONTACT_TYPES = [
  { key: 'wechat', label: '微信号' },
  { key: 'phone', label: '手机号' },
  { key: '', label: '暂不公开' }
];
// QQ 档位已下线；老资料里的 qq 统一回落到“暂不公开”，避免把 QQ 号当成微信展示。
function contactTypeIndex(type) {
  const key = String(type || '');
  if (key === 'wechat') return 0;
  if (key === 'phone') return 1;
  return 2;
}

Page({
  data: {
    nickName: '',
    avatarUrl: '',
    avatarText: '浙',
    colleges: [],
    collegeIdx: 0,
    motto: '',
    contactTypes: CONTACT_TYPES,
    contactTypeIdx: 0,
    contactValue: '',
    contactPlaceholder: '填上微信号，同学才能找到你',
    openidTip: '',
    // 是否在审核员白名单里。只决定「身份 ID 那一行显不显示」——
    // 真正的门禁在云函数（MODERATORS 环境变量），前端这份只管展示
    isMod: false,
    // UI 专用：隐私档位胶囊。值沿用原有 contactType 的 key，
    // 没有新增任何字段，云函数 saveProfile 的参数结构完全没动
    privacyItems: ['wechat', 'phone', ''],
    privacyLabels: {
      wechat: '仅好友可见',
      phone: '申请后可见',
      '': '暂不公开'
    }
  },

  onLoad() {
    const p = userApi.getMyProfile();
    const colleges = store.getColleges();
    const ci = Math.max(0, colleges.indexOf(p.college));
    const ti = contactTypeIndex(p.contactType);
    this.setData({
      nickName: p.nickName || '',
      avatarUrl: p.avatarUrl || '',
      avatarText: (p.nickName || '浙').charAt(0),
      colleges: colleges,
      collegeIdx: ci,
      motto: p.motto || '',
      contactTypeIdx: ti,
      contactValue: p.contactType === 'qq' ? '' : (p.contactValue || ''),
      contactPlaceholder: CONTACT_TYPES[ti].label + '（不填谁也看不到）'
    });
    // 云端回滚：换设备 / 重装后本地是默认资料，从云端把「我」的资料读回来
    const oid = cloud.getOpenid();
    if (oid) {
      privacy.requireIfNeeded().then((ok) => {
        if (ok === false) return;
        return userApi.getProfile(oid).then((r) => {
          const prof = r && r.profile;
          if (prof && prof.nickName) {
            const t2 = contactTypeIndex(prof.contactType);
            this.setData({
              nickName: prof.nickName,
              avatarUrl: prof.avatarUrl,
              avatarText: prof.nickName.charAt(0),
              college: prof.college || '',
              motto: prof.motto || '',
              contactTypeIdx: t2,
              contactValue: prof.contactType === 'qq' ? '' : (prof.contactValue || '')
            });
          }
        });
      }).catch(() => {});
    }
    // 身份 ID 不打码：添加审核员就得靠每个人把自己这串完整 ID 复制出来上交 ——
    // 打码了就没法配名单。这一段只对审核员显示（wx:if="{{isMod}}"）：
    // 普通同学拿着这串字符无处可用，摆出来只是让人看了生疑。
    // 打开页面时身份多半还在路上，等它落地再补一次，不然这里会一直空着。
    // 判定跟「我的」页同一口径：先本地名单，再问云端 whoami（以云端为准）
    const markMod = (v) => {
      if (v && userApi.isModerator({ openid: v })) this.setData({ isMod: true });
    };
    const showOid = (v) => {
      if (v) this.setData({ openidTip: '你的身份 ID：' + v + '（点一下复制）' });
      markMod(v);
    };
    showOid(oid);
    userApi.whoami()
      .then((w) => { if (w && w.isMod) this.setData({ isMod: true }); })
      .catch(() => {});
    if (!oid) {
      cloud.fetchOpenid().then(showOid).catch(() => {});
    }
  },

  // 点一下弹窗确认再复制。之前是静默 setClipboardData，成功只有一闪而过的
  // 底部 toast，模拟器里几乎看不见，用户点完以为没反应。弹窗先把完整 ID
  // 摆在眼前（还能长按选中手动复制），点「复制」才是真正写剪贴板
  onCopyOpenid() {
    const oid = cloud.getOpenid();
    if (!oid) {
      wx.showToast({ title: '身份还没拿到，等一秒再点', icon: 'none', duration: 2000 });
      return;
    }
    wx.showModal({
      title: '你的身份 ID',
      content: oid,
      confirmText: '复制',
      cancelText: '关闭',
      success: (r) => {
        if (!r.confirm) return;
        wx.setClipboardData({
          data: oid,
          success: () => {
            haptic.ok();
            wx.showToast({ title: '已复制，可以粘贴了', icon: 'success' });
          }
        });
      }
    });
  },

  // 选完头像顺手传云存储：选图给的是本机临时路径，
  // 直接存下来只有自己看得见，别人打开是空的。
  //
  // 另一件事：原来选完还得记得点「保存资料」才算数，忘了点等于白选，
  // 对真实用户来说这是个隐形坏体验。现在改成选完就存，立刻生效。
  //
  // 这里踩过两个坑，都改掉了：
  //   1）cloudPath 以前是固定 'avatars/<openid>.jpg'，同名覆盖 —— 云存储 CDN
  //      会缓存旧图，于是「明明换成功了，看到的还是上一张」，看起来就是换不了头像。
  //      现在每次带时间戳，路径唯一，不碰缓存。
  //   2）以前裸调 wx.cloud.uploadFile，卡住不回调就一直转圈；改成走
  //      utils/upload.js（自带 60 秒超时 + 失败原因），云挂了也一定能落地。
  async onChooseAvatar(e) {
    const temp = e.detail && e.detail.avatarUrl;
    if (!temp) return;
    this.setData({ avatarUrl: temp, avatarText: '' });

    try {
      // 拿不到 openid 时不能上传：文件名按 openid 命名，
      // 用兜底名会让所有人的头像互相覆盖；这种情况就先存在本机。
      const oid = cloud.getOpenid();
      if (!cloud.ensureCloud() || !oid) {
        const local = await this.saveAvatarLocal(temp);
        this.setData({ avatarUrl: local || temp });
        await this.persist(
          local ? '头像已更新（仅本机）' : '头像没存住，再试一次',
          '头像没存住，再试一次'
        );
        return;
      }

      wx.showLoading({ title: '上传头像 0%', mask: true });
      const cloudPath = 'avatars/' + oid + '_' + Date.now() + '.jpg';
      const r = await upload.uploadFile(temp, cloudPath, (p) => {
        wx.showLoading({ title: '上传头像 ' + p + '%', mask: true });
      });
      wx.hideLoading();

      if (r && r.ok && r.fileID) {
        this.setData({ avatarUrl: r.fileID });
        await this.persist('头像已更新', '头像传到云端了，但资料没存住，再点一次「保存资料」');
        return;
      }

      // 云存储没开通 / 上传失败：退回本机永久目录，至少自己这边换成功了
      const local = await this.saveAvatarLocal(temp);
      this.setData({ avatarUrl: local || temp });
      await this.persist(
        local ? '头像已更新（仅本机）' : '头像没传上去，再试一次',
        (r && r.msg) || '头像没传上去，再试一次'
      );
    } finally {
      // 通知组件收掉忙碌态：不收的话头像上永远压着一层「上传中」遮罩
      const comp = this.selectComponent('.pf-avatar');
      if (comp && typeof comp.finish === 'function') comp.finish();
    }
  },

  // 存到本机永久目录。临时路径小程序重启就失效，saveFile 出来的不会 ——
  // 云存储没开通时也保证「头像换成功了」是看得见的
  saveAvatarLocal(temp) {
    const dir = (wx.env && wx.env.USER_DATA_PATH) || '';
    if (!dir) return Promise.resolve('');
    const target = dir + '/avatar_' + Date.now() + '.jpg';
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      setTimeout(() => done(''), 10000);
      try {
        wx.getFileSystemManager().saveFile({
          tempFilePath: temp,
          filePath: target,
          success: () => done(target),
          fail: () => done('')
        });
      } catch (e) {
        done('');
      }
    });
  },

  // avatar-editor 的 change 给的是 { tempFilePath }，云上传整套逻辑在
  // onChooseAvatar 里（它认的是 e.detail.avatarUrl），这里只转发一层，
  // 不为换头像去动上传代码
  onAvatarChange(e) {
    const temp = e.detail && e.detail.tempFilePath;
    if (temp) this.onChooseAvatar({ detail: { avatarUrl: temp } });
  },

  // 静默保存当前资料：昵称没填时不再拦着——头像本来就该能单独先换。
  // 昵称为空时沿用 app.js 里的默认值，保证同学看见的不是空白。
  //
  // okMsg / failMsg 分开传：以前失败原因也走 okMsg，失败时反而弹「成功」的图标，
  // 让人以为换成了其实没有。
  persist(okMsg, failMsg) {
    const nick = String(this.data.nickName || '').trim() || '浙小商';
    const ct = CONTACT_TYPES[this.data.contactTypeIdx];
    return userApi.saveProfile({
      nickName: nick,
      avatarUrl: this.data.avatarUrl,
      college: this.data.colleges[this.data.collegeIdx] || '',
      motto: String(this.data.motto || '').trim(),
      contactType: ct.key,
      contactValue: String(this.data.contactValue || '').trim()
    }).then((r) => {
      this.syncGlobal(nick);
      if (!r || r.ok === false) {
        wx.showToast({
          title: (r && r.msg) || failMsg || '没存住，点「保存资料」再试一次',
          icon: 'none',
          duration: 3000
        });
        return r;
      }
      wx.showToast({ title: okMsg || '已更新', icon: 'success' });
      haptic.ok();
      return r;
    }).catch(() => {
      wx.showToast({ title: failMsg || '没存住，点「保存资料」再试一次', icon: 'none' });
    });
  },

  // 全局状态同步。头像换了但别处还是旧的，正是「换了头像没反应」的观感来源：
  //   1）store（zjgsu_user）：发帖 / 评价的作者名与头像取自这里；
  //   2）app.globalData.userInfo：启动期缓存在内存里，不更新就一直显示旧头像。
  // 「我的」页在 onShow 里从 user.js 的本地缓存重新读，所以那里自然刷新。
  syncGlobal(nick) {
    const nickName = nick || String(this.data.nickName || '').trim() || '浙小商';
    const next = Object.assign({}, store.getUser(), {
      nickName: nickName,
      avatar: this.data.avatarUrl
    });
    store.setUser(next);
    try {
      const app = getApp();
      if (app && app.globalData) app.globalData.userInfo = next;
    } catch (e) { /* getApp 拿不到（极端情况）不影响本地已生效 */ }
  },

  onNick(e) {
    const v = e.detail.value;
    this.setData({ nickName: v, avatarText: v ? v.charAt(0) : '' });
  },
  onMotto(e) {
    this.setData({ motto: e.detail.value });
  },
  onContactValue(e) {
    this.setData({ contactValue: e.detail.value });
  },

  // 隐私档位 → contactType 下标（0 微信号 / 1 手机号 / 2 暂不公开）。
  onPrivacy(e) {
    const idx = { wechat: 0, phone: 1, '': 2 }[e.detail.value];
    if (idx === this.data.contactTypeIdx) return;
    // 和 picker 那条路（onContactType）保持同样的两个字段
    this.setData({
      contactTypeIdx: typeof idx === 'number' ? idx : 2,
      contactPlaceholder: CONTACT_TYPES[typeof idx === 'number' ? idx : 2].label + '（不填谁也看不到）'
    });
  },

  onCollege(e) {
    this.setData({ collegeIdx: Number(e.detail.value) });
  },
  onContactType(e) {
    const i = Number(e.detail.value);
    this.setData({
      contactTypeIdx: i,
      contactPlaceholder: CONTACT_TYPES[i].label + '（不填谁也看不到）'
    });
  },

  onSave() {
    const nickName = this.data.nickName.trim();
    if (!nickName) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' });
      return;
    }
    const ct = CONTACT_TYPES[this.data.contactTypeIdx];
    const cv = this.data.contactValue.trim();
    if (ct.key && !cv) {
      wx.showToast({ title: '填一下' + ct.label, icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中', mask: true });
    userApi.saveProfile({
      nickName,
      avatarUrl: this.data.avatarUrl,
      college: this.data.colleges[this.data.collegeIdx] || '',
      motto: this.data.motto.trim(),
      contactType: ct.key,
      contactValue: cv
    }).then((r) => {
      // 本地 saveProfile 先落一份；云端失败时明确告诉用户「只在本机」，
      // 不能继续弹成功并把页面退掉。
      this.syncGlobal(nickName);
      store.setUser(Object.assign({}, store.getUser(), { motto: this.data.motto.trim() }));
      wx.hideLoading();
      if (!r || r.ok === false) {
        haptic.warn && haptic.warn();
        wx.showToast({ title: (r && r.msg) || '资料只保存在本机，云端未同步', icon: 'none', duration: 3000 });
        return;
      }
      haptic.ok();
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '保存失败，试试重来', icon: 'none' });
    });
  },

  onReset() {
    wx.showModal({
      title: '要改回默认资料吗',
      content: '昵称、头像、联系方式都会重置',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({
          nickName: '浙小商', avatarUrl: '', avatarText: '浙',
          collegeIdx: 0, motto: '浙江工商大学 · 在读',
          contactTypeIdx: 0, contactValue: ''
        });
      }
    });
  }
});
