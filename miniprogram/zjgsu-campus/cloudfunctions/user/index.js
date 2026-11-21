// 云函数 user —— 用户身份 / 个人资料 / 同学联系方式交换
//
// 设计要点：
//  1) 用户不需要「登录」。微信云开发在云函数里能直接拿到 openid，
//     openid 就是全校唯一的身份证，换手机、卸载重装都不变。
//  2) 联系方式（微信号 / 手机号）属于个人信息，权限过滤必须放在服务端。
//     前端拿得到就等于公开，所以这里统一由云函数返回，前端不做隐藏。
//  3) 只有双向都 accepted 的关系，双方才看得到对方的联系方式。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
// 全站同一套精准 / 模糊搜索内核（云函数也要带一份，不能指望打包时自动跟过去）
const searchCore = require('./search.js');
// 举报计票与队列分组的纯函数（一个人一票 / 一条内容一行）。
// 抽出去是为了能被 scripts/test-report-votes.cjs 直接灌数据验行为 ——
// 这两条口径错了都不报错，只会把正常内容删掉、或者在队列里重复出现
const { countVoices, groupReports, isPersonType } = require('./report-votes.js');
// 下架门槛的分档表（按独立浏览人数定需要几个人举报）。
// 抽成纯函数同样是为了能直接灌数据验边界：49 人看要 3 票、50 人看要 5 票，
// 这种边界写错一个数字，全网的下架速度就变了，而且**不会报错**
const { hideNeed, describeTier, shouldAutoDismiss } = require('./report-rules.js');

const COL_USERS = 'users';      // 个人资料
const COL_CONTACTS = 'contacts'; // 交友 / 联系请求（申请记录，处理完就删）
const COL_FRIENDS = 'friends';   // 同学关系表：一条记录一个方向，_id = openid_friendOpenid
const COL_BLOCKS = 'blocks';    // 拉黑：我拉黑的人，反过来也不能给我发请求
const COL_REPORTS = 'reports';  // 举报：别人内容违规时留下的记录
const COL_POSTS = 'posts';      // 论坛帖子
const COL_REVIEWS = 'reviews';  // 课程评价
const COL_COURSES = 'courses';  // 同学共建课程（官方课程在前端 seed 里，不占云库）
const COL_ADMINS = 'admins';    // 审核员名册：谁点过「把我设为审核员」，谁就在里面
const COL_FAVS = 'favorites';   // 收藏：整个数组存一条文档（_id = openid），量小、无联表
const COL_MARKET = 'market';    // 失物招领 / 二手交易
const COL_CHATS = 'chats';      // 私信会话：一条会话一条文档
const COL_RESOURCES = 'resources'; // 学习资料（笔记 / 真题 / 讲义）元数据，文件本体在云存储
// 历年真题不在这里建表：它是批量导入 + 只读的数据，和课程库那 903 门课一样走随包数据
// （data/exam-papers.js，只进 tool 分包），检索全在端上做，不需要集合也不需要云函数。
// 见 docs/exam-papers.md
const COL_CALENDAR = 'calendar';   // 校历节点：开学 / 考试周 / 四六级 / 考研
const COL_PLACES = 'places';       // 校园地点：教学楼 / 食堂 / 快递点，带经纬度
const COL_MEMOS = 'memos';         // 备忘录：个人日常记录，读写都带 openid，任何人看不到别人的
const COL_EVENTS = 'events';           // 校园活动：讲座 / 比赛 / 组队 / 社团活动
const COL_EVENT_JOINS = 'event_joins'; // 活动报名：一条报名一条记录（见 eventJoin 处的注释）
const COL_TEACHERS = 'teachers';       // 教师名录：官方导入 + 同学补充，用于评价时的自动补全
// 云数据库单次 get 的上限就是 1000，超了要按这个页数翻
const TEACHER_PAGE = 1000;
// 评价翻页：按老师批量下架时要遍历一整位老师名下的评价
const REVIEW_PAGE = 100;
const COL_COURSE_REQS = 'course_reqs'; // 删除课程的申请：加课人毕业/失联时，得有别人能收尾的办法
const COL_BOTTLES = 'bottles';         // 校园盲盒 / 漂流瓶：同学匿名扔进去的吐槽、分享、提问
// 赞踩记名表：一条（帖子 + 用户）只可能有一条文档，_id = `帖子id_用户openid`。
// 计数不再靠 likes 字段一路 inc（并发下会重复加），而是从这张表统计得出 ——
// 表是唯一约束，计数就是它的影子，怎么点都对得上
const COL_VOTES = 'post_votes';
// 树洞三连（抱抱 / 递茶 / 摸摸头）：和赞踩同一套思路，
// 一人一帖一行，行里三个开关。写十次也只有一行，连点不会把数字顶上去
const COL_REACTS = 'post_reactions';
const COL_BOTTLE_LOGS = 'bottle_logs'; // 捞瓶记录：每人每天限捞 3 次，计数以天为窗口存这里
const COL_COURSE_TYPES = 'course_types'; // 课程类型纠错：官网目录不带「课程性质」，猜错的由同学改，全校共享
const COL_CONFIG = 'app_config';   // 运行配置：订阅消息模板 ID、屏蔽词表等小程序里就能改的设置
// ⚠️ 集合名不能以下划线开头（tcb/CreateTable 会报 InvalidParameter），所以叫 app_config 不叫 _config
const COL_NOTIFIES = 'notifications'; // 站内通知：谁回复了我的帖子 / 谁申请加我 / 谁解除了关系
const COL_MODLOGS = 'mod_logs';       // 审核操作日志：封号 / 删内容 / 置顶都留一条痕
const COL_ERRORS = 'errors';          // 轻量错误上报：真机上没人看 console，写进库里才查得到
const COL_MEDIA = 'media_audit';      // 图片异步安全审核：提交时的 traceId 与回执结果
const COL_ACCOUNT_REQS = 'account_reqs'; // 账号注销申请：冷静期里的待办，_id = openid
// 草稿：写到一半的帖子 / 评价 / 闲置 / 树洞。以前只存本机，换设备就没了。
// 一人一条一条文档（不是一人一整份数组）：两台设备同时保存时，
// 整份写回必然丢一条，单条 upsert 只会「后写者胜」地覆盖同一条。
const COL_DRAFTS = 'post_drafts';
// 内容保护：被保护的帖子 / 留言不会被「多人举报」自动下架或自动删除。
//
// 为什么独立成表，而不是往 posts 文档里写一个 protectBy：
// posts 是「所有用户可读」的（前端直连同步），把审核员的 openid 写进去，
// 等于把管理员名单连同「哪条是护着的」一起发给全校 —— 那反而成了靶子。
// 这里只记保护关系，读的时候由云函数查一次，外人看不到。
// _id = `${targetType}_${targetId}`，天然幂等，也不用建复合索引
const COL_PROTECTS = 'content_protects';

// 留言赞踩记名表：一条（留言 + 用户）一行，_id = `留言id_用户openid`。
// 和帖子赞踩同一套记账思路，但**不能塞进 post 文档**：留言数组本来就要整份
// 下发到客户端，把「谁赞了哪条」也塞进去等于把全校的投票名单发给每个人，
// 而且数组越滚越大 —— 帖子文档有 1MB 上限，先撞线的就是它
const COL_COMMENT_VOTES = 'comment_votes';

// 留言本体：一条留言一个文档，_id = 留言 id。
//
// 以前留言长在帖子的 comments 数组里，每次写都是「读整份数组 → 改 → 整份写回」。
// 两个人同时留言时，后写的那份会把先写的那条整条抹掉；点赞回写计数时更糟，
// 它会把别人刚发的留言一起盖回旧值。拆成独立文档之后：
//   · 新增 = add 自己这一条，不碰别人
//   · 点赞 = 只 update 自己这条的计数字段
//   · 删除 = 软删（置 removed），不物理删 —— 申诉时要能核对原文
// 帖子文档上只留一个 commentCount，列表页够用，也不用再整份下发留言
const COL_POST_COMMENTS = 'post_comments';

// 留言申诉：_id = 留言 id（一条留言只能申诉一次）。
// 留言被自动删掉时作者是**静默**的 —— 他看不到「自己那条没了」，
// 更没有地方说「你们判错了」。没有出口的自动处置等于把人拉黑还不告诉他
const COL_COMMENT_APPEALS = 'comment_appeals';

// 浏览记录：一条内容一个浏览者一条文档，_id = 类型_内容id_openid。
//
// 为什么单开集合、不往帖子文档里塞一个 viewers 数组：
//   posts 是整份下发到客户端的（store 同步），把「谁看过」也塞进去，
//   等于把全校的阅读名单发给每个人，而且文档会随着浏览量一直长大。
//
// 为什么必须去重：
//   分母要用「几个人看过」，不是「被打开几次」。同一个人刷新十次就涨十个浏览量，
//   门槛会跟着涨 —— 那正好给了「自己刷浏览量来躲下架」的口子。
//
// 为什么作者本人的浏览不算（在 countViews 里排除）：
//   作者会反复打开自己的帖子（看回复、看点赞），把自己算进观众里，
//   等于自己稀释自己该承担的举报比例。
const COL_VIEWS = 'content_views';

// 订阅消息（一次性）：模板 ID 优先读 app_config 集合（审核员在「审核」页里直接填），
// 没配再退回环境变量 SUBMSG_COMMENT / SUBMSG_REPLY / SUBMSG_CHAT。两处都没有就静默跳过，不影响主流程。
//   mp 后台 → 功能 → 订阅消息 → 公共模板库，选三个模板各一个，
//   模板 ID 形如 "AbCdEfGhIjKlMnOpQrStUvWxYz1234567890-abcdefg"
//
// 三个模板对应三种**不同**的通知，别合并成一个「回复提醒」：
//   comment —— 我的帖子被留言（第二个字段是「文章标题」）
//   reply   —— 我的留言被回复（第二个字段是「原评论」）
// 这两件事的接收人和第二行内容都不一样，混用会把帖子标题塞进「原评论」那一行
const ENV_SUBMSG = {
  comment: String(process.env.SUBMSG_COMMENT || '').trim(),
  reply: String(process.env.SUBMSG_REPLY || '').trim(),
  chat: String(process.env.SUBMSG_CHAT || '').trim()
};

// app_config 里的模板 ID 有 5 分钟缓存：不用每次发通知都查一遍库，
// 审核员改完配置最迟 5 分钟生效（重新部署云函数可立即生效）
let _cfgCache = { at: 0, value: null };
const CFG_CACHE_MS = 5 * 60 * 1000;

//
// ── action 路由索引（前端 cloud.callFunction('user',{action}) 对应）──────
// 完整分类见 ../../../docs/miniprogram-docs/ARCHITECTURE.md §2.4。定位后端逻辑先按 action 名搜本文件。
//   资料/关系 : upsertProfile getProfile search addRequest respond friendAccept
//              friendReject removeFriend friendCancel friendAlias
//              listRequests listOutgoing listFriends (limit/offset 分页)
//              block unblock listBlocks whoami setAdmin
//   账号与数据: accountState accountCancel accountCancelUndo（7 天冷静期，到期匿名化）
//   审核      : report(delete|hide|throttle；targetType 支持 post|review|chat|profile，
//              chat|profile 走 reportPerson 那条「只升级不自动处置」的链路)
//              getQueue resolveReports(confirm|reject) setStatus delContent patchContent
//              banUser unbanUser banList（账号封禁：卖片这类把账号当广告位的，直接封）
//              modLogs（审核操作日志，只读）
//   通知      : notifyList notifyRead notifyReadAll（站内通知中心；推送失败一律不影响主流程）
//   收藏      : saveFavorites getFavorites
//   内容写入  : postAdd postEdit(改完云端重新过审) voteCast reviewAdd courseAdd courseRemove
//              likeToggle holeReact weather postPin cfgGet cfgSave calendarReset
//              postsByAuthor(名片页看某人的历史发帖，匿名帖一律不出)
//   市场      : marketAdd marketList marketDone marketRemove
//   私信      : chatSend(文字 / 图片) chatList(分页 + 请求箱分组) chatHistory(支持 after 增量)
//              chatAccept chatDismiss（消息请求箱）chatRecall chatRemove
//   评论      : postComment(文字 / 图片) commentRemove commentReport
//   学习资料  : resourceAdd resourceList resourceUrl resourceThanks resourceRemove
//   校历      : calendarList calendarSave calendarRemove
//   校园地点  : placeList placeAdd placeRemove
//   活动      : eventAdd eventList eventJoin eventCancel eventRemove eventSyncFromWeb
//              （同步时一并把就业网的双选会 / 招聘会拉进来，见 JOBFAIR_* 一节）
//   其他      : teacherSyncFromWeb diag(环境自检) reportError(客户端错误上报)
//   定时      : dailyWebSync(官网页同步) + accountPurge(注销到期执行) + mediaAuditSweep(审核兜底)

async function getSubMsgIds() {
  if (_cfgCache.value && Date.now() - _cfgCache.at < CFG_CACHE_MS) return _cfgCache.value;
  const res = await db.collection(COL_CONFIG).doc('submsg').get().catch(() => null);
  const d = res && res.data && !Array.isArray(res.data) ? res.data : {};
  const value = {
    comment: String(d.comment || '').trim() || ENV_SUBMSG.comment,
    reply: String(d.reply || '').trim() || ENV_SUBMSG.reply,
    chat: String(d.chat || '').trim() || ENV_SUBMSG.chat
  };
  _cfgCache = { at: Date.now(), value: value };
  return value;
}

// 下发订阅消息：模板没配 / 用户没授权 / 接口报错，一律不抛，只记日志。
// 通知是锦上添花，绝不能因为它把主流程（评论、私信）弄失败。
async function sendSubMsg(to, kind, payload) {
  if (!to) return false;
  const ids = await getSubMsgIds();
  const tpl = ids[kind];
  if (!tpl) return false;
  if (!cloud.openapi || !cloud.openapi.subscribeMessage) return false;
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: to,
      templateId: tpl,
      page: payload.page || 'pages/forum/list/list',
      data: payload.fields || {},
      miniprogramState: 'formal'
    });
    return true;
  } catch (e) {
    console.error('[submsg] send failed:', String((e && e.errMsg) || e).slice(0, 200));
    return false;
  }
}

/* ==========================================================================
   运行期基础设施：错误上报 / 站内通知 / 审核留痕 / 图片审核 / 可配词表

   四条共同的铁律（照着写，别在各自的调用点重新发明）：
     1) **一律不抛**。上报、通知、留痕全是「锦上添花」，任何一条把主流程弄失败，
        用户看到的就是「发帖失败」，而真实原因只是一条日志没写进去。
     2) **一律 .catch 吞掉并落盘**。吞掉不等于不管 —— 写进 errors 集合才查得到，
        真机上没人会去看 console。
     3) **不改写业务回执**。通知失败不影响「消息已发送」这个事实。
     4) **新集合没建也不能崩**。所有写入都 catch；前台功能不因缺集合而不可用。
   ========================================================================== */

// 轻量错误上报：不接第三方 SDK，往库里写一条就够查了。
// 为什么必须有：真机上 console.error 谁也不会去看，用户报「点了没反应」时
// 唯一能对上的线索就是这段时间服务端到底抛了什么。
async function reportError(scope, e, extra) {
  try {
    await db.collection(COL_ERRORS).add({
      data: {
        scope: String(scope || '').slice(0, 40),
        msg: String((e && (e.errMsg || e.message)) || e || '').slice(0, 300),
        code: (e && e.errCode) || 0,
        extra: extra ? JSON.parse(JSON.stringify(extra)) : {},
        time: now(),
        at: Date.now()
      }
    });
  } catch (_) { /* 上报失败只能咽下去，否则就成了递归 */ }
}

// 站内通知：订阅消息是一次性的（用户授权一次只能推一条），断了就只能靠红点。
// 通知中心承接的正是「订阅消息发不出去」的那部分。
async function pushNotify(to, payload) {
  const target = String(to || '');
  if (!target) return false;
  const p = payload || {};
  try {
    const eventKey = String(p.eventKey || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
    const docId = eventKey ? ('n_' + eventKey).slice(0, 64) : '';
    await db.collection(COL_NOTIFIES).add({
      data: Object.assign({}, docId ? { _id: docId } : {}, {
        openid: target,
        type: String(p.type || '').slice(0, 24),   // reply / friendReq / friendAccept / unfriend / report
        title: String(p.title || '').slice(0, 40),
        body: String(p.body || '').slice(0, 120),
        page: String(p.page || '').slice(0, 200),
        targetId: String(p.targetId || '').slice(0, 64),
        // 通知里不存发起人的昵称快照：昵称改了要跟着变，存快照就会出现
        // 「通知里叫他小张，点进去名片上写着张三」这种对不上的怪象
        read: false,
        at: Date.now(),
        time: now()
      })
    });
    return true;
  } catch (e) {
    // 集合没建时这里会失败：通知是附加能力，绝不能因此让评论 / 私信发不出去
    console.error('[notify] push failed:', String((e && e.errMsg) || e));
    return false;
  }
}

// 保护关系的主键。帖子和留言共用一个函数，避免两处拼出不一样的 key
function protectKey(targetType, targetId) {
  return (targetType === 'comment' ? 'comment' : 'post') + '_' + String(targetId || '');
}

// 查一次保护关系。没有记录 / 查不到（集合还没建）一律当「没保护」——
// 保护功能缺失只是回到原来的行为，绝不能让举报链路因为查不到而整个失败
async function isProtected(targetType, targetId) {
  if (!targetId) return null;
  const got = await db.collection(COL_PROTECTS).doc(protectKey(targetType, targetId))
    .get().catch(() => null);
  const d = got && got.data && !Array.isArray(got.data) ? got.data : null;
  return d || null;
}

// 审核操作留痕：封号 / 删内容 / 置顶都记一条。
// 只有一个 bannedBy 字段是不够的 —— 多审核员协作时，「这条帖是谁下的、
// 为什么下、什么时候下的」三个问题里有两个答不上来。
async function logMod(openid, act, targetType, targetId, detail) {
  try {
    await db.collection(COL_MODLOGS).add({
      data: {
        by: String(openid || ''),
        act: String(act || '').slice(0, 32),
        targetType: String(targetType || '').slice(0, 16),
        targetId: String(targetId || '').slice(0, 64),
        detail: String(detail || '').slice(0, 200),
        time: now(),
        at: Date.now()
      }
    });
  } catch (e) {
    console.error('[modlog] write failed:', String((e && e.errMsg) || e));
  }
}

// 屏蔽词表支持运行期增补：代码里那份是兜底，审核员在「审核」页填的那份优先叠加。
// 为什么不做成「完全可配」：词表一旦全空就是裸奔，代码里那份必须永远在。
const BLOCK_WORDS_BASE = [
  '傻逼', '煞笔', '沙比', '智障', '脑残', '废物', '滚蛋', '去死',
  '约炮', '一夜情', '裸聊', '成人', '赌场', '博彩', '私彩',
  '加微信', '加v信', '加微', '刷单', '兼职日结', '贷款',
  '内部消息', '包过', '代考', '作弊器'
];
let _extraWords = [];
let _extraWordsAt = 0;
const EXTRA_WORDS_MS = 5 * 60 * 1000;

function blockWords() {
  return _extraWords.length ? BLOCK_WORDS_BASE.concat(_extraWords) : BLOCK_WORDS_BASE;
}

// 拉一次审核员自配的词。失败时保留上一份（或空表），绝不清空内置词。
async function getExtraWords() {
  if (_extraWordsAt && Date.now() - _extraWordsAt < EXTRA_WORDS_MS) return _extraWords;
  const res = await db.collection(COL_CONFIG).doc('moderation').get().catch(() => null);
  const d = res && res.data && !Array.isArray(res.data) ? res.data : {};
  const raw = Array.isArray(d.words) ? d.words : [];
  _extraWords = raw
    .map((w) => String(w || '').trim())
    .filter((w) => w.length >= 1 && w.length <= 12)
    .slice(0, 200);
  _extraWordsAt = Date.now();
  return _extraWords;
}

/* ---------------- 图片异步安全审核 ---------------- */

// 为什么走**异步**而不是同步 imgSecCheck：
//   ① 同步接口要求图片 < 1MB，而本项目私信最多 6 张、评论 3 张，很多照片超了；
//   ② 同步接口要把每张图从云存储下载到函数内存再逐个校验，弱网下用户要干等，
//      而「发消息」是个高频动作，不该被审核拖住。
//   异步 mediaCheckAsync 只提交 URL 就返回一个 traceId，结果由微信侧回推。
//
// ⚠️ 结果回来的前提：云开发控制台 → 设置 → 其他设置 → 消息推送，
//    推送模式选「云函数」，配一条 MsgType=event / Event=wxa_media_check → 本云函数。
//    注意不是 mp 后台的「开发管理 → 开发设置 → 消息推送」——那条是给自建服务器
//    URL 用的，而且官方文档写明：云开发里配过的类型，就不再往那儿推了。
//    没配的话图片会一直停在 pending，由定时器兜底标记 unverified（放行）。
const MEDIA_KEEP_MS = 30 * 24 * 60 * 60 * 1000; // 审核记录保留 30 天
const MEDIA_SWEEP_MS = 10 * 60 * 1000;          // 超过 10 分钟还没回执 = 当没配推送

// 把云存储 fileID 换成公网可访问的临时链接（mediaCheckAsync 只收 http/https）
async function tempUrls(fileIds) {
  // 这里刻意不复用 isCloudFileIn：那个函数要求目录也完全匹配（forum / chat / market），
  // 而审核要处理的是「所有已通过白名单的图」，跨目录。所以只做最保守的形状检查 ——
  // 调用方传进来的都已经是 sanitizeImages 的产物，这一步只是防止将来有人
  // 从别处直接调它时把本机路径塞进去。
  const ids = (fileIds || []).filter((f) => {
    const s = String(f || '').trim();
    return s.indexOf('cloud://') === 0 && s.length <= FILEID_MAX;
  });
  if (!ids.length) return {};
  const out = {};
  try {
    const res = await cloud.getTempFileURL({ fileList: ids.slice(0, 10) });
    (res.fileList || []).forEach((f) => {
      if (f && f.fileID && f.tempFileURL) out[f.fileID] = f.tempFileURL;
    });
  } catch (e) {
    console.error('[tempUrls] failed:', String((e && e.errMsg) || e));
  }
  return out;
}

// 发布前的同步图片审核：色情/低俗图片在写库之前就拒绝掉。
// 微信 imgSecCheck 限制单图约 1MB；客户端上传前已压到长边 1280、质量 70。
// 接口不可用/单图超限时 checked=false，由调用方决定是否降级到异步审核。
function imageContentType(fileID) {
  const s = String(fileID || '').toLowerCase();
  if (/\.png(\?|$)/.test(s)) return 'image/png';
  if (/\.gif(\?|$)/.test(s)) return 'image/gif';
  if (/\.webp(\?|$)/.test(s)) return 'image/webp';
  return 'image/jpeg';
}

async function checkImageRiskSync(files) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return { supported: true, checked: true, risky: false };
  const api = cloud.openapi && cloud.openapi.security && cloud.openapi.security.imgSecCheck;
  if (!api) return { supported: false, checked: false, risky: false };

  const results = await Promise.all(list.map(async (fileID) => {
    let buf = null;
    try {
      const dl = await cloud.downloadFile({ fileID: fileID });
      buf = dl && (dl.fileContent || dl.buffer);
    } catch (e) {
      return { checked: false, risky: false };
    }
    if (!buf || !buf.length || buf.length > 1024 * 1024) return { checked: false, risky: false };
    try {
      const r = await api({
        media: { contentType: imageContentType(fileID), value: buf }
      });
      const code = Number(r && (r.errCode || r.errcode));
      if (code === 87014) return { checked: true, risky: true };
      if (!code || code === 0) return { checked: true, risky: false };
      return { checked: false, risky: false };
    } catch (e) {
      const code = Number(e && (e.errCode || e.errcode));
      if (code === 87014) return { checked: true, risky: true };
      return { checked: false, risky: false };
    }
  }));

  return {
    supported: true,
    checked: results.every((x) => x.checked),
    risky: results.some((x) => x.risky)
  };
}

async function imageGate(files) {
  const r = await checkImageRiskSync(files);
  if (r.risky) return '图片含有违规内容，换一张再发';
  if (r.supported && !r.checked) return '图片审核没完成，请稍后重试';
  return '';
}

// 提交审核。失败一律放行 —— 审核接口挂了不能让全校发不出图。
async function submitMediaCheck(openid, files, ctx) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return { ok: true, submitted: 0 };
  if (!cloud.openapi || !cloud.openapi.security || !cloud.openapi.security.mediaCheckAsync) {
    return { ok: true, submitted: 0, unsupported: true };
  }
  const urls = await tempUrls(list);
  let submitted = 0;
  for (const fid of list) {
    const url = urls[fid];
    if (!url) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await cloud.openapi.security.mediaCheckAsync({
        mediaUrl: url,
        mediaType: 2,       // 2 = 图片
        version: 2,         // 2 是当前推荐版本，返回的 detail 更细
        scene: (ctx && ctx.scene) || 1, // 1 资料 2 评论 3 论坛 4 社交日志
        openid: openid
      });
      const traceId = String((r && (r.traceId || r.trace_id)) || '');
      if (!traceId) continue;
      // eslint-disable-next-line no-await-in-loop
      await db.collection(COL_MEDIA).add({
        data: {
          traceId: traceId,
          openid: openid,
          mediaUrl: url,
          fileId: fid,
          targetType: String((ctx && ctx.targetType) || ''),
          targetId: String((ctx && ctx.targetId) || ''),
          peer: String((ctx && ctx.peer) || ''),
          msgId: String((ctx && ctx.msgId) || ''),
          status: 'pending',   // pending → pass / risky / unverified
          at: Date.now(),
          time: now(),
          expireAt: Date.now() + MEDIA_KEEP_MS
        }
      }).catch(() => {});
      submitted += 1;
    } catch (e) {
      console.error('[mediaCheck] submit failed:', String((e && e.errMsg) || e));
    }
  }
  return { ok: true, submitted: submitted };
}

// 回执处理：把 traceId 对应的记录更新掉，命中违规再把内容摘掉。
// 由 exports.main 顶部的消息推送分支调用（event.Event === 'wxa_media_check'）。
async function applyMediaVerdict(ev) {
  const traceId = String((ev && (ev.trace_id || ev.traceId)) || '');
  if (!traceId) return { ok: false, msg: '没有 traceId' };
  // 微信侧给的是 detail[] + result.suggest；历史上字段位置变过，两个都读
  const sug = String((ev && ev.result && ev.result.suggest)
    || (ev && ev.isrisky ? 'risky' : '')
    || ((ev && ev.detail && ev.detail[0] && ev.detail[0].suggest) || ''));
  const risky = sug === 'risky' || ev.isrisky === true || String(ev.isrisky) === 'true';

  const res = await db.collection(COL_MEDIA).where({ traceId: traceId }).limit(1)
    .get().catch(() => ({ data: [] }));
  const rec = res.data && res.data[0];
  if (!rec) {
    // 记录不在（已被清理，或推送来自别的小程序）：记一条便于排查，不报错
    await logMediaOrphan(traceId, sug);
    return { ok: true, ignored: true };
  }

  await db.collection(COL_MEDIA).doc(rec._id).update({
    data: { status: risky ? 'risky' : 'pass', suggest: sug, verdictAt: Date.now() }
  }).catch(() => {});

  if (!risky) return { ok: true, verdict: 'pass' };

  // 命中违规：把那张图摘掉，并给发布者记一段观察期。
  // 只摘图不删整条 —— 一句话配一张违规图，文字部分未必有问题，
  // 整条删掉会连带把正常的上下文一起弄没，审核员事后也看不到原始现场。
  await blockRiskyMedia(rec);
  return { ok: true, verdict: 'risky', handled: true };
}

async function logMediaOrphan(traceId, sug) {
  try {
    await db.collection(COL_ERRORS).add({
      data: {
        scope: 'mediaOrphan', msg: 'traceId=' + traceId + ' suggest=' + sug,
        code: 0, extra: {}, time: now(), at: Date.now()
      }
    });
  } catch (_) {}
}

// 违规图片的落地处理：按 targetType 分派
async function blockRiskyMedia(rec) {
  const t = String(rec.targetType || '');
  const id = String(rec.targetId || '');
  const mediaFlag = { mediaBlocked: true, mediaBlockedAt: Date.now() };
  try {
    if (t === 'chat') {
      // 私信：定位到那条消息，把图摘掉、正文保留，并在气泡上留一句说明。
      // 这里同样不能整份写回：审核回执往往在对话正热的时候才回来，
      // 抹掉一条刚发的消息比晚几秒处理这张图糟得多 —— 见 chatUpdateMessages
      const key = chatKey(rec.openid, rec.peer);
      const r = await db.collection(COL_CHATS).where({ key: key }).limit(1).get().catch(() => ({ data: [] }));
      const chat = r.data && r.data[0];
      if (!chat) return;
      let wasImageLast = false;
      await chatUpdateMessages(chat._id, (cur) => {
        wasImageLast = cur.lastText === '[图片]';
        const msgs = (cur.messages || []).map((m) => {
          if (!m || String(m.id) !== String(rec.msgId)) return m;
          return Object.assign({}, m, mediaFlag, {
            images: [], text: String(m.text || ''),
            note: '图片因违反内容规范已被移除'
          });
        });
        return { messages: msgs };
      });
      // 摘要行跟着改：只改一个字段，不碰数组
      if (wasImageLast) {
        await db.collection(COL_CHATS).doc(chat._id)
          .update({ data: { lastText: '[图片已被移除]' } }).catch(() => {});
      }
    } else if (t === 'post') {
      await byId(COL_POSTS, id).update({
        data: Object.assign({}, mediaFlag, {
          status: 'hidden',
          hiddenReason: '系统检测到图片违规，已暂停展示',
          hiddenAt: now()
        })
      }).catch(() => {});
    } else if (t === 'comment') {
      // 评论：整条摘掉（评论太短，摘图之后往往只剩一句无意义的残话）
      // 拆表之后留言是独立文档，直接按 id 软删；连带它的子回复。
      // 走申诉通道：图片是机器判的，机器会错，作者得有机会说一句
      const parts = String(rec.targetId || '').split('|');
      const pid = parts[0] || '';
      const cid = parts[1] || '';
      if (!pid || !cid) return;
      await softRemoveCommentTree(pid, cid, {
        by: 'system', reason: '系统检测到图片违规', appealable: true
      });
      const r = await byId(COL_POSTS, pid).limit(1).get().catch(() => ({ data: [] }));
      const post = r.data && r.data[0];
      const got = await db.collection(COL_POST_COMMENTS).doc(cid).get().catch(() => null);
      const c = got && got.data && !Array.isArray(got.data) ? got.data : null;
      if (post && c) {
        await notifyCommentRemoved(post, c, '系统检测到图片违规', 'system').catch(() => {});
      }
    } else if (t === 'market') {
      // 闲置的 status 是 open / done（交易状态），不能拿来当处置标记；
      // 列表只认 hidden。这里必须写 hidden=true，否则图片审核命中了也不会下线。
      await byId(COL_MARKET, id).update({
        data: Object.assign({}, mediaFlag, {
          hidden: true,
          hiddenReason: '图片违规',
          hiddenAt: now()
        })
      }).catch(() => {});
    }
  } catch (e) {
    console.error('[blockRiskyMedia] failed:', String((e && e.errMsg) || e));
  }

  // 观察期：和「被多名同学举报的作者」共用同一枚标记，
  // 页面据此显示「该账号近期内容存在风险」。不自动封号 —— 图片判定的误伤率
  // 比文字高，自动封号会封掉一片，留给审核员在队列里手动处置
  await db.collection(COL_USERS).doc(rec.openid).update({
    data: { limitedUntil: Date.now() + MOD_RULES.AUTHOR_WINDOW_H * 3600 * 1000 }
  }).catch(() => {});
}

// 兜底：微信推送没配（或推送丢了）时，pending 记录会一直挂着。
// 超过 10 分钟仍无回执的一律标 unverified 并放行 —— 悬挂状态比「没审」更糟，
// 因为审核员在队列里看到 pending 会以为「还在审」，一直等下去。
async function mediaAuditSweep() {
  const res = await db.collection(COL_MEDIA)
    .where({ status: 'pending' }).limit(100).get().catch(() => ({ data: [] }));
  const stale = (res.data || []).filter((r) => Date.now() - (Number(r.at) || 0) > MEDIA_SWEEP_MS);
  for (const r of stale) {
    // eslint-disable-next-line no-await-in-loop
    await db.collection(COL_MEDIA).doc(r._id)
      .update({ data: { status: 'unverified', verdictAt: Date.now() } }).catch(() => {});
  }
  return stale.length;
}

// 想固定几个人当审核员，走环境变量：
//   云函数目录 → 配置 → 环境变量 → KEY: MODERATORS，值用英文逗号分隔多个 openid
// 这是上线后固定的做法：不用改代码、不用重新部署，改完等一两分钟就生效
const MODERATORS = String(process.env.MODERATORS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// 审核员名册里记录的就是点过按钮的人。名单留空时，谁能进来由这里决定。
//
// ⚠️ 默认关掉自助登记：审核员能删全校任意帖子 / 评价、置顶、清空校历、删别人的闲置，
// 而 setAdmin 不校验身份，任何同学一次云调用就能把自己登记进去。
// 开放它等于给全校所有人一把管理后台的钥匙。
// 确实需要自助登记（比如自己就是唯一的运营者）时，再改成 true 重新部署一次。
const SELF_ADMIN = false;

// 举报处置规则。
// ⚠️ 这份是「服务端权威值」，utils/config.js 的 MODERATION 只用于前端展示文案，
// 两边阈值要一起改，别只改一处。
//
// ==== 2026-10-18：改成「按浏览量分档」，并且**取消一切自动删除** ====
//
// 一、为什么分档
//   固定「3 个人举报就下架」对两种内容是两件完全不同的事：
//   一条 8 个人看过的帖子，3 个人说不行 = 37%，确实有问题；
//   一条 800 个人看过的帖子，3 个人说不行 = 0.4%，很可能只是三个人看不顺眼。
//   而后者恰恰是最容易被举报三次的 —— 看得人越多，遇到不同意的人越多。
//   固定门槛惩罚的是「火」，不是「坏」。
//   现在按独立浏览人数（去重、不含作者）分档：0-49 → 3 人、50-199 → 5 人、
//   200-499 → 7 人、500+ → 10 人。表在 report-rules.js，纯函数，有边界测试。
//
// 二、为什么取消自动删除
//   删除不可逆，而被误删的那条帖子的原文，正是作者申诉、同学举证、撤回投诉时
//   唯一能拿出来的东西。删错一次就是永久性的证据灭失。
//   所以自动处置只做**下架**（hide）：内容从公开列表收起来、进人工队列，
//   作者自己能一键恢复。删不删由审核员看过之后再定。
//   连带去掉的还有三处：
//     · 5 人直删（AUTO_DELETE_THRESHOLD）—— 本来也到不了（3 票就藏了）
//     · 高敏 2 人 + 证据直删（HIGH_RISK_DELETE）—— 删除不再由人数决定
//     · 1 人踩词 + 证据直删（HIGH_RISK_DELETE_SOLE）—— 同上
//   高敏理由仍然有用：它决定举报在队列里的排序（审核员先看哪一条）。
const MOD_RULES = {
  HIGH_RISK: ['涉及隐私', '违规交易', '广告骚扰'], // 高敏原因：只影响队列排序
  AUTHOR_WINDOW_H: 24,  // 同一个人 24h 内被举报多次的统计窗口（用于队列里标人）

  // ==== 反滥用：从「一罚三，永久作废」改成「有窗口，能自己好起来」 ====
  // 旧规则是「被驳回满 3 次，这个人这辈子的举报都不算数」——
  // 两条毛病：
  //   ① 惩罚太重。最该被这一条误伤的，恰恰是最热心的那批人
  //      （他认真看过、写了说明，只是判断偏了一点），一棍子打死太凉薄；
  //   ② 永久生效，除了运营手动清库没有任何出路。
  // 新规则只在最近 ABUSER_WINDOW_D 天里数驳回次数，满 ABUSER_LIMIT 进观察期，
  // 观察期 OBSERVE_H 小时后自动解除（不用任何人动手），
  // 观察期内再熬满 OBSERVE_GRACE_H 没有新的驳回也能提前放出来；
  // reverse 通道更宽：只要有一条举报被审核员判「违规成立」，观察期立刻解除 ——
  // 一个举报得准的人，不该因为错过几次就一直背着。
  ABUSER_WINDOW_D: 7,         // 只数最近这么多天被驳回的举报
  ABUSER_LIMIT: 3,            // 最近这么多天被驳回满这么多次 → 进观察期
  OBSERVE_H: 48,              // 观察期时长（小时），到点自动解除
  OBSERVE_GRACE_H: 24,        // 观察期内连续这么久没新的驳回 → 提前恢复
  ABUSER_BADGE: '观察期'      // 观察期内在队列里显示的标签
};

/* ----------------------------------------------------------------
 * 「这是正常校园社交，还是商业广告」的判定曾经在这里
 *
 * 原来它决定「这条帖子会不会被两条高敏举报直接删掉」——社团招新帖被当广告删，
 * 是最伤的误判。现在自动处置只剩「下架」这一档，而且要凑够按浏览量算的人数，
 * 真正删不删已经全部交给审核员，这个判定没有用武之地，连同 SOCIAL_HINTS /
 * AD_HINTS / PROOF_PATTERN 一起删掉了。
 *
 * 之所以专门留这段说明：这几个正则写得挺细，将来若有人想恢复「自动删除」，
 * 会以为它还在。**恢复自动删除之前，先想清楚误删的原文怎么给作者申诉。**
 * ---------------------------------------------------------------- */

// 屏蔽词（与前端 utils/moderation.js 保持一致，服务端为准，绕不过去）
//
// 词表本体在文件上方的 BLOCK_WORDS_BASE，审核员在「审核」页填的增补词
// 存在 app_config/moderation.words 里，由 blockWords() 合并 ——
// 所以这里不再有一份写死的常量，加词不必改代码 + 重新部署。
// ⚠️ 内置那份永远不能被清空：审核员把自配词删光时只剩它，静默裸奔是最坏的结果。

// 「拉群 / 留联系方式」这一类词，正常社交也需要，只在特定板块放行。
//
// 为什么必须放行：社团招新和同好群帖的核心内容就是「加群」「加微信」——
// 「加微信」在 BLOCK_WORDS 里，照原来的规则这类帖子一条都发不出去，
// 或者发出来被当成广告举报掉。而它恰恰是校园社区冷启动最值钱的内容：
// 社团本来就自带一群人，让他们把群号贴在这儿，比自己去拉活有效得多。
//
// 放行的只是「怎么联系」，不是「别守规矩」：涉黄涉赌、代考刷单这些词
// 不在豁免名单里，骂人的词也不在，一律照旧拦截。
const JOIN_WORDS_EXEMPT = ['加微信', '加v信', '加微'];

// 允许留联系方式的板块。只有这些板块享受上面的豁免，
// 别的板块（课程评价、闲置、校园吐槽…）一视同仁 ——
// 在校园吐槽里发「加微信领资料」仍然是广告，该拦就拦
const CONTACT_OK_BOARDS = ['社团同好', '活动组队', '失物招领', '树洞'];

// 豁免只作用于「怎么加群」这几个词，其余屏蔽词照常生效
function checkTextInBoard(board, ...parts) {
  const exempt = CONTACT_OK_BOARDS.indexOf(String(board || '')) >= 0;
  if (!exempt) return checkText.apply(null, parts);
  const s = parts.map(normalizeText).join('');
  if (!s) return { ok: true };
  const hit = blockWords().filter((w) => {
    if (JOIN_WORDS_EXEMPT.indexOf(w) >= 0) return false;
    return s.indexOf(normalizeText(w)) >= 0;
  });
  if (hit.length) return { ok: false, hit: hit, msg: blockMsg(hit) };
  return { ok: true };
}

// 拦截提示：点名是哪个词。见 checkText 下面的说明
function blockMsg(hit) {
  const names = (hit || []).slice(0, 2).join('、');
  return names ? '内容里有「' + names + '」，换个说法试试' : '内容含不合适用词';
}

// 抹掉大小写、空白、标点、符号，只留 ASCII 字母数字和常用汉字。
// 与前端 utils/moderation.js 的 normalize 保持一致，避免「前端放行、云端又拦」
// 的双标问题；同时避开 \p{}（ES2018 Unicode property）在旧基础库上的崩溃。
function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

// 命中屏蔽词则拒绝写入，返回结果给前端决定怎么提示。
// 提示文案见 blockMsg：点名具体是哪个词，别只说「含不合适用词」
function checkText(...parts) {
  const s = parts.map(normalizeText).join('');
  if (!s) return { ok: true };
  const hit = blockWords().filter((w) => s.indexOf(normalizeText(w)) >= 0);
  if (hit.length) return { ok: false, hit: hit, msg: blockMsg(hit) };
  return { ok: true };
}

function now() {
  // 云函数宿主时区不保证是 Asia/Shanghai（Tencent 常见为 UTC）。
  // 直接 getHours() 会让帖子时间比手机慢 8 小时。这里先加 8 小时，
  // 再用 UTC 取值，得到稳定的北京时间。
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
    ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

// 没填过资料的人也要有一张能打开的名片：否则管理员从举报页点进来是一片空白，
// 连封禁入口都没有。默认名只用于展示，不代表用户自己设置了昵称。
function fallbackProfile(openid) {
  return {
    openid: String(openid || ''),
    nickName: '浙小商',
    avatarUrl: '',
    college: '',
    motto: '',
    profileIncomplete: true
  };
}

// 只暴露公开的展示字段（不含联系方式）
function publicProfile(u) {
  const avatarUrl = safeAvatar(u.avatarUrl);
  const nickName = u.nickName || '浙小商';
  return {
    openid: u.openid || u._openid || '',
    nickName: nickName,
    // 读的时候也过一遍白名单：老数据里可能存过外链，不能让名片页继续请求站外图片。
    avatarUrl: avatarUrl,
    college: u.college || '',
    motto: u.motto || '',
    profileIncomplete: !!u.profileIncomplete
      || (!avatarUrl && !u.college && !u.motto && (!u.nickName || u.nickName === '浙小商'))
  };
}

// 展示字段 + 联系方式（仅用于「已互认的好友」）
function fullProfile(u) {
  return Object.assign(publicProfile(u), {
    contactType: u.contactType || '',
    contactValue: u.contactValue || ''
  });
}

async function me() {
  return cloud.getWXContext().OPENID || '';
}

/* ---------------- 个人资料 ---------------- */

// 首次进入时自动登记：openid 作为 _id，天然唯一且幂等
async function upsertProfile(openid, payload) {
  payload = payload || {};
  const normalized = {
    nickName: String(payload.nickName || '').trim().slice(0, 20) || '浙小商',
    // 头像只认本小程序 avatars/ 目录下的云文件：外链等于给头像开了一个站外请求入口
    avatarUrl: safeAvatar(payload.avatarUrl),

    college: String(payload.college || '').trim().slice(0, 20),
    motto: String(payload.motto || '').trim().slice(0, 40),
    contactType: payload.contactType || '',     // wechat / phone / qq / ''
    contactValue: String(payload.contactValue || '').trim().slice(0, 40),
    updatedAt: now()
  };
  if (!normalized.contactValue) normalized.contactType = '';
  const g = await guard(normalized.nickName, normalized.motto, normalized.college);
  if (!g.ok) return { ok: false, msg: g.msg };

  const exist = await db.collection(COL_USERS).doc(openid).get().catch(() => null);
  const prevAvatar = exist && exist.data ? safeAvatar(exist.data.avatarUrl) : '';
  const avatarChanged = payload.avatarUrl !== undefined
    && !!normalized.avatarUrl && normalized.avatarUrl !== prevAvatar;
  // 头像会出现在帖子、留言、名片和私信里，属于公开 UGC 图片。
  // 只在头像真的变了时做一次同步审核，避免每次保存资料都多一次云调用；
  // 审核接口不可用或单图超限时放行（risk.checked=false），不让换头像被网络问题卡死。
  if (avatarChanged) {
    const risk = await checkImageRiskSync([normalized.avatarUrl]);
    if (risk.risky) return { ok: false, msg: '头像含有违规内容，换一张再试' };
  }
  if (exist && exist.data) {
    // 只更新客户端明确提供的字段。空缓存/旧客户端缺字段时绝不能把云端已有资料覆盖掉。
    const patch = {};
    ['nickName', 'avatarUrl', 'college', 'motto', 'contactType', 'contactValue'].forEach((k) => {
      if (payload[k] !== undefined) patch[k] = normalized[k];
    });
    if (payload.contactType !== undefined && payload.contactValue !== undefined && !patch.contactValue) {
      patch.contactType = '';
    }
    patch.updatedAt = now();
    const w = await db.collection(COL_USERS).doc(openid).update({ data: patch }).catch((e) => ({ err: e }));
    if (w && w.err) return { ok: false, saved: false, msg: '资料没存住，再试一次' };
    const merged = Object.assign({}, exist.data, patch);
    // 只有用户明确保存资料时才允许重新激活已注销账号；打开小程序不能自动复活。
    if (payload.revive === true && exist.data.deleted) {
      const rv = await db.collection(COL_USERS).doc(openid)
        .update({ data: { deleted: false, deletedAt: 0 } }).catch((e) => ({ err: e }));
      if (rv && rv.err) return { ok: false, saved: false, msg: '账号状态没更新，再试一次' };
      merged.deleted = false;
      merged.deletedAt = 0;
    }
    return { ok: true, profile: fullProfile(Object.assign({ openid }, merged)) };
  }

  const data = Object.assign({ createdAt: Date.now() }, normalized);
  const w = await db.collection(COL_USERS).doc(openid)
    .set({ data: data }).catch((e) => ({ err: e }));
  if (w && w.err) return { ok: false, saved: false, msg: '资料没存住，再试一次' };
  return { ok: true, profile: fullProfile(Object.assign({ openid }, data)) };
}

// 看别人的主页：只有双方已互认（双向 accepted）才给联系方式，否则只给公开字段
async function getProfile(openid, target) {
  target = String(target || '');

  // 看自己的名片：返回**本人完整资料**。
  //
  // 原先这里第一行就是 `if (!target || target === openid) return { profile: null }`，
  // 而名片页模板里有一整块 wx:if="{{isMe}}" 的 UI（「这是你自己的名片 / 编辑我的资料」）。
  // 结果那块 UI 谁也看不到：传自己的 openid 会被渲染成
  // 「这位同学还没有填资料」的空状态，看起来像资料丢了。
  // 一块永远不显示的分支比没有它更坏 —— 后来的人会以为它被某条路径用着，不敢动。
  //
  // 自己的数据不存在「该不该给」的问题，直接给完整版（含联系方式）。
  if (!target || target === openid) {
    const self = await db.collection(COL_USERS).doc(openid).get().catch(() => null);
    const su = self && self.data && !Array.isArray(self.data) ? self.data : null;
    if (!su) return { profile: fullProfile(fallbackProfile(openid)), isFriend: false, isMe: true };
    su.openid = su.openid || openid;
    return { profile: fullProfile(su), isFriend: false, isMe: true };
  }

  // 关系以 friends 表为准，contacts 里 accepted 的老记录同样认（升级兼容）
  const relF = await db.collection(COL_FRIENDS)
    .where({ openid: openid, friend: target }).limit(1).get().catch(() => ({ data: [] }));
  let isFriend = !!(relF.data && relF.data.length);
  if (!isFriend) {
    const rel = await db.collection(COL_CONTACTS)
      .where(db.command.or([
        { fromOpenid: openid, toOpenid: target, status: 'accepted' },
        { fromOpenid: target, toOpenid: openid, status: 'accepted' }
      ])).limit(1).get().catch(() => ({ data: [] }));
    isFriend = !!(rel.data && rel.data.length);
  }

  const res = await db.collection(COL_USERS).doc(target).get().catch(() => null);
  const u = res && res.data && !Array.isArray(res.data) ? res.data : null;
  if (!u) return { profile: publicProfile(fallbackProfile(target)), isMe: false, isFriend: isFriend };

  // 备注名：对方的名片在我这儿要显示成我给他起的名字。
  // 只查我这一侧的 friends 记录，不改对方的资料 —— 备注是**我这边的视图**，
  // 一旦写进对方的 users 文档，全校都会看到我给他起的外号
  const alias = isFriend ? await friendAliasOf(openid, target) : '';

  u.openid = u.openid || target;
  return {
    profile: Object.assign(isFriend ? fullProfile(u) : publicProfile(u), alias ? { alias: alias } : {}),
    isFriend: isFriend,
    isMe: false
  };
}

// 我给他起的备注名（没有就返回空串）
async function friendAliasOf(openid, friend) {
  const r = await db.collection(COL_FRIENDS)
    .where({ openid: openid, friend: friend }).limit(1).get().catch(() => ({ data: [] }));
  const rec = r.data && r.data[0];
  return String((rec && rec.alias) || '').trim().slice(0, 20);
}

// 同学广场：按昵称 / 学院搜人（只返回公开字段）
//
// 数据库只支持正则匹配（原样包含），「打错一个字就搜不到人」在同学广场上照样会发生，
// 找人的时候更致命 —— 于是先让库里按包含粗筛一轮省传输，再在内存里用同一套
// 精准 / 模糊内核复筛 + 排序：找得到的人里，名字完全对得上的排最前面。
async function search(openid, keyword, exact) {
  const kw = String(keyword || '').trim();
  if (!kw) return { list: [] };
  // 数据库的正则只能做「原样包含」，拿它当粗筛必须放得足够宽：
  // 关键词拆成单个字，「出现任意一个字就捞出来」。
  // 早先这里用的是完整关键词，结果同学把名字打错一个字时，库里一条都捞不出来 ——
  // 下面那套内存复筛（精准 / 模糊）根本轮不到执行，找人就像坏了
  const parts = kw.split('').map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const reg = db.RegExp({ regexp: parts, options: 'i' });
  const res = await db.collection(COL_USERS)
    .where(db.command.or([{ nickName: reg }, { college: reg }]))
    .limit(50).get().catch(() => ({ data: [] }));

  const scored = [];
  (res.data || []).forEach((u) => {
    const lv = searchCore.matchFields([u.nickName, u.college], kw);
    // 精准档只留原样命中，和前端课程 / 论坛 / 闲置的判定保持一致
    if (lv < 0 || (exact && lv > searchCore.MATCH_RANK.contain)) return;
    scored.push({ lv: lv, u: publicProfile(u) });
  });
  scored.sort((a, b) => a.lv - b.lv);
  return { list: scored.map((s) => s.u) };
}

/* ---------------- 联系请求（想认识） ---------------- */

// ⚠️ 早期这里写的是 .where({toOpenid, status:'pending'}).orderBy('time','desc')。
// 云开发的 where + orderBy 走的是**复合索引**，没在控制台建索引时查询直接报错，
// 而外面又套了 .catch(() => ({data:[]})) 把错误吞掉 —— 结果就是「别人发给我的申请
// 永远一条都不出现」，日志里什么都看不到。这是「好友申请收不到」的根因之一。
// 现在改成：只按单字段 where 取回来，排序在内存里做（量级 50 条，开销可忽略），
// 顺便把失败原因记进日志，别再静默。
async function listRequests(openid) {
  const res = await db.collection(COL_CONTACTS)
    .where({ toOpenid: openid, status: 'pending' })
    .limit(50).get()
    .catch((e) => { console.error('[listRequests] query failed:', String((e && e.errMsg) || e)); return null; });

  // ⚠️ 「查失败」不能和「真的没有申请」长成同一个样子。
  //    这里以前是 .catch(() => ({data: []}))，两种情况的回执一模一样，
  //    页面只好显示「暂时没有新申请」—— 而实际情况可能是索引没建、查询直接报错，
  //    用户等一整周也等不到那条申请，且永远查不出原因。
  //    现在如实带上 degraded，页面据此提示「刷新失败，下拉重试」。
  if (!res) return { ok: true, list: [], degraded: true };

  const rows = (res.data || []).slice().sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  const out = [];
  for (const r of rows) {
    const p = await db.collection(COL_USERS).doc(r.fromOpenid).get().catch(() => null);
    const u = (p && p.data) || {};
    out.push({
      id: r._id,
      fromOpenid: r.fromOpenid,
      message: r.message || '',
      time: r.time || '',
      nickName: u.nickName || '某个同学',
      avatarUrl: u.avatarUrl || '',
      college: u.college || '',
      avatarText: (u.nickName || '某').charAt(0)
    });
  }
  return { ok: true, list: out };
}

// 我主动发起、还在等对方处理的
async function listOutgoing(openid) {
  const res = await db.collection(COL_CONTACTS)
    .where({ fromOpenid: openid, status: 'pending' })
    .limit(50).get()
    .catch((e) => { console.error('[listOutgoing] query failed:', String((e && e.errMsg) || e)); return { data: [] }; });

  const rows = (res.data || []).slice().sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  const out = [];
  for (const r of rows) {
    const p = await db.collection(COL_USERS).doc(r.toOpenid).get().catch(() => null);
    const u = (p && p.data) || {};
    out.push({
      id: r._id,
      toOpenid: r.toOpenid,
      message: r.message || '',
      time: r.time || '',
      nickName: u.nickName || '同学',
      avatarUrl: u.avatarUrl || ''
    });
  }
  return { ok: true, list: out };
}

// 撤销我发出的那条好友申请。
//
// 为什么要有：申请发出去以后，界面上只剩「已申请，等对方回应」这一句，
// 没有任何出口。发错人了、突然觉得唐突、或者想换句话重发，都只能干等对方处理。
//
// 顺带清掉 24 小时冷却：冷却记在 contacts 记录上（见 addRequest），
// 记录一删冷却就没了 —— 这正是我们想要的，撤销之后本来就应该能立刻重发，
// 否则「撤销」这个动作等于把自己锁上一天。
async function friendCancel(openid, payload) {
  payload = payload || {};
  const target = String(payload.toOpenid || '').trim();
  const id = String(payload.id || '').trim();

  let rec = null;
  if (id) {
    const r = await db.collection(COL_CONTACTS).doc(id).get().catch(() => null);
    rec = r && r.data && !Array.isArray(r.data) ? r.data : null;
    if (rec && String(rec.fromOpenid || '') !== openid) return { ok: false, msg: '只能撤销自己发出的申请' };
    if (rec && String(rec.status || '') !== 'pending') return { ok: false, msg: '这条申请已经处理过了' };
  } else if (target) {
    const r = await db.collection(COL_CONTACTS)
      .where({ fromOpenid: openid, toOpenid: target, status: 'pending' })
      .limit(1).get().catch(() => ({ data: [] }));
    rec = r.data && r.data[0];
  } else {
    return { ok: false, msg: '参数缺失' };
  }

  // 没有记录 = 已经不在那儿了，按成功处理（用户点第二次、或对方刚同意/拒绝）
  if (!rec) return { ok: true, canceled: true, already: true };

  const rm = await db.collection(COL_CONTACTS).doc(rec._id).remove().catch(() => null);
  // 删失败还报「已撤销」，用户下次进来又看到「已申请」，会以为撤销按钮是坏的
  if (!rm) return { ok: false, msg: '撤销失败，再试一次' };
  return { ok: true, canceled: true };
}

// 设置 / 清除备注名。备注只写我这一侧的 friends 记录（一条记录一个方向），
// 所以它是「我怎么看他」，对方看不到，也不影响对方怎么看我。
async function friendAlias(openid, payload) {
  payload = payload || {};
  const target = String(payload.toOpenid || '').trim();
  if (!target) return { ok: false, msg: '参数缺失' };
  if (target === openid) return { ok: false, msg: '不能给自己设备注' };
  const alias = String(payload.alias || '').trim().slice(0, 20);
  const ga = await guard(alias);
  if (!ga.ok) return { ok: false, msg: ga.msg };

  const r = await db.collection(COL_FRIENDS)
    .where({ openid: openid, friend: target }).limit(1).get().catch(() => ({ data: [] }));
  const rec = r.data && r.data[0];
  // 不是好友就不让设备注：备注的意义是「在我的同学名单里怎么显示他」，
  // 名单里没这个人，存下来的备注名没有任何地方会用到
  if (!rec) return { ok: false, msg: '你们还不是同学关系' };

  const w = await db.collection(COL_FRIENDS).doc(rec._id)
    .update({ data: { alias: alias, aliasAt: Date.now() } }).catch(() => null);
  if (!w) return { ok: false, msg: '保存失败，再试一次' };
  return { ok: true, alias: alias };
}

/* ---------------- 同学关系表 ---------------- */

// 同学关系单独一张表，不再和「申请记录」挤在一起：
//   旧模型把「A 同意 B」表达成把申请记录的 status 改成 accepted，
//   于是「申请列表」和「好友列表」是同一张表的两个视图 —— 一旦其中一步写失败，
//   就会出现「申请消失了，好友也没加上」或者「好友加了，申请还挂在那儿」。
//   现在关系就是关系：双向各写一条，_id 定死，重复写入天然幂等。
function friendDocId(a, b) { return String(a) + '_' + String(b); }

// 事务外壳：老版本 SDK 没有 runTransaction / startTransaction 时降级成顺序写 + 补偿回滚，
// 保证「要么两边都加上，要么都没加」，绝不留下单边好友
async function runTransaction(work) {
  if (typeof db.runTransaction === 'function') {
    return db.runTransaction(async (tx) => { await work(tx, true); });
  }
  if (typeof db.startTransaction === 'function') {
    const tx = await db.startTransaction();
    try {
      await work(tx, true);
      await tx.commit();
    } catch (e) {
      try { await tx.rollback(); } catch (_) {}
      throw e;
    }
    return;
  }
  // 降级：tx 传 null，调用方按「直接操作 db」实现，并在失败时手动补偿
  await work(null, false);
}

// 已经互认了吗（两个方向只要有一向成立就算，读取侧容错）
async function isFriendPair(a, b) {
  const r = await db.collection(COL_FRIENDS)
    .where({ openid: a, friend: b }).limit(1).get().catch(() => ({ data: [] }));
  return !!(r.data && r.data.length);
}

// 24 小时冷却：刚被拒绝的人不能立刻反复骚扰，避免「想认识」变成轰炸
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

async function addRequest(openid, payload) {
  payload = payload || {};
  const to = String(payload.toOpenid || '');
  const message = String(payload.message || '').slice(0, 50);
  const g = await guard(message);
  if (!g.ok) return { ok: false, msg: g.msg };
  if (!to) return { ok: false, msg: '没有指定同学' };
  if (to === openid) return { ok: false, msg: '不能给自己发请求' };

  // 已经是同学就别再发申请了：关系表是新的权威来源，
  // 只查 contacts 会在「申请记录已被同意时删掉」之后误判成陌生人，
  // 于是同学之间能反复互发申请（「明明是好友还一直弹申请」）
  if (await isFriendPair(openid, to)) {
    return { ok: false, msg: '你们已经是好友啦' };
  }

  // 对方把我拉黑了 —— 直接拒绝，前端连「已发出」都看不到
  const blocked = await db.collection(COL_BLOCKS)
    .where({ openid: to, target: openid })
    .limit(1).get().catch(() => ({ data: [] }));
  if (blocked.data && blocked.data.length) {
    return { ok: false, msg: '对方设置了消息限制' };
  }

  const exist = await db.collection(COL_CONTACTS)
    .where({ fromOpenid: openid, toOpenid: to })
    .limit(1).get().catch(() => ({ data: [] }));

  const prev = exist.data && exist.data[0];
  if (prev) {
    if (prev.status === 'pending') return { ok: false, msg: '已经发起过了，等对方回应' };
    if (prev.status === 'accepted') return { ok: false, msg: '你们已经是好友啦' };
    // 之前被拒绝过：24 小时内不让你重来
    const last = prev.replyAt || prev.time || '';
    const t = Date.parse(last.replace(/-/g, '/'));
    if (t && Date.now() - t < COOLDOWN_MS) {
      return { ok: false, msg: '对方可能还没准备好，过一天再试试' };
    }
    // 冷却结束，重新激活这条记录
    await db.collection(COL_CONTACTS).doc(prev._id)
      .update({ data: { status: 'pending', message: message, time: now() } });
    await notifyFriendReq(openid, to, message);
    return { ok: true };
  }

  await db.collection(COL_CONTACTS).add({
    data: {
      fromOpenid: openid,
      toOpenid: to,
      status: 'pending',
      message: message,
      time: now()
    }
  });
  await notifyFriendReq(openid, to, message);
  return { ok: true };
}

// 好友申请的站内通知。
// 订阅消息是一次性的（用户授权一次只能推一条），而「有人想加你」恰恰是
// 最需要及时知道的一类事件 —— 晚两天看到，人家已经不再想加了。
// 通知里不写对方的昵称：昵称随时会改，存快照就会出现
// 「通知里叫他小张，点进去名片上写着张三」的对不上。只写「有一位同学」。
async function notifyFriendReq(openid, to, message) {
  await pushNotify(to, {
    type: 'friendReq',
    title: '有一位同学想认识你',
    body: String(message || '').slice(0, 50) || '在「我的同学 → 请求」里可以看到',
    page: 'pages/user/friends/friends'
  });
  return true;
}

// 同意好友申请 —— 一个事务里做完三件事：
//   ① 删除这条待处理申请记录；
//   ② 双向写入同学关系表（A→B 与 B→A 各一条，_id 定死，重复执行不产生脏数据）；
//   ③ 返回成功状态 + 这位新同学的资料，前端拿到就能立刻插进列表。
//
// 之前的实现是「改申请状态 → 再补一条反向申请」，两步独立、没有事务：
// 第二步失败时对方那边永远看不到我，而申请又已经从待处理里消失了 ——
// 正是「点了同意，申请没了，人也没加上」这个现象的来源。
async function friendAccept(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };

  // 先在事务外读一次做权限校验：只有被请求的一方（toOpenid）能同意
  const rec = await db.collection(COL_CONTACTS).doc(id).get().catch(() => null);
  if (!rec || !rec.data) return { ok: false, msg: '这条申请已经不在了，刷新一下' };
  if (rec.data.toOpenid !== openid) return { ok: false, msg: '无权处理这条请求' };
  if (rec.data.status && rec.data.status !== 'pending') {
    // 已经处理过：别再写一遍，直接按成功返回，前端刷新即可（幂等）
    return { ok: true, alreadyDone: true, friend: null };
  }

  const from = String(rec.data.fromOpenid || '');
  if (!from || from === openid) return { ok: false, msg: '这条申请不完整，无法处理' };

  const at = now();
  const docA = { openid: openid, friend: from, since: at, from: 'accept' };
  const docB = { openid: from, friend: openid, since: at, from: 'accept' };
  const idA = friendDocId(openid, from);
  const idB = friendDocId(from, openid);

  try {
    await runTransaction(async (tx, inTx) => {
      const c = tx ? tx.collection(COL_CONTACTS) : db.collection(COL_CONTACTS);
      const f = tx ? tx.collection(COL_FRIENDS) : db.collection(COL_FRIENDS);
      await c.doc(id).remove();
      // 用 set 而不是 add：_id 定死，重复同意（重试 / 连点）只会覆盖，不会多出一条
      await f.doc(idA).set({ data: docA });
      await f.doc(idB).set({ data: docB });
      if (!inTx) return; // 降级分支不做额外动作
    });
  } catch (e) {
    console.error('[friendAccept] transaction failed:', String((e && e.errMsg) || e));
    // 降级路径下可能只写了一半，手动补偿：把刚写进去的关系撤掉，回到「都没发生」
    try {
      await db.collection(COL_FRIENDS).doc(idA).remove().catch(() => {});
      await db.collection(COL_FRIENDS).doc(idB).remove().catch(() => {});
    } catch (_) {}
    return { ok: false, msg: '通过失败，请再点一次', detail: String((e && e.errMsg) || e).slice(0, 120) };
  }

  // 事务已提交，再查一次确认两个方向都在（顺带给前端新同学的资料）
  const [okA, okB] = await Promise.all([
    isFriendPair(openid, from),
    isFriendPair(from, openid)
  ]);
  if (!okA || !okB) {
    // 极端情况：提交成功但读不到（主从延迟）。补一次再验，仍失败就如实报错
    await db.collection(COL_FRIENDS).doc(idA).set({ data: docA }).catch(() => {});
    await db.collection(COL_FRIENDS).doc(idB).set({ data: docB }).catch(() => {});
  }

  const p = await db.collection(COL_USERS).doc(from).get().catch(() => null);
  // 告诉申请人「通过了」：他那边一直在等，而通过的瞬间只有他自己点进名单才发现
  await pushNotify(from, {
    type: 'friendAccept',
    title: '你的好友申请通过了',
    body: '你们现在是同学关系，可以互相看到联系方式',
    page: 'pages/user/card/card?openid=' + openid
  });
  return {
    ok: true,
    accepted: true,
    friendOpenid: from,
    friend: p && p.data ? fullProfile(p.data) : null
  };
}

// 忽略：不删记录，标成 rejected —— 保留时间戳才有 24 小时冷却（见 addRequest）
async function friendReject(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const rec = await db.collection(COL_CONTACTS).doc(id).get().catch(() => null);
  if (!rec || !rec.data) return { ok: true, alreadyDone: true };
  if (rec.data.toOpenid !== openid) return { ok: false, msg: '无权处理这条请求' };
  await db.collection(COL_CONTACTS).doc(id)
    .update({ data: { status: 'rejected', replyAt: now() } })
    .catch((e) => { console.error('[friendReject] update failed:', String((e && e.errMsg) || e)); });
  return { ok: true, rejected: true };
}

// 旧 action 保留：老版本前端还在调 respond，转发到上面两个实现，行为一致
async function respond(openid, payload) {
  payload = payload || {};
  return payload.action === 'accept'
    ? friendAccept(openid, payload)
    : friendReject(openid, payload);
}

/* ---------------- 解除好友 ---------------- */

// 解除好友关系：双向都撤，回到「陌生人」状态。任何一方都能单方面发起
// （不需要对方同意 —— 退出关系不该需要对方批准，拉黑也是这个道理）。
//
// 三件事必须一起做，少一件就会留下自相矛盾的状态：
//
//   ① 删 friends 表的**双向**记录 —— 关系本身的权威来源。
//      按 where 删而不是按定死的 _id 删：_id = a_b 是后来才统一的，
//      更早期写进去的记录 id 是随机的，只用 doc(a_b).remove() 会漏掉那些，
//      于是「解除了但名片页还显示是好友」。
//
//   ② 删 contacts 里这对人之间**所有方向、所有状态**的记录。
//      不删的话后果很具体：addRequest 会先查到一条 status:'accepted' 的老记录，
//      直接回「你们已经是好友啦」，于是两人解除之后**再也加不回来**，
//      而界面上给出的理由（已经是好友）和实际状态（已经不是了）正好对不上，
//      是那种最难排查的一类 bug。
//
//   ③ 在会话文档上盖一个 quotaResetAt —— 解除后回到非好友，双方各拿到新的 3 条额度。
//      不盖这个的话，chatQuota 会在长会话里数出成百条历史消息、把额度直接算成 0：
//      聊了半年的两个人一解除，双方立刻都说不了话（连「你怎么把我删了」都发不出去），
//      看着就像私信坏了。这条水位只影响额度计数，不动聊天记录。
//
// 聊天记录本身保留（和拉黑一致）：删掉记录并不能让对方忘掉说过的话，
// 反而会把自己这边的约定、地点、联系方式一并弄丢，也没法给举报留证据。
//
// 幂等：本来就不是好友时照样返回 ok —— 用户点第二次、或两台设备同时点，
// 结果都该是「已经不是好友了」，不该报错。
async function removeFriend(openid, payload) {
  payload = payload || {};
  const to = String(payload.toOpenid || payload.openid || '').trim();
  if (!to) return { ok: false, msg: '没有指定同学' };
  if (to === openid) return { ok: false, msg: '不能解除自己' };

  const [rmA, rmB] = await Promise.all([
    db.collection(COL_FRIENDS).where({ openid: openid, friend: to }).remove().catch(() => null),
    db.collection(COL_FRIENDS).where({ openid: to, friend: openid }).remove().catch(() => null)
  ]);
  // 两个方向都读不到结果 = 库根本连不上。这时候说「已解除」是骗人：
  // 对方那边可能还是好友，下次进来关系又冒出来了
  if (rmA === null && rmB === null) return { ok: false, msg: '解除失败，再试一次' };

  await Promise.all([
    db.collection(COL_CONTACTS).where({ fromOpenid: openid, toOpenid: to }).remove().catch(() => null),
    db.collection(COL_CONTACTS).where({ fromOpenid: to, toOpenid: openid }).remove().catch(() => null)
  ]);

  // ④ 往会话里留一条**系统消息**，并在会话上盖额度水位。
  //
  // 为什么非要留这条系统消息：解除之后两个人从彼此名单里消失、聊天记录还在，
  // 于是双方看到的都是「对话莫名其妙断了，而且我只能再发 3 条」。
  // 没有这条提示，最常见的结果是对方过两天发现发不出去，来问「你怎么把我删了」，
  // 而被问的那个人其实只是点错了。一条系统消息的成本极低，能省掉大量这种误会。
  //
  // 为什么不给双方各写一条「你已解除与 XX 的同学关系」：
  // 主动解除的那一方自己知道，他看到第二条只会觉得吵。
  const sys = {
    id: 'sys' + Date.now() + Math.floor(Math.random() * 1000),
    from: 'system',
    // from 不是任何一方的 openid，所以这条消息**不会被 chatQuota 计入任何一侧**
    // —— 系统消息不该吃掉用户的额度
    sys: true,
    text: '你们已解除同学关系，聊天记录保留，双方各自还能发送 ' + STRANGER_QUOTA + ' 条消息',
    time: now(),
    at: Date.now()
  };
  const cw = await db.collection(COL_CHATS).where({ key: chatKey(openid, to) }).limit(1)
    .get().catch(() => ({ data: [] }));
  const chat = cw.data && cw.data[0];
  if (chat) {
    await db.collection(COL_CHATS).doc(chat._id).update({
      data: {
        messages: db.command.push({ each: [sys], slice: -CHAT_KEEP }),
        rev: db.command.inc(1),
        quotaResetAt: Date.now(),
        updatedAt: Date.now(),
        lastAt: sys.at,
        lastText: sys.text,
        lastSys: true,
        // 解除之后这一对又回到「请求箱」的判定范围（见 chatList），
        // 所以两侧的接受标记都要清掉
        reqState: '',
        deletedBy: []
      }
    }).catch(() => {});
  }

  // 站内通知：解除是**发生在对方身上**的事件，他那边只有红点能发现
  await pushNotify(to, {
    type: 'unfriend',
    title: '有一位同学解除了与你的同学关系',
    body: '你们不再是同学，联系方式不再互相可见；聊天记录保留',
    page: 'pages/user/chats/chats'
  });

  return { ok: true, removed: true, friendDeleted: countRemoved(rmA) + countRemoved(rmB) };
}

// 云开发的 remove 回执是 { stats: { removed: n } }；拿不到就当 0，只用于回执统计
function countRemoved(r) {
  return (r && r.stats && Number(r.stats.removed)) || 0;
}

/* ---------------- 我的好友 ---------------- */

// 同学关系以 friends 表为准；老数据（accepted 的 contacts）合并进来去重，
// 保证升级之后不丢已有好友。
//
// 顺带修掉一个旧 bug：旧实现把两个方向的查询结果都 push 进同一个数组，
// 双向记录都在时同一个人会出现两次（好友列表里同一个人排两行）。
// 我的好友 id 集合（含升级前的 contacts 兼容数据），返回 { openid: true }。
// listFriends（同学列表）与 chatList（给陌生会话打标）共用这一份口径 ——
// 两处各写一套的话，迟早出现「同学列表里有他、私信里却标着还不是好友」
// 这种自相矛盾，而且用户不知道该信哪个。
// 一次拿齐「好友 id + 我这一侧的备注」。三张表并行查，避免
// friends → contacts A → contacts B 串行等待；listFriends 也不再重复查一次 friends。
async function friendSnapshot(openid) {
  const [f, a, b] = await Promise.all([
    db.collection(COL_FRIENDS).where({ openid: openid }).limit(FRIEND_MAX).get()
      .catch((e) => { console.error('[friendSnapshot] friends query failed:', String((e && e.errMsg) || e)); return { data: [] }; }),
    db.collection(COL_CONTACTS).where({ fromOpenid: openid, status: 'accepted' }).limit(100).get().catch(() => ({ data: [] })),
    db.collection(COL_CONTACTS).where({ toOpenid: openid, status: 'accepted' }).limit(100).get().catch(() => ({ data: [] }))
  ]);
  const set = {};
  const aliases = {};
  (f.data || []).forEach((r) => {
    if (!r.friend) return;
    set[r.friend] = true;
    if (r.alias) aliases[r.friend] = String(r.alias);
  });
  (a.data || []).forEach((r) => { if (r.toOpenid) set[r.toOpenid] = true; });
  (b.data || []).forEach((r) => { if (r.fromOpenid) set[r.fromOpenid] = true; });
  delete set[openid];
  return { set: set, aliases: aliases };
}

async function friendIdSet(openid) {
  return (await friendSnapshot(openid)).set;
}

// 一次最多回多少人。和 friendIdSet 的 limit(200) 对齐 ——
// 两处数字不一致时会出现「总数说有 200 个，翻了半天只有 100 个」的怪象
const FRIEND_MAX = 200;

async function listFriends(openid, payload) {
  payload = payload || {};
  const limit = Math.max(1, Math.min(FRIEND_MAX, Number(payload.limit) || FRIEND_MAX));
  const offset = Math.max(0, Number(payload.offset) || 0);

  const snap = await friendSnapshot(openid);
  const set = snap.set;
  const aliases = snap.aliases;
  const ids = Object.keys(set).filter((x) => x && x !== openid);
  const page = ids.slice(offset, offset + limit);

  // 批量查。以前是 for + doc(id).get()，一个好友一次往返 ——
  // 50 个好友就是 50 次网络往返，在云函数默认超时下必然 timeout，
  // 表现为「同学列表转圈然后空白」。改成 where(_id in [...]) 一次取回；
  // 单次 in 的上限是 100，所以分片。
  const users = {};
  for (let i = 0; i < page.length; i += 100) {
    const chunk = page.slice(i, i + 100);
    // eslint-disable-next-line no-await-in-loop
    const r = await db.collection(COL_USERS)
      .where({ _id: db.command.in(chunk) }).limit(100).get()
      .catch((e) => {
        console.error('[listFriends] batch query failed:', String((e && e.errMsg) || e));
        return { data: [] };
      });
    (r.data || []).forEach((u) => { users[u._id] = u; });
  }

  const list = [];
  page.forEach((id) => {
    // 没编辑过资料的好友也要出现在名单里：用默认名片，点进去仍能看主页/设备注。
    const u = users[id] || {
      openid: id, nickName: '浙小商', avatarUrl: '', college: '', motto: '', profileIncomplete: true
    };
    const prof = fullProfile(u);
    // users 文档的主键是 _id，文档里不一定有 openid 字段；不补这一行，
    // 列表点击时 dataset 里的 openid 是空串，就会误判成“没登记资料”。
    prof.openid = prof.openid || id;
    if (aliases[id]) {
      prof.alias = aliases[id];
      prof.nickName = aliases[id];
    }
    prof.avatarText = String(prof.nickName || '同').charAt(0);
    list.push(prof);
  });

  return {
    ok: true,
    list: list,
    total: ids.length,
    offset: offset,
    hasMore: offset + limit < ids.length
  };
}

/* ---------------- 拉黑 ---------------- */

// 拉黑某人后：TA 对我的请求直接被拒，我的名片也不再对 TA 显示联系方式
async function blockUser(openid, payload) {
  const target = String((payload && payload.toOpenid) || '');
  if (!target || target === openid) return { ok: false, msg: '参数不对' };

  await db.collection(COL_BLOCKS).doc(openid + '_' + target).set({
    data: { openid: openid, target: target, time: now() }
  }).catch(() => {});
  return { ok: true };
}

async function unblockUser(openid, payload) {
  const target = String((payload && payload.toOpenid) || '');
  if (!target) return { ok: false, msg: '参数不对' };
  await db.collection(COL_BLOCKS).doc(openid + '_' + target).remove().catch(() => {});
  return { ok: true };
}

async function listBlocks(openid) {
  const res = await db.collection(COL_BLOCKS)
    .where({ openid: openid }).limit(100).get().catch(() => ({ data: [] }));
  const list = [];
  for (const b of (res.data || [])) {
    const p = await db.collection(COL_USERS).doc(b.target).get().catch(() => null);
    if (p && p.data) list.push(publicProfile(p.data));
  }
  return { list };
}

/* ==========================================================================
   账号与数据（注销 / 匿名化）

   微信对「收集了用户信息的小程序」要求提供删除途径。这里给两条：
     ① 「注销账号」—— 7 天冷静期，到期把个人信息匿名化；
     ② 冷静期内随时可撤销（误点很常见，不给撤销等于把注销做成一次性按钮）。

   为什么是**匿名化**而不是把内容一起抽走：
     论坛的历史讨论是一串互相咬合的对话，把一个人的帖子和评论整个拔掉，
     剩下的回复就失去了上下文（「楼上说得对」指向空气）。
     所以按「承载不承载公共讨论」分成两类：
       内容型（帖子 / 评论 / 活动）        → 保留，作者换成匿名代号
       私人与关系型（资料 / 私信 / 好友 / 拉黑 / 申请 / 收藏 / 备忘 /
                     二手闲置 / 报名 / 投票 / 捞瓶记录）
                                        → 真删。这些不承载公共讨论，
                                          留着反而是「死人在占位」
     二手闲置也删而不是匿名：它是**交易信息**，作者联系不上的挂单
     只会让买家反复碰壁，匿名保留对它没有任何好处。

   为什么留 7 天：注销入口藏在「我的」页里，属于最容易误触的那一类，
   而反悔成本极高（好友、聊天记录一次性全没）。7 天足够覆盖手滑与冷静。
   ========================================================================== */

const CANCEL_DAYS = 7;
const CANCEL_MS = CANCEL_DAYS * 24 * 60 * 60 * 1000;

// 匿名代号：同一个 openid 永远映射到同一个名字（对 openid 做稳定散列）。
// 用随机数的话，「已注销用户」在同一个帖子下面每换一页就换一个名字，
// 论坛的对话关系会彻底散架；稳定映射至少保住了「这是同一个人」的可读性。
//
// 刻意不用 openid 的前几位当代号：openid 是身份标识，把它的一部分贴到
// 公开页面上去，等于给了别人一条跨小程序追踪同一个人的线索。
function anonName(openid) {
  const s = String(openid || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) % 100000;
  }
  return '已注销用户' + String(h < 0 ? h + 100000 : h).padStart(5, '0');
}

// 查注销状态：页面据此显示「已提交，N 天后生效」与「撤销注销」
async function accountState(openid) {
  const res = await db.collection(COL_ACCOUNT_REQS).doc(openid).get().catch(() => null);
  const r = res && res.data && !Array.isArray(res.data) ? res.data : null;
  if (!r) return { ok: true, pending: false };
  const due = Number(r.dueAt) || 0;
  return {
    ok: true,
    pending: true,
    requestedAt: Number(r.requestedAt) || 0,
    dueAt: due,
    dueText: fmtStamp(due),
    // 向上取整：还剩 3 小时时显示「1 天」比「0 天」诚实 —— 后者看着像已经生效了
    leftDays: Math.max(0, Math.ceil((due - Date.now()) / (24 * 3600 * 1000)))
  };
}

async function accountCancel(openid, payload) {
  payload = payload || {};
  // 二次确认前端已经做过一遍；这里再要一个显式的 confirm，
  // 是为了将来有人从别的入口误调这个 action 时也拦得住
  if (payload.confirm !== true) return { ok: false, msg: '需要明确确认后才能注销' };

  const at = Date.now();
  const prev = await db.collection(COL_ACCOUNT_REQS).doc(openid).get().catch(() => null);
  if (prev && prev.data && !Array.isArray(prev.data) && Number(prev.data.dueAt) > at) {
    // 重复提交：按幂等处理，把原来那个到期时间原样告诉他
    return { ok: true, already: true, dueAt: Number(prev.data.dueAt) };
  }

  const due = at + CANCEL_MS;
  await db.collection(COL_ACCOUNT_REQS).doc(openid).set({
    data: {
      openid: openid,
      requestedAt: at,
      dueAt: due,
      reason: String(payload.reason || '').slice(0, 100)
    }
  }).catch(() => {});

  // 回写后必须回读确认。写失败却提示「已提交」，用户 7 天后回来发现号还在，
  // 那时冷静期已经过了、也无从查起 —— 这种「说了却没做」比直接报错糟糕得多
  const back = await db.collection(COL_ACCOUNT_REQS).doc(openid).get().catch(() => null);
  if (!back || !back.data) return { ok: false, msg: '提交失败，请稍后再试' };
  logMod(openid, 'accountCancel', 'user', openid, '注销申请');
  return { ok: true, requested: true, dueAt: due, leftDays: CANCEL_DAYS };
}

async function accountCancelUndo(openid) {
  await db.collection(COL_ACCOUNT_REQS).doc(openid).remove().catch(() => {});
  const back = await db.collection(COL_ACCOUNT_REQS).doc(openid).get().catch(() => null);
  // 读得到 = 没删掉。不能只说「已撤销」就完事
  if (back && back.data) return { ok: false, msg: '取消失败，请再试一次' };
  logMod(openid, 'accountCancelUndo', 'user', openid, '撤销注销');
  return { ok: true, undone: true };
}

// 真正执行。顺序有讲究：先把「我」之外的东西摘干净，再改资料，最后处理内容署名。
// 反过来做的话，中途失败会留下「资料已经匿名、好友关系还在」这种中间态 ——
// 那是最难解释的一种现象（用户看到的是一个不存在的账号还挂在他的同学列表里）。
async function accountPurge(openid, byMod) {
  const uid = String(openid || '');
  if (!uid) return { ok: false, msg: '没有指定账号' };
  const name = anonName(uid);
  const done = {};

  // 云数据库单次查询最多 100 条；注销必须分页清干净，不能只删第一页。
  const rmAll = async (key, col, where) => {
    let total = 0;
    for (let page = 0; page < 100; page += 1) {
      const got = await db.collection(col).where(where).limit(100).get().catch(() => null);
      if (!got || !Array.isArray(got.data) || !got.data.length) break;
      const r = await db.collection(col).where(where).remove().catch(() => null);
      total += countRemoved(r);
      if (got.data.length < 100) break;
    }
    done[key] = total;
  };
  const rmList = [
    ['friendsOut', COL_FRIENDS, { openid: uid }],
    ['friendsIn', COL_FRIENDS, { friend: uid }],
    ['contactsOut', COL_CONTACTS, { fromOpenid: uid }],
    ['contactsIn', COL_CONTACTS, { toOpenid: uid }],
    ['blocksOut', COL_BLOCKS, { openid: uid }],
    ['blocksIn', COL_BLOCKS, { target: uid }],
    ['chatsA', COL_CHATS, { a: uid }],
    ['chatsB', COL_CHATS, { b: uid }],
    ['memos', COL_MEMOS, { openid: uid }],
    ['bottleLogs', COL_BOTTLE_LOGS, { openid: uid }],
    ['eventJoins', COL_EVENT_JOINS, { openid: uid }],
    ['votes', COL_VOTES, { openid: uid }],
    ['reacts', COL_REACTS, { openid: uid }],
    ['commentVotes', COL_COMMENT_VOTES, { openid: uid }],
    ['views', COL_VIEWS, { openid: uid }],
    ['notifications', COL_NOTIFIES, { openid: uid }],
    ['drafts', COL_DRAFTS, { openid: uid }],
    ['mediaAudit', COL_MEDIA, { openid: uid }],
    ['protects', COL_PROTECTS, { by: uid }]
  ];
  for (const [key, col, where] of rmList) {
    // eslint-disable-next-line no-await-in-loop
    await rmAll(key, col, where);
  }

  await db.collection(COL_FAVS).doc(uid).remove().catch(() => {});

  // 二手闲置 / 学习资料可能超过 100 条：先分页收集文件，再分页删元数据。
  const mkFiles = [];
  const ownRec = await db.collection(COL_USERS).doc(uid).get().catch(() => null);
  if (ownRec && ownRec.data && ownRec.data.avatarUrl) mkFiles.push(ownRec.data.avatarUrl);
  for (let page = 0; page < 100; page += 1) {
    const got = await db.collection(COL_MARKET).where({ openid: uid }).skip(page * 100).limit(100).get().catch(() => null);
    if (!got || !Array.isArray(got.data) || !got.data.length) break;
    got.data.forEach((m) => (m.images || []).slice(0, 6).forEach((f) => mkFiles.push(f)));
    if (got.data.length < 100) break;
  }
  await rmAll('market', COL_MARKET, { openid: uid });

  for (let page = 0; page < 100; page += 1) {
    const got = await db.collection(COL_RESOURCES).where({ openid: uid }).skip(page * 100).limit(100).get().catch(() => null);
    if (!got || !Array.isArray(got.data) || !got.data.length) break;
    got.data.forEach((r) => { if (r.fileID) mkFiles.push(r.fileID); });
    if (got.data.length < 100) break;
  }
  await rmAll('resources', COL_RESOURCES, { openid: uid });

  // 云文件一次最多删 50 个，按批次删完，不能只删第一批。
  for (let i = 0; i < mkFiles.length; i += 50) {
    // eslint-disable-next-line no-await-in-loop
    await cloud.deleteFile({ fileList: mkFiles.slice(i, i + 50) })
      .catch((e) => { console.error('[accountPurge] deleteFile failed:', String((e && e.errMsg) || e)); });
  }

  // 内容署名匿名化：帖子 / 评价 / 活动
  const scrub = { author: name, avatarUrl: '', authorAnon: true };
  const updWhere = async (key, col, where, data) => {
    const r = await db.collection(col).where(where).update({ data: data }).catch(() => null);
    done[key] = (r && r.stats && Number(r.stats.updated)) || 0;
  };
  await updWhere('posts', COL_POSTS, { authorOpenid: uid }, scrub);
  await updWhere('postsLegacy', COL_POSTS, { openid: uid }, { author: name, avatarUrl: '', authorAnon: true });
  await updWhere('events', COL_EVENTS, { authorOpenid: uid }, scrub);
  await updWhere('reviews', COL_REVIEWS, { openid: uid }, { author: name, authorAnon: true });

  // 留言的匿名化：拆表之后一条 where 就够 ——
  // 以前嵌在帖子的数组里，只能逐帖读出来改再整份写回（还分了 10 页上限），
  // 现在既不用担心超时，也不会把别人同时发的留言覆盖掉
  await updWhere('comments', COL_POST_COMMENTS, { authorOpenid: uid }, scrub);
  // 举报记录是审核证据，但举报人身份要脱敏；内容和处置结果继续保留。
  await updWhere('reports', COL_REPORTS, { openid: uid }, { openid: 'deleted', detail: '' });

  // 资料本身：清空所有能识别到人的字段，只留一个匿名代号。
  // 文档保留（不是删除）—— 帖子上的 authorOpenid 还指着这里，删了就成了悬空引用
  await db.collection(COL_USERS).doc(uid).set({
    data: {
      nickName: name,
      avatarUrl: '',
      college: '',
      motto: '',
      contactType: '',
      contactValue: '',
      banned: false,
      bannedReason: '',
      deleted: true,
      deletedAt: Date.now(),
      updatedAt: now()
    }
  }).catch(() => {});

  // 最后才清掉申请单：它一没，注销状态就结束了
  await db.collection(COL_ACCOUNT_REQS).doc(uid).remove().catch(() => {});

  logMod(byMod || uid, 'accountPurge', 'user', uid, '匿名化执行 ' + JSON.stringify(done).slice(0, 160));
  return { ok: true, purged: true, anonName: name, counts: done };
}

// 定时兜底：把到期且没被撤销的注销申请执行掉。
// 为什么不靠用户「再登录一次触发」：注销的语义是「我不想再来了」，
// 让一个已经离开的人回来点一下才算数，等于把注销做成了空承诺。
async function runAccountPurge() {
  const res = await db.collection(COL_ACCOUNT_REQS).limit(20).get().catch(() => ({ data: [] }));
  const rows = res.data || [];
  const due = rows.filter((r) => Number(r.dueAt) > 0 && Number(r.dueAt) <= Date.now());
  const out = [];
  for (const r of due) {
    // eslint-disable-next-line no-await-in-loop
    const one = await accountPurge(r.openid, r.openid).catch((e) => ({ ok: false, msg: String(e) }));
    out.push({ openid: r._id, ok: !!one.ok });
  }
  return { pending: rows.length - due.length, purged: out.length, detail: out };
}

/* ---------------- 举报 ---------------- */

const REPORT_REASONS = ['广告骚扰', '不文明用语', '虚假信息', '涉及隐私', '违规交易', '恶意骚扰', '冒充他人', '其他'];
// 举报「人」而不是举报「内容」时的合法理由：拉黑之外的第二条路。
// 这两类只对 chat / profile 有意义，对帖子没有意义
const PERSON_REASONS = ['恶意骚扰', '冒充他人', '广告骚扰', '涉及隐私'];
// 同一账号被不同的人举报到这么多条 → 标记 escalated，进审核队列时排在最前。
// 只升优先级、**不自动封号**：举报是主观的，账号级自动处置的误伤面太大
const PERSON_REPORT_THRESHOLD = 3;

// 按业务字段 id 定位文档。
// 注意：云开发 add 时不会自动把业务字段 id 当成 _id，所以很多地方用 doc(id) 会打空。
// 统一走 where({id}) 更稳：查、改、删一条路。
function byId(col, id) {
  return db.collection(col).where({ id: String(id || '') });
}

// 举报 / 处置链路的 targetType 归一。
// 集中在一处：这几个值散落在 report / setStatus / delContent / fetchTarget 里，
// 每加一种内容（留言、闲置、活动）都要在四五个地方各补一支，
// 漏一处就会出现「举报落库了、处置写成帖子集合」这种最难查的错。
// comment 不走这里（留言有自己的一套：软删 + 申诉），match 到它原样返回。
const CONTENT_TYPES = ['post', 'review', 'market', 'event', 'comment', 'resource'];
function normTargetType(t) {
  const s = String(t || '');
  return CONTENT_TYPES.indexOf(s) >= 0 ? s : 'post';
}

// 按 id 取一条内容（帖子 / 评价 / 留言 / 闲置 / 活动共用）
async function fetchTarget(targetType, targetId) {
  if (!targetId) return null;
  // 留言在独立集合里（拆表之后帖子文档不再带 comments）。
  // 以前这里只认 review / post，留言类举报在队列里一律显示「内容已不存在」——
  // 审核员点开一条「广告留言」的举报，看到的只有这四个字，判不了
  if (targetType === 'comment') {
    const got = await db.collection(COL_POST_COMMENTS).doc(String(targetId)).get().catch(() => null);
    const c = got && got.data && !Array.isArray(got.data) ? got.data : null;
    if (!c) return null;
    const prec = await byId(COL_POSTS, String(c.postId || '')).limit(1).get().catch(() => ({ data: [] }));
    const post = prec.data && prec.data[0];
    // 形状对齐帖子：队列那段渲染是通用的（title / content / images / status）
    return Object.assign({}, c, {
      title: (post && post.title) || '留言',
      board: (post && post.board) || '',
      status: c.removed ? 'deleted' : 'normal'
    });
  }
  // 闲置（失物招领 / 二手）也是全校可见的内容，同样会被举报。
  // 它的字段和帖子不一样：正文叫 desc、状态叫 status（open / done，跟处置无关）、
  // 下架标记是 hidden。在这里归一成下游认的形状（title / content / status），
  // 免得判定引擎、审核队列、处置三条链路各写一套 if。
  if (targetType === 'resource') {
    const res = await byId(COL_RESOURCES, targetId).limit(1).get().catch(() => ({ data: [] }));
    const r = res.data && res.data[0];
    if (!r) return null;
    const deleted = !!r.deleted || r.status === 'deleted';
    const hidden = !!r.hidden || r.status === 'hidden';
    return Object.assign({}, r, {
      title: String(r.title || ''),
      content: String(r.desc || ''),
      board: '学习资料',
      status: deleted ? 'deleted' : (hidden ? 'hidden' : 'normal')
    });
  }
  if (targetType === 'market') {
    const res = await byId(COL_MARKET, targetId).limit(1).get().catch(() => ({ data: [] }));
    const m = res.data && res.data[0];
    if (!m) return null;
    return Object.assign({}, m, {
      title: String(m.title || ''),
      content: String(m.desc || ''),
      // 归到「失物招领」这个可留联系方式的板块：二手交易本来就要留电话 / 微信，
      // 不这么映的话，一条正常闲置只要被举报「广告骚扰」就会命中屏蔽词表里的
      // 「加微信」，白白多出一条误判证据
      board: '失物招领',
      status: m.deleted ? 'deleted' : (m.hidden ? 'hidden' : 'normal')
    });
  }
  // 活动：只有同学发起的才可能被举报（官网内容由学校发布，不归社区自治）。
  // 字段同样归一成 title / content / status，下游三条链路不必各写一套
  if (targetType === 'event') {
    const res = await byId(COL_EVENTS, targetId).limit(1).get().catch(() => ({ data: [] }));
    const e = res.data && res.data[0];
    if (!e) return null;
    return Object.assign({}, e, {
      title: String(e.title || ''),
      content: String(e.desc || ''),
      // 活动和「活动组队」是同一个性质：留群号 / 联系方式是正常内容，
      // 不该因为写了「加微信」就被算成广告证据
      board: '活动组队',
      status: e.deleted ? 'deleted' : (e.hidden ? 'hidden' : 'normal')
    });
  }
  const col = targetType === 'review' ? COL_REVIEWS : COL_POSTS;
  const res = await byId(col, targetId).limit(1).get().catch(() => ({ data: [] }));
  return (res.data && res.data[0]) || null;
}

// 内容下架 / 恢复：下架不是删除，内容还在库里，随时能恢复
async function setContentStatus(targetType, targetId, status, reason) {
  if (!targetId) return;
  if (targetType === 'comment') {
    // 留言只有「在 / 不在」两档（没有下架这个中间态），
    // 所以 hidden / deleted 都映射成 removed，其余映射成恢复
    const got = await db.collection(COL_POST_COMMENTS).doc(String(targetId)).get().catch(() => null);
    const c = got && got.data && !Array.isArray(got.data) ? got.data : null;
    if (!c) return;
    const gone = status === 'hidden' || status === 'deleted';
    const was = !!c.removed;
    await db.collection(COL_POST_COMMENTS).doc(String(targetId)).update({
      data: gone
        ? { removed: true, removedAt: Date.now(), removedBy: 'mod', removedReason: String(reason || '审核员处理').slice(0, 40), appealable: true }
        : { removed: false, restoredAt: Date.now(), appealable: false }
    }).catch(() => null);
    if (gone !== was) {
      await db.collection(COL_POSTS).where({ id: String(c.postId || '') })
        .update({ data: { commentCount: db.command.inc(gone ? -1 : 1) } }).catch(() => null);
    }
    return;
  }
  if (targetType === 'resource') {
    const gone = status === 'hidden' || status === 'deleted';
    const data = gone
      ? { status: status === 'deleted' ? 'deleted' : 'hidden', hidden: true, deleted: status === 'deleted', hiddenReason: String(reason || ''), hiddenAt: now() }
      : { status: 'normal', hidden: false, deleted: false, hiddenReason: '', hiddenAt: '' };
    const w = await byId(COL_RESOURCES, targetId).update({ data: data }).catch((e) => ({ err: e }));
    if (w && w.err) return false;
    return !!(w && w.stats && w.stats.updated > 0);
  }
  // 闲置用 hidden 而不是 status：status 在闲置里表示 open / done（交易状态），
  // 拿它当处置标记会把「已解决」和「被下架」混成同一个值
  if (targetType === 'market' || targetType === 'event') {
    const col = targetType === 'market' ? COL_MARKET : COL_EVENTS;
    const gone = status === 'hidden' || status === 'deleted';
    await byId(col, targetId).update({
      data: {
        hidden: gone,
        hiddenReason: gone ? String(reason || '') : '',
        hiddenAt: gone ? now() : ''
      }
    }).catch(() => {});
    return;
  }
  const col = targetType === 'review' ? COL_REVIEWS : COL_POSTS;
  const w = await byId(col, targetId).update({
    data: { status: status, hiddenReason: reason || '', hiddenAt: now() }
  }).catch((e) => ({ err: e }));
  // 返回值 =「真的改到了」。
  // update 在没有匹配记录时**不报错**，只在 stats.updated 里给个 0 ——
  // 不看这一位，批量下架就会把没改动的记录也算成成功，
  // 投诉处理的台账当场变成假的（真出事时这是最要命的一类错）
  if (w && w.err) return false;
  return !!(w && w.stats && w.stats.updated > 0);
}

// 审核确认违规后的真删除（下架可逆，删除不可逆，只在人工确认那一刀用）
async function removeContent(targetType, targetId) {
  if (!targetId) return;
  if (targetType === 'resource') {
    await byId(COL_RESOURCES, targetId).update({
      data: { status: 'deleted', hidden: true, deleted: true, hiddenReason: '审核员确认违规', hiddenAt: now() }
    }).catch(() => {});
    return;
  }
  if (targetType === 'market' || targetType === 'event') {
    // 和帖子不同，这里也不物理删：客户端缓存里那一条在下次拉取时
    // 会作为「本地独有」被合并回来，删库反而会让「云端已删、别人手机还看得见」。
    // 打标记，靠列表过滤
    const col = targetType === 'market' ? COL_MARKET : COL_EVENTS;
    await byId(col, targetId).update({
      data: { hidden: true, deleted: true, hiddenReason: '审核员确认违规', hiddenAt: now() }
    }).catch(() => {});
    return;
  }
  if (targetType === 'comment') {
    // 留言不物理删：申诉要能核对原文（见 softRemoveCommentTree）
    const got = await db.collection(COL_POST_COMMENTS).doc(String(targetId)).get().catch(() => null);
    const c = got && got.data && !Array.isArray(got.data) ? got.data : null;
    if (!c || !c.postId) return;
    await softRemoveCommentTree(String(c.postId), String(targetId), {
      by: 'mod', reason: '审核员确认违规', appealable: true
    });
    return;
  }
  const col = targetType === 'review' ? COL_REVIEWS : COL_POSTS;
  await byId(col, targetId).remove().catch(() => {});
}

// 举报落库时同时写一个时间戳字段：云开发里字符串时间没法直接比较大小，
// 做「24 小时内的举报数」统计必须靠数值字段。
// ⚠️ reports 集合没建时 add 会失败，这里必须把失败抛出去 —— 之前静默吞掉的话，
//    举报看起来「提交成功」实则一条没存，阈值永远算不出来，整个判定形同虚设。
async function addReportDoc(doc) {
  const r = await db.collection(COL_REPORTS).add({ data: doc });
  // 返回新文档 id：留言申诉、审核日志要靠它回指这一条。拿不到 id 也不至于失败
  return String((r && (r._id || r.id)) || '');
}

// 举报人的「反滥用」状态：是不是正在观察期。
//
// 旧版本这个名字叫 rejectedCount，数的是「历史被驳回的总数」，没有窗口、没有上限，
// 驳回满 3 次就永久作废。两个问题：惩罚太重（最热心的人最容易被误伤），
// 而且没有出路。现在换成按时间窗口判定，误报会过去，准报能抵消。
//
// 返回：
//   limited —— 是否正在观察期（观察期内举报照样记录、照样进人工队列，
//              只是不计入自动处置的票数，系统不会自己动手）
//   until   —— 观察期解除的时间戳；已经过去的返回 0
//   eased   —— 是提前放出来的（不是满刑期）
//   count   —— 窗口内被驳回的次数（仅用于展示）
async function abuseState(openid) {
  // 云函数端单次 get 默认 100、上限 1000，写 200 是合法的。
  // 但观察期判定是「数窗口内的驳回次数」，真的搬不完时应当能看出来，
  // 所以这里只取最近 200 条，不追求全量
  const res = await db.collection(COL_REPORTS)
    .where({ openid: openid }).limit(200).get().catch(() => ({ data: [] }));
  const all = (res && res.data) || [];

  // 时间戳兜底：老数据可能没有 at 字段，退回去解析 time 字符串
  const atOf = (r) => {
    const n = Number(r && r.at);
    if (n) return n;
    const t = Date.parse(String((r && r.time) || '').replace(/-/g, '/'));
    return t || 0;
  };
  const since = Date.now() - MOD_RULES.ABUSER_WINDOW_D * 86400 * 1000;

  // 出站通道：有一条举报被审核员判「违规成立」，说明这个人的判断是被认可的，
  // 观察期当场解除（不用等满刑期）
  const good = all.filter((r) => r.status === 'confirmed' && atOf(r) >= since);
  if (good.length) {
    return { count: 0, confirmed: good.length, limited: false, until: 0, eased: true };
  }

  // 入站通道：只看最近的驳回，更早的账一笔钩销。
  // 'reject'（单数）也认：resolveReports 以前把驳回写成了那个值，老数据里已经存着了
  const hit = all
    .filter((r) => (r.status === 'rejected' || r.status === 'reject') && atOf(r) >= since)
    .map(atOf);
  if (hit.length < MOD_RULES.ABUSER_LIMIT) {
    return { count: hit.length, confirmed: 0, limited: false, until: 0, eased: false };
  }

  const earliest = Math.min.apply(null, hit);
  const latest = Math.max.apply(null, hit);
  const until = earliest + MOD_RULES.OBSERVE_H * 3600 * 1000;
  // 观察期内只要又熬满 OBSERVE_GRACE_H 没有新的驳回，就提前放出来。
  // 最热心那批人常常一天连报好几条，全被驳回之后如果还要按满刑期关着，
  // 下一次他就不会再认真看了
  if (Date.now() - latest >= MOD_RULES.OBSERVE_GRACE_H * 3600 * 1000) {
    return { count: hit.length, confirmed: 0, limited: false, until: 0, eased: true };
  }
  return {
    count: hit.length, confirmed: 0,
    limited: Date.now() < until, until: until, eased: false
  };
}

// 某个被举报人 24 小时内的举报总数
async function recentReportsCount(target) {
  const since = Date.now() - MOD_RULES.AUTHOR_WINDOW_H * 3600 * 1000;
  const res = await db.collection(COL_REPORTS)
    .where({ target: target, at: db.command.gte(since) })
    .count().catch(() => null);
  return (res && res.total) || 0;
}

// 同一条内容 24 小时内的举报详情。
// 判「要不要直接删」得看具体原因：高敏原因（广告/隐私/违规交易）危害性明确，
// 两个人指出来就够了；一般原因（不文明用语之类）主观性强，得人数更多才敢删。
async function recentReports(targetId) {
  const since = Date.now() - MOD_RULES.AUTHOR_WINDOW_H * 3600 * 1000;
  const res = await db.collection(COL_REPORTS)
    .where({ targetId: String(targetId || ''), at: db.command.gte(since) })
    .limit(50).get().catch(() => ({ data: [] }));
  return res.data || [];
}

// 一条内容被多少个**人**看过（去重、不含作者本人）。
//
// 这是举报门槛的分母。三件事决定了它的口径：
//   ① 去重（COL_VIEWS 的 _id 里带 openid）—— 分母要的是「几个人看过」，
//      不是「被打开几次」。按次数算的话，作者自己刷新十次就能把门槛抬高；
//   ② 排除作者 —— 他本来就会反复打开自己的帖子（看回复、看点赞），
//      把自己算进观众等于自己稀释自己该承担的比例；
//   ③ 读不到就当 0 —— 老内容没有浏览记录、集合还没建、count 失败都走这条路。
//      0 对应最低档 3 人，也就是改造前的原始门槛：宁可临时按老规矩办，
//      也别因为读不到浏览量就把门槛抬高（那会让举报的人点完什么都没发生）。
async function countViews(targetType, targetId, authorOpenid) {
  const where = { targetType: String(targetType), targetId: String(targetId || '') };
  const who = String(authorOpenid || '');
  if (who) where.openid = db.command.neq(who);
  const res = await db.collection(COL_VIEWS).where(where).count().catch(() => null);
  return (res && Number(res.total)) || 0;
}

// 详情页打开一次，记一次浏览。同一个人的重复打开只算一次（_id 天然去重）。
//
// 为什么不让客户端直接改计数：客户端能改就能刷。浏览量是下架门槛的分母，
// 谁能随便加分母，谁就能让自己的帖子永远达不到下架线。
// 所以「记一次浏览」必须是一个云函数动作，openid 由服务端从上下文取。
async function contentView(openid, payload) {
  payload = payload || {};
  const targetType = normTargetType(payload.targetType);
  const targetId = String(payload.targetId || '');
  // 留言没有独立的详情页，它跟着帖子一起被看到 —— 帖子浏览量就是它的曝光量
  if (!targetId || targetId.length > 40 || targetType === 'comment') {
    return { ok: true, views: 0, counted: false };
  }
  const key = (targetType + '_' + targetId + '_' + String(openid || '')).slice(0, 120);
  let counted = false;
  try {
    // 指定 _id：同一个人第二次打开会撞上主键，天然不会重复计数，
    // 也省掉「先查有没有、再决定写不写」那次往返（两个人同时打开也不会写重）
    await db.collection(COL_VIEWS).add({
      data: {
        _id: key,
        targetType: targetType,
        targetId: targetId,
        openid: String(openid || ''),
        at: Date.now()
      }
    });
    counted = true;
  } catch (e) {
    // 撞主键 = 这个人看过了。不是错误
  }
  // 数人数时排除作者本人 —— 跟下架门槛用的是同一个口径（countViews 的②）。
  //
  // 为此要多查一次内容本身，因为作者 openid 只在内容文档上，浏览记录里没有。
  // 这一次查询是为了修一个很具体的难看：作者打开自己刚发的帖，写进去一条记录，
  // 数出来 1，页面显示「1 人看过」—— 那个 1 就是他自己。
  // 冷启动期最容易被这句话打退的正是刚发完帖的作者。
  const content = await fetchTarget(targetType, targetId);
  const author = String((content && (content.openid || content.authorOpenid)) || '');
  const views = await countViews(targetType, targetId, author);
  return { ok: true, views: views, counted: counted };
}

// 判定处置动作。
//   'hide' —— 人数够了，把内容收起来等人工确认（**唯一的自动处置动作**）
//   ''     —— 只记录，不动内容
//
// ⚠️ 这里永远不会返回 'delete'：删除不可逆，而被误删的原文正是作者申诉、
// 同学举证、撤回投诉时唯一拿得出的凭据，删错一次就是永久性的证据灭失。
// 删不删由审核员看过之后定。
// excludeOpenid —— 观察期里的那个人。他的票照样记在库里、照样进人工队列，
//   但这条内容判「要不要自动动手」时不算他那一票，交给审核员自己看
async function decideAction(targetType, targetId, target, reason, detail, excludeOpenid) {
  const content = await fetchTarget(targetType, targetId);
  if (!content) return { action: '', content: null, hit: [] };

  // 「这条内容是不是被运营护着的」。护着 ≠ 举报作废：
  // 举报照样落库、照样进人工队列，只是系统自己不动手。
  //
  // 这条只挡「举报触发的自动处置」，**挡不住人工审核**，也挡不住图片审核回调
  // （那条是平台合规要求，护着也必须下）。保护要防的是「几个号凑人数把好内容打掉」，
  // 不是让违规内容免检。
  const guarded = await isProtected(targetType, targetId);
  // 把 hide 降级成「只记录」。保护防的是「几个号凑人数把好内容打掉」，
  // 不是让违规内容免检 —— 人工审核和图片审核回调都不受它影响
  const cap = (a) => (guarded && a === 'hide' ? '' : a);

  const text = String(content.title || '') + ' ' + String(content.content || '');
  // 命中判定也按板块：社团同好里的「加微信」是正常内容，不该记成违规证据
  const hit = checkTextInBoard(
    content.board, String(content.title || ''), String(content.content || '')
  ).hit || [];
  const highRisk = MOD_RULES.HIGH_RISK.indexOf(reason) >= 0;
  // 内容维度的举报数：这条内容自己被多少个**人**举报。
  // 早先这里数的是「这个作者被举报的总数」—— 结果是作者发十条、九条清白，
  // 只因为另一条被举报过，这条就跟着达到阈值被删掉，属于误伤
  //
  // 现在再往前一步：**数人头，不数记录条数**（见 report-votes.js 的 countVoices）。
  // 以前同一个人换 8 种理由能投 8 次，3 票下架 / 5 票删除这两档等于一个人就能推平，
  // 「三个人都说不行」实际是「一个人点三次」—— 阈值形同虚设。
  const reports = await recentReports(targetId);
  const voices = countVoices(reports, excludeOpenid, MOD_RULES.HIGH_RISK);
  const total = voices.total;
  const risky = voices.risky;
  // 分母：这条内容被多少个**人**看过（去重、不含作者本人）。
  // 门槛按这个数分档 —— 8 个人看过被 3 人举报，和 800 个人看过被 3 人举报，
  // 是完全不同的两件事：前者该管，后者多半只是三个人看不顺眼。
  // 分档表在 report-rules.js（纯函数，边界有测试）
  const views = await countViews(targetType, targetId, content.openid);
  const need = hideNeed(views);
  const blocked = hit.length > 0;

  // 只有一条判定：人数够了就收起来，等人工确认。
  //
  // 高敏理由**不再降低门槛**：原来「2 人 + 证据就能删」，等于给两个号合谋
  // 留了一条删任何帖子的路，而「广告骚扰」这类理由本身最主观。
  // 现在高敏只影响举报在队列里的排序（审核员先看哪一条）。
  //
  // 也没有 throttle：原规则要 5 人举报同一作者，而 3 人就已经把内容藏起来了，
  // 那条分支从来没走到过 —— 留着只会让人以为限流在起作用。
  let action = '';
  // 命中屏蔽词属于高置信违规，单个举报也可以先做可恢复的下架；
  // 普通理由仍必须达到按浏览量计算的人数门槛。
  if (total >= need || (blocked && total >= 1)) action = 'hide';

  return {
    action: cap(action), content, hit, total, highRisk, guarded: !!guarded, rawAction: action,
    reports: total, risky, views, need, blocked,
    detail: detail || ''
  };
}

// 举报：落库的同时当场决定处置动作，不等人工。
// 设计原则：绝大多数举报在这层就被消化掉，只有「系统拿不准」的那部分才进人工队列。
async function report(openid, payload) {
  payload = payload || {};

  // 举报「人」与举报「内容」是两条不同的处置链路，在这里分岔：
  //   内容 → decideAction 那套多票阈值，可能自动下架 / 删除
  //   人   → 只累计、只升级优先级，**永不自动封号**（见 reportPerson 的说明）
  // 之前私信与名片页一处举报入口都没有，被骚扰的人只有「拉黑」这条事后手段，
  // 而拉黑只挡得住那一个人，换个小号照样来 —— 这是最需要补上的一条。
  if (payload.targetType === 'chat' || payload.targetType === 'profile') {
    return reportPerson(openid, payload);
  }

  const targetId = String(payload.targetId || '');
  const targetType = normTargetType(payload.targetType);
  const rawReason = String(payload.reason || '');
  const reason = REPORT_REASONS.indexOf(rawReason) >= 0 ? rawReason : '其他';
  const detail = String(payload.detail || '').slice(0, 100);

  // ① 作者一律由服务端按内容认定，不信客户端报上来的 targetOpenid。
  //
  //    正着看：匿名评价的 openid 一样在库里（匿名只改前端显示，见 reviewAdd）。
  //    采信前端那句「匿名的没法定位作者」的话，最该能被举报的那一类内容
  //    —— 骂老师的恰恰几乎都是匿名发的 —— 反而一条都举报不了。
  //
  //    反过来看更要命：targetOpenid 是客户端随手填的，采信它就能把账记到别人头上，
  //    攒够人数还能让别人的内容被自动下架，被冤的人还得自证「不是我发的」。
  //
  //    内容已经被删干净、按 id 查不到时，才退回客户端给的那个 ——
  //    不这么做，「内容被自动删除之后同学再补一票」那条路就断了。
  const doc = await fetchTarget(targetType, targetId);
  const target = String((doc && doc.openid) || payload.targetOpenid || '');
  if (!target) return { ok: false, msg: '没被举报的对象' };
  const guarded = await isProtected(targetType, targetId);

  // ② 反滥用：正在观察期的同学（最近被驳回太多），举报照样记录、照样进人工队列，
  //    只是这一票不计入自动处置 —— 系统不自己动手，留给审核员看
  const ab = await abuseState(openid);

  // ③ 查重：一个人对同一条内容**只算一票**。
  //
  //    旧版查重键里带着 reason，而理由有 8 种 —— 同一个人换 3 个理由就能独自
  //    把任何内容推过下架线（正式 3 票 / 冷启动 2 票），换 5 个理由就能触发
  //    直接删除。也就是说「三个人都说不行」实际是「一个人点几次」，
  //    而整套自动处置的正当性全在这句「三个人」上。理由只该影响「法官怎么判」，
  //    不该影响「有几个证人」。
  //
  //    换理由时改掉原来那一票，不新增一条；**at 不动** —— 动了等于每次换理由
  //    都把 24 小时窗口重新计时，等于给了「每天重新开始攒票」的口子。
  const dupRes = await db.collection(COL_REPORTS)
    .where({ openid: openid, targetId: targetId })
    .limit(1).get().catch(() => ({ data: [] }));
  const oldRep = (dupRes.data || [])[0];
  let reportId = String((oldRep && oldRep._id) || '');
  if (oldRep) {
    // 已经结掉的那一票不再翻案：内容被判过「证据不足」之后换个理由重投，
    // 等于把结案的东西重新拉回队列，审核员要再判一遍同一件事
    if (oldRep.status !== 'pending') {
      return { ok: true, msg: '这条你已经举报过了', dup: true };
    }
    if (String(oldRep.reason || '') === reason) {
      // 内容是保护状态时，历史遗留的 pending 记录也要从普通队列里摘出去。
      if (guarded) {
        await db.collection(COL_REPORTS).doc(oldRep._id)
          .update({ data: { status: 'protected', protectedAt: Date.now() } })
          .catch(() => {});
      }
      return { ok: true, msg: guarded ? '这条内容受保护，举报已被记录，不会进入普通审核队列' : '你已经举报过了，我们会尽快处理', dup: true, protected: !!guarded };
    }
    // 理由变了：按新的判。一个人从「不文明用语」改口「涉及隐私」，
    // 高敏那档该重新走一遍 —— 但票数不会因此多出来
    await db.collection(COL_REPORTS).doc(oldRep._id)
      .update({ data: { reason: reason, detail: detail || String(oldRep.detail || ''), status: guarded ? 'protected' : 'pending' } })
      .catch(() => {});
  } else {
    reportId = await addReportDoc({
      openid: openid,
      target: target,
      targetId: targetId,
      targetType: targetType,
      reason: reason,
      detail: detail,
      // protected 不是“处理完成”，而是“保留举报证据、但不进入普通人工队列”
      status: guarded ? 'protected' : 'pending',
      time: now(),
      at: Date.now(),
      // 观察期里投的这一票：留痕、进队列，但下面判处置时不算它
      reviewOnly: !!ab.limited
    });
  }

  const verdict = await decideAction(
    targetType, targetId, target, reason, detail,
    ab.limited ? openid : ''
  );
  // decideAction 会重新查一次保护关系；这里以最终判定为准，把记录彻底移出
  // 普通 pending 队列（包括刚新增或刚改理由的那一条）。
  if (verdict.guarded && reportId) {
    await db.collection(COL_REPORTS).doc(reportId)
      .update({ data: { status: 'protected', protectedAt: Date.now() } })
      .catch(() => {});
  }
  // 低可信单票自动归档：不处罚举报人，只是不占用当前唯一审核员的人工队列。
  const autoDismissed = shouldAutoDismiss({
    total: verdict.total,
    blocked: verdict.blocked,
    guarded: verdict.guarded,
    highRisk: verdict.highRisk,
    reporterLimited: !!ab.limited,
    detail: detail
  });
  if (autoDismissed && reportId) {
    await db.collection(COL_REPORTS).doc(reportId)
      .update({ data: { status: 'auto_dismissed', autoDismissed: true, handledAt: now(), handledBy: 'auto' } })
      .catch(() => {});
  }

  // 已经下架过的内容，这一票照样回给前端 —— 票不能吞。
  //
  // ⚠️ 这里以前写成「已经 hidden 就把动作清成空」，看着是「不重复下架」，
  // 实际坑不小：之后同学在「因举报暂停展示」那个页面补投的票，
  // 全部只换回一句「举报已提交」，needReview 也是 false ——
  // 投了跟没投一样。内容状态是幂等的（再写一遍 hidden 没坏处），
  // 要省的是那次多余的写库，不是这一次举报的上报。
  const action = verdict.action;

  let msg = '举报已提交，我们会尽快核实';
  if (autoDismissed) {
    msg = '举报已收到。系统暂未发现可核实的违规信息，已自动归档';
  } else if (verdict.guarded) {
    // 保护内容不自动下架，也不进入普通审核队列；举报记录仍保留，供后续追溯。
    msg = '举报已收到。这条内容受保护，不会自动下架，也不会进入普通审核队列';
  } else if (action === 'hide') {
    await setContentStatus(targetType, targetId, 'hidden',
      alertHideReason(reason, verdict.total, '自动下架'));
    msg = '已暂停这条内容的展示，我们会尽快核实';
  } else if (verdict.need > verdict.total) {
    // 没到下架门槛时，把「还差几个」说出来。
    // 不说的话，热门内容的举报人看到内容还在，只会觉得「举报没用」——
    // 而这条内容其实是 800 人看过、本来就要 10 个人才算数。
    // 浏览量那句只在有数据时加：没数据时说「0 人看过」比不说更让人困惑
    msg = '举报已收到。这条内容要 ' + verdict.need + ' 位同学举报才会先暂停展示（还差 '
      + (verdict.need - verdict.total) + ' 人），在此之前会由审核员核实'
      + (verdict.views > 0 ? '。目前有 ' + verdict.views + ' 人看过' : '');
  }

  // 观察期里的举报：系统不自动处置，得审核员自己看一眼 —— 文案要说清楚，
  // 别让人以为「举报交上去就没动静了」
  if (ab.limited && !action && !verdict.guarded) msg = '举报已收到，会由老师优先核实';

  // needReview 只 telling 前端「还有事要人工看」：下架算已经处理掉了，
  // 不该再往审核队列里塞一条（否则审核员看到的都是重复项）
  return {
    ok: true,
    msg: msg,
    action: action,
    // 顺带回给前端：这条内容现在几个人看过、门槛几个人。
    // 举报弹窗据此能说一句「这条要 7 个人才算数」，比「已提交」有用得多
    views: verdict.views || 0,
    need: verdict.need || 0,
    total: verdict.total || 0,
    needReview: autoDismissed ? false : (!!verdict.guarded ? false : (action === 'hide' || !!ab.limited)),
    reviewOnly: autoDismissed ? false : (!!ab.limited && !verdict.guarded),
    autoDismissed: !!autoDismissed,
    protected: !!verdict.guarded
  };
}

// 全部审核员 id：环境变量写死的那批 + 名册集合 admins 里自助登记的。
// 只用于「把某条东西推给该看的人」，权限判定仍然各走各的 isModerator，
// 两处口径不需要一致（一个名单是「谁收通知」，一个是「谁能动手」）。
async function moderatorIds() {
  const set = {};
  MODERATORS.forEach((m) => { set[m] = true; });
  const res = await db.collection(COL_ADMINS).limit(50).get().catch(() => ({ data: [] }));
  (res.data || []).forEach((r) => {
    const id = String(r.openid || r._id || '');
    if (id) set[id] = true;
  });
  return Object.keys(set);
}

// 通知全部审核员。失败不抛 —— 审核员没收到通知的最坏后果是晚一点看到，
// 而抛出去会把举报这件事本身弄失败。
async function notifyMods(payload) {
  const ids = await moderatorIds();
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await pushNotify(id, payload);
  }
  return ids.length;
}

// 举报「人」：私信页与名片页的入口走这里。
//
// 与举报内容的根本差别：**不做任何自动处置**。
// 内容能被三个不相干的人同时看错，概率不高；「人」被举报则可以完全来自同一起
// 私人矛盾（室友、分手、社团恩怨），自动封号会立刻酿成事故。
// 所以这里只做三件事：留证据、累计人数、把该看的推给审核员。
async function reportPerson(openid, payload) {
  const targetType = payload.targetType === 'chat' ? 'chat' : 'profile';
  const target = String(payload.targetOpenid || '').trim();
  const rawReason = String(payload.reason || '');
  const reason = REPORT_REASONS.indexOf(rawReason) >= 0 ? rawReason : '其他';
  const detail = String(payload.detail || '').slice(0, 100);
  if (!target) return { ok: false, msg: '没被举报的对象' };
  if (target === openid) return { ok: false, msg: '不能举报自己' };

  // 查重：同一个人对同一个对象、同一理由只算一次。
  // 对「人」而言 targetId 是空的，所以去重键里不含它
  const dup = await db.collection(COL_REPORTS)
    .where({ openid: openid, target: target, targetType: targetType, reason: reason })
    .limit(1).get().catch(() => ({ data: [] }));
  if (dup.data && dup.data.length) {
    return { ok: true, msg: '你已经举报过了，我们会尽快处理' };
  }

  // 证据快照。私信举报必须带上当时的对话 —— 不带的话审核员只能看到一个
  // 光秃秃的账号，而他手上没有任何可核对的材料，这条举报就等于没提交。
  // 只取最近 10 条、每条截 80 字：够还原现场，又不至于把整段聊天搬进举报库
  let evidence = [];
  if (targetType === 'chat') {
    const key = chatKey(openid, target);
    const c = await db.collection(COL_CHATS).where({ key: key }).limit(1)
      .get().catch(() => ({ data: [] }));
    const msgs = (c.data && c.data[0] && c.data[0].messages) || [];
    evidence = msgs.slice(-10).map((m) => ({
      from: m.from === openid ? 'me' : 'peer',
      text: String(m.text || (m.images && m.images.length ? '[图片]' : '')).slice(0, 80),
      time: String(m.time || '')
    }));
  } else {
    const p = await db.collection(COL_USERS).doc(target).get().catch(() => null);
    const u = (p && p.data) || {};
    evidence = [{
      nickName: String(u.nickName || '').slice(0, 20),
      college: String(u.college || '').slice(0, 20)
    }];
  }

  const ab = await abuseState(openid);
  await addReportDoc({
    openid: openid,
    target: target,
    targetId: '',
    targetType: targetType,
    reason: reason,
    detail: detail,
    evidence: evidence,
    status: 'pending',
    time: now(),
    at: Date.now(),
    // 观察期里投的票照样进队列，只是不计入任何阈值（与内容举报同一口径）
    reviewOnly: !!ab.limited
  });

  // 账号级累计：最近 7 天里有多少个**不同的人**报过同一个账号。
  // 用「不同的人」而不是「多少条」：一个人连点五次的恶意举报不该把它顶上去
  const since = Date.now() - 7 * 24 * 3600 * 1000;
  const rs = await db.collection(COL_REPORTS)
    .where({ target: target, targetType: targetType }).limit(200)
    .get().catch(() => ({ data: [] }));
  const reporters = {};
  (rs.data || []).forEach((r) => {
    if (Number(r.at) >= since && r.openid !== target) reporters[r.openid] = true;
  });
  const people = Object.keys(reporters).length;

  if (people >= PERSON_REPORT_THRESHOLD) {
    await db.collection(COL_REPORTS)
      .where({ target: target, targetType: targetType, status: 'pending' })
      .update({ data: { escalated: true, reporterCount: people } }).catch(() => {});
    // 账号级举报不进自动处置，只能靠人看到 —— 所以必须主动推给审核员
    await notifyMods({
      type: 'report',
      title: '有账号被多名同学举报',
      body: targetType === 'chat' ? '私信骚扰举报累计到' + people + '人' : '名片举报累计到' + people + '人',
      page: 'pages/admin/moderation/moderation',
      targetId: target
    });
  }

  return {
    ok: true,
    msg: people >= PERSON_REPORT_THRESHOLD
      ? '举报已提交，会由审核员优先核实'
      : '举报已提交，我们会尽快核实',
    action: '',
    // 账号举报一律要人工看：没有自动处置兜底，队列里必须留着
    needReview: true,
    reviewOnly: !!ab.limited
  };
}

function alertHideReason(reason, total, prefix) {
  return (prefix || '') + '：' + reason + (total > 1 ? '（' + total + ' 人举报）' : '');
}

/* ---------------- 内容审核（仅白名单） ---------------- */

// 审核员判定：两处任一命中即可
//   ① 环境变量 MODERATORS 里写死的
//   ② 名册集合 admins 里有这个人（审核页里点「把我设为审核员」写的）
// 只看代码里写死的白名单，不查库
function isModeratorFast(openid) {
  return MODERATORS.indexOf(openid) >= 0;
}
// 完整判定：白名单之外，还要去名册库 admins 里查（审核页里点按钮登记的）
async function isModerator(openid) {
  if (isModeratorFast(openid)) return true;
  const res = await db.collection(COL_ADMINS).doc(openid).get().catch(() => null);
  // ⚠️ 必须确认拿到的是「单个文档对象」：某些 SDK 版本对不存在的文档不抛错而是返回
  //    空数组/空数据，直接 !!(res && res.data) 会把任何人都误判成审核员
  const d = res && res.data;
  return !!d && !Array.isArray(d) && typeof d === 'object';
}
// ⚠️ 返回值必须是「错误信息字符串」或空字符串。
//    这里曾经被写了两遍一模一样的定义（重复函数声明，后定义覆盖前定义），
//    功能上碰巧一致，但会让读过的人以为有一处被改过却没生效。现在只留这一份。
async function denyReason(openid) {
  if (isModeratorFast(openid)) return '';
  return (await isModerator(openid)) ? '' : '你不是审核员，无法进入内容审核';
}

// 「把我设为审核员」：名册用 openid 当 _id，伪造请求也只能给自己登记，改不了别人。
// ⚠️ 但代价是「任何人都能给自己登记」——所以默认由上面的 SELF_ADMIN = false 关着，
// 正式上线前请走 MODERATORS 环境变量，别把自助登记打开。
async function setAdmin(openid) {
  if (!SELF_ADMIN) return { ok: false, msg: '当前设置了禁止自助登记，请联系管理员' };
  await db.collection(COL_ADMINS).doc(openid).set({
    data: { openid: openid, at: Date.now() }
  }).catch(() => {});
  return { ok: true, isMod: true, msg: '你已经是审核员了' };
}

/* ---------------- 账号封禁（仅审核员） ---------------- */

// 卖片、代写、拉群招生这类内容的问题不在「某一帖」上，而在账号本身：
// 删一条他再发一条，删帖永远追不上。所以给审核员一把直接封号的钥匙。
//
// 封禁状态记在 users 文档上（banned / bannedReason / bannedAt / bannedBy），一人一份，天然幂等。
// 两条取舍：
//   ① 读不受影响。被封的人还能进小程序看内容 —— 封的是「发和互动」，
//      不是把人从校园社区里抹掉（真把人彻底挡在外面，反而没法申诉）；
//   ② 拦在 exports.main 的统一入口，而不是散到每个写 action 里各判一次。
//      分散判定迟早会漏一个，漏掉的那个就是后门。
const BAN_REASON_MAX = 60;

// 被封禁时拒绝的动作清单。这里刻意列「写」，不列「读」——
// 反过来列白名单（哪些能读）更不安全：新加一个读接口忘了登记，用户就先被误伤了
const BANNED_BLOCK_ACTIONS = [
  // 内容
  'postAdd', 'postEdit', 'patchContent', 'setStatus', 'reviewAdd', 'postComment', 'commentRemove', 'commentReport',
  'commentVote',
  'marketAdd', 'marketDone', 'marketRemove', 'resourceAdd',
  'placeAdd', 'placeRemove', 'calendarSave', 'calendarRemove', 'calendarReset',
  'eventAdd', 'eventJoin', 'eventCancel', 'teacherAdd', 'teacherRemove',
  'courseAdd', 'courseRemove', 'courseReqVote', 'courseTypeSet',
  // 互动
  'voteCast', 'likeToggle', 'holeReact', 'report',
  // 社交
  // ⚠️ block / unblock / removeFriend 不在这里：这三个是「退出关系」的动作，
  //    被封的人也该能把自己从别人那儿摘出去，把账号关进小黑屋不该连门都锁上
  'chatSend', 'addRequest', 'respond', 'bottleThrow', 'bottleReply',
  // 私人数据
  'memoSave', 'memoRemove'
];

// 「会写内容」的 action 全集，只用来决定「这次调用要不要先把屏蔽词表拉一遍」。
// 它是 BANNED_BLOCK_ACTIONS 的超集：后者故意漏掉了 block / unblock / removeFriend
// / accountCancel 这些「退出关系」的动作（被封的人也该能把自己摘出去），
// 但它们照样会写库，照样需要最新词表。
// ⚠️ 新增写接口时两处都要登记，漏了这里不会报错，只会让自配词晚 5 分钟才生效。
const WRITE_ACTIONS = BANNED_BLOCK_ACTIONS.concat([
  'block', 'unblock', 'removeFriend', 'friendAccept', 'friendReject', 'patchContent', 'setStatus',
  'friendCancel', 'friendAlias', 'accountCancel', 'accountCancelUndo',
  'postEdit', 'chatRecall', 'chatRemove', 'chatAccept', 'chatDismiss',
  'notifyRead', 'saveFavorites', 'eventRemove', 'commentRemove', 'commentVote',
  'postPin', 'postPinOrder', 'setAdmin', 'cfgSave', 'resourceUrl', 'resourceReview'
]);

function fmtStamp(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const d = new Date(n);
  const p = (x) => (x < 10 ? '0' + x : '' + x);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 取某人的封禁状态：没封 / 查不到都返回 null（「查不到」= 放行，
// 与全站其它地方「云端不可用一律放过」的口径一致 —— 库抽风不能把全校锁死）
async function banStateOf(openid) {
  const target = String(openid || '');
  if (!target) return null;
  const res = await db.collection(COL_USERS).doc(target).get().catch(() => null);
  const u = res && res.data;
  if (!u || Array.isArray(u) || typeof u !== 'object') return null;
  if (!u.banned) return null;
  return { reason: String(u.bannedReason || ''), at: Number(u.bannedAt) || 0 };
}

async function banUser(openid, payload) {
  payload = payload || {};
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能封禁账号' };
  const target = String(payload.openid || payload.target || '').trim();
  if (!target) return { ok: false, msg: '参数缺失' };
  if (target === openid) return { ok: false, msg: '不能封禁自己' };
  // 审核员之间不互相封：这条口子是给「卖片账号」用的，
  // 不加这层，一把钥匙就能把整个管理团队锁在门外
  if (isModeratorFast(target) || await isModerator(target)) {
    return { ok: false, msg: '对方也是审核员，不能封禁' };
  }

  const reason = String(payload.reason || '').trim().slice(0, BAN_REASON_MAX) || '发布违规内容';
  const extra = {
    banned: true,
    bannedReason: reason,
    bannedAt: Date.now(),
    bannedBy: openid
  };

  // 用户可能从没登记过资料（users 里没有这条文档）。这时 update 会命中 0 条、
  // 而且**不报错** —— 界面提示「已封禁」、实际什么都没发生，是最坏的一种失败。
  // 所以先探一次：有文档就增量 update（不覆盖他的昵称头像），没有就 set 一条最小的
  const exist = await db.collection(COL_USERS).doc(target).get().catch(() => null);
  const has = !!(exist && exist.data && !Array.isArray(exist.data) && typeof exist.data === 'object');
  const w = has
    ? await db.collection(COL_USERS).doc(target).update({ data: extra }).catch((e) => ({ err: e }))
    : await db.collection(COL_USERS).doc(target)
      .set({ data: Object.assign({ openid: target, nickName: '某位同学' }, extra) })
      .catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[banUser] write failed:', d.code, d.msg);
    return { ok: false, msg: '封禁没成功，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  await logMod(openid, 'ban', 'user', target, String(payload.reason || '').slice(0, 60));
  return { ok: true, msg: '已封禁该账号' };
}

async function unbanUser(openid, payload) {
  payload = payload || {};
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能解除封禁' };
  const target = String(payload.openid || payload.target || '').trim();
  if (!target) return { ok: false, msg: '参数缺失' };
  const w = await db.collection(COL_USERS).doc(target)
    .update({ data: { banned: false, bannedReason: '', bannedAt: 0, bannedBy: openid } })
    .catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[unbanUser] write failed:', d.code, d.msg);
    return { ok: false, msg: '解除没成功，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  await logMod(openid, 'unban', 'user', target, '');
  return { ok: true, msg: '已解除封禁' };
}

// 封禁名册：审核员得能看见「现在封了谁、为什么封、什么时候封的」。
// 没有这面镜子，封错了没法回头，换个人接手也不知道前任封过谁
async function banList(openid) {
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能看封禁名册' };
  // where({banned:true}) 只命中「有这个字段且为 true」的文档，
  // 没写过 banned 的用户不会被扫进来（所以不用额外过滤）
  const res = await db.collection(COL_USERS)
    .where({ banned: true }).limit(50).get().catch(() => ({ data: [] }));
  const list = (res.data || []).map((u) => ({
    openid: u._id || u.openid || '',
    nickName: u.nickName || '某位同学',
    college: u.college || '',
    reason: String(u.bannedReason || ''),
    at: Number(u.bannedAt) || 0,
    atText: fmtStamp(u.bannedAt)
  })).filter((x) => x.openid);
  return { ok: true, list: list };
}

// 云端版本指纹。
//
// 为什么要专门放一个这个：小程序前端是「保存即生效」的，云函数却要手动
// 「上传并部署」。两者异步之后就会出现一种最难查的现场 —— 本地代码是新的、
// 云端跑的是旧的，症状像是前端有 bug。
// 真实踩过一次：前端上了「私信发图」，云端 user 云函数没重新部署，旧版 chatSend
// 压根不认识 images 字段，纯图消息一律回「内容不能为空」，图文消息则**悄悄把图丢掉**。
// 当时从现象上完全看不出是部署问题。
//
// 以后改云函数的行为（新增 action、改参数或回执形状），就把 BUILD 往后加一位。
// features 是给**人**看的自检清单（前端不做自动判断：diag 要并发探测二十多个集合，
// 为了一句提示在启动时跑一次不划算），排查时调一次 diag 就知道云端有没有这项能力。
const BUILD = '2026-10-20.5';
const FEATURES = [
  'chatImage', 'ban', 'whoamiMod', 'postsByAuthor', 'commentImage',
  'jobfair', 'jobtalk', 'byline', 'chatQuota', 'removeFriend',
  // .9 新增：注销、举报人、请求箱、撤回、通知中心、图片审核、帖子编辑
  'accountCancel', 'reportPerson', 'chatRequest', 'chatRecall',
  'notify', 'mediaCheck', 'postEdit', 'modLog',
  // .10：审核队列带被举报内容的配图（以前审核员看不见图只能凭感觉判），
  //      并修掉「人的证据被当成图片渲染」导致的碎图
  'modQueueImages',
  // 2026-10-17.1：评论区四项交互 —— 留言赞踩（记名表数人头）、
  //               二级回复（层级折叠 + 连父删除）、举报处理状态回传
  'commentVote', 'commentReply',
  // 2026-10-17.2：留言拆独立集合（消除读-改-写竞态）、举报防刷、
  //               留言软删 + 删除通知 + 申诉入口
  'commentTable', 'commentCount', 'commentAppeal', 'reportGuard',
  // 2026-10-17.3：内容保护（举报不自动下架）、限时置顶（到期自动收回）
  'contentProtect', 'pinExpire',
  // 2026-10-17.4：功能缺口修复 ——
  //   myPostsAnon  按作者查帖带出自己的匿名 / 树洞 / 下架帖（「我的帖子」以前只取本地 20 条）
  //   notifyPage   通知列表支持 skip 分页，未读数改全量 count（以前最多 100 条、偏低）
  //   chatReadAt   会话返回对方阅读水位（前端显示「已读 / 未读」）
  //   commentRecount 打开详情时顺手校正 commentCount 漂移
  'myPostsAnon', 'notifyPage', 'chatReadAt', 'commentRecount',
  // 2026-10-17.5：订阅消息拆成三种（帖子被留言 / 留言被回复 / 私信），
  //               授权框一次可要两个模板，审核页三格分别配
  'submsgComment',
  // 2026-10-17.6：补完审计里剩下的缺口 ——
  //   marketReport / eventReport  闲置与活动终于能举报（此前只有帖子 / 评价 / 留言）
  //   draftCloud                  草稿上云：换设备接着写（后写者胜 + 墓碑防复活）
  'marketReport', 'eventReport', 'draftCloud',
  // 2026-10-17.7：撤回与「摘掉违规图」不再整份写回 messages，
  //               改成按 rev 做有条件写入（并发 push 时不会互相抹掉）
  'chatRevCas',
  // 2026-10-17.9：被举报下架的闲置 / 活动补上作者出口 ——
  //   myContent  作者对账：我发的东西现在是被暂停展示还是已经删了
  //   （恢复动作复用 setStatus，作者本人可恢复自己那条自动下架的内容）
  'myContent',
  // 2026-10-18.4：举报计票改成**一个人一票**（以前查重键带着理由，
  //               8 种理由能投 8 次，一个人就能推平 3 票下架 / 5 票删除）；
  //               审核队列改成**一条内容一行**（带人数、差几票、理由分布）；
  //               新增已处置归档（确认 / 驳回之后可回看，带内容快照）
  'reportOneVote', 'queueGrouped', 'reportArchive',
  // 2026-10-18.5：举报只下架、不删除（删除一律人工）；下架门槛按**独立浏览人数**
  //               分档（0-49 → 3 人 / 50-199 → 5 人 / 200-499 → 7 人 / 500+ → 10 人）；
  //               contentView 负责记浏览（一人一次、作者不计），队列带分母
  'viewCount', 'hideByViews', 'noAutoDelete',
  // 2026-10-18.6：contentView 数人数前先排除作者本人 —— 作者打开自己的新内容
  //               不该看到「1 人看过」，那个 1 就是他自己；
  //               前端「N 人看过」改成 ≥50 才显示（VIEW_SHOW_MIN），
  //               冷启动期不露出小数字
  'viewShowGate',
  // 2026-10-18.8：匿名帖的**评论区**一并匿名（楼主用主贴代号、其他人按
  //               「帖子id+openid」取名），且 commentList 在下发之前就把
  //               author / avatarUrl / replyToAuthor 摘掉 ——
  //               前端换代号只是遮住屏幕，真名还在响应体里躺着
  'anonComment',
  // 2026-10-20.5：帖子赞踩计数只认 post_votes 记名表；
  //               一个 openid 对一条帖子最多一票，赞踩互斥
  'voteTableCountOnly'
];

// 环境自检：告诉前端「哪些集合还没建」，好让页面直接把引导显示出来，
// 而不是让用户对着一堆报错猜
async function diag() {
    // 不查 likes 集合：点赞早就收口到服务端了，记录存在帖子里的 likedBy 数组里，
    // 客户端直连写 likes 能无限刷赞。留着会让，「我的自检」里多一条永远无害的假警报
    const need = [COL_USERS, COL_POSTS, COL_REVIEWS, COL_CONTACTS, COL_REPORTS,
      COL_ADMINS, COL_FAVS, COL_MARKET, COL_CHATS,
      // courses 以前不在这个清单里（云函数确实写它，漏了纯属漏了）。
      // 缺它的后果很绕：utils/store-sync.js 启动时**前端直连**读 courses，
      // 集合不存在时查询报错被 catch 掉，同学共建的课程就凭空少一批，
      // 而自检页面还理直气壮地显示「全部就绪」—— 自检漏掉自己要用的集合最要命
      COL_COURSES,
      COL_RESOURCES, COL_CALENDAR, COL_PLACES, COL_CONFIG, COL_MEMOS,
      COL_EVENTS, COL_EVENT_JOINS, COL_TEACHERS, COL_COURSE_REQS, COL_BLOCKS,
      COL_BOTTLES, COL_BOTTLE_LOGS, COL_COURSE_TYPES,
      // 同学关系表：同意好友申请的事务写这里。没建的话「同意」会失败，
      // 自检里必须能直接看到，不然又是「点了没反应」
      COL_FRIENDS, COL_VOTES, COL_REACTS,
      // 留言赞踩记名表：没建的话点赞会走降级路径（按钮照样有反应，
      // 只是计数可能重复），属于「没报错但悄悄不准」的一类，必须能自检出来
      COL_COMMENT_VOTES,
      // 本轮新增的四个：全部是「没建也不崩，但对应功能会静默失效」的类型 ——
      // 通知中心不写通知、审核日志不留痕、图片审核没记录、注销申请存不下。
      // 正因如此才更要进自检清单：它们的失败都没有前台报错
      COL_NOTIFIES, COL_MODLOGS, COL_ERRORS, COL_MEDIA, COL_ACCOUNT_REQS,
      // 留言本体与申诉：拆表之后留言只存在于 post_comments 里，
      // 集合没建等于整个评论区打不开 —— 这是本轮最不能漏的两个
      COL_POST_COMMENTS, COL_COMMENT_APPEALS,
      // 内容保护表。没建不会报错，只是「保护」永远设不上 ——
      // 而运营会以为自己护住了，直到那条内容被举报自动下架才发现
      COL_PROTECTS,
      // 浏览记录。没建不报错，只是分母永远是 0 → 所有内容都按最低档 3 人算，
      // 也就是「火帖也只是 3 人就能下架」—— 这轮改动等于白做，且不会有任何报错
      COL_VIEWS,
      // 草稿。没建同样不报错：草稿照常存在本机，「换设备还在」这条静默失效
      COL_DRAFTS];

    // 并发探测：9 个集合串行查询在真机上要 3 秒以上，正好卡死云函数默认的 3 秒超时
    const probes = await Promise.all(need.map((name) =>
      // eslint-disable-next-line array-callback-return
      db.collection(name).limit(1).get().then((r) => (r && Array.isArray(r.data) ? null : name)).catch(() => name)
    ));
    // 能查出数据 = 集合存在；返回空数组也算存在；null 就是查得到
    const missing = probes.filter((n) => n);
    // 内容安全接口是否可用：真上架时这是硬要求，通没通得一眼看出来。
    // secCheck 内部调用失败会返回 { sec: 'error' }，不会抛出去。
    const sec = await secCheck('浙商大校园自检');
    // 控制台「测试」发起的调用没有微信侧的云调用上下文，openapi 的 access_token
    // 必然无效（-501001），sec 在那里恒为 error 属假警报。只有从小程序端 /
    // 定时触发器发起的调用才带得上鉴权。这里把提示带出去，省得再误判一次。
    const fromClient = Boolean(await me());
    return {
      ok: true,
      // 云端跑的是哪一版 / 有哪些能力：排查「本地新、云端旧」时先看这两个字段
      build: BUILD,
      features: FEATURES,
      missing: missing,
      isMod: await isModerator(await me()),
      // 订阅消息有没有配模板 ID：没配就只是发不出通知，其他功能不受影响
      submsg: await getSubMsgIds(),
      sec: sec.sec || 'ok',
      secErr: sec.secErr || '',
      secNote: fromClient
        ? ''
        : '本次调用来自控制台测试，没有微信侧鉴权上下文，sec 在这里恒为 error 属假警报；请在小程序「我的 → 审核」页看真实结果'
    };
  }

// 待处理队列：把举报和它对应的内容拼在一起，审核页直接能看
async function getQueue(openid) {
  const err = await denyReason(openid);
  if (err) return { ok: false, msg: err };

  const res = await db.collection(COL_REPORTS)
    .where({ status: 'pending' })
    .orderBy('at', 'desc').limit(50).get().catch(() => ({ data: [] }));

  // 一条内容一行，而不是一条举报一行。
  //
  // 以前同一条帖被 3 个人举报，队列里就是三张长得一样的卡：审核员要么逐张点
  // 「确认违规」（点第一张内容就没了，后两张对着空气操作），要么三张全勾上驳回。
  // 更要紧的是看不出「它还差几票就自动下架」—— 而那个数字才是「现在要不要动手」
  // 的依据。分组口径在 report-votes.js，和计票用的是同一套「一件事」定义。
  const groups = groupReports(res.data || []);

  // 并发取回：原来每条举报串行做「查内容 + 查发布者」两次往返，
  // 队列里有十几条时累计超过云函数默认的 3 秒超时（真机上直接 Timeout）。
  // 分组之后条数少了一半以上，往返次数跟着少
  //
  // 只有走 decideAction 的那几类内容才有「差几个人自动下架」这回事。
  // 留言没有下架档（它只有删 / 不删），给它算这个数就是撒谎
  const HIDE_TYPES = ['post', 'review', 'market', 'event', 'resource'];
  const detail = await Promise.all(groups.map((g) => (async () => {
    const content = g.targetId ? await fetchTarget(g.targetType, g.targetId) : null;
    const u = g.targetOpenid
      ? await db.collection(COL_USERS).doc(g.targetOpenid).get().catch(() => null)
      : null;
    // 这条内容被几个人看过：审核员要看到「还差 3 人」背后的分母。
    // 差 3 人可能是没人管，也可能是这条有 900 人看过 —— 后者根本不用管
    const views = (content && HIDE_TYPES.indexOf(g.targetType) >= 0)
      ? await countViews(g.targetType, g.targetId, content.openid)
      : 0;
    const guarded = await isProtected(g.targetType, g.targetId);
    if (guarded) {
      await db.collection(COL_REPORTS)
        .where({ targetType: g.targetType, targetId: g.targetId, status: 'pending' })
        .update({ data: { status: 'protected', protectedAt: Date.now() } })
        .catch(() => {});
    }
    return {
      content: content,
      name: (u && u.data && u.data.nickName) || '某位同学',
      guarded: !!guarded,
      views: views,
      need: HIDE_TYPES.indexOf(g.targetType) >= 0 ? hideNeed(views) : 0
    };
  })()));

  const list = [];
  groups.forEach((g, i) => {
    // 保护内容是运营明确要护住的：举报记录保留，但不进入普通待处理队列。
    // 旧版本遗留的 pending 记录也会在这里被摘掉。
    if (detail[i].guarded && !isPersonType(g.targetType)) return;
    const content = detail[i].content;
    const name = detail[i].name;
    const common = {
      // 兼容老字段：卡片勾选和「确认违规」都从 repId 起手，
      // 新的批量口径用 repIds（这一组的全部举报）
      repId: g.repId,
      repIds: g.repIds,
      gkey: g.key,
      targetId: g.targetId,
      targetType: g.targetType,
      reason: g.reason,
      // 这一组里出现过的理由分布（前端只显示种数，省得卡片被标签撑满）
      reasons: g.reasons,
      detail: g.detail,
      time: g.time,
      targetNick: name,
      // 被举报对象的 openid：审核页靠它「直接封号」。
      // 之前这里不带，审核员看到一条卖片帖也只能删帖，删完他再发一条
      targetOpenid: g.targetOpenid,
      // 这一组里只要有一个人在观察期，就标出来：系统没拿他那票动手
      reviewOnly: g.reviewOnly,
      // 账号级举报累计到阈值后打到这儿：队列里排前面，且要标出来
      escalated: g.escalated,
      reporterCount: g.reporterCount,
      // 举报人数（去重后的人头）、「还差几个人」以及门槛背后的分母。
      // need 是按这条内容自己的浏览量算出来的，不是全局一个常数 ——
      // 审核员看到「还差 3 人 / 900 人看过」，就知道这条不用急着动手
      reportCount: g.reportCount,
      views: detail[i].views || 0,
      hideAt: detail[i].need || 0,
      needMore: detail[i].need ? Math.max(0, detail[i].need - g.reportCount) : 0
    };

    // 举报「人」：没有可下架的内容，但必须带证据快照和「排前面」的标记 ——
    // 这条链路没有自动处置兜底，审核员漏看就等于白举报
    if (isPersonType(g.targetType)) {
      // 证据快照合并：同一个人被 3 个人举报，三份快照都要看得到 ——
      // 只留最新一份等于让审核员凭一条消息判「是不是长期骚扰」
      const ev = [];
      g.rows.forEach((r) => {
        (Array.isArray(r.evidence) ? r.evidence : []).forEach((e) => {
          if (ev.length < 12) ev.push(e);
        });
      });
      list.push(Object.assign({}, common, {
        person: true,
        title: g.targetType === 'chat' ? '私信骚扰举报' : '名片举报',
        desc: ev.length
          ? ev.map((e) => (e.text ? (e.from === 'me' ? '我：' : '对方：') + e.text : (e.nickName || ''))).join(' / ').slice(0, 300)
          : '（没有留下证据快照）',
        // ⚠️ 字段名叫 personEvidence 而不是 evidence：前端那个证据区是 `src="{{src}}"`
        // 直接渲染图片的，只能吃 URL 字符串。这里 ev 是对象数组（{from,text,time}），
        // 以前挂在 evidence 上，审核页就会拿对象当图片地址去加载 —— 名片举报那一栏
        // 一直是一块加载不出来的碎图。文本证据走上面的 desc，不进图片区
        personEvidence: ev,
        contentStatus: 'person'
      }));
      return;
    }

    if (!content) {
      list.push(Object.assign({}, common, {
        desc: '（内容已不存在）', contentStatus: 'gone'
      }));
      return;
    }

    // 被举报内容自己的配图：广告常常长在图里（二维码、微信号截图），
    // 正文可能只有「加我」两个字。以前队列只给正文前 160 字，审核员看不见图，
    // 这类举报只能凭感觉判 —— 驳回怕放过、通过怕误伤。现在把图一起带下去。
    // 截 3 张：再多队列首屏就要并发下载一堆图了，判违规看 3 张足够
    const pics = (Array.isArray(content.images) ? content.images : [])
      .filter((s) => typeof s === 'string' && s)
      .slice(0, 3);

    list.push(Object.assign({}, common, {
      title: String(content.title || ''),
      desc: String(content.content || '').slice(0, 160),
      contentStatus: content.status || 'normal',
      // 补上板块和帖子类型：队列里只给标题的话，审核员看不出这条该按哪套规矩判。
      // 「信息墙」帖的正文是空的，按普通帖的印象去判会以为内容不全，
      // 不知道它的设计本来就是把信息收在评论区
      board: String(content.board || ''),
      kind: content.kind === 'topic' ? 'topic' : 'normal',
      // evidence 这个名字前端只当图片 URL 数组用（见上面 personEvidence 的说明）
      evidence: pics
    }));
  });

  // 排前面：账号级（escalated）→ 举报人多的 → 其余按时间。
  // 审核员的时间有限，队列顺序本身就是一种优先级声明：
  // 一条已经 2 个人说不行、再一票就自动下架的内容，比刚被举报 1 次的新帖该先看
  list.sort((a, b) => {
    if (a.escalated !== b.escalated) return a.escalated ? -1 : 1;
    if (a.reportCount !== b.reportCount) return b.reportCount - a.reportCount;
    return 0;
  });

  return { ok: true, list: list, isMod: true };
}

// 举报结果通知该点去哪儿。
//
// 以前这里不分类型，一律写 'pages/forum/list/list'。同学举报的是二手上的一条
// 假货、或者一个收费拉人的活动，收到「你举报的内容已处理」点进去却是论坛首页 ——
// 回音掉进了错的信箱，他只会觉得「举报没处理」。处置结果本身是对的，通知却把人
// 送去了不相干的地方，这是这条链路上最后一处断点。
//
// 规则：内容还在（驳回或只下架）→ 直达那一条；已经删掉 → 落到对应列表。
// 删掉之后还往详情页送，打开只会看到「这条记录不见了」，比落错地方更像出了故障。
function reportResultPage(rec, action) {
  const t = String((rec && rec.targetType) || 'post');
  const id = String((rec && rec.targetId) || '');
  const postId = String((rec && rec.postId) || '');
  // 举报「人」没有可看的内容，落回私信列表（被骚扰的人下一步就在那儿）
  if (t === 'chat' || t === 'profile') return 'pages/user/chats/chats';
  if (t === 'resource') return 'pages/tool/resources/resources';
  // 留言被删掉之后帖子还在，回帖子详情比回列表更有用 —— 上下文都在这儿
  if (t === 'comment') {
    return postId ? 'sub/forum/detail/detail?id=' + postId : 'pages/forum/list/list';
  }
  const deleted = action === 'confirm';
  if (!deleted && id) {
    if (t === 'market') return 'sub/market/detail/detail?id=' + id;
    if (t === 'event') return 'sub/campus/event/event?id=' + id;
    if (t === 'review') return 'sub/course/detail/detail?id=' + id;
    if (t === 'post') return 'sub/forum/detail/detail?id=' + id;
  }
  if (t === 'market') return 'pages/market/list/list';
  // 活动没有独立列表页，列表就是校园页（那里同时是报名入口）
  if (t === 'event') return 'pages/campus/campus';
  if (t === 'review') return 'pages/course/list/list';
  return 'pages/forum/list/list';
}

// 处置时留一份内容快照。
//
// 为什么要多存这两个字段：确认违规之后内容是真删掉的，而「已处置」那一屏
// 和事后的复盘（有人来问「你们凭什么删我的帖」）都需要能看出**当时删的是哪条**。
// 只留一个 id 的话，那条记录等于什么都没留下 —— 而这恰恰是最需要凭据的时候。
// 只存标题和正文前 120 字：留证，不是留档；全文没必要跟着举报记录一起躺在库里。
function snapshotOf(rec, content) {
  const t = String((rec && rec.targetType) || 'post');
  if (t === 'chat' || t === 'profile') {
    return { title: t === 'chat' ? '私信骚扰举报' : '名片举报', desc: '' };
  }
  const title = String((content && content.title) || '').slice(0, 80);
  const body = String((content && content.content) || '').slice(0, 120);
  return {
    // 标题为空的内容（一句话帖 / 纯图帖）用正文开头顶上，别让归档里整列空白
    title: title || body || '（无标题内容）',
    desc: title ? body : ''
  };
}

// 已处置归档：确认 / 驳回之后，记录就从待办队列里消失了 —— 没有地方回看
// 「上周删了哪几条、驳回了什么」。平常用不上，被追问、被投诉、或者想复核自己
// 判得对不对的时候，这是唯一的凭据。
//
// 与队列同一套分组口径：一条内容一行，结果取最新那次处置。
// 只给审核员，和其他审核 action 一样在云端验身份。
async function reportArchive(openid, payload) {
  const err = await denyReason(openid);
  if (err) return { ok: false, msg: err };

  const scope = String((payload && payload.scope) || '');
  const where = (scope === 'confirmed' || scope === 'rejected')
    ? { status: scope }
    : { status: db.command.in(['confirmed', 'rejected', 'auto_dismissed']) };

  const res = await db.collection(COL_REPORTS).where(where)
    .orderBy('at', 'desc').limit(80).get().catch(() => ({ data: [] }));
  const groups = groupReports(res.data || []);

  const list = groups.map((g) => {
    const last = g.last || {};
    const confirmed = String(last.status || '') === 'confirmed';
    const autoDismissed = String(last.status || '') === 'auto_dismissed';
    return {
      gkey: g.key,
      repId: g.repId,
      repIds: g.repIds,
      targetId: g.targetId,
      targetType: g.targetType,
      targetOpenid: g.targetOpenid,
      confirmed: confirmed,
      statusText: autoDismissed ? '系统自动筛除·证据不足' : (confirmed ? '已确认违规' : '证据不足·已驳回'),
      reason: g.reason,
      reasons: g.reasons,
      detail: g.detail,
      time: g.time,
      reportCount: g.reportCount,
      // 老数据没有快照（这个字段是后加的），退回一个说明，别显示空白卡片
      title: String(last.snapTitle || ''),
      desc: String(last.snapDesc || ''),
      handledAt: String(last.handledAt || ''),
      noSnap: !last.snapTitle
    };
  });

  return { ok: true, list: list, isMod: true };
}

// 批量裁决：
//   reject —— 证据不足，驳回；内容如果在自动阶段被下了架，这里一并恢复
//   confirm —— 违规成立，内容保持下架或直接删除
// 批量裁决：reject=证据不足驳回；confirm=违规成立。
// 先按内容分组，再批量改举报状态，避免审核队列稍多时逐条串行查询把云函数拖超时。
async function resolveReports(openid, payload) {
  const err = await denyReason(openid);
  if (err) return { ok: false, msg: err };
  payload = payload || {};
  const decision = payload.decision || payload.action;
  const action = decision === 'confirm' ? 'confirm' : 'reject';
  let ids = payload.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map((x) => String(x || '')).filter(Boolean);

  if (action === 'reject' && payload.all) {
    const q = await db.collection(COL_REPORTS).where({ status: 'pending' }).limit(100).get()
      .catch(() => null);
    if (!q) return { ok: false, msg: '举报队列读取失败，请稍后重试', handled: 0 };
    ids = (q.data || []).map((r) => String(r._id || '')).filter(Boolean);
  }
  if (!ids.length) return { ok: true, msg: '没有待处理的举报', handled: 0 };

  // 一次取回全部待处理记录，而不是每个 id 单独查一次。
  const records = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const got = await db.collection(COL_REPORTS)
      .where({ _id: db.command.in(chunk) }).limit(100).get().catch(() => null);
    if (!got) return { ok: false, msg: '举报记录读取失败，请稍后重试', handled: 0 };
    records.push(...(got.data || []));
  }
  const pending = records.filter((r) => r && r.status === 'pending');
  if (!pending.length) return { ok: true, msg: '这些举报已经处理过了', handled: 0 };

  const groups = {};
  pending.forEach((r) => {
    const key = String(r.targetType || 'post') + '|' + String(r.targetId || r.target || '');
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  });

  let handled = 0;
  const stamp = now();
  for (const key of Object.keys(groups)) {
    const rows = groups[key];
    const first = rows[0];
    const person = first.targetType === 'chat' || first.targetType === 'profile';
    const cur = (first.targetId && !person) ? await fetchTarget(first.targetType, first.targetId) : null;
    const snap = snapshotOf(first, cur);
    const data = {
      status: action === 'confirm' ? 'confirmed' : 'rejected',
      handledBy: openid,
      handledAt: stamp,
      snapTitle: snap.title,
      snapDesc: snap.desc
    };
    const rowIds = rows.map((r) => String(r._id || '')).filter(Boolean);
    // 云数据库批量 update 有单次条数限制，按 20 条一组更新，避免只处理一半。
    for (let i = 0; i < rowIds.length; i += 20) {
      const chunk = rowIds.slice(i, i + 20);
      const w = await db.collection(COL_REPORTS)
        .where({ _id: db.command.in(chunk), status: 'pending' }).update({ data: data })
        .catch((e) => ({ err: e }));
      if (w && w.err) {
        // 兼容个别 SDK 对 in(_id) 更新的限制：退回逐条更新，但不再逐条查询。
        for (const id of chunk) {
          const one = await db.collection(COL_REPORTS)
            .where({ _id: id, status: 'pending' }).update({ data: data })
            .catch(() => null);
          if (one && !one.err) handled += 1;
        }
      } else {
        const n = Number(w && w.stats && (w.stats.updated || w.stats.updatedCount));
        handled += n || chunk.length;
      }
    }

    if (action === 'confirm') {
      if (!person && first.targetId) await removeContent(first.targetType, first.targetId);
    } else if (cur && cur.status === 'hidden' && String(cur.hiddenReason || '').indexOf('自动下架') === 0) {
      await setContentStatus(first.targetType, first.targetId, 'normal', '');
    }

    // 通知和日志是附加能力：不阻塞裁决回执，避免一条举报拖慢整批。
    rows.forEach((rec) => {
      pushNotify(rec.openid, {
        type: 'report',
        title: '你举报的内容已处理',
        body: action === 'confirm'
          ? '审核员确认了违规，感谢你帮忙维护这里'
          : '审核员核实后认为证据不足，这条没有处理',
        page: reportResultPage(rec, action)
      }).catch(() => {});
      logMod(openid, action === 'confirm' ? 'reportConfirm' : 'reportReject',
        rec.targetType, rec.targetId || rec.target, rec.reason).catch(() => {});
    });
  }

  return { ok: true, msg: action === 'confirm' ? '已确认违规' : '已驳回，内容已恢复', handled: handled };
}

// 我发的内容现在是什么状态（闲置 / 活动）—— 只回 id + 两个布尔。
//
// 为什么非要云端回答：被下架的内容不进公开列表，客户端那份缓存只记得
// 「上次看到的样子」，它根本不知道自己那条已经被暂停展示了。于是作者看到的是
// 一条在「我发布的」里正常显示、点进去却说「不见了」的东西，而且没有任何恢复入口。
//
// 某一侧没读到（集合没建 / 网络抖）就回 null，客户端据此「本地一个字都不动」：
// 绝不能让一次查询失败表现成「把作者的列表清空了」。
async function myContent(openid) {
  const pick = (x) => ({
    id: String(x.id || ''),
    hidden: x.hidden === true,
    deleted: x.deleted === true
  });
  const mineOf = (col) => db.collection(col).where({ openid: openid }).limit(100).get().catch(() => null);
  const mk = await mineOf(COL_MARKET);
  const ev = await mineOf(COL_EVENTS);
  // 被暂停展示的那几条要回完整内容：换台设备就是一份空缓存，只给 id 的话
  // 它在「我发布的」里根本不会出现 —— 恢复入口对「换过手机的人」等于不存在，
  // 而换设备恰恰是最容易撞上误伤的场景。这些是作者自己的内容，回给他没问题
  const pausedOf = (res) => (res && Array.isArray(res.data)
    ? res.data.filter((x) => x && x.id && x.hidden === true && x.deleted !== true)
    : null);
  return {
    ok: true,
    market: mk && Array.isArray(mk.data) ? mk.data.filter((x) => x.id).map(pick) : null,
    event: ev && Array.isArray(ev.data) ? ev.data.filter((x) => x.id).map(pick) : null,
    marketPaused: pausedOf(mk),
    eventPaused: pausedOf(ev)
  };
}

// 审核员手动恢复 / 下架单条内容，作者本人也能恢复自己被自动下架的
async function setStatus(openid, payload) {
  payload = payload || {};
  const targetId = String(payload.targetId || '');
  const targetType = normTargetType(payload.targetType);
  // 'deleted' 也认：举报自动处置要在作者 / 审核员的手机上同步标成已删除
  const status = (payload.status === 'hidden' || payload.status === 'deleted') ? payload.status : 'normal';
  if (!targetId) return { ok: false, msg: '参数缺失' };

  const content = await fetchTarget(targetType, targetId);
  if (!content) return { ok: false, msg: '内容不存在' };

  const mine = String(content.openid || content._openid || content.authorOpenid || '') === openid;
  const mod = await isModerator(openid);
  if (!mod && !mine) return { ok: false, msg: '只能处理自己的内容' };
  // 作者只能恢复展示，不能自行下架/删除；否则举报自动处置会被作者一键撤销。
  if (!mod && status !== 'normal') return { ok: false, msg: '只有审核员能下架或删除内容' };

  await setContentStatus(targetType, targetId, status,
    status === 'hidden' ? '审核员手动下架' : (status === 'deleted' ? '被多名同学举报，已自动删除' : ''));
  // 只有审核员的动作才留痕。作者自己下架自己的内容不算「审核操作」，
  // 记进去只会把日志冲成一堆噪音，真出事时反而找不到人
  if (!mine || await isModerator(openid)) {
    await logMod(openid, 'setStatus:' + status, targetType, targetId, mine ? '作者本人' : '审核员');
  }
  return {
    ok: true,
    msg: status === 'hidden' ? '已下架' : (status === 'deleted' ? '已标记为删除' : '已恢复展示')
  };
}

// 内容删除 / 更新统一走云函数：客户端 SDK 在安全规则下只能改删「自己创建」的记录，
// 且不允许 where().remove() 批量删除。示例帖的 _openid 是空的，「仅创建者可写」权限下
// 前端一条都删不掉，本地删了云端还在，下次同步又回来——「删了重进还在」就是它。
function isContentOwner(content, openid) {
  return [content.openid, content._openid, content.authorOpenid]
    .some((v) => v && v === openid);
}

async function hasContentRight(openid, content) {
  if (isContentOwner(content, openid)) return true;
  return isModerator(openid);
}

// 删除一条内容（帖子或评价），云函数是管理员身份，能删任何记录
// 管理员直删时，把这条内容相关、还没处理的举报一起归档。
//
// 不这么做的话：帖子已经删了，举报队列里还挂着一行「内容已不存在」，
// 审核员要么再点一次确认，要么永远留着 —— 直删省下的一步又被队列补回来了。
// 帖子被删时，它下面的留言也一起没了，所以留言举报（targetType=comment + postId）
// 也一并归档。只归档 pending，已经判过的举报不改写。
async function archivePendingReportsForDeleted(openid, targetType, targetId, content) {
  const rows = [];
  const q1 = await db.collection(COL_REPORTS)
    .where({ status: 'pending', targetType: targetType, targetId: targetId })
    .limit(100).get().catch(() => null);
  if (q1) rows.push(...(q1.data || []));
  if (targetType === 'post') {
    const q2 = await db.collection(COL_REPORTS)
      .where({ status: 'pending', targetType: 'comment', postId: targetId })
      .limit(100).get().catch(() => null);
    if (q2) rows.push(...(q2.data || []));
  }
  const seen = {};
  const pending = rows.filter((r) => {
    const id = String((r && r._id) || '');
    if (!id || seen[id]) return false;
    seen[id] = true;
    return true;
  });
  if (!pending.length) return 0;

  const snap = snapshotOf({ targetType: targetType }, content || {});
  const stamp = now();
  const data = {
    status: 'confirmed',
    handledBy: openid || '',
    handledAt: stamp,
    snapTitle: snap.title || '（内容已删除）',
    snapDesc: snap.desc || '',
    archiveReason: '管理员直接删除'
  };
  let handled = 0;
  const ids = pending.map((r) => String(r._id || '')).filter(Boolean);
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const w = await db.collection(COL_REPORTS)
      .where({ _id: db.command.in(chunk), status: 'pending' })
      .update({ data: data }).catch((e) => ({ err: e }));
    if (w && w.err) {
      // 与 resolveReports 一样，个别 SDK 对 in(_id) 更新有限制时退回逐条写
      for (const id of chunk) {
        const one = await db.collection(COL_REPORTS)
          .where({ _id: id, status: 'pending' }).update({ data: data })
          .catch(() => null);
        if (one && !one.err) handled += 1;
      }
    } else {
      const n = Number(w && w.stats && (w.stats.updated || w.stats.updatedCount));
      handled += Number.isFinite(n) ? n : chunk.length;
    }
  }

  // 通知举报人：内容已经处理掉了，别让他们在「待核实」里一直等。
  // 通知失败不影响删除本身。
  pending.forEach((rec) => {
    pushNotify(rec.openid, {
      type: 'report',
      title: '你举报的内容已处理',
      body: '管理员已删除该内容，感谢你帮忙维护这里',
      // 留言举报原来会落到帖子详情，但帖子已经删了，点进去只会看到「内容不见了」
      page: rec.targetType === 'comment' ? 'pages/forum/list/list' : reportResultPage(rec, 'confirm')
    }).catch(() => {});
  });
  return handled;
}
async function delContent(openid, payload) {
  payload = payload || {};
  const targetType = normTargetType(payload.targetType);
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const content = await fetchTarget(targetType, id);
  const mod = await isModerator(openid);
  if (!content) {
    // 内容已经被删掉，但可能还有没结的举报；审核员直删时顺手结掉
    const archived = mod
      ? await archivePendingReportsForDeleted(openid, targetType, id, null)
      : 0;
    return { ok: true, archivedReports: archived };
  }
  if (!mod && !isContentOwner(content, openid)) return { ok: false, msg: '没有权限删除这条内容' };
  const col = targetType === 'review' ? COL_REVIEWS
    : (targetType === 'market' ? COL_MARKET : (targetType === 'event' ? COL_EVENTS : COL_POSTS));
  await db.collection(col).where({ id: id }).remove().catch(() => {});
  // 留言现在存在独立集合里，删帖不会带走它们 —— 不清的话，
  // 那些留言会变成没有人能找到、也永远不会被删的孤儿文档，
  // 而它们的作者还以为「帖子删了我的话也就没了」
  if (targetType === 'post') {
    await db.collection(COL_POST_COMMENTS).where({ postId: id }).remove().catch(() => null);
    await db.collection(COL_COMMENT_VOTES).where({ postId: id }).remove().catch(() => null);
  }
  // 审核员直删：把这条内容相关的待处理举报一起归档，队列里不再留「内容已不存在」。
  // 作者自己删帖不归档 —— 那不等于「违规成立」，不能替举报人下结论。
  const archivedReports = mod
    ? await archivePendingReportsForDeleted(openid, targetType, id, content)
    : 0;
  // 真删是不可逆的那一刀，必须留痕：谁删的、删的是什么
  const detail = String(content.title || content.content || '').slice(0, 60)
    + (archivedReports ? '；归档举报 ' + archivedReports + ' 条' : '');
  await logMod(openid, 'delContent', targetType, id, detail);
  return { ok: true, archivedReports: archivedReports };
}

// 编辑评价：只允许作者改内容字段；状态和计数不再由这个客户端入口控制。
async function patchContent(openid, payload) {
  payload = payload || {};
  if (String(payload.targetType || '') !== 'review') {
    return { ok: false, msg: '该接口只允许修改课程评价' };
  }
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const content = await fetchTarget('review', id);
  if (!content) return { ok: false, msg: '内容不存在' };
  if (!(await hasContentRight(openid, content))) return { ok: false, msg: '没有权限修改这条内容' };

  const patch = payload.patch || {};
  const data = {};
  if (patch.score !== undefined) {
    const score = Number(patch.score);
    if (!Number.isFinite(score) || score < 1 || score > 5) return { ok: false, msg: '评分必须是 1 到 5 星' };
    data.score = score;
  }
  if (patch.content !== undefined) {
    const text = String(patch.content || '').trim().slice(0, 1000);
    const g = await guard(text);
    if (!g.ok) return { ok: false, msg: g.msg };
    data.content = text;
  }
  if (patch.tags !== undefined) {
    const tags = Array.isArray(patch.tags) ? patch.tags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8) : [];
    const g = await guard(tags.join(' '));
    if (!g.ok) return { ok: false, msg: g.msg };
    data.tags = tags;
  }
  if (patch.anonymous !== undefined) data.anonymous = !!patch.anonymous;
  if (patch.teacher !== undefined) {
    const teacher = String(patch.teacher || '').trim().slice(0, 20);
    const g = await guard(teacher);
    if (!g.ok) return { ok: false, msg: g.msg };
    data.teacher = teacher;
    if (teacher) {
      const hit = await db.collection(COL_TEACHERS).where({ name: teacher }).limit(1).get().catch(() => ({ data: [] }));
      data.teacherVerified = !!(hit.data && hit.data.length);
    } else {
      data.teacherVerified = false;
    }
  }
  if (patch.teacherScore !== undefined) {
    const score = Number(patch.teacherScore);
    if (!Number.isFinite(score) || score < 0 || score > 5) return { ok: false, msg: '老师评分必须是 0 到 5 星' };
    data.teacherScore = Math.round(score);
  }
  if (patch.status !== undefined) {
    if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能改内容状态' };
    const status = ['normal', 'hidden', 'deleted'].indexOf(String(patch.status)) >= 0 ? String(patch.status) : '';
    if (!status) return { ok: false, msg: '状态值无效' };
    data.status = status;
    data.hiddenReason = String(patch.hiddenReason || '').slice(0, 60);
  }
  if (!Object.keys(data).length) return { ok: true };
  data.updatedAt = now();
  const w = await db.collection(COL_REVIEWS).where({ id: id })
    .update({ data: data }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    return { ok: false, saved: false, msg: '评价没存住，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  if (!w || !w.stats || Number(w.stats.updated) < 1) {
    return { ok: false, saved: false, msg: '评价没存住，再试一次' };
  }
  if (data.status !== undefined) {
    await logMod(openid, 'patchStatus:' + data.status, 'review', id, String(data.hiddenReason || '').slice(0, 60));
  }
  return { ok: true };
}

// 帖子编辑：发完可改，改完重新过一遍审核。
// 为什么必须重新过审：先发一条干净的、攒够赞和评论，再把它改成广告 ——
// 这是绕过发布审核最省事的办法。改完只走 guard（屏蔽词 + 官方接口），
// 不做人工队列：改写频率低，真有问题举报会兜住。
async function postEdit(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const cur = await fetchTarget('post', id);
  if (!cur) return { ok: false, msg: '这条帖子已经不在了' };
  if (String(cur.authorOpenid || cur.openid || '') !== openid) {
    return { ok: false, msg: '只能改自己发的帖子' };
  }
  if (cur.status === 'deleted') return { ok: false, msg: '这条帖子已经被删除了' };

  const title = String(payload.title || '').trim().slice(0, 60);
  const content = String(payload.content || '').trim().slice(0, 2000);
  if (!title && !content) return { ok: false, msg: '标题和正文不能都是空的' };

  const g = await guardInBoard(cur.board, title, content);
  if (!g.ok) return { ok: false, msg: g.msg };

  const images = payload.images === undefined ? (cur.images || []) : sanitizeImages(payload.images, 'forum', 9);
  const mediaErr = await imageGate(images);
  if (mediaErr) return { ok: false, msg: mediaErr };
  const w = await byId(COL_POSTS, id).update({
    data: {
      title: title,
      content: content,
      images: images,
      editedAt: now(),
      // 改过就标出来：别人读到一段和记忆中不一样的文字时，
      // 至少知道它被改过，而不是怀疑自己记错了
      edited: true
    }
  }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    return { ok: false, saved: false, msg: '帖子没存住，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  if (!w || !w.stats || Number(w.stats.updated) < 1) {
    return { ok: false, saved: false, msg: '帖子没存住，再试一次' };
  }
  // 编辑后新增/替换的图片也要重新过媒体审核，否则可以先发干净内容再加违规图。
  if (images.length) {
    await submitMediaCheck(openid, images, { scene: 3, targetType: 'post', targetId: id }).catch(() => {});
  }
  return { ok: true, msg: '已保存' };
}

// 审核操作日志（只读）。留痕的意义在于「事后能回溯」，
// 所以这里只读不写、也不给删的接口 —— 能改的日志等于没有日志。
async function modLogs(openid, payload) {
  const err = await denyReason(openid);
  if (err) return { ok: false, msg: err };
  payload = payload || {};
  const limit = Math.max(1, Math.min(100, Number(payload.limit) || 50));
  const res = await db.collection(COL_MODLOGS)
    .orderBy('at', 'desc').limit(limit).get().catch(() => ({ data: [] }));
  return { ok: true, list: (res.data || []).map((r) => ({
    by: String(r.by || ''),
    act: String(r.act || ''),
    targetType: String(r.targetType || ''),
    targetId: String(r.targetId || ''),
    detail: String(r.detail || ''),
    time: String(r.time || '')
  })) };
}

/* ---------------- 内容写入（服务端权威校验） ---------------- */

// 微信官方内容安全接口。
// 屏蔽词是我们自己列的（社区自治），官方接口才是平台合规的底线 —— 真上架时审核会看这个。
// ⚠️ 接口没开通 / 调用失败时一律「放过」而不是「拦截」：
//    接口故障把正常内容全卡死，比漏掉一条的代价大得多。开通后在 diag 里能看到状态。
async function secCheck(text) {
  const s = String(text || '').trim();
  if (!s) return { ok: true };
  if (s.length > 2500) return { ok: false, msg: '内容太长了，拆成几条发吧' };
  if (!cloud.openapi || !cloud.openapi.security) return { ok: true, sec: 'unavailable' };
  try {
    const r = await cloud.openapi.security.msgSecCheck({ content: s });
    const sug = r && r.result && r.result.suggestion;
    if (sug === 'block') return { ok: false, msg: '内容可能包含违规信息，换个说法试试' };
    if (sug === 'review') return { ok: true, needReview: true };
    return { ok: true };
  } catch (e) {
    // 87093（敏感词库异常）/ 42001（token 过期）都不代表内容真的违规
    // 把报错带出来：diag 靠它区分「没权限」还是「接口抽风」，否则永远在猜
    const detail = String((e && (e.errMsg || e.errCode)) || (e && e.message) || e || '').slice(0, 200);
    console.error('[secCheck] msgSecCheck failed:', detail);
    return { ok: true, sec: 'error', secErr: detail };
  }
}

// 把数据库报错翻译成人话。
// 直接把 "-502005 database collection not exists" 抛给用户没人看得懂，
// 但把错误码带出去，前端就能提示「哪个集合还没建」，用户不用对着黑盒猜。
function dbErr(e) {
  const raw = String((e && (e.errMsg || e.message)) || e || '');
  const code = (raw.match(/-\d{6}/) || [''])[0];
  const tail = (raw.match(/-\d{6}\s*(.*)/) || [, ''])[1];
  return { code: code, msg: (tail || raw).slice(0, 160) };
}

// 所有 UGC 写入的统一关口：先过屏蔽词，再过官方接口。
// 前端那侧再怎么校验，绕过云函数直接写库也躲不过这一关。
async function guard(...parts) {
  const hit = checkText.apply(null, parts);
  if (!hit.ok) return hit;
  return secCheck(parts.join(' '));
}

// 发帖专用：按板块决定要不要放行「加群 / 留联系方式」那几个词。
// 官方内容安全接口（secCheck）照常过 —— 豁免的只是我们自己的词表，
// 涉黄涉赌那些官方接口自己会拦，不归这里管
async function guardInBoard(board, ...parts) {
  const hit = checkTextInBoard(board, ...parts);
  if (!hit.ok) return hit;
  return secCheck(parts.join(' '));
}

// 帖子类型：normal（默认）| topic（主题帖）。
// 主题帖只有标题、没有正文，具体信息全在评论区由同学自己补 ——
// 「浙工商同好群」这种贴用得着：标题写清楚要找什么，群号、二维码留给评论区。
//
// 为什么发这条帖子类型，而不是直接「正文留空就行」：
//   正文可空 ≠ 帖子可空。不加这一档，想发信息墙的人只能发个空正文的普通帖，
//   列表页看不出那是信息墙，同学点进去一脸茫然，评论区还不受任何约束。
//   有了类型，界面、排序、信息收集规则才能各自对上号。
function isTopicPost(p) {
  return String((p && p.kind) || '') === 'topic';
}

async function postAdd(openid, payload) {
  payload = payload || {};
  const p = payload.post || {};
  const title = String(p.title || '').trim();
  const content = String(p.content || '').trim();
  const topic = isTopicPost(p);
  // 投票帖：选项齐全才算数。它和主题帖一样正文可空 —— 投票的「内容」就是选项本身
  const voteOpts = (p.kind === 'vote' && p.vote && Array.isArray(p.vote.options))
    ? p.vote.options.slice(0, 8) : [];
  const isVote = voteOpts.length >= 2;
  const author = String(p.author || '浙小商').slice(0, 20);
  const voteText = isVote ? voteOpts.map((o) => String((o && o.label) || '')).join(' ') : '';
  // 图片提前清洗一次：它既是落库字段，也是「这条帖子算不算有内容」的判据
  const imgs = sanitizeImages(p.images, 'forum', 9);
  // 标题选填：普通帖可以只发一句话、只发一张图。
  // 主题帖和投票帖的信息主体就是标题本身（评论区、投票选项都挂在标题下），
  // 所以那两种仍然必须有标题 —— 没有标题就没有可依附的东西
  if (topic && !title) return { ok: false, msg: '给这个主题起个名字' };
  if (isVote && !title) return { ok: false, msg: '给投票起个标题' };
  if (title.length > 60) return { ok: false, msg: '标题最多 60 个字' };
  // 主题帖的定义就是「不带正文」：正文一旦填了，它就是个普通帖，
  // 拦下来不是刁难，是免得「信息墙」变成绕过正文审核的偏门
  if (topic && content) return { ok: false, msg: '主题帖不写正文，信息留给评论区' };
  // 普通帖：正文和图片至少占一样。图本身就是内容，
  // 逼着人给一张照片配文案，只会逼出「如题」这种废话
  if (!topic && !isVote && !content && !imgs.length) return { ok: false, msg: '写点什么再发吧' };
  if (!topic && content.length > 2000) return { ok: false, msg: '正文最多 2000 个字' };
  // 按板块校验：社团同好 / 活动组队这类地方，留群号联系方式是正常内容。
  // 主题帖照样过这道 —— 空正文不是免检牌，「求一个靠谱的代写」照样被拦
  const g = await guardInBoard(p.board, title, content, voteText, author);
  if (!g.ok) return { ok: false, msg: g.msg };
  const mediaErr = await imageGate(imgs);
  if (mediaErr) return { ok: false, msg: mediaErr };
  const doc = {
    id: String(p.id || ('p' + Date.now() + Math.floor(Math.random() * 1000))),
    board: String(p.board || ''),
    title: title,
    content: content,
    kind: topic ? 'topic' : (isVote ? 'vote' : 'normal'),
    // 作者身份一律以调用者为准，前端传什么都改不了
    author: author,
    // 头像在发帖那一刻拍一张快照存下来，和 author 昵称同一个道理：
    // 详情页要是不带这个，就得为每条帖子去 users 集合里回查一次头像，
    // 列表页几十条就是几十次查询。代价是换了头像之后老帖子还是旧头像 ——
    // 昵称本来就是这么处理的，两处口径一致，不会再冒出第三种「有的会更新有的不会」
    avatarUrl: safeAvatar(p.avatarUrl),
    authorOpenid: openid,
    openid: openid,
    time: now(),
    at: Date.now(),
    images: imgs,
    courseId: String(p.courseId || ''),
    courseName: String(p.courseName || ''),
    // 留言不再长在帖子文档里（见 COL_POST_COMMENTS），这里只留一个计数。
    // comments: [] 是给旧版前端留的兼容位，新代码不再读写它
    comments: [],
    commentCount: 0,
    commentsMigrated: true,
    likes: 0,
    likedBy: [],
    pinned: false,
    // 匿名只是「列表里不显示作者」，服务端照样认得出是谁写的，被举报能追到人
    anonymous: !!p.anonymous,
    status: 'normal'
  };
  // 投票数据服务端重新组装一遍：选项 id/标签/截止时间都以这里为准，
  // 别信客户端拼好的结构 —— voters 从空表开始，票数由 voteCast 从它重算
  if (isVote) {
    doc.vote = {
      options: voteOpts.map((o, i) => ({
        id: String(o.id || ('o' + (i + 1))),
        label: String(o.label || ('选项' + (i + 1))).slice(0, 30),
        votes: 0
      })),
      multiple: !!(p.vote && p.vote.multiple),
      deadlineAt: Number(p.vote && p.vote.deadlineAt) || Date.now() + 72 * 3600000,
      anonymous: !(p.vote && p.vote.anonymous === false),
      voters: {}
    };
  }
  // 写库成功/失败必须如实上报。以前这里 .catch(() => {}) 把一切吞掉照样返回 ok:true，
  // 前端就提示「发布成功」，内容却压根没进数据库 —— 用户看到的就是「写完好好的一转头没了」。
  // 数据库写入套 6 秒超时：集合没建 / 没权限 / 弱网时某些 sdk 版本会让 add() 一直 pending 不 reject，
  // 把整条 postAdd 拖到云端函数超时（默认 20s+），前端要等很久才拿到「云端暂时连不上」。
  // 6 秒内没写进去就按存储失败处理，前端 12s 超时前就能早失败、内容留本机、可重发
  const addPromise = db.collection(COL_POSTS).add({ data: doc }).catch((e) => ({ err: e }));
  const w = await Promise.race([
    addPromise,
    new Promise((resolve) => setTimeout(() => resolve({ err: { errMsg: '数据库写入超时(6s)' } }), 6000))
  ]);
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[postAdd] write failed:', d.code, d.msg);
    // saved:false 告诉前端「这是存储失败不是内容违规」，本地那份别删
    return { ok: false, saved: false, msg: '云端没存住', detail: (d.code + ' ' + d.msg).trim() };
  }
  // 带图的帖子提交异步图片安全审核（提交失败只是「这几张图没审」，不回收帖子）
  if (doc.images && doc.images.length) {
    await submitMediaCheck(openid, doc.images, {
      scene: 3, targetType: 'post', targetId: doc.id
    }).catch(() => {});
  }
  return { ok: true, post: doc };
}

// 投票记名：同一个 openid 只能投一次，票数永远从 voters 重算。
// 直接改库会绕过这层防重，所以投票必须走云函数（和发帖同一道理）
async function voteCast(openid, payload) {
  payload = payload || {};
  const postId = String(payload.postId || '');
  const ids = Array.isArray(payload.optionIds)
    ? payload.optionIds.map(String).slice(0, 8) : [];
  if (!postId || !ids.length) return { ok: false, msg: '参数缺失' };
  const snap = await db.collection(COL_POSTS).where({ id: postId }).get()
    .catch(() => null);
  const doc = snap && snap.data && snap.data[0];
  if (!doc || !doc.vote || !Array.isArray(doc.vote.options)) {
    return { ok: false, msg: '这条不是投票帖' };
  }
  const v = doc.vote;
  if (v.deadlineAt && Date.now() > Number(v.deadlineAt)) {
    return { ok: false, msg: '投票已结束' };
  }
  const valid = {};
  v.options.forEach((o) => { valid[o.id] = true; });
  const choose = ids.filter((x) => valid[x]);
  if (!choose.length) return { ok: false, msg: '选项无效' };
  const voters = v.voters && typeof v.voters === 'object' ? v.voters : {};
  if (Array.isArray(voters[openid]) && voters[openid].length) {
    return { ok: true, already: true };
  }
  voters[openid] = v.multiple ? choose : [choose[0]];
  // 票数从 voters 全量重算再一起写：计数和记录同源，永不打架
  const counts = {};
  Object.keys(voters).forEach((k) => {
    (voters[k] || []).forEach((o) => { counts[o] = (counts[o] || 0) + 1; });
  });
  const options = v.options.map((o) => ({
    id: o.id, label: o.label, votes: counts[o.id] || 0
  }));
  const u = await db.collection(COL_POSTS).where({ id: postId }).update({
    data: { 'vote.voters': voters, 'vote.options': options }
  }).catch((e) => ({ err: e }));
  if (u && u.err) {
    const d = dbErr(u.err);
    console.error('[voteCast] write failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '云端没存住', detail: (d.code + ' ' + d.msg).trim() };
  }
  return { ok: true };
}

// 一条内容最多能收多少条留言。
// 主题帖的价值在于「信息收得全」，但不限量的话它会在一小时内被同一个人刷满，
// 真正的群号被淹没在最底下 —— 这不是审核问题，是可用性问题
const COMMENT_CAP = 200;
// 同一个人对同一条内容，两次留言之间至少隔这么久。
// 连点发送、脚本刷屏都在这道闸上
const COMMENT_GAP_MS = 60 * 1000;
// 回复另算一档，比留言短得多：接话的节奏和「留一条信息」不一样，
// 一分钟一条的话一问一答根本聊不起来（见 postComment 里 ③ 的说明）
const REPLY_GAP_MS = 15 * 1000;
// 一条留言最多几张图。评论区不是相册：留「三张图 + 一句话」是为了
// 「群二维码 + 截图 + 地图」，再多就该自己发一条帖子了
const COMMENT_IMG_MAX = 3;

// 留言回复的层级上限：0 = 一级留言，1 = 二级回复，2 = 三级回复。
// 四级及以上一律折回三级（理由见 replyTargetOf）。
// ⚠️ 前端 utils/store-forum.js 里有一份同名的 REPLY_MAX_DEPTH，
//    改一边必须改另一边 —— 否则「手机上挂在一级、云端挂在二级」，
//    同一次回复在两端长成两副样子，而且只有刷新同步之后才看得出来
const REPLY_MAX_DEPTH = 2;

// 回复该挂在哪一层：和前端 replyTargetOf 同构。
//
// 前端算一遍是为了乐观显示（不用等网络就能看到挂在哪儿），
// 服务端再算一遍是因为它才是权威 —— 前端那份可以被改包绕过，
// 而「层级」是要落进库里的结构，不是展示细节。
//
// 注意这里只决定「挂在哪条文档下面」，不决定缩进：三级回复照样挂在二级那条
// 下面（parentId = 二级的 id，depth = 2），是前端 buildCommentTree 渲染时
// 才把它和二级回复拉平成一档。库里留着链条是为了「谁回谁」不丢
function replyTargetOf(comments, parentId) {
  const pid = String(parentId || '');
  const parent = pid ? (comments || []).find((c) => c.id === pid) : null;
  if (!parent) return { parentId: '', depth: 0 };
  const pd = Number(parent.depth) || 0;
  if (pd < REPLY_MAX_DEPTH) return { parentId: pid, depth: pd + 1 };
  // 已经在最深层：挂到它父下面（父必为上一级），「回复的是谁」照旧由 replyTo* 记着
  const up = String(parent.parentId || '');
  return { parentId: up, depth: REPLY_MAX_DEPTH };
}

// 回复该挂在哪 —— 服务端版。
//
// 和上面的纯函数是同一套算法，区别只在于「去哪拿父留言」：
// 拆表之后父留言是**一条文档**，读它一条就够，不用再把整份留言数组拉下来
// （以前那一步既是竞态的源头，也是大帖越读越慢的原因）。
//
// 三种「父不可用」都当一级留言处理，而不是报错：
// 父已被删 / 父属于别的帖子 / 父 id 是编的。报错会让用户卡在一个
// 本来跟他无关的状态里；降级成一级，话至少留下来了
async function resolveReplyTarget(postId, parentId) {
  const pid = String(parentId || '');
  if (!pid) return { parentId: '', depth: 0 };
  const got = await db.collection(COL_POST_COMMENTS).doc(pid).get().catch(() => null);
  const parent = got && got.data && !Array.isArray(got.data) ? got.data : null;
  if (!parent) return { parentId: '', depth: 0 };
  // 跨帖挂载必须挡住：parentId 由客户端传，不校验的话 A 帖的一级留言
  // 可以被挂到 B 帖下面，删 B 帖时跟着被清掉
  if (String(parent.postId || '') !== postId) return { parentId: '', depth: 0 };
  if (parent.removed) return { parentId: '', depth: 0 };
  const t = replyTargetOf([parent], pid);
  // 顺手把父留言的正文带出去：回复提醒的第二个字段（模板里叫「原评论」）
  // 要显示我被回复的那句话。这一条文档本来就已经读出来了，
  // 为了再拿一次 content 往回调一次库，等于白跑一趟网络
  t.parentContent = String(parent.content || '').slice(0, 40);
  // 回复通知的目标必须来自父留言本身，不能信客户端传的 replyToOpenid。
  t.parentAuthorOpenid = String(parent.authorOpenid || parent.openid || '');
  t.parentAuthor = String(parent.author || '').slice(0, 20);
  return t;
}

// 一条内容现在有多少条留言。
// 优先读帖子上的 commentCount（每次增删都原子增减），读不到再数一遍集合，
// 都没有（老数据）才退回帖子里的旧数组 —— 三层兜底，省得因为一次字段缺失
// 就把「收满 200 条」的闸当成 0，让一个已经爆掉的墙继续收
async function commentCountOf(post) {
  const n = Number(post && post.commentCount);
  if (Number.isFinite(n) && n >= 0 && post.commentCount !== null && post.commentCount !== undefined) {
    return n;
  }
  const c = await db.collection(COL_POST_COMMENTS)
    .where({ postId: String(post.id || ''), removed: false }).count().catch(() => null);
  if (c && typeof c.total === 'number') return c.total;
  return Array.isArray(post.comments) ? post.comments.length : 0;
}

// 一条内容下的全部留言（未删的），按时间从早到晚。
//
// 排序在内存里做，不写 orderBy：where(postId) + orderBy(at) 在没建复合索引的
// 环境里会直接查询失败，被 catch 成空数组 —— 表现就是「帖子一条留言都没有」。
// 一个帖子的留言最多 COMMENT_CAP 条，内存排一次的开销远小于这个风险
async function listCommentsOfPost(postId) {
  // 云函数端单次 get 默认只回 100 条（上限 1000）。一条信息墙最多 200 条留言，
  // 正好卡在默认值之上 —— 不分页就会**悄悄少给一半**，而且不报错。
  // 这里按 100 一页自己翻，比把 limit 顶到 1000 更稳：单个文档再大也不会
  // 因为一次返回太多而被截断
  const PAGE = 100;
  const out = [];
  let skip = 0;
  while (out.length < COMMENT_CAP + 50) {
    const res = await db.collection(COL_POST_COMMENTS)
      .where({ postId: String(postId || '') })
      .skip(skip).limit(PAGE)
      .get().catch(() => null);
    const data = (res && res.data) || [];
    for (let i = 0; i < data.length; i += 1) out.push(data[i]);
    if (data.length < PAGE) break;
    skip += PAGE;
  }
  return out
    .filter((c) => c && !c.removed)
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
}

// 老数据惰性迁移：帖子的 comments 数组 → post_comments 集合。
//
// 不做一次性脚本，是因为没有任何地方能在「所有人都不在线」的时候跑它；
// 而只要有人打开这个帖子，迁移就完成了。抢占用一条带条件的 update：
// where(commentsMigrated != true) 只有第一个请求能 update 成功（stats.updated === 1），
// 其余请求直接返回，不会重复写。
//
// 只有**全部**写成功才清掉原数组。中途失败就留着 —— 原数组是唯一的副本，
// 清掉就真没了（这条比「尸体字段占空间」严重得多）
async function migrateLegacyComments(post) {
  const postId = String((post && post.id) || '');
  if (!postId) return;
  const legacy = Array.isArray(post.comments) ? post.comments.filter((c) => c && c.id) : [];
  if (!legacy.length) return;
  if (post.commentsMigrated === true) {
    // 标记说迁过了，数组却还在：上次清空那一步失败了。清掉即可（集合里已有权威数据）
    await db.collection(COL_POSTS).where({ id: postId })
      .update({ data: { comments: db.command.remove() } }).catch(() => null);
    return;
  }
  const lock = await db.collection(COL_POSTS)
    .where({ id: postId, commentsMigrated: db.command.neq(true) })
    .update({ data: { commentsMigrated: true } }).catch(() => null);
  const won = lock && lock.stats && lock.stats.updated > 0;
  if (!won) return; // 别人正在迁，这次直接用他迁出来的结果
  let failed = 0;
  for (const c of legacy) {
    const doc = Object.assign({}, c, {
      postId: postId,
      // 老留言可能只有云端自动写入的 _openid
      authorOpenid: String(c.authorOpenid || c._openid || ''),
      parentId: String(c.parentId || ''),
      depth: Number(c.depth) || 0,
      replyToOpenid: String(c.replyToOpenid || ''),
      replyToAuthor: String(c.replyToAuthor || ''),
      images: Array.isArray(c.images) ? c.images : [],
      likes: Number(c.likes) || 0,
      dislikes: Number(c.dislikes) || 0,
      removed: !!c.removed,
      at: Number(c.at) || 0
    });
    delete doc._openid;
    delete doc._id;
    const w = await db.collection(COL_POST_COMMENTS)
      .doc(String(c.id)).set({ data: doc }).catch((e) => ({ err: e }));
    if (w && w.err) failed += 1;
  }
  if (failed) {
    console.error('[migrateLegacyComments] partial:', postId, failed + '/' + legacy.length);
    // 标记退回未迁状态，下次打开重试（已经写进去的那些是 set，重写幂等）
    await db.collection(COL_POSTS).where({ id: postId })
      .update({ data: { commentsMigrated: false } }).catch(() => null);
    return;
  }
  await db.collection(COL_POSTS).where({ id: postId }).update({
    data: {
      comments: db.command.remove(),
      commentCount: legacy.filter((c) => !c.removed).length
    }
  }).catch(() => null);
}

// 评论也走云函数：① 服务端过审 ② 顺便给作者推订阅消息。
// 客户端直连 patch 评论数组既能绕过审核，也发不出通知。
async function postComment(openid, payload) {
  payload = payload || {};
  const postId = String(payload.postId || '');
  const content = String(payload.content || '').trim().slice(0, 300);
  // 配图：只认上传到本小程序 comment/ 目录下的云文件（白名单见 sanitizeImages）。
  // 信息墙最常见的留言是「群二维码 + 一句说明」，光靠文字根本表达不了
  const images = sanitizeImages(payload.images, 'comment', COMMENT_IMG_MAX);
  const wantedId = String(payload.id || '');
  const commentId = /^[A-Za-z0-9_-]{1,64}$/.test(wantedId) ? wantedId : ('c' + Date.now() + Math.floor(Math.random() * 1000));
  if (!postId) return { ok: false, msg: '参数缺失' };
  const existed = await db.collection(COL_POST_COMMENTS).doc(commentId).get().catch(() => null);
  if (existed && existed.data && !Array.isArray(existed.data)) {
    if (String(existed.data.authorOpenid || '') === openid) {
      return { ok: true, comment: existed.data, deduped: true };
    }
    return { ok: false, msg: '留言 id 冲突，再试一次' };
  }
  // 文字和图片至少有一个。带了图却一张都没通过白名单 = 上传没成功 ——
  // 这时要说「图没传上去」，而不是甩一句「说点什么再发吧」：
  // 用户明明选了图，被告知「你什么都没写」只会一脸茫然地再点一次发送
  if (!content && !images.length) {
    if (payload.images && payload.images.length) {
      return { ok: false, msg: '图片没上传成功，重新选一次' };
    }
    return { ok: false, msg: '说点什么再发吧' };
  }
  const mediaErr = await imageGate(images);
  if (mediaErr) return { ok: false, msg: mediaErr };
  // 纯图留言没有文字可过词表 —— 和私信一样，图片的合规走另一条通道（imgSecCheck），
  // 这里不拦。有文字的部分一分钟也不放过
  if (content) {
    const g = await guard(content);
    if (!g.ok) return { ok: false, msg: g.msg };
  }

  const hit = await db.collection(COL_POSTS).where({ id: postId }).limit(1).get().catch(() => ({ data: [] }));
  const rec = hit.data && hit.data[0];
  if (!rec) return { ok: false, msg: '这条内容已经不存在了' };

  // 老帖子第一次被写入前先把旧数组搬进集合：不搬的话，新留言进集合、
  // 旧留言还在帖子里，两边各存一半 —— 而看的那一端只认一边，另一半就消失了
  await migrateLegacyComments(rec);

  // 回复的挂载点在这里做最后一次归一化：前端算的那份只是乐观显示，
  // 库里存什么由服务端说了算。
  // ⚠️ 必须放在下面三道闸**之前** —— 它们都要按「这是第几层」分别对待
  const where = await resolveReplyTarget(postId, payload.parentId);
  // 信息墙的三道闸。普通帖的评论区不设防也过得去，
  // 但主题帖就是把别人的联系方式聚到一处 —— 它是全网最容易被拿来刷的地方，
  // 不设闸等于给贴广告的人发了一张不用审查的通行证。
  //
  // ① 总量：一条内容收满就收手，让下一个人另开一条，别让最后几条沉到底下
  const total = await commentCountOf(rec);
  if (total >= COMMENT_CAP) {
    return { ok: false, msg: '这条主题已经收满 ' + COMMENT_CAP + ' 条了，换一条发吧' };
  }

  // 同一个人在一条内容下的留言，一次取一页足够判重与判频率：
  // 取最近 50 条而不是全量，是因为一条爆掉的信息墙有 200 条留言，
  // 每次都把它们全读一遍，这条链路的耗时会被别人的流量拖垮
  const mineRes = await db.collection(COL_POST_COMMENTS)
    .where({ postId: postId, authorOpenid: openid })
    .limit(50).get().catch(() => ({ data: [] }));
  const mine = (mineRes.data || []).filter((c) => c && !c.removed);

  // ② 重复：同一个人对同一条内容**一级留言**只收一次同样的信息。
  //    留错群号、群满了再补一个，那是有用的；把同一个群号连发二十遍刷屏，不是。
  //
  //    分两种情况比：有文字按文字，纯图按图片组。
  //    不能一律比 content —— 纯图留言的 content 都是空串，
  //    那样第二条纯图留言会被判成「这条你留过了」，一个人永远只能发一条图。
  //
  //    ⚠️ 只对一级留言判重：回复里「好的」「+1」「我也是」本来就会重复，
  //    按内容去重会让接话的人被莫名其妙地挡回去（频率闸才是回复该走的那道闸）
  if (where.depth === 0) {
    const dup = mine.some((c) => {
      if ((Number(c.depth) || 0) !== 0) return false;
      if (content) return String(c.content || '').trim() === content;
      const prev = Array.isArray(c.images) ? c.images : [];
      return prev.length > 0 && prev.join('|') === images.join('|');
    });
    if (dup) return { ok: false, msg: '这条信息你留过了，换一条吧' };
  }

  // ③ 频率：一级留言一分钟一条，回复十五秒一条。
  //    分开算是因为两者节奏不同：留言是「我留一条信息」，回复是「我接一句」——
  //    拿留言的闸去卡回复，一问一答都聊不下去，而回复恰恰是评论区最该鼓励的
  const gapMs = where.depth > 0 ? REPLY_GAP_MS : COMMENT_GAP_MS;
  const sameLevel = mine
    .filter((c) => (Number(c.depth) || 0) === where.depth)
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  const last = sameLevel[0];
  if (last && Date.now() - (Number(last.at) || 0) < gapMs) {
    return { ok: false, msg: where.depth > 0 ? '慢一点，稍后再回一句' : '慢一点，一分钟以后再留下一条' };
  }

  const replyToOpenid = String(where.parentAuthorOpenid || '');
  const replyToAuthor = String(where.parentAuthor || '').slice(0, 20);
  const authorName = String(payload.author || '浙小商').slice(0, 20);
  const ng = await guard(authorName, replyToAuthor);
  if (!ng.ok) return { ok: false, msg: ng.msg };
  const comment = {
    id: commentId,
    // 留言属于哪条内容 —— 拆表之后这个字段就是「外键」，
    // 少了它，删帖时不知道该清哪些留言，commentList 也不知道该查谁
    postId: postId,
    author: authorName,
    // 和发帖同一个道理：留言也把头像拍一张快照存进留言里。
    // 老留言没有这个字段 → 前端退回「文字头像」，不会渲染出一条空白的头像框
    avatarUrl: safeAvatar(payload.avatarUrl),
    authorOpenid: openid,
    content: content,
    // 云存储 fileID 数组（最多 COMMENT_IMG_MAX 张），前端直接当 image 的 src 用
    images: images,
    // 回复链的四个字段。parentId / depth 决定挂载与缩进，
    // replyTo* 决定界面上那句「回复 @某某」写谁 ——
    // 三级折回二级之后它们不再同指一条，所以必须分开存
    parentId: where.parentId,
    depth: where.depth,
    replyToOpenid: replyToOpenid,
    replyToAuthor: replyToAuthor,
    // 赞踩计数：从 0 起算，权威值由 commentVote 从记名表数出来后回写
    likes: 0,
    dislikes: 0,
    // 软删标记。物理删掉的话，申诉时连「你们删的是哪句话」都核对不了；
    // 留着原文（界面按 removed 过滤掉）才能让人问一句「凭什么」
    removed: false,
    time: now(),
    at: Date.now()
  };
  // 写不进去必须如实说：原来这里 .catch 掉了错误照样 return ok:true，
  // 同学看到的永远是「评论成功」，刷新才发现根本没留下来
  const cw = await db.collection(COL_POST_COMMENTS).doc(comment.id)
    .set({ data: comment }).catch((e) => ({ err: e }));
  if (cw && cw.err) {
    const d = dbErr(cw.err);
    console.error('[postComment] write failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '没加上，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  // 计数单独维护，且用原子自增：几个人的留言同时进来时，各自 inc 一次，
  // 不会像「读出来 +1 再写回」那样互相覆盖（那正是这次拆表要根治的病）
  await db.collection(COL_POSTS).where({ id: postId })
    .update({ data: { commentCount: db.command.inc(1) } }).catch(() => null);

  // 纯图评论：图片走异步安全审核（提交在写库之后，命中违规时再把那条留言摘掉）
  if (images.length) {
    await submitMediaCheck(openid, images, {
      scene: 2,             // 2 = 评论
      targetType: 'comment',
      // 用 postId|commentId 拼一个复合目标：回执回来时才知道该摘哪条留言的哪张图
      targetId: postId + '|' + comment.id
    }).catch(() => {});
  }

  // 自己评论自己不发通知。
  // 回复时通知的**是被回复的那个人**而不是帖主 —— 楼上问了句「群满了吗」，
  // 有人回了「满了」，该知道的是提问的人，不是发帖的人。
  // 没有明确的被回复人（回复的是一级留言）才回到「通知帖主」这条老路
  const authorOid = String(rec.openid || rec.authorOpenid || rec._openid || '');
  const notifyOid = replyToOpenid || authorOid;
  // 两种场景走两个模板，别图省事合成一个：
  //   reply   —— 我的留言被回复：第二行要显示**我那条留言**（模板里叫「原评论」）
  //   comment —— 我的帖子被留言：第二行要显示**帖子标题**（模板里叫「文章标题」）
  // 合成一个的后果是：帖子标题被塞进「原评论」那一行，收到的人看不懂在说什么
  const isReply = Boolean(replyToOpenid);
  if (notifyOid && notifyOid !== openid) {
    const who = String(payload.author || '同学').slice(0, 12);
    const preview = (content || '[图片]').slice(0, 20);
    const pageUrl = 'sub/forum/detail/detail?id=' + postId;
    if (isReply) {
      sendSubMsg(notifyOid, 'reply', {
        page: pageUrl,
        fields: {
          thing1: { value: (who + ' 回复了你').slice(0, 20) },
          // 拿不到父留言正文（父子链被降级成一级）时退回帖子标题，
          // 那一格至少不是空的 —— 空字段微信会整条拒发
          thing2: { value: (where.parentContent || String(rec.title || '你的留言')).slice(0, 20) },
          thing3: { value: preview },
          time4: { value: now() }
        }
      });
    } else {
      sendSubMsg(notifyOid, 'comment', {
        page: pageUrl,
        fields: {
          thing1: { value: (who + ' 留言了你的帖子').slice(0, 20) },
          thing2: { value: (String(rec.title || '你发布的帖子').slice(0, 20)) || '你发布的帖子' },
          thing3: { value: preview },
          time4: { value: now() }
        }
      });
    }
    // 站内通知：订阅消息是一次性的，用户没授权就收不到 ——
    // 通知中心是这条链路的兜底，也是「我的帖子」那枚红点之外唯一的汇总入口
    await pushNotify(notifyOid, {
      type: 'reply',
      // 回复留言时措辞要换：收到的人是被回复的那个，
      // 写「有人回复了你的帖子」会让他以为是自己帖子下的新留言
      title: isReply ? '有人回复了你的留言' : '有人回复了你的帖子',
      body: (content || '[图片]').slice(0, 60),
      page: pageUrl,
      targetId: postId,
      // 云函数可能因为超时被客户端重试；同一条评论只应该有一条通知。
      eventKey: 'reply_' + String(comment.id || commentId || '')
    });
  }
  return { ok: true, comment: comment, commentCount: total + 1 };
}

// 删掉一条留言。
//
// 这个口子是为「信息墙」开的，但它对普通帖也有效 —— 发完发现说错了想撤回来，
// 总比等审核员来处理强。
//
// 谁能删，按下面三档认，服务端这里是权威：
//   ① 留言的作者本人（我留错了，我来撤）；
//   ② 这条内容的作者（信息墙的主人，唯一有动力维护它的人）；
//   ③ 审核员（别人留了广告，帖主没空处理）。
// 认不出就只有一句提示 —— 以前「自己的帖子删不掉」的坑就是少这一层校验造成的。
async function commentRemove(openid, payload) {
  payload = payload || {};
  const postId = String(payload.postId || '');
  const commentId = String(payload.commentId || '');
  if (!postId || !commentId) return { ok: false, msg: '参数缺失' };

  const hit = await db.collection(COL_POSTS).where({ id: postId }).limit(1).get().catch(() => ({ data: [] }));
  const rec = hit.data && hit.data[0];
  if (!rec) return { ok: false, msg: '这条内容已经不存在了' };
  // 老帖子上的留言还在旧数组里时，先搬进集合 —— 否则这里找不到它
  await migrateLegacyComments(rec);

  const got = await db.collection(COL_POST_COMMENTS).doc(commentId).get().catch(() => null);
  const target = got && got.data && !Array.isArray(got.data) ? got.data : null;
  // 已经删过的不算错：前端可能连点了两下，第二下让它安静地成功就行
  if (!target || String(target.postId || '') !== postId) {
    return { ok: false, msg: '这条留言已经不在了' };
  }
  if (target.removed) return { ok: true, removed: 0, already: true };

  const isAuthorOfPost = String(rec.openid || rec.authorOpenid || rec._openid || '') === openid;
  const isAuthorOfComment = String(target.authorOpenid || target._openid || '') === openid;
  const isMod = await isModerator(openid);
  if (!isAuthorOfComment && !isAuthorOfPost && !isMod) {
    return { ok: false, msg: '只有本人、帖主或审核员能删这条留言' };
  }

  // 连子回复一起撤：二级回复长在父留言下面，父没了它就成了一句
  // 「回复 @某某」却找不到被回复的那条 —— 留着比删掉更糟。
  // 逐层收而不是只收一层：层级以后放开也不用回来改
  const del = await softRemoveCommentTree(postId, commentId, {
    by: openid,
    // by 的不同含义要留在数据里：以后申诉时审核员第一个要问的就是
    // 「这条是谁删的」—— 作者自删、帖主清理、系统判违规，三种处置完全不同
    reason: isAuthorOfComment ? '作者自删' : (isMod ? '审核员删除' : '帖主删除'),
    // 本人自删没有申诉的意义（自己说自己判错了？），所以不给他开申诉入口
    appealable: !isAuthorOfComment
  });
  if (!del.ok) return { ok: false, removed: 0, msg: '没删掉，再试一次' };

  // 不是自己删的，一定要让作者知道：以前留言被删是完全静默的 ——
  // 他下次打开发现自己那条没了，只会以为是小程序坏了
  if (!isAuthorOfComment) {
    await notifyCommentRemoved(rec, target, isMod ? '审核员判定违规' : '帖主认为不合适', openid).catch(() => {});
  }
  return { ok: true, removed: del.removed, commentCount: Math.max(0, (await commentCountOf(rec)) - del.removed) };
}

// 留言的处置判定：**不自动删，只统计**。
//
// 留言没有「下架」这个中间态 —— 它长在帖子的留言列表里，removed 一置就是从所有人
// 眼前消失，跟删除没有区别。所以它和帖子遵守同一条规矩：**删除一律人工**。
// 这跟以前不一样：以前 3 人举报就自动删（冷启动 2 人），代价是误删一条
// 认真写的群号，作者只有一次申诉的机会，而原文已经看不到了。
//
// 这里仍然把「几个人说」「有没有人指认高敏」「内容自己踩没踩词」算出来 ——
// 队列要按这个排序，审核员要知道先看哪一条。
async function decideCommentAction(post, comment, commentId, excludeOpenid) {
  // 与帖子同一套计票口径：一个人只算一票（见 report-votes.js 的 countVoices）。
  // 留言这边以前同样按记录条数数，一个人换理由就能把一条留言删掉
  const reports = await recentReports(commentId);
  const voices = countVoices(reports, excludeOpenid, MOD_RULES.HIGH_RISK);
  // 留言自己踩没踩屏蔽词：信息墙的正文是空的，能藏脏东西的地方只有留言本身，
  // 这条信号比「有没人写说明」更硬
  // ⚠️ 没命中时这个函数返回的是 { ok: true }，根本没有 hit 字段 ——
  //    直接 .hit.length 会让整个举报流程当场抛错（返回 undefined 给前端，
  //    同学点了举报什么都没发生），所以这里必须兜一下
  const blocked = (checkTextInBoard(
    post.board, '', String((comment && comment.content) || '')
  ).hit || []).length > 0;

  return {
    del: false,       // 永远不删：删除是审核员的事
    total: voices.total,
    risky: voices.risky,
    blocked: blocked
  };
}

// 举报一条留言：只记录 + 进人工队列，**不当场删**。
//
// 这跟以前不一样。以前「3 人举报 → 自动删」，理由是运营一个人盯不过来；
// 但代价是：误删一条认真写的群号，作者只有一次申诉机会，而原文已经看不到了 ——
// 申诉要核对原文，原文却没了。所以现在删除一律人工，举报只负责把
// 「几个人在说、说的什么」摆到审核员面前。
async function commentReport(openid, payload) {
  payload = payload || {};
  const postId = String(payload.postId || '');
  const commentId = String(payload.commentId || '');
  const rawReason = String(payload.reason || '');
  const reason = REPORT_REASONS.indexOf(rawReason) >= 0 ? rawReason : '其他';
  const detail = String(payload.detail || '').slice(0, 200);
  if (!postId || !commentId) return { ok: false, msg: '没指名要举报哪条留言' };

  // ① 这条留言得真的存在 —— 对着一条已经不在的留言投票，票数永远进不了统计
  const rec = await byId(COL_POSTS, postId).limit(1).get().catch(() => ({ data: [] }));
  const post = rec.data && rec.data[0];
  if (!post) return { ok: false, msg: '这条内容已经不存在了' };
  await migrateLegacyComments(post);
  const got = await db.collection(COL_POST_COMMENTS).doc(commentId).get().catch(() => null);
  const target = got && got.data && !Array.isArray(got.data) ? got.data : null;
  if (!target || String(target.postId || '') !== postId) {
    return { ok: false, msg: '这条留言已经不在了' };
  }
  if (target.removed) return { ok: true, removed: false, msg: '这条留言已经被处理了', status: 'confirmed' };

  // ② 反滥用：跟帖子同一个口径。观察期里的人投的票照样记、照样进队列
  const ab = await abuseState(openid);

  // ③ 查重：同一个人对同一条留言**只算一票**。
  //
  //    ⚠️ 旧版查重键里带着 reason，而理由有 8 种 —— 同一个人换 3 个理由
  //    就能把一条留言推过删除线。理由只该影响「怎么判」，不该影响「有几个证人」。
  //    换理由时改原来那一票、不新增；**at 不动**（动了等于每次换理由都重新计时）
  const dup = await db.collection(COL_REPORTS)
    .where({ openid: openid, targetId: commentId, targetType: 'comment' })
    .limit(1).get().catch(() => ({ data: [] }));
  const oldRep = (dup.data || [])[0];
  if (oldRep) {
    // 已经结掉的那一票不再翻案：换理由重投等于把结案的东西拉回队列
    if (oldRep.status !== 'pending') {
      return { ok: true, msg: '这条你已经举报过了', dup: true };
    }
    if (String(oldRep.reason || '') === reason) {
      return { ok: true, msg: '你已经举报过这条留言了', dup: true };
    }
    await db.collection(COL_REPORTS).doc(oldRep._id)
      .update({ data: { reason: reason, detail: detail || String(oldRep.detail || '') } })
      .catch(() => {});
  } else {
    await addReportDoc({
      openid: openid,
      target: String(target.authorOpenid || target._openid || ''),
      targetId: commentId,
      postId: postId,
      targetType: 'comment',
      reason: reason,
      detail: detail,
      status: 'pending', // pending → rejected（证据不足）/ confirmed（违规成立）
      time: now(),
      at: Date.now(),
      // 观察期里投的这一票：留痕、进队列，但数人数时不算它
      reviewOnly: !!ab.limited,
      triggered: false
    });
  }

  const verdict = await decideCommentAction(
    post, target, commentId, ab.limited ? openid : ''
  );
  return {
    ok: true, removed: false, total: verdict.total,
    reviewOnly: !!ab.limited,
    // 处理状态：写进 reports 集合的是什么就回什么，前端据此把按钮写成
    // 「已举报·待核实」。举报是一条有去有回的流程，给它一个看得见的去处
    status: 'pending',
    block: verdict.blocked,
    // 现在不会有「自动删掉」这个结果了，文案必须如实：
    // 说的是「交给老师核实」，不是「已经处理」。反过来写，用户会以为留言已经没了
    msg: ab.limited
      ? '举报已收到，会由老师优先核实'
      : '举报已提交，会由老师核实后处理'
  };
}

// 留言的赞 / 踩。
//
// 和帖子点赞同一套记账，但记名表是独立的一张：留言数组要整份下发到客户端，
// 把「谁赞了哪条」也塞进去等于把全校的投票名单发给每个人，
// 而且帖子文档有 1MB 上限，先撞线的就是它。
//
// 三条硬规矩：
//   ① 态度一个人一格（记名表 upsert）—— 赞踩互斥由数据结构保证，不是靠两处代码互相清；
//   ② 再点同一边就是取消；
//   ③ 计数从记名表数人头得出，不是「上次的值 +1」——历史上记错过，
//      下一次点赞也会自动把数字修正回来
function commentVoteDocId(commentId, openid) {
  return String(commentId || '') + '_' + String(openid || '');
}

async function commentVote(openid, payload) {
  payload = payload || {};
  const postId = String(payload.postId || '');
  const commentId = String(payload.commentId || '');
  const kind = payload.kind === 'dislike' ? 'dislike' : 'like';
  if (!postId || !commentId) return { ok: false, msg: '参数缺失' };

  const rec = await byId(COL_POSTS, postId).limit(1).get().catch(() => ({ data: [] }));
  const post = rec.data && rec.data[0];
  if (!post) return { ok: false, msg: '这条内容已经不存在了' };
  await migrateLegacyComments(post);
  // 只读这一条留言。以前是把整份留言数组读下来再找下标 ——
  // 一次点赞要搬 200 条留言，而且回写时会把别人刚发的留言一起盖掉
  const got = await db.collection(COL_POST_COMMENTS).doc(commentId).get().catch(() => null);
  const target0 = got && got.data && !Array.isArray(got.data) ? got.data : null;
  if (!target0 || String(target0.postId || '') !== postId) {
    return { ok: false, msg: '这条留言已经不在了' };
  }
  if (target0.removed) return { ok: false, msg: '这条留言已经不在了' };
  // 不能给自己的留言点赞：那是一条「我觉得自己说得对」的票，
  // 计数里混进这种票，数字就不再是别人的评价了
  if (String(target0.authorOpenid || target0._openid || '') === openid) {
    return { ok: false, msg: '不能给自己的留言点赞' };
  }

  // ① 我现在的态度：从记名表读（唯一事实来源）
  const voteId = commentVoteDocId(commentId, openid);
  const mine = await db.collection(COL_COMMENT_VOTES).doc(voteId).get().catch(() => null);
  const cur = (mine && mine.data) ? (mine.data.kind === 'dislike' ? 'dislike' : 'like') : '';
  // 再点同一个 = 取消；点另一边 = 换边（覆盖同一格，不存在并存）
  const next = cur === kind ? '' : kind;

  // ② 写记名表：doc().set() 是 upsert，同一个 _id 写多少次都只有一条（幂等）
  let werr = null;
  if (next) {
    const w = await db.collection(COL_COMMENT_VOTES).doc(voteId).set({
      data: {
        postId: postId, commentId: commentId, openid: openid,
        kind: next, at: Date.now()
      }
    }).catch((e) => ({ err: e }));
    if (w && w.err) werr = w.err;
  } else {
    await db.collection(COL_COMMENT_VOTES).doc(voteId).remove().catch(() => null);
  }

  let likes = Number(target0.likes) || 0;
  let dislikes = Number(target0.dislikes) || 0;
  if (!werr) {
    // ③ 计数从记名表统计：不是累加，是当场数一遍。
    //    统计失败（集合刚建、权限抖动）就退回留言上的旧值 ——
    //    直接写 0 等于把全校点过的赞一夜清零
    const [lc, dc] = await Promise.all([
      db.collection(COL_COMMENT_VOTES).where({ commentId: commentId, kind: 'like' }).count().catch(() => null),
      db.collection(COL_COMMENT_VOTES).where({ commentId: commentId, kind: 'dislike' }).count().catch(() => null)
    ]);
    if (lc && typeof lc.total === 'number') likes = lc.total;
    if (dc && typeof dc.total === 'number') dislikes = dc.total;
  } else {
    // ④ 降级路径：comment_votes 集合没建 / 写不进去。
    //    这时候绝不能让点赞整个失效 —— 那正是「点了一点反应都没有」的来源。
    //    按态度在旧值上加减一次：并发下可能重复计数，但总比按钮装死强。
    //    控制台建好集合后不用改代码，下次点击自动回到强一致模式
    const d = dbErr(werr);
    console.error('[commentVote] vote table unavailable, fallback:', d.code, d.msg);
    if (cur === 'like') likes = Math.max(0, likes - 1);
    if (cur === 'dislike') dislikes = Math.max(0, dislikes - 1);
    if (next === 'like') likes += 1;
    if (next === 'dislike') dislikes += 1;
  }

  // ⑤ 只回写这一条的计数字段。文档级更新是原子的 ——
  //    以前整份覆盖 comments 数组，会把别人并发发出的留言一起抹掉
  await db.collection(COL_POST_COMMENTS).doc(commentId)
    .update({ data: { likes: likes, dislikes: dislikes } }).catch(() => null);

  return {
    ok: true,
    liked: next === 'like',
    disliked: next === 'dislike',
    likes: likes,
    dislikes: dislikes,
    // 走了降级路径要如实说：本机那一下生效了，但计数不保证精确
    degraded: !!werr
  };
}

/* ============ 留言：软删除、通知、申诉 ============ */

// 留言删除一律走「软删」：把 removed 置 true，文档留着。
//
// 物理删掉会有两个后果，都不可接受：
//   ① 作者来申诉时，没有任何东西能核对「你们删的到底是哪句话」；
//   ② 误判之后无法恢复 —— 自动处置是机器判的，机器会错。
// 软删的代价是集合里留着一批不可见的文档，用 removed 过滤即可，
// 一条留言最多几百字节，这个代价换「可复核」值。
async function softRemoveCommentTree(postId, commentId, opts) {
  opts = opts || {};
  // 子孙回复要一起撤：二级回复挂在父下面，父没了它就成了
  // 「回复 @某某」却找不到被回复的那条 —— 留着比删掉更糟。
  // 逐层收而不是只收一层：层级以后放开也不用回来改
  const all = await listCommentsOfPost(postId);
  const doomed = {};
  doomed[String(commentId)] = true;
  let grew = true;
  while (grew) {
    grew = false;
    all.forEach((c) => {
      if (doomed[c.id]) return;
      if (doomed[String(c.parentId || '')]) { doomed[c.id] = true; grew = true; }
    });
  }
  const ids = Object.keys(doomed);
  const at = Date.now();
  const w = await db.collection(COL_POST_COMMENTS)
    .where({ _id: db.command.in(ids) })
    .update({
      data: {
        removed: true,
        removedAt: at,
        // 谁删的、为什么删 —— 申诉与复核全靠这两个字段
        removedBy: String(opts.by || ''),
        removedReason: String(opts.reason || '').slice(0, 40),
        appealable: !!opts.appealable
      }
    }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[softRemoveCommentTree]', d.code, d.msg);
    return { ok: false, removed: 0 };
  }
  // 计数原子减。可能的漂移（删一条不存在的留言、并发）在下次重算时归位，
  // 比「先读再写」把别人的留言盖掉要安全得多
  await db.collection(COL_POSTS).where({ id: postId })
    .update({ data: { commentCount: db.command.inc(-ids.length) } }).catch(() => null);
  return { ok: true, removed: ids.length, ids: ids };
}

// 告诉留言作者「你那条没了」，并给出申诉入口。
//
// 以前删除是完全静默的：他下次打开发现自己那条不见了，只会以为小程序坏了，
// 或者以为别人看不到只有自己看不到。自动处置尤其需要这一步 ——
// 机器判错了，人得有机会说一句话
async function notifyCommentRemoved(post, comment, reason, by) {
  const to = String((comment && comment.authorOpenid) || '');
  if (!to) return;
  // 自己删的不通知：他知道自己干了什么，再弹一条「你的留言已被移除」很荒唐
  if (String(by || '') && String(by) === to) return;
  const postId = String((post && post.id) || '');
  const cid = String((comment && comment.id) || '');
  const snippet = String((comment && comment.content) || '').trim() || '[图片留言]';
  await pushNotify(to, {
    type: 'comment_removed',
    title: '你的一条留言已被移除',
    body: snippet.slice(0, 40) + ' · ' + (reason || '违规'),
    // 申诉页带着留言 id 去：那条留言已经不在列表里了，
    // 没有 id 就无从指向「你在说哪一条」
    page: 'pages/forum/comment-appeal/comment-appeal?postId='
      + encodeURIComponent(postId) + '&commentId=' + encodeURIComponent(cid),
    targetId: cid
  });
}

// 拉一条内容下的留言。
//
// 详情页不再从帖子文档里拿留言（那里已经没有了），改成按需拉一次。
// 顺带做老数据迁移：第一次有人打开这个帖子时，旧数组就被搬进集合
async function commentList(openid, payload) {
  payload = payload || {};
  const postId = String(payload.postId || '');
  if (!postId) return { ok: false, msg: '参数缺失' };
  const rec = await byId(COL_POSTS, postId).limit(1).get().catch(() => ({ data: [] }));
  const post = rec.data && rec.data[0];
  if (!post) return { ok: false, msg: '这条内容已经不存在了' };
  await migrateLegacyComments(post);
  const list = await listCommentsOfPost(postId);
  // 这条内容算不算匿名。口径与前端 isAnonPost、本文件 isAnonContent 一致：
  // 字段为真，或发在树洞板块 —— 三处只要有一处不同口径，
  // 就会出现「云端按匿名脱敏、前端按实名渲染」这类谁也不报错的错位
  const anon = !!post.anonymous || String(post.board || '') === ANON_BOARD;

  // 顺手对账。commentCount 是全站唯一靠 inc 增量维护的计数，
  // 任何一次写入失败（或迁移中断）都会留下永久偏差：列表写着「12 条评论」，
  // 点进去只有 9 条，而且永远不会自己好。
  // 这里手上正好有准确值，谁打开过这条内容就顺手修正一次 ——
  // 比单开一个每天全表扫一遍的定时任务便宜得多，也只在真正有人看的地方生效
  const real = list.length;
  const stored = Number(post.commentCount);
  if (!Number.isFinite(stored) || stored !== real) {
    await db.collection(COL_POSTS).where({ id: postId })
      .update({ data: { commentCount: real } }).catch(() => null);
  }

  return {
    ok: true,
    comments: anon ? maskAnonComments(list) : list,
    commentCount: real,
    // 客端用它判断「要不要显示空状态」：拉失败时不能显示「还没有评论」
    degraded: false
  };
}

// 匿名帖的留言，在下发之前把真名摘掉。
//
// 前端拿到之后也会换成代号，但那是**遮住屏幕**：真名还在响应体里，
// 开发者工具或抓包一看就有。既然承诺了匿名，就不能靠客户端自觉。
//
// 这里换的是空串而不是代号 —— 代号由前端按 openid 算，词表只有一份。
// 云端再存一份 120 个词的池子，迟早和前端漂移，那种「同一个帖子两处算出的
// 名字不一样」的 bug 极难发现。openid 保留：判断「是不是我留的」「能不能删」
// 「举报定位作者」都要它。
//
// 三个字段都要清：author 是昵称、avatarUrl 是脸、replyToAuthor 会以
// 「回复 @张三」的形式印在界面上 —— 漏掉最后这个，前面两个等于白清。
function maskAnonComments(list) {
  return (list || []).map((c) => Object.assign({}, c, {
    author: '',
    avatarUrl: '',
    replyToAuthor: ''
  }));
}

// 申诉窗口：7 天。太短来不及看到，太长则原文要一直留着
const APPEAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// 申诉页要展示的东西：这条留言的原文、为什么被删、还能不能申诉
async function commentAppealInfo(openid, payload) {
  payload = payload || {};
  const commentId = String(payload.commentId || '');
  if (!commentId) return { ok: false, msg: '参数缺失' };
  const got = await db.collection(COL_POST_COMMENTS).doc(commentId).get().catch(() => null);
  const c = got && got.data && !Array.isArray(got.data) ? got.data : null;
  if (!c) return { ok: false, msg: '这条留言已经找不到了' };
  // 只有作者本人能看：原文里可能有别人的联系方式
  if (String(c.authorOpenid || '') !== String(openid)) {
    return { ok: false, msg: '这不是你的留言' };
  }
  const postId = String(c.postId || payload.postId || '');
  const prec = await byId(COL_POSTS, postId).limit(1).get().catch(() => ({ data: [] }));
  const post = prec.data && prec.data[0];
  const appeal = await db.collection(COL_COMMENT_APPEALS).doc(commentId).get().catch(() => null);
  const a = appeal && appeal.data && !Array.isArray(appeal.data) ? appeal.data : null;
  const removedAt = Number(c.removedAt) || 0;
  return {
    ok: true,
    comment: {
      id: commentId,
      postId: postId,
      content: String(c.content || ''),
      images: Array.isArray(c.images) ? c.images : [],
      time: c.time || '',
      removed: !!c.removed,
      removedReason: String(c.removedReason || ''),
      removedAt: removedAt
    },
    postTitle: String((post && post.title) || ''),
    // 申诉窗口：7 天。太短来不及看到，太长则原文要一直留着
    canAppeal: !!c.removed && !!c.appealable
      && removedAt > 0 && (Date.now() - removedAt) < APPEAL_WINDOW_MS
      && !a,
    appeal: a ? { status: a.status, reason: a.reason, time: a.time } : null
  };
}

// 提交申诉。
//
// 申诉不是「一键复活」：它只是把这件事放回人工队列。自动处置是人数堆出来的，
// 人数可以被组织；申诉的价值是让「被组织起来的那批人」有一个对手方。
// 所以这里不自动恢复，只记录，等审核员在审核页里看
async function commentAppeal(openid, payload) {
  payload = payload || {};
  const commentId = String(payload.commentId || '');
  const reason = String(payload.reason || '').trim().slice(0, 300);
  if (!commentId) return { ok: false, msg: '参数缺失' };
  if (reason.length < 10) return { ok: false, msg: '说说为什么觉得判错了（至少 10 个字）' };

  const got = await db.collection(COL_POST_COMMENTS).doc(commentId).get().catch(() => null);
  const c = got && got.data && !Array.isArray(got.data) ? got.data : null;
  if (!c) return { ok: false, msg: '这条留言已经找不到了' };
  if (String(c.authorOpenid || '') !== String(openid)) {
    return { ok: false, msg: '这不是你的留言' };
  }
  if (!c.removed) return { ok: false, msg: '这条留言还在，不用申诉' };
  if (!c.appealable) return { ok: false, msg: '这条留言不支持申诉' };
  const removedAt = Number(c.removedAt) || 0;
  if (!removedAt || Date.now() - removedAt >= APPEAL_WINDOW_MS) {
    return { ok: false, msg: '已经过了申诉期限（7 天）' };
  }
  const exist = await db.collection(COL_COMMENT_APPEALS).doc(commentId).get().catch(() => null);
  if (exist && exist.data && !Array.isArray(exist.data)) {
    return { ok: true, already: true, msg: '这条已经申诉过了，老师会看到的' };
  }

  // 一人一条留言一次申诉，_id = commentId 天然做幂等 ——
  // 连点两下不会写出两条，也不用额外的查重查询
  const w = await db.collection(COL_COMMENT_APPEALS).doc(commentId).set({
    data: {
      commentId: commentId,
      postId: String(c.postId || ''),
      openid: openid,
      author: String(c.author || '').slice(0, 20),
      content: String(c.content || '').slice(0, 300),
      images: Array.isArray(c.images) ? c.images.slice(0, 3) : [],
      removedReason: String(c.removedReason || ''),
      removedAt: removedAt,
      reason: reason,
      status: 'pending', // pending → accepted（恢复）/ rejected（维持）
      time: now(),
      at: Date.now()
    }
  }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[commentAppeal]', d.code, d.msg);
    return { ok: false, msg: '没提交上，再试一次' };
  }
  return { ok: true, msg: '申诉已提交，老师会重新看一遍' };
}

// 审核员：恢复一条被删的留言（申诉通过，或人工复核发现判错了）
async function commentRestore(openid, payload) {
  payload = payload || {};
  const commentId = String(payload.commentId || '');
  if (!commentId) return { ok: false, msg: '参数缺失' };
  if (!(await isModerator(openid))) return { ok: false, msg: '没有权限' };
  const got = await db.collection(COL_POST_COMMENTS).doc(commentId).get().catch(() => null);
  const c = got && got.data && !Array.isArray(got.data) ? got.data : null;
  if (!c) return { ok: false, msg: '这条留言已经找不到了' };
  if (!c.removed) return { ok: true, already: true };
  await db.collection(COL_POST_COMMENTS).doc(commentId).update({
    data: {
      removed: false,
      restoredAt: Date.now(),
      restoredBy: openid,
      // 恢复之后这条不能再被同一批人「再删一次」，所以申诉入口一并关掉
      appealable: false
    }
  }).catch(() => null);
  await db.collection(COL_POSTS).where({ id: String(c.postId || '') })
    .update({ data: { commentCount: db.command.inc(1) } }).catch(() => null);
  // 申诉记录跟着结案，审核页不会一直挂着一条已经处理完的
  await db.collection(COL_COMMENT_APPEALS).doc(commentId)
    .update({ data: { status: 'accepted', resolvedAt: Date.now(), resolvedBy: openid } })
    .catch(() => null);
  const prec = await byId(COL_POSTS, String(c.postId || '')).limit(1).get().catch(() => ({ data: [] }));
  await notifyCommentRemoved(prec.data && prec.data[0], c, '申诉通过，留言已恢复', openid).catch(() => {});
  return { ok: true };
}

// 审核队列里的留言申诉
async function appealQueue(openid, payload) {
  payload = payload || {};
  if (!(await isModerator(openid))) return { ok: false, msg: '没有权限' };
  const res = await db.collection(COL_COMMENT_APPEALS)
    .where({ status: 'pending' }).limit(50).get().catch(() => ({ data: [] }));
  const list = (res.data || [])
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return { ok: true, list: list };
}

async function reviewAdd(openid, payload) {
  payload = payload || {};
  const r = payload.review || {};
  const courseId = String(r.courseId || '');
  const content = String(r.content || '').trim();
  const score = Number(r.score) || 0;
  const tags = Array.isArray(r.tags) ? r.tags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8) : [];
  const teacher = String(r.teacher || '').trim();
  const courseName = String(r.courseName || '').trim().slice(0, 40);
  const author = String(r.author || '浙小商').slice(0, 20);
  // 「添加老师评价」是独立入口：只评老师、不挂课程（courseId 为空）。
  // 只要老师名和课程 id 有一个就放行 —— 两个都没有才是真不知道该挂哪儿
  if (!courseId && !teacher) return { ok: false, msg: '这条评价挂在哪个课程 / 哪位老师下？' };
  if (score < 1 || score > 5) return { ok: false, msg: '打个分吧，1 到 5 星' };
  if (content.length > 1000) return { ok: false, msg: '评价最多 1000 个字' };
  const g = await guard(content, teacher, courseName, tags.join(' '), author);
  if (!g.ok) return { ok: false, msg: g.msg };
  // 幂等去重（一次评价出两条记录的修复，双保险之二）：
  // 前端 12 秒超时后用户重试、或双击竞态漏过来时，同一份内容会被再写一条。
  // 这里按「同一作者 + 同一课程 + 同一内容」查最近一条，10 分钟内视为重复，
  // 直接返回已入库的那条，不再新增 —— 重试是幂等的，库里永远只有一条。
  // ⚠️ 这里原来写的是 where(...).orderBy('at','desc')，同样踩了复合索引的坑：
  // 没建索引时查询直接失败 → catch 成 null → 去重形同虚设，
  // 于是「连点两下出两条一样评价」的锅又回来了。改成单字段 where + 内存取最新。
  const RECENT_MS = 10 * 60 * 1000;
  const dupWhere = courseId
    ? { openid: openid, courseId: courseId, content: content }
    : { openid: openid, teacher: teacher, content: content };
  const dupRes = await db.collection(COL_REVIEWS)
    .where(dupWhere).limit(10).get().catch(() => null);
  const dupHit = (dupRes && dupRes.data && dupRes.data.length)
    ? dupRes.data.slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))[0]
    : null;
  if (dupHit && Date.now() - (Number(dupHit.at) || 0) < RECENT_MS) {
    return { ok: true, review: dupHit, deduped: true };
  }
  // 这里刻意不校验「课程在不在库里」：误伤的代价是同学给一门明明存在的课发不出评价，
  // 比几条孤儿评价严重得多。删课时 dropCourseDoc 已经把评价一起清了，够用
  const doc = {
    id: String(r.id || ('r' + Date.now() + Math.floor(Math.random() * 1000))),
    courseId: courseId,
    courseName: courseName,
    score: score,
    content: content,
    tags: tags,
    // 任课老师：评价可以只针对某一位老师。同学填的名字不会自动变成「官方认定」，
    // 名录里查得到只是打一个 verified:true 的标记，方便别人一眼看出这人真是浙工商的。
    teacher: teacher.slice(0, 20),
    teacherVerified: false,
    // 给这位老师的分，和上面给课程的分是两档。留 0 = 没单独给老师打分，
    // 聚合老师均分时跳过，不把「没表态」的人算成「差评」。
    teacherScore: Math.max(0, Math.min(5, Math.round(Number(r.teacherScore) || 0))),
    // 匿名只是「前端不显示作者」，服务端照样认得出是谁写的，方便事后追责
    anonymous: !!r.anonymous,
    openid: openid,
    author: author,
    time: now(),
    at: Date.now(),
    status: 'normal',
    helpful: 0
  };
  // 同 postAdd：写不进去绝不能报成功，否则前端撤掉本地、用户以为发过了
  const w = await db.collection(COL_REVIEWS).add({ data: doc }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[reviewAdd] write failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '云端没存住', detail: (d.code + ' ' + d.msg).trim() };
  }
  // 写了老师名就顺手校一次名录：命中就打个标记，列表里显示「✓ 官方名录」。
  // 不查就不打，同学自己加的老师照样能用，只是没有那个勾。
  if (doc.teacher) {
    const hit = await db.collection(COL_TEACHERS)
      .where({ name: doc.teacher }).limit(1).get().catch(() => ({ data: [] }));
    if (hit.data && hit.data.length) {
      await db.collection(COL_REVIEWS).where({ id: doc.id }).update({
        data: { teacherVerified: true }
      }).catch(() => {});
      doc.teacherVerified = true;
    }
  }
  return { ok: true, review: doc };
}

// 认出「一门课在云端是哪条记录」。为什么不能只认 id：
//   ① 现在这条：courseAdd 会把客户端给的 id 一起存下来，前端那个 id 就是云端这个 id；
//   ② 老数据： courseAdd 早先没存 id，云端只有自动生成的 _id，
//              而前端手里那个 id 是它自己生成的字符串，两边对不上；
//   ③ 只认得课名（老客户端、或从分享链接进去）。
// 认不出课 = 删不掉课，误加的那门课就永久挂在那里，正是要修的那件事。
// 所以按 id / _id / 课名依次兜底，但同名多条时必须停下交给人来决定，
// 不能闭眼删掉其中一个 —— 那可能删掉的是别人正经加的课。
async function findCourseDoc(courseId, name) {
  const id = String(courseId || '').trim();
  const nm = String(name || '').trim();
  const conds = [];
  if (id) conds.push({ id: id });
  if (nm) conds.push({ name: nm });
  if (!conds.length) return { notFound: true };

  const res = await db.collection(COL_COURSES)
    .where(db.command.or(conds)).limit(20).get().catch(() => ({ data: [] }));
  const all = (res && res.data) || [];

  const byId = all.filter((c) => id && (String(c.id) === id || String(c._id) === id));
  if (byId.length === 1) return { doc: byId[0] };

  const byName = all.filter((c) => String(c.name) === nm);
  if (byName.length === 1) return { doc: byName[0] };
  if (byName.length > 1) {
    // 同名好几分：同学自己加的那条优先（它有 openid），仍然分不清就拒绝
    const userMade = byName.filter((c) => !c.builtin && (c.openid || c._openid));
    if (userMade.length === 1) return { doc: userMade[0] };
    return { ambiguous: true };
  }
  return { notFound: true };
}

async function courseAdd(openid, payload) {
  payload = payload || {};
  const c = payload.course || {};
  const name = String(c.name || '').trim();
  if (!name) return { ok: false, msg: '课程名得写一下' };
  if (name.length > 60) return { ok: false, msg: '课程名最多 60 个字' };
  const g = await guard(name, String(c.teacher || ''), String(c.term || ''));
  if (!g.ok) return { ok: false, msg: g.msg };
  // 客户端那个 id 必须一起存：云端这条和本地那份说的是同一门课，
  // 只留一份不给 id，后面按 id 就永远查不到它，误加的课也跟着永远删不掉
  const doc = {
    id: String(c.id || '').trim().slice(0, 40),
    name: name,
    teacher: String(c.teacher || '').slice(0, 30),
    credit: Number(c.credit) || 0,
    college: String(c.college || '').slice(0, 30),
    term: String(c.term || '').slice(0, 30),
    description: String(c.description || '').slice(0, 200),
    // 课程类型：同学手挑的优先（过一遍名册认不认得出），没挑才按课名推断 ——
    // 官方课目录里几乎全是专业课，光靠课名推不出「体育课 / 思政课」，
    // 让加课的人自己说一句是最靠谱的那份数据
    ctype: require('./course-type.js').pickCourseType(c.ctype, name),
    builtin: false,
    openid: openid,
    at: Date.now()
  };
  // 同学共建课程同样不能「写失败还报成功」，否则全校都看不到这门课
  const w = await db.collection(COL_COURSES).add({ data: doc }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[courseAdd] write failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '云端没存住', detail: (d.code + ' ' + d.msg).trim() };
  }
  return { ok: true, course: doc };
}

// 删除同学自己误加的课程。
// 两条硬规矩：
//   ① 只能删自己加的那门（比对 openid），别人的课删不掉；
//   ② 官方课程（builtin / 没有 openid 的）一律删不了 —— 那是全校共用的课程库。
// 认课交给 findCourseDoc：id 对不上的老数据（云端只有 _id）也得能删，
// 不然误加的课云端留着、下次同步又冒出来，就是「删了重进还在」。
async function courseRemove(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '').trim();
  const name = String(payload.name || '').trim();
  if (!id && !name) return { ok: false, msg: '参数缺失' };

  const f = await findCourseDoc(id, name);
  if (f.notFound) {
    // 云端没有不代表删不掉：可能只在本地加过。前端据此照常清掉本地那份。
    return { ok: true, removed: 0, notFound: true };
  }
  if (f.ambiguous) return { ok: false, msg: '同名课程有好几条，删不掉这门，请联系管理员处理' };
  const course = f.doc;
  if (course.builtin) return { ok: false, msg: '官方课程不能删除' };

  const owner = String(course.openid || course._openid || '');
  if (!owner || owner !== openid) return { ok: false, msg: '只能删除自己添加的课程' };

  // 永远按云端主键 _id 删：按「本地那份 id」删会误伤别的记录
  const w = await db.collection(COL_COURSES).where({ _id: course._id })
    .remove().catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[courseRemove] remove failed:', d.code, d.msg);
    return { ok: false, msg: '云端没删掉', detail: (d.code + ' ' + d.msg).trim() };
  }
  return { ok: true, removed: 1 };
}

/* ---------------- 误加课程的「申请删除」 ---------------- */

// 为什么需要这个：加课程的人一旦毕业 / 换号 / 只是懒得管，这门误加的课就永远挂在库里，
// 谁都删不掉（删课只认加课人的 openid）。所以再开一条路：
// 其他同学也能提交删除申请，同一个人只能投一次，凑够票数自动清掉。
const COURSE_REQ_VOTES = 3;          // 几个人同意就自动删（除加课人本人一票即算）
const COURSE_REQ_DAYS = 14;          // 申请超过这个天数没人再附和，自动作废，不留一堆僵尸申请

// 删课时顺手收拾干净：挂在这门课下的评价 + 它的申请记录一起走。
// 评价不一起删会留在库里变成孤儿（courseId 指向一门已经不存在的课），
// 哪天 id 复用就串到别人课下去了。
async function dropCourseDoc(key, course) {
  const docId = String((course && course._id) || '');
  if (!docId) return;
  const idField = String((course && course.id) || '');
  // 评价里记的 courseId 是前端那个 id，可能跟云端主键对不上，两种都要扫一遍
  if (idField) await db.collection(COL_REVIEWS).where({ courseId: idField }).remove().catch(() => {});
  await db.collection(COL_REVIEWS).where({ courseId: docId }).remove().catch(() => {});
  if (key) await db.collection(COL_COURSE_REQS).where({ id: courseReqId(key) }).remove().catch(() => {});
}

// 把一门课从云端彻底拿走：课程本身 + 挂在它下面的评价 + 它的申请记录。
// 漏掉评价会留下无主数据，漏掉申请记录会让下次又重新开始凑票。
async function dropCourseCloud(course) {
  const docId = String((course && course._id) || '');
  if (!docId) return { ok: true };
  const del = await db.collection(COL_COURSES).where({ _id: docId })
    .remove().catch((e) => ({ err: e }));
  if (del && del.err) {
    const d = dbErr(del.err);
    return { ok: false, msg: '云端没删掉', detail: (d.code + ' ' + d.msg).trim() };
  }
  await dropCourseDoc(String((course && course.id) || '') || docId, course);
  return { ok: true };
}

// 申请的主键：一门课一条记录，避免同一门课攒出十几条申请
function courseReqId(courseId) {
  return 'cr' + String(courseId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
}

// 顺手清掉过期的申请：每次读写前扫一遍，比单独挂定时任务省事
async function pruneCourseReqs(rows) {
  const now = Date.now();
  const dead = (rows || []).filter((r) => r.at && (now - Number(r.at)) > COURSE_REQ_DAYS * 86400000);
  for (let i = 0; i < dead.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await db.collection(COL_COURSE_REQS).where({ id: dead[i].id }).remove().catch(() => {});
  }
  const deadIds = dead.map((r) => r.id);
  return (rows || []).filter((r) => deadIds.indexOf(r.id) < 0);
}

// 投票 + 达票自动删。返回里的 removed 告诉前端「这门课已经没了，把本地那份也清掉」
async function courseReqVote(openid, payload) {
  payload = payload || {};
  const courseId = String(payload.courseId || '').trim();
  const name = String(payload.name || '').trim();
  const reason = String(payload.reason || '').trim().slice(0, 100);
  if (!courseId && !name) return { ok: false, msg: '参数缺失' };

  const f = await findCourseDoc(courseId, name);
  if (f.notFound) {
    // 云端本来就没有（可能只在本地加过）：告诉前端照常清本地那份
    return { ok: true, removed: 1, notFound: true, msg: '这门课云端本来就没有，已清理' };
  }
  if (f.ambiguous) return { ok: false, msg: '同名课程有好几条，删不掉这门，请联系管理员处理' };
  const course = f.doc;
  if (course.builtin) return { ok: false, msg: '官方课程不能删除' };

  // 申请记录按云端主键认课：前端那个 id 在老数据里对不上云端主键，
  // 用它当主键会让同一门课攒出好几条互不相认的申请，票永远凑不齐
  const key = String(course.id || course._id || '');
  const owner = String(course.openid || course._openid || '');
  // 加课人自己点一下就删，不用凑票 —— 他要删，没理由拦
  if (owner && owner === openid) {
    const d = await dropCourseCloud(course);
    if (!d.ok) return { ok: false, saved: false, msg: d.msg, detail: d.detail };
    return { ok: true, removed: 1, owner: true };
  }

  const rid = courseReqId(key);
  const q = await db.collection(COL_COURSE_REQS).where({ id: rid }).limit(1).get().catch(() => ({ data: [] }));
  const rec = (q.data || [])[0];
  const voters = rec && Array.isArray(rec.voters) ? rec.voters.slice() : [];
  if (voters.indexOf(openid) >= 0) {
    return { ok: true, already: true, votes: voters.length, need: COURSE_REQ_VOTES };
  }
  // 审核员一票即可：这条通道本来就是给「管理员收尾」用的
  const mod = await isModerator(openid);

  // 攒票用 push 追加，不整份读出来再整份写：两个同学同时点投票时，
  // 后写的那份会盖掉先写的，voters 停在 1 条，永远凑不满 3 票，
  // 误加的课程就靠这条通道删不掉（这段代码的初衷）
  if (!rec) {
    const nd = {
      id: rid, courseId: key, courseName: String(course.name || '').slice(0, 40),
      voters: [openid], reasons: reason ? [reason.slice(0, 60)] : [],
      at: Date.now(), lastAt: Date.now(), status: 'open'
    };
    const aw = await db.collection(COL_COURSE_REQS).add({ data: nd }).catch((e) => ({ err: e }));
    if (aw && aw.err) {
      const d = dbErr(aw.err);
      console.error('[courseReqVote] add failed:', d.code, d.msg);
      return { ok: false, saved: false, msg: '申请没记上，再试一次', detail: (d.code + ' ' + d.msg).trim() };
    }
    const enough = mod || 1 >= COURSE_REQ_VOTES;
    if (enough) return finishCourseReq(course, rid, 1, mod);
    return { ok: true, votes: 1, need: COURSE_REQ_VOTES, byMod: mod };
  }

  // 认业务主键 id 而不是 doc()：doc() 得靠 _id 找，而这条记录是 add 出来的，
  // 两边对不上就会写出一条「同课两份」的孪生记录，票数各算各的永远凑不齐
  const uw = await db.collection(COL_COURSE_REQS).where({ id: rid }).update({
    data: {
      voters: db.command.push(openid),
      reasons: reason ? db.command.push(reason.slice(0, 60)) : db.command.push([]),
      lastAt: Date.now()
    }
  }).catch((e) => ({ err: e }));
  if (uw && uw.err) {
    const d = dbErr(uw.err);
    console.error('[courseReqVote] write failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '投票没记上，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  // 票数以库里那份为准：客户端怎么刷都刷不出第二票
  const fq = await db.collection(COL_COURSE_REQS).where({ id: rid }).limit(1).get().catch(() => ({ data: [] }));
  const fqr = fq && fq.data ? fq.data[0] : null;
  const count = fqr && Array.isArray(fqr.voters) ? fqr.voters.length : 0;
  const enough = mod || count >= COURSE_REQ_VOTES;
  if (enough) return finishCourseReq(course, rid, count, mod);
  return { ok: true, votes: count, need: COURSE_REQ_VOTES, byMod: mod };
}

// 票凑够了，这门课从云端拿走：课程本身 + 挂着的评价 + 申请记录一起收拾干净。
// 评价不删会变成孤儿（courseId 指向一门已经不存在的课），留着不如一起删掉
async function finishCourseReq(course, rid, count, mod) {
  const d = await dropCourseCloud(course);
  if (!d.ok) return { ok: false, saved: false, msg: d.msg, detail: d.detail };
  await db.collection(COL_COURSE_REQS).where({ id: rid }).remove().catch(() => {});
  return { ok: true, removed: 1, votes: count, byMod: !!mod };
}

// 这门课上有没有人正在申请删除：详情页要看，好把「申请删除」的按钮状态显示对
async function courseReqInfo(openid, payload) {
  payload = payload || {};
  const courseId = String(payload.courseId || '').trim();
  const name = String(payload.name || '').trim();
  if (!courseId && !name) return { ok: false, msg: '参数缺失' };
  // 先用云端真实的课 id：前端那个 id 对不上老数据时，得靠课名兜一层，
  // 否则按钮上永远显示「0/3」，同学会以为申请根本没提交上去
  let key = courseId;
  const f = await findCourseDoc(courseId, name);
  if (f.doc && !f.doc.builtin) key = String(f.doc.id || f.doc._id || courseId);
  const q = await db.collection(COL_COURSE_REQS)
    .where({ id: courseReqId(key) }).limit(1).get().catch(() => ({ data: [] }));
  let rec = (q.data || [])[0];
  if (rec && rec.at && (Date.now() - Number(rec.at)) > COURSE_REQ_DAYS * 86400000) rec = null;
  const voters = (rec && Array.isArray(rec.voters)) ? rec.voters : [];
  return {
    ok: true,
    votes: voters.length,
    need: COURSE_REQ_VOTES,
    mine: voters.indexOf(openid) >= 0,
    courseName: (rec && rec.courseName) || '',
    lastReason: (rec && rec.reasons && rec.reasons[rec.reasons.length - 1]) || ''
  };
}

/* ================= 课程类型纠错 =================
 * 官网课程目录不带「课程性质」，类型是按课名猜的，猜错难免
 * （「实验心理学」因为带「心理」被当成通识课，其实是专业课）。
 * 猜错了让同学自己改：course_types 集合按课程 id 存一条 { id, ctype, openid, at }，
 * 全校共享 —— 类型筛选要让人信得过，纠错就不能只是本机的事。
 * 类型取值过一遍名册（pickCourseType），前端传什么都不至于写进脏值。
 */
async function courseTypeSet(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '').trim().slice(0, 40);
  if (!id) return { ok: false, msg: '课程 id 丢了，改不了' };
  const ctype = require('./course-type.js').pickCourseType(payload.ctype, '');
  const at = Date.now();
  const hit = await db.collection(COL_COURSE_TYPES).where({ id: id }).limit(1).get()
    .catch(() => ({ data: [] }));
  const rec = (hit.data || [])[0];
  if (rec) {
    const w = await db.collection(COL_COURSE_TYPES).doc(rec._id)
      .update({ data: { ctype: ctype, openid: openid, at: at } }).catch((e) => ({ err: e }));
    if (w && w.err) {
      const d = dbErr(w.err);
      console.error('[courseTypeSet] update failed:', d.code, d.msg);
      return { ok: false, saved: false, msg: '云端没存住', detail: (d.code + ' ' + d.msg).trim() };
    }
  } else {
    const w = await db.collection(COL_COURSE_TYPES).add({
      data: { id: id, ctype: ctype, openid: openid, at: at }
    }).catch((e) => ({ err: e }));
    if (w && w.err) {
      const d = dbErr(w.err);
      console.error('[courseTypeSet] write failed:', d.code, d.msg);
      return { ok: false, saved: false, msg: '云端没存住', detail: (d.code + ' ' + d.msg).trim() };
    }
  }
  // 同学自建课的正本在 courses 集合里也带着 ctype：顺手改掉，
  // 不然同一个类型在两处各说各话
  await db.collection(COL_COURSES).where({ id: id })
    .update({ data: { ctype: ctype } }).catch(() => {});
  return { ok: true, ctype: ctype };
}

// 全量下发纠错表。纠错条数很小（只会有几十条），一次拉完比按需查省事
async function courseTypeList() {
  const res = await db.collection(COL_COURSE_TYPES).limit(1000).get()
    .catch(() => ({ data: [] }));
  const typeMod = require('./course-type.js');
  const fixes = {};
  (res.data || []).forEach((d) => {
    if (d && d.id && d.ctype) fixes[d.id] = typeMod.normalizeCourseType(d.ctype) || '专业课';
  });
  return { ok: true, fixes: fixes };
}

// 记名表的主键：帖子 id + 用户 openid。同一个用户对同一条帖子永远只有这一条，
// 数据库层面就是唯一约束 —— 连点十次也只会是「 upsert 同一条」
function voteDocId(postId, openid) {
  return String(postId) + '_' + String(openid);
}

// 老帖子迁移：posts 上还挂着 likedBy / dislikedBy 两个数组（旧版存法），
// 记名表里却一条都没有。这种情况按老数组补记一次，计数才不会从 0 重新开始
async function migrateVotesIfNeeded(postId, p) {
  // 迁过的帖子打标记：不然每次点赞都要多跑一次 count 查询，白花一次数据库往返
  if (p && p.votesMigrated) return;
  const old = {
    like: Array.isArray(p && p.likedBy) ? p.likedBy : [],
    dislike: Array.isArray(p && p.dislikedBy) ? p.dislikedBy : []
  };
  if (!old.like.length && !old.dislike.length) {
    await markVotesMigrated(postId);
    return;
  }
  // 不能只看“表里有没有记录”：旧版可能只迁进去一部分（比如 posts 数组有 2 人，
  // post_votes 只有 1 行），直接 return 会把漏掉的那一票永久丢掉。
  // 这里按 openid 对比，缺谁补谁。
  const c = await db.collection(COL_VOTES).where({ postId: postId }).limit(1000).get().catch(() => null);
  const have = {};
  ((c && c.data) || []).forEach((v) => { if (v && v.openid) have[String(v.openid)] = 1; });
  const tasks = [];
  ['like', 'dislike'].forEach((kind) => {
    old[kind].forEach((oid) => {
      if (!oid || have[String(oid)]) return;
      have[String(oid)] = 1; // 同一个人同时出现在两个旧数组里时，只补第一条
      tasks.push(db.collection(COL_VOTES).add({
        data: { _id: voteDocId(postId, oid), postId: postId, openid: oid, kind: kind, at: Date.now() }
      }).catch(() => null)); // 撞主键说明已经有人补过了，忽略
    });
  });
  await Promise.all(tasks);
  await markVotesMigrated(postId);
}

// 迁移标记：写失败无所谓（下次再迁一次而已），不能因为打标记失败影响点赞
async function markVotesMigrated(postId) {
  await db.collection(COL_POSTS).where({ id: postId })
    .update({ data: { votesMigrated: true } }).catch(() => null);
}

// 记名表统计 + 旧帖历史计数。
// 旧帖可能只有 likes 数字、没有 likedBy 数组，迁移后 post_votes 为 0；
// 这时不能把 0 当权威值写回去，否则点一下就从 5 赞变成 1 赞。
// prevTotal 是本次操作前的帖子总计数，tableCount 是记名表里的真实票数，
// was / next 是当前用户操作前后的态度。
function countWithLegacy(tableCount, prevTotal, was, next, kind) {
  const count = Math.max(0, Number(tableCount) || 0);
  const prev = Math.max(0, Number(prevTotal) || 0);
  const legacy = Math.max(0, prev - count);
  const had = was === kind ? 1 : 0;
  const want = next === kind ? 1 : 0;
  return Math.max(0, legacy + count - had + want);
}
async function likeToggle(openid, payload) {
  payload = payload || {};
  const postId = String(payload.postId || '');
  if (!postId) return { ok: false, msg: '参数缺失' };
  // 默认点赞；传 kind 表示点踩。认 'down'/'dislike' 两种写法，免得前端改一半就报错
  const kind = payload.kind === 'dislike' || payload.kind === 'down' ? 'dislike' : 'like';
  const res = await db.collection(COL_POSTS).where({ id: postId }).limit(1).get().catch(() => null);
  const p = res && res.data && res.data[0];
  if (!p) return { ok: true, liked: false, disliked: false, likes: 0, dislikes: 0 };

  await migrateVotesIfNeeded(postId, p);

  // ① 我现在的态度：从记名表读，不靠 posts 上的数组（数组会重复，表不会）
  const voteId = voteDocId(postId, openid);
  const mine = await db.collection(COL_VOTES).doc(voteId).get().catch(() => null);
  const cur = mine && mine.data ? (mine.data.kind === 'dislike' ? 'dislike' : 'like') : '';
  // 再点同一个 = 取消；点另一边 = 换边。
  // 「赞踩互斥」就落在这行上 —— 一个人在表里的位置只有一个，换边是覆盖不是并存
  const next = cur === kind ? '' : kind;

  // ② 写记名表：doc().set() 是 upsert，同一个 _id 写多少次都只有一条（幂等）。
  //    旧实现是 push + inc，两个并发请求同时看到「没踩过」就各加一次，
  //    于是连点几下 dislikes 能涨好几个 —— 这就是「累加多个踩」的根源
  let werr = null;
  if (next) {
    const w = await db.collection(COL_VOTES).doc(voteId).set({
      data: { postId: postId, openid: openid, kind: next, at: Date.now() }
    }).catch((e) => ({ err: e }));
    if (w && w.err) werr = w.err;
  } else {
    // 取消：删掉那条记录。本来就无所谓「删没删到」，删不到说明已经没了
    await db.collection(COL_VOTES).doc(voteId).remove().catch(() => null);
  }
  if (werr) {
    // 记名表写不动：最常见的原因是 post_votes 集合还没在云开发控制台建好。
    // 这时候绝不能让点赞整个失效 —— 那正是「点了一点反应都没有」的来源。
    // 降级到旧的数组方式（push/pull + inc）：功能照常能用，只是并发下可能重复计数，
    // 但总比完全点不动强。控制台建好集合后不用改代码，下次点击自动回到强一致模式
    const d = dbErr(werr);
    console.error('[likeToggle] vote table unavailable, fallback:', d.code, d.msg);
    return legacyVoteFallback(postId, openid, cur, next, p);
  }

  // ③ 计数从记名表统计：不是「上次的值 +1」，而是当场数一遍。
  //    这样即使历史上记错过，下一次点赞也会自动把数字修正回来。
  //    ⚠️ 统计失败（最常见是 post_votes 集合还没建）必须退回帖子上的旧值 ——
  //    直接当成 0 写回去，等于把全校点过的赞一夜清零
  const [lc, dc] = await Promise.all([
    db.collection(COL_VOTES).where({ postId: postId, kind: 'like' }).count().catch((e) => ({ err: e })),
    db.collection(COL_VOTES).where({ postId: postId, kind: 'dislike' }).count().catch((e) => ({ err: e }))
  ]);
  const tableLikes = (lc && !lc.err) ? (Number(lc.total) || 0) : null;
  const tableDislikes = (dc && !dc.err) ? (Number(dc.total) || 0) : null;
  // 统计成功时，记名表就是唯一权威值：不再把 posts 上的旧数字当 legacy 加回去。
  // 旧数字本身可能已经被历史 +1/-1 写歪，继续叠加只会把“一个人两个赞”保留下来。
  // 统计失败（集合/权限异常）时才退回旧计数，保证点赞不至于完全不可用。
  const likes = tableLikes === null ? (Number(p.likes) || 0) : tableLikes;
  const dislikes = tableDislikes === null ? (Number(p.dislikes) || 0) : tableDislikes;

  // ④ 回写帖子：计数用 set（权威值整份覆盖，不用 inc 累加）。
  //    likedBy / dislikedBy 两个数组只为兼容旧代码保留，用 pull/push 维护，
  //    表里那份才是准的，界面计数一律看 likes / dislikes
  const data = { likes: likes, dislikes: dislikes };
  // addToSet 能防止旧数据重复 push 同一个 openid；老 SDK 没有这个命令时退回 push
  const addToSet = (oid) => (db.command.addToSet ? db.command.addToSet(oid) : db.command.push(oid));
  if (cur === 'like') data.likedBy = db.command.pull(openid);
  if (cur === 'dislike') data.dislikedBy = db.command.pull(openid);
  if (next === 'like') data.likedBy = addToSet(openid);
  if (next === 'dislike') data.dislikedBy = addToSet(openid);
  const vw = await db.collection(COL_POSTS).where({ id: postId })
    .update({ data: data }).catch((e) => ({ err: e }));
  if (vw && vw.err) {
    console.error('[likeToggle] post write failed:', dbErr(vw.err).code, dbErr(vw.err).msg);
    // 记名表已经写成功了，态度是对的，只是计数没刷到帖子上 —— 把真实状态如实返回
  }

  return {
    ok: true,
    liked: next === 'like',
    disliked: next === 'dislike',
    likes: likes,
    dislikes: dislikes
  };
}

// 降级路径：记名表不可用时用它顶上。
// 只有在 post_votes 集合没建 / 权限异常时才会走到这儿，正常情况永远不启用。
// 用 push/pull + inc 的原子操作维护数组，尽量把重复计数的影响压到最小
async function legacyVoteFallback(postId, openid, cur, next, p) {
  const data = {};
  const addToSet = (oid) => (db.command.addToSet ? db.command.addToSet(oid) : db.command.push(oid));
  if (cur === 'like') { data.likedBy = db.command.pull(openid); data.likes = db.command.inc(-1); }
  if (cur === 'dislike') { data.dislikedBy = db.command.pull(openid); data.dislikes = db.command.inc(-1); }
  if (next === 'like') { data.likedBy = addToSet(openid); data.likes = db.command.inc(1); }
  if (next === 'dislike') { data.dislikedBy = addToSet(openid); data.dislikes = db.command.inc(1); }
  if (!Object.keys(data).length) {
    return { ok: true, liked: false, disliked: false, likes: Number(p && p.likes) || 0, dislikes: Number(p && p.dislikes) || 0 };
  }
  await db.collection(COL_POSTS).where({ id: postId }).update({ data: data }).catch(() => null);
  const fresh = await db.collection(COL_POSTS).where({ id: postId }).limit(1).get().catch(() => null);
  const f = fresh && fresh.data && fresh.data[0];
  return {
    ok: true,
    liked: next === 'like',
    disliked: next === 'dislike',
    likes: Number(f && f.likes) || 0,
    dislikes: Number(f && f.dislikes) || 0
  };
}

// ============ 树洞三连：抱抱 / 递茶 / 摸摸头 ============
// 一人一帖一行，行里三个开关。和赞踩同一套记账思路：
// 写十次也只有一行（幂等），三个动作各自独立，互不干扰
const REACT_KINDS = ['hug', 'tea', 'pat'];

async function holeReact(openid, payload) {
  payload = payload || {};
  const postId = String(payload.postId || '');
  const kind = REACT_KINDS.indexOf(payload.kind) >= 0 ? payload.kind : 'hug';
  const on = payload.on !== false;
  if (!postId) return { ok: false, msg: '参数缺失' };

  const reactId = postId + '_' + openid;
  const got = await db.collection(COL_REACTS).doc(reactId).get().catch(() => null);
  const mine = (got && got.data)
    ? { hug: !!got.data.hug, tea: !!got.data.tea, pat: !!got.data.pat }
    : { hug: false, tea: false, pat: false };
  const nextMine = Object.assign({}, mine);
  nextMine[kind] = on;

  const w = await db.collection(COL_REACTS).doc(reactId).set({
    data: {
      postId: postId, openid: openid,
      hug: nextMine.hug, tea: nextMine.tea, pat: nextMine.pat,
      at: Date.now()
    }
  }).catch((e) => ({ err: e }));

  if (w && w.err) {
    // 集合没建也不让按钮装死：本地已经把这一下记下了，
    // 这里如实回一句「没存到云端」，界面保持用户刚点出来的样子
    console.error('[holeReact] write failed:', dbErr(w.err).code, dbErr(w.err).msg);
    return { ok: false, saved: false, msg: '云端暂未记录，本机已生效' };
  }

  // 计数：三项各数一遍人头，不是累加。历史上记错了也会在下次点击时自动修正
  const counts = {};
  for (const k of REACT_KINDS) {
    const q = { postId: postId };
    q[k] = true;
    const c = await db.collection(COL_REACTS).where(q).count().catch(() => null);
    counts[k] = c ? (Number(c.total) || 0) : null;
  }
  // 统计失败时用帖子上的旧值顶上，绝不写 0 —— 写 0 等于把全校抱过的抱抱清零
  const pr = await db.collection(COL_POSTS).where({ id: postId }).limit(1).get().catch(() => null);
  const old = (pr && pr.data && pr.data[0] && pr.data[0].react) || {};
  const final = {};
  REACT_KINDS.forEach((k) => {
    final[k] = counts[k] === null ? (Number(old[k]) || 0) : counts[k];
  });
  await db.collection(COL_POSTS).where({ id: postId })
    .update({ data: { react: final } }).catch(() => null);

  return { ok: true, counts: final, mine: nextMine };
}

// ============ 天气：钱塘区今日 + 明日 ============
// 这条链路刻意走云函数，不在前端直连第三方接口：
// 小程序在体验版 / 正式版会强制校验 request 合法域名，漏配就直接请求失败，
// 表现为「开发工具里好好的，体验版一点反应没有」。云函数出网不受这个限制，
// 前端只调自己的云函数，永远合法 —— 省掉一整类环境问题。
const https = require('https');

function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve(buf));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    setTimeout(() => { try { req.destroy(new Error('timeout')); } catch (e) {} }, timeoutMs + 1000);
  });
}

async function weather() {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=30.3167&longitude=120.5530'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min'
    + '&timezone=Asia%2FShanghai&forecast_days=2';
  let raw = null;
  try {
    raw = await httpsGet(url, 6000);
  } catch (e) {
    console.error('[weather] request failed:', e && e.message);
    return { ok: false, msg: '天气服务暂时取不到' };
  }
  try {
    const d = JSON.parse(raw);
    const daily = (d && d.daily) || {};
    const codes = daily.weather_code || [];
    const maxs = daily.temperature_2m_max || [];
    const mins = daily.temperature_2m_min || [];
    const dates = daily.time || [];
    if (!codes.length) return { ok: false, msg: '天气数据为空' };
    const pick = (i) => ({
      date: dates[i] || '',
      code: typeof codes[i] === 'number' ? codes[i] : null,
      max: typeof maxs[i] === 'number' ? maxs[i] : null,
      min: typeof mins[i] === 'number' ? mins[i] : null
    });
    return {
      ok: true,
      // 下标 0 今天、1 明天。接口只给一天时（改版 / 限流），明天那格如实留空
      today: pick(0),
      tomorrow: codes.length > 1 ? pick(1) : null,
      source: 'open-meteo'
    };
  } catch (e) {
    // 接口改版、返回不是 JSON：宁可不给，也不把异常抛到页面上
    console.error('[weather] parse failed:', e && e.message);
    return { ok: false, msg: '天气数据解析失败' };
  }
}

/* ---------------- 置顶（仅审核员） ---------------- */

// 置顶帖：全校同时最多 10 条（运营位扩容，超过就提示先取消一条）。
// 前端「置顶」类别单独一档展示；普通分类列表里置顶帖按原排序出现，带「置顶」徽标。
const PIN_MAX = 10;
// 单个置顶最长一年。不是技术限制，是运营约束：
// 「永久置顶」一旦给出去就再也收不回来（人会走、群会散、商家会跑），
// 一年到期强制让人重新确认一次，比事后满世界找谁批的永久位省事
const PIN_MAX_DAYS = 365;

async function postPin(openid, payload) {
  payload = payload || {};
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能置顶帖子' };
  const postId = String(payload.postId || '');
  const pin = payload.pin !== false;
  if (!postId) return { ok: false, msg: '参数缺失' };

  // 置顶截止时间：0 = 永久（老前端不传这个参数，走的也是永久，行为不变）。
  // 存的是毫秒时间戳而不是「时长」—— 存时长的话，改一次规则会让已经置顶的帖子
  // 按新规则重新算一遍，等于把历史决定改掉了
  const nowMs = Date.now();
  let pinUntil = Number(payload.until) || 0;
  if (pin && pinUntil > 0) {
    if (pinUntil <= nowMs) return { ok: false, msg: '截止时间已经过去了' };
    const cap = nowMs + PIN_MAX_DAYS * 24 * 3600 * 1000;
    if (pinUntil > cap) return { ok: false, msg: '最多置顶 ' + PIN_MAX_DAYS + ' 天' };
    pinUntil = Math.floor(pinUntil);
  } else {
    pinUntil = 0;
  }

  const hit = await db.collection(COL_POSTS).where({ id: postId }).limit(1).get().catch(() => ({ data: [] }));
  const rec = hit.data && hit.data[0];
  if (!rec) return { ok: false, msg: '帖子不存在' };

  if (pin) {
    // 「还剩几个名额」要看「除了它自己以外的置顶条数」。
    // 光拿 pinned 不等于 true 去卡，只排除了这条自己，另外 3 条照样匹配，第 4 条就被放进去了
    const others = await db.collection(COL_POSTS)
      .where({ pinned: true, id: db.command.neq(postId) })
      .count().catch(() => ({ total: 0 }));
    const used = Number(others && others.total) || 0;
    if (!rec.pinned && used >= PIN_MAX) {
      return { ok: false, msg: '最多同时置顶 ' + PIN_MAX + ' 条，先取消一条吧' };
    }
    const uw = await db.collection(COL_POSTS).where({ id: postId })
      .update({ data: { pinned: true, pinnedAt: nowMs, pinUntil: pinUntil, pinOrder: Number(rec.pinOrder) || 0 } }).catch((e) => ({ err: e }));
    if (uw && uw.err) {
      const d = dbErr(uw.err);
      console.error('[postPin] write failed:', d.code, d.msg);
      return { ok: false, saved: false, msg: '置顶没成功，再试一次', detail: (d.code + ' ' + d.msg).trim() };
    }
    // 写完再数一次确认没破上限：两个人同时点的话，先写完的那个可能刚把名额占满。
    // 超限必须把自己刚写的那条撤回来 —— 只回失败不回滚的话，
    // 置顶名额会被并发悄悄突破（Code Review 抓到的边缘漏洞）
    const after2 = await db.collection(COL_POSTS)
      .where({ pinned: true, id: db.command.neq(postId) })
      .count().catch(() => ({ total: 0 }));
    const used2 = Number(after2 && after2.total) || 0;
    if (!rec.pinned && used2 >= PIN_MAX) {
      await db.collection(COL_POSTS).where({ id: postId })
        .update({ data: { pinned: false, pinnedAt: 0, pinUntil: 0, pinOrder: 0 } }).catch(() => {});
      return { ok: false, saved: false, msg: '刚被别人占满了，先取消一条吧' };
    }
    await logMod(openid, 'pin', 'post', postId,
      pinUntil ? '限时置顶至 ' + new Date(pinUntil).toISOString().slice(0, 10) : '永久置顶');
    return { ok: true, pinned: true, pinUntil: pinUntil, msg: pinUntil ? '已置顶（到期自动取消）' : '已永久置顶' };
  }
  const uw2 = await db.collection(COL_POSTS).where({ id: postId })
    .update({ data: { pinned: false, pinnedAt: 0, pinUntil: 0, pinOrder: 0 } }).catch((e) => ({ err: e }));
  if (uw2 && uw2.err) {
    const d = dbErr(uw2.err);
    console.error('[postPin] unpin failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '取消置顶没成功，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  await logMod(openid, 'unpin', 'post', postId, '取消置顶');
  return { ok: true, pinned: false, pinUntil: 0, msg: '已取消置顶' };
}

// 管理员自定义置顶顺序。ids 是按“从上到下”排列的全部置顶帖 id；
// 只把仍然 pinned 的条目写入 pinOrder，避免旧页面把已取消的帖子重新排进来。
async function postPinOrder(openid, payload) {
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能调整置顶顺序' };
  const wanted = Array.isArray(payload && payload.ids) ? payload.ids : [];
  const uniq = [];
  wanted.forEach((id) => {
    const v = String(id || '');
    if (v && uniq.indexOf(v) < 0 && uniq.length < PIN_MAX) uniq.push(v);
  });
  const res = await db.collection(COL_POSTS)
    .where({ pinned: true }).limit(20).get()
    .catch(() => ({ data: [] }));
  // 不在数据库层叠 orderBy，避免把「置顶顺序」绑到额外复合索引；
  // 数量最多 10 条，内存排序足够。
  const rows = (res.data || []).slice().sort((a, b) => {
    const ao = Number(a.pinOrder) || 0, bo = Number(b.pinOrder) || 0;
    if (ao && bo) return ao - bo;
    if (ao) return -1;
    if (bo) return 1;
    return (Number(a.pinnedAt) || 0) - (Number(b.pinnedAt) || 0);
  });
  const alive = {};
  rows.forEach((p) => { alive[String(p.id || p._id || '')] = true; });
  const ids = uniq.filter((id) => alive[id]);
  rows.forEach((p) => {
    const id = String(p.id || p._id || '');
    if (alive[id] && ids.indexOf(id) < 0 && ids.length < PIN_MAX) ids.push(id);
  });
  for (let i = 0; i < ids.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await db.collection(COL_POSTS).where({ id: ids[i], pinned: true })
      .update({ data: { pinOrder: i + 1 } }).catch(() => null);
  }
  await logMod(openid, 'pinOrder', 'post', '', ids.join(','));
  return { ok: true, ids: ids, msg: '置顶顺序已保存' };
}

// 到期的置顶统一收回来。
//
// 光靠「读的时候判断有没有过期」是不够的：帖子上还挂着 pinned: true，
// 管理页的「置顶 (N)」计数、PIN_MAX 名额判定都会把这些过期帖算进去 ——
// 名额就那么 10 个，过期的不清，新的一直加不进去，运营只会看到「明明没人置顶了却说满了」。
async function pinSweep() {
  const nowMs = Date.now();
  const _ = db.command;
  const res = await db.collection(COL_POSTS)
    .where({ pinned: true, pinUntil: _.gt(0).and(_.lte(nowMs)) })
    .limit(100).get().catch(() => ({ data: [] }));
  const rows = res.data || [];
  let cleared = 0;
  for (const p of rows) {
    // 一条一条改，不用 where().update() 批量：批量更新走的是同一套条件，
    // 万一 pinUntil 判断有偏差（比如时区/精度），会连没到期的也一起清掉。
    // 置顶到期是低频动作，逐条写换来的确定性更值
    // eslint-disable-next-line no-await-in-loop
    const r = await db.collection(COL_POSTS).doc(p._id)
      .update({ data: { pinned: false, pinnedAt: 0, pinUntil: 0 } }).catch(() => null);
    if (r) cleared += 1;
  }
  return cleared;
}

/* ---------------- 内容保护（仅审核员） ---------------- */

// 保护 / 取消保护一条帖子或留言。
//
// 保护的作用范围只在「举报触发的自动处置」这一层：
// 有它，凑够人数也不会自动下架 / 自动删除，改由审核员看过再定；
// 没有它，内容照旧按阈值自动处理。人工审核和图片审核回调都不受它影响。
async function protectSet(openid, payload) {
  payload = payload || {};
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能设置保护' };
  const targetType = payload.targetType === 'comment' ? 'comment' : 'post';
  const targetId = String(payload.targetId || '');
  const on = payload.on !== false;
  const reason = String(payload.reason || '').slice(0, 60);
  if (!targetId) return { ok: false, msg: '没指名要保护哪条' };

  // 关掉不用查对象：内容可能已经被删了，但那条保护记录还得能清掉，
  // 否则会留下一条再也点不动的幽灵记录
  if (!on) {
    await db.collection(COL_PROTECTS).doc(protectKey(targetType, targetId))
      .remove().catch(() => null);
    await logMod(openid, 'unprotect', targetType, targetId, reason || '取消保护');
    return { ok: true, protected: false, msg: '已取消保护' };
  }

  // 打开之前对象必须真的存在：护一个不存在的 id，只会在列表里留一条空记录
  let snapshot = {};
  if (targetType === 'comment') {
    const got = await db.collection(COL_POST_COMMENTS).doc(targetId).get().catch(() => null);
    const c = got && got.data && !Array.isArray(got.data) ? got.data : null;
    if (!c || c.removed) return { ok: false, msg: '这条留言已经不在了' };
    snapshot = {
      postId: String(c.postId || ''),
      title: String(c.content || '[图片留言]').slice(0, 60),
      author: String(c.author || '')
    };
  } else {
    const hit = await db.collection(COL_POSTS).where({ id: targetId }).limit(1).get()
      .catch(() => ({ data: [] }));
    const p = hit.data && hit.data[0];
    if (!p) return { ok: false, msg: '这条内容已经不在了' };
    snapshot = {
      postId: targetId,
      title: String(p.title || '').slice(0, 60),
      author: String(p.author || '')
    };
  }

  const doc = Object.assign({
    targetType: targetType,
    targetId: targetId,
    by: String(openid || ''),
    at: Date.now(),
    reason: reason
  }, snapshot);
  const w = await db.collection(COL_PROTECTS).doc(protectKey(targetType, targetId))
    .set({ data: doc }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[protectSet] write failed:', d.code, d.msg);
    return { ok: false, msg: '保护没设上，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  // 标题快照存一份：内容以后被删了，保护列表里还能看出「当时护的是哪条」
  await logMod(openid, 'protect', targetType, targetId, reason || snapshot.title);
  return { ok: true, protected: true, msg: '已保护，这条不会再被举报自动下架' };
}

// 已保护的清单（审核页用）。只回保护记录本身，不回全量内容：
// 记录里已经存了标题快照，够列表显示，也不用为了 10 条记录去查 10 次内容
async function protectList(openid) {
  if (!(await isModerator(openid))) return { ok: false, msg: '无权限', list: [] };
  const res = await db.collection(COL_PROTECTS)
    .orderBy('at', 'desc').limit(100).get().catch(() => ({ data: [] }));
  return { ok: true, list: res.data || [] };
}

// 单条查询：详情页 / 审核页打开时判断「这条现在护着没」
async function protectInfo(openid, payload) {
  payload = payload || {};
  const targetType = payload.targetType === 'comment' ? 'comment' : 'post';
  const rec = await isProtected(targetType, String(payload.targetId || ''));
  return { ok: true, protected: !!rec, record: rec || null };
}

/* ---------------- 运行配置（仅审核员） ---------------- */

// 读：任何登录用户都可以拿（前端要用它判断「通知开了没有」），模板 ID 本身不算秘密
async function cfgGet(openid) {
  const ids = await getSubMsgIds();
  const words = await getExtraWords();
  // 置顶列表也顺手带出来，管理页一次拉全
  const pinned = await db.collection(COL_POSTS).where({ pinned: true }).limit(10).get().catch(() => ({ data: [] }));
  return {
    ok: true,
    submsg: ids,
    // 审核员自配的屏蔽词。前端要能显示「内置 N 个 + 自配 M 个」，
    // 并把内置那份也列出来 —— 不然审核员以为词表是空的，自己加了几个
    // 却发现老词早就在拦了，会以为配置没生效
    words: words,
    builtinWords: BLOCK_WORDS_BASE,
    fromEnv: { comment: !!ENV_SUBMSG.comment, reply: !!ENV_SUBMSG.reply, chat: !!ENV_SUBMSG.chat },
    pinnedList: (pinned.data || []).map((p) => ({ id: p.id, title: p.title, board: p.board })),
    cancel: await accountState(openid)
  };
}

// 写：只有审核员能改。两类配置各存 app_config 里的一个文档：
//   submsg      订阅消息模板 ID（空值以环境变量兜底）
//   moderation  屏蔽词增补表（内置那份永远在，删不掉）
async function cfgSave(openid, payload) {
  payload = payload || {};
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能改通知设置' };

  const touched = [];

  if (payload.submsg) {
    const s = payload.submsg;
    const data = {
      comment: String(s.comment || '').trim().slice(0, 64),
      reply: String(s.reply || '').trim().slice(0, 64),
      chat: String(s.chat || '').trim().slice(0, 64),
      updatedAt: now()
    };
    await db.collection(COL_CONFIG).doc('submsg').set({ data }).catch(() => {});
    _cfgCache = { at: 0, value: null }; // 改完立刻失效缓存，下次发送读新值
    touched.push('submsg');
  }

  if (payload.words !== undefined) {
    const raw = Array.isArray(payload.words) ? payload.words : String(payload.words || '').split(/[\s,，、]+/);
    const words = raw
      .map((w) => String(w || '').trim())
      .filter((w) => w.length >= 1 && w.length <= 12)
      // 自配词里混进了内置词：去重，否则 checkText 的命中列表里同一个词出现两次，
      // 提示文案会变成「内容里有「约炮、约炮」」
      .filter((w) => BLOCK_WORDS_BASE.indexOf(w) < 0)
      .slice(0, 200);
    await db.collection(COL_CONFIG).doc('moderation').set({
      data: { words: words, updatedAt: now() }
    }).catch(() => {});
    _extraWordsAt = 0; // 立刻失效缓存
    touched.push('words(' + words.length + ')');
  }

  if (!touched.length) return { ok: true, msg: '没有要保存的内容' };
  return { ok: true, msg: '已保存 ' + touched.join(' / ') + '，最迟 5 分钟内生效（重新部署云函数立即生效）' };
}

/* ---------------- 站内通知中心 ---------------- */

// 通知列表。按 openid 单字段查 + 内存排序：多字段 where 没建索引时会静默失败
// （listRequests 上已经踩过一次），而通知列表恰恰是最不该静默失败的地方 ——
// 用户看到空列表只会以为「没人理我」，不会想到是查询报错。
async function notifyList(openid, payload) {
  payload = payload || {};
  const limit = Math.max(1, Math.min(50, Number(payload.limit) || 20));
  // 分页偏移：通知中心以前固定只给最近 50 条，攒多了更早的再也看不到
  const skip = Math.max(0, Number(payload.skip) || 0);
  // 一次能读的窗口上限（云函数端 limit 最大 100）。分页在这个窗口里切，
  // 再往前的历史不再往回捞 —— 通知是「最近发生了什么」，不是档案
  const WINDOW = 100;
  const res = await db.collection(COL_NOTIFIES)
    .where({ openid: openid }).limit(WINDOW).get()
    .catch((e) => {
      console.error('[notifyList] query failed:', String((e && e.errMsg) || e));
      return null;
    });
  // 查不到与「真的没有」必须分开：查失败时说「暂无通知」，
  // 用户会当成事实；加个 degraded 让页面能提示「暂时读不到」
  if (!res) return { ok: true, list: [], unread: 0, degraded: true };
  const rows = (res.data || []).slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));

  // 未读数单独数全量：以前只在最近 100 条里数，消息攒多之后这个数字会偏低，
  // 而 tabBar 上的红点来自同一份数据，偏低就等于「明明还有未读却不提醒」
  const uc = await db.collection(COL_NOTIFIES)
    .where({ openid: openid, read: false }).count().catch(() => null);
  const unread = uc && typeof uc.total === 'number'
    ? uc.total
    : rows.filter((r) => !r.read).length;

  const list = rows.slice(skip, skip + limit).map((r) => ({
    id: r._id,
    type: String(r.type || ''),
    // 新通知带稳定事件键；客户端用它去掉旧版本留下的同一条重复通知。
    eventKey: String(r.eventKey || ''),
    title: String(r.title || ''),
    body: String(r.body || ''),
    page: String(r.page || ''),
    targetId: String(r.targetId || ''),
    read: !!r.read,
    time: String(r.time || '')
  }));
  return {
    ok: true,
    list: list,
    unread: unread,
    total: rows.length,
    hasMore: skip + limit < rows.length
  };
}

async function notifyRead(openid, payload) {
  payload = payload || {};
  const targetId = String(payload.targetId || '');
  // 打开自己的帖子详情时，把「有人回复了你的帖子」这类同目标通知一起标已读。
  // 不这么做，帖子红点清了，通知中心还挂着一枚红点，用户会反复点进去找。
  if (targetId) {
    await db.collection(COL_NOTIFIES)
      .where({ openid: openid, read: false, targetId: targetId })
      .update({ data: { read: true, readAt: Date.now() } }).catch(() => {});
    return { ok: true };
  }
  const id = String(payload.id || '');
  if (!id) {
    // 不带 id = 全部标为已读。前端「全部已读」就用这个
    await db.collection(COL_NOTIFIES).where({ openid: openid, read: false })
      .update({ data: { read: true, readAt: Date.now() } }).catch(() => {});
    return { ok: true };
  }
  await db.collection(COL_NOTIFIES).where({ _id: id, openid: openid })
    .update({ data: { read: true, readAt: Date.now() } }).catch(() => {});
  return { ok: true };
}

/* ---------------- 草稿（跨设备） ---------------- */

// 草稿以前只存本机：换手机、重装、清缓存，写到一半的东西直接没了。
// 上云之后要解决的核心问题不是「怎么存」，而是「两台设备都改过该听谁的」：
//
//   · 合并策略：**后写者胜**（updatedAt 大的那份赢）。不做事无巨细的字段级合并 ——
//     草稿是一整段文字，逐字段合出来的半篇东西比丢一篇更糟。
//   · 删除必须留墓碑（deleted: true）。只把文档删掉的话，另一台设备下次同步
//     会认为「云端没有、本机有」，把刚删掉的草稿又推回去。
//   · 客户端只把「本机独有」的推上来，不会整份覆盖云端 ——
//     否则旧设备一同步就会把新设备刚写的内容洗掉。
const DRAFT_MAX = 20;
const DRAFT_TYPES = ['post', 'review', 'market', 'hole'];

function draftOut(d) {
  return {
    id: String(d.id || ''),
    type: String(d.type || 'post'),
    board: String(d.board || ''),
    courseId: String(d.courseId || ''),
    courseName: String(d.courseName || ''),
    title: String(d.title || ''),
    content: String(d.content || ''),
    tags: Array.isArray(d.tags) ? d.tags.slice(0, 10) : [],
    updatedAt: Number(d.updatedAt) || 0
  };
}

async function draftList(openid) {
  const res = await db.collection(COL_DRAFTS).where({ openid: openid }).limit(100).get()
    .catch(() => null);
  // 读不到与「真的没有草稿」分开：读不到时不能返回空列表，
  // 调用方会拿它去覆盖本地 —— 那等于把用户写到一半的东西删了
  if (!res) return { ok: false, degraded: true, list: [] };
  const rows = res.data || [];
  const list = rows
    .filter((d) => !d.deleted)
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, DRAFT_MAX)
    .map(draftOut);
  // 墓碑要单独回给前端：只回「还活着的」话，另一台设备会认为
  // 「云端没有这条 = 我本机那条还没上传」，于是把刚删掉的草稿又推回来
  const removed = rows.filter((d) => d.deleted).map((d) => String(d.id || ''));
  return { ok: true, list: list, removed: removed };
}

async function draftSave(openid, payload) {
  const d = payload && payload.draft ? payload.draft : {};
  const id = String(d.id || '');
  const title = String(d.title || '').slice(0, 100);
  const content = String(d.content || '').slice(0, 5000);
  if (!id) return { ok: false, msg: '草稿缺少 id' };
  // 标题正文都空的不存：和客户端同一条规则，否则会攒一堆空壳
  if (!title.trim() && !content.trim()) return { ok: true, skipped: true };

  const updatedAt = Number(d.updatedAt) || Date.now();
  const hit = await db.collection(COL_DRAFTS)
    .where({ openid: openid, id: id }).limit(1).get().catch(() => null);
  const cur = hit && hit.data && hit.data[0];

  // 后写者胜：云端那份更新就不动。这是「旧设备一同步把新内容洗掉」的防线
  if (cur && (Number(cur.updatedAt) || 0) > updatedAt) {
    return { ok: true, kept: 'remote', updatedAt: Number(cur.updatedAt) || 0 };
  }

  const data = {
    id: id,
    type: DRAFT_TYPES.indexOf(String(d.type || '')) >= 0 ? String(d.type) : 'post',
    board: String(d.board || '').slice(0, 20),
    courseId: String(d.courseId || ''),
    courseName: String(d.courseName || '').slice(0, 40),
    title: title,
    content: content,
    tags: Array.isArray(d.tags) ? d.tags.slice(0, 10) : [],
    updatedAt: updatedAt,
    deleted: false,
    at: now()
  };

  if (cur) {
    await db.collection(COL_DRAFTS).doc(String(cur._id)).update({ data: data }).catch(() => {});
  } else {
    await db.collection(COL_DRAFTS).add({ data: Object.assign({ openid: openid }, data) }).catch(() => {});
  }
  return { ok: true, updatedAt: updatedAt };
}

async function draftRemove(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  // 软删：留墓碑，另一台设备同步时才知道「这条是被删了」，而不是「云端还没有」
  await db.collection(COL_DRAFTS).where({ openid: openid, id: id })
    .update({ data: { deleted: true, updatedAt: Date.now() } })
    .catch(() => {});
  return { ok: true };
}

/* ---------------- 收藏（私有数据） ---------------- */

// 收藏整体存一条文档：一条文档 = 一个人的收藏，读写都是一次操作，
// 拆成「一条收藏一个文档」反而要按 openid 查一堆再合并。
async function saveFavorites(openid, payload) {
  const list = Array.isArray(payload && payload.list)
    ? payload.list.slice(0, 200).map((f) => ({
      type: String((f && f.type) || ''),
      id: String((f && f.id) || ''),
      title: String((f && f.title) || '').slice(0, 60),
      at: Number(f && f.at) || 0
    })).filter((f) => f.type && f.id)
    : [];
  await db.collection(COL_FAVS).doc(openid).set({
    data: { openid: openid, list: list, at: Date.now() }
  }).catch(() => {});
  return { ok: true, list: list };
}

async function getFavorites(openid) {
  const res = await db.collection(COL_FAVS).doc(openid).get().catch(() => null);
  const d = res && res.data;
  const list = d && Array.isArray(d.list) ? d.list : [];
  return { ok: true, list: list };
}

/* ---------------- 失物招领 / 二手交易 ---------------- */

const MARKET_TYPES = ['lost', 'found', 'sell'];
const MARKET_PAGE = 30;

// 列表展示用的补全：云端写库会补 _openid，这里统一成 openid，
// 前端「是不是我发的 / 点作者去私聊」都靠它
function decorateMarket(m, me) {
  const openid = m.openid || m._openid || '';
  return Object.assign({}, m, {
    openid: openid,
    isMine: !!me && openid === me,
    priceText: m.type === 'sell' ? (m.price ? '¥' + m.price : '议') : ''
  });
}

async function marketAdd(openid, payload) {
  payload = payload || {};
  const it = payload.item || {};
  const type = MARKET_TYPES.indexOf(it.type) >= 0 ? it.type : 'lost';
  const author = String(it.author || '浙小商').slice(0, 20);
  const doc = {
    id: String(it.id || ('m' + Date.now() + Math.floor(Math.random() * 1000))),
    type: type,
    title: String(it.title || '').slice(0, 40),
    desc: String(it.desc || '').slice(0, 500),
    contact: String(it.contact || '').slice(0, 40),
    contactType: it.contactType || 'phone',
    // 只有二手才需要价格，找东西的地方标价格很怪
    price: type === 'sell' ? String(it.price || '').slice(0, 20) : '',
    location: String(it.location || '').slice(0, 40),
    // 教材专区：category=book 时按 courseName 匹配教材，开学季最好用。
    // ⚠️ 这张白名单必须和前端 utils/market.js 的 CATEGORIES 对得上：
    //    漏一个的话，发布页能选、存进库却静默变成「其他」，筛选永远筛不出来，
    //    而且不报错 —— scripts/test-market-categories.cjs 会钉住两边
    category: ['book', 'digital', 'life', 'substitute', 'other'].indexOf(it.category) >= 0 ? it.category : 'other',
    courseName: String(it.courseName || '').slice(0, 30),
    images: sanitizeImages(it.images, 'market', 6),
    author: author,
    // 作者身份一律以调用者为准：前端传什么都改不了
    openid: openid,
    time: now(),
    at: Date.now(),
    status: 'open',
    done: false
  };
    if (!doc.title) return { ok: false, msg: '写个标题吧，别人才知道发生了什么' };
    // 失物招领是最容易被拿来做广告的地方，标题 / 描述 / 地点必须过审。
    // contact 不参与校验：找东西本来就要留联系方式，
    // 而「加微信」在我们的屏蔽词表里——一起校验会把正常的失物帖挡死。
    const g = await guard(doc.title, doc.desc, doc.location, author);
    if (!g.ok) return { ok: false, msg: g.msg };
    await db.collection(COL_MARKET).add({ data: doc });
    if (doc.images && doc.images.length) {
      await submitMediaCheck(openid, doc.images, {
        scene: 1, targetType: 'market', targetId: doc.id
      }).catch(() => {});
    }
  return { ok: true, item: decorateMarket(doc, openid) };
}

async function marketList(openid, payload) {
  payload = payload || {};
  const page = Math.max(1, Number(payload.page) || 1);
  // 类型下推到云端：以前不管用户在看哪个 tab，都拉「全类型 30 条」再回本地筛，
  // 常常是「拉了 30 条、筛完只剩 8 条」—— 白白传了一倍多的数据。
  // 带上 type 之后这 30 条就全是这个类型的。
  //
  // ⚠️ 兼容性：老版本云函数不认 type，会照旧返回全类型。客户端本地还有一层过滤兜底，
  //    结果一样对，只是省不下流量 —— 所以这个参数可以放心加，不用等前端一起发版。
  //
  // 📌 索引：带 type 的查询走 (type 升序 + at 降序) 复合索引；
  //    不带 type 的走 at 降序单字段索引。两个都在云开发控制台「索引管理」里建。
  const type = MARKET_TYPES.indexOf(payload.type) >= 0 ? payload.type : '';
  const query = type ? db.collection(COL_MARKET).where({ type: type }) : db.collection(COL_MARKET);
  const res = await query
    .orderBy('at', 'desc').skip((page - 1) * MARKET_PAGE).limit(MARKET_PAGE)
    .get().catch(() => null);
  const list = (res && res.data) || [];
  // 被举报下架 / 审核删除的条目从全校视野里消失。
  // 这里用内存过滤而不是 where：hidden 字段是老数据里没有的，
  // where({hidden: neq(true)}) 会把「没有这个字段」的旧记录一起筛掉。
  // 代价是这一页可能少几条，分页由前端触底补偿，比丢内容强
  const alive = list.filter((m) => m.hidden !== true && m.deleted !== true);
  return { ok: true, list: alive.map((m) => decorateMarket(m, openid)), page: page, type: type };
}

async function marketDone(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const hit = await db.collection(COL_MARKET).where({ id: id }).limit(1).get().catch(() => ({ data: [] }));
  const rec = hit.data && hit.data[0];
  if (!rec) return { ok: true };
  const owner = String(rec.openid || rec._openid || '') === openid;
  if (!owner && !(await isModerator(openid))) return { ok: false, msg: '只能处理自己发布的内容' };

  const done = payload.done !== false;
  await db.collection(COL_MARKET).where({ id: id }).update({
    data: { status: done ? 'done' : 'open', done: done }
  }).catch(() => {});
  return { ok: true };
}

async function marketRemove(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const hit = await db.collection(COL_MARKET).where({ id: id }).limit(1).get().catch(() => ({ data: [] }));
  const rec = hit.data && hit.data[0];
  if (!rec) return { ok: true };
  const owner = String(rec.openid || rec._openid || '') === openid;
  if (!owner && !(await isModerator(openid))) return { ok: false, msg: '没有权限删除这条' };
  await db.collection(COL_MARKET).where({ id: id }).remove().catch(() => {});
  return { ok: true };
}

/* ---------------- 图片附件：云存储 fileID 白名单 ---------------- */

// 图片在上传那一刻就已经躺在云存储里了，写库时带上来的是 fileID。
// 这一串是**用户可控输入**，原样存库有两个后果：
//   ① 外链跳板：塞一个 http 地址进来，别人渲染时就去请求站外资源（还可能被用来做图床）；
//   ② 跨目录越权：把别的业务的 fileID（甚至别人聊天里的图）挂到自己的内容上，
//      等于借「配图」的名义把任意云文件转发出去。
// 所以统一收口在这里：只认 cloud:// 开头、且正好落在本业务目录下的 fileID。
//
// 目录按业务分：帖子 = forum/、私信 = chat/、闲置 = market/。
// 上传侧的前缀由 utils/upload.js 的 cloudPathFor(prefix, ext) 生成，两边必须对得上。
const FILEID_MAX = 512;

// fileID 的形状固定是 cloud://<环境ID>.<存储桶>/<目录>/<文件名>，正好 5 段。
// 段数不对、目录不对、文件名里有怪字符（空白 / 引号 / 斜杠）一律不认。
function isCloudFileIn(fid, dir) {
  const s = String(fid || '').trim();
  if (!s || s.length > FILEID_MAX) return false;
  if (s.indexOf('cloud://') !== 0) return false;
  if (/\s/.test(s)) return false;
  const parts = s.split('/');
  // ['cloud:', '', 'env.bucket', dir, file]
  if (parts.length !== 5) return false;
  if (parts[3] !== dir) return false;
  return /^[\w\-.]+$/.test(parts[4]);
}

// 逐条校验 → 去重 → 按上限截断。
// 校验不过的是「整条退回」，不是「截断成打不开的 ID」——
// 后者会在库里留下一个永远渲染不出来的坏链，比丢掉更难排查。
function sanitizeImages(list, dir, max) {
  if (!Array.isArray(list)) return [];
  const cap = Number(max) || 9;
  const out = [];
  for (let i = 0; i < list.length && out.length < cap; i += 1) {
    const s = String(list[i] || '').trim();
    if (!isCloudFileIn(s, dir)) continue;
    if (out.indexOf(s) >= 0) continue;
    out.push(s);
  }
  return out;
}

// 头像：只认上传到本小程序 avatars/ 目录的云文件，规矩和上面的配图一样。
//
// 两条都必须挡：
//   ① 不接受 http(s) 地址。放行外链等于给头像开了一个站外图床入口，
//      别人渲染时就去请求站外资源 —— 上面「外链跳板」那一条说得很清楚了；
//   ② 前端传来的头像有可能是「上传失败时的本机临时路径」（profile 页在
//      云存储没通时会把头像退回本机目录）。那种路径别人手机上根本没有，
//      存进库就是一条谁都打不开的坏链，比空着更难查。
// 空串是合法值（没设头像 / 匿名），前端会退回「文字头像」。
function safeAvatar(v) {
  const s = String(v || '').trim();
  return isCloudFileIn(s, 'avatars') ? s : '';
}

/* ---------------- 名片页：某人的历史发帖 ---------------- */

// 树洞板块名。树洞帖和普通帖在 posts 集合里同构，只靠 board 区分 ——
// 所以「这条算不算匿名内容」不能只看 anonymous 字段，板块名也要认
const ANON_BOARD = '树洞';

// 一次最多回几条：名片页是「看看这人发过什么」，不是审核台账，
// 一屏够用。要翻遍某人的全部历史，那是审核页的活儿
const AUTHOR_POSTS_MAX = 20; // 名片页默认仍只取一屏，我的发布可显式请求更多
// 查询上限：先多捞一点再在内存里排序截断，
// 直接 limit 20 会让「发过 50 条的人」只看到中间某 20 条
const AUTHOR_QUERY_MAX = 100;

// TA 的历史发帖。
//
// 为什么不复用 getQueue / getPosts：那两条都要管理员身份，而「看一眼这人发过什么」
// 是普通同学也要的判断依据（约球、找搭子之前顺手看看靠不靠谱）。
//
// 两条硬约束，**服务端必须自己挡**，不能指望前端不显示：
//   ① 树洞帖与任何 anonymous 帖一律不出。匿名是发帖人可依赖的承诺，
//      把匿名帖挂在某人的名片下等于当众点名 —— 这条一破，「匿名」就再也不值钱了；
//   ② 只出 status='normal' 的帖子，被下架的违规内容不该从这个口子二次传播。
//      但审核员除外：他需要知道「这人被下架过几条」，所以给管理员额外回一份
//      「已下架」条目 —— 只带标题和状态，**不带正文、不带图片**，能判断又不扩散。
async function postsByAuthor(openid, payload) {
  const who = String((payload && payload.author) || '').trim();
  if (!who) return { ok: false, msg: '没指定看谁' };
  const max = Math.max(1, Math.min(100, Number(payload && payload.limit) || AUTHOR_POSTS_MAX));

  const isMod = await isModerator(openid);

  // 作者字段查两次再合并：
  //   authorOpenid —— postAdd 写入的规范字段（「我的帖子」按它查）
  //   openid       —— 早期从云端同步上来的老帖可能只有这个，
  //                   漏掉的话「历史发帖」会莫名其妙地少几条
  const [byAuthor, byOpenid] = await Promise.all([
    db.collection(COL_POSTS).where({ authorOpenid: who })
      .orderBy('at', 'desc').limit(AUTHOR_QUERY_MAX).get().catch(() => ({ data: [] })),
    db.collection(COL_POSTS).where({ openid: who })
      .orderBy('at', 'desc').limit(AUTHOR_QUERY_MAX).get().catch(() => ({ data: [] }))
  ]);

  const seen = {};
  const merged = [];
  (byAuthor.data || []).concat(byOpenid.data || []).forEach((p) => {
    const id = String(p.id || p._id || '');
    if (!id || seen[id]) return;
    seen[id] = true;
    merged.push(p);
  });
  // 云端 orderBy 之外的兜底排序：两次查询各自有序，但合并后要重新排一遍，
  // 保证「最近发的在最上面」这条直觉不被查询方式破坏
  merged.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));

  const out = [];
  // 看自己的历史发帖时，匿名 / 树洞帖不能像看别人那样剔掉 ——
  // 「我的帖子」里得能看见自己匿名发的那条，否则他既找不到也没法删。
  // 判定看调用者身份而不是入参：who 就是自己才算。被打码的帖子同理。
  const isSelf = who === openid;
  for (const p of merged) {
    // 已被彻底删除的帖子云端没有文档，这里天然拿不到；
    // status 只管「暂停展示 / 下架」这种软处置
    const anon = !!p.anonymous || String(p.board || '') === ANON_BOARD;
    if (anon && !isSelf) continue;
    const status = String(p.status || 'normal');
    const hidden = status !== 'normal';
    if (hidden && !isMod && !isSelf) continue;
    out.push({
      id: String(p.id || ''),
      title: String(p.title || ''),
      board: String(p.board || ''),
      kind: String(p.kind || 'normal'),
      time: String(p.time || ''),
      at: Number(p.at) || 0,
      hidden: hidden,
      hiddenReason: hidden ? String(p.hiddenReason || '') : '',
      // 下架条目只带「有这回事」：标题照给（审核员在后台本来就看得见），
      // 正文和图片一律不带 —— 从名片页把违规内容再抄一遍毫无必要
      // 自己读自己的帖子要拿完整图片和正文，否则列表摘要会覆盖本机完整缓存，
      // 导致同一篇帖子有时完整、有时只剩前 60 字。他人名片仍只给摘要。
      images: hidden ? [] : (Array.isArray(p.images) ? p.images.slice(0, isSelf ? 9 : 3) : []),
      content: hidden ? '' : String(p.content || '').slice(0, isSelf ? 2000 : 60),
      likes: Number(p.likes) || 0,
      // 留言早已拆到独立集合，帖子上的 comments 数组只剩历史残留（大多是空的）。
      // 增量字段 commentCount 才是现在的真相来源
      commentCount: Number(p.commentCount) ||
        (Array.isArray(p.comments) ? p.comments.length : 0),
      pinned: !!p.pinned
    });
    if (out.length >= max) break;
  }
  return { ok: true, list: out, isMod: isMod };
}

/* ---------------- 私信 ---------------- */

// 一条私信最多几张图：再多就该拆成几条发，塞在一起对方也看不清
const CHAT_IMG_MAX = 6;

// 会话唯一键：谁跟谁聊只算一条，跟谁先开口无关（a_b 排序后拼）
function chatKey(a, b) {
  return [a, b].sort().join('_');
}

// 每句话只留最近 200 条：聊天记录无限涨会把文档撑大，读写都变慢
const CHAT_KEEP = 200;

/* ---------------- 私信消息的「有条件整份写回」 ---------------- */

// messages 是会话文档里的一个数组。发消息走的是原子 push；但「改其中一条」
// （撤回、摘掉违规图）改不了单条，只能把数组读出来、改一处、再整份写回 ——
// 而这一次整份写回会把这段时间里 push 进来的新消息一起抹掉。
// 表现为「刚发出去的话，一刷新就没了」，两人同时说话时才偶发，事后查日志
// 什么都看不出来，用户只会觉得"消息丢了"。
//
// 所以整份写回必须带条件：会话上维护一个 rev，push / add 时 +1，
// 写回时拿读到的 rev 当条件。命中 0 条说明中途有人发过消息 ——
// 重读、重算、再写一次。三次还对不上（只可能是两个人在猛发）就认输，
// 让用户重试，总比悄悄吞掉一条消息好。
const CHAT_CAS_TRIES = 3;

// mutate(chat) 返回要一起写的其它字段；返回 null 表示什么都不用改。
// 返回 { ok, wrote, gone, busy, noop }
async function chatUpdateMessages(chatId, mutate) {
  for (let i = 0; i < CHAT_CAS_TRIES; i += 1) {
    const r = await db.collection(COL_CHATS).where({ _id: chatId }).limit(1)
      .get().catch(() => ({ data: [] }));
    const chat = r.data && r.data[0];
    if (!chat) return { ok: false, gone: true };

    // 老会话没有 rev 字段，先把它补成 0 再走 CAS。
    // 用 inc(0) 而不是写死 0：字段不存在时结果是 0，已经存在时原地不动 ——
    // 万一这期间有人 push 过（rev 已经变成 1），这里也不会把那次 +1 抹掉。
    if (typeof chat.rev !== 'number') {
      await db.collection(COL_CHATS).where({ _id: chatId })
        .update({ data: { rev: db.command.inc(0) } }).catch(() => {});
      continue;
    }

    const rev = chat.rev;
    const patch = mutate(chat);
    if (!patch) return { ok: true, noop: true };

    const w = await db.collection(COL_CHATS).where({ _id: chatId, rev: rev })
      .update({ data: Object.assign({ rev: rev + 1 }, patch) })
      .catch(() => ({ stats: { updated: 0 } }));
    const n = (w && w.stats && w.stats.updated) || 0;
    if (n > 0) return { ok: true, wrote: true };
    // 0 条命中 = 读完之后有人发过消息，rev 已经变了：重读一遍再算
  }
  return { ok: false, busy: true };
}

/* ---------------- 非好友之间的消息配额 ---------------- */

// 这是本模块唯一的「事前」反骚扰闸门。
// 拉黑是「事后」手段 —— 对方得先挨够了骚扰才想起来拉黑；配额从一开始就把上限封死。
//
// 规则只有一条：**加为好友之前，双方各自最多 3 条；加为好友之后不限。**
// 刻意让它「一眼能背下来」—— 只要规则里出现「看情况」的分支，
// 用户看到「明明还剩 1 条却说用完」就会当成 bug，而解释起来谁也说不清。
//
// 为什么是 3 条，而不是 10 条：
//   ① 一条打招呼、一条说来意、一条补联系方式，正好把一件具体的事说完；
//   ② 「自我介绍」的职责已经由好友申请的 50 字留言承担了，不必在这里重复占额度；
//   ③ 骚扰成本被硬封顶：3 条消息 + 1 次好友申请 + 至多 1 条推送。
//      给到 10 条等于没限制 —— 收件人得先挨完 10 条才想起可以拉黑。
//
// ⚠️ 这里曾经有一条「对方回过我，就放宽到 20 条」的规则，现已去掉。
//   它想解决的是「双方一来一回之后，正常约时间地点立刻撞墙」，
//   但代价是把规则的形状从「3 条」变成「3 条或 20 条，看对方回没回」——
//   用户根本无从得知自己处在哪一档，撞墙时也无法预计还剩多少。
//   而「想继续聊」本来就有出口，而且是明确的出口：加为好友。
//   3 条加上好友申请那句留言，足够把「我是谁、为什么找你」说完并交出去。
//
// 计数口径：一条消息算一次，图文都算一次。发图同样占额度（广告重灾区）。
//
// 不按天重置：按天重置等于「每天 3 条」的永久骚扰通道。额度绑定「关系未建立」
//   这个状态，一次给足、用完为止，唯一的解锁路径是对方同意好友请求。
//   （解除好友会把这个状态重新打开，见 removeFriend：那时双方各拿到一份新的 3 条）
const STRANGER_QUOTA = 3;

// 我还能给 TA 发几条。已是好友时 isFriend 为真，下面几个数字全部无意义。
//
// used / peerUsed 直接数会话记录里的消息，不另存计数器：
// 非好友阶段每人上限 3 条，双方发满一共 6 条，远在 CHAT_KEEP(200) 之内 ——
// 而 chatSend 的 push 会保留最近 200 条，所以这份计数在「配额还有意义」的区间里
// 永远是准的，还省掉一个需要给老会话做迁移的新字段。
//
// since（会话上的 quotaResetAt）：解除好友时盖的时间戳，只数它之后的消息。
// 不加这道水位的话，数历史会把额度直接算成 0 —— 聊了半年的两个人一解除好友，
// 双方立刻都说不了话（连「你怎么把我删了」都发不出去），看着就像私信坏了。
async function chatQuota(openid, peer) {
  const FREE = { isFriend: true, limit: 0, used: 0, peerUsed: 0, left: 0, replied: false };
  // 这里不走 isFriendPair：它把查询失败也 catch 成「不是好友」，
  // 而那正是最不能出错的一种误判 —— 一对老同学聊了三百句，数据库抽一下风，
  // 就会被判成「陌生人已用满 3 条」当场锁死，而且理由完全看不出来。
  // 全站口径是「云端判断不了就不拦」，这里照办：查不到结果就按好友放行
  const rel = await db.collection(COL_FRIENDS)
    .where({ openid: openid, friend: peer }).limit(1).get()
    .catch(() => null);
  if (!rel) return Object.assign({}, FREE, { degraded: true });
  if (rel.data && rel.data.length) return FREE;

  const key = chatKey(openid, peer);
  const res = await db.collection(COL_CHATS).where({ key: key }).limit(1)
    .get().catch(() => ({ data: [] }));
  const rec = (res.data && res.data[0]) || null;
  const msgs = (rec && rec.messages) || [];
  // 只有真解除过好友才会有这个水位；为 0 时不套过滤，
  // 计数口径与历史版本完全一致（老会话一条都不会算错）
  const since = Number(rec && rec.quotaResetAt) || 0;

  let used = 0;
  let peerUsed = 0;
  msgs.forEach((m) => {
    if (!m) return;
    if (since && Number(m.at || 0) <= since) return;
    if (m.from === openid) used += 1;
    else if (m.from === peer) peerUsed += 1;
  });

  return {
    isFriend: false,
    limit: STRANGER_QUOTA,
    used: used,
    peerUsed: peerUsed,
    left: Math.max(0, STRANGER_QUOTA - used),
    replied: peerUsed > 0
  };
}

// 已读水位按「我在这段对话里的角色」分开记（readAtA / readAtB）。
// 一条会话只有一份文档、两个人在里面，若共用一个 readAt，
// 甲发消息时会把它顶成“已读”，乙那边就永远亮不起未读红点。
const readField = (rec, openid) => (rec.a === openid ? 'readAtA' : 'readAtB');
function myReadAt(rec, openid) {
  const v = rec.a === openid ? rec.readAtA : rec.readAtB;
  // 老会话只有共用的 readAt，且 denote 的是“发消息那位”的水位，直接拿来用
  if (v === undefined || v === null) return Number(rec.readAt || 0);
  return Number(v) || 0;
}

async function chatSend(openid, payload) {
  payload = payload || {};
  const to = String(payload.to || '');
  const text = String(payload.text || '').trim().slice(0, 300);
  // 配图：只认上传到本小程序 chat/ 目录下的云文件（见 sanitizeImages 的注释）
  const images = sanitizeImages(payload.images, 'chat', CHAT_IMG_MAX);
  if (!to) return { ok: false, msg: '没有指定对象' };
  if (to === openid) return { ok: false, msg: '不能给自己发消息' };
  // 纯图片消息是合法的：可以一个字都不写。但「文字和图片都空」不行
  if (!text && !images.length) {
    // 前端说有图却一条都没过白名单：多半是上传失败留下了本机路径 ——
    // 那条路径对方根本打不开，如实退回，别让用户以为发出去了
    if (payload.images && payload.images.length) {
      return { ok: false, msg: '图片没上传成功，重新选一次' };
    }
    return { ok: false, msg: '内容不能为空' };
  }

  // 服务端再过一遍审核：前端绕过云函数直接写库也躲不过这里。
  // 私信是监管重点，屏蔽词之外还要过一遍官方内容安全接口。
  if (text) {
    const g = await guard(text);
    if (!g.ok) return { ok: false, msg: g.msg };
  }
  // 纯图消息没有文字可审，图片走**异步**安全审核（见 submitMediaCheck）。
  // 提交在消息落库之后，结果由微信侧回推 —— 命中违规时再把图摘掉。
  // 为什么不是发之前同步拦：审核要几百毫秒到几秒，而「发消息」是高频动作，
  // 拦在这里等于把每张图的发送都做成了等待。
  //
  // ⚠️ 这条注释以前写的是「图片走 imgSecCheck 通道」，但全工程从来没有调用过
  //    那个接口 —— 注释描述的行为和代码实际做的事不一致，是最坏的一种注释：
  //    后来的人读到它就会以为图片已经有人管了，于是没人去补。

  // 对方把我拉黑了，连消息都发不出去。
  // 拉黑记录的方向是「我→TA」（openid 拉黑 target），所以要查的是「TA 有没有拉黑我」，
  // 写成 {openid: openid, target: to} 就变成「我是不是先拉黑了对方」，方向正好反了。
  const blk = await db.collection(COL_BLOCKS)
    .where({ openid: to, target: openid }).limit(1).get().catch(() => ({ data: [] }));
  if (blk.data && blk.data.length) return { ok: false, msg: '对方设置了消息限制' };

  // 反向也拦：我拉黑了对方，双方都不能继续发送（历史消息保留）。
  // 上面查的是「TA 有没有拉黑我」，这里查「我有没有拉黑 TA」。
  const blkMe = await db.collection(COL_BLOCKS)
    .where({ openid: openid, target: to }).limit(1).get().catch(() => ({ data: [] }));
  if (blkMe.data && blkMe.data.length) return { ok: false, msg: '你已拉黑对方，解除后才能发送' };

  // 非好友的配额闸门：这是「对方还没同意好友请求」这句话在服务端的唯一落点。
  // 刻意排在两个拉黑检查之后 —— 被拉黑的人该看到「对方设置了消息限制」，
  // 而不是「你发满了」：后者等于告诉骚扰者「换个号还能再发 3 条」。
  const quota = await chatQuota(openid, to);
  if (!quota.isFriend && quota.left <= 0) {
    // quota 恒为对象（成功时也是），前端只管往上套，不用分两种形状
    return {
      ok: false,
      quotaBlocked: true,
      quota: quota,
      msg: '你们还不是好友，你的 ' + quota.limit + ' 条消息已经发完了，加为好友后就不限了'
    };
  }

  const key = chatKey(openid, to);
  const msg = {
    id: 'msg' + Date.now() + Math.floor(Math.random() * 1000),
    from: openid,
    text: text,
    images: images,
    time: now(),
    at: Date.now()
  };
  // 会话列表里那行摘要：纯图消息没有正文，写 '[图片]' 顶上去，
  // 否则列表里会出现一条「对方发了东西但我这儿一片空白」的会话
  const summary = text || (images.length ? '[图片]' : '');

  const exist = await db.collection(COL_CHATS).where({ key: key }).limit(1).get().catch(() => ({ data: [] }));
  const rec = exist.data && exist.data[0];
  if (rec) {
    // 别整份读出来、改完、再整份写回去：两人同时发（或一端连发两句）时，
    // 后写的那份会盖掉先写的 —— 对方刷新就少一条消息。
    // push 的 slice 顺手做掉老消息的截断，效果跟原来一样，但加减是原子的
    // 我刚发过，说明这段对话「从我这边看」已经读过了 —— 只推进我那一侧的水位
    const patch = {};
    patch[readField(rec, openid)] = msg.at;
    const cw = await db.collection(COL_CHATS).where({ key: key }).update({
      data: Object.assign({
        messages: db.command.push({ each: [msg], slice: -CHAT_KEEP }),
        // 每一次 push 都要让 rev 动一下：撤回 / 摘违规图那边靠它判断
        // 「我读到的这份数组有没有过期」（见 chatUpdateMessages）
        rev: db.command.inc(1),
        updatedAt: Date.now(),
        lastAt: msg.at,
        lastText: summary,
        lastSys: false,
        // 请求箱状态：
        //   我发了话 → 这段对话从我这边已经「接下了」，不再算待处理的请求
        //   对方发的话要看我先前有没有把它扔进垃圾桶：扔过就重新变回一条待处理请求
        //     （扔过就一直沉底也不好，新的消息本来就该重新争取一次注意；
        //      而 3 条配额是累计的，所以「不停重发来刷屏」这条路本来就被封着）
        reqState: (rec.reqState === 'dismissed' && String(rec.reqBy || '') !== openid)
          ? '' : 'accepted'
      }, patch)
    }).catch((e) => ({ err: e }));
    if (cw && cw.err) {
      const d = dbErr(cw.err);
      console.error('[chatSend] write failed:', d.code, d.msg);
      return { ok: false, saved: false, msg: '消息没发出去，再试一次', detail: (d.code + ' ' + d.msg).trim() };
    }
  } else {
    const aw = await db.collection(COL_CHATS).add({
      data: {
        key: key, a: openid, b: to,
        messages: [msg], updatedAt: Date.now(),
        // 新会话从 1 起：rev 的意思是「这份 messages 被写过几次」，
        // 建会话本身就是第一次。0 留给「这个字段还不存在」的老文档
        rev: 1,
        lastAt: msg.at, lastText: summary, lastSys: false,
        readAtA: msg.at, readAtB: 0,
        // 新会话默认「已接下」：主动发起对话的人不需要再接受一次自己的请求
        reqState: 'accepted', reqBy: openid
      }
    }).catch((e) => ({ err: e }));
    if (aw && aw.err) {
      const d = dbErr(aw.err);
      console.error('[chatSend] add failed:', d.code, d.msg);
      return { ok: false, saved: false, msg: '消息没发出去，再试一次', detail: (d.code + ' ' + d.msg).trim() };
    }
  }

  // 图片异步审核：提交在消息落库之后。提交失败只是「这张图没审」，
  // 绝不能因此把已经写好的消息回滚（那样用户看到的是「发送失败」，
  // 但消息其实已经在对方会话里了，比不审更糟）
  if (images.length) {
    await submitMediaCheck(openid, images, {
      scene: 4,                // 4 = 社交日志，私信属于这一类
      targetType: 'chat',
      targetId: msg.id,
      peer: to,
      msgId: msg.id
    }).catch(() => {});
  }

  // 给接收方推订阅消息：私信是最需要「有人找你」提醒的场景。
  // 拿昵称要查一次库，放在消息写库之后，失败也不影响消息本身。
  const meRes = await db.collection(COL_USERS).doc(openid).get().catch(() => null);
  const nick = (meRes && meRes.data && meRes.data.nickName) || '同学';
  sendSubMsg(to, 'chat', {
    page: 'pages/user/chat/chat?peer=' + openid,
    fields: {
      thing1: { value: (nick + ' 给你发了一条私信').slice(0, 20) },
      // 纯图消息没有正文：摘要降级成 '[图片]'，别推一条空白提醒过去
      thing2: { value: (text || (images.length ? '[图片]' : '')).slice(0, 20) || '[图片]' },
      time3: { value: now() }
    }
  });
  // 把扣减后的额度一并发回：发起方要立刻把「还能发 N 条」改成 N-1。
  // 等下一次 load() 再刷新的话，连发两条时中间那一帧会显示错数
  return {
    ok: true,
    msg: msg,
    quota: quota.isFriend ? quota : Object.assign({}, quota, {
      used: quota.used + 1,
      left: Math.max(0, quota.left - 1)
    })
  };
}

// 我在这一侧把会话删掉的时刻。用「时间水位」而不是「删除名单」：
//   名单（deletedBy 数组）要求每条新消息都去把它清理掉，两个人同时操作时会互相覆盖；
//   水位只比大小 —— 最后一次发言晚于我的删除时刻，会话自然就回来了。
//   而且它是幂等的、并发安全的，代价只是多存一个数字字段。
const delField = (rec, openid) => (rec.a === openid ? 'delA' : 'delB');
function myDelAt(rec, openid) {
  return Number(rec.a === openid ? rec.delA : rec.delB) || 0;
}

// 会话列表：对方资料 + 最后一句 + 未读标记。
//
// 分两段返回：
//   requests —— 「消息请求」：还不是好友、我从来没回过、而且不是我删掉的那些会话
//   list     —— 主列表
// 为什么非要把陌生人消息隔离出来：主列表混进一条「XX 给你发了个兼职链接」，
// 用户点进去看到的第一条就是广告，而这条会话从此永远占着列表第一格。
// 收进请求箱之后，它只有在我主动点「接受」之后才进主列表。
async function chatList(openid, payload) {
  payload = payload || {};
  const limit = Math.max(1, Math.min(50, Number(payload.limit) || 50));
  const offset = Math.max(0, Number(payload.offset) || 0);

  // 拉一段比要展示的多一些，因为下面还要按「单侧删除」和请求箱过滤掉一部分。
  // 直接 skip/limit 的话，被过滤掉的那些会让每一页都变短，用户以为到底了
  const fetchMax = 100;
  const res = await db.collection(COL_CHATS)
    .where(db.command.or([{ a: openid }, { b: openid }]))
    .orderBy('updatedAt', 'desc').limit(fetchMax).get()
    .catch((e) => {
      console.error('[chatList] query failed:', String((e && e.errMsg) || e));
      return null;
    });
  // 查询失败与「真的没有会话」必须分得开：都回空列表的话，
  // 用户会以为自己的聊天记录被清了
  if (!res) return { ok: true, list: [], requests: [], degraded: true };

  // 一次把我所有好友取回来做集合，而不是逐个会话去问一遍是不是好友 ——
  // 50 条会话就是 50 次查询，这里只要 1 次（friendIdSet 内部共 3 次）
  const friends = await friendIdSet(openid);

  // 备注名：会话标题优先显示我给他起的名字
  const aliases = {};
  const fr = await db.collection(COL_FRIENDS).where({ openid: openid }).limit(FRIEND_MAX)
    .get().catch(() => ({ data: [] }));
  (fr.data || []).forEach((r) => { if (r.friend && r.alias) aliases[r.friend] = r.alias; });

  const rows = res.data || [];
  const peers = rows.map((r) => (r.a === openid ? r.b : r.a)).filter(Boolean);
  // 批量取对方资料：原来是一个会话一次 doc().get()，50 条会话 50 次往返。
  // 好友多一点 + 会话多一点就会撞上云函数超时，表现为「私信列表一直转圈」
  const users = {};
  for (let i = 0; i < peers.length; i += 100) {
    const chunk = peers.slice(i, i + 100);
    // eslint-disable-next-line no-await-in-loop
    const ur = await db.collection(COL_USERS)
      .where({ _id: db.command.in(chunk) }).limit(100).get()
      .catch(() => ({ data: [] }));
    (ur.data || []).forEach((u) => { users[u._id] = u; });
  }

  const list = [];
  const requests = [];
  rows.forEach((r) => {
    const peer = r.a === openid ? r.b : r.a;
    if (!peer) return;
    const msgs = r.messages || [];
    const last = msgs[msgs.length - 1] || {};
    const lastAt = Number(r.lastAt || last.at || 0);

    // 我删过、而且删之后对方没再说话 → 不显示（对方一开口自然回来）
    if (myDelAt(r, openid) >= lastAt) return;
    // 最后一条是对方发的，而且比我的删除水位新 —— 说明我删过之后他又发了，
    // 这种情况按「新消息」处理，不该因为下面的请求箱规则被永久压住

    const u = users[peer] || {};
    const isFriend = !!friends[peer];
    const lastFrom = String(last.from || '');
    const unread = last.from && last.from !== openid && last.from !== 'system'
      && myReadAt(r, openid) < Number(last.at || 0) ? 1 : 0;

    const item = {
      peer: peer,
      nickName: aliases[peer] || u.nickName || '某个同学',
      alias: aliases[peer] || '',
      avatarUrl: u.avatarUrl || '',
      college: u.college || '',
      // 纯图消息的 lastText 兜底成 '[图片]'：老会话没有这个降级，
      // 列表里会显示成一整条空白，用户以为消息丢了
      lastText: r.lastText || last.text || ((last.images && last.images.length) ? '[图片]' : ''),
      lastTime: r.lastAt || r.updatedAt || '',
      lastSys: !!r.lastSys,
      unread: unread,
      updatedAt: r.updatedAt || 0,
      // 还不是好友的会话在列表里要打标：这类对话有配额上限、对方也未必愿意聊，
      // 和同学之间的会话混在一起，用户点进去才发现「怎么发不出去了」
      isFriend: isFriend
    };

    // 请求箱的判定，三个条件缺一不可：
    //   ① 还不是好友；② 最后一句是对方发的（我回过就不算请求了）；
    //   ③ 我没有明确接受过，也没有把它扔进垃圾桶
    const pendingReq = !isFriend && lastFrom === peer
      && r.reqState !== 'accepted' && r.reqState !== 'dismissed';
    if (pendingReq) requests.push(item);
    else if (!(r.reqState === 'dismissed' && lastFrom === peer)) list.push(item);
    // 上面这一行：被我扔掉的会话，在对方没再开口之前不进主列表。
    // 对方再发一条时 chatSend 会把 reqState 清空，它就变回一条待处理请求
  });

  return {
    ok: true,
    list: list.slice(offset, offset + limit),
    requests: requests.slice(offset, offset + limit),
    total: list.length,
    requestTotal: requests.length,
    hasMore: offset + limit < list.length,
    requestHasMore: offset + limit < requests.length
  };
}

// 接受一条消息请求：相当于「把这个人放进我的收件箱」。
// 刻意**不顺手加好友** —— 接受的是「我愿意收你的消息」，
// 而加好友要交出联系方式，是另一件更重的事。两件事混在一起做，
// 用户按下「接受」时会不知道自己还答应了什么。
async function chatAccept(openid, payload) {
  payload = payload || {};
  const peer = String(payload.peer || '');
  if (!peer || peer === openid) return { ok: false, msg: '参数不对' };
  const key = chatKey(openid, peer);
  const r = await db.collection(COL_CHATS).where({ key: key }).limit(1).get().catch(() => ({ data: [] }));
  const rec = r.data && r.data[0];
  if (!rec) return { ok: true, already: true };
  await db.collection(COL_CHATS).doc(rec._id)
    .update({ data: { reqState: 'accepted', reqBy: openid } }).catch(() => {});
  return { ok: true, accepted: true };
}

// 把一条消息请求扔进垃圾桶。会话本身不删（聊天记录还在），只是不再占列表位置。
// 对方再发一条就会重新回来 —— 这是刻意的：一个直接的「永久屏蔽」按钮
// 会让用户在气头上把以后真的想联系的人一起扔掉，而这个决定没有反悔路径。
// 真要彻底断掉，正确的动作是拉黑。
async function chatDismiss(openid, payload) {
  payload = payload || {};
  const peer = String(payload.peer || '');
  if (!peer || peer === openid) return { ok: false, msg: '参数不对' };
  const key = chatKey(openid, peer);
  const r = await db.collection(COL_CHATS).where({ key: key }).limit(1).get().catch(() => ({ data: [] }));
  const rec = r.data && r.data[0];
  if (!rec) return { ok: true, already: true };
  await db.collection(COL_CHATS).doc(rec._id)
    .update({ data: { reqState: 'dismissed', reqBy: openid } }).catch(() => {});
  return { ok: true, dismissed: true };
}

// 撤回一条自己发的消息，限 2 分钟。
//
// 为什么是 2 分钟：微信本身也是这个尺度。再长就会出现「我引用了他一句话，
// 回头那句话不见了」，对话的一方看到的上下文和另一方不一样。
// 2 分钟足够覆盖「打错字 / 发错人 / 手滑」，又不至于破坏对话的稳定性。
//
// 撤回不退额度：非好友的 3 条是反骚扰闸门，如果撤回能退款，
// 骚扰者就得到一条「发出去 → 撤回 → 再发」的无限通道。
const RECALL_MS = 2 * 60 * 1000;

// 撤回前的校验。进 CAS 前要跑一遍，CAS 重读之后还要再跑一遍
// （那期间消息可能已经被截断出 200 条之外，或者已经被撤过了），所以抽出来
function recallCheck(msgs, openid, msgId) {
  const target = msgs.filter((m) => m && String(m.id) === msgId)[0];
  if (!target) return { ok: false, msg: '这条消息已经不在了' };
  if (String(target.from || '') !== openid) return { ok: false, msg: '只能撤回自己发的消息' };
  if (target.recalled) return { ok: true, already: true };
  if (Date.now() - (Number(target.at) || 0) > RECALL_MS) {
    return { ok: false, msg: '超过 2 分钟了，撤不回来' };
  }
  return { ok: true };
}

async function chatRecall(openid, payload) {
  payload = payload || {};
  const peer = String(payload.peer || '');
  const msgId = String(payload.msgId || '');
  if (!peer || !msgId) return { ok: false, msg: '参数缺失' };
  const key = chatKey(openid, peer);
  const r = await db.collection(COL_CHATS).where({ key: key }).limit(1).get().catch(() => ({ data: [] }));
  const rec = r.data && r.data[0];
  if (!rec) return { ok: false, msg: '这段对话已经不在了' };

  const first = recallCheck(rec.messages || [], openid, msgId);
  if (first.already) return { ok: true, already: true };
  if (!first.ok) return { ok: false, msg: first.msg };

  // 写入走 CAS，不是「把刚才读到的那份数组原样写回去」：
  // 校验通过到写回之间有几百毫秒，对方（或自己另一台设备）这时发一条消息，
  // 整份写回就会把它抹掉 —— 见 chatUpdateMessages
  let isLast = false;
  const w = await chatUpdateMessages(rec._id, (chat) => {
    const msgs = chat.messages || [];
    const again = recallCheck(msgs, openid, msgId);
    if (!again.ok || again.already) return null; // 重读时已经不可撤了，不用写
    isLast = String((msgs[msgs.length - 1] || {}).id) === msgId;
    return {
      messages: msgs.map((m) => (m && String(m.id) === msgId
        ? Object.assign({}, m, { recalled: true, text: '', images: [] })
        : m))
    };
  });
  if (w && w.gone) return { ok: false, msg: '这段对话已经不在了' };
  if (w && w.noop) return { ok: true, already: true };
  if (w && w.busy) return { ok: false, msg: '正在收发消息，再点一次撤回' };

  // 会话列表那行摘要如果正好是这条，也要跟着改，否则列表里还写着被撤回的内容。
  // 只改 lastText 一个字段、不碰数组，所以不需要进 CAS
  if (isLast) {
    await db.collection(COL_CHATS).doc(rec._id)
      .update({ data: { lastText: '[消息已撤回]' } }).catch(() => {});
  }
  return { ok: true, recalled: true };
}

// 删除会话（只删我这一侧）。聊天记录不物理删除：
//   ① 对方那一侧的记录还在，单方面抹掉会造成「同一段对话两个人看到的不一样」；
//   ② 被骚扰的人需要留着证据去举报（见 reportPerson 的证据快照）。
// 所以这里只打一个时间水位，我的列表里不再出现；对方再发消息它就回来。
async function chatRemove(openid, payload) {
  payload = payload || {};
  const peer = String(payload.peer || '');
  if (!peer || peer === openid) return { ok: false, msg: '参数不对' };
  const key = chatKey(openid, peer);
  const r = await db.collection(COL_CHATS).where({ key: key }).limit(1).get().catch(() => ({ data: [] }));
  const rec = r.data && r.data[0];
  if (!rec) return { ok: true, already: true };

  const data = {};
  data[delField(rec, openid)] = Math.max(
    Number(rec.lastAt || 0) || 0,
    Number(rec.updatedAt || 0) || 0,
    Date.now()
  );
  await db.collection(COL_CHATS).doc(rec._id).update({ data: data }).catch(() => {});
  return { ok: true, removed: true };
}

// 聊天记录：打开会话即已读，不用额外点「标为已读」
async function chatHistory(openid, payload) {
  payload = payload || {};
  const peer = String(payload.peer || '');
  if (!peer || peer === openid) return { ok: false, msg: '参数不对' };

  const key = chatKey(openid, peer);
  const res = await db.collection(COL_CHATS).where({ key: key }).limit(1).get().catch(() => ({ data: [] }));
  const rec = res.data && res.data[0];
  const messages = (rec && rec.messages) ? rec.messages : [];
  if (rec && messages.length) {
    const lastAt = messages[messages.length - 1].at || 0;
    if (myReadAt(rec, openid) < Number(lastAt)) {
      // 只推进「我」这一侧的水位，不影响对方那侧的未读
      const patch = {};
      patch[readField(rec, openid)] = lastAt;
      await db.collection(COL_CHATS).where({ key: key })
        .update({ data: patch }).catch(() => {});
    }
  }
  // 增量拉取：带上 after 时只回这个水位之后的消息，供前端轮询用。
  // 不加这个参数就整段回 —— 轮询时每次搬 200 条历史是纯浪费，
  // 而校园网环境下这几百 KB 恰好就是「刷新有点卡」那一下。
  const after = Number(payload.after) || 0;
  const src = after ? messages.filter((m) => Number((m && m.at) || 0) > after) : messages.slice(-CHAT_KEEP);

  // images 统一补成数组：老消息没有这个字段，前端 WXML 里 item.images.length 会取到 undefined。
  // sys 标记一下：系统消息（「你们已解除同学关系」那类）在气泡里要单独一种样式，
  // 也不能让它有机会被当成对方说的话
  const slice = src.map((m) => Object.assign({}, m, {
    mine: m.from === openid,
    sys: !!m.sys || String(m.from || '') === 'system',
    images: Array.isArray(m.images) ? m.images : []
  }));

  const p = await db.collection(COL_USERS).doc(peer).get().catch(() => null);
  const u = (p && p.data) || {};
  const alias = await friendAliasOf(openid, peer);

  // 黑名单状态：会话页据此显示「拉黑 / 解除拉黑」并限制发送。
  // 顺带把「关系 + 剩余额度」和「我有没有在等对方回应」一起取回来 ——
  // 会话页要据此显示「还不是好友，还剩 N 条」、锁输入框、以及把按钮
  // 显示成「申请加好友 / 已申请，等回应」
  const [blkMe, blkThem, quota, outReq, inReq] = await Promise.all([
    db.collection(COL_BLOCKS).where({ openid: openid, target: peer }).limit(1).get().catch(() => ({ data: [] })),
    db.collection(COL_BLOCKS).where({ openid: peer, target: openid }).limit(1).get().catch(() => ({ data: [] })),
    chatQuota(openid, peer),
    // ⚠️ 只按单字段 where 取回来、再在内存里过滤 toOpenid + status：
    // 多字段 where 在没建索引时可能直接报错，而外面套着 catch 就会静默变成
    // 「没申请过」—— 于是「申请加好友」按钮反复出现，点下去只得到一句
    // 「已经发起过了」。这个坑 listRequests 上已经踩过一次，不再踩第二次
    db.collection(COL_CONTACTS).where({ fromOpenid: openid }).limit(100)
      .get().catch(() => ({ data: [] })),
    // 反向：对方申请了我、还没被处理。会话页据此把按钮换成「同意加好友」——
    // 否则两人会各自发一条反向申请，谁也没按下去，消息还卡在额度里
    db.collection(COL_CONTACTS).where({ toOpenid: openid }).limit(100)
      .get().catch(() => ({ data: [] }))
  ]);
  const requested = (outReq.data || []).some((r) => r.toOpenid === peer && r.status === 'pending');
  const incoming = (inReq.data || []).filter((r) => r.fromOpenid === peer && r.status === 'pending')[0];

  // 对方的阅读水位：会话页据此在我发出的最后一条上标「已读 / 未读」。
  // 这个水位一直在推进（谁打开会话就推进谁那一侧），只是从来没回给前端，
  // 于是发送方永远只能猜对方看没看
  const peerReadAt = rec ? myReadAt(rec, peer) : 0;

  return {
    ok: true,
    messages: slice,
    peerReadAt: peerReadAt,
    blockedByMe: !!(blkMe.data && blkMe.data.length),
    blockedByThem: !!(blkThem.data && blkThem.data.length),
    isFriend: quota.isFriend,
    quota: quota,
    requested: requested,
    // 已经是好友就没有「同意」这回事了；带 id 是因为 friendAccept 要按申请记录操作
    incomingRequest: (!quota.isFriend && incoming) ? { id: incoming._id, message: incoming.message || '' } : null,
    // 会话页顶部的「关系状态条」靠这三个字段：
    //   isFriend / quota 决定还剩几条，reqState 决定要不要显示「接受/忽略」那一行。
    // 没有它们，用户只会看到输入框突然变灰，而不知道为什么 ——
    // 解除好友之后尤其如此，那一边根本不知道关系已经变了
    reqState: String((rec && rec.reqState) || ''),
    peer: {
      openid: peer,
      nickName: alias || u.nickName || '某个同学',
      alias: alias,
      avatarUrl: u.avatarUrl || '',
      college: u.college || '',
      // 联系方式只在互认好友之间给。原先这里是**无条件返回**的：
      // 名片页严格判了 isFriend，私信页却把微信号直接吐出来 ——
      // 等于「不用加好友也能拿到联系方式」，把好友那道门整个绕过去了
      contactType: quota.isFriend ? (u.contactType || '') : '',
      contactValue: quota.isFriend ? (u.contactValue || '') : ''
    }
  };
}

/* ---------------- 冷启动种子 ---------------- */

// 新用户进来时云端往往是空的。库里一条帖子都没有时，把示例内容写进去，
// 让第一个人之后进来就有东西看；已经有人发过真帖子就完全不动。
async function ensureSeed(payload) {
  if (process.env.ALLOW_SEED !== '1') {
    return { ok: false, msg: '示例内容写入未开启' };
  }
  const data = payload || {};
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const reviews = Array.isArray(data.reviews) ? data.reviews : [];
  if (!posts.length) return { ok: false, msg: '没有种子数据' };

  const exist = await db.collection('posts').limit(1).get().catch(() => ({ data: [] }));
  if (exist.data && exist.data.length) return { ok: true, seeded: false };

  const postIds = {};
  const revIds = {};
  reviews.forEach((r) => { revIds[r.id] = true; });

  for (const p of posts) {
    if (postIds[p.id]) continue;
    postIds[p.id] = true;
    // eslint-disable-next-line no-await-in-loop
    await db.collection('posts').add({
      data: {
        id: p.id,
        board: p.board,
        title: p.title,
        content: p.content,
        author: p.author,
        time: p.time,
        likes: p.likes || 0,
        liked: false,
        images: p.images || [],
        courseId: p.courseId || '',
        courseName: p.courseName || '',
        comments: p.comments || [],
        seed: true
      }
    }).catch(() => {});
  }

  for (const r of reviews) {
    if (revIds[r.id]) continue;
    revIds[r.id] = true;
    // eslint-disable-next-line no-await-in-loop
    await db.collection('reviews').add({
      data: {
        id: r.id,
        courseId: r.courseId,
        nickName: r.nickName,
        anonymous: !!r.anonymous,
        score: r.score,
        content: r.content,
        time: r.time,
        tags: r.tags || [],
        openid: '',
        seed: true
      }
    }).catch(() => {});
  }

  return { ok: true, seeded: true };
}

/* ---------------- 学习资料共享 ---------------- */

// 文件本体存在云存储，这里只存元数据。
// 下载一律走云函数换临时链接：云存储权限设成「仅创建者可读写」时，
// 别人拿 fileID 也打不开，必须服务端签发临时 URL。
const RESOURCE_CATS = ['笔记', '真题', '讲义', '其他'];

function decorateResource(r, me) {
  const openid = r.openid || r._openid || '';
  const thanks = Array.isArray(r.thanks) ? r.thanks : [];
  return Object.assign({}, r, {
    openid: openid,
    isMine: !!me && openid === me,
    thanks: thanks,
    thanksCount: thanks.length,
    thanked: !!me && thanks.indexOf(me) >= 0,
    status: String(r.status || 'normal'),
    // pending / rejected 只给作者本人和审核员看。列表里把状态写在卡片上，
    // 作者才知道「不是没传上去，是在等审核 / 没通过」。
    statusText: String(r.status || 'normal') === 'pending' ? '审核中'
      : (String(r.status || 'normal') === 'rejected' ? '未通过' : ''),
    reviewReason: String(r.reviewReason || ''),
    sizeText: r.size ? (Number(r.size) > 1048576
      ? (Number(r.size) / 1048576).toFixed(1) + ' MB'
      : Math.max(1, Math.round(Number(r.size) / 1024)) + ' KB') : ''
  });
}

async function resourceAdd(openid, payload) {
  payload = payload || {};
  const r = payload.resource || {};
  const title = String(r.title || '').trim().slice(0, 40);
  const fileID = String(r.fileID || '').trim();
  const author = String(r.author || '浙小商').slice(0, 20);
  const fileName = String(r.fileName || '').slice(0, 60);
  const size = Number(r.size) || 0;
  if (!title) return { ok: false, msg: '给资料起个名字吧' };
  if (!fileID) return { ok: false, msg: '文件没上传成功，重新选一次' };
  if (!isCloudFileIn(fileID, 'resources')) return { ok: false, msg: '文件地址不合法' };
  if (size > 20 * 1024 * 1024) return { ok: false, msg: '资料文件需在 20MB 以内' };
  const g = await guard(title, String(r.desc || ''), String(r.courseName || ''), fileName, author);
  if (!g.ok) return { ok: false, msg: g.msg };

  const doc = {
    id: String(r.id || ('res' + Date.now() + Math.floor(Math.random() * 1000))),
    title: title,
    desc: String(r.desc || '').slice(0, 200),
    fileID: fileID,
    fileName: fileName,
    size: size,
    category: RESOURCE_CATS.indexOf(r.category) >= 0 ? r.category : '其他',
    courseName: String(r.courseName || '').slice(0, 30),
    author: author,
    openid: openid,
    time: now(),
    at: Date.now(),
    thanks: [],
    // 先审后发：文件本体已经上传，但元数据先不进公开列表。
    // 审核员在资料页的「待审核」区通过后，才改成 normal 对全校可见。
    status: 'pending',
    reviewStatus: 'pending',
    submittedAt: now(),
    reviewReason: ''
  };
  await db.collection(COL_RESOURCES).add({ data: doc });
  return { ok: true, pending: true, resource: decorateResource(doc, openid) };
}

async function resourceList(openid, payload) {
  payload = payload || {};
  const category = String(payload.category || '');
  const courseName = String(payload.courseName || '').trim();
  // 一次拉 400 条。原来是 60：历年真题批量导进来之后「真题」这一档就有 185 份，
  // 60 条的上限会把它们（连同同学新传的资料）一起挡在列表外 ——
  // 而且是按时间倒序，新传一份笔记，最老的真题就消失一份，谁也发现不了。
  // 元数据每份不到 200B，400 条一次拉回是几十 KB，远低于单次返回上限
  const res = await db.collection(COL_RESOURCES)
    .orderBy('at', 'desc').limit(400).get().catch(() => null);
  let list = ((res && res.data) || []).filter((r) => {
    const st = String(r.status || 'normal');
    if (st === 'normal') return true;
    // 作者自己要看得到「审核中 / 未通过」，否则刚传完就像凭空消失了；
    // 别人的 pending / rejected 一律不出现在公开列表里。
    const mine = !!openid && String(r.openid || r._openid || '') === openid;
    return mine && (st === 'pending' || st === 'rejected');
  });
  if (category && category !== '全部') list = list.filter((r) => (r.category || '其他') === category);
  if (courseName) {
    const kw = courseName.toLowerCase();
    list = list.filter((r) => String(r.courseName || '').toLowerCase().indexOf(kw) >= 0
      || String(r.title || '').toLowerCase().indexOf(kw) >= 0);
  }
  return { ok: true, list: list.map((r) => decorateResource(r, openid)) };
}

// 审核员资料队列：只拉 pending，按提交时间倒序。
// 只给审核员看，普通用户调了会被 denyReason 拦下。
async function resourceQueue(openid) {
  const err = await denyReason(openid);
  if (err) return { ok: false, msg: err, list: [] };
  const res = await db.collection(COL_RESOURCES)
    .where({ status: 'pending' }).orderBy('at', 'desc').limit(100).get()
    .catch(() => null);
  if (!res) return { ok: false, msg: '资料审核队列读取失败，请稍后重试', list: [] };
  return { ok: true, list: (res.data || []).map((r) => decorateResource(r, openid)) };
}

// 资料审核结果：approve = 公开；reject = 不公开，作者仍能在列表里看到原因。
// 这一步只改元数据，不删云存储文件 —— 驳回后要留证据，误判也能恢复。
async function resourceReview(openid, payload) {
  const err = await denyReason(openid);
  if (err) return { ok: false, msg: err };
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const decision = payload.decision === 'approve' ? 'approve' : 'reject';
  const reason = String(payload.reason || '').trim().slice(0, 80);
  if (decision === 'reject' && !reason) return { ok: false, msg: '写一句驳回原因' };

  const hit = await db.collection(COL_RESOURCES).where({ id: id }).limit(1).get()
    .catch(() => null);
  const rec = hit && hit.data && hit.data[0];
  if (!rec) return { ok: false, msg: '资料不存在' };
  if (String(rec.status || 'normal') !== 'pending') {
    return { ok: false, msg: '这条资料已经处理过了' };
  }

  const approved = decision === 'approve';
  const data = approved
    ? {
      status: 'normal', reviewStatus: 'approved', hidden: false, deleted: false,
      reviewedBy: openid, reviewedAt: now(), reviewReason: ''
    }
    : {
      status: 'rejected', reviewStatus: 'rejected', hidden: true, deleted: false,
      reviewedBy: openid, reviewedAt: now(), reviewReason: reason
    };
  const w = await db.collection(COL_RESOURCES)
    .where({ id: id, status: 'pending' }).update({ data: data })
    .catch((e) => ({ err: e }));
  if (w && w.err) return { ok: false, msg: '资料状态没存住，再试一次' };
  if (!w || !w.stats || Number(w.stats.updated) < 1) {
    return { ok: false, msg: '这条资料已经处理过了' };
  }

  await logMod(openid, approved ? 'resourceApprove' : 'resourceReject',
    'resource', id, approved ? String(rec.title || '') : reason).catch(() => {});
  await pushNotify(rec.openid, {
    type: 'resource',
    title: approved ? '资料审核通过' : '资料未通过审核',
    body: approved
      ? '你分享的资料已经公开展示，谢谢分享'
      : ('未通过原因：' + reason).slice(0, 120),
    page: 'pages/tool/resources/resources',
    targetId: id
  }).catch(() => {});
  return { ok: true, approved: approved };
}
// 换临时下载链接：云存储权限收紧也照样能下载，且不暴露永久地址
async function resourceUrl(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const hit = await db.collection(COL_RESOURCES).where({ id: id }).limit(1).get().catch(() => ({ data: [] }));
  const rec = hit.data && hit.data[0];
  if (!rec) return { ok: false, msg: '资料不存在' };
  const st = String(rec.status || 'normal');
  if (st !== 'normal' || rec.hidden || rec.deleted) {
    const mine = !!openid && String(rec.openid || rec._openid || '') === openid;
    const mod = mine ? false : await isModerator(openid);
    // 作者要能打开自己待审核/被驳回的文件；审核员要能打开 pending 文件核对内容。
    if (!mine && !mod) return { ok: false, msg: '资料已被下架' };
    if (rec.deleted && !mod) return { ok: false, msg: '资料已被删除' };
  }
  if (!isCloudFileIn(rec.fileID, 'resources')) return { ok: false, msg: '资料文件地址不合法' };
  try {
    const r = await cloud.getTempFileURL({ fileList: [rec.fileID] });
    const f = r && r.fileList && r.fileList[0];
    if (!f || !f.tempFileURL) return { ok: false, msg: '文件链接获取失败' };
    return { ok: true, url: f.tempFileURL, fileName: rec.fileName || rec.title };
  } catch (e) {
    return { ok: false, msg: '文件链接获取失败' };
  }
}

async function resourceThanks(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const hit = await db.collection(COL_RESOURCES).where({ id: id }).limit(1).get().catch(() => ({ data: [] }));
  const rec = hit.data && hit.data[0];
  if (!rec) return { ok: false, msg: '资料不存在' };
  // 「感谢」只对已公开的资料开放：审核中 / 未通过 / 已下架都不该累计感谢。
  if ((rec.status || 'normal') !== 'normal' || rec.hidden || rec.deleted) {
    return { ok: false, msg: '资料已被下架' };
  }
  const thanks = Array.isArray(rec.thanks) ? rec.thanks : [];
  const on = thanks.indexOf(openid) < 0;
  // 别整份读出来再整份写回去：多个人同时点「感谢」，后写的那份会把先写的那份盖掉。
  // 用 pull / push 各自原子做，谁后写都不吞人
  const data = {};
  if (on) {
    data.thanks = db.command.push(openid);
    data.thanksCount = db.command.inc(1);
  } else {
    data.thanks = db.command.pull(openid);
    data.thanksCount = db.command.inc(-1);
  }
  const tw = await db.collection(COL_RESOURCES).where({ id: id })
    .update({ data: data }).catch((e) => ({ err: e }));
  if (tw && tw.err) {
    const d = dbErr(tw.err);
    console.error('[resourceThanks] write failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '没能记上，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  // 回读一份最新的当返回值：老数据可能压根没有 thanksCount 这个字段，
  // 直接在 undefined 上 inc(-1) 会算出 -1 并永远卡在负数。名单数组才是权威值
  const fresh = await db.collection(COL_RESOURCES).where({ id: id }).limit(1).get().catch(() => null);
  const fr = fresh && fresh.data && fresh.data[0];
  const arr = (fr && fr.thanks) || [];
  const raw = fr ? fr.thanksCount : null;
  const count = (typeof raw === 'number' && raw >= 0) ? raw : arr.length;
  // 字段缺失或已经算成负数，顺手修回来，免得下次接着错
  if (typeof raw !== 'number' || raw < 0) {
    await db.collection(COL_RESOURCES).where({ id: id })
      .update({ data: { thanksCount: arr.length } }).catch(() => {});
  }
  return { ok: true, thanked: on, thanksCount: count };
}

async function resourceRemove(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const hit = await db.collection(COL_RESOURCES).where({ id: id }).limit(1).get().catch(() => ({ data: [] }));
  const rec = hit.data && hit.data[0];
  if (!rec) return { ok: true };
  const owner = String(rec.openid || rec._openid || '') === openid;
  if (!owner && !(await isModerator(openid))) return { ok: false, msg: '只能删除自己上传的资料' };
  const rm = await db.collection(COL_RESOURCES).where({ id: id }).remove().catch((e) => ({ err: e }));
  if (rm && rm.err) return { ok: false, saved: false, msg: '资料没删掉，再试一次' };
  if (rec.fileID) {
    await cloud.deleteFile({ fileList: [rec.fileID] }).catch((e) => {
      console.error('[resourceRemove] deleteFile failed:', String((e && e.errMsg) || e));
    });
  }
  return { ok: true };
}

/* ---------------- 校历 ---------------- */

// 官方校历（2026-09-26 从教务处《关于2026-2027学年第一学期本科教学相关工作的通知》抄录）：
//   9月14日(周一)正式上课；共18周=教学16周+复习考试2周；期中考试拟第8-10周；
//   中秋 9/25-9/27；国庆 10/1-10/7；四六级口语 11/21-22、笔试 12/12；
//   1月18日(周一)起放寒假（即期末考试周为 1/4-1/17）。
//   考研初试与春季开学日期官方暂未公布，标了「预计」，审核员可在校历页里改。
const DEFAULT_CALENDAR = [
  { id: 'cal-midterm', name: '期中考试周（第8-10周）', date: '2026-11-02', type: 'exam', note: '教务拟定，以学院通知为准' },
  { id: 'cal-cet-spoken', name: '四六级口语考试', date: '2026-11-21', type: 'exam', note: '11月21-22日，两天' },
  { id: 'cal-cet', name: '四六级笔试', date: '2026-12-12', type: 'exam', note: '考前一周打印准考证' },
  { id: 'cal-kaoyan', name: '考研初试', date: '2026-12-26', type: 'exam', note: '预计12月26-27日，以研招网为准' },
  { id: 'cal-final', name: '期末考试周', date: '2027-01-04', type: 'exam', note: '第17-18周，停课复习' },
  { id: 'cal-winter', name: '寒假开始', date: '2027-01-18', type: 'term', note: '1月18日（周一）起放寒假' },
  { id: 'cal-spring', name: '春季学期开学', date: '2027-03-01', type: 'term', note: '预计，以学校校历为准' }
];

// 官方校历的「指纹」：教务处出新通知后改这里，calendarReset 一键刷新全校数据
const CALENDAR_VER = '2026-2027-1-official';

async function calendarList() {
  const res = await db.collection(COL_CALENDAR).orderBy('date', 'asc').limit(50).get().catch(() => null);
  let list = (res && res.data) || null;
  // 第一次进来库是空的：把预置节点写进去再返回，省得校历永远空白
  if (!list || !list.length) {
    for (const item of DEFAULT_CALENDAR) {
      // eslint-disable-next-line no-await-in-loop
      await db.collection(COL_CALENDAR).where({ id: item.id }).limit(1).get()
        .then((r) => {
          if (!(r && r.data && r.data.length)) {
            return db.collection(COL_CALENDAR).add({ data: Object.assign({}, item, { at: Date.now() }) });
          }
          return null;
        })
        .catch(() => {});
    }
    list = DEFAULT_CALENDAR.slice();
  }
  return { ok: true, list: list };
}

async function calendarSave(openid, payload) {
  payload = payload || {};
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能改校历' };
  const item = payload.item || {};
  const name = String(item.name || '').trim().slice(0, 30);
  const date = String(item.date || '').trim().slice(0, 10);
  if (!name || !date) return { ok: false, msg: '名称和日期都要填' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, msg: '日期格式写成 2026-12-12 这样' };
  const data = {
    id: String(item.id || ('cal' + Date.now())),
    name: name,
    date: date,
    type: String(item.type || 'other').slice(0, 10),
    note: String(item.note || '').slice(0, 60),
    at: Date.now()
  };
  const exist = await db.collection(COL_CALENDAR).where({ id: data.id }).limit(1).get().catch(() => ({ data: [] }));
  if (exist.data && exist.data.length) {
    await db.collection(COL_CALENDAR).where({ id: data.id }).update({ data: data }).catch(() => {});
  } else {
    await db.collection(COL_CALENDAR).add({ data: data }).catch(() => {});
  }
  return { ok: true, item: data };
}

async function calendarRemove(openid, payload) {
  payload = payload || {};
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能改校历' };
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  await db.collection(COL_CALENDAR).where({ id: id }).remove().catch(() => {});
  return { ok: true };
}

// 一键导入官方校历：清掉旧节点、灌入 DEFAULT_CALENDAR（数据来源见上方注释）。
// 给审核员的按钮用 —— 老库里存着旧版预置日期时，跑一次就能整体升级成官方版。
async function calendarReset(openid) {
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能导入校历' };
  await db.collection(COL_CALENDAR).where({}).remove().catch(() => {});
  for (const item of DEFAULT_CALENDAR) {
    // eslint-disable-next-line no-await-in-loop
    await db.collection(COL_CALENDAR).add({
      data: Object.assign({}, item, { ver: CALENDAR_VER, at: Date.now() })
    }).catch(() => {});
  }
  return { ok: true, msg: '已导入教务处官方校历 ' + DEFAULT_CALENDAR.length + ' 条', list: DEFAULT_CALENDAR };
}

/* ---------------- 校园地点 ---------------- */

// 经纬度由前端 wx.chooseLocation 在地图上点出来，不手写——手写坐标百分百有偏差，
// 而 openLocation 一旦坐标错了，导航会把同学带到隔壁学校去。
// 预置地点例外：名称来自学校官网（三个食堂、校医院、生活区等），
// 坐标来自公开地图数据（OpenStreetMap，已转 GCJ-02，教学楼定位可精确到楼）。
// 权限「所有用户可读」，审核员/同学后续仍可在地图上重新选点校准。
const PLACE_CATS = ['教学楼', '食堂', '宿舍', '快递', '运动', '其他'];

const DEFAULT_PLACES = [
  { id: 'pl-lib', name: '图书馆', category: '教学楼', desc: '自习室 8:00-22:30，图书馆广场中央是「勤」时钟花坛', latitude: 30.30997, longitude: 120.38964, official: true },
  { id: 'pl-tA', name: 'A 教学楼', category: '教学楼', desc: '', latitude: 30.30938, longitude: 120.39164, official: true },
  { id: 'pl-tB', name: 'B 教学楼', category: '教学楼', desc: '', latitude: 30.30983, longitude: 120.39221, official: true },
  { id: 'pl-tC', name: 'C 教学楼', category: '教学楼', desc: '', latitude: 30.31029, longitude: 120.39186, official: true },
  { id: 'pl-tD', name: 'D 教学楼', category: '教学楼', desc: '', latitude: 30.30957, longitude: 120.39406, official: true },
  { id: 'pl-tE', name: 'E 教学楼', category: '教学楼', desc: '', latitude: 30.31001, longitude: 120.39474, official: true },
  { id: 'pl-tF', name: 'F 教学楼', category: '教学楼', desc: '', latitude: 30.31034, longitude: 120.39564, official: true },
  { id: 'pl-xy', name: '行云苑食堂', category: '食堂', desc: '钱江湾生活区', latitude: 30.31193, longitude: 120.38791, official: true },
  { id: 'pl-ls', name: '流水苑食堂', category: '食堂', desc: '钱江湾生活区，三层，一楼有麦当劳', latitude: 30.31216, longitude: 120.39355, official: true },
  { id: 'pl-qf', name: '清风苑食堂', category: '食堂', desc: '金沙港生活区', latitude: 30.31191, longitude: 120.38126, official: true },
  { id: 'pl-gym', name: '体育中心', category: '运动', desc: '游泳馆 / 羽毛球馆 / 乒乓球馆 / 健身房都在这里', latitude: 30.30734, longitude: 120.38328, official: true },
  { id: 'pl-act', name: '学生活动中心', category: '其他', desc: '社团活动大多在这里', latitude: 30.30965, longitude: 120.38717, official: true },
  { id: 'pl-hosp', name: '校医院', category: '其他', desc: '钱江湾生活区 1 号综合楼，有急诊', latitude: 30.31173, longitude: 120.39224, official: true },
  { id: 'pl-qjw', name: '钱江湾生活区', category: '宿舍', desc: '生活区里有食堂和生活服务部', latitude: 30.31193, longitude: 120.39247, official: true },
  { id: 'pl-jsg', name: '金沙港生活区', category: '宿舍', desc: '离文海南路地铁站更近', latitude: 30.31274, longitude: 120.38043, official: true },
  { id: 'pl-south', name: '南大门（飞翔门）', category: '其他', desc: '访客与快递多走这个门', latitude: 30.30707, longitude: 120.38835, official: true },
  { id: 'pl-north', name: '北大门', category: '其他', desc: '', latitude: 30.31044, longitude: 120.38757, official: true },
  { id: 'pl-metro', name: '地铁 8 号线 · 工商大学云滨站', category: '其他', desc: 'A/C 口出站即达，1 号线可在文海南路换乘 8 号线', latitude: 30.31097, longitude: 120.39307, official: true }
];

// 库为空时把官方地点灌进去（和校历同款逻辑：只灌一次，之后不覆盖同学的手工修改）
async function seedPlaces() {
  for (const item of DEFAULT_PLACES) {
    // eslint-disable-next-line no-await-in-loop
    const hit = await db.collection(COL_PLACES).where({ id: item.id }).limit(1).get().catch(() => null);
    if (hit && hit.data && hit.data.length) continue;
    // eslint-disable-next-line no-await-in-loop
    await db.collection(COL_PLACES).add({
      data: Object.assign({}, item, { openid: '', at: Date.now(), source: 'official' })
    }).catch(() => {});
  }
}

// 地点关键词的云端兜底：和客户端 utils/place-search.js 同一套口径，
// 先包含、再走全站模糊内核（错字 / 少字 / 乱序）。
function placeCompact(s) {
  return String(s || '').toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[·,，。.!！?？:：;；\-—_/\\|（）()\[\]【】《》<>“”"']/g, '');
}
function placeKeywordMatch(p, word) {
  const w = placeCompact(word);
  if (!w) return true;
  const fields = [p && p.name, p && p.desc, p && p.address, p && p.category].map(placeCompact);
  if (fields.join(' ').indexOf(w) >= 0) return true;
  return searchCore.matchFields(fields, w) >= 0;
}

async function placeList(openid, payload) {
  payload = payload || {};
  const category = String(payload.category || '');
  const keyword = String(payload.keyword || '').trim().toLowerCase();
  let res = await db.collection(COL_PLACES).orderBy('at', 'desc').limit(100).get().catch(() => null);
  let list = (res && res.data) || [];
  // 第一次进来库是空的：把官方地点灌进去再返回，同学打开就有全校地图可用
  if (!list.length) {
    await seedPlaces();
    res = await db.collection(COL_PLACES).orderBy('at', 'desc').limit(100).get().catch(() => null);
    list = (res && res.data) || [];
  }
  if (category && category !== '全部') list = list.filter((p) => (p.category || '其他') === category);
  // 关键词兜底：前端本地列表没加载成功时，仍然能按关键词从云端找到地点。
  if (keyword) {
    const words = keyword.split(/\s+/).filter(Boolean);
    list = list.filter((p) => words.every((w) => placeKeywordMatch(p, w)));
  }
  return {
    ok: true,
    list: list.map((p) => Object.assign({}, p, {
      isMine: String(p.openid || p._openid || '') === openid
    }))
  };
}

async function placeAdd(openid, payload) {
  payload = payload || {};
  const p = payload.place || {};
  const name = String(p.name || '').trim().slice(0, 30);
  const address = String(p.address || '').slice(0, 60);
  const desc = String(p.desc || '').slice(0, 80);
  const lat = Number(p.latitude);
  const lng = Number(p.longitude);
  if (!name) return { ok: false, msg: '地点名字得写一下' };
  if (!isFinite(lat) || !isFinite(lng) || !lat || !lng) return { ok: false, msg: '请在地图上选一下位置' };
  const g = await guard(name, desc, address);
  if (!g.ok) return { ok: false, msg: g.msg };

  const doc = {
    id: String(p.id || ('pl' + Date.now() + Math.floor(Math.random() * 1000))),
    name: name,
    category: PLACE_CATS.indexOf(p.category) >= 0 ? p.category : '其他',
    desc: desc,
    address: address,
    latitude: lat,
    longitude: lng,
    openid: openid,
    at: Date.now()
  };
  await db.collection(COL_PLACES).add({ data: doc });
  return { ok: true, place: doc };
}

async function placeRemove(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const hit = await db.collection(COL_PLACES).where({ id: id }).limit(1).get().catch(() => ({ data: [] }));
  const rec = hit.data && hit.data[0];
  if (!rec) return { ok: true };
  const owner = String(rec.openid || rec._openid || '') === openid;
  if (!owner && !(await isModerator(openid))) return { ok: false, msg: '只能删除自己添加的地点' };
  await db.collection(COL_PLACES).where({ id: id }).remove().catch(() => {});
  return { ok: true };
}

/* ---------------- 校园活动 ---------------- */

// 活动是一条 events 文档，报名单独放 event_joins，一人一条。
// 为什么不把报名塞进 events 的 joined 数组：一个热门讲座几百号人，数组只增不减，
// 每次打开列表都要把整份名单读一遍，越用越慢；取消报名还得在数组里翻着删。
// 计数（joinedCount）留在活动文档上，报名 / 取消时加减，列表页一次查询就能带上人数。
const EVENT_TYPES = ['lecture', 'contest', 'team', 'other'];
// 列表页多给一点：同步来的官网活动按 at 倒序排在最前，一屏根本放不下。
// 上到 100（云函数端单次 get 的上限）是因为招聘会 / 宣讲会也挤在这同一个列表里：
// 它们按**举办日期**排（未来时间戳更大），一场秋招就能带进来几十条，
// 还留在 50 的话，压在尾巴上的旧公告会被直接截掉 —— 页面上就是
// 「库里明明有、列表里没有」，这种偏差最难查。前端只拉第一页，所以要一次性给够。
const EVENT_PAGE = 100;

// 报名记录的 id 必须是「我 + 活动」唯一键：既然唯一，重复点报名就查得到、不去加计数，
// 也就不会出现「刷新一次报名数涨一次」这种事。
function joinId(openid, eventId) {
  return openid + '__' + eventId;
}

function decorateEvent(e, me, joinedIds) {
  const openid = e.openid || e._openid || '';
  const cap = Number(e.capacity) || 0;
  const count = Number(e.joinedCount) || 0;
  const joined = !!(me && joinedIds && joinedIds.indexOf(String(e.id)) >= 0);
  const out = Object.assign({}, e, {
    openid: openid,
    isMine: !!me && openid === me,
    joined: joined,
    count: count,
    full: cap > 0 && count >= cap,
    canJoin: !joined && (cap === 0 || count < cap)
  });
  // 正文可能上万字，只给详情页按需接口返回；列表带上会把整页响应撑大。
  delete out.articleMd;
  delete out.articleAt;
  delete out.articleSourceUrl;
  return out;
}

async function eventAdd(openid, payload) {
  payload = payload || {};
  const it = payload.event || {};
  const title = String(it.title || '').trim();
  const desc = String(it.desc || '').trim();
  const location = String(it.location || '').trim();
  const author = String(it.author || '浙小商').slice(0, 20);
  if (!title) return { ok: false, msg: '给活动起个名字吧' };
  if (title.length > 40) return { ok: false, msg: '标题最多 40 个字' };
  if (desc.length > 500) return { ok: false, msg: '活动详情最多 500 个字' };
  // 屏蔽词 / 官方内容安全：标题、详情、地点都要过。
  // 联系方式不参与校验 —— 活动本来就要留联系方式，而「加微信」在我们的词表里，
  // 一起校验会把正常的讲座通知挡死（失物招领那边也是同样的处理）。
  const g = await guard(title, desc, location, author);
  if (!g.ok) return { ok: false, msg: g.msg };

  const doc = {
    id: String(it.id || ('ev' + Date.now() + Math.floor(Math.random() * 1000))),
    type: EVENT_TYPES.indexOf(it.type) >= 0 ? it.type : 'other',
    title: title,
    desc: desc,
    location: location.slice(0, 40),
    start: String(it.start || '').slice(0, 20),
    // 0 = 不限人数。真限制人数时要给出上限，别让同学报完名发现进不去
    capacity: Math.max(0, Math.min(500, Math.round(Number(it.capacity) || 0))),
    joinedCount: 0,
    contact: String(it.contact || '').slice(0, 40),
    contactType: it.contactType || 'wechat',
    author: author,
    authorOpenid: openid,
    openid: openid,
    time: now(),
    at: Date.now(),
    status: 'open'
  };
  // 写库成功/失败必须如实上报，跟 postAdd 一个道理：
  //  swallowed 成 ok:true 的话，前端弹「发布成功」，活动却压根没到云端。
  const w = await db.collection(COL_EVENTS).add({ data: doc }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[eventAdd] write failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '云端没存住', detail: (d.code + ' ' + d.msg).trim() };
  }
  return { ok: true, event: decorateEvent(doc, openid, []) };
}

async function eventList(openid, payload) {
  payload = payload || {};
  const page = Math.max(1, Number(payload.page) || 1);
  const res = await db.collection(COL_EVENTS)
    .orderBy('at', 'desc').skip((page - 1) * EVENT_PAGE).limit(EVENT_PAGE)
    .get().catch(() => null);
  const list = (res && res.data) || [];
  // 我报过名的活动：一次查我自己的报名记录就够，
  // 比给每条活动各查一次「有没有我」省得多（列表 30 条会直接把查询次数用光）
  const mine = await db.collection(COL_EVENT_JOINS)
    .where({ openid: openid }).limit(300).get().catch(() => ({ data: [] }));
  const joinedIds = ((mine && mine.data) || []).map((r) => String(r.eventId || ''));
  // 被举报下架 / 审核删除的活动从全校视野里消失。
  // 用内存过滤而不是 where：hidden 字段老数据没有，
  // where 条件会把「没这个字段」的旧记录一起筛掉
  const alive = list.filter((e) => e.hidden !== true && e.deleted !== true);
  return { ok: true, list: alive.map((e) => decorateEvent(e, openid, joinedIds)), page: page };
}

async function eventJoin(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const hit = await db.collection(COL_EVENTS).where({ id: id }).limit(1).get().catch(() => ({ data: [] }));
  const ev = hit.data && hit.data[0];
  if (!ev) return { ok: false, msg: '这个活动找不到了' };
  if (ev.status === 'closed') return { ok: false, msg: '这个活动已经结束了' };

  // 过了开赛时间就不再收报名。原来只在 status === 'closed' 时拦，
  // 而全仓库没有任何一处会把活动标成 closed（那段判断等于死的），
  // 结果就是宋日都过去的讲座同学照样能报。按日期拦更可靠 —— 时间写在明面上，不靠谁维护。
  const startAt = String(ev.start || '').trim();
  if (startAt && startAt < memoDateStr()) {
    return { ok: false, msg: '这个活动已经开始了，报不了名了' };
  }

  // 已经报过要先于「满员」判断返回：我自己就是填满名额的那个人，
  // 这时报「人数满了，下次早点来」同学只会一脸问号 —— 我明明报上了。
  const jid = joinId(openid, id);
  const dup = await db.collection(COL_EVENT_JOINS).where({ id: jid }).limit(1).get().catch(() => ({ data: [] }));
  if (dup.data && dup.data.length) return { ok: true, joined: true, already: true };

  const cap = Number(ev.capacity) || 0;
  // 原来拿「刚才读到的那份快照」判满员，两个同学同时报、只剩最后一个名额时
  // 两边都读到 cap-1，都判成没满，一起报进去 —— 热门讲座会超卖。
  // 现在名额判断下沉到下面那次 inc 的 where 里，由服务端原子判定：
  // 同一批请求里只有一个人能匹配到「人数还没满」，其余的 updated === 0
  const w = await db.collection(COL_EVENT_JOINS).add({
    data: { id: jid, eventId: id, openid: openid, author: String(ev.author || '').slice(0, 20), at: Date.now() }
  }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[eventJoin] write failed:', d.code, d.msg);
    // saved:false = 存储失败（不是违规），前端别把本地记录清掉
    return { ok: false, saved: false, msg: '报名没存住，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }

  // 报名记录先落地，再抢名额；没抢到就把这条记录撤掉，别留下一条没用的报名
  const uw = await db.collection(COL_EVENTS).where(
    cap > 0
      ? { id: id, joinedCount: db.command.lt(cap) }
      : { id: id }
  ).update({ data: { joinedCount: db.command.inc(1) } }).catch((e) => ({ err: e }));

  if (uw && uw.err) {
    const d = dbErr(uw.err);
    console.error('[eventJoin] count failed:', d.code, d.msg);
    await db.collection(COL_EVENT_JOINS).where({ id: jid }).remove().catch(() => {});
    return { ok: false, saved: false, msg: '报名没存住，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  if (cap > 0 && uw && uw.stats && Number(uw.stats.updated) === 0) {
    await db.collection(COL_EVENT_JOINS).where({ id: jid }).remove().catch(() => {});
    return { ok: false, msg: '人数满了，下次早点来' };
  }
  return { ok: true, joined: true };
}

async function eventCancel(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const jid = joinId(openid, id);
  const w = await db.collection(COL_EVENT_JOINS).where({ id: jid }).remove().catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[eventCancel] remove failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '取消失败，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  // 记录其实不存在时（重复点取消、名单丢过一次）remove 不报错、只回 removed:0。
  // 照旧减计数会让人数变成 -1，之后「满员」判断全是错的，还会让人以为自己真报上了
  const removed = w && w.stats ? Number(w.stats.removed) : NaN;
  if (!(removed > 0)) {
    return { ok: true, joined: false, already: true, msg: '这条报名记录已经不在了，不用取消' };
  }
  // 减计数也要如实：加减不对称的话，人数会越点越离谱
  const dw = await db.collection(COL_EVENTS).where({ id: id }).update({
    data: { joinedCount: db.command.inc(-1) }
  }).catch((e) => ({ err: e }));
  if (dw && dw.err) {
    const d = dbErr(dw.err);
    console.error('[eventCancel] dec failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '人数没改过来，再试一次', detail: (d.code + ' ' + d.msg).trim() };
  }
  return { ok: true, joined: false };
}

async function eventRemove(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const hit = await db.collection(COL_EVENTS).where({ id: id }).limit(1).get().catch(() => ({ data: [] }));
  const rec = hit.data && hit.data[0];
  if (!rec) return { ok: true };
  const owner = String(rec.openid || rec._openid || '') === openid;
  if (!owner && !(await isModerator(openid))) return { ok: false, msg: '只能删除自己发布的活动' };
  // 报名记录先陪葬：活动都没了，报名的人留着一条记录只会看到「活动已失效」
  await db.collection(COL_EVENT_JOINS).where({ eventId: id }).remove().catch(() => {});
  await db.collection(COL_EVENTS).where({ id: id }).remove().catch(() => {});
  return { ok: true };
}

/* ---------------- 官网数据同步 ---------------- */
//
// 为什么放在云函数里同步，而不是前端直接抓：
//   前端调 https 抓校内网站会被跨域挡住，还得配域名白名单；
//   云函数在服务端出网，没有任何限制，还能被定时触发器定时叫醒。
//
// 抓下来的东西只做两件事：
//   ① 公告条目 → 官方活动（标 official:true，带 sourceUrl，点标题能跳回官网原文）
//   ② 学院师资页 → 教师名录，同学写评价选老师时用它自动补全
// 同步是幂等的：按 sourceUrl / 姓名去重，官网改了就更新，重复跑不会产生重复数据。
//
// 频率：config.json 里挂了定时触发器（每天一次）。抓失败不写日志噪声，
// 返回明确的 ok:false，前端「更新」按钮能把原因说出来。
const WEB_SOURCES = [
  { key: 'youth', site: '校团委', url: 'https://youth.zjgsu.edu.cn/main.htm' },
  { key: 'tgb', site: '体育工作部', url: 'https://tgb.zjgsu.edu.cn/List-54.html' },
  { key: 'xsc', site: '学生处', url: 'https://xsc.zjgsu.edu.cn/1826/list.htm' },
  { key: 'news', site: '学校主页', url: 'https://www.zjgsu.edu.cn/' }
  // 就业指导中心原本在这里（job.zjgsu.edu.cn/list-27-1.html），现在**不放了**：
  // 那个域名已经整体下线（连接直接失败），而就业信息全部迁到了新平台
  // jyw.zjgsu.edu.cn。新平台是前端 ajax 渲染的，静态 HTML 里没有数据，
  // 走不通这条「抓页面里的链接」的通用通道，所以单独给它写了一条（见 JOBFAIR_* 一节）。
];

// 各学院官网的师资页。学校没有统一的教师库，只能一处一处抓；
// 页面改版抓不到时静默跳过，同学仍可用 teacherAdd 自己补。
const TEACHER_SOURCES = [
  { key: 'scie', site: '计算机科学与技术学院', url: 'https://scie.zjgsu.edu.cn/index.php/zh-hans/%E5%85%A8%E4%BD%93%E6%95%99%E5%B8%88', from: '一、专任教师' },
  { key: 'spxy', site: '食品与生物工程学院', url: 'https://spxy.zjgsu.edu.cn/?zrjs=', from: '博士生导师（硕士生导师）' },
  { key: 'sme', site: '管理工程与电子商务学院', url: 'https://sme.zjgsu.edu.cn/276/list.htm', from: '专任教师' }
];

const WEB_TIMEOUT = 8000;

// 云函数出网抓页面。跟着跳转走，学校站不少栏目是 301 到 https 的。
function webGet(rawUrl, depth) {
  const d = depth || 0;
  return new Promise((resolve) => {
    if (d > 4) return resolve('');
    const mod = String(rawUrl).indexOf('https') === 0 ? require('https') : require('http');
    let req;
    try {
      req = mod.get(rawUrl, { timeout: WEB_TIMEOUT, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        const loc = res.headers['location'];
        if (res.statusCode >= 300 && loc && res.statusCode < 400) {
          res.resume();
          let next = loc;
          try { next = new URL(loc, rawUrl).href; } catch (e) {}
          return resolve(webGet(next, d + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(''); }
        let buf = '';
        res.on('data', (c) => { buf += c; if (buf.length > 1500000) res.destroy(); });
        res.on('end', () => resolve(buf));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(''); });
    } catch (e) {
      resolve('');
    }
  });
}

// 出网 POST 表单并解析 JSON。
// 为什么需要它：就业网新平台是前端 ajax 渲染的 —— 静态 HTML 里一条数据都没有，
// 页面上的列表全是 loadPage() 回头打接口换来的。webGet 抓那个页面只会拿到空壳子，
// 所以只能按它自己的方式打到接口上，直接把 JSON 要回来。
// 解析失败一律回 null（跟 webGet 回空串一个意思）：调用方按「这个源没抓到」处理，
// 不抛错、不写日志噪声 —— 官网改版是常态，一次抓不到不该让整个同步流程失败。
function webPostJson(rawUrl, form) {
  return new Promise((resolve) => {
    let body = '';
    try {
      body = Object.keys(form || {})
        .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(form[k]))
        .join('&');
    } catch (e) {
      return resolve(null);
    }
    const mod = String(rawUrl).indexOf('https') === 0 ? require('https') : require('http');
    let req;
    try {
      req = mod.request(rawUrl, {
        method: 'POST',
        timeout: WEB_TIMEOUT,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          // 服务端偶尔按这个头决定「回 JSON 还是回整页 HTML」，少它可能拿到一整个页面
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let buf = '';
        // 显式按 utf8 解码：学校站的 JSON 是 UTF-8，但 Node 不设编码时按 Buffer 拼，
        // 中文标题会变成一串乱码存进库
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; if (buf.length > 1000000) res.destroy(); });
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
      req.write(body);
      req.end();
    } catch (e) {
      resolve(null);
    }
  });
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&amp;/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ');
}

function toAbs(href, base) {
  try { return new URL(href, base).href; } catch (e) { return ''; }
}

function decodeHtmlEntities(text) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code.charAt(0) === '#') {
      const n = code.charAt(1).toLowerCase() === 'x'
        ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCharCode(n) : '';
    }
    return map[code.toLowerCase()] || '';
  });
}

function stripHtmlTags(text) {
  return decodeHtmlEntities(String(text || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

// 从某个开始标签往后按同名标签配平，避免非贪婪正则遇到嵌套 div 时只截到第一层。
function sliceBalancedElement(html, start, tag) {
  const openRe = new RegExp('<' + tag + '\\b', 'ig');
  const closeRe = new RegExp('</' + tag + '\\s*>', 'ig');
  let depth = 0;
  let pos = start;
  while (pos < html.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const open = openRe.exec(html);
    const close = closeRe.exec(html);
    if (!close) return '';
    if (open && open.index < close.index) {
      depth += 1;
      pos = open.index + open[0].length;
    } else {
      depth -= 1;
      pos = close.index + close[0].length;
      if (depth === 0) return html.slice(start, pos);
    }
  }
  return '';
}

// 没有命中已知 CMS 容器时，从页面里找“文字最多、链接不占主导”的块。
// 这是兜底，不是万能解析：找不到就返回空，让前端回退复制原文链接。
function fallbackArticleHtml(html) {
  const src = String(html || '').replace(/<(script|style|noscript|iframe|svg|canvas|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  const re = /<(div|article|section|td|dd)\b[^>]*(?:class|id)=["'][^"']+["'][^>]*>/gi;
  let best = '';
  let bestScore = 0;
  let seen = 0;
  let m;
  while ((m = re.exec(src)) && seen < 300) {
    seen += 1;
    const attrs = m[0];
    if (/(nav|menu|header|footer|sidebar|related|recommend|share|breadcrumb|comment|login|search|banner|\blist\b|\bmain\b)/i.test(attrs)) continue;
    const tag = m[1].toLowerCase();
    const block = sliceBalancedElement(src, m.index, tag);
    if (!block || block.length > 250000) continue;
    const text = stripHtmlTags(block);
    if (text.length < 80) continue;
    const links = (block.match(/<a\b/gi) || []).length;
    const score = text.length - links * 40;
    if (score > bestScore) { bestScore = score; best = block; }
  }
  return best;
}

function pickArticleHtml(html) {
  const src = String(html || '');
  const patterns = [
    /<dd\b[^>]*\bid=["']the_content["'][^>]*>/i,
    /<div\b[^>]*\bclass=["'][^"']*wp_articlecontent[^"']*["'][^>]*>/i,
    /<div\b[^>]*\bid=["']vsb_content["'][^>]*>/i,
    /<div\b[^>]*\bclass=["'][^"']*(?:v_news_content|entry-content|post-content|article-body|art-content|news-detail|detail-content|TRS_Editor|pages_content|article-content|news_content|article_content)["'][^>]*>/i,
    /<(?:div|dd)\b[^>]*\bid=["'](?:content|zoom|article|main-content)["'][^>]*>/i,
    /<div\b[^>]*\bclass=["'][^"']*\barticle\b[^"']*["'][^>]*>/i,
    /<article\b[^>]*>/i
  ];
  for (const re of patterns) {
    const m = re.exec(src);
    if (!m) continue;
    const tag = (m[0].match(/^<([a-z0-9]+)/i) || [])[1];
    if (!tag) continue;
    const body = sliceBalancedElement(src, m.index, tag.toLowerCase());
    if (body) return body;
  }
  return fallbackArticleHtml(src);
}

function officialArticleUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const host = u.hostname.toLowerCase();
    if (host !== 'zjgsu.edu.cn' && !host.endsWith('.zjgsu.edu.cn')) return '';
    // 学校站点多数支持 HTTPS；统一升级，失败时 webGet 会跟随它自己的跳转。
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.href;
  } catch (e) {
    return '';
  }
}

function secureSchoolUrl(u) {
  const s = String(u || '');
  return /^http:\/\/[^/]*zjgsu\.edu\.cn/i.test(s) ? s.replace(/^http:/i, 'https:') : s;
}

function htmlToMarkdown(html, baseUrl) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|iframe|svg|canvas|form|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
    const alt = (tag.match(/\balt=["']([^"']*)["']/i) || [])[1] || '图片';
    const abs = src ? secureSchoolUrl(toAbs(src, baseUrl)) : '';
    return abs ? '\n\n![' + alt.replace(/[\[\]]/g, '') + '](' + abs + ')\n\n' : '';
  });
  s = s.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
    const label = stripHtmlTags(text);
    const abs = secureSchoolUrl(toAbs(href, baseUrl));
    if (!label || !/^https?:\/\//i.test(abs)) return label;
    return '[' + label + '](' + abs + ')';
  });
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, n, text) => {
    return '\n\n' + '#'.repeat(Number(n)) + ' ' + stripHtmlTags(text) + '\n\n';
  });
  s = s.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n').replace(/<p\b[^>]*>/gi, '')
    .replace(/<\/div>/gi, '\n').replace(/<div\b[^>]*>/gi, '')
    .replace(/<\/li>/gi, '\n').replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/tr>/gi, '\n').replace(/<tr\b[^>]*>/gi, '')
    .replace(/<\/td>/gi, ' | ').replace(/<td\b[^>]*>/gi, '')
    .replace(/<strong\b[^>]*>|<\/strong>|<b\b[^>]*>|<\/b>/gi, '**')
    .replace(/<em\b[^>]*>|<\/em>|<i\b[^>]*>|<\/i>/gi, '*')
    .replace(/<[^>]+>/g, ' ');
  s = decodeHtmlEntities(s)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.slice(0, 20000);
}

function extractOfficialArticle(html, url) {
  const picked = pickArticleHtml(html);
  // 找不到正文容器时宁可让前端回退复制链接，也不要把整页导航/页脚当正文展示。
  const markdown = picked ? htmlToMarkdown(picked, url) : '';
  return { markdown: markdown, picked: !!picked };
}

async function eventArticle(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const ev = await fetchTarget('event', id);
  if (!ev) return { ok: false, msg: '活动不存在' };
  if (!ev.official || !ev.sourceUrl) return { ok: false, msg: '这条不是官网活动' };
  const url = officialArticleUrl(ev.sourceUrl);
  if (!url) return { ok: false, msg: '官网链接不在白名单内' };
  const cached = String(ev.articleMd || '');
  if (cached && Date.now() - (Number(ev.articleAt) || 0) < 24 * 3600 * 1000) {
    return { ok: true, markdown: cached, cached: true };
  }
  const html = await webGet(url, 0);
  if (!html) return { ok: false, msg: '官网正文读取失败，可复制原文链接' };
  const article = extractOfficialArticle(html, url);
  if (!article.markdown || article.markdown.length < 30) {
    return {
      ok: false,
      msg: ev.type === 'jobfair'
        ? '招聘会详情请查看上方时间地点，或复制原文链接'
        : '官网正文提取失败，可复制原文链接'
    };
  }
  await db.collection(COL_EVENTS).where({ id: id }).update({
    data: {
      articleMd: article.markdown,
      articleAt: Date.now(),
      articleSourceUrl: url
    }
  }).catch(() => {});
  return { ok: true, markdown: article.markdown, cached: false };
}
function pickDate(text) {
  const m = String(text || '').match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return '';
  // 补零必须用 slice，'0' + '09' 会得到 '009'，日期就成了 2026-009-11
  const p = (n) => ('0' + String(n)).slice(-2);
  return m[1] + '-' + p(m[2]) + '-' + p(m[3]);
}

// 公告列表页的解析器。几个站的写法都不一样，但共同点是「一个链接 + 一个日期」，
// 所以这里按「链接 → 找同一段里的日期」来做，比给每个站各写一套稳。
const BAD_TITLE = ['更多', '首页', '导航', 'English', '上一页', '下一页', '登录', '下载', '网站声明', '版权'];

function parseAnnounce(html, base) {
  const out = [];
  const seen = {};
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,240}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const title = htmlToText(m[2]).trim();
    if (title.length < 6 || title.length > 60) continue;
    if (BAD_TITLE.some((b) => title.indexOf(b) >= 0)) continue;
    if (/^javascript:/i.test(m[1])) continue;
    const url = toAbs(m[1], base);
    if (!url) continue;
    const win = html.slice(Math.max(0, m.index - 260), m.index + 300);
    let day = pickDate(win);
    // 有些站把日期写在标题括号里
    const tail = title.match(/[（(](20\d{2}[-/.]\d{1,2}[-/.]\d{1,2})[)）]\s*$/);
    if (!day && tail) day = tail[1];
    if (!day) day = pickDate(title);
    if (!day || seen[url]) continue;
    seen[url] = 1;
    out.push({
      title: title
        .replace(/[（(]20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}[)）]\s*$/, '')
        .trim()
        .slice(0, 40),
      url: url,
      date: day
    });
  }
  return out;
}

// 粗略判断活动类型：同学看到的是「招聘会 / 讲座 / 比赛 / 组队 / 其他」，
// 自动归类只是为了列表里图标好看一点，猜错了同学也能改。
function guessEventType(title) {
  const t = String(title || '');
  // 招聘会单独成类：就业中心的宣讲会 / 双选会 / 校招是「找工作」的事，
  // 和听讲座的心态完全不同，同学要在「招聘会」分类下一眼找齐这些消息
  if (/招聘会|双选会|宣讲会|校招|招聘|就业/.test(t)) return 'jobfair';
  if (/讲座|报告|论坛|宣讲|交流|校友|开学典礼|毕业典礼|仪式/.test(t)) return 'lecture';
  if (/运动|体育|篮球|足球|排球|田径|马拉松|越野|跑步|联赛|锦标赛|运动会|八段锦|游泳|羽毛球|乒乓/.test(t)) return 'contest';
  if (/比赛|竞赛|大赛|选拔|评选|征文|辩论/.test(t)) return 'contest';
  if (/社团|百团|音乐节|文化节|艺术|晚会|演出|展览|招新/.test(t)) return 'other';
  return 'other';
}

async function syncOfficialEvents() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // 只采集最近 7 天的官网消息：校园通知是「看一眼就知道现在要干什么」的东西，
  // 两个月前的值班安排挂在列表里只会把新消息顶下去（此前 120 天窗口攒了几十条旧通知）。
  // 7 天前的老条目已在库里的不再删除 —— 展示端（campus 页）会按同一窗口过滤。
  const minTs = today.getTime() - 7 * 86400000;
  const maxTs = today.getTime() + 90 * 86400000;
  let added = 0, updated = 0, skipped = 0;

  const pages = await Promise.all(WEB_SOURCES.map((s) => webGet(s.url).then((body) => ({ src: s, body: body }))));
  for (const p of pages) {
    if (!p.body) { skipped += 1; continue; }
    const items = parseAnnounce(p.body, p.src.url);
    for (const it of items) {
      const ts = new Date(String(it.date).replace(/-/g, '/') + ' 00:00:00').getTime();
      if (!ts || ts < minTs || ts > maxTs) continue;
      const exist = await db.collection(COL_EVENTS)
        .where({ sourceUrl: it.url }).limit(1).get().catch(() => ({ data: [] }));
      const rec = exist.data && exist.data[0];
      const data = {
        title: it.title,
        date: it.date,
        type: guessEventType(it.title),
        official: true,
        source: p.src.site,
        sourceUrl: it.url,
        at: ts,
        syncedAt: Date.now()
      };
      if (rec) {
        // 只覆盖这些字段：同学报名、作者等都是这个活动自己的，别被同步冲掉
        await db.collection(COL_EVENTS).where({ id: rec.id }).update({ data: data }).catch(() => {});
        updated += 1;
      } else {
        await db.collection(COL_EVENTS).add({
          data: Object.assign({}, data, {
            id: 'web' + String(it.url).replace(/[^a-zA-Z0-9]/g, '').slice(-24) + Date.now(),
            desc: '',
            location: '',
            start: it.date,
            capacity: 0,
            joinedCount: 0,
            contact: '',
            author: p.src.site,
            authorOpenid: '',
            openid: '',
            time: now(),
            status: 'open'
          })
        }).catch(() => {});
        added += 1;
      }
    }
  }
  // 招聘会 / 宣讲会走另一条通道（见 JYW_* 一节），结果在这里并进来
  const job = await syncJywAll();

  // 四个栏目全抓不到才叫失败：那多半是官网挂了 / 出网被墙 / 云函数版本太老。
  // 只挂一两个站点不算失败 —— 同学照旧能拿到另外那几个栏目的活动。
  const alive = WEB_SOURCES.length - skipped;
  const out = {
    ok: alive > 0 || job.ok,
    added: added + job.added,
    updated: updated + job.updated,
    skipped: skipped,
    alive: alive,
    total: WEB_SOURCES.length,
    // 招聘会单独报一份，而且报到**每条通道**：
    // 「公告抓到了、宣讲会挂了」和「两边都挂了」是完全不同的两件事，
    // 只报一个总数的话，页面上只看得出「招聘会 0 条」，还得反过来猜是代码问题、
    // 部署问题还是官网问题 —— 这个猜的过程已经浪费过一轮了。
    jobfair: {
      ok: job.ok,
      added: job.added,
      updated: job.updated,
      kept: job.kept,
      channels: job.channels.map((c) => ({
        key: c.key, label: c.label, ok: c.ok,
        added: c.added, updated: c.updated, kept: c.kept, scanned: c.scanned
      }))
    },
    // 同步回执里带一份版本指纹：前端拿它就能分辨「云端跑的是旧版云函数」，
    // 而不是让同学对着一个空列表猜。BUILD 每次改云函数行为都往后加一位。
    build: BUILD
  };
  if (!out.ok) out.msg = '学校官网暂时打不开，稍后再试。已配置每天自动同步，明天再看。';
  return out;
}

/* ---------------- 招聘会 / 宣讲会（就业网新平台）----------------
 *
 * 为什么单写一条通道，不塞进上面的 WEB_SOURCES：
 *   ① 旧域名 job.zjgsu.edu.cn 已整体下线（连接直接失败）。代码一直是好的，
 *      是「源没了」—— 这就是「招聘会」分类长期空着的真正原因。
 *   ② 新平台 jyw.zjgsu.edu.cn 的列表是前端 ajax 画的：静态 HTML 里一条数据都没有，
 *      而上面那条通用通道只认「页面里的 <a> 链接 + 日期」，抓到的只是个空壳。
 *      所以只能按它自己的方式打到接口上，直接把 JSON 要回来。
 *
 * 为什么是**两条**通道，而不是一条：
 *   第一版只接了 zphxx（招聘会 / 双选会），结果页面上还是空的 —— 那个栏目
 *   全站 167 条里落在窗口内的只有 3 条（一学期就那几场大场子）。
 *   「分类有、列表空」于是又踩了第二次。真正撑住这个分类的是 xjhxx（宣讲会）：
 *   企业进校开的专场，一场一间教室、一天能有好几场，实测 30 条全在未来两个月内。
 *   这两批消息本来就是同一个来源 —— 就业指导中心公众号每天推的也是这些。
 *
 * 接口（2026-10 实测）：
 *   招聘会 POST https://jyw.zjgsu.edu.cn/career/zphxx/search/{页码}/{每页}
 *          zphlb=allzph（全部类别）
 *          回执 { code:200, data:{ total, list:[{ zphid, zphzt, zphlbmc, zphlb,
 *                jbkssj, jbjssj, bmkssj, bmjzsj, jbdd, bmdws, djs, djrq }] } }
 *   宣讲会 POST https://jyw.zjgsu.edu.cn/career/xjhxx/search/all/{页码}/{每页}
 *          回执 { code:200, data:{ total, list:[{ xjhid, xjhzt, dwmc, jbrq, jbsjdmc,
 *                jbxqmc, cdmc, cddz, rsgmmc, hyyjmc, szsmc, zws, shzt, djs }] } }
 *
 * 时间口径跟公告**故意不一样**：
 *   公告是「今天发、今天看」，所以按发布日卡最近 7 天；
 *   招聘会是「提前一两个月公布、到那天才办」—— 也按发布日卡窗口的话，
 *   12 月的秋招在 10 月中旬就会从列表里消失，而那恰恰是最该看到它的时候。
 *   所以这里按**举办日期**卡窗口（往前留几天见各通道的 daysBack，往后放 180 天）。
 */
const JYW_BASE = 'https://jyw.zjgsu.edu.cn/career';
const JYW_SITE = '就业指导中心';
// 全量也就一百多条，一页拿完 —— 少几轮请求，也省得逐页去猜它的翻页参数
const JYW_PAGE_SIZE = 200;
// 往后放半年：半年内公布过的都收。往前的天数每条通道不一样，写在通道表里
const JYW_DAYS_AHEAD = 180;

// 详情页地址（招聘会）。照官网 jump() 的分支来：zphlb=40（空中 / 线上）走 kz/view；
// 且当 jbdd 本身就是个网址时，它直接开那个网址（第三方空中双选会平台）。
// 猜错这一段，同学点「原文」就是 404，所以按它的逻辑原样搬过来。
function jobfairDetailUrl(zphid, zphlb, jbdd) {
  const id = String(zphid || '').trim();
  if (!id) return '';
  const isAir = String(zphlb || '') === '40';
  const ext = String(jbdd || '').trim();
  if (isAir && /^https?:\/\//i.test(ext)) return ext;
  return JYW_BASE + '/zphxx/' + (isAir ? 'kz/view/' : 'view/') + id;
}

// 'YYYY-MM-DD HH:mm' → 时间戳。解析不出来回 0（调用方按「这条时间不合法」跳过）
function tsOf(str) {
  const s = String(str || '').trim();
  if (!s) return 0;
  const t = new Date(s.replace(/-/g, '/')).getTime();
  return isNaN(t) ? 0 : t;
}

// 校园里的教室写法五花八门（「C117」「师生之家就业宣讲厅」「管理210」），
// 有些还挂着「教室需借用成功后才能确定具体位置」这种占位说明 ——
// 那行字当地点显示只会让人以为地点叫这个名字，所以占位的一律丢掉只留校区。
function jywRoom(cdmc) {
  const r = String(cdmc || '').trim();
  if (!r || /借用|待定|另定|未定|详见/.test(r)) return '';
  return r;
}

// 两条通道的差异全集中在这张表里：取数地址、字段映射、往前留几天。
// 之所以不写成两个函数：除了「字段叫什么名字」，取数 → 卡窗口 → 判重 → 落库
// 这四步是一模一样的。抄两遍的话，以后改判重口径（比如改成按标题 + 日期去重）
// 必然只改一处，另一处就成了只有春招时才暴露的暗坑。
const JYW_CHANNELS = [
  {
    key: 'zph',
    label: '双选会',
    url: JYW_BASE + '/zphxx/search',
    form: { zphlb: 'allzph' },
    // 大场子一学期就那么几场，「刚办完的那场」还值得回看一眼结果
    daysBack: 7,
    pick(it) {
      const sid = String(it.zphid || '').trim();
      // desc 只写**确定**的信息。规模（bmdws）在报名期开始前就是预设值，
      // 写成「已报名 200 家单位」会误导；报名截止是官网明写的，可以放。
      const lb = String(it.zphlbmc || '').trim() || '招聘会';
      const bmEnd = String(it.bmjzsj || '').trim().slice(0, 10);
      return {
        sid: sid,
        title: String(it.zphzt || '').trim(),
        // 卡片标签直接用官网自己的分类名（大型招聘会 / 中型招聘会 / 空中招聘会）
        kind: lb,
        startStr: String(it.jbkssj || '').trim(),
        endStr: String(it.jbjssj || '').trim(),
        venue: String(it.jbdd || '').trim(),
        desc: lb + (bmEnd ? ' · 单位报名截止 ' + bmEnd : ''),
        url: jobfairDetailUrl(sid, it.zphlb, it.jbdd)
      };
    }
  },
  {
    key: 'xjh',
    label: '宣讲会',
    url: JYW_BASE + '/xjhxx/search/all',
    form: {},
    // 宣讲会是一天好几场的日常事，往前留一天就够 —— 前天的场次对
    // 「接下来去哪听」已经没有任何用，留着只会把今天明天的挤下去
    daysBack: 1,
    pick(it) {
      const sid = String(it.xjhid || '').trim();
      const rq = String(it.jbrq || '').trim();
      // 时间只有「18:00-20:00」这种时段串，拆成开始 / 结束两半
      const seg = String(it.jbsjdmc || '').trim().split('-');
      const venue = [String(it.jbxqmc || '').trim(), jywRoom(it.cdmc)].filter(Boolean).join(' ');
      const dw = String(it.dwmc || '').trim();
      return {
        sid: sid,
        title: String(it.xjhzt || '').trim() || (dw ? dw + '宣讲会' : ''),
        kind: '宣讲会',
        startStr: (rq + ' ' + String(seg[0] || '').trim()).trim(),
        endStr: (rq + ' ' + String(seg[1] || '').trim()).trim(),
        venue: venue || String(it.cddz || '').trim().slice(0, 60),
        // 单位名 + 行业 + 规模，都是官网挂在列表上的硬字段，不猜
        desc: [dw, String(it.hyyjmc || '').trim(), String(it.rsgmmc || '').trim()]
          .filter(Boolean).join(' · ').slice(0, 60),
        url: sid ? (JYW_BASE + '/xjhxx/view/' + sid) : ''
      };
    }
  }
];

// 跑一条通道：打到接口 → 卡举办日期窗口 → 按 sourceUrl 判重 → 落库
async function syncJywChannel(ch) {
  const raw = await webPostJson(ch.url + '/1/' + JYW_PAGE_SIZE, ch.form || {});
  const list = (raw && raw.data && Array.isArray(raw.data.list)) ? raw.data.list : null;
  // 抓不到就如实说抓不到。不抛错：官网改版是常态，它挂了不该连累另一条通道
  if (!list) return { key: ch.key, label: ch.label, ok: false, added: 0, updated: 0, kept: 0, scanned: 0 };

  const day = new Date(); day.setHours(0, 0, 0, 0);
  const minTs = day.getTime() - ch.daysBack * 86400000;
  const maxTs = day.getTime() + JYW_DAYS_AHEAD * 86400000;
  let added = 0, updated = 0, kept = 0;

  for (const rawIt of list) {
    // list 里绝大多数是当年往后的历史存档（招聘会 167 条里只有 3 条在窗口内）。
    // 全收进来会把 events 集合灌满好几年份的旧场次，列表也就废了 —— 所以严格卡窗口
    const it = ch.pick(rawIt || {}) || {};
    const jobTs = tsOf(it.startStr);
    if (!jobTs || jobTs < minTs || jobTs > maxTs) continue;
    if (!it.sid || !it.title || !it.url) continue;
    kept += 1;

    const data = {
      title: it.title.slice(0, 40),
      date: it.startStr.slice(0, 10),
      desc: it.desc,
      location: it.venue.slice(0, 60),
      start: it.startStr.slice(0, 20),
      type: 'jobfair',
      // 卡片标签要区分「宣讲会」和「双选会」：一个是一间教室的小场、
      // 一个是一操场的招聘集市，同学安排行程时看的就是这个差别
      jobKind: it.kind.slice(0, 12),
      official: true,
      source: JYW_SITE,
      sourceUrl: it.url,
      // at 放的是**举办日期**，不是发布日。这里跟公告源是故意不一样的：
      //   ① eventList 按 at 倒序取第一页，而前端只拉第一页。放发布日的话，
      //      一场 12 月才办的秋招，会在 11 月被中间陆续发布的公告挤出首页 ——
      //      它明明还没办，同学却已经找不到它了。
      //   ② 放举办日期，它天然排在公告前面（未来时间戳更大），而「下个月要办的那场」
      //      本来就该比「昨天发的通知」更靠前。办完之后这个值变成过去时间，
      //      它会自然而然地沉下去，不需要额外写清理逻辑。
      // jobTs / jobEndTs 仍然单独存一份：展示端判断「还没办 / 已办完」时用它们，
      // 不去猜 at 到底是什么口径。结束时间也要单独存，因为双选会一开就是一下午 ——
      // 只拿开始时间比的话，下午两点刚开始就会被标成「已结束」。
      at: jobTs,
      jobTs: jobTs,
      jobEndTs: tsOf(it.endStr) || jobTs,
      syncedAt: Date.now()
    };

    const exist = await db.collection(COL_EVENTS)
      .where({ sourceUrl: it.url }).limit(1).get().catch(() => ({ data: [] }));
    const rec = exist.data && exist.data[0];
    if (rec) {
      // 可变字段（含地点、时间、desc）都在 data 里，会一起覆盖 ——
      // 官网改举办地点是常事，只更新标题的话同学会照着旧地点跑一趟
      await db.collection(COL_EVENTS).where({ id: rec.id }).update({ data: data }).catch(() => {});
      updated += 1;
    } else {
      await db.collection(COL_EVENTS).add({
        data: Object.assign({}, data, {
          id: 'job' + ch.key + it.sid + '-' + Date.now(),
          capacity: 0,
          joinedCount: 0,
          contact: '',
          author: JYW_SITE,
          authorOpenid: '',
          openid: '',
          time: now(),
          status: 'open'
        })
      }).catch(() => {});
      added += 1;
    }
  }
  return { key: ch.key, label: ch.label, ok: true, added: added, updated: updated, kept: kept, scanned: list.length };
}

// 两条通道一起跑。它们互不依赖，并发出去，省一半等待
// （云函数有默认超时，串行跑两个 8 秒级的出网请求容易卡在边界上）。
async function syncJywAll() {
  const channels = await Promise.all(JYW_CHANNELS.map((ch) => syncJywChannel(ch)));
  const out = { ok: false, added: 0, updated: 0, kept: 0, scanned: 0, channels: channels };
  channels.forEach((c) => {
    out.added += c.added;
    out.updated += c.updated;
    out.kept += c.kept;
    out.scanned += c.scanned;
    if (c.ok) out.ok = true;
  });
  return out;
}

// 谁都能触发一次（小程序里就是那个「更新」按钮）。
// 同步是只读 + 幂等的：只按 sourceUrl 增删官网条目，不动同学发布 / 报名的任何数据。
async function takeSyncSlot(key, ms) {
  const docId = 'sync_' + key;
  const nowMs = Date.now();
  const got = await db.collection(COL_CONFIG).doc(docId).get().catch(() => null);
  const last = Number(got && got.data && got.data.at) || 0;
  if (last && nowMs - last < ms) return false;
  await db.collection(COL_CONFIG).doc(docId).set({ data: { at: nowMs } }).catch(() => {});
  return true;
}

async function eventSyncFromWeb(openid, payload) {
  if (!(await takeSyncSlot('events', 5 * 60 * 1000))) {
    return { ok: false, msg: '官网刚同步过，请稍后再试' };
  }
  return syncOfficialEvents();
}

/* ================= 校园盲盒 / 漂流瓶 =================
 *
 * 规则（全部在服务端执行，前端只是展示）：
 *   - 扔：匿名，选「吐槽 / 分享 / 提问」其中一类，写一段话。每天最多扔 5 条防刷屏；
 *   - 捞：每天限 3 次（按 openid + 日期计数，改手机 / 重装都躲不开）；
 *   - 捞到的瓶子随机来自别的同学，30 天内的才可能被捞到（更老的算「沉海了」）；
 *   - 捞到时只能看到类型和内容 —— 院系这些「是谁」的信息全都锁着；
 *   - 回复之后解锁：回复的人能看到瓶子作者的院系，作者也能看到回复人的院系。
 *     「回复才解锁」是这个功能的规矩：想让别人愿意捞、愿意回，就得让认真回复的人先交出一点自己。
 *
 * 作者院系从 users 集合实时读：资料改了就跟着新，不存瓶子快照。
 */
const BOTTLE_KINDS = ['吐槽', '分享', '提问'];
const BOTTLE_LIFE_MS = 30 * 86400000;    // 瓶子 30 天后沉底，不再被捞到
const BOTTLE_DAILY_FETCH = 3;            // 每人每天限捞次数
const BOTTLE_DAILY_THROW = 5;            // 每人每天限扔条数（防刷屏，不写进 UI 也生效）

function bottleDayKey() {
  const d = new Date();
  const p = (n) => ('0' + String(n)).slice(-2);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 某人的院系（users 集合实时读，没填就「未填写」）
async function bottleCollegeOf(openid) {
  if (!openid) return '';
  const r = await db.collection(COL_USERS).where({ openid: openid }).limit(1).get()
    .catch(() => ({ data: [] }));
  const u = r.data && r.data[0];
  return String((u && u.college) || '').trim();
}

// 扔瓶子：bottleThrow { kind, content }
async function bottleThrow(openid, payload) {
  payload = payload || {};
  const kind = BOTTLE_KINDS.indexOf(String(payload.kind || '')) >= 0 ? payload.kind : '吐槽';
  const content = String(payload.content || '').trim().slice(0, 500);
  if (!content) return { ok: false, msg: '写点什么再扔吧' };
  const g = await guard(content);
  if (!g.ok) return { ok: false, msg: g.msg };

  // 每日限扔：以天为窗口数这个人扔的条数
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const mine = await db.collection(COL_BOTTLES).where({
    openid: openid,
    thrownAt: db.command.gte(dayStart.getTime())
  }).count().catch(() => ({ total: 0 }));
  if ((mine.total || 0) >= BOTTLE_DAILY_THROW) {
    return { ok: false, msg: '今天扔得够多了，明天再来给同学们一点惊喜' };
  }

  const college = await bottleCollegeOf(openid);
  const doc = {
    id: 'b' + Date.now() + Math.floor(Math.random() * 1000),
    kind: kind,
    content: content,
    // 作者身份只锁在服务端：捞到的人永远拿不到 openid，解锁的只有院系
    openid: openid,
    // 院系是「回复后解锁」的那部分信息：存快照但只在回复成功后下发
    ownerCollege: college,
    thrownAt: Date.now(),
    replies: []
  };
  const w = await db.collection(COL_BOTTLES).add({ data: doc }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[bottleThrow] write failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '云端没存住', detail: (d.code + ' ' + d.msg).trim() };
  }
  return { ok: true, id: doc.id };
}

// 捞瓶子：bottleFetch {} —— 每天限 3 次，随机一条 30 天内别人扔的
async function bottleFetch(openid) {
  const key = openid + '|' + bottleDayKey();
  const logRes = await db.collection(COL_BOTTLE_LOGS).where({ key: key }).limit(1).get()
    .catch(() => ({ data: [] }));
  const log = logRes.data && logRes.data[0];
  const used = (log && Number(log.count)) || 0;
  if (used >= BOTTLE_DAILY_FETCH) {
    return { ok: false, msg: '今天 ' + BOTTLE_DAILY_FETCH + ' 次机会用完了，明天再来捞', left: 0 };
  }

  // 30 天内的才捞得到；自己扔的不算；已经回复过的也尽量不再给（等作者看到回复）
  const minAt = Date.now() - BOTTLE_LIFE_MS;
  const res = await db.collection(COL_BOTTLES).where({
    openid: db.command.neq(openid),
    thrownAt: db.command.gte(minAt)
  }).limit(100).get().catch(() => ({ data: [] }));
  const pool = (res.data || []).filter((b) => !(b.replies || []).some((x) => x.openid === openid));
  if (!pool.length) {
    return { ok: false, dry: true, msg: '海里暂时没有漂流瓶，扔一个再回来捞吧', left: BOTTLE_DAILY_FETCH - used };
  }

  const picked = pool[Math.floor(Math.random() * pool.length)];
  // 捞一次记一次（inc 并发安全）；记完再返回，保证次数以服务端为准
  if (log) {
    await db.collection(COL_BOTTLE_LOGS).where({ key: key })
      .update({ data: { count: db.command.inc(1), at: Date.now() } }).catch(() => {});
  } else {
    await db.collection(COL_BOTTLE_LOGS).add({
      data: { key: key, openid: openid, day: bottleDayKey(), count: 1, at: Date.now() }
    }).catch(() => {});
  }
  return {
    ok: true,
    bottle: {
      id: picked.id,
      kind: picked.kind || '吐槽',
      content: picked.content || '',
      thrownAt: picked.thrownAt || 0,
      // 捞到时锁着院系：回复成功才解锁（见 bottleReply）
      ownerCollege: '',
      locked: true
    },
    left: BOTTLE_DAILY_FETCH - used - 1
  };
}

// 回复捞到的瓶子：bottleReply { id, content } —— 回复成功即解锁对方院系
async function bottleReply(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  const content = String(payload.content || '').trim().slice(0, 300);
  if (!id) return { ok: false, msg: '瓶子不见了，重新捞一个吧' };
  if (!content) return { ok: false, msg: '回复写点什么吧' };
  const g = await guard(content);
  if (!g.ok) return { ok: false, msg: g.msg };

  const hit = await db.collection(COL_BOTTLES).where({ id: id }).limit(1).get()
    .catch(() => ({ data: [] }));
  const bottle = hit.data && hit.data[0];
  if (!bottle) return { ok: false, msg: '这只瓶子已经沉海了' };
  if (bottle.openid === openid) return { ok: false, msg: '这是你自己扔的瓶子' };

  const replyerCollege = await bottleCollegeOf(openid);
  const reply = {
    id: 'br' + Date.now() + Math.floor(Math.random() * 1000),
    content: content,
    openid: openid,
    college: replyerCollege, // 作者侧解锁用：作者能在「我的瓶子」里看到回复人的院系
    at: Date.now()
  };
  // each 写法明确「把数组里的每一项逐个追加」：直接 push([reply]) 在不同 SDK 版本上
  // 有被当成「追加一个数组元素」的风险，聊天消息那边也是这么写的，保持一致
  const w = await db.collection(COL_BOTTLES).where({ id: id })
    .update({ data: { replies: db.command.push({ each: [reply] }) } }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[bottleReply] write failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '云端没存住', detail: (d.code + ' ' + d.msg).trim() };
  }
  // 解锁：回复的人此刻拿到瓶子作者的院系
  return { ok: true, ownerCollege: String(bottle.ownerCollege || '未填写'), replies: (bottle.replies || []).length + 1 };
}

// 我的瓶子：bottleMine {} —— 我扔的（含收到的回复 + 回复人院系）与今日剩余次数
async function bottleMine(openid) {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const res = await db.collection(COL_BOTTLES).where({
    openid: openid,
    thrownAt: db.command.gte(dayStart.getTime() - BOTTLE_LIFE_MS)
  }).limit(20).get().catch(() => ({ data: [] }));

  // 作者侧解锁：回复人的院系是回复那一刻对方交出来的，直接下发
  const mine = (res.data || []).map((b) => ({
    id: b.id,
    kind: b.kind || '吐槽',
    content: b.content || '',
    thrownAt: b.thrownAt || 0,
    replies: (b.replies || []).map((r) => ({
      id: r.id,
      content: r.content || '',
      at: r.at || 0,
      college: String(r.college || '未填写')
    }))
  })).sort((a, b) => b.thrownAt - a.thrownAt);

  const logRes = await db.collection(COL_BOTTLE_LOGS).where({ key: openid + '|' + bottleDayKey() }).limit(1).get()
    .catch(() => ({ data: [] }));
  const used = (logRes.data && logRes.data[0] && Number(logRes.data[0].count)) || 0;
  return { ok: true, mine: mine, fetchedToday: used, left: Math.max(0, BOTTLE_DAILY_FETCH - used) };
}

// 从师资页正文里抽人名。规则很粗：2-4 个汉字、不在黑名单里。
// 宁可漏几个，也别把「计算机科学与技术系」「主任」这类词塞进名录，
// 那会让同学在选老师时看到一串假老师。
const NAME_STOP = ['系', '主任', '副主任', '导师', '老师', '学院', '大学', '学校', '中心', '办公室',
  '建设', '发展', '项目', '研究', '教学', '课程', '学生', '教师', '管理', '工程', '技术', '科学',
  '委员会', '工作', '专业', '方向', '重点', '团队', '计划', '申报', '博导', '硕导', '职称', '高级',
  '级', '组', '员', '公告', '通知', '师资', '队伍', '队伍', '博士', '硕士', '本科', '研究生'];

function parseTeacherNames(html, fromMark) {
  const text = htmlToText(html);
  const from = fromMark ? text.indexOf(fromMark) : -1;
  const seg = from >= 0 ? text.slice(from, from + 3200) : text.slice(0, 3200);
  const cleaned = seg.replace(/[^一-龥\s]/g, ' ');
  const names = [];
  const seen = {};
  cleaned.split(/\s+/).forEach((w) => {
    const w2 = w.trim();
    if (w2.length < 2 || w2.length > 4) return;
    if (!/^[一-龥]{2,4}$/.test(w2)) return;
    if (NAME_STOP.some((s) => w2.indexOf(s) >= 0)) return;
    if (seen[w2]) return;
    seen[w2] = 1;
    names.push(w2);
    if (names.length >= 200) return;
  });
  return names;
}

async function syncOfficialTeachers() {
  let added = 0, updated = 0;
  const pages = await Promise.all(TEACHER_SOURCES.map((s) => webGet(s.url).then((body) => ({ src: s, body: body }))));
  for (const p of pages) {
    if (!p.body) continue;
    const names = parseTeacherNames(p.body, p.src.from);
    for (const name of names) {
      const exist = await db.collection(COL_TEACHERS)
        .where({ name: name, college: p.src.site }).limit(1).get().catch(() => ({ data: [] }));
      const rec = exist.data && exist.data[0];
      if (rec) { updated += 1; continue; }
      const w = await db.collection(COL_TEACHERS).add({
        data: {
          id: 't' + p.src.key + name + Date.now(),
          name: name,
          college: p.src.site,
          official: true,
          sourceUrl: p.src.url,
          at: Date.now()
        }
      }).catch(() => ({ err: true }));
      if (!w || !w.err) added += 1;
    }
  }
  return { ok: true, added: added, updated: updated };
}

async function teacherSyncFromWeb(openid) {
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能同步教师名录' };
  if (!(await takeSyncSlot('teachers', 60 * 60 * 1000))) {
    return { ok: false, msg: '教师名录刚同步过，请稍后再试' };
  }
  return syncOfficialTeachers();
}

/* ---------------- 教师名录 ---------------- */

// 同学自己补一个老师：官网名录覆盖不到的学院、新入职的老师都靠这一步。
// 写入时带上 openid，别人不能改也不能删。
async function teacherAdd(openid, payload) {
  payload = payload || {};
  const name = String(payload.name || '').trim();
  const college = String(payload.college || '').trim().slice(0, 30);
  if (!name) return { ok: false, msg: '老师名字得写一下' };
  if (!/^[一-龥·]{2,6}$/.test(name)) return { ok: false, msg: '名字看起来不太对，填个中文名' };
  const g = await guard(name, college);
  if (!g.ok) return { ok: false, msg: g.msg };
  const hit = await db.collection(COL_TEACHERS)
    .where({ name: name, college: college || '' }).limit(1).get().catch(() => ({ data: [] }));
  if (hit.data && hit.data.length) return { ok: true, id: hit.data[0].id, already: true };
  const doc = {
    id: 'tu' + Date.now() + Math.floor(Math.random() * 1000),
    name: name,
    college: college,
    official: false,
    openid: openid,
    at: Date.now()
  };
  const w = await db.collection(COL_TEACHERS).add({ data: doc }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[teacherAdd] write failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '云端没存住', detail: (d.code + ' ' + d.msg).trim() };
  }
  return { ok: true, teacher: doc };
}

// 名录现在 1500+ 人，一次性拉不全：云数据库单次 get 的硬上限就是 1000 条，
// 直接写 limit(1500) 会报错，写 limit(1000) 则默默只给前 1000 个。
// 所以先 count 拿总数，再按 1000 一页翻完。
// 这个上限不报错，症状是「后面那些老师怎么搜都搜不到」，
// 而且按自然序截断，丢的是谁完全不可预期 —— 和真题列表 limit(60) 那次一个性质。
async function fetchAllTeachers() {
  const c = await db.collection(COL_TEACHERS).count().catch(() => null);
  const total = (c && c.total) || 0;
  if (!total) return [];
  if (total <= TEACHER_PAGE) {
    const r = await db.collection(COL_TEACHERS).limit(TEACHER_PAGE).get().catch(() => null);
    return (r && r.data) || [];
  }
  const pages = Math.ceil(total / TEACHER_PAGE);
  const out = [];
  for (let i = 0; i < pages; i++) {
    const r = await db.collection(COL_TEACHERS).skip(i * TEACHER_PAGE).limit(TEACHER_PAGE)
      .get().catch(() => null);
    if (r && r.data) out.push.apply(out, r.data);
  }
  return out;
}

async function teacherList(openid, payload) {
  payload = payload || {};
  const kw = String(payload.keyword || '').trim();
  const college = String(payload.college || '').trim();
  // 模糊搜索走不了正则（云数据库不支持），只能先整份拉回来再在内存里过滤
  if (!kw) {
    // 名录一次性全给：下拉补全要的是「输一个字就能筛出人」，分页没意义
    let list = await fetchAllTeachers();
    if (college) list = list.filter((t) => t.college === college);
    return { ok: true, list: list.map((t) => Object.assign({}, t, { isMine: !!openid && (t.openid === openid) })) };
  }
  // 搜索也必须翻全量：之前只取前 500 条，名录一过 500 人，
  // 排在后面的老师输入全名也搜不出来
  let list = await fetchAllTeachers();
  if (college) list = list.filter((t) => t.college === college);
  // 名字匹配 + 学院也匹配：同学输入「王 计算机」这种尽量能搜到
  list = list.filter((t) => {
    const hay = (t.name || '') + ' ' + (t.college || '');
    return hay.indexOf(kw) >= 0;
  }).slice(0, 20);
  return { ok: true, list: list.map((t) => Object.assign({}, t, { isMine: !!openid && (t.openid === openid) })) };
}

// 只要名字的轻量版：课程列表页一进页面就要拿全量名录做老师档，
// 走 teacherList 会把 1500 条整份文档搬回前端（含 sourceUrl、时间戳这些页面根本不看的字段），
// 既慢又占流量。名字本身才几 KB。
async function teacherNames() {
  const list = await fetchAllTeachers();
  const names = [];
  list.forEach((t) => {
    const n = String(t.name || '').trim();
    if (n && names.indexOf(n) < 0) names.push(n);
  });
  return { ok: true, names: names };
}

// 老师本人投诉到邮箱、审核员核实后，要把这位老师名下的评价一次性收下去。
// 一条条点太慢，而对外承诺的响应是 48 小时 ——
// 「还没找到内容在哪儿」不能成为拖延的正当理由。
//
// ⚠️ 只下架（status: 'hidden'），绝不物理删除。三个理由：
//   ① 老师投诉后又撤回、或学生申诉说被冤枉时，删干净了就什么都说不清；
//   ② 真走到诉讼，这些留存的原文本身就是处置记录，
//      能证明「收到通知后及时采取了必要措施」；
//   ③ 下架可逆，删除不可逆，可逆的操作才敢让审核员一键点下去
async function teacherHideReviews(openid, payload) {
  payload = payload || {};
  if (!(await isModerator(openid))) return { ok: false, msg: '只有审核员能操作' };
  const name = String(payload.name || '').trim();
  if (!name) return { ok: false, msg: '没指名是哪位老师' };
  const reason = String(payload.reason || '老师本人投诉').slice(0, 40);
  // 分页取全量：单次 get 上限 1000，一位老师名下的评价攒够了也会破，
  // 不翻页就会漏掉后半截 —— 漏掉的恰恰是「以为下架干净了其实没有」的那批
  const cnt = await db.collection(COL_REVIEWS).where({ teacher: name }).count().catch(() => null);
  const total = (cnt && cnt.total) || 0;
  const list = [];
  if (total) {
    const pages = Math.ceil(total / REVIEW_PAGE);
    for (let i = 0; i < pages; i++) {
      const r = await db.collection(COL_REVIEWS).where({ teacher: name })
        .skip(i * REVIEW_PAGE).limit(REVIEW_PAGE).get().catch(() => null);
      if (r && r.data) list.push.apply(list, r.data);
    }
  }
  const alive = list.filter((x) => x && (!x.status || x.status === 'normal'));
  if (!alive.length) return { ok: true, hidden: 0, msg: '这位老师名下没有正在展示的评价' };
  // 一次最多 200 条：再多就分两次，别把云函数拖到超时（超时 = 一条都没改成）
  const batch = alive.slice(0, 200);
  let done = 0;
  for (let i = 0; i < batch.length; i++) {
    const ok = await setContentStatus('review', String(batch[i].id || ''), 'hidden', reason)
      .catch(() => false);
    if (ok) done += 1;
  }
  await logMod(openid, 'teacherHideReviews', 'teacher', name,
    '下架 ' + done + '/' + batch.length + ' 条：' + reason).catch(() => null);
  const left = alive.length - done;
  return {
    ok: !!done,
    hidden: done,
    total: alive.length,
    msg: done
      ? ('已下架 ' + done + ' 条' + (left > 0 ? '，还剩 ' + left + ' 条，再点一次继续' : ''))
      : '一条都没下架成，请重试'
  };
}

async function teacherRemove(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  const hit = await db.collection(COL_TEACHERS).where({ id: id }).limit(1).get().catch(() => ({ data: [] }));
  const rec = hit.data && hit.data[0];
  if (!rec) return { ok: true };
  if (rec.official === true) return { ok: false, msg: '官方名录里的老师不能删' };
  if (rec.openid !== openid) return { ok: false, msg: '只能删除自己添加的老师' };
  await db.collection(COL_TEACHERS).where({ id: id }).remove().catch(() => {});
  return { ok: true };
}

/* ---------------- 备忘录（只自己可见） ---------------- */

// 备忘录记的是「我自己想留下的事」，跟论坛正好相反：
// 这里没有任何人（包括审核员）应该看到别人的记录，所以读写一律带 openid 过滤，
// 在服务端强制——前端藏不藏都一样，绕过云函数直接写库也只会写到自己名下。
const MEMO_TEXT_MAX = 2000; // 单条正文上限，超长的基本是复制粘贴误操作
const MEMO_MAX = 800;       // 单用户条数上限，防止有人把集合撑爆

function memoDateStr(d) {
  const t = d || new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

async function memoList(openid) {
  if (!openid) return { ok: true, list: [] };
  const res = await db.collection(COL_MEMOS)
    .where({ openid: openid })
    .orderBy('at', 'desc')
    .limit(300)
    .get().catch(() => null);
  return { ok: true, list: (res && res.data) || [] };
}

async function memoSave(openid, payload) {
  // 兼容两种喂法：memoSave(openid, { item }) 和直接把一条记录当参数丢进来
  payload = (payload && payload.item) || payload || {};
  const text = String(payload.text || '').trim().slice(0, MEMO_TEXT_MAX);
  if (!text) return { ok: false, msg: '还没写内容' };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(payload.date || '')) ? payload.date : memoDateStr();
  const mood = String(payload.mood || '').slice(0, 10);
  // id 带随机后缀：只用 Date.now() 的话，同一毫秒里写两条会撞 id，
  // 后一条会被当成「编辑前一条」，用户看到的就是「我明明写了两条只剩一条」
  const id = String(payload.id || ('memo' + Date.now() + Math.floor(Math.random() * 1000)));

  // 归属校验：带 id 过来时，那一条必须是我自己的
  const hit = await db.collection(COL_MEMOS).where({ id: id }).limit(1).get().catch(() => ({ data: [] }));
  const old = (hit && hit.data && hit.data[0]) || null;
  if (old && String(old.openid || old._openid || '') !== openid) {
    return { ok: false, msg: '这条不是你的，改不了' };
  }
  const data = {
    id: id,
    openid: openid,
    text: text,
    date: date,
    mood: mood,
    at: Date.now()
  };
  // 只有新增才判总量：编辑自己那条不该被上限拦住
  if (!old) {
    const cnt = await db.collection(COL_MEMOS).where({ openid: openid }).count().catch(() => null);
    if (cnt && cnt.total >= MEMO_MAX) return { ok: false, msg: '备忘录最多 ' + MEMO_MAX + ' 条' };
  }
  // 写不进去要如实报：备忘只有云端一份，报成功却没落库 = 用户明明天天记、刷新就没了
  const w = old
    ? await db.collection(COL_MEMOS).where({ id: id }).update({ data: data }).catch((e) => ({ err: e }))
    : await db.collection(COL_MEMOS).add({ data: data }).catch((e) => ({ err: e }));
  if (w && w.err) {
    const d = dbErr(w.err);
    console.error('[memoSave] write failed:', d.code, d.msg);
    return { ok: false, saved: false, msg: '云端没存住', detail: (d.code + ' ' + d.msg).trim() };
  }
  return { ok: true, item: data };
}

async function memoRemove(openid, payload) {
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id) return { ok: false, msg: '参数缺失' };
  // where 里带上 openid：就算猜到别人的 id 也删不掉
  await db.collection(COL_MEMOS).where({ id: id, openid: openid }).remove().catch(() => {});
  return { ok: true };
}

/* ---------------- 入口 ---------------- */

// 定时触发器专用入口：抓官网活动 + 学院师资。
// 两条同步都是只读 + 幂等的，跟「谁触发的」无关，所以不需要 openid。
// 抓不完不让整个函数抛错 —— 触发失败会连着失败告警会淹没真问题，如实回 ok:false 就够了
async function runTimerSync(event) {
  const trigger = String((event && (event.TriggerName || event.triggerName)) || '');
  if (trigger === 'mediaAuditSweep') {
    try {
      return { ok: true, trigger: 'mediaAuditSweep', mediaSweep: await mediaAuditSweep() };
    } catch (e) {
      return { ok: false, trigger: 'mediaAuditSweep', msg: String((e && e.message) || e) };
    }
  }
  let events = null;
  let teachers = null;
  let purge = null;
  let sweep = 0;
  const errs = [];
  try {
    events = await syncOfficialEvents();
  } catch (e) {
    errs.push('events: ' + ((e && e.message) || String(e)));
  }
  try {
    teachers = await syncOfficialTeachers();
  } catch (e) {
    errs.push('teachers: ' + ((e && e.message) || String(e)));
  }
  // 注销到期执行。放在这里而不是「等用户回来点一下」：
  // 注销的语义是「我不想再来了」，让一个已经离开的人回来点一下才算数，
  // 等于把注销做成了一句空承诺。
  try {
    purge = await runAccountPurge();
  } catch (e) {
    errs.push('purge: ' + ((e && e.message) || String(e)));
  }
  // 图片审核兜底：微信推送没配（或推送丢了）时，pending 会一直挂着，
  // 审核员在队列里看到 pending 会以为「还在审」，一直等下去
  try {
    sweep = await mediaAuditSweep();
  } catch (e) {
    errs.push('sweep: ' + ((e && e.message) || String(e)));
  }
  // 到期的限时置顶收回。放在这里而不是单开一个定时器：
  // 一条 timer 记录一次调用，多一个就是多一份配额。
  // 读的一侧也会按 pinUntil 过滤（到期那一刻起就不显示了），
  // 这一步只负责把 pinned 字段真正清干净，好让名额计数和上限判定不失真
  let pins = 0;
  try {
    pins = await pinSweep();
  } catch (e) {
    errs.push('pin: ' + ((e && e.message) || String(e)));
  }
  console.info('[dailyWebSync] events=', JSON.stringify(events && { added: events.added, updated: events.updated, alive: events.alive }),
    ' teachers=', JSON.stringify(teachers && { added: teachers.added, updated: teachers.updated }),
    ' purge=', JSON.stringify(purge),
    ' mediaSweep=', sweep,
    ' pinSweep=', pins,
    ' errors=', JSON.stringify(errs));
  return {
    ok: errs.length === 0,
    trigger: 'dailyWebSync',
    events: events,
    teachers: teachers,
    purge: purge,
    mediaSweep: sweep,
    pinSweep: pins,
    msg: errs.join('; ')
  };
}

exports.main = async (event) => {
  const openid = await me();
  const action = String((event && event.action) || '');

  // 微信「消息推送」回调：图片异步审核的结果从这里回来。
  // ⚠️ 前提是云开发控制台 → 设置 → 其他设置 → 消息推送，模式选「云函数」，
  //    配一条 MsgType=event / Event=wxa_media_check → 本云函数。
  //    （不是 mp 后台那条，那条是给自建服务器 URL 用的，且被云开发这条废掉。）
  //    没配的话结果永远回不来，只能靠上面的 mediaAuditSweep 兜底标 unverified。
  // 判定要放在最前面：这类事件没有 action，也没有 openid，
  // 落到下面的分支只会得到一句「无法识别用户身份」
  if (event && (event.Event === 'wxa_media_check' || event.MsgType === 'event' && event.trace_id)) {
    // 客户端调用一定带 openid；平台消息推送不带。不能允许用户伪造审核回执。
    if (openid) return { ok: false, msg: '无权提交媒体审核回执' };
    return applyMediaVerdict(event);
  }

  // 定时触发器（config.json 的 dailyWebSync）叫醒云函数时，微信传来的 event 里
  // 没有 action 这个字段，直接落到 default 只会得到一句「未知操作」——
  // 官网活动 / 教师名录就永远只能靠人手点「更新」，所谓的每天自动同步从来没跑起来过
  if (!action) {
    // 定时触发器没有 openid；普通客户端调用没有 action 不是定时器，直接拒绝。
    if (openid) return { ok: false, msg: '未知操作' };
    if (!(event && event.Type === 'Timer')) return { ok: false, msg: '未知操作' };
    return runTimerSync(event);
  }

  // 屏蔽词增补表：写操作前拉一次（5 分钟缓存，不额外增加每次写库的往返）。
  // 放在这里而不是各处调用点：checkText 是同步函数，改不成 async，
  // 只能在入口把词表准备好。读操作不需要，省一次查询
  if (action && WRITE_ACTIONS.indexOf(action) >= 0) {
    await getExtraWords();
  }


  // 诊断类动作不需要用户身份：云开发控制台的「测试」不携带 openid，
  // 如果放在下面的统一校验之后，diag/whoami 在控制台里永远跑不了
  if (action === 'diag') {
    return diag();
  }
  // ⚠️ whoami 只在这里返回，下面 switch 里那一份是够不到的死代码（已删）。
  //    之前这里只回 openid，把 isMod 一起吞掉了 —— 前端「我的 → 内容审核」页
  //    拿 me.isMod 判断自己是不是审核员，永远拿到 false，队列于是一直是空的。
  if (action === 'whoami') {
    const isMod = openid ? await isModerator(openid) : false;
    const ban = openid ? await banStateOf(openid) : null;
    // 注销冷静期状态一起带出去：被注销的人每次进小程序都该看到
    // 「你已申请注销，还有 N 天」和那个撤销按钮，否则他会以为点了没反应
    const acct = openid ? await accountState(openid) : { pending: false };
    const own = openid ? await db.collection(COL_USERS).doc(openid).get().catch(() => null) : null;
    const ownData = own && own.data && !Array.isArray(own.data) ? own.data : null;
    return {
      ok: true,
      openid: openid || '',
      isMod: isMod,
      deleted: !!(ownData && ownData.deleted),
      // 被封禁的人进小程序要能看见原因，不然只会以为是程序坏了
      banned: !!ban,
      banReason: ban ? ban.reason : '',
      cancel: acct,
      note: openid ? '' : '控制台测试无用户身份，openid 为空属正常'
    };
  }

  if (!openid) return { ok: false, msg: '无法识别用户身份' };

  // 封禁拦截：读一律放行，写一律拒绝。放在统一入口而不是每个 action 里，
  // 新增接口只要名字进了 BANNED_BLOCK_ACTIONS 就自动生效，不会漏
  if (BANNED_BLOCK_ACTIONS.indexOf(action) >= 0) {
    const ban = await banStateOf(openid);
    if (ban) {
      return {
        ok: false,
        banned: true,
        msg: '你的账号已被封禁' + (ban.reason ? '（' + ban.reason + '）' : '') + '，无法发布内容或互动'
      };
    }
  }

  try {
    switch (action) {
      case 'upsertProfile':
        return upsertProfile(openid, event);
      case 'getProfile':
        return getProfile(openid, String(event.openid || ''));
      case 'search':
        return search(openid, event.keyword, event.exact);
      case 'addRequest':
        return addRequest(openid, event);
      case 'respond':
        return respond(openid, event);
      case 'friendAccept':
        return friendAccept(openid, event);
      case 'friendReject':
        return friendReject(openid, event);
      case 'removeFriend':
        return removeFriend(openid, event);
      case 'friendCancel':
        return friendCancel(openid, event);
      case 'friendAlias':
        return friendAlias(openid, event);
      case 'listRequests':
        return listRequests(openid);
      case 'listOutgoing':
        return listOutgoing(openid);
      case 'listFriends':
        return listFriends(openid, event);
      // 账号与数据：注销 / 撤销注销 / 查状态
      case 'accountState':
        return accountState(openid);
      case 'accountCancel':
        return accountCancel(openid, event);
      case 'accountCancelUndo':
        return accountCancelUndo(openid);
      // 站内通知中心
      case 'notifyList':
        return notifyList(openid, event);
      case 'notifyRead':
        return notifyRead(openid, event);
      // 草稿：换设备也能接着写
      case 'draftList':
        return draftList(openid);
      case 'draftSave':
        return draftSave(openid, event);
      case 'draftRemove':
        return draftRemove(openid, event);
      // 审核操作日志（只读）
      case 'modLogs':
        return modLogs(openid, event);
      // 客户端错误上报：真机上没人看 console，写进库才查得到
      case 'reportError':
        return reportError('client:' + String(event.scope || ''), { errMsg: String(event.msg || '').slice(0, 200) }, event.extra)
          .then(() => ({ ok: true }));
      case 'block':
        return blockUser(openid, event);
      case 'unblock':
        return unblockUser(openid, event);
      case 'listBlocks':
        return listBlocks(openid);
      case 'report':
        return report(openid, event);
      case 'contentView':
        return contentView(openid, event);
      case 'getQueue':
        return getQueue(openid);
      case 'banUser':
        return banUser(openid, event);
      case 'unbanUser':
        return unbanUser(openid, event);
      case 'banList':
        return banList(openid);
      case 'resolveReports':
        return resolveReports(openid, event);
      // 已处置归档（只读）：确认 / 驳回之后回看「当时删的是哪条」
      case 'reportArchive':
        return reportArchive(openid, event);
      case 'setStatus':
        return setStatus(openid, event);
      case 'myContent':
        return myContent(openid);
      case 'delContent':
        return delContent(openid, event);
      case 'patchContent':
        return patchContent(openid, event);
      case 'whoami':
        // 到不了这里：whoami 在上方的统一入口就返回了（那里要带 isMod / banned）
        return { ok: true, openid: openid, isMod: await isModerator(openid) };
      case 'setAdmin':
        return setAdmin(openid);
      case 'saveFavorites':
        return saveFavorites(openid, event);
      case 'getFavorites':
        return getFavorites(openid);
        case 'postAdd':
          return postAdd(openid, event);
        case 'voteCast':
          return voteCast(openid, event);
        case 'reviewAdd':
          return reviewAdd(openid, event);
        case 'courseAdd':
          return courseAdd(openid, event);
        case 'courseRemove':
          return courseRemove(openid, event);
        case 'likeToggle':
          return likeToggle(openid, event);
        case 'holeReact':
          return holeReact(openid, event);
        case 'weather':
          return weather(openid, event);
      case 'postPin':
        return postPin(openid, event);
      case 'postPinOrder':
        return postPinOrder(openid, event);
      // 内容保护：只有审核员能调用，云函数里会再验一次身份
      case 'protectSet':
        return protectSet(openid, event);
      case 'protectList':
        return protectList(openid);
      case 'protectInfo':
        return protectInfo(openid, event);
      case 'cfgGet':
        return cfgGet(openid);
      case 'cfgSave':
        return cfgSave(openid, event);
      case 'calendarReset':
        return calendarReset(openid);
        case 'marketAdd':
          return marketAdd(openid, event);
      case 'marketList':
        return marketList(openid, event);
      case 'marketDone':
        return marketDone(openid, event);
      case 'marketRemove':
        return marketRemove(openid, event);
      case 'chatSend':
        return chatSend(openid, event);
      case 'chatList':
        return chatList(openid, event);
      case 'chatHistory':
        return chatHistory(openid, event);
      case 'chatAccept':
        return chatAccept(openid, event);
      case 'chatDismiss':
        return chatDismiss(openid, event);
      case 'chatRecall':
        return chatRecall(openid, event);
      case 'chatRemove':
        return chatRemove(openid, event);
      case 'postEdit':
        return postEdit(openid, event);
      case 'postsByAuthor':
        return postsByAuthor(openid, event);
      case 'postComment':
        return postComment(openid, event);
      case 'commentRemove':
        return commentRemove(openid, event);
      case 'commentReport':
        return commentReport(openid, event);
      // 留言的赞 / 踩：记名表 + 数人头，见 commentVote
      case 'commentVote':
        return commentVote(openid, event);
      // 留言按需拉取（拆表之后详情页不再从帖子文档里读留言）
      case 'commentList':
        return commentList(openid, event);
      // 留言申诉：被自动删掉的作者总要有个地方说话
      case 'commentAppealInfo':
        return commentAppealInfo(openid, event);
      case 'commentAppeal':
        return commentAppeal(openid, event);
      case 'commentRestore':
        return commentRestore(openid, event);
      case 'appealQueue':
        return appealQueue(openid, event);
      case 'resourceAdd':
        return resourceAdd(openid, event);
      case 'resourceList':
        return resourceList(openid, event);
      case 'resourceQueue':
        return resourceQueue(openid);
      case 'resourceReview':
        return resourceReview(openid, event);
      case 'resourceUrl':
        return resourceUrl(openid, event);
      case 'resourceThanks':
        return resourceThanks(openid, event);
      case 'resourceRemove':
        return resourceRemove(openid, event);
      case 'calendarList':
        return calendarList();
      case 'calendarSave':
        return calendarSave(openid, event);
      case 'calendarRemove':
        return calendarRemove(openid, event);
      case 'placeList':
        return placeList(openid, event);
      case 'placeAdd':
        return placeAdd(openid, event);
      case 'placeRemove':
        return placeRemove(openid, event);
      // 校园活动
      case 'eventAdd':
        return eventAdd(openid, event);
      case 'eventArticle':
        return eventArticle(openid, event);
      case 'eventList':
        return eventList(openid, event);
      case 'eventJoin':
        return eventJoin(openid, event);
      case 'eventCancel':
        return eventCancel(openid, event);
      case 'eventRemove':
        return eventRemove(openid, event);
      // 官网数据同步
      case 'eventSyncFromWeb':
        return eventSyncFromWeb(openid, event);
      case 'teacherSyncFromWeb':
        return teacherSyncFromWeb(openid);
      // 校园盲盒 / 漂流瓶：扔、捞（每日 3 次）、回复解锁院系、我的瓶子
      case 'bottleThrow':
        return bottleThrow(openid, event);
      case 'bottleFetch':
        return bottleFetch(openid);
      case 'bottleReply':
        return bottleReply(openid, event);
      case 'bottleMine':
        return bottleMine(openid);
      case 'courseTypeSet':
        return courseTypeSet(openid, event);
      case 'courseTypeList':
        return courseTypeList();
      case 'teacherAdd':
        return teacherAdd(openid, event);
      case 'teacherList':
        return teacherList(openid, event);
      case 'teacherNames':
        return teacherNames();
      case 'teacherRemove':
        return teacherRemove(openid, event);
      // 老师本人投诉 → 审核员把这位老师名下的评价一次性下架
      case 'teacherHideReviews':
        return teacherHideReviews(openid, event);
      // 误加课程的收尾通道：加课人不管了的时候，别人也能把它清掉
      case 'courseReqVote':
        return courseReqVote(openid, event);
      case 'courseReqInfo':
        return courseReqInfo(openid, event);
      case 'memoList':
        return memoList(openid);
      case 'memoSave':
        return memoSave(openid, event);
      case 'memoRemove':
        return memoRemove(openid, event);
      case 'diag':
        return diag();
      case 'checkText':
        // 服务端权威校验：前端绕过云函数直接写库也躲不过这一步
        return checkText(event.title || '', event.content || '');
      case 'ensureSeed':
        return ensureSeed(event);
      default:
        return { ok: false, msg: '未知操作：' + action };
    }
  } catch (e) {
    return { ok: false, msg: (e && e.message) || '服务端出错' };
  }
};

// 把处置阈值也导出去：前端 utils/config.js 的 MODERATION 是照这份写的展示文案，
// 两边一旦分叉，页面上写的和云上实际干的事就对不上了
module.exports.MOD_RULES = MOD_RULES;
