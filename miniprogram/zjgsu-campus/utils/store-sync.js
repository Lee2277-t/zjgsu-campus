// utils/store-sync.js —— 云端同步 + 启动初始化
// 基础设施（KEYS / read / write / 墓碑 / 工具函数）统一来自 store-base.js；
// 跨模块调用通过 require 同级 store-* 模块获取，不跨文件改写逻辑。

const { KEYS, read, write, cloud, seed, myOpenid, keepContents, notTombstoned, addTombstone, SEED_VERSION, PAGE_SIZE, SEED_POST_IDS, SEED_REVIEW_IDS } = require('./store-base.js');
const { refreshCourses } = require('./store-course.js');
const { pullFavorites, getFavorites, FAV_MAX } = require('./store-favorite.js');

/* ---------------- 云端同步 ---------------- */

// 云端分页游标：已经从云端「按顺序」取回了多少条，下次接着往下翻
let cloudPulled = 0;

// 从云端分页拉帖子：pages 表示拉几页，返回本次拿到的条数
// 两处性能处理：
//   ① 多页「同时发请求」而不是一页等一页——原来串行两页 = 两轮网络往返，现在一轮；
//   ② 必须把几页「合并后」再写回缓存——之前每页直接覆盖，两页时本地只剩第二页，
//      用户最新发的帖子（第一页）会被冲掉，看起来就是「我的帖子丢了」
// fromTop=true 表示重新从最新一页开始拉（下拉刷新用）
async function fetchPostsFromCloud(pages, fromTop) {
  if (!cloud.ensureCloud()) return 0;
  const n = Math.max(1, pages || 1);
  if (fromTop) cloudPulled = 0;

  const tasks = [];
  for (let i = 0; i < n; i += 1) {
    tasks.push(cloud.db().collection('posts')
      .orderBy('time', 'desc').skip(cloudPulled + i * PAGE_SIZE).limit(PAGE_SIZE).get()
      .catch(() => null));
  }
  const results = await Promise.all(tasks);

  const fetched = [];
  results.forEach((r) => {
    if (r && r.data && r.data.length) fetched.push(...r.data);
  });
  if (!fetched.length) return 0;

  const inCloud = {};
  fetched.forEach((p) => { inCloud[p.id] = true; });
  // 已删的帖子绝不复活：云端删除偶尔会失败（权限/网络），同步时靠墓碑挡住
  const alive = notTombstoned('posts');
  // 示例内容开关关闭时，云端拉回来的示例帖也不进缓存
  const fromCloud = (keepContents() ? fetched : fetched.filter((p) => !SEED_POST_IDS[p.id])).filter(alive);
  if (!fromCloud.length) {
    cloudPulled += fetched.length;
    return 0;
  }
  const localOnly = read(KEYS.posts, []).filter((p) => !inCloud[p.id] && alive(p) && (keepContents() || !SEED_POST_IDS[p.id]));
  write(KEYS.posts, fromCloud.concat(localOnly));
  // 云端刚给了一批权威计数，顺手刷新基线：
  // 我互动过的帖子如果还抱着旧基线，别人新点的赞就会被算丢 ——
  // 表现为「明明有 5 个赞，我这里只显示 1 个（我自己的那一票）」
  cloudPulled += fetched.length;
  return fromCloud.length;
}

// 手动再来一遍云端同步。详情页找不到课程时用它自救：
// 数据没同步全（换设备、刚清过缓存）时，重拉一次多半就回来了。
function syncNow() {
  if (!cloud.ensureCloud()) return Promise.resolve(false);
  return syncFromCloud().catch(() => false);
}

// 客户端单次查询最多 20 条（平台限制）。以前这里直接写 limit(500)：
// 要么被截到 20 条，要么报参数错误，而外层的 .catch(() => null) 把两种情况
// 都变成了「云端没有数据」—— 换设备后评价只剩二十来条，还没人知道为什么。
const CLIENT_PAGE = 20;

// 按页拉全某个集合（可带条件），最多 max 条。
// 中途某一页失败就停，已拉到的照用；第一页就失败则返回 null（表示「没拉到」，
// 调用方据此别用空数组覆盖本地缓存 —— 那等于把用户的数据清空了）。
async function fetchAll(collection, where, max) {
  const cap = Number(max) || 300;
  const dbi = cloud.db();
  const out = [];
  for (let skip = 0; skip < cap; skip += CLIENT_PAGE) {
    let q = dbi.collection(collection);
    if (where) q = q.where(where);
    // 逐页串行：skip 依赖上一页的结果，并行没有意义
    // eslint-disable-next-line no-await-in-loop
    const res = await q.skip(skip).limit(CLIENT_PAGE).get().catch(() => null);
    // 任何一页失败都要当作整次失败，不能用“前半页”覆盖本地完整缓存。
    if (!res || !res.data) return null;
    out.push.apply(out, res.data);
    if (res.data.length < CLIENT_PAGE) break;
  }
  return out;
}

// 评价导入后总量会超过 300；客户端单次仍只能取 20 条，
// 但可以并发翻页，避免串行等几十轮网络往返。
// 只给 reviews 用；帖子/收藏等仍走 fetchAll，错误语义保持不变。
async function fetchAllParallel(collection, where, max, concurrency) {
  const cap = Number(max) || 2000;
  const n = Math.max(1, Math.min(8, Number(concurrency) || 5));
  const dbi = cloud.db();
  const out = [];
  let nextSkip = 0;
  let ended = false;
  while (!ended && out.length < cap) {
    const tasks = [];
    for (let i = 0; i < n; i += 1) {
      let q = dbi.collection(collection);
      if (where) q = q.where(where);
      // 固定按 _id 排序，翻页时不会因为库内默认顺序变化而漏条 / 重复
      q = q.orderBy('_id', 'asc');
      tasks.push(q.skip(nextSkip + i * CLIENT_PAGE).limit(CLIENT_PAGE).get().catch(() => null));
    }
    const results = await Promise.all(tasks);
    // 任何一页失败都当作整次失败：不能用半套评价覆盖本地完整缓存
    if (results.some((r) => !r || !r.data)) return null;
    let shortPage = false;
    results.forEach((r) => {
      out.push.apply(out, r.data);
      if (r.data.length < CLIENT_PAGE) shortPage = true;
    });
    nextSkip += n * CLIENT_PAGE;
    if (shortPage) ended = true;
  }
  return out.slice(0, cap);
}

// 最近一次云端同步的结果：null = 还没跑过，true = 读到了，false = 没读到。
// 主列表拿它来区分「真的没有内容」和「只是这次没拉到」——
// 这两件事在界面上必须说成两句不同的话，否则用户会以为自己看到的是事实。
let lastSync = null;
let lastSyncAt = 0;

function syncState() {
  return { ok: lastSync, at: lastSyncAt };
}

// 置顶帖不能依赖普通信息流的“最新一页”：一条半年前的置顶帖可能永远不在前 20 条里，
// 新设备就会显示“有人能看到、有人看不到”。所以每次启动/下拉刷新都单独拉全部置顶帖。
async function fetchPinnedPostsFromCloud() {
  if (!cloud.ensureCloud()) return false;
  const pinned = await fetchAll('posts', { pinned: true }, 40);
  if (pinned === null) return false;
  const alive = notTombstoned('posts');
  const rows = (keepContents() ? pinned : pinned.filter((p) => !SEED_POST_IDS[p.id])).filter(alive);
  const byId = {};
  rows.forEach((p) => { if (p && p.id) byId[p.id] = true; });
  const local = read(KEYS.posts, []).filter((p) => p && p.id && !byId[p.id] && alive(p) && (keepContents() || !SEED_POST_IDS[p.id]));
  // 置顶帖放前面只是缓存顺序；真正的展示顺序仍由 getPosts({sort:'pinned'}) 决定
  write(KEYS.posts, rows.concat(local));
  return true;
}

// 启动后从云端拉取评价与帖子，并把“我点赞过的帖子”标记下来
async function syncFromCloud() {
  if (!cloud.ensureCloud()) {
    // 没开云 / 云环境没初始化：本地模式本来就是唯一数据源，不算「没读到」
    lastSync = true;
    lastSyncAt = Date.now();
    return;
  }
  try {
    const oid = myOpenid();

    // 四组查询并行发出：每组内部按页串行，组与组之间互不依赖
    const [revs, crs, likes, dislikes] = await Promise.all([
      fetchAllParallel('reviews', null, 2000, 5),
      // 同学自建课程单独容错：集合还没建时不影响评价/帖子同步
      fetchAll('courses', null, 300),
      // 「我赞过」的去向：以前读 likes 集合，可投票早就收口到服务端了，
      // 那个集合现在没人往里写 —— 换手机、清缓存后绿心永远回不来。
      // 改成问帖子自己：数组字段包含匹配，正好只取得到跟我有关的那些
      oid ? fetchAll('posts', { likedBy: oid }, 200) : Promise.resolve(null),
      oid ? fetchAll('posts', { dislikedBy: oid }, 200) : Promise.resolve(null)
    ]);

    // revs / crs 为 null = 第一页就没拉到（fetchAll 的约定：失败返回 null，
    // 而不是空数组，免得用空数据覆盖本地缓存）。这就判本次同步失败。
    lastSync = !!revs && !!crs;
    lastSyncAt = Date.now();

    if (revs) {
      // 示例评价开关关闭时，云端拉回来的示例评价不进缓存；已删的评价靠墓碑挡住
      const alive = notTombstoned('reviews');
      write(KEYS.reviews, (keepContents() ? revs : revs.filter((r) => !SEED_REVIEW_IDS[r.id])).filter(alive));
    }
    if (crs) write(KEYS.userCourses, crs);
    // 写进统一的投票记录：老版本的 liked_set 只记 true，用来认「点过赞」。
    // 摊平在新列里，升级后既不会丢点赞状态，也不会和点踩打架
    if (likes || dislikes) {
      const set = read(KEYS.voteSet, {});
      (likes || []).forEach((p) => { set[p.id] = 'like'; });
      (dislikes || []).forEach((p) => { set[p.id] = 'dislike'; });
      write(KEYS.voteSet, set);
    }

    refreshCourses();
    // 首屏只拉一页就先渲染：原来一上来拉两页，等于多等一轮网络往返才出内容
    await Promise.all([fetchPostsFromCloud(1), fetchPinnedPostsFromCloud()]);
    // 草稿也顺手拉一次（不 await）：它不影响首屏，但换设备后
    // 一进「我的 → 草稿箱」就该看到自己写到一半的东西，而不是空的。
    // 在函数里 require 而不是文件顶部：store-draft 与这里没有依赖，
    // 但放在顶部会让模块加载顺序变得更难追（这条链上已经有 4 个 store-* 了）
    try {
      require('./store-draft.js').pullDrafts().catch(() => {});
    } catch (e) { /* 草稿同步失败不影响其它数据 */ }
  } catch (e) {
    // 云端读取失败不阻塞本地使用，但要把「这次没读到」记下来给界面用
    lastSync = false;
    lastSyncAt = Date.now();
  }
  // 冷启动兜底：云端一条内容都没有时，把示例内容补进去
  ensureSeed();
}

// 触底加载：再拉一页帖子（fromTop 传给下拉刷新用）
function loadMorePosts(fromTop) {
  const posts = fetchPostsFromCloud(1, !!fromTop);
  const pinned = fromTop ? fetchPinnedPostsFromCloud() : Promise.resolve(true);
  return Promise.all([posts, pinned]).then((r) => r[0] > 0);
}

// 冷启动种子：云端 posts 为空时，让云函数把示例内容写进去（只做一次）
// KEEP_SEED_CONTENTS=false 时整段跳过——不再往云端灌示例
function ensureSeed() {
  if (!keepContents()) return Promise.resolve(false);
  if (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud()) return Promise.resolve(false);
  const localPosts = read(KEYS.posts, []);
  if (localPosts.length > 0) return Promise.resolve(false);
  try {
    return wx.cloud.callFunction({
      name: 'user',
      data: {
        action: 'ensureSeed',
        reviews: seed.reviews,
        posts: seed.posts
      }
    }).then((res) => !!(res && res.result && res.result.ok)).catch(() => false);
  } catch (e) {
    return Promise.resolve(false);
  }
}

// ensureCourseId / refreshCourses 已归入 store-course.js（见顶部 require）：
// 课程目录的维护逻辑集中在课程模块，同步模块只消费、不重复定义。

function initStore() {
  // seed 升级时刷新板块/示例帖：只补进官方示例，同学自己发的帖不会被覆盖
  if (wx.getStorageSync(KEYS.seedVer) !== SEED_VERSION) {
    write(KEYS.boards, seed.boards);
    const oldPosts = read(KEYS.posts, []);
    const oldReviews = read(KEYS.reviews, []);
    if (keepContents()) {
      const seedIds = {};
      seed.posts.forEach((p) => { seedIds[p.id] = true; });
      const minePosts = oldPosts.filter((p) => !seedIds[p.id]);
      write(KEYS.posts, seed.posts.concat(minePosts));
      // 评价也补：老用户能把新示例评价刷下来
      const revIds = {};
      oldReviews.forEach((r) => { revIds[r.id] = true; });
      const mineReviews = oldReviews.filter((r) => !revIds[r.id]);
      write(KEYS.reviews, seed.reviews.concat(mineReviews));
    } else {
      // 示例内容关闭：把示例帖/评价从本地清掉（同学自己发的都保留）
      write(KEYS.posts, oldPosts.filter((p) => !SEED_POST_IDS[p.id]));
      write(KEYS.reviews, oldReviews.filter((r) => !SEED_REVIEW_IDS[r.id]));
    }
    write(KEYS.seedVer, SEED_VERSION);
  }
  refreshCourses();
  if (!wx.getStorageSync(KEYS.reviews)) write(KEYS.reviews, []);
  if (!wx.getStorageSync(KEYS.posts)) write(KEYS.posts, []);
  if (cloud.cfg.USE_CLOUD) {
    syncFromCloud();
    // 换设备后把云端那侧收藏补回本地；本机刚收藏的排前面，云端旧的往后靠
    pullFavorites().then((list) => { if (list) mergeFavorites(list); });
  }
}

// 云端收藏合并回本地：本机已有的不动（刚点的更实时），只补本机没有的部分
function mergeFavorites(remote) {
  if (!Array.isArray(remote) || !remote.length) return;
  const local = getFavorites();
  const has = {};
  local.forEach((f) => { has[f.type + '|' + f.id] = true; });
  const add = remote
    .filter((f) => f && f.id && !has[f.type + '|' + f.id])
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  if (!add.length) return;
  write(KEYS.favorites, local.concat(add).slice(0, FAV_MAX));
}

module.exports = {
  fetchPostsFromCloud,
  syncNow,
  syncFromCloud,
  fetchPinnedPostsFromCloud,
  syncState,
  loadMorePosts,
  ensureSeed,
  initStore,
  mergeFavorites
};
