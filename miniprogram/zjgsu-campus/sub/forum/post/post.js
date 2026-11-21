// sub/forum/post/post.js
// 发帖带图：选图 → 传云存储拿 fileID → 把 fileID 存进帖子。
// 图片走云存储而不是本地路径，别人打开才能看到；fileID 小程序内可直接当 src 用。
const store = require('../../../utils/store.js');
const moderation = require('../../../utils/moderation.js');
const userApi = require('../../../utils/user.js');
const cloud = require('../../../utils/cloud.js');
const upload = require('../../../utils/upload.js');
const notify = require('../../utils/notify.js');
// 全站同一套精准 / 模糊搜索
const searchCore = require('../../../utils/search.js');
// 所有面向用户的提示统一走反馈层：它会先把 Loading 收掉再隔一帧弹 Toast。
// 以前裸调 wx.showToast，在「刚刚 showLoading 过」的分支上会被随后的 hideLoading 抹掉，
// 用户看到的就是「点了发布，页面毫无反应」——属于历史最顽固的那个 Bug
const feedback = require('../../../utils/feedback.js');

const COURSE_BOARD = '课程评价';
const MAX_IMAGES = 6;

// 整条发布链路的总闸（毫秒）。
// 链路里串着三段等待：内容预检（12s 上限）→ 等 openid（6s 上限）→ 写云端（12s 上限），
// 加起来最坏能拖到二三十秒。没有这个总闸，一旦某段卡住，
// 用户就对着「发布中」的蒙层干等到怀疑程序坏了。到点一律给提示收场。
const SUBMIT_DEADLINE_MS = 14 * 1000;
// 超过这个时间还没动静，就把 Loading 文案换掉：
// 蒙层上一句不变的「发布中」，看久了和死机没有区别
const SLOW_HINT_MS = 4 * 1000;
// 「发布中」状态过了这么久还没复位，就判定为卡死并强制放开按钮。
// 注意是 30s > 总闸 25s：正常流程轮不到它出场，它只接「总闸自己也没响」的那些情况
const SUBMIT_STUCK_MS = 14 * 1000;
// 看门狗：比总闸再宽 8 秒。真机切后台时 setTimeout 会被系统暂停，
// 总闸和它都可能哑火，但回前台后至少还有一个会补上那句话
const WATCHDOG_MS = SUBMIT_DEADLINE_MS + 8 * 1000;

Page({
  data: {
    boards: [],
    board: '',
    title: '',
    content: '',
    isCourseBoard: false,
    courseKeyword: '',
    courseResults: [], // 命中的候选课程 [{ id, name, college }]
    courseId: '',
    courseName: '',
    images: [], // 云存储 fileID 列表（云不可用时是本机永久路径）
    // 有没有图只存在本机：云存储没开通时保底存的，别人看不到，得跟用户说清
    imagesLocal: false,
    uploading: false,
    // 上传进度（0-100）：多图 + 大图时必须有，不然「处理图片」转半天像卡死
    uploadPercent: 0,
    submitting: false,
    // 这次是恢复哪条草稿来的：发成功之后要把它从草稿箱撤掉
    draftId: '',
    // 匿名发布（树洞）：开了以后列表里只显示代号，服务端仍能追到人
    anonymous: false,
    anonTip: '',
    // 帖子类型：normal（普通帖，有标题有正文）/ topic（主题帖，只有标题，信息收评论区）
    kind: 'normal',
    // 切到主题帖时的说明。放在数据里而不是写死在 wxml，
    // 是因为这句话会随板块变（社团板块说「拉群」，别的板块说法不一样）
    topicTip: '',
    // 第三种发帖模式「发起投票」的面板状态：选项 / 单选多选 / 截止时间 / 匿名
    voteOptions: [
      { id: 'vote-option-1', label: '' },
      { id: 'vote-option-2', label: '' }
    ],
    voteMultiple: false,
    voteDeadline: 72,
    voteAnonymous: true,
    voteFilled: 0,
    optionSeq: 3
  },

  onLoad(options) {
    // 默认板块「闲聊」：不想纠结发哪儿的同学，进来直接写就行
    this.setData({
      boards: store.getBoards().map((b) => b.name),
      // 默认落在「闲聊」：绝大多数帖子先按聊天处理，想发别的再切
      board: '闲聊',
      contactOk: moderation.CONTACT_OK_BOARDS.indexOf('闲聊') >= 0
    });
    // 从草稿箱进来：把没写完的那篇填回表单，并记住是哪一条，发成功好撤掉
    if (options && options.draftId) {
      const d = store.getDraft(options.draftId);
      if (d) {
        this.setData({ draftId: options.draftId });
        const board = this.data.boards.indexOf(d.board) >= 0 ? d.board : '闲聊';
        this.setData({
          board,
          isCourseBoard: board === COURSE_BOARD,
          // 课程关联一起回填：缺了它恢复完会被「先选一门课程」卡住，看着像草稿坏了
          courseId: d.courseId || '',
          courseName: d.courseName || '',
          title: d.title || '',
          content: d.content || '',
          kind: d.kind === 'topic' ? 'topic' : 'normal',
          images: Array.isArray(d.images) ? d.images : [],
          // 草稿里可能存着云存储没连上时留下的本机路径，恢复时也把提示带上
          imagesLocal: Array.isArray(d.images) && d.images.some((x) => String(x).indexOf('cloud://') !== 0),
          anonymous: !!d.anonymous
        });
      }
      return;
    }
    // 不是从草稿箱进来的，也自动接上最近一篇没写完的：
    // 写一半直接退出去是最伤的，回来应该接着写，而不是面对一张白纸重新回忆
    const last = store.getDrafts().find((x) => x.type === 'post');
    if (last) {
      // 旧草稿可能挂着「课程评价」却丢了课程关联，恢复完会被「先选一门课程」卡死，
      // 这种宁可直接落到「闲聊」，不让用户对着报错猜
      let board = this.data.boards.indexOf(last.board) >= 0 ? last.board : '闲聊';
      if (board === COURSE_BOARD && !last.courseId) board = '闲聊';
      this.setData({
        draftId: last.id,
        board,
        isCourseBoard: board === COURSE_BOARD,
        courseId: last.courseId || '',
        courseName: last.courseName || '',
        title: last.title || '',
        content: last.content || '',
        kind: last.kind === 'topic' ? 'topic' : 'normal',
        images: Array.isArray(last.images) ? last.images : [],
        imagesLocal: Array.isArray(last.images) && last.images.some((x) => String(x).indexOf('cloud://') !== 0),
        anonymous: !!last.anonymous
      });
      feedback.toast('已接上上次没发完的');
    }
  },

  // 页面离开（返回 / 切后台）时自动存草稿：不用记得点「存草稿」，
  // 下次进来直接接着上次写。存的是同一条（内容没变不攒重复），发布成功后自动清。
  autoSaveDraft() {
    if (this._published) return;
    const d = this.data;
    if (!store.hasDraftText({ title: d.title, content: d.content })) {
      // 内容被清空了还留着旧草稿的话，下次进来又会冒出来 —— 把关联那条删掉
      if (d.draftId) store.removeDraft(d.draftId);
      return;
    }
    const saved = store.saveDraft({
      type: 'post',
      board: d.board,
      title: d.title,
      content: d.content,
      // 类型也存：主题帖的正文是空的，不存的话草稿恢复回来会被当成普通帖，
      // 一点发布就被「写点内容」卡住
      kind: d.kind,
      images: d.images,
      anonymous: d.anonymous
    });
    if (saved && saved.id && saved.id !== d.draftId) this.setData({ draftId: saved.id });
  },

  onHide() { this.autoSaveDraft(); },
  onUnload() { this.autoSaveDraft(); },

  // 兜底：界面重新可见时，如果「发布中」的遮罩还挂着（上次提交被中断的情况），
  // 顺手收掉。遮罩是盖满整个页面的，留着会让所有按钮都点不动，
  // 表现就是「点了完全没反应」——而用户根本不知道罪魁是那个遮罩。
  onShow() {
    if (this.data.submitting) {
      const hadStuck = true;
      this.setData({ submitting: false });
      feedback.hideLoading();
      if (hadStuck) {
        feedback.toast('上一条没发完，已复位，可以再试');
      }
    }
  },

  // 写一半退出去最伤，这里留个退路：点一下存草稿，什么时候回来都还在
  onSaveDraft() {
    const d = this.data;
    if (!store.hasDraftText({ title: d.title, content: d.content })) {
      feedback.toast('还没写内容');
      return;
    }
    store.saveDraft({
      type: 'post',
      board: d.board,
      title: d.title,
      content: d.content
    });
    // 提示要说清去哪儿找：只说「已保存」，用户回头找不到地方，就会以为草稿丢了
    feedback.toast('草稿已存，在「我的 → 草稿箱」');
  },

  onBoard(e) {
    const board = e.currentTarget.dataset.b;
    // 切板块时重置课程选择，避免把课程挂到无关板块上
    this.setData({
      board,
      isCourseBoard: board === COURSE_BOARD,
      // 这个板块能不能留联系方式：提示文案要不要出现，由它决定
      contactOk: moderation.CONTACT_OK_BOARDS.indexOf(board) >= 0,
      courseId: '',
      courseName: '',
      courseKeyword: '',
      courseResults: []
    });
  },

  onCourseSearch(e) {
    const raw = e.detail.value;
    this.setData({ courseKeyword: raw });
    const kw = raw.trim();
    if (!kw) {
      this.setData({ courseResults: [] });
      return;
    }
    // 选课程也走同一套精准 / 模糊：同学把课程名打错一个字，
    // 不该在候选列表里彻底搜不到、只能放弃关联课程
    const hits = store
      .getCourses()
      .filter((c) => searchCore.matchFields([c.name, c.major, c.college], kw) >= 0)
      .slice(0, 12)
      .map((c) => ({ id: c.id, name: c.name, college: c.college }));
    this.setData({ courseResults: hits });
  },

  pickCourse(e) {
    this.setData({
      courseId: e.currentTarget.dataset.id,
      courseName: e.currentTarget.dataset.name,
      courseResults: [],
      courseKeyword: ''
    });
  },

  clearCourse() {
    this.setData({ courseId: '', courseName: '', courseResults: [] });
  },

  onTitle(e) {
    this.setData({ title: e.detail.value });
  },

  // 换帖子类型。
  //
  // 主题帖只有标题、正文要留空，所以切过去的第一件事是把正文框里的内容搬走 ——
  // 不然同学写了两百字的正文，切一下发现空格没了，还以为是被吃了。
  // 但搬走也要留个记号，不能默默清空，下次切回来他能找回来。
  onKind(e) {
    // 三档都认：普通 / 主题 / 投票。之前只认 topic，点「发起投票」会被
    // 兜底成 normal，投票面板永远展不开 —— 用户看到的就是「点了没反应」
    const want = e.currentTarget.dataset.kind;
    const kind = (want === 'topic' || want === 'vote') ? want : 'normal';
    if (kind === this.data.kind) return;
    const kept = this.data.content;
    this.setData({
      kind,
      content: kind === 'topic' ? '' : kept,
      // 切回普通帖时，正文确实是他自己写的，得让原话回到框里
      topicTip: kind === 'topic'
        ? '这是一个主题：只写标题。具体信息（群号、地点、报名方式等）留给评论区，'
          + '有需要的同学进来自己看。'
        : ''
    });
  },

  /* ---------------- 发起投票模式（UI 面板） ---------------- */

  onVoteOption(e) {
    const i = Number(e.currentTarget.dataset.i || 0);
    const label = e.detail.value;
    const options = this.data.voteOptions.slice();
    if (!options[i]) return;
    options[i] = Object.assign({}, options[i], { label });
    this.setData({
      voteOptions: options,
      // 有效选项数：至少填 2 个才发得出去
      voteFilled: options.filter((o) => String(o.label || '').trim()).length
    });
  },

  addVoteOption() {
    if (this.data.voteOptions.length >= 8) {
      feedback.toast('最多 8 个选项');
      return;
    }
    const id = 'vote-option-' + this.data.optionSeq;
    this.setData({
      voteOptions: this.data.voteOptions.concat([{ id, label: '' }]),
      optionSeq: this.data.optionSeq + 1
    });
  },

  removeVoteOption(e) {
    if (this.data.voteOptions.length <= 2) return;
    const i = Number(e.currentTarget.dataset.i || 0);
    this.setData({ voteOptions: this.data.voteOptions.filter((o, idx) => idx !== i) });
  },

  moveVoteOption(e) {
    const i = Number(e.currentTarget.dataset.i || 0);
    const offset = Number(e.currentTarget.dataset.d || 0);
    const to = i + offset;
    const list = this.data.voteOptions.slice();
    if (to < 0 || to >= list.length) return;
    const moved = list.splice(i, 1)[0];
    list.splice(to, 0, moved);
    this.setData({ voteOptions: list });
  },

  onVoteMode(e) {
    this.setData({ voteMultiple: e.currentTarget.dataset.m === 'true' });
  },

  onVoteDeadline(e) {
    this.setData({ voteDeadline: Number(e.currentTarget.dataset.h || 72) });
  },

  onVoteAnonymous() {
    this.setData({ voteAnonymous: !this.data.voteAnonymous });
  },

  // 匿名开关：只是「对同学隐藏」，不是「对平台隐身」——
  // 违规内容照样能追到人，这句话必须让用户看见
  toggleAnonymous() {
    const on = !this.data.anonymous;
    this.setData({
      anonymous: on,
      anonTip: on ? '已匿名：别人只看到「匿名·晚风」这样的代号，每发一条换一个，评论区也一样，你仍能在「我的」里找到它' : ''
    });
  },

  onContent(e) {
    this.setData({ content: e.detail.value });
  },

  // 选图。
  //
  // 这一段以前是「自己拼 chooseMedia / chooseImage 两套回调」：
  // 只要隐私协议没授权、或者接口在当前基础库不存在，失败就被吞掉，
  // 用户看到的是「点了加图没反应」。
  // 现在统一交给 utils/upload.js：隐私授权门 → chooseMedia → chooseImage 逐级降级，
  // 任何一步失败都给一句人话（而不是 errMsg 尾巴）。
  async chooseImages() {
    // 上一批还在传就别再开相册：既会重复计费上传，界面上也只会让人觉得「点了没反应」
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
      // 用户自己从相册退出来不算错误，静默即可
      if (r.canceled || !r.msg) return;
      console.error('[chooseImages] failed:', r.msg);
      feedback.toast(r.msg);
      return;
    }
    // 选完立刻在后台压图（不 await）：从选完图到点「发布」，用户还要填标题、正文、
    // 选板块，通常有十几秒。本地压缩（大图 1–2 秒）正好在这段时间里做完，
    // 点发布时就只剩上传那一步 —— 这是把「等待」挪出用户视线最有效的一刀。
    upload.prewarm(r.files);
    this.uploadImages(r.files);
  },

  // 把一张临时图存到本机永久目录：云存储没开通 / 上传失败时的保底方案。
  // 临时路径小程序重启就失效，saveFile 出来的路径不会 ——
  // 至少发帖的人自己看得到图，而不是「选了半天一张都没有」
  saveLocal(file, seq) {
    const ext = String(file.split('.').pop() || 'jpg').toLowerCase();
    const dir = (wx.env && wx.env.USER_DATA_PATH) || '';
    const target = dir + '/forum_' + Date.now() + '_' + seq + '.' + ext;
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      setTimeout(() => done(''), 10000); // 兜底：卡住也不能让整批流程悬着
      try {
        const fs = wx.getFileSystemManager();
        fs.saveFile({
          tempFilePath: file,
          filePath: target,
          success: () => done(target),
          fail: () => done('')
        });
      } catch (e) {
        done('');
      }
    });
  },

  async uploadImages(files) {
    this.setData({ uploading: true, uploadPercent: 0 });
    // ⚠️ 这里刻意不用 wx.showLoading({ mask: true })：
    // 上传是在「点发布的那一刻」之前就发生的（早失败早知道），而这时用户往往还想
    // 继续打字 —— 一个带 mask 的蒙层会把输入框挡死几秒，用户感受到的就是
    // 「点了加图后整页卡住」。进度改由页面内「配图」那一栏右侧的百分比显示
    // （post.wxml 的 uploadPercent），不挡任何操作。
    const cloudOk = !!cloud.ensureCloud();
    const n = files.length || 1;
    // 进度条：云存储不给真实字节进度，就用「已完成张数」这个真值推进 ——
    // 每张只有 0（在传）和 100（传完）两种真值，整体取平均。
    // 不用「按时间假装往前爬」的假百分比：那样数字在动，但实际可能一动没动。
    const report = (pct) => {
      this.setData({ uploadPercent: pct });
    };
    let done = [];
    let localHit = 0;
    try {
      if (!cloudOk) {
        // 云存储没开通：直接存本机，别再走一遍上传流程白等
        for (let i = 0; i < files.length; i += 1) {
          const p = await this.saveLocal(files[i], i);
          if (p) done.push(p);
          report(Math.floor(((i + 1) / n) * 100));
        }
      } else {
        // 并发 3 个一组传（upload.uploadMany）：比「6 张一起挤」总体更快，
        // 单张仍带 60s 超时与可读失败原因，失败/超时自动退回本机保存
        const r = await upload.uploadMany(files, {
          prefix: 'forum',
          fallback: (f, i) => this.saveLocal(f, i),
          onProgress: report
        });
        done = r.ok;
      }
      // fileID 一定以 cloud:// 开头，其余的都是落在本机的路径
      localHit = done.filter((x) => String(x).indexOf('cloud://') !== 0).length;
    } catch (e) {
      // 兜底：任何漏网的异常也要把 uploading 收掉（后面 finally 会做），
      // 否则「加图」按钮从此只剩一句提示，看起来像彻底坏了
      console.error('[uploadImages] error:', e);
    } finally {
      // 无论成败都要复位：不复位的话「加图」按钮从此只剩提示，点不动
      feedback.hideLoading();
      this.setData({
        images: this.data.images.concat(done),
        imagesLocal: this.data.imagesLocal || localHit > 0,
        uploading: false,
        uploadPercent: 0
      });
    }
    if (!cloudOk) {
      feedback.toast(localHit ? '云存储不可用，图片只存在本机' : '图片没能保存，检查存储空间');
    } else if (localHit) {
      feedback.toast(localHit + ' 张没传到云端，先存本机了');
    } else if (files.length && !done.length) {
      feedback.toast('图片处理失败，帖子仍可发出');
    }
  },

  removeImage(e) {
    const i = e.currentTarget.dataset.i;
    const images = this.data.images.slice();
    images.splice(i, 1);
    this.setData({ images });
  },

  previewImage(e) {
    wx.previewImage({ current: e.currentTarget.dataset.src, urls: this.data.images });
  },

  // 真正干活的那一段：只负责发 request，提示与超时一律不在这里掺和。
  // 拆出来的目的 —— 让「每个失败分支有没有给反馈」能在一个地方看清，
  // 顺带也让它能被冒烟脚本单独驱动。
  async _doSubmit(board, title, content, kind) {
    const t0 = Date.now();
    console.log('[zjgsu:post] _doSubmit 开始', { board, kind });
    // 不计入超时的后台预热：身份能提前拿到就省一趟等待，拿不到也不拖累提交
    if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
      cloud.fetchOpenid().catch(() => {});
    }
    // 服务端权威校验（本地词表只是提示，拦截权在云函数）。
    // 这步前端只给 5s：慢了不如直接放行，别把「发布中」拖到总闸边缘
    feedback.loading('正在检查内容…', true);
    console.log('[zjgsu:post] CHECK 开始', Date.now() - t0);
    const safe = await userApi.checkText({ title: title, content: content });
    console.log('[zjgsu:post] CHECK 结束', Date.now() - t0, 'ok=', !!(safe && safe.ok));
    if (safe && safe.ok === false) {
      return { ok: false, saved: false, muted: true, msg: safe.msg || '内容不合适，换个说法' };
    }
    // 写库类接口前端给 10s。阶段文案让用户感知到「在发了」而不是「死了」
    feedback.loading('正在发布…', true);
    console.log('[zjgsu:post] POST 开始', Date.now() - t0);
    // 幂等键：**同一页面上没发成功之前一直用同一个 id**。
    // 这样「云端其实写进去了但我没等到回执 → 用户再点一次」不会变成两条帖子：
    // addPost 看到同一个 id 会直接返回已有那条（reused: true），
    // 云函数那边同样按 id 去重。发成功之后清掉，下一条是新 id。
    if (!this._clientId) this._clientId = store.genId();
    const res = await store.addPost({
      clientId: this._clientId,
      board: board,
      title,
      content,
      kind,
      courseId: this.data.courseId,
      courseName: this.data.courseName,
      images: this.data.images,
      anonymous: this.data.anonymous,
      // 投票帖把面板里的设置一起带过去：选项 / 单选多选 / 截止时间 / 匿名。
      // 不带的话落库的就是一张没有选项的空投票，谁都没法投
      vote: kind === 'vote' ? {
        labels: this.data.voteOptions.map((o) => o.label),
        multiple: this.data.voteMultiple,
        deadlineHours: this.data.voteDeadline,
        anonymous: this.data.voteAnonymous
      } : null
    });
    console.log('[zjgsu:post] POST 结束', Date.now() - t0, 'ok=', !!(res && res.ok));
    return res;
  },

  // 手指落下：记下起点，供抬手时判断这是不是一次「点击」
  // （见 onSubmitTouchEnd —— 真机上 tap 事件偶发丢失，用它兜底）
  onSubmitTouchStart(e) {
    const t = (e.touches && e.touches[0]) || {};
    this._touch = { x: t.clientX || 0, y: t.clientY || 0, t: Date.now() };
  },

  // 手指抬起：如果 tap 压根没来（iOS 收键盘那一帧吞点击、或 JS 线程正忙时最常出现），
  // 这里补执行一次提交。
  // 表现就是用户说的「按下去按钮变深了，然后什么都没有」——
  // 变色是渲染层的事，跟 JS 有没有收到这一下完全无关。
  onSubmitTouchEnd(e) {
    const s = this._touch;
    this._touch = null;
    if (!s) return;
    const t = (e.changedTouches && e.changedTouches[0]) || {};
    const moved = Math.abs((t.clientX || 0) - s.x) + Math.abs((t.clientY || 0) - s.y);
    // 滑动 / 长按都不算点击，别把翻页误判成发布。阈值放宽到 40：
    // 手指在按钮上本来就会有几像素位移，24 偏严会漏掉「tap 没来、手指微动」的兜底
    if (moved > 40 || Date.now() - s.t > 1500) return;
    // tap 已经来过就别重复提交（两次触发通常只差几十毫秒）
    if (Date.now() - (this._tapAt || 0) < 700) return;
    this._tapAt = Date.now();
    // 返回 promise：submit 里现在要等一次授权（最多 4 秒），
    // 把 promise 交出去，测试和调试时才能等到这一趟真的跑完
    return this.submit();
  },

  // 提交入口。外面这一层只做一件事：**同步**重入锁。
  //
  // 为什么必须有它（「发一条出现两个帖子」的根因）：
  //   这个按钮有两条进路 —— 按钮自己的 bindtap，和 onSubmitTouchEnd 的兜底
  //   （真机上 tap 偶发丢失，兜底是必要的）。两条路都会调 submit()。
  //   原来的去重靠 `this.data.submitting`，但 setData 是**异步**的，
  //   而且它要等到 `await notify.maybeRequest(...)` **之后**才被置上 ——
  //   中间隔着一次订阅消息授权面板，最长 4 秒。这 4 秒里 submitting 还是 false，
  //   第二次调用照样通过检查，于是两条一模一样的帖子被写进去。
  //   用实例字段（同步赋值，不走渲染层）才能挡住同一帧/同一秒内的第二次调用。
  //
  // 释放放在 finally：整条链（含授权、云函数往返）跑完才放开，
  // 中途任何一次 return 都会解锁，不会把按钮永久锁死。
  async submit() {
    if (this._inflight) return undefined;
    this._inflight = true;
    try {
      return await this._submitRun();
    } finally {
      this._inflight = false;
    }
  },

  async _submitRun() {
    this._tapAt = Date.now();
    console.log('[zjgsu:post] submit 被触发', this._tapAt);
    // 零依赖兜底：就算 feedback 模块在真机极端情况下没加载成功（独立文件、无依赖，
    // 正常不会发生，但防万一），也先让用户看到「点到了」。同时这行原生 Toast 也是
    // 区分「tap 根本没进 JS」还是「提示被吞」的关键诊断标记（配合上面的 console.log 看真机调试）
    try { if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: '收到，发送中', icon: 'none', duration: 600 }); } catch (e) {}
    // 轻震动：唯一不会被 Loading / 键盘 / 系统弹窗吞掉的反馈。
    // 有震动说明 JS 收到了这一下点击，问题在后面；没震动就是点击压根没进来
    if (feedback && feedback.buzz) { try { feedback.buzz(); } catch (e) {} }
    else { try { if (typeof wx !== 'undefined' && wx.vibrateShort) wx.vibrateShort({ type: 'light' }); } catch (e) {} }
    // 上一次提交卡住时 submitting 会留在 true。
    // ⚠️ 以前按钮上还挂着 disabled="{{submitting}}"：一旦卡住，按钮是真的点不动，
    //    连一句提示都没有 —— 这是「点了完全没反应」里最硬的一种。
    //    现在按钮不再 disabled（改由这里判断），并且用**时间戳**而不是定时器来认
    //    「上次是不是过期了」：真机切后台 / 锁屏时 setTimeout 会被系统暂停，
    //    靠定时器复位的话，用户回来后按钮会永久失灵。
    if (this.data.submitting) {
      const stuckMs = Date.now() - (this._submitAt || 0);
      // 超过 30 秒还在「发布中」，基本就是被后台暂停 / 云函数彻底没回声了：
      // 强制复位让他能重发，而不是对着一个点不动的按钮
      if (stuckMs > SUBMIT_STUCK_MS) {
        this.setData({ submitting: false });
        feedback.hideLoading();
      } else {
        feedback.toast('还在发上一条，稍等一下');
        return;
      }
    }
    this._submitAt = Date.now();
    // 不选板块也能发：兜底归进「闲聊」，不再拦着（board 正常流程在 onLoad 就有默认值）
    const board = this.data.board || '闲聊';
    if (this.data.isCourseBoard && !this.data.courseId) {
      feedback.toast('先选一门课程');
      return;
    }
    const title = String(this.data.title || '').trim();
    const content = String(this.data.content || '').trim();
    // 投票帖不带正文，和主题帖一样放行（store.addPost 仍按自己的字段落库）
    const kind = this.data.kind === 'topic' || this.data.kind === 'vote' ? this.data.kind : 'normal';
    // 只有主题帖和投票帖必须要标题 —— 它们的信息主体就是标题本身，
    // 评论区和投票选项是依附在标题下的。普通帖的标题彻底选填：
    // 一句话、一张图，都能单独发出去
    if (!title && kind !== 'normal') {
      feedback.toast(kind === 'topic' ? '给这个主题起个名字' : '给投票起个标题');
      return;
    }
    // 主题帖的定义就是「不带正文」：正文一旦填了它就变成普通帖了
    if (kind === 'topic' && content) {
      feedback.toast('主题帖不写正文');
      return;
    }
    // 普通帖：正文和图片至少要有一样。
    // 以前卡在「正文不能空」，结果想发张照片问问这是哪儿，
    // 还得先憋一句文案 —— 图本身就是内容
    if (kind === 'normal' && !content && !this.data.images.length) {
      feedback.toast('写点什么，或者加张图');
      return;
    }
    // 投票帖必须有两个以上填了字儿的选项，否则发出去是一张投不了票的空卡
    if (kind === 'vote' && this.data.voteFilled < 2) {
      feedback.toast('至少填写 2 个投票选项');
      return;
    }
    // 带上板块：社团同好 / 活动组队里留群号联系方式是正常内容，不该被屏蔽词挡住。
    // 主题帖的正文是空的，过 guardText 的前提是拼接串里至少要有东西可查
    if (!moderation.guardText(title + ' ' + content, '帖子', this.data.board)) return;

    // 订阅消息授权：**必须在这一帧发起**。
    // wx.requestSubscribeMessage 只认用户点击的手势 —— 放到 setTimeout 或
    // navigateBack 回调里（上一版的写法）微信会直接 fail（errCode 20004，
    // "can only be invoked by user TAP gesture"），面板一次都不会出现，
    // 模板 ID 填得再对也没用。
    // 位置选在校验全部通过之后：内容都合法了，这一问才有意义。
    // 必须 await：不 await 的话发布会趁面板盖着的时候跑完，
    // 「发布成功」那句又会被面板吃掉（这正是上一版把它挪走的原因）。
    // 整个调用有 4 秒上限（见 utils/notify.js 的 ASK_TIMEOUT_MS），不会把发布拖死。
    // force：发帖是「明确需要后续通知」的时刻 —— 没授权就等于发完永远收不到
    // 「有人回复你」。所以这里不沿用 12 小时/7 天那套顺手问的节流，
    // 授权过也再问一次（一次允许只能推一条，额度用完就该再要），
    // 拒绝过的按 1 天冷却算（见 utils/notify.js）。
    // 用户不同意也不拦发布：通知是附加价值，不是发帖的前提。
    await notify.maybeRequest(['comment', 'reply'], { force: true });

    // 点下去立刻给反馈：云函数校验要跑一个来回，之前这一步没反馈，用户以为卡住了
    this.setData({ submitting: true });
    feedback.loading('发布中', true);
    // 慢的时候把话说出来：一直挂着同一句「发布中」，和死机看着一模一样
    const slowTimer = setTimeout(() => {
      if (feedback.isLoading()) feedback.loading('网络有点慢，还没发出去…', true);
    }, SLOW_HINT_MS);
    // 看门狗：整条链跑完之前，如果一句话都没给用户（超时提示也算），它兜底说一句
    const wd = feedback.watchdog({ ms: WATCHDOG_MS, msg: '发布这条卡太久了，先看看网络' });

    let r = null;
    let timedOut = false;
    try {
      const run = await feedback.run({
        task: this._doSubmit(board, title, content, kind),
        ms: SUBMIT_DEADLINE_MS,
        // 到点还没回来：内容按「已经留在本机」处理（addPost 一开头就写本地了），
        // 提示也照实说，绝不让人反复重写一遍
        timeoutValue: { ok: false, saved: false, msg: '这次超时了，内容已经留在本机' },
        timeoutMsg: '这次超时了，内容已经留在本机'
      });
      r = run.value || null;
      timedOut = run.timedOut;
      console.log('[zjgsu:post] run 结束', { timedOut: timedOut, ok: !!(r && r.ok), 耗时: Date.now() - (this._submitAt || 0) });
    } catch (e) {
      // 网络超时 / 云函数崩了：也必须落到下面统一提示，不能让流程断在半路
      r = { ok: false, saved: false, msg: '网络好像不太稳，内容先存在本机了' };
    } finally {
      clearTimeout(slowTimer);
      wd.cancel();
      feedback.hideLoading();
      this.setData({ submitting: false });
    }

    if (timedOut) return;   // run() 已经把话说过了，别再叠一句

    if (!r || r.ok === false) {
      // 云端存不住时内容还在本机，说清楚「到底发没发出去」
      await feedback.toast((r && r.msg) || '内容没能发出去');
      return;
    }
    // 只有「不可逆且落到云端了」的动作才震：帖子发出去就收不回来。
    // 收藏、投票这类有即时可见状态变化的动作一律不震，免得变成噪音。
    feedback.buzz();
    // reused = 这一条本来就已经在列表里了（上一次其实发成功了，只是没等到回执）。
    // 这时候说「发布成功」是骗人 —— 用户会以为又发了一条，去列表里找却只有一条
    if (r.reused) await feedback.toast('这条已经发出去了，去列表看看');
    else await feedback.ok('发布成功');
    // 这一条到此为止，下一条用新的幂等键
    this._clientId = '';
    // 发成功了就别让 onUnload 再自动存一遍草稿（不然刚发的内容又进草稿箱）
    this._published = true;
    // 从草稿箱恢复着发的，发完就把那条草稿撤掉，
    // 否则草稿箱里会留一条跟刚发的帖子一模一样的东西，看着像出了错
    // 兜一层 try：清草稿要写本地存储，存储满了会抛异常 ——
    // 那是件小事，不该把「发布成功之后返回列表」这件大事给打断
    try {
      if (this.data.draftId) store.removeDraft(this.data.draftId);
    } catch (e) {}
    // 900ms 返回：够看清「发布成功」，又不用干等。
    // 授权已经在上面的 submit 开头要过了（那才是点击手势所在的位置），
    // 这里只负责返回 —— 绝对不要再往回调里塞 requestSubscribeMessage，
    // 那个时机微信是不认的。
    setTimeout(() => wx.navigateBack(), 900);
  }
});
