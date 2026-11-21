// utils/report.js —— 客户端错误上报（唯一的出口）
//
// 真机上 console.error 没人看得见。小程序出错时同学只会说「打不开」「点了没反应」，
// 没有堆栈就只能靠猜。这里把**意外**错误送进云端 errors 集合，排查时有处可对。
//
// 四条纪律，都是踩过的坑反过来定的：
//
//   1. 只报意外，不报预期内的失败。
//      断网、用户点取消、表单没填完、内容命中敏感词 —— 这些都是正常流程的
//      一部分，报上来只会淹没真正的 bug。所以这里是**手动调用**的，
//      不挂在每个 catch 上：那种挂法一次断网能写几十条，等于没有。
//
//   2. 同一个错误要合并。
//      列表渲染里出错的话，每条数据都会报一次，一次冷启动就能写几百条。
//      所以按「作用域 + 消息」做指纹，静默期内只报一次。
//
//   3. 单次启动有封顶。
//      真出大问题时（比如某个 util 整个挂了），页面会连锁报错。
//      一次启动最多报 MAX_PER_SESSION 条不同的，剩下的只留在 console。
//
//   4. 上报自己永远不能出错、不能阻塞、不能弹任何东西。
//      上报失败的代价不该由用户承担 —— 用户已经遇到一个错误了，
//      不能因为上报又给他弹一个。

const QUIET_MS = 30 * 60 * 1000;  // 同一个指纹 30 分钟内只报一次
const KEEP_MS = 6 * 60 * 60 * 1000; // 指纹表最多留 6 小时，之后清掉
const MAX_PER_SESSION = 8;        // 一次启动最多报 8 条不同的错误
const KEY = 'zjgsu_err_fingerprints';

// 本次启动已经报过的（进程内去重，比读 storage 快得多）
const memSeen = {};
let sessionCount = 0;

function msgOf(err) {
  if (err === null || err === undefined) return '';
  if (typeof err === 'string') return err;
  // 微信的失败回调大多给 { errMsg: 'xxx:fail ...' }
  if (err.errMsg) return String(err.errMsg);
  if (err.message) return String(err.message);
  try {
    return String(err);
  } catch (e) {
    return '（错误信息无法转成字符串）';
  }
}

function fingerprint(scope, msg) {
  // 只取前 80 字：消息里常带 id、时间戳这类每次都不同的东西，
  // 全量做指纹的话同一类错误每次都会被当成新错误
  return String(scope || 'unknown') + '|' + String(msg).slice(0, 80);
}

function readSeen() {
  try {
    const v = wx.getStorageSync(KEY);
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}

function writeSeen(map) {
  try {
    wx.setStorageSync(KEY, map);
  } catch (e) { /* 存不下就算了，去重本来就是尽力而为 */ }
}

// 顺手清掉过期的指纹：这张表每次报错都要读写，
// 不清的话几个月下来会变成几百条，白白拖慢每一次上报
function prune(map) {
  const cut = Date.now() - KEEP_MS;
  let changed = false;
  Object.keys(map).forEach((k) => {
    if (!map[k] || map[k] < cut) {
      delete map[k];
      changed = true;
    }
  });
  return changed;
}

/**
 * 上报一个意外错误。
 * @param {string} scope  出错的地方，形如 'chat.send' / 'app.onError'
 * @param {Error|string|object} err  错误本体
 * @param {object} [extra]  附带信息（页面、id 之类，别放隐私字段）
 * @returns {Promise<boolean>} 是否真的发出去了
 */
function report(scope, err, extra) {
  const msg = msgOf(err);
  if (!msg) return Promise.resolve(false);
  const fp = fingerprint(scope, msg);

  // 进程内去重放最前面：真出连锁错误时，这一层拦掉绝大多数重复，
  // 后面读写 storage 的开销就根本不会发生
  if (memSeen[fp]) return Promise.resolve(false);
  if (sessionCount >= MAX_PER_SESSION) {
    console.warn('[report] 本次启动上报已达上限，这条只留在 console：', fp);
    return Promise.resolve(false);
  }

  try {
    const seen = readSeen();
    const last = seen[fp] || 0;
    if (last && Date.now() - last < QUIET_MS) return Promise.resolve(false);

    memSeen[fp] = Date.now();
    seen[fp] = Date.now();
    prune(seen); // 就地删掉过期条目，再把瘦身后的整张表写回
    writeSeen(seen);
    sessionCount += 1;

    // Error 的 stack 在真机上有、开发者工具里更全。截一段就够定位，
    // 整段存下来一条能占几 KB，没必要
    const stack = (err && typeof err.stack === 'string')
      ? String(err.stack).slice(0, 300)
      : '';

    return require('./user.js').reportError(scope, msg, Object.assign({
      stack: stack,
      // 基础库和系统版本：很多问题只在特定版本上出现，没有这两行
      // 「我这里好的」和「他那里坏的」永远对不上
      sdk: (wx.getAppBaseInfo && wx.getAppBaseInfo().SDKVersion) || ''
    }, extra || {})).then(() => true, () => false);
  } catch (e) {
    // 上报自身出错：只记 console，绝不能往回抛
    console.error('[report] 上报失败：', e);
    return Promise.resolve(false);
  }
}

/**
 * 只在开关打开时上报。用于「我知道这里可能失败，但只在云模式下才值得看」的场景。
 */
function reportIfCloud(scope, err, extra) {
  try {
    if (!require('./cloud.js').cfg.USE_CLOUD) return Promise.resolve(false);
  } catch (e) {
    return Promise.resolve(false);
  }
  return report(scope, err, extra);
}

module.exports = { report, reportIfCloud };
