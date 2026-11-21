// utils/unread.js —— 小红点：我的帖子被回复 + 私信未读
//
// 为什么单独抽一个模块：
//   这两处红点的数据来源完全不同（一个来自本地帖子缓存，一个来自云函数），
//   但「什么时候亮、亮在哪、什么时候清」是同一套规则。散在页面里必然各写各的：
//   帖子详情点进去忘了清、清早了又漏一条，最后没人说得清红点为什么还亮着。
//   收口在这里，改一处全站一致。
//
// 帖子回复的判定不用「未读消息表」（那要服务端配合存一份每人的未读指针），
// 而用「已读水位」这个纯本地的办法：
//   每条我的帖子记一个水位 = 我上次看到时这条帖子的留言条数（缓存键 zjgsu_post_seen）。
//   现在这条帖子的留言条数 - 水位 > 0 → 这条帖子有新回复，差值就是未读数。
//   水位只在两处推进：① 我打开这条帖子的详情页；② 我刚发完这条帖子。
//
// 首次遇到「没有水位的帖子」时按当前条数建水位（不亮红点）——
// 否则老同学一升级，半年前的帖子会一次性亮出一排红点，红点从此失去意义。

const store = require('./store.js');

const KEYS = { postSeen: 'zjgsu_post_seen' };

// 「我的」页在 tabBar 里的下标。app.json 的 list 顺序是
// 课程 0 / 论坛 1 / 闲置 2 / 校园 3 / 我的 4
const MINE_TAB_INDEX = 4;

// 私信未读要走云函数，不能每次进页面都问一遍：同一个会话里 30 秒内复用上次结果
const CHAT_THROTTLE_MS = 30 * 1000;

let chatUnreadCount = 0;
let lastChatAt = 0;
// 站内通知也有未读数。它和回复水位不是同一份数据：
// 别人刚回复时，本机还没有机会重新拉帖子，但通知中心已经能告诉我们“有新消息”。
let notifyUnreadCount = 0;
let lastNotifyAt = 0;
let lastReplySyncAt = 0;

function readSeen() {
  const v = wx.getStorageSync(KEYS.postSeen);
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

function writeSeen(map) {
  try { wx.setStorageSync(KEYS.postSeen, map); } catch (e) { /* 缓存写不进去不影响功能 */ }
}

/**
 * 推进某条帖子的已读水位。
 * @param {string} postId
 * @param {number} count 这条帖子当前的留言条数
 */
function markPostSeen(postId, count) {
  const id = String(postId || '');
  if (!id) return;
  const map = readSeen();
  // 直接记当前条数而不是取 max：留言被删掉后水位要跟着降，
  // 否则「删了两条又新增两条」会被算成没有新回复
  map[id] = Math.max(0, Number(count) || 0);
  writeSeen(map);
}

// 帖子被删了就把它那条水位一起清掉，免得这张表越用越长
function forgetPost(postId) {
  const id = String(postId || '');
  if (!id) return;
  const map = readSeen();
  if (map[id] === undefined) return;
  delete map[id];
  writeSeen(map);
}

/**
 * 我的帖子新回复：{ map: {帖子id: 未读条数}, total: 总未读 }
 * 没水位的帖子在这里顺便建水位（按当前条数），所以这个函数是幂等的
 */
function replyMap() {
  const seen = readSeen();
  const map = {};
  let total = 0;
  let dirty = false;

  (store.getMyPosts() || []).forEach((p) => {
    if (!p || !p.id) return;
    // 留言拆表后帖子上的 commentCount 才是权威数；
    // 本地 comments 只在打开过详情页后有值，拿它当水位会让红点凭空消失
    const n = Number(p.commentCount) || (p.comments || []).length;
    if (seen[p.id] === undefined) {
      // 没见过水位：按当前条数建立基线，这条帖子的历史留言不算「新回复」
      seen[p.id] = n;
      dirty = true;
      return;
    }
    const unread = n - (Number(seen[p.id]) || 0);
    if (unread > 0) {
      map[p.id] = unread;
      total += unread;
    }
  });

  if (dirty) writeSeen(seen);
  return { map: map, total: total };
}

function replyTotal() {
  return replyMap().total;
}

// 进详情页时一次性推进水位：把当前条数记成「已读」，红点随之消失
function markAllSeenFor(post) {
  if (!post || !post.id) return;
  markPostSeen(post.id, Number(post.commentCount) || (post.comments || []).length);
}

function markAllSeenForPosts(posts) {
  (Array.isArray(posts) ? posts : []).forEach(markAllSeenFor);
}


// tabBar 上的小红点。非 tabBar 页调用、老基础库不支持时都会失败 —— 静默即可，
// 红点只是提示，绝不能因为它报错把页面带崩
function paint(total) {
  const n = Math.max(0, Number(total) || 0);
  if (n > 0) {
    wx.setTabBarBadge({
      index: MINE_TAB_INDEX,
      text: n > 99 ? '99+' : String(n),
      fail: function () {}
    });
  } else {
    wx.removeTabBarBadge({ index: MINE_TAB_INDEX, fail: function () {} });
  }
}

/**
 * 重新计算并点亮/熄灭「我的」tab 上的红点。
 * @param {boolean} force 忽略私信那 30 秒节流，强制问一次云端（进「我的」页时用）
 * @returns {Promise<{reply:number, chat:number, total:number}>}
 */
function refreshBadge(force) {
  const r = replyMap();
  // 先用本机数据画一版，网络回来后再校正；不把红点显示成“问完云端才出现”。
  paint(r.total + chatUnreadCount + notifyUnreadCount);

  const now = Date.now();
  const needReplySync = force || now - lastReplySyncAt >= CHAT_THROTTLE_MS;
  const needChat = force || now - lastChatAt >= CHAT_THROTTLE_MS;
  const needNotify = force || now - lastNotifyAt >= CHAT_THROTTLE_MS;

  const jobs = [];
  if (needReplySync) {
    lastReplySyncAt = now;
    const oid = store.myOpenid();
    jobs.push(oid
      ? require('./user.js').postsByAuthor(oid, 100)
        .then((res) => {
          if (res && res.ok !== false && Array.isArray(res.list)) {
            store.applyCloudPostSummaries(res.list);
          }
          return true;
        })
        .catch(() => false)
      : Promise.resolve(false));
  } else {
    jobs.push(Promise.resolve(false));
  }

  if (needChat) {
    lastChatAt = now;
    // 延迟 require：避免启动时把云开发初始化提前。
    jobs.push(require('./chat.js').list().then((list) => {
      chatUnreadCount = (list || []).reduce((s, c) => s + (Number(c.unread) || 0), 0);
      return true;
    }).catch(() => false));
  } else {
    jobs.push(Promise.resolve(false));
  }

  if (needNotify) {
    lastNotifyAt = now;
    jobs.push(require('./user.js').notifyList(1).then((res) => {
      if (res && !res.degraded) notifyUnreadCount = Math.max(0, Number(res.unread) || 0);
      return true;
    }).catch(() => false));
  } else {
    jobs.push(Promise.resolve(false));
  }

  return Promise.all(jobs).then(() => {
    const latest = replyMap();
    const total = latest.total + chatUnreadCount + notifyUnreadCount;
    paint(total);
    return { reply: latest.total, chat: chatUnreadCount, notify: notifyUnreadCount, total: total };
  });
}

// 会话页把某个人的消息读掉之后，本地这份私信计数要能立刻减下来，
// 不用等下一次 refreshBadge 问云端
function chatUnread() {
  return chatUnreadCount;
}

/**
 * 会话页刚把列表拉回来（每条的未读数都是新的），把这边的缓存直接换成这份数字。
 * 为什么要这个出口：chats.js 已经拿到准确结果了，再让 refreshBadge 去问一次云端
 * 就是同一份数据问两遍。顺带推进节流时间戳，紧接着的 refreshBadge 会复用这份结果。
 */
function setChatUnread(n) {
  chatUnreadCount = Math.max(0, Number(n) || 0);
  lastChatAt = Date.now();
  paint(replyMap().total + chatUnreadCount + notifyUnreadCount);
}

function setNotifyUnread(n) {
  notifyUnreadCount = Math.max(0, Number(n) || 0);
  lastNotifyAt = Date.now();
  paint(replyMap().total + chatUnreadCount + notifyUnreadCount);
}

module.exports = {
  KEYS: KEYS,
  MINE_TAB_INDEX: MINE_TAB_INDEX,
  markPostSeen: markPostSeen,
  markAllSeenFor: markAllSeenFor,
  markAllSeenForPosts: markAllSeenForPosts,
  forgetPost: forgetPost,
  replyMap: replyMap,
  replyTotal: replyTotal,
  refreshBadge: refreshBadge,
  chatUnread: chatUnread,
  setChatUnread: setChatUnread,
  setNotifyUnread: setNotifyUnread
};
