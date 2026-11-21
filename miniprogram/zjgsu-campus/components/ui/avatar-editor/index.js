// components/ui/avatar-editor/index.js
// 迁移自 src/components/ui/AvatarEditor.vue
//
// 只负责「选图 + 预览 + 忙碌态」，不碰业务接口，选到的临时路径通过 change 交给页面。
//
// 之前这里直接 wx.chooseMedia({ sourceType:['album'] })，失败只弹一句
// 「选择图片失败」：隐私协议没授权、基础库太老、相册权限被拒都会走到这里，
// 用户看到的是「点头像没反应 / 换不了头像」。
// 现在改走 utils/upload.js 的 pickImages：隐私授权门 → chooseMedia → chooseImage
// 逐级降级，并且把相册和拍照都放开（原来只允许相册，等于砍掉一半入口）。
//
// 另一个坑：以前 uploading 靠组件内部 4 秒定时器自己收，页面上传还没完它就亮完了，
// 上传失败时更是永远停在「上传中」。改成页面上传结束后显式调 finish() 收，
// 定时器只作兜底（页面漏调也不会卡死）。

const upload = require('../../../utils/upload.js');

Component({
  properties: {
    src: { type: String, value: '' },
    size: { type: String, value: '160rpx' },
    readonly: { type: Boolean, value: false }
  },

  data: {
    uploading: false,
    // src 有值但图裂了（地址过期 / 断网）。置 true 后退回文字头像 ——
    // 只看 src 有没有值的话，图裂时就是一个空圈，用户以为自己没设过头像
    srcFailed: false
  },

  observers: {
    // 换了一张就重新给它一次机会
    src() {
      if (this.data.srcFailed) this.setData({ srcFailed: false });
    }
  },

  methods: {
    async chooseAlbum() {
      if (this.data.readonly || this.data.uploading) return;

      this.setData({ uploading: true });
      const r = await upload.pickImages(1);

      if (!r.ok) {
        this.setData({ uploading: false });
        // 用户自己取消的不打扰；其余情况给一句能照着做的原因
        if (r.canceled || !r.msg) return;
        wx.showToast({ title: r.msg, icon: 'none', duration: 2600 });
        return;
      }

      const file = (r.files || [])[0];
      if (!file) {
        this.setData({ uploading: false });
        wx.showToast({ title: '没读到图片，换一张试试', icon: 'none' });
        return;
      }

      // 先本地预览：即使后面上传失败，用户也能立刻看到自己选的图
      this.setData({ src: file });
      this.triggerEvent('change', { tempFilePath: file });

      // 页面调 finish() 之后这里才会收；定时器兜底，防止页面漏调导致永久转圈
      clearTimeout(this._t);
      this._t = setTimeout(() => this.setData({ uploading: false }), 30000);
    },

    // 页面上传结束（成功或失败）时调用，把忙碌态收回去
    finish() {
      clearTimeout(this._t);
      this.setData({ uploading: false });
    },

    onTap() {
      this.chooseAlbum();
    },

    // 头像加载失败 → 退回文字头像。和「我的」、名片、会话列表同一套判断
    onImgError() {
      if (this.data.srcFailed) return; // 已经在兜底了，别反复 setData
      this.setData({ srcFailed: true });
    }
  }
});
