// utils/store-base.js —— 数据层共享基础设施（KEYS / read / write / 墓碑 / 工具 / 常量）
// 所有 store-*.js 业务模块都 require 本文件，避免重复定义基础设施。
//
// 对外接口（保持兼容）：
//   initStore / getUser / setUser / getCourses / getCourseById / getColleges
//   findCourseByName / addCourse / getReviews / addReview / getMyReviews
//   getBoards / getPosts / getPostById / addPost / addComment / toggleLike / getMyPosts
//
// 本次升级新增：
//   getCourseInsight(courseId) —— 课程「决策卡」数据：均分、评分分布、标签热度、一句话结论；
//   updateReview / removeReview —— 自己发的评价可改可删（本地 + 云端同步）；
//   loadMorePosts() —— 云端分页，触底继续拉，不再一次全量；
//   ensureSeed() —— 云端空库时自动灌入示例内容，解决新用户「进来一片空白」；
//   addPost 支持 images（论坛配图，上传到云存储拿 fileID）。
//
// 隐私：评价默认匿名，展示时统一替换成「匿名同学」；自己那条靠 openid 认领，不做删除后还能被别人改。


// ===================== 对外导出速查（按业务域）=====================
// 全文 2100+ 行，按下面分区定位即可，无需通读；每个分区见文件内
// 「/* ---- 业务域 ---- */」注释。完整导出见文件末尾 module.exports。
//   初始化/同步 : initStore · syncNow · openidTrouble · myOpenid
//   用户       : getUser · setUser
//   课程       : getCourses · getCourseById · getCourseInsight · setCourseType
//                · syncCourseTypes · getColleges · refreshCourses · findCourseByName
//                · addCourse · removeCourse · dropCourseLocal · isMineCourse
//   评价       : getReviews · getReviewById · getAllReviews · getCourseTeachers
//                · getReviewsByTeacher · getTeacherBoard · addReview · updateReview
//                · removeReview · getMyReviews · setReviewStatus · isMineReview
//   论坛/帖子  : getBoards · getPosts · getHolePosts · getHiddenPosts · HOLE_BOARD
//                · getPostById · addPost · addComment · removeComment · deletePost
//                · getMyPosts · isMinePost · setPostStatus · setPostPinned
//                · loadMorePosts · fetchPostsFromCloud · ensureSeed · searchPosts
//   投票/点赞  : castVote · toggleVote · toggleLike · myVote · toggleReact
//   互动/举报  : REACT_KINDS · REACT_META · hasReported · markReported
//                · hasReportedComment · markReportedComment · markCommentRemoved
//   收藏       : getFavorites · isFavorited · toggleFavorite · removeFavorite · pullFavorites
//   草稿       : getDrafts · hasDraftText · saveDraft · getDraft · removeDraft · clearDrafts
//   搜索       : getSearchHistory · pushSearchHistory · clearSearchHistory · getHotKeywords
//   常量       : PAGE · REACT_KINDS · REACT_META
// ================================================================

const seed = require('../data/seed.js');
const cloud = require('./cloud.js');
// 精准 / 模糊的搜索内核（全站共用）
const searchCore = require('./search.js');

const KEYS = {
  courses: 'zjgsu_courses',
  userCourses: 'zjgsu_user_courses', // 同学自建课程（本地镜像，云端正源）
  courseAlias: 'zjgsu_course_alias', // 重复课程 id -> 保留课程 id；历史评价据此归并
  reviews: 'zjgsu_reviews',
  boards: 'zjgsu_boards',
  posts: 'zjgsu_posts',
  user: 'zjgsu_user',
  // 赞 / 踩：一份统一的投票记录 { 帖子id: 'like' | 'dislike' }。
  // 早先只有点赞（zjgsu_liked_set，值是 true），加了点踩之后两份数据各写各的、
  // 「我到底赞过还是踩过」就会打架，所以收敛成一份。
  // 老数据里的 liked_set 只在读取时兜一下，写入一律走 voteSet
  likedSet: 'zjgsu_liked_set',
  voteSet: 'zjgsu_votes',
  // 旧版帖子赞踩基线，仅为兼容旧缓存保留键名；新代码不再读写它。
  // 帖子计数现在只认云端回执（post_votes 记名表数出来的人数）。
  voteBase: 'zjgsu_vote_base',
  // 树洞的三种回应（抱抱 / 递茶 / 摸摸头）：{ 帖子id: { hug:true, tea:false, pat:true } }。
  // 和赞踩的区别是这三者可以叠加 —— 抱完再递茶是人之常情，所以各记各的。
  // 但每一项的计数同样用「基线 + 我这一份」算，点多少次都只等于一份
  reactSet: 'zjgsu_hole_reacts',
  reactBase: 'zjgsu_hole_react_base',
  seedVer: 'zjgsu_seed_version',
  // 删除墓碑：本地已删的内容 id。云端删除失败（没权限/没网）时，
  // 下次同步靠它过滤，否则帖子会「删了重进又回来」
  tomb: 'zjgsu_deleted_ids',
  // 搜索历史：最近搜过的几个词，列表页直接展示，省得用户反复回忆怎么打
  searchHistory: 'zjgsu_search_history',
  // 收藏：本地一份用于秒开，云端一份用于跨设备
  favorites: 'zjgsu_favorites',
  // 草稿：发帖 / 写评价写到一半退出来，下次接着写
  drafts: 'zjgsu_drafts',
  // 我举报过哪些内容：{ 帖子id: true }。
  // 只用来把按钮变成「已举报」——同一个人对同一条内容重复举报，服务端本来就会去重，
  // 但按钮不变的话用户会以为自己没点上，一遍遍地戳
  reportedSet: 'zjgsu_reported',
  // 留言删除墓碑：{ 留言id: true }。
  // 留言是存在帖子里面的，云端那一刀砍的是帖子的 comments 数组；
  // 而手机上的本地缓存只会在同步时整条替换，翻页之外的地方并不会立刻刷新。
  // 少了这块墓碑，一条「多人举报已经自动删掉」的留言会在别人手机上继续挂着，
  // 看起来就像举报功能没生效
  commentTomb: 'zjgsu_removed_comments',
  // 留言的赞 / 踩：{ "帖子id#留言id": 'like' | 'dislike' }。
  // 和帖子那套同构（态度记一份、计数由云端权威值整份覆盖），但不复用
  // voteSet —— 留言的 id 只在一条帖子里唯一，换一条帖子就可能撞车，
  // 所以键里把帖子 id 一起拼上
  commentVoteSet: 'zjgsu_comment_votes',
  // 留言赞踩「不含我」的基线：{ "帖子id#留言id": { likes, dislikes } }。
  // 理由和帖子那边一样：计数靠「点一次 +1」累加，只要有一次状态对不上
  // （云端覆盖、连点、换设备）就永久漂移；基线 + 我这一票是纯函数，点一百次也是一份
  commentVoteBase: 'zjgsu_comment_vote_base',
  // 我举报过的留言及其处理状态：{ "帖子id#留言id": { reason, status, at } }。
  // reportedSet 里那个 true 只够把按钮变灰，而举报是一条有去有回的流程
  // （pending → confirmed 成立 / rejected 证据不足）—— 状态记下来，
  // 举报的人才能看见「已举报·待核实」，而不是对着一个灰按钮猜有没有人管
  commentReportState: 'zjgsu_comment_report_state',
  // 课程类型纠错：{ 课程id: '体育课' | ... }。官网课程目录不带「课程性质」，
  // 类型是按课名猜的，猜错的（比如「实验心理学」被当成通识课）由同学自己纠正。
  // 本机一份立即生效，云端 course_types 集合一份给所有同学共享
  ctypeFix: 'zjgsu_ctype_fixes',
  // 我在投票帖里投过的选项：{ 帖子id: [选项id] }。
  // openid 还没取回来时投的票，等身份到了也得认得出来，不能让人投两次
  pollVotes: 'zjgsu_poll_votes'
};

// seed 数据版本号：改动 seed 后 +1，即可让所有老用户刷新到新示例数据
// v5：论坛板块新增「闲聊」（发帖页的默认板块）
// v6：新增「社团同好」板块 + 三条起步内容（社团 / 摄影同好 / 考研搭子）
// v7：新增一条「只发主题」的信息墙样板帖（浙工商同好群）——
//     加了新帖型却让老用户看不到，这个功能等于没上线
const SEED_VERSION = '2026-09-26-add-topic-post-v7';

// 论坛一页条数：列表页触底加载，避免一次拉全量导致卡顿和流量浪费
const PAGE_SIZE = 20;

// 课程列表一屏渲染条数：课程库有 900+ 门，一次全渲染会把渲染层压垮
const COURSE_PAGE_SIZE = 30;

// 匿名展示统一用的昵称
const ANON_NAME = '匿名同学';

// 树洞板块名：树洞是独立区域，帖子只进树洞页，主论坛的「全部」和板块筛选里都不出现
const HOLE_BOARD = '树洞';

// 示例内容的 id 索引：KEEP_SEED_CONTENTS=false 时用于在展示层过滤掉示例帖/示例评价
const SEED_POST_IDS = {};
const SEED_REVIEW_IDS = {};
seed.posts.forEach((p) => { SEED_POST_IDS[p.id] = true; });
seed.reviews.forEach((r) => { SEED_REVIEW_IDS[r.id] = true; });
function keepContents() {
  return !!cloud.cfg.KEEP_SEED_CONTENTS;
}

/* ---------------- 删除墓碑 ---------------- */

function tombRead() {
  const t = read(KEYS.tomb, {});
  if (!t.posts) t.posts = {};
  if (!t.reviews) t.reviews = {};
  return t;
}
function addTombstone(type, id) {
  if (!id) return;
  const t = tombRead();
  t[type][id] = true;
  // 防止无限膨胀：超过 500 条时丢掉最早记录的一批
  const keys = Object.keys(t[type]);
  if (keys.length > 500) keys.slice(0, 200).forEach((k) => { delete t[type][k]; });
  write(KEYS.tomb, t);
}
function notTombstoned(type) {
  const t = tombRead();
  return (x) => !t[type][x.id];
}

// 留言删除墓碑的读法。读的时候兜一下脏数据：
// read 拿到的是空字符串时会返回兜底值，但万一里面存了别的东西
// （比如哪次写成了数组），过滤就得按对象来，别把「已删」误判成「没删」
function commentTomb() {
  const t = read(KEYS.commentTomb, {});
  return (t && typeof t === 'object' && !Array.isArray(t)) ? t : {};
}

function read(key, fallback) {
  const v = wx.getStorageSync(key);
  return (v === '' || v === undefined || v === null) ? fallback : v;
}
function write(key, val) {
  wx.setStorageSync(key, val);
}
function myOpenid() {
  return cloud.cfg.USE_CLOUD ? (cloud.getOpenid() || '') : '';
}
function today() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 展示用的时间串，格式和云函数 now() 一致（YYYY-MM-DD HH:mm）。
//
// 为什么本地也要带时分：云端同步下来的帖子写的是「2026-10-17 08:30」，
// 本地新发的如果只有「2026-10-17」，同一个列表里两行时间长得不一样，
// 用户会以为后者是「昨天以前的老帖」。
//
// ⚠️ 这一串只负责**显示**。排序一律用 at（毫秒），别拿它比大小 ——
//    长度不同的字符串比出来的是字典序，不是时间序（详见 store-forum.js 的 atOf）
function nowText() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function genId() {
  return 'u' + Date.now() + Math.floor(Math.random() * 1000);
}

// 身份常常比页面晚一步到：login 云函数要跑一个网络来回，
// 用户可能刚进来就发帖。没身份就往云里发，一定被「无法识别用户身份」驳回，
// 用户白写一场。所以这里先等等它。
//
// ⚠️ 这里以前注释写着「最多 2.5 秒」，但代码里**一个超时都没有** —— 注释是假的。
//    实际路径是 cloud.fetchOpenid()：内部连续重试 3 次 × 每次 5 秒 = 最多 15 秒。
//    而 waitOpenid 卡在「发布 / 投递」这条链的正中间（store-forum.addPost 里 await 它），
//    login 云函数没部署时，用户点完发布要对着蒙层干等 15 秒 ——
//    这就是「点了发送毫无反应」里最难查的那一半。
//    现在加一个真实的总闸：6 秒拿不到就放弃等待。
//    拿不到也照发：addPost 后面依旧会把帖子发出去 —— 云端身份来自微信平台注入的
//    context，跟客户端有没有拿到 openid 没关系。多等的那 9 秒原本也是白等。
const WAIT_OPENID_MS = 6 * 1000;

async function waitOpenid() {
  if (myOpenid()) return true;
  try {
    // 到点就走，不等到底：cloud.fetchOpenid 自己那套重试留着给「不着急」的场景用
    await Promise.race([
      cloud.fetchOpenid().catch(() => null),
      new Promise((resolve) => setTimeout(resolve, WAIT_OPENID_MS))
    ]);
  } catch (e) {}
  return !!myOpenid();
}

// 身份迟迟拿不到时给页面一份诊断：重试了几次。
// 试了三四回还是空，多半是 login 云函数没部署，这时候让用户「退出重进」没用，
// 该提示的是去控制台部署云函数
function openidTrouble() {
  const t = cloud.openidTrouble ? cloud.openidTrouble() : null;
  return {
    ok: !!(t && t.ok),
    tried: (t && t.tried) || 0,
    msg: (t && !t.ok && t.tried >= 3)
      ? '身份一直没拿到，多半是 login 云函数还没部署。去微信开发者工具右键 cloudfunctions/login 上传部署一次。'
      : ''
  };
}
// 通用常量（原文件末尾定义，集中在此导出，供各模块复用）
const PAGE = { SIZE: PAGE_SIZE, ANON: ANON_NAME };

module.exports = {
  KEYS, read, write, myOpenid, today, nowText, genId, waitOpenid, openidTrouble,
  keepContents, addTombstone, notTombstoned, commentTomb, tombRead,
  SEED_POST_IDS, SEED_REVIEW_IDS, cloud, seed, searchCore,
  PAGE_SIZE, COURSE_PAGE_SIZE, ANON_NAME, HOLE_BOARD, SEED_VERSION, PAGE
};
