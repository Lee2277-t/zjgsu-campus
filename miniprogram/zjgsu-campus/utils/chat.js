// utils/chat.js —— 同学之间的私信
//
// 设计取舍：
//   没有做 WebSocket 实时推送 —— 校园场景里「发完对方一分钟后看到」足够了，
//   实时通道要配消息服务、要付费、要处理断线重连，对课程作业性价比太低。
//   所以现在是「进入会话时拉一次历史 + 发一句刷新一次」，点击进入就能看到对方的新消息。
const cloud = require('./cloud.js');

// 云函数统一入口在 cloud.js，这里只转发。
// 云函数返回 null 表示「云函数没部署 / 网络断了」，调用方据此决定要不要提示
const call = cloud.callFunction;

// 会话列表：对方昵称 / 头像 / 最后一句 / 未读红点。
//
// 云端返回两段：
//   list     —— 主列表（好友，或我已经回过话的对话）
//   requests —— 「消息请求」：还不是好友、对方先开口、我从来没回过
// 分成两段是为了让陌生人发来的广告不占主列表的第一格 ——
// 混在一起时，用户点开看到的第一条就是广告，而这条会话从此永远挂在最上面。
//
// 分页参数透传：会话多了以后一次拉 50 条不够用，但**两种列表各自分页**，
// 不能共用一个 offset（一段翻完了另一段会跟着跳）
function listPage(params) {
  const p = params || {};
  return call('chatList', {
    limit: p.limit || 50,
    offset: p.offset || 0
  }).then((r) => {
    if (!r) return { list: [], requests: [], hasMore: false, requestHasMore: false, offline: true };
    return {
      list: Array.isArray(r.list) ? r.list : [],
      requests: Array.isArray(r.requests) ? r.requests : [],
      total: Number(r.total) || 0,
      requestTotal: Number(r.requestTotal) || 0,
      hasMore: !!r.hasMore,
      requestHasMore: !!r.requestHasMore,
      // 查询失败与「真的没有会话」必须分得开：都回空列表的话，
      // 用户会以为自己的聊天记录被清空了
      degraded: !!r.degraded
    };
  });
}

// 兼容旧调用点：只要主列表
function list() {
  return listPage({}).then((r) => r.list);
}

// 云端还在跑旧版 user 云函数（没重新部署）时统一说这一句。
// 说清楚「该去做什么」，比让用户对着「内容不能为空」反复重试有用得多。
// 长度压在 30 字以内 —— 超了会被反馈层截断成省略号，最关键的信息反而丢了
// （具体部署哪个云函数、怎么部署，写在 README 的部署章节里）
const DEPLOY_MSG = '图片没发出去：云函数是旧版，需重新部署';

// 发一条消息：文字和图片至少有一个。返回 null 时不代表失败，
// 可能是云函数没部署，前端按「本地已发出」处理（这条消息会标上 localOnly 保住）
function send(to, text, images) {
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];
  const hasText = !!String(text || '').trim();
  return call('chatSend', { to: to, text: text, images: imgs })
    .then((r) => (r === null ? { ok: false, saved: false, local: true, msg: '云端没响应，消息只在本机' } : (r || { ok: false, msg: '发送失败' })))
    .then((r) => {
      if (!imgs.length || !r) return r;

      // 情况一：纯图消息被旧版拒了。旧 chatSend 不认识 images 字段，
      // 只看得到 text 为空，于是回一句「内容不能为空」—— 现象上完全像前端 bug
      if (r.ok === false && !hasText && String(r.msg || '') === '内容不能为空') {
        return Object.assign({}, r, { msg: DEPLOY_MSG, needDeploy: true });
      }

      // 情况二：图文消息「成功」了，但图被旧版悄悄丢掉，用户以为发出去了、
      // 对方只收到半句。判据用服务端回执里那份 images ——
      // 新版一定会把它带回来（哪怕是空数组），旧版连字段都没有
      if (r.ok !== false && r.msg && !Array.isArray(r.msg.images)) {
        return Object.assign({}, r, { warn: DEPLOY_MSG, needDeploy: true });
      }
      return r;
    });
}

// 聊天记录 + 对方资料；打开会话时顺手把未读清掉。
// after 传上一次拿到的最后一条消息时间戳时只回增量 —— 会话页的轮询走这条路径，
// 每次搬 200 条历史是纯浪费，而校园网下这几百 KB 恰好就是「刷新有点卡」那一下
function history(peer, after) {
  return call('chatHistory', { peer: peer, after: Number(after) || 0 })
    .then((r) => {
      if (!(r && Array.isArray(r.messages))) {
        return { messages: [], peer: { openid: peer, nickName: '' } };
      }
      // images 统一补成数组。老消息没有这个字段，而 WXML 里要写 item.images.length，
      // 拿到 undefined 会让整段图片区渲染不出来（甚至报错）
      r.messages = r.messages.map((m) => Object.assign({}, m, {
        images: Array.isArray(m.images) ? m.images : []
      }));
      return r;
    });
}

// 接受一条消息请求：把这个人放进收件箱。
// 刻意不顺手加好友 —— 「我愿意收你的消息」和「我们交换联系方式」是两件不同的事，
// 混在一起做，用户按下按钮时并不知道自己还答应了什么
function accept(peer) {
  return call('chatAccept', { peer: peer }).then((r) => r || { ok: false, msg: '云端没响应，没能接下消息' });
}

// 把一条请求扔进垃圾桶。会话不删、记录还在，对方再发一条就会重新回来 ——
// 这是刻意的：一个直接的「永久屏蔽」会让用户在气头上把以后真想联系的人一起扔掉，
// 而这个决定没有反悔路径。真要彻底断掉，正确的动作是拉黑
function dismiss(peer) {
  return call('chatDismiss', { peer: peer }).then((r) => r || { ok: false, msg: '云端没响应，没能移出请求箱' });
}

// 撤回（2 分钟内，服务端判定）。失败时如实返回原因，
// 绝不本地先抹掉 —— 本地抹掉而云端还在，对方看得到、我看不到，
// 是最容易让人怀疑「我是不是记错了」的一种状态
function recall(peer, msgId) {
  return call('chatRecall', { peer: peer, msgId: msgId })
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，再试一次' } : r));
}

// 删除会话（只删我这一侧）。对方那份记录保留 ——
// 单方面抹掉会造成「同一段对话两个人看到的不一样」，
// 而且被骚扰的人需要留着证据去举报
function remove(peer) {
  return call('chatRemove', { peer: peer })
    .then((r) => (r === null ? { ok: false, msg: '云端没响应，再试一次' } : r));
}

module.exports = { list, listPage, send, history, accept, dismiss, recall, remove };
