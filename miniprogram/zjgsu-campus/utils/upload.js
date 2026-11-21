// utils/upload.js —— 选图 / 选文件 / 上传云存储的统一入口
//
// 为什么要单独抽一层：
//   之前「选图」「选文件」各写各的，三处代码三种处理方式 ——
//   chooseMedia 失败静默、chooseMessageFile 失败直接 fail:()=>{} 吞掉、
//   上传失败只弹一句「上传失败」。用户看到的就是「点击没反应」。
//
// 这一层统一负责四件事：
//   1）隐私授权门：app.json 开了 __usePrivacyCheck__，相册 / 聊天文件都属隐私接口，
//      没走授权会被微信直接拦下（errMsg 里带 privacy/auth/permission）；
//   2）真机上可能没有 chooseMedia / chooseMessageFile，逐个降级；
//   3）失败一定有可读的原因，绝不静默；
//   4）上传带进度回调 + 超时兜底，大文件不会让人干等。

const cloud = require('./cloud.js');
// 提示统一走反馈层（先收 Loading、先收键盘，再隔一帧弹），别再裸调 wx.showToast
const feedback = require('./feedback.js');

// 上传超时：云存储卡住时 promise 会一直挂着，
// 用户看到的是「上传中」转圈到天荒地老（其实早就失败了）
const UPLOAD_TIMEOUT_MS = 60 * 1000;
const UPLOAD_TIMEOUT_MIN = 20 * 1000;
const UPLOAD_TIMEOUT_MAX = 90 * 1000;

// 超时不该是个死数：一张 200KB 的图和一份 15MB 的真题压缩包，
// 「等多久算异常」显然不是一个量级。
// 固定 60 秒的坏处是两头不讨好 —— 小图真出故障时用户要干等一分钟才看到失败，
// 大文件在弱网下又可能刚传一半就被判超时。改成按体积给：
// 20 秒起步，每 1MB 多给 4 秒，封顶 90 秒。
function timeoutFor(size) {
  const mb = (Number(size) || 0) / 1024 / 1024;
  const t = UPLOAD_TIMEOUT_MIN + mb * 4000;
  return Math.max(UPLOAD_TIMEOUT_MIN, Math.min(UPLOAD_TIMEOUT_MAX, t));
}

function isGifPath(path) {
  return /\.gif(?:$|\?)/i.test(String(path || ''));
}

function isCancel(err) {
  const m = String((err && err.errMsg) || '').toLowerCase();
  return m.indexOf('cancel') >= 0;
}

// 微信把「隐私未授权 / 权限被拒 / 接口不支持」都塞在 errMsg 里，
// 这里统一翻译成一句人话，别让用户对着 "chooseMedia:fail privacy" 猜
// errMsg 的通用形状是「接口名:fail 失败原因」。
// ⚠️ 判断失败原因时必须只看冒号**后面**那一段：
//   'requirePrivacyAuthorize:fail not support' 里，接口名本身就带 "Privacy"，
//   拿整串做 indexOf('privacy') 必然命中 —— 于是「老版本不支持这个接口」会被
//   误判成「用户拒绝隐私授权」，明明能用却被掐死。
function failReason(err) {
  const m = String((err && err.errMsg) || err || '').toLowerCase();
  const at = m.indexOf(':fail');
  return at >= 0 ? m.slice(at + 5) : m;
}

function humanReason(err, fallback) {
  const r = failReason(err);
  if (!r) return fallback || '操作没成功，再试一次';
  if (r.indexOf('privacy') >= 0) return '需要先同意隐私保护指引才能选文件';
  if (r.indexOf('auth deny') >= 0 || r.indexOf('unauthorized') >= 0 || r.indexOf('permission') >= 0) {
    return '没拿到权限，去微信设置里开一下';
  }
  if (r.indexOf('not support') >= 0 || r.indexOf('unsupported') >= 0) {
    return '这台设备的微信版本太老，换个方式试试';
  }
  if (r.indexOf('network') >= 0 || r.indexOf('timeout') >= 0) {
    return '网络不太顺，换个地方再试';
  }
  if (r.indexOf('size') >= 0 || r.indexOf('large') >= 0) return '文件太大了';
  if (r.indexOf('no file') >= 0 || r.indexOf('empty') >= 0) return '没选到文件';
  return fallback || '操作没成功，再试一次';
}

// 隐私授权门：需要授权时会弹微信的授权窗（app.js 里注册过 onNeedPrivacyAuthorization）。
// 拿不到授权就如实返回 false，由调用方决定要不要继续。
//
// ⚠️ 这里踩过一次「修一个 bug 引出另一个 bug」，值得记下来：
//   旧版是「无条件 await requirePrivacyAuthorize + 8 秒超时兜底」。
//   当后台《用户隐私保护指引》漏勾了某一项（比如「收集你选中的文件」）时，
//   这个接口既不 success 也不 fail，于是**每点一次「加图 / 选文件」都要先白等 8 秒**
//   才弹出提示 —— 用户看到的现象就是「点了没反应 / 等待时间过长」。
//
// 现在改成三段式，把「无谓等待」压到接近 0：
//   1）缓存：本次生命周期里已经确认过授权，直接放行，零开销；
//   2）快探：wx.getPrivacySetting 毫秒级返回，needAuthorization=false 就放行；
//   3）真授权：确实需要授权时才调 requirePrivacyAuthorize，超时降到 3 秒；
//      且超时一律「放行」而不是「拒绝」—— 让微信原生接口自己的报错（会带 privacy 字样）
//      暴露出来，交给 humanReason 翻译成人话，总比让用户干等强。
const PRIVACY_TIMEOUT_MS = 3000;
const PRIVACY_PROBE_MS = 1500;
let privacyGranted = false; // 本次运行期已确认授权
let privacyWarned = false;  // 超时提示只弹一次，别每次点「加图」都弹

// 问一句「现在需不需要授权」：比 requirePrivacyAuthorize 轻得多，通常几十毫秒回来。
// 拿不到（接口不存在 / 超时）返回 null，意思是「不知道」，由调用方按「不拦」处理。
function privacySetting() {
  return new Promise((resolve) => {
    if (!wx.getPrivacySetting) return resolve(null);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), PRIVACY_PROBE_MS);
    try {
      wx.getPrivacySetting({
        success: (res) => { clearTimeout(timer); done(res || null); },
        fail: () => { clearTimeout(timer); done(null); }
      });
    } catch (e) {
      clearTimeout(timer);
      done(null);
    }
  });
}

function ensurePrivacy() {
  if (!wx.requirePrivacyAuthorize) return Promise.resolve(true); // 老版本不做隐私校验
  if (privacyGranted) return Promise.resolve(true);

  return privacySetting().then((setting) => {
    // 探测不到 = 「不知道」，放行；真被拦下时原生接口会带 privacy 报错，照样能翻译成人话
    if (!setting) return true;
    // 明确不需要授权：记住，这次运行期内后面都不用再问
    if (!setting.needAuthorization) { privacyGranted = true; return true; }

    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => {
        if (!privacyWarned) {
          privacyWarned = true;
          // 走反馈层：裸调 wx.showToast 会被同一时刻的 Loading 抹掉，也会被键盘挡住
          feedback.toast('隐私授权没响应，如无法选图请到微信确认已同意隐私指引', { duration: 3000 });
        }
        // 超时放行：宁可让微信自己报错，也别让用户对着空白干等
        done(true);
      }, PRIVACY_TIMEOUT_MS);
      try {
        wx.requirePrivacyAuthorize({
          success: () => { clearTimeout(timer); done(true); },
          fail: (e) => {
            clearTimeout(timer);
            // ⚠️ 旧实现这里写反了：条件是「既不含 privacy 也不含 not support 才放行」，
            // 于是 'requirePrivacyAuthorize:fail not support'（老基础库根本没有这个接口，
            // 说明这个环境根本不做隐私校验）被当成了「用户拒绝授权」，直接把功能掐死 ——
            // 和它上面那句注释说的完全是两回事。
            // 正确逻辑：只有失败原因里明确是隐私/授权才拦下，其余一律放行。
            // 这里必须走 failReason（只看冒号后），否则接口名里的 Privacy 会永远命中
            const r = failReason(e);
            done(!(r.indexOf('privacy') >= 0 || r.indexOf('unauthorized') >= 0 || r.indexOf('authorize') >= 0));
          }
        });
      } catch (e) {
        clearTimeout(timer);
        done(true);
      }
    });
  }).then((ok) => {
    if (ok) privacyGranted = true;
    return ok;
  });
}

/**
 * 选图片。
 * @param {number} count 最多几张
 * @returns {Promise<{ok:boolean, files:string[], msg?:string, canceled?:boolean}>}
 */
async function pickImages(count) {
  const n = Math.max(1, Number(count) || 1);
  const okPrivacy = await ensurePrivacy();
  if (!okPrivacy) {
    return { ok: false, files: [], msg: '需要先同意隐私保护指引才能选图' };
  }

  const picked = (res) => {
    const files = (res.tempFiles || []).map((f) => f.tempFilePath).filter(Boolean);
    const list = files.length ? files : (res.tempFilePaths || []);
    return list.filter(Boolean);
  };

  // 优先 chooseMedia（一次选多张 + 可现拍），没有就退回 chooseImage
  if (wx.chooseMedia) {
    const r = await new Promise((resolve) => {
      wx.chooseMedia({
        count: n,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: (res) => resolve({ ok: true, res: res }),
        fail: (err) => resolve({ ok: false, err: err })
      });
    });
    if (r.ok) {
      const files = picked(r.res);
      if (files.length) return { ok: true, files: files };
      return { ok: false, files: [], msg: '没读到图片，换一张试试' };
    }
    // 用户自己退出相册不算错误
    if (isCancel(r.err)) return { ok: false, files: [], canceled: true, msg: '' };
    // 拍照不可用时退回只选相册，别把整条路堵死
    const fb = await new Promise((resolve) => {
      if (!wx.chooseImage) return resolve(null);
      wx.chooseImage({
        count: n, sizeType: ['compressed'], sourceType: ['album'],
        success: (res) => resolve({ ok: true, res: res }),
        fail: (err) => resolve({ ok: false, err: err })
      });
    });
    if (fb && fb.ok) {
      const files = picked(fb.res);
      if (files.length) return { ok: true, files: files };
      return { ok: false, files: [], msg: '没读到图片，换一张试试' };
    }
    if (fb && !fb.ok && isCancel(fb.err)) return { ok: false, files: [], canceled: true, msg: '' };
    return { ok: false, files: [], msg: humanReason((fb && fb.err) || r.err, '选图没打开') };
  }

  if (wx.chooseImage) {
    const r = await new Promise((resolve) => {
      wx.chooseImage({
        count: n, sizeType: ['compressed'], sourceType: ['album', 'camera'],
        success: (res) => resolve({ ok: true, res: res }),
        fail: (err) => resolve({ ok: false, err: err })
      });
    });
    if (r.ok) {
      const files = picked(r.res);
      if (files.length) return { ok: true, files: files };
      return { ok: false, files: [], msg: '没读到图片，换一张试试' };
    }
    if (isCancel(r.err)) return { ok: false, files: [], canceled: true, msg: '' };
    return { ok: false, files: [], msg: humanReason(r.err, '选图没打开') };
  }

  return { ok: false, files: [], msg: '这台设备不支持选图' };
}

/**
 * 选 GIF 表情。先从聊天文件里选 .gif；没有该接口时退回相册原图选择，
 * 再过滤出 GIF。小程序无法直接读取微信表情收藏面板。
 */
async function pickGif(count) {
  const n = Math.max(1, Number(count) || 1);
  const okPrivacy = await ensurePrivacy();
  if (!okPrivacy) return { ok: false, files: [], msg: '需要先同意隐私保护指引才能选 GIF' };

  const filesOf = (res) => (res && (res.tempFiles || []))
    ? res.tempFiles.map((f) => f.path || f.tempFilePath || '').filter(Boolean).filter(isGifPath)
    : [];

  if (wx.chooseMessageFile) {
    const r = await new Promise((resolve) => {
      wx.chooseMessageFile({
        count: n,
        type: 'file',
        extension: ['gif'],
        success: (res) => resolve({ ok: true, res: res }),
        fail: (err) => resolve({ ok: false, err: err })
      });
    });
    if (r.ok) {
      const files = filesOf(r.res);
      if (files.length) return { ok: true, files: files };
      return { ok: false, files: [], msg: '没有选到 GIF 文件' };
    }
    if (isCancel(r.err)) return { ok: false, files: [], canceled: true, msg: '' };
  }

  if (wx.chooseMedia) {
    const r = await new Promise((resolve) => {
      wx.chooseMedia({
        count: n,
        mediaType: ['image'],
        sizeType: ['original'],
        sourceType: ['album'],
        success: (res) => resolve({ ok: true, res: res }),
        fail: (err) => resolve({ ok: false, err: err })
      });
    });
    if (r.ok) {
      const files = filesOf(r.res);
      if (files.length) return { ok: true, files: files };
      return { ok: false, files: [], msg: '相册里没有识别到 GIF，请选择 .gif 文件' };
    }
    if (isCancel(r.err)) return { ok: false, files: [], canceled: true, msg: '' };
    return { ok: false, files: [], msg: humanReason(r.err, 'GIF 没打开') };
  }
  return { ok: false, files: [], msg: '这台设备不支持选择 GIF' };
}

// 一次最多选几个。微信允许到 100，但学习资料一次传十几份已经够呛：
// 每份都要上传 + 发布，中途失败要能说清是哪一份，队列太长反而没人看得完
const MAX_PICK_FILES = 9;

/**
 * 选文件（PDF / Word / PPT 这类学习资料），支持一次选多个。
 * 只能从聊天记录里选，这是微信给小程序的唯一入口。
 * @param {string[]} extensions 限定后缀，不传就是任意文件
 * @param {number} count 最多几个，默认 9
 * @returns {Promise<{ok:boolean, files:{path,name,size}[], msg?:string, canceled?:boolean}>}
 */
async function pickFiles(extensions, count) {
  const okPrivacy = await ensurePrivacy();
  if (!okPrivacy) {
    return { ok: false, files: [], msg: '需要先同意隐私保护指引才能选文件' };
  }
  if (!wx.chooseMessageFile) {
    return { ok: false, files: [], msg: '这台设备的微信版本太老，选不了文件' };
  }

  const want = Math.max(1, Math.min(MAX_PICK_FILES, Number(count) || MAX_PICK_FILES));

  const once = (opt) => new Promise((resolve) => {
    wx.chooseMessageFile(Object.assign({ count: want }, opt, {
      success: (res) => resolve({ ok: true, res: res }),
      fail: (err) => resolve({ ok: false, err: err })
    }));
  });

  // 先按「文件 + 指定后缀」选；老版本不认 extension 就退回不带后缀；
  // 再不行就 type:'all'。三档都试过还是失败，才如实报原因。
  const tries = [];
  if (extensions && extensions.length) tries.push({ type: 'file', extension: extensions });
  tries.push({ type: 'file' });
  tries.push({ type: 'all' });

  let lastErr = null;
  for (const opt of tries) {
    const r = await once(opt);
    if (r.ok) {
      const raw = r.res.tempFiles || [];
      // 有些版本在只选一个时给的字段不一样，逐个兜底，别让整批因为一个字段落空
      const files = raw.map((f) => ({
        path: f.path || f.tempFilePath || '',
        name: f.name || String(f.path || f.tempFilePath || '').split('/').pop() || '文件',
        size: Number(f.size) || 0
      })).filter((f) => !!f.path);
      if (!files.length) return { ok: false, files: [], msg: '没选到文件，换个聊天记录里的文件试试' };
      return { ok: true, files: files };
    }
    lastErr = r.err;
    if (isCancel(r.err)) return { ok: false, files: [], canceled: true, msg: '' };
  }
  return { ok: false, files: [], msg: humanReason(lastErr, '选文件没打开') };
}

/**
 * 选单个文件。批量版的薄封装 ——
 * 降级逻辑只有一份，不会出现「单选能用、多选卡住」这种两边不一致。
 */
async function pickFile(extensions) {
  const r = await pickFiles(extensions, 1);
  if (!r.ok) return { ok: false, file: null, msg: r.msg, canceled: r.canceled };
  return { ok: true, file: r.files[0] };
}

/**
 * 上传到云存储。
 * @param {string} filePath 本地临时路径
 * @param {string} cloudPath 云端路径
 * @param {(p:number)=>void} onProgress 0-100
 * @returns {Promise<{ok:boolean, fileID?:string, msg?:string}>}
 */
async function uploadFile(filePath, cloudPath, onProgress) {
  if (!cloud.ensureCloud()) {
    return { ok: false, msg: '云存储没开通' };
  }
  if (!filePath) return { ok: false, msg: '文件路径是空的' };

  const waitMs = timeoutFor(await fileSize(filePath));

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done({ ok: false, msg: '上传超时了，换个网络再试' }), waitMs);

    let task;
    try {
      task = wx.cloud.uploadFile({
        cloudPath: cloudPath,
        filePath: filePath,
        success: (r) => {
          clearTimeout(timer);
          done((r && r.fileID) ? { ok: true, fileID: r.fileID } : { ok: false, msg: '上传没拿到文件 ID' });
        },
        fail: (e) => {
          clearTimeout(timer);
          console.error('[upload] failed:', String((e && e.errMsg) || e));
          done({ ok: false, msg: humanReason(e, '上传失败') });
        }
      });
    } catch (e) {
      clearTimeout(timer);
      done({ ok: false, msg: humanReason(e, '上传失败') });
      return;
    }

    // 大文件必须有进度：传一张 10MB 的图时，没有进度条用户以为卡死了。
    // 有的版本返回的是 UploadTask（带 onProgressUpdate），有的直接是 promise —— 两种都认
    if (task && typeof task.onProgressUpdate === 'function' && typeof onProgress === 'function') {
      try {
        task.onProgressUpdate((res) => {
          const p = Number(res && res.progress) || 0;
          onProgress(p > 100 ? 100 : p);
        });
      } catch (e) { /* 拿不到进度不影响上传本身 */ }
    }
    if (task && typeof task.then === 'function') {
      task.then((r) => {
        clearTimeout(timer);
        done((r && r.fileID) ? { ok: true, fileID: r.fileID } : { ok: false, msg: '上传没拿到文件 ID' });
      }).catch((e) => {
        clearTimeout(timer);
        console.error('[upload] rejected:', String((e && e.errMsg) || e));
        done({ ok: false, msg: humanReason(e, '上传失败') });
      });
    }
  });
}

/* ---------------- 压缩 ---------------- */

// 超过这个体积才处理：小图多压一次是白赔一次编解码（旧机型上肉眼可见的几百毫秒）。
const COMPRESS_THRESHOLD = 200 * 1024; // 200KB
// 压缩质量 1–100。70 在手机屏上几乎看不出差别。
const COMPRESS_QUALITY = 70;
// 长边上限（像素）。这一条比 quality 关键得多：
//   手机相册直出的图长边常常 3000–4000px，只调 quality 是把「一张又大又糊的图」
//   变成「一张又大又更糊的图」——体积砍不动多少，上传时间几乎没省。
//   把长边压到 1280（约等于主流手机屏一倍图宽的显示需求），
//   像素数直接降到原来的 1/6 ~ 1/10，3MB 的原图通常落到 150–300KB，
//   上传时间按秒级下降。这是整个上传链路里收益最大的一刀。
const MAX_EDGE = 1280;

// 压缩结果缓存（key = 原始路径，value = 压缩任务的 Promise）。
// 存 Promise 而不是结果：预热（prewarm）刚开始压、正式上传紧接着来问时，
// 拿到的是同一个 Promise —— 排队等它压完即可，绝不会同一张图压两遍。
const compressCache = new Map();
const COMPRESS_CACHE_MAX = 30;

function rememberCompress(key, promise) {
  if (compressCache.size >= COMPRESS_CACHE_MAX) {
    // 简单的先进先出：小程序内存有限，别让缓存无限涨
    const first = compressCache.keys().next().value;
    if (first !== undefined) compressCache.delete(first);
  }
  compressCache.set(key, promise);
}

/**
 * 读一个本地文件的真实体积（字节）。拿不到就返回 0，由调用方决定要不要压。
 */
function fileSize(path) {
  return new Promise((resolve) => {
    try {
      const fs = wx.getFileSystemManager();
      if (!fs || !fs.getFileInfo) return resolve(0);
      fs.getFileInfo({
        filePath: path,
        success: (r) => resolve(Number(r && r.size) || 0),
        fail: () => resolve(0)
      });
    } catch (e) {
      resolve(0);
    }
  });
}

/**
 * 读一张图的像素宽高。拿不到（接口不存在 / 文件不是图 / 超时）返回 null。
 */
function imageSize(path) {
  return new Promise((resolve) => {
    if (!wx.getImageInfo) return resolve(null);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), 3000);
    try {
      wx.getImageInfo({
        src: path,
        success: (r) => {
          clearTimeout(timer);
          done({ width: Number(r && r.width) || 0, height: Number(r && r.height) || 0 });
        },
        fail: () => { clearTimeout(timer); done(null); }
      });
    } catch (e) {
      clearTimeout(timer);
      done(null);
    }
  });
}

/**
 * 真正的压缩动作（不查缓存）。
 * 触发条件：体积超阈值。够格了才去读尺寸，避免给每张小图都白付一次解码开销。
 */
async function compressNow(path, o) {
  // GIF 压缩会把动图变成静态图，直接保留原文件。
  if (isGifPath(path)) return { path: path, size: 0, compressed: false };
  const size = await fileSize(path);
  // 读不到体积 / 设备不支持：都用原图，绝不因为压缩把流程卡住
  if (!size || !wx.compressImage) return { path: path, size: size, compressed: false };
  if (size <= o.threshold) return { path: path, size: size, compressed: false };

  // 长边超上限才缩放。不判断就传 compressedWidth，微信会把小图「放大」——
  // 那种越压越大、还变模糊的结果比不压更糟
  const dim = await imageSize(path);
  const copt = { src: path, quality: o.quality };
  if (dim && dim.width && dim.height && Math.max(dim.width, dim.height) > o.maxEdge) {
    // 只给长边那一边，另一边微信按比例算 —— 这才是等比缩放
    if (dim.width >= dim.height) copt.compressedWidth = o.maxEdge;
    else copt.compressedHeight = o.maxEdge;
  }

  const out = await new Promise((resolve) => {
    wx.compressImage(Object.assign(copt, {
      success: (r) => resolve((r && r.tempFilePath) || ''),
      fail: () => resolve('')
    }));
  });
  if (!out) return { path: path, size: size, compressed: false };

  const after = await fileSize(out);
  // 压完反而更大（已经压过的图、部分 png 会这样）：还是用原图
  if (after && after >= size) return { path: path, size: size, compressed: false };
  return { path: out, size: after || size, compressed: true, saved: size - (after || size) };
}

/**
 * 图片「按需压缩」：小图原样返回，大图压一道（降分辨率 + 降画质）。
 * @param {string} path 本地临时路径
 * @param {{threshold?:number, quality?:number, maxEdge?:number}} opt
 * @returns {Promise<{path:string, size:number, compressed:boolean, saved?:number}>}
 */
function compressIfNeeded(path, opt) {
  if (isGifPath(path)) return Promise.resolve({ path: path, size: 0, compressed: false });
  const o = opt || {};
  const conf = {
    threshold: Number(o.threshold) || COMPRESS_THRESHOLD,
    quality: Number(o.quality) || COMPRESS_QUALITY,
    maxEdge: Number(o.maxEdge) || MAX_EDGE
  };
  // 命中预热：拿到的可能还是个没跑完的 Promise，await 它就等于排队等预热结果，
  // 不会出现「预热压一遍、上传又压一遍」
  let p = compressCache.get(path);
  if (!p) {
    p = compressNow(path, conf);
    rememberCompress(path, p);
  }
  return p;
}

/**
 * 预热压缩：选完图立刻在后台开始压，不等用户点「发布」。
 *
 * 这是把「等待」从用户眼前挪走的关键一步 —— 选完图到点发布之间，
 * 用户还要填标题、正文、选板块，通常有十几秒。压缩（本地 CPU 编解码，
 * 大图 1–2 秒）正好在这段时间里悄悄做完，点发布时就只剩上传。
 *
 * 不阻塞：失败、不支持、拿不到尺寸都无所谓，正式上传时自然会再走一遍。
 * @param {string[]} files
 * @returns {Promise<number>} 完成的数量
 */
function prewarm(files) {
  const list = (files || []).filter(Boolean).filter((p) => !isGifPath(p));
  if (!list.length || !wx.compressImage) return Promise.resolve(0);
  return Promise.all(list.map((p) => {
    if (compressCache.has(p)) return Promise.resolve(null);
    const conf = {
      threshold: COMPRESS_THRESHOLD,
      quality: COMPRESS_QUALITY,
      maxEdge: MAX_EDGE
    };
    const job = compressNow(p, conf).catch(() => ({ path: p, size: 0, compressed: false }));
    rememberCompress(p, job);
    return job;
  })).then((rs) => rs.filter((r) => r && r.compressed).length).catch(() => 0);
}

/* ---------------- 批量上传（并发队列 + 真实进度） ---------------- */

// 并发度：一次把 6 张图全塞出去会互相抢带宽，总体反而更慢，内存也容易顶上去。
// 3 是个折中 —— 单张基本能跑满，多张也不用排太久。
const UPLOAD_CONCURRENCY = 3;

/**
 * 多文件并发上传。
 *
 * 进度怎么算（这里刻意不造假）：微信云存储 `wx.cloud.uploadFile` 在小程序端
 * 只给 promise、不给上传任务，拿不到真实字节进度；能给进度的版本我们照样接
 * （uploadFile 内部已处理 onProgressUpdate）。所以整体进度 = 每个文件各自完成度
 * 的平均值，完成度只有 0（正在传）和 100（传完了）两种真值 —— 传完一张就往前走一格，
 * 决不用「按时间假装推进」的假百分比糊弄用户。
 *
 * @param {string[]} files 本地路径数组
 * @param {object} opt
 *   prefix      云端路径前缀（forum / market / resources）
 *   compress    是否先压缩（默认 true，只对图片有意义；传 PDF 请关掉）
 *   concurrency 并发数，默认 3
 *   onProgress  (pct:number)=>void 0–100
 *   onDone      (doneCount:number, total:number)=>void 每完成一个回调
 *   fallback    (原路径, 序号, 失败原因)=>Promise<string> 上传失败时的保底方案（如存本机）
 * @returns {Promise<{list:string[], ok:string[], failed:number}>}
 *   list 与入参顺序一致，失败项为 ''
 */
async function uploadMany(files, opt) {
  const o = opt || {};
  const list = (files || []).filter(Boolean);
  const total = list.length;
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : function () {};
  const onDone = typeof o.onDone === 'function' ? o.onDone : function () {};
  const prefix = o.prefix || 'misc';
  const compress = o.compress !== false;
  const concurrency = Math.max(1, Number(o.concurrency) || UPLOAD_CONCURRENCY);
  const fallback = typeof o.fallback === 'function' ? o.fallback : null;

  if (!total) return { list: [], ok: [], failed: 0 };

  const per = new Array(total).fill(0);
  const results = new Array(total).fill('');
  const report = function () {
    let sum = 0;
    for (let i = 0; i < total; i += 1) sum += per[i];
    onProgress(Math.min(99, Math.floor(sum / total)));
  };

  let cursor = 0;

  // 每个 worker 自己往下抢任务，抢完为止 —— 队列空了就自然结束
  async function work() {
    for (;;) {
      const i = cursor;
      if (i >= total) return;
      cursor += 1;

      let src = list[i];
      if (compress) {
        const shrunk = await compressIfNeeded(src, o);
        src = shrunk.path;
      }

      // 扩展名要按「原始文件」算，不能按压缩后的临时路径算：
      // 压缩产物叫 xxx.jpg.compressed，直接 .pop() 会拿到 'compressed'，
      // 存到云上就变成一个没类型的文件（下载 / 预览时认不出来）
      const ext = String(list[i].split('.').pop() || 'jpg').toLowerCase();
      const r = await uploadFile(src, cloudPathFor(prefix, ext), (p) => {
        per[i] = p;
        report();
      });

      if (r && r.ok && r.fileID) {
        results[i] = r.fileID;
      } else if (fallback) {
        results[i] = (await fallback(list[i], i, (r && r.msg) || '')) || '';
      }
      per[i] = 100;
      report();
      onDone(i + 1, total);
    }
  }

  const workers = [];
  const n = Math.min(concurrency, total);
  for (let s = 0; s < n; s += 1) workers.push(work());
  await Promise.all(workers);

  const ok = results.filter(Boolean);
  onProgress(100);
  return { list: results, ok: ok, failed: total - ok.length };
}

// 云端路径：按「业务前缀 / 我的身份 / 时间戳 + 随机数」命名，
// 同名不覆盖、不同用户不串号
function cloudPathFor(prefix, ext) {
  const e = String(ext || '').replace(/^\./, '').toLowerCase() || 'dat';
  const me = cloud.getOpenid() || 'me';
  return prefix + '/' + me + '_' + Date.now() + '_'
    + Math.floor(Math.random() * 1000) + '.' + e;
}

module.exports = {
  ensurePrivacy,
  pickImages,
  pickGif,
  pickFile,
  pickFiles,
  uploadFile,
  uploadMany,
  compressIfNeeded,
  prewarm,
  imageSize,
  fileSize,
  timeoutFor,
  cloudPathFor,
  humanReason,
  UPLOAD_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MIN,
  UPLOAD_TIMEOUT_MAX,
  COMPRESS_THRESHOLD,
  COMPRESS_QUALITY,
  MAX_EDGE,
  UPLOAD_CONCURRENCY,
  isGifPath
};
