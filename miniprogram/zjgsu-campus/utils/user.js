// utils/user.js —— 用户身份与同学关系层
//
// 三层身份，从上到下：
//   1）openid：微信云开发在云函数里直接给的唯一 ID，不用登陆、不会变，负责「区分谁是谁」；
//   2）个人资料：昵称 / 头像 / 学院 / 我的联系方式，由用户自己填、自己决定公开多少；
//   3）同学关系：加为好友 → 对方同意 → 才互相亮出联系方式；单向请求永远看不到对方的号，
//      任何一方都能单方面解除（解除后回到「陌生人」，各自恢复 3 条私信额度）。
//
// 本文件只做「接口」，不做「按钮」：加好友 / 解除好友的交互（留言弹窗、二次确认、
// 文案）在 utils/friend.js —— 那两个动作有多个触发点，交互写一份才不会各说各话。
//
// 所有涉及「别人联系方式」的读写在服务端（云函数 user）完成，
// 这里的前端缓存只是为了让页面秒开，云端不可用时自动回落到本地，功能不中断。
//
// ── 本文件职责边界（接手注意）────────────────────────────────────────
// 文件名虽叫 user，但实际不止身份关系，还承载：
//   · 内容写入   postAdd / reviewAdd / courseAdd / voteCast / likeToggle / holeReact …
//   · 审核处置   reportPost / getModerationQueue / resolveReports / delContent …
//   · 资源/校历/地点/天气/运行配置  resource* / calendar* / place* / weather / cfg*
// 未来可考虑把「内容写入 / 资源 / 日历 / 地点」下沉到各自域文件，
// 但对外 module.exports 接口请保持兼容，页面零改动。
// 真正落到云端由 cloudfunctions/user/index.js 按 action 路由，action 名见该文件头索引。

const cloud = require('./cloud.js');

const KEY = {
  profile: 'zjgsu_profile', // 我的资料
  profileDirty: 'zjgsu_profile_dirty', // 本机改过但云端还没确认
  friends: 'zjgsu_friends', // 我的好友（含联系方式）
  reqIn: 'zjgsu_req_in',    // 收到待处理的请求
  reqOut: 'zjgsu_req_out'   // 我发出待回应的请求
};

// 联系方式展示文案
const CONTACT_LABEL = {
  wechat: '微信号',
  phone: '手机号',
  qq: 'QQ号'
};

function read(key, fallback) {
  const v = wx.getStorageSync(key);
  return (v === '' || v === undefined || v === null) ? fallback : v;
}
function write(key, val) {
  try { wx.setStorageSync(key, val); } catch (e) {}
}

// 云函数调用兜底超时：wx.cloud.callFunction 本身没有可靠的前端超时，
// 云端冷启动卡住 / 函数卡死时这个 promise 会挂起很久，
// 用户看到的就是「点了发布没反应」（树洞「投进树洞」提交失败的视频演示正是这种观感）。
// 12 秒还没回来就按「云端暂时连不上」处理 —— 上层会把内容留在本机并如实提示，
// 绝不无限干等。
const CALL_TIMEOUT_MS = 12 * 1000;

// 给任意 promise 套一个超时：到点还没结果就 resolve(fallback)，不 reject（调用方好处理）
function withTimeout(promise, fallback, ms) {
  let timer = setTimeout(() => settle(fallback), ms || CALL_TIMEOUT_MS);
  let settle;
  const gate = new Promise((resolve) => { settle = resolve; });
  promise.then((v) => { clearTimeout(timer); settle(v); }, () => { clearTimeout(timer); settle(null); });
  return gate;
}

/** 调云函数；云函数未部署 / 超时 / 报错时 resolve(null)，由调用方回落本地 */
// 真正的发请求那一份在 cloud.js，这里额外套一层上面的超时。
// ⚠️ 第三个参数 ms 允许单接口自定义超时：发帖的 checkText / postAdd 是「发布中」转圈的主要耗时，
//    必须比全局 12s 更短，否则弱网下两段各拖到 12s、合计 24s 正好卡在提交总闸边缘，
//    用户看到的就是「一直发布中」。慢了不如早失败、让内容留本机、可重发
const call = (action, payload, ms) => withTimeout(cloud.callFunction(action, payload), null, ms || CALL_TIMEOUT_MS);

/* ---------------- 启动登记 ---------------- */

// 首次进入只“读回”云端资料，绝不用本机空缓存去覆盖云端。
// 以前这里会无条件 upsert：新设备/清缓存后本地资料是空的，服务端就会把
// 已有昵称、学院、联系方式全部覆盖成默认值。资料写入只能由用户明确点“保存”触发。
function hasMeaningfulProfile(p) {
  const x = p || {};
  return !!(String(x.avatarUrl || '').trim()
    || String(x.college || '').trim()
    || String(x.motto || '').trim()
    || String(x.contactType || '').trim()
    || String(x.contactValue || '').trim()
    || (String(x.nickName || '').trim() && String(x.nickName || '').trim() !== '浙小商'));
}

function initUser() {
  try { if (wx.getStorageSync('zjgsu_account_deleted')) return Promise.resolve(null); } catch (e) {}
  const oid = cloud.getOpenid();
  if (!oid) return Promise.resolve(null);
  const local = read(KEY.profile, {});
  return call('getProfile', { openid: oid }).then((r) => {
    const profile = r && r.profile;
    const dirty = !!read(KEY.profileDirty, false);
    // 本机没有资料时从云端补回；本机有未同步修改时保留本机，等服务端确认。
    if (profile && (!hasMeaningfulProfile(local) || !dirty)) {
      write(KEY.profile, profile);
    }
    return r;
  });
}

/* ---------------- 我的资料 ---------------- */

function getMyProfile() {
  const p = read(KEY.profile, {});
  p.openid = p.openid || cloud.getOpenid() || '';
  p.avatarText = (p.nickName || '浙').charAt(0);
  return p;
}

function saveProfile(p) {
  const data = {
    openid: cloud.getOpenid() || p.openid || '',
    nickName: p.nickName || '浙小商',
    avatarUrl: p.avatarUrl || '',
    college: p.college || '',
    motto: p.motto || '',
    contactType: p.contactType || '',
    contactValue: p.contactValue || ''
  };
  write(KEY.profile, data);
  write(KEY.profileDirty, true);
  return call('upsertProfile', Object.assign({ revive: true }, data)).then((r) => {
    if (!r || r.ok === false) {
      return {
        ok: false,
        localOnly: true,
        msg: (r && r.msg) || '云端没同步，资料只保存在本机',
        profile: data
      };
    }
    const profile = (r && r.profile) || data;
    write(KEY.profile, profile);
    write(KEY.profileDirty, false);
    try { wx.removeStorageSync('zjgsu_account_deleted'); } catch (e) {}
    return { ok: true, profile: profile };
  }).catch(() => ({
    ok: false,
    localOnly: true,
    msg: '云端没同步，资料只保存在本机',
    profile: data
  }));
}

/* ---------------- 看别人的资料 ---------------- */

// 看别人主页：是否为好友、能否看到联系方式，一律由云函数判定
function getProfile(openid) {
  return call('getProfile', { openid: openid })
    // 即使云端还没升级、profile 仍是 null，也要保留 isFriend / isMe；
    // 名片页会自己补一张默认名片，不能把“是不是同学”也一起吞掉。
    .then((r) => r || { profile: null, isFriend: false, isMe: false });
}

// TA 的历史发帖（名片页用）。
//
// 匿名帖与树洞帖的过滤一律留在服务端：这条规矩只允许存在一份，
// 前端再抄一遍，两边迟早漂移，而漏一次就等于把匿名内容漏出去 —— 代价太大。
// 返回 null 表示「云端拿不到」（没部署 / 断网），调用方据此退回本地缓存那份。
function postsByAuthor(openid, limit) {
  const n = Number(limit) || 0;
  return call('postsByAuthor', { author: openid, limit: n }).then((r) => r || null);
}

// 找同学：和课程 / 论坛 / 闲置一个道理，也有人把名字打错一个字。
// exact 传 true 是「精准档」，只认原样；不传就是模糊档
function search(keyword, exact) {
  return call('search', { keyword: keyword, exact: !!exact })
    .then((r) => (r && r.list) || []);
}

/* ---------------- 想认识 / 好友 ---------------- */

function addRequest(toOpenid, message) {
  return call('addRequest', { toOpenid: toOpenid, message: message })
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，申请没发出去' } : r));
}

// ⚠️ 旧实现在云函数没响应（null）时返回 { ok:true } ——
// 前端于是弹「已通过」、把那一行从列表里撤掉，云端却压根没处理，
// 刷新之后申请又回来了，人也没加成同学。这正是「点了同意没反应 / 反复出现」的根源之一。
// 现在一律如实返回 ok:false，绝不谎报成功。
function respond(id, action) {
  return call('respond', { id: id, action: action })
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，再点一次' } : r));
}

// 同意好友申请：云端在一个事务里删申请 + 双向写同学关系，成功才回 ok:true。
// 返回里带 friend（新同学资料），前端可以直接插进同学列表，不用再整表重拉一次
function friendAccept(id) {
  return call('friendAccept', { id: id })
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，再点一次' } : r));
}

// 忽略：保留 24 小时冷却
function friendReject(id) {
  return call('friendReject', { id: id })
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，再点一次' } : r));
}

// 解除好友：服务端双向删关系、清掉这对人之间的申请记录，并在会话上盖一个额度水位
// （见云函数 removeFriend 一节）。⚠️ 云端不可用时**不能**当成成功 ——
// 谎报「已解除」而关系还在，比直接说失败更难查：用户会以为点第二次就行
function removeFriend(toOpenid) {
  return call('removeFriend', { toOpenid: toOpenid })
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，再点一次' } : r));
}

function listRequests() {
  return call('listRequests', {}).then((r) => {
    const list = (r && r.list) || read(KEY.reqIn, []);
    write(KEY.reqIn, list);
    return list;
  });
}

function listOutgoing() {
  return call('listOutgoing', {}).then((r) => {
    const list = (r && r.list) || [];
    write(KEY.reqOut, list);
    return list;
  });
}

// 撤回我发出的那条好友申请。
//
// 为什么必须有：申请发出去以后界面只剩「已申请，等对方回应」这一句，没有任何出口。
// 发错人了、觉得唐突了、想换句话重发，都只能干等对方处理。
// 撤销会连 24 小时冷却一起清掉（冷却记在那条记录上），所以撤销之后能立刻重发 ——
// 不清的话，「撤销」这个动作等于把自己锁一天
function friendCancel(id, toOpenid) {
  return call('friendCancel', { id: id || '', toOpenid: toOpenid || '' })
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，再点一次' } : r));
}

// 备注名：只影响我这边的显示，对方看不到。
// 「全校同名同姓」在校园里一点都不稀奇，名单里只靠学院区分根本不够用
function friendAlias(toOpenid, alias) {
  return call('friendAlias', { toOpenid: toOpenid, alias: alias || '' })
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，再点一次' } : r));
}

// 同学名单（旧签名，返回数组）。保留它是因为页面调用点很多，
// 改返回形状会让所有调用方一起改，而它们要的其实只是数组
function listFriends() {
  return call('listFriends', {}).then((r) => {
    // 超时/云端失败时保留上一次缓存，不能把“没读到”当成“没有好友”。
    if (!r || !Array.isArray(r.list)) return read(KEY.friends, []);
    write(KEY.friends, r.list);
    return r.list;
  });
}

function cachedFriends() {
  const list = read(KEY.friends, []);
  return Array.isArray(list) ? list : [];
}

// 同学名单（分页版），给「好友上百」那种情况用：
// 云端一次最多回 200 条，再多就得翻页。
// 页码大于 0 时**不写本地缓存** —— 把每一页都写进去，本地那份会变成
// 一个谁也说不清是第几页的拼接结果，离线打开时显示的东西完全对不上
function listFriendsPaged(limit, offset) {
  const off = Number(offset) || 0;
  return call('listFriends', { limit: Number(limit) || 100, offset: off })
    .then((r) => {
      const list = (r && r.list) || [];
      if (!off && list.length) write(KEY.friends, list);
      return {
        list: list,
        total: Number((r && r.total) || list.length) || 0,
        hasMore: !!(r && r.hasMore)
      };
    });
}

// 同步判断：某个 openid 是不是我的好友（用于名片页决定按钮文案）
function isFriend(openid) {
  const list = read(KEY.friends, []);
  return list.some((f) => f.openid === openid);
}

/* ---------------- 拉黑 ---------------- */

// 拉黑之后：TA 再也发不出请求给我，我的联系方式也不会对 TA 显示
// 拉黑与解除拉黑。
//
// ⚠️ 云端不可用时**绝不**回 ok:true —— 断网时云端什么都没写，
// 而「界面显示已拉黑、消息其实照旧能发进来」是最坏的一种错：
// 用户以为挡住了，接下来会放松所有警惕
function block(toOpenid) {
  return call('block', { toOpenid: toOpenid })
    .then((r) => (r === null ? { ok: false, degraded: true, msg: '云端没响应，没能拉黑' } : r));
}

function unblock(toOpenid) {
  return call('unblock', { toOpenid: toOpenid })
    .then((r) => (r === null ? { ok: false, degraded: true, msg: '云端没响应，没能解除' } : r));
}

function listBlocks() {
  return call('listBlocks', {}).then((r) => (r && r.list) || []);
}

/* ---------------- 收藏 ---------------- */

// 收藏落在云端的 favorites 集合（_id = 我的 openid），换手机、重装都还在。
// 云函数不可用时照常 resolve(null)，调用方回落本地那份。
function saveFavorites(list) {
  return call('saveFavorites', { list: Array.isArray(list) ? list : [] })
    .then((r) => r || { ok: true, list: Array.isArray(list) ? list : [] });
}

function getFavorites() {
  return call('getFavorites', {}).then((r) => (r && Array.isArray(r.list) ? r : { ok: true, list: [] }));
}

/* ---------------- 内容写入 ---------------- */

// 这几个操作一律走云函数，前端不碰数据库。
// 云函数里会过屏蔽词 + 微信官方内容安全接口，绕过云函数直接写库躲不过去。
// 云函数没部署/调不通时 call 返回 null，写入类接口一律如实返回 saved:false，
// 不谎报成功 —— 本地那份由 store 层负责保留。

// 注意：call 返回 null 表示「云函数没部署 / 网络失败 / 调用超时」，
// 这时绝不能谎报 { ok: true } —— 前端会弹「发布成功」，内容却压根没到云端，
// 正是「写完好好的一转头没了」的根源。如实返回 saved:false，
// 由 store 层按「已存本机、没同步上」处理（本地内容保留）。
function postAdd(post) {
  // 写库类接口：单独 10s。慢了前端能在总闸之前拿到「云端暂时连不上」，
  // 而不是对着「发布中」干等到全局 12s 上限
  return call('postAdd', { post: post }, 10000)
    .then((r) => (r === null ? { ok: false, saved: false, msg: '云端暂时连不上' } : r));
}

// 投票同步：服务端按 context openid 记名，同一 openid 投两次会被挡回。
// 失败只影响云端那份，本地结果已经生效（store.castVote 本地先行）
function voteCast(postId, optionIds) {
  return call('voteCast', { postId: postId, optionIds: optionIds })
    .then((r) => (r === null ? { ok: false, saved: false, msg: '云端暂时连不上' } : r));
}

function reviewAdd(review) {
  return call('reviewAdd', { review: review })
    .then((r) => (r === null ? { ok: false, saved: false, msg: '云端暂时连不上' } : r));
}

function courseAdd(course) {
  return call('courseAdd', { course: course })
    .then((r) => (r === null ? { ok: false, saved: false, msg: '云端暂时连不上' } : r));
}

// 删除同学自己误加的课程（只能删自己加的，官方课删不了）
// 注意不能像其他接口那样「调不通就当成功」：删除是破坏性操作，
// 谎报成功会让云端那条永远留着，下次同步又冒出来（「删了重进还在」）。
// 拿不到结果就如实说没删掉，由调用方决定怎么提示。
function courseRemove(id, name) {
  return call('courseRemove', { id: id || '', name: name || '' })
    .then((r) => (r === null ? { ok: false, msg: '云端连不上，没能删干净' } : r));
}

/* ---------------- 误加课程 · 申请删除 ---------------- */

// 别人误加的课删不掉，是加课这件事的硬伤：加的人毕业了，这门课就永远挂在库里。
// 现在是「申请」制：谁都能投一票，凑够票数（或审核员出手）自动清掉。
// 同样不能谎报成功 —— 删不掉就是删不掉。
// courseName 一定要带上：早先云端存的课没有 id，前端那个 id 在云端对不上号，
// 只给 id 会让云函数认不出这门课、永远删不掉（误加的课就那么挂着）
function courseReqVote(courseId, reason, courseName) {
  return call('courseReqVote', {
    courseId: courseId || '', reason: reason || '', name: courseName || ''
  }).then((r) => (r === null ? { ok: false, saved: false, msg: '云端连不上，没能提交申请' } : r));
}

// 这门课上现在有几票、我投过没有。详情页要靠它决定按钮显示成什么样
function courseReqInfo(courseId, courseName) {
  return call('courseReqInfo', { courseId: courseId || '', name: courseName || '' })
    .then((r) => r || { ok: true, votes: 0, need: 3, mine: false });
}

// 纠正一门课的类型（体育课 / 思政课这些靠课名猜的，猜错了由同学改）。
// 云端 course_types 集合按课程 id 存一份，全校共享
function courseTypeSet(courseId, ctype) {
  return call('courseTypeSet', { id: courseId || '', ctype: ctype || '' })
    .then((r) => r || { ok: false, saved: false, msg: '云端连不上，先记在你手机上' });
}

// 拉全校的课程类型纠正表：{ 课程id: 类型 }。进课程页时合并进本机
function courseTypeList() {
  return call('courseTypeList', {}).then((r) => r || { ok: false, fixes: null });
}

// 赞 / 踩：kind 传 'like'（默认）或 'dislike'，再点一次同一个就是取消
function likeToggle(postId) {
  return call('likeToggle', { postId: postId }).then((r) => (r === null ? { ok: false, msg: '云端没响应，点赞没生效' } : r));
}

function voteToggle(postId, kind) {
  return call('likeToggle', { postId: postId, kind: kind === 'dislike' ? 'dislike' : 'like' })
    // 超时/断网不能伪装成“成功且归零”：上层会据此把本地状态和计数改坏。
    .then((r) => (r === null ? { ok: false, offline: true, msg: '云端没响应，点赞稍后再试' } : r));
}

// 树洞三连（抱抱 / 递茶 / 摸摸头）：on 为 true 是给，false 是收回。
// 云函数那边用同一张记名表做唯一约束，连点也只落一份
function holeReact(postId, kind, on) {
  return call('holeReact', {
    postId: postId,
    kind: kind === 'tea' ? 'tea' : (kind === 'pat' ? 'pat' : 'hug'),
    on: on !== false
  }).then((r) => (r === null ? null : r));
}

// 天气：走云函数中转。体验版/正式版会校验 request 合法域名，
// 前端直连第三方接口会被拦，云函数不受这个限制
function weather() {
  return call('weather', {}).then((r) => (r === null ? null : r));
}

// 置顶 / 取消置顶（只有审核员能操作，云端会再验一次身份）
// until：置顶截止的毫秒时间戳，0 或不传 = 永久。
// 传时间戳而不是「几天」——天数换算放在页面里做，云端只认一个绝对时间，
// 这样「一天」到底算 24 小时还是算到今晚 24 点，由产品决定，不用改云函数
function postPin(postId, pin, until) {
  return call('postPin', {
    postId: postId,
    pin: pin !== false,
    until: Number(until) > 0 ? Number(until) : 0
  }).then((r) => r || { ok: false, msg: '云函数没响应' });
}

// 内容保护：被保护的帖子 / 留言不会被举报自动下架（人工审核照样能处理）
function postPinOrder(ids) {
  return call('postPinOrder', { ids: Array.isArray(ids) ? ids : [] })
    .then((r) => r || { ok: false, msg: '云函数没响应' });
}

function protectSet(targetType, targetId, on, reason) {
  return call('protectSet', {
    targetType: targetType === 'comment' ? 'comment' : 'post',
    targetId: String(targetId || ''),
    on: on !== false,
    reason: String(reason || '')
  }).then((r) => r || { ok: false, msg: '云函数没响应' });
}

function protectList() {
  return call('protectList', {}).then((r) => r || { ok: false, list: [] });
}

function protectInfo(targetType, targetId) {
  return call('protectInfo', {
    targetType: targetType === 'comment' ? 'comment' : 'post',
    targetId: String(targetId || '')
  }).then((r) => r || { ok: false, protected: false });
}

// 运行配置：订阅消息模板 ID + 当前置顶列表
function cfgGet() {
  return call('cfgGet', {}).then((r) => r || null);
}

// 保存订阅消息模板 ID（审核员在小程序「审核」页里直接填，不用再进控制台）
function cfgSave(submsg) {
  return call('cfgSave', { submsg: submsg || {} })
    .then((r) => r || { ok: false, msg: '云函数没响应' });
}

// 保存屏蔽词增补表。内置那份词表永远在，这里加的是**追加**的那部分 ——
// 所以把自配词删光不会造成裸奔，只是回到内置词表
function cfgSaveWords(words) {
  return call('cfgSave', { words: Array.isArray(words) ? words : [] })
    .then((r) => r || { ok: false, msg: '云函数没响应' });
}

// 评论走云函数：服务端过审 + 给作者推订阅消息。
// images 是已经上传好的云存储 fileID 数组（最多 3 张，白名单在云函数侧校验）。
//
// 「云端是旧版云函数」的识别和私信发图是同一个坑（那时 chatSend 不认识 images，
// 只看得到 text 为空，回一句「内容不能为空」）：纯图评论会被旧版 postComment
// 以同样的理由打回。这里翻译成人话，别让用户对着它反复点发送
const COMMENT_DEPLOY_MSG = '图片没发出去：云函数是旧版，需重新部署';

function postComment(postId, content, images, reply, id) {
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];
  const hasText = !!String(content || '').trim();
  // 回复：parentId 指「挂在谁下面」，replyTo* 指「回复的是谁」。
  // 两者在层级被折叠（三级折回二级）时不再同指一条，所以要分开传
  const rep = reply || {};
  return call('postComment', {
    postId: postId,
    id: String(id || ''),
    content: content,
    images: imgs,
    parentId: String(rep.parentId || ''),
    replyToOpenid: String(rep.replyToOpenid || ''),
    replyToAuthor: String(rep.replyToAuthor || '').slice(0, 20),
    author: getMyProfile().nickName || '浙小商',
    // 留言卡片要显示头像。服务端只认 avatars/ 目录下的云文件，
    // 传本机路径 / 站外链接都会被丢成空串（前端自动退回文字头像）
    avatarUrl: getMyProfile().avatarUrl || ''
  })
    .then((r) => (r === null ? { ok: false, saved: false, local: true, msg: '云端没响应，评论先留在本机' } : r))
    .then((r) => {
      // 纯图评论 + 旧版云函数：它把「没有文字」当成「空内容」打回来。
      // 有文字的评论不判 —— 那种情况下「说点什么再发吧」是真话
      if (r && r.ok === false && imgs.length && !hasText
          && String(r.msg || '').indexOf('说点什么') >= 0) {
        return Object.assign({}, r, { msg: COMMENT_DEPLOY_MSG, needDeploy: true });
      }
      // 图文评论「成功」了，但图被旧版悄悄吞掉：用户以为图送到了，别人只看到半句。
      // 判据用回执里那份 comment.images —— 新版一定会带回来（哪怕是空数组）
      if (r && r.ok !== false && imgs.length && r.comment
          && !Array.isArray(r.comment.images)) {
        return Object.assign({}, r, { warn: COMMENT_DEPLOY_MSG, needDeploy: true });
      }
      return r;
    });
}

/* ---------------- 留言（拆表后按需拉取） ---------------- */

// 拉一条内容下的留言。
//
// 留言已经从帖子文档里拆出去了，详情页必须在打开时自己拉一次。
// 返回 null（而不是 []）表示这次没拉到：断网、云函数还是旧版、查询失败。
// 调用方必须把「空评论区」和「没拉到」分开处理 —— 这两种在界面上长得
// 一模一样，但一个该显示「还没有评论」，另一个该说「网络不太顺」，
// 把后者当成前者就是在告诉用户一件我们并不知道的事
function commentList(postId) {
  return call('commentList', { postId: postId }).then((r) => (r || null));
}

// 申诉：先取原文与当前状态（还能不能申诉、申诉过没有），再提交
function commentAppealInfo(postId, commentId) {
  return call('commentAppealInfo', { postId: postId, commentId: commentId })
    .then((r) => r || { ok: false, msg: '云端没响应' });
}

function commentAppeal(commentId, reason) {
  return call('commentAppeal', { commentId: commentId, reason: reason })
    .then((r) => r || { ok: false, msg: '云端没响应' });
}

// 审核员：待处理申诉列表 / 恢复一条被删的留言
function appealQueue() {
  return call('appealQueue', {}).then((r) => r || { ok: false, list: [] });
}

function commentRestore(commentId) {
  return call('commentRestore', { commentId: commentId })
    .then((r) => r || { ok: false, msg: '云端没响应' });
}

/* ---------------- 学习资料 ---------------- */

function resourceList(params) {
  return call('resourceList', params || {}).then((r) => (r && r.list) || []);
}

function resourceAdd(resource) {
  return call('resourceAdd', { resource: resource })
    .then((r) => (r === null ? { ok: false, saved: false, msg: '云端没响应，资料没发布' } : r));
}

// 审核员资料队列：只返回 pending，非审核员会被云函数拒绝
function resourceQueue() {
  return call('resourceQueue', {})
    .then((r) => r || { ok: false, list: [], msg: '云函数没响应' });
}

// 资料审核：decision = 'approve' | 'reject'，reject 必须带原因
function resourceReview(id, decision, reason) {
  return call('resourceReview', {
    id: id,
    decision: decision,
    reason: reason || ''
  }).then((r) => (r === null ? { ok: false, msg: '云端没响应，审核没生效' } : r));
}
function resourceUrl(id) {
  return call('resourceUrl', { id: id }).then((r) => r || { ok: false, msg: '云函数没响应' });
}

function resourceThanks(id) {
  return call('resourceThanks', { id: id })
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，没记上' } : r));
}

function resourceRemove(id) {
  return call('resourceRemove', { id: id }).then((r) => r || { ok: false, msg: '云函数没响应' });
}

/* ---------------- 校园活动 · 官网同步 ---------------- */

// 从学校官网抓最新公告当作官方活动。同步是幂等的，点多少次都不会变多。
function eventSync() {
  return call('eventSyncFromWeb', {}).then((r) => (r === null ? { ok: false, msg: '云端连不上，同步失败' } : r));
}

/* ---------------- 教师名录 ---------------- */

// 名录有两个来源：官网各学院师资页抓取（official:true）+ 同学自己补（official:false）。
// 搜索是服务端的字符串包含匹配，keyword 可以只打一个字。
function teacherList(keyword, college) {
  return call('teacherList', { keyword: keyword || '', college: college || '' })
    .then((r) => (r && r.list) || []);
}

// 只要名字的轻量版。名录 1500+ 人之后，整份文档传回前端太重，
// 而课程列表页要用它做的只是「这位老师有没有被评价过」的并集，名字就够了
function teacherNames() {
  return call('teacherNames', {}).then((r) => (r && r.names) || []);
}

function teacherAdd(name, college) {
  return call('teacherAdd', { name: name || '', college: college || '' })
    .then((r) => (r === null ? { ok: false, msg: '云端连不上，没存住' } : r));
}

function teacherRemove(id) {
  return call('teacherRemove', { id: id })
    .then((r) => (r === null ? { ok: false, msg: '云端连不上，没删掉' } : r));
}

// 老师本人投诉到邮箱、核实之后，把这位老师名下的评价一次性下架。
// 只下架、不删除：留着原文，撤回与申诉才有得可查
function teacherHideReviews(name, reason) {
  return call('teacherHideReviews', { name: name, reason: reason })
    .then((r) => (r === null ? { ok: false, msg: '云端连不上，没下架' } : r));
}

/* ---------------- 校历 ---------------- */

function calendarList() {
  return call('calendarList', {}).then((r) => (r && r.list) || []);
}

function calendarSave(item) {
  return call('calendarSave', { item: item }).then((r) => r || { ok: false, msg: '云函数没响应' });
}

function calendarRemove(id) {
  return call('calendarRemove', { id: id }).then((r) => r || { ok: false, msg: '云函数没响应' });
}

// 一键导入教务处官方校历（审核员操作，会清掉旧节点重新灌入）
function calendarReset() {
  return call('calendarReset', {}).then((r) => r || { ok: false, msg: '云函数没响应' });
}

/* ---------------- 校园地点 ---------------- */

function placeList(category, keyword) {
  return call('placeList', { category: category || '', keyword: keyword || '' })
    .then((r) => (r && r.list) || []);
}

function placeAdd(place) {
  return call('placeAdd', { place: place }).then((r) => r || { ok: false, msg: '云函数没响应' });
}

function placeRemove(id) {
  return call('placeRemove', { id: id }).then((r) => r || { ok: false, msg: '云函数没响应' });
}

/* ---------------- 备忘录 ---------------- */

// 备忘录是纯私人的：服务端一律按 openid 过滤，别人翻不到。
// 云函数不可用时全部 resolve(null)，调用方按空列表处理，功能不中断。
function memoList() {
  return call('memoList', {}).then((r) => (r && r.ok === false) ? r : { ok: true, list: (r && Array.isArray(r.list)) ? r.list : [] });
}

function memoSave(item) {
  return call('memoSave', { item: item || {} })
    .then((r) => r || { ok: false, msg: '云函数没响应' });
}

function memoRemove(id) {
  return call('memoRemove', { id: id })
    .then((r) => r || { ok: false, msg: '云函数没响应' });
}

/* ---------------- 举报 ---------------- */

// 记一次浏览。返回这条内容现在有几个人看过（去重后的人数）。
//
// 为什么要走云端而不是本地加一：浏览人数是举报下架门槛的分母（见云函数
// report-rules.js 的分档表）。谁能随便改分母，谁就能让自己的帖子
// 永远达不到下架线。所以计数放在服务端，同一个人只算一次。
//
// 失败一律静默：记浏览失败不该影响「看内容」这件事本身
function contentView(targetType, targetId) {
  return call('contentView', {
    targetType: targetType || 'post',
    targetId: targetId || ''
  }).then((r) => (r && r.ok !== false ? r : { ok: false, views: 0 }))
    .catch(() => ({ ok: false, views: 0 }));
}

function reportPost(targetOpenid, reason, detail, targetId, targetType) {
  return call('report', {
    targetOpenid: targetOpenid,
    reason: reason,
    detail: detail || '',
    targetId: targetId || '',
    targetType: targetType || 'post'
  }).then((r) => (r === null
    // 断网时云端一条记录都没写。谎报「已提交」会让用户以为这条进了队列、
    // 之后什么也没发生；而服务端恰恰是靠「多人举报凑够数」才自动处置的 ——
    // 他以为算上自己这一票了
    ? { ok: false, degraded: true, msg: '云端没响应，举报可能没提交到' }
    : r));
}

// 举报一条留言（信息墙上别人留的群号那类）。
// 走的是另一条通道：留言不是一条独立内容，而是长在帖子里的，
// 所以这里要连帖子 id 一起带上，云函数才知道该改哪条帖子的哪一条留言。
// 服务端当场就判定要不要删，凑够人数不用运营同学亲手去点。
function reportComment(postId, commentId, reason, detail) {
  return call('commentReport', {
    postId: postId,
    commentId: commentId,
    reason: reason,
    detail: (detail || '').slice(0, 200)
  }).then((r) => (r ? r : { ok: false, degraded: true, msg: '云端没响应，举报可能没提交到' }));
}

// 给一条留言点赞 / 点踩。
//
// 为什么不直接改本地那份 comments 就完事：留言长在帖子文档里，
// 客户端直连改数组既能绕过记名（一个人能刷出一百个赞），也没有权威计数。
// 服务端数人头给出计数，本地只是乐观地先把这一下显示出来。
//
// kind 传 'like' / 'dislike'，再点一次同一个就是取消 —— 服务端按「一个人一格」
// 存态度，所以互斥和取消都是幂等的，连点不会把数字点歪。
function commentVote(postId, commentId, kind) {
  return call('commentVote', {
    postId: postId,
    commentId: commentId,
    kind: kind === 'dislike' ? 'dislike' : 'like'
  }).then((r) => (r === null
    // 断网 / 云函数没响应：本机那一下已经生效了，只是没同步上去。
    // 如实说「没同步」而不是「失败」—— 用户看到的是本机已经变了的样子
    ? { ok: false, offline: true, msg: '网络不太顺，这一下还没记到云端' }
    : r));
}

// 举报一个人（私信骚扰 / 冒名顶替）。
//
// 和举报内容的根本差别：**不会触发任何自动处置**。
// 内容能被三个不相干的人同时看错，概率不高；「人」被举报则完全可能来自
// 同一起私人矛盾（室友、分手、社团恩怨），自动封号会当场酿成事故。
// 所以云端只做三件事：留证据、累计人数、把该看的推给审核员。
// targetType 传 'chat'（私信页）或 'profile'（名片页）
function reportPerson(targetOpenid, targetType, reason, detail) {
  return call('report', {
    targetOpenid: targetOpenid,
    targetType: targetType === 'chat' ? 'chat' : 'profile',
    reason: reason || '恶意骚扰',
    detail: detail || ''
  }).then((r) => (r === null
    // degraded 而不是 ok:true —— 断网时云端什么都没收到。
    // 举报「人」是用户在校验别人、期待有人来处理的严肃动作，
    // 谎报「已提交」比报错糟得多：他会等着看对方被处置，然后发现什么都没有
    ? { ok: false, degraded: true, msg: '云端没响应，举报可能没提交到' }
    : r));
}

/* ---------------- 账号与数据（注销） ---------------- */

// 注销状态：页面据此显示「还有 N 天」和撤销按钮
function accountState() {
  return call('accountState', {}).then((r) => r || { ok: true, pending: false });
}

// 提交注销。7 天冷静期，期间随时可以撤销。
// ⚠️ 云端不可用时**绝不**返回成功 —— 谎报「已提交注销」而云端什么都没有，
// 用户 7 天后回来发现号还在，而那时已经无从追查
function accountCancel(reason) {
  return call('accountCancel', { confirm: true, reason: reason || '' })
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，没能提交' } : r));
}

function accountCancelUndo() {
  return call('accountCancelUndo', {})
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，没能撤销' } : r));
}

/* ---------------- 站内通知中心 ---------------- */

// 站内通知：订阅消息是一次性的（用户授权一次只能推一条），断了就只能靠红点。
// 通知中心承接的正是「订阅消息发不出去」的那部分。
// degraded 为真表示**查询失败**而不是「真的没有通知」—— 两者必须分得开，
// 否则用户会把「读不到」当成「没人理我」
function notifyList(limit, skip) {
  return call('notifyList', { limit: limit || 20, skip: Math.max(0, Number(skip) || 0) })
    .then((r) => (r === null
      ? { ok: false, list: [], unread: 0, degraded: true }
      : r));
}

function notifyRead(id) {
  return call('notifyRead', { id: id || '' }).then((r) => r || { ok: true });
}

// 打开自己的帖子时，把这条帖子相关的回复通知一起标已读
function notifyReadByTarget(targetId) {
  return call('notifyRead', { targetId: targetId || '' }).then((r) => r || { ok: true });
}

/* ---------------- 审核操作日志（管理员） ---------------- */

// 谁封了号、谁删了内容、谁置顶了 —— 多审核员协作时，没有这面镜子就查不回任何事。
// 只读：能改的日志等于没有日志
function modLogs(limit) {
  return call('modLogs', { limit: limit || 50 }).then((r) => r || { ok: false, list: [] });
}

/* ---------------- 客户端错误上报 ---------------- */

// 真机上没人会去看 console，所以失败分支光写日志等于没写。
// 这里往 errors 集合塞一条，排查时至少有一处能对上。
// 它本身永远不抛、也永远不影响调用方 —— 上报失败的代价不该由用户承担
function reportError(scope, msg, extra) {
  return call('reportError', {
    scope: String(scope || '').slice(0, 40),
    msg: String(msg || '').slice(0, 200),
    extra: extra || {}
  }).then((r) => r || { ok: true }, () => ({ ok: true }));
}

/* ---------------- 内容审核（管理员） ---------------- */

// 白名单判断只是前端展示用，云函数那边还有一份真校验
function isModerator(profile) {
  const list = (cloud.cfg.MODERATORS) || [];
  const oid = (profile && profile.openid) || getMyProfile().openid || cloud.getOpenid() || '';
  return !!oid && Array.isArray(list) && list.indexOf(oid) >= 0;
}

function whoami() {
  return call('whoami', {}).then((r) => r || null);
}

// 注意：这里曾经有「一键把我设为审核员」，上线后等于给每个用户一把删全校内容的钥匙，
// 已经拿掉。审核员名单统一走云函数环境变量 MODERATORS。

// 环境自检：返回还没建的数据库集合，页面好把引导直接显示出来
function diagCloud() {
  return call('diag', {}).then((r) => (r === null ? { ok: false, missing: [] } : r));
}

// 待处理队列：举报 + 它对应的内容
// 返回的 list 已经**按内容合并**过：同一条内容被 3 个人举报是一行，
// 带 repIds（这一行的全部举报）、reportCount（有多少人）、
// views（几个人看过）、hideAt（这条内容的门槛人数）、needMore（还差几个人）。
// 门槛按浏览量分档，不是固定常数 —— 所以前端也不要自己写死一个 3
// 合并口径在云函数 report-votes.js，前端不要自己再分一次组
function getModerationQueue() {
  return call('getQueue', {}).then((r) => r || { ok: false, list: [] });
}

// 已处置归档（确认 / 驳回之后回看）。scope: 'confirmed' | 'rejected' | '' 全部
function reportArchive(scope) {
  return call('reportArchive', { scope: scope || '' })
    .then((r) => r || { ok: false, list: [] });
}

// 批量裁决：reject=证据不足驳回（顺带恢复内容），confirm=违规成立
function resolveReports(ids, action, all) {
  return call('resolveReports', { ids: ids, decision: action, all: !!all })
    .then((r) => (r === null ? { ok: false, msg: '云函数没响应' } : r));
}

// 审核员 / 作者本人 手动下架或恢复一条内容。
// ⚠️ 这里尤其不能谎报成功：审核动作的后果是「这条内容全校看不到了」，
// 断网时云端什么都没改，界面却显示「已下架」，等管理员回来发现内容还在，
// 会以为出了别的 bug，而真正的原因（当时断网）已经无从查证
function setContentStatus(targetId, status, targetType) {
  return call('setStatus', { targetId: targetId, status: status, targetType: targetType || 'post' })
    .then((r) => (r === null ? { ok: false, degraded: true, msg: '云端没响应，没能提交' } : r));
}

// 删除一条内容（帖子或评价）：必须走云函数，客户端直连数据库删不掉别人的/示例的记录
function delContent(targetType, id) {
  return call('delContent', { targetType: targetType, id: id })
    .then((r) => r || { ok: false, msg: '云函数没响应' });
}

// 更新一条内容的允许字段（点赞计数 / 评论 / 评价内容等）
function patchContent(targetType, id, patch) {
  return call('patchContent', { targetType: targetType, id: id, patch: patch })
    .then((r) => r || { ok: false });
}

// 编辑自己发的帖子。改完云端会重新过一遍审核（屏蔽词 + 官方接口）。
// 为什么必须重新过审：先发一条干净的、攒够赞和评论，再把它改成广告 ——
// 这是绕过发布审核最省事的办法
function postEdit(id, title, content, images) {
  return call('postEdit', {
    id: id, title: title, content: content, images: images
  }, 10000).then((r) => (r === null ? { ok: false, msg: '云端暂时连不上' } : r));
}

/* ---------------- 账号封禁（管理员） ---------------- */

// 卖片 / 代写这类内容的根子不在某一条帖子上，而在账号本身 ——
// 删帖追不上他再发一条。封禁是账号级的：读还能读，写（发帖 / 评论 / 私信 / 互动）一律拒。
// 真正的门禁在云函数（只有审核员能调用，且审核员之间不能互封），这里只是前端入口。
function banUser(openid, reason) {
  return call('banUser', { openid: openid, reason: reason || '' })
    .then((r) => (r === null ? { ok: false, msg: '云函数没响应，封禁未生效' } : r));
}

function unbanUser(openid) {
  return call('unbanUser', { openid: openid })
    .then((r) => (r === null ? { ok: false, msg: '云函数没响应，解除未生效' } : r));
}

// 封禁名册：现在封了谁、为什么封、什么时候封的
function banList() {
  return call('banList', {})
    .then((r) => r || { ok: false, list: [], msg: '云函数没响应' });
}

// 删掉一条留言。信息墙上留错了群号、群里有人塞广告，都得有人能清掉 ——
// 帖主是唯一有动力维护那面墙的人，所以先给他；审核员兜底。
// 服务端会再认一遍权限，这里传什么进去都改不了判定结果。
function removeComment(postId, commentId) {
  return call('commentRemove', { postId: postId, commentId: commentId })
    .then((r) => r || { ok: false, msg: '云函数没响应' });
}

/* ---------------- 内容安全 ---------------- */

// 服务端权威校验：前端已有本地词表做即时提示，这里再过一遍，防绕过
function checkText(fields) {
  const payload = {};
  ['title', 'content'].forEach((k) => {
    if (fields && fields[k]) payload[k] = fields[k];
  });
  if (!Object.keys(payload).length) return Promise.resolve({ ok: true });
  // 预检只是「提前打招呼」，慢了不如直接放行（真正的拦截在 postAdd 服务端）。
  // 单独 5s：避免弱网下预检本身拖满全局 12s，把「发布中」拉到总闸边缘
  return call('checkText', payload, 5000).then((r) => {
    // 预检只是「提前打招呼」，真正的拦截在 postAdd/reviewAdd 服务端那道 guard，
    // 这里放行并不等于违规内容能进库。
    // 只有云端明确判定内容违规才拦；云函数版本太老不认识 checkText（返回「未知操作」）
    // 时必须放行 —— 否则旧版云函数会把所有发帖/评价卡死在预检这一步，
    // 表现就是「闲置能发、论坛和评价全都发不出去」（闲置不走这道预检）。
    if (r && r.ok === false && String(r.msg || '').indexOf('未知操作') < 0) return r;
    return { ok: true };
  });
}

module.exports = {
  CONTACT_LABEL,
  initUser,
  getMyProfile,
  saveProfile,
  getProfile,
  postsByAuthor,
  search,
  addRequest,
  respond,
  friendAccept,
  friendReject,
  removeFriend,
  friendCancel,
  friendAlias,
  listRequests,
  listOutgoing,
  listFriends,
  cachedFriends,
  listFriendsPaged,
  isFriend,
  // 账号与数据：注销（7 天冷静期，期间可撤销）
  accountState,
  accountCancel,
  accountCancelUndo,
  // 站内通知中心（订阅消息是一次性的，断了就靠它兜底）
  notifyList,
  notifyRead,
  notifyReadByTarget,
  // 审核操作日志（只读，留住「谁封了谁、谁删了什么」）
  modLogs,
  // 客户端错误上报：真机上 console 没人看，写进库才查得到
  reportError,
  block,
  isModerator,
  whoami,
  diagCloud,
  // 云函数统一出口：漂流瓶（utils/bottle.js）走它调云端，不用为每个 action 在这里写一层
  call,
  getModerationQueue,
  reportArchive,
  resolveReports,
  setContentStatus,
  delContent,
  patchContent,
  // 账号封禁（管理员）：卖片这类把账号当广告位的，直接封号而不是删帖
  banUser,
  unbanUser,
  banList,
  removeComment,
  unblock,
  listBlocks,
      reportPost,
      // 记一次浏览：举报下架门槛的分母（一个人只算一次，作者本人不计）
      contentView,
      // 举报留言：一条留言不是独立内容，长在帖子里，所以要连 postId 一起报（见 reportComment 实现）
      reportComment,
      // 举报「人」：私信骚扰 / 冒名顶替，走另一条不自动处置的链路（见 reportPerson）
      reportPerson,
      // 帖子编辑（改完云端重新过审）
      postEdit,
      // 屏蔽词增补表（审核员可配，内置那份词表永远在）
      cfgSaveWords,
      checkText,
      // 内容写入（服务端过审，别给前端留绕过口子）
      postAdd,
      voteCast,
      reviewAdd,
      courseAdd,
      courseRemove,
      courseReqVote,
      courseReqInfo,
      courseTypeSet,
      courseTypeList,
      likeToggle,
      voteToggle,
      holeReact,
      weather,
      postComment,
      // 留言的赞 / 踩：服务端记名 + 数人头，本机只做乐观显示
      commentVote,
      // 留言按需拉取 + 申诉（拆表之后这两条是评论区的另一半）
      commentList,
      commentAppealInfo,
      commentAppeal,
      appealQueue,
      commentRestore,
      // 学习资料
      resourceList,
      resourceAdd,
      resourceQueue,
      resourceReview,
      resourceUrl,
      resourceThanks,
      resourceRemove,
      // 校历
      calendarList,
      calendarSave,
      calendarRemove,
      calendarReset,
      // 置顶与运行配置
      postPin,
      postPinOrder,
      protectSet,
      protectList,
      protectInfo,
      cfgGet,
      cfgSave,
      // 校园地点
      placeList,
      placeAdd,
      placeRemove,
      // 校园活动 · 官网同步
      eventSync,
      // 教师名录
      teacherList,
      teacherNames,
      teacherAdd,
      teacherRemove,
      teacherHideReviews,
      // 备忘录（私有，只自己可见）
      memoList,
      memoSave,
      memoRemove,
    // 收藏（云端存一份，换手机 / 重装还能拿回来）
    saveFavorites,
    getFavorites
  };
