/* 好友功能第二版 —— 行为测试
 *
 * 覆盖这一轮的三个需求：
 *   ① 加好友不做独立入口（动作在 utils/friend.js，落点嵌进已有页面/流程）
 *   ② 解除好友（云函数 removeFriend + 前端 remove）
 *   ③ 非好友双方各 3 条、加为好友后不限（不再有「对方回过就放宽到 20 条」那一档）
 *
 * 原则跟这个项目一贯一样：**不另抄一份逻辑**。全部从真实源码里抠出来跑：
 *   A. 云函数 chatQuota        —— 花括号配平抽出（db 打桩，含查库失败降级分支）
 *   B. 云函数 chatSend 闸门     —— 位置与形状断言（防「闸门被挪到写库之后」这类回归）
 *   C. 云函数 removeFriend     —— 三个落点是否都做到 + 路由 + 幂等 + 失败不谎报
 *   D. 云函数 addRequest       —— 「解除之后还能加回来」这条链真的成立（关键回归）
 *   E. 前端纯函数              —— chat.js 的 quotaText / sendAllowed / lockText
 *   F. utils/friend.js         —— 弹窗交互（取消不发请求、留言 50 字、回执如实转发）
 *   G. 页面事件                —— Page() 捕获 + 假 this
 *   H. 常量/版本/模板一致性     —— 四处条数一致、BUILD 与 CLOUD_BUILD 一致、死控件已清
 *
 * 用法：node scripts/test-friend-v2.cjs
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');
const SRC = path.join(PROJ, 'cloudfunctions', 'user', 'index.js');
const readCloudSource = require('./cloud-source.cjs');
const src = readCloudSource();
const readProj = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8');
const userApiText = readProj('utils/user.js');

// 仓库根 package.json 是 type:module，Node 22 会把小程序 .js 当 ESM —— 强制回 CommonJS
// ⚠️ 前缀要用 path.resolve 过的原生路径比：Windows 下 Node 给的是反斜杠，
//    拿正斜杠前缀去 indexOf 永远 -1，hook 形同虚设
const origJs = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (norm(filename).startsWith(norm(PROJ))) return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return origJs(mod, filename);
};

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra))); }
};

/* ---------- 花括号配平抽函数（跳过字符串 / 模板串） ---------- */
function sliceFn(text, name) {
  const re = new RegExp('(^|\\n)(?:async\\s+)?function ' + name + '\\s*\\(');
  const m = re.exec(text);
  if (!m) throw new Error('找不到函数 ' + name);
  let j = text.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (; j < text.length; j += 1) {
    const c = text[j];
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
    else if (c === "'" || c === '"' || c === '`') {
      const q = c; j += 1;
      while (j < text.length && text[j] !== q) { if (text[j] === '\\') j += 1; j += 1; }
    }
  }
  return text.slice(m.index, j);
}

const BE_QUOTA = Number((src.match(/const STRANGER_QUOTA = (\d+);/) || [])[1]);
if (!BE_QUOTA) throw new Error('没抽到 STRANGER_QUOTA 常量');
const QUOTA_CONST = 'const STRANGER_QUOTA = ' + BE_QUOTA + ';';

const ME = 'me_openid';
const PEER = 'peer_openid';
const from = (who, n, at) => Array.from({ length: n }, (_, i) => ({
  id: 'm' + i, from: who, text: 'x', at: at === undefined ? 1000 + i : at
}));

/* ============ A. 云函数 chatQuota ============ */
console.log('\nA. 云函数 chatQuota（非好友双方各 ' + BE_QUOTA + ' 条 / 好友不限）');

// msgs === null 表示这段对话压根没有文档；relFails 模拟「查好友关系时数据库抽风」；
// resetAt 模拟「解除过好友」盖在会话上的额度水位
function quotaDb(msgs, isFriend, relFails, resetAt) {
  const rows = msgs === null ? [] : [{ _id: 'chat1', messages: msgs, quotaResetAt: resetAt }];
  return {
    collection: (name) => ({
      where: () => ({
        limit: () => ({
          get: () => {
            if (name === 'friends') {
              return relFails ? Promise.reject(new Error('db down'))
                : Promise.resolve({ data: isFriend ? [{ _id: 'f1' }] : [] });
            }
            return Promise.resolve({ data: rows });
          }
        })
      })
    })
  };
}

function mkQuota(msgs, isFriend, relFails, resetAt) {
  return new Function('db', 'COL_CHATS', 'COL_FRIENDS',
    QUOTA_CONST + '\n' + sliceFn(src, 'chatKey') + '\n' + sliceFn(src, 'chatQuota') + '\n'
    + 'return { chatKey: chatKey, chatQuota: chatQuota };'
  )(quotaDb(msgs, isFriend, relFails, resetAt), 'chats', 'friends');
}

(async () => {
  let q = await mkQuota(from(ME, 50), true).chatQuota(ME, PEER);
  ok('已经是好友：isFriend 为真', q.isFriend === true);
  ok('好友没有上限（limit/left 都是 0，前端据此不显示任何剩余提示）', q.limit === 0 && q.left === 0);

  // 最关键的一条兜底：好友关系查不到结果时必须放行，不能猜成陌生人
  q = await mkQuota(from(ME, 300), false, true).chatQuota(ME, PEER);
  ok('查好友关系失败 → 按好友放行（否则一对聊了三百句的老同学会被当场锁死，还看不出原因）',
    q.isFriend === true && q.degraded === true, q);
  ok('查库失败时不会给出「还剩 0 条」这种会锁死输入框的值', q.left === 0 && q.isFriend === true);

  q = await mkQuota(null, false).chatQuota(ME, PEER);
  ok('陌生人、还没聊过：limit = ' + BE_QUOTA, q.limit === BE_QUOTA);
  ok('左额 = 满额', q.left === BE_QUOTA && q.used === 0);
  ok('peerUsed 初始为 0，replied 为 false', q.peerUsed === 0 && q.replied === false);
  ok('isFriend 为假', q.isFriend === false);

  q = await mkQuota(from(ME, 2), false).chatQuota(ME, PEER);
  ok('我发了 2 条：left = 1', q.left === 1, q);

  q = await mkQuota(from(ME, 3), false).chatQuota(ME, PEER);
  ok('我发满 3 条：left = 0', q.left === 0);

  q = await mkQuota(from(ME, 7), false).chatQuota(ME, PEER);
  ok('超发时 left 夹到 0，不会变成负数（负数会让前端显示「还能发 -4 条」）', q.left === 0);

  // 核心：计数按方向，对方发的不吃我的额度
  q = await mkQuota(from(PEER, 3), false).chatQuota(ME, PEER);
  ok('对方发的消息不消耗我的额度', q.used === 0 && q.peerUsed === 3, q);
  ok('对方开口过 → replied 为真（只用于文案，不影响上限）', q.replied === true);
  ok('★★ 对方开口过，上限**仍然是** ' + BE_QUOTA + '（这是本轮改掉的那一档：以前会放宽到 20）',
    q.limit === BE_QUOTA, q);
  ok('★★ 对方回过之后我照样只有 ' + BE_QUOTA + ' 条，left 就是满额', q.left === BE_QUOTA);

  // 反向验一次「以前那一档真的没了」：源码里不该再出现 20 条那档放宽
  ok('源码里不再有 STRANGER_QUOTA_REPLIED 这种第二档上限',
    src.indexOf('STRANGER_QUOTA_REPLIED') < 0);

  q = await mkQuota(from(PEER, 4).concat(from(ME, BE_QUOTA)), false).chatQuota(ME, PEER);
  ok('对方回过、我也发满 ' + BE_QUOTA + ' 条 → left = 0（不再「对方一开口就又能聊」）',
    q.left === 0 && q.used === BE_QUOTA, q);

  q = await mkQuota(from(ME, BE_QUOTA).concat(from(PEER, 4)), false).chatQuota(ME, PEER);
  ok('消息先后顺序不影响判定', q.left === 0);

  // 解除好友后的额度水位：只数水位之后的消息
  q = await mkQuota(from(ME, 20).concat(from(PEER, 20)), false, false, 5000).chatQuota(ME, PEER);
  ok('★★ 解除过好友（quotaResetAt=5000）：历史消息（at<5000）不算进额度', q.used === 0 && q.left === BE_QUOTA, q);
  ok('解除之后对方的历史消息也不算', q.peerUsed === 0 && q.replied === false);

  const after = from(ME, 2, 9000).concat(from(PEER, 1, 9001));
  q = await mkQuota(from(ME, 20).concat(from(PEER, 20)).concat(after), false, false, 5000)
    .chatQuota(ME, PEER);
  ok('解除之后新发的 2 条才计入：left = ' + (BE_QUOTA - 2), q.used === 2 && q.left === BE_QUOTA - 2, q);
  ok('解除之后对方新发的 1 条计入 peerUsed', q.peerUsed === 1 && q.replied === true);

  q = await mkQuota(from(ME, 20), false, false, 0).chatQuota(ME, PEER);
  ok('没有水位（老会话取不到该字段）→ 计数口径与以前完全一致', q.used === 20 && q.left === 0);

  /* ============ B. chatSend 的闸门 ============ */
  console.log('\nB. 云函数 chatSend 的闸门位置与形状');
  const send = sliceFn(src, 'chatSend');
  const iThem = send.indexOf('对方设置了消息限制');
  const iMe = send.indexOf('你已拉黑对方，解除后才能发送');
  const iQuota = send.indexOf('chatQuota(openid, to)');
  const iPush = send.indexOf('db.command.push');

  ok('chatSend 里确实挂了配额闸门', iQuota > 0);
  ok('闸门排在「TA 拉黑了我」之后（被拉黑该说「对方设置了消息限制」，不能说「你发满了」）',
    iThem >= 0 && iQuota > iThem);
  ok('闸门排在「我拉黑了 TA」之后', iMe >= 0 && iQuota > iMe);
  ok('闸门排在写库之前 —— 放到 push 后面就等于「先发出去再退回」，消息已经进对方会话了',
    iPush > 0 && iQuota < iPush);
  ok('只在非好友时才拦（好友短路，不受任何限制）', send.indexOf('!quota.isFriend && quota.left <= 0') > iQuota);
  ok('被配额拦下时回 quotaBlocked 标志，前端据此把输入框锁掉', send.indexOf('quotaBlocked: true') > iQuota);
  ok('拦下时的提示说清了「加为好友后就不限了」，而不是只丢一句「只能发 3 条」',
    send.indexOf('加为好友后就不限了') > iQuota);
  ok('成功回执带回扣减后的额度（前端连发两条时中间那帧才不会是错数）',
    send.indexOf('quota: quota.isFriend ? quota : Object.assign') > 0);
  ok('闸门在配额判定里用 chatQuota（没有另抄一份计数逻辑）', send.indexOf('await chatQuota(openid, to)') > 0);

  /* ============ C. 云函数 removeFriend ============ */
  console.log('\nC. 云函数 removeFriend（解除好友）');
  const rm = sliceFn(src, 'removeFriend');

  ok('是自己实现的，不是转发到别的函数', /async function removeFriend\(openid, payload\)/.test(src));
  ok('没有指定同学 → 拒绝', rm.indexOf("msg: '没有指定同学'") > 0);
  ok('不能解除自己', rm.indexOf("msg: '不能解除自己'") > 0);
  ok('按 where 双向删 friends（不能只按定死的 _id 删：早期记录的 id 是随机的）',
    rm.indexOf('where({ openid: openid, friend: to }).remove()') > 0
    && rm.indexOf('where({ openid: to, friend: openid }).remove()') > 0);
  ok('清掉 contacts 里两个方向的所有申请记录（漏了这步就再也加不回来）',
    rm.indexOf('where({ fromOpenid: openid, toOpenid: to }).remove()') > 0
    && rm.indexOf('where({ fromOpenid: to, toOpenid: openid }).remove()') > 0);
  ok('在会话上盖 quotaResetAt（否则长会话一解除双方立刻都说不了话）',
    rm.indexOf('quotaResetAt: Date.now()') > 0);
  // 这条断言原先写的是「源码里不出现 messages」——那是 .8 版还没有系统消息时的写法。
  // .9 起 removeFriend 会往会话里追加一条系统消息（解除后双方都只看到「对话断了、
  // 我还剩 3 条」，没有这条提示最常见的结局是对方过两天来问「你怎么把我删了」），
  // 所以判据要换成「只追加、不整份覆盖、更不删记录」
  ok('不删也不整份覆盖聊天记录（和拉黑一致：删记录会把自己这边的约定、联系方式一并弄丢）',
    !/COL_CHATS\)[\s\S]{0,120}\.remove\(\)/.test(rm)
    && rm.indexOf('messages: next') < 0
    && rm.indexOf('messages: db.command.push(') > 0);
  ok('留一条系统消息，且标了 sys / from:\'system\'（前端据此单独一种样式，'
    + '也不会被当成对方说的一句话）',
    rm.indexOf('sys: true') > 0 && rm.indexOf("from: 'system'") > 0);
  ok('解除后两侧的请求箱接受标记都清掉（这一对又回到 chatList 的请求箱判定范围）',
    rm.indexOf("reqState: ''") > 0);
  ok('两个方向都读不到结果 → 如实报失败，不谎报「已解除」',
    rm.indexOf("msg: '解除失败，再试一次'") > 0);
  ok('路由里注册了 removeFriend', src.indexOf("case 'removeFriend':") > 0);
  ok('removeFriend 挂到了 removeFriend 函数上', src.indexOf('return removeFriend(openid, event);') > 0);

  const banned = (src.match(/const BANNED_BLOCK_ACTIONS = \[([\s\S]*?)\];/) || [])[1] || '';
  ok('removeFriend 不在封禁拦截清单里（被封的人也该能把自己摘出去）',
    banned.indexOf("'removeFriend'") < 0);
  ok('block / unblock 同样不在清单里（和它们保持一致）',
    banned.indexOf("'block'") < 0 && banned.indexOf("'unblock'") < 0);

  // 行为：四个落点是否真的发生（friends / contacts / chats / 站内通知）
  function mkRemove(opt) {
    opt = opt || {};
    const log = { removed: [], updated: [], notifies: [] };
    const CHAT_ROW = { _id: 'c1', key: 'A_B', a: 'A', b: 'B', messages: [], lastAt: 1 };
    const db = {
      // db.command.push 只需要把参数原样包一层：行为断言关心的是
      // 「用 push 追加还是整份覆盖」，不关心云开发内部怎么实现。
      // inc 是给 rev 用的（撤回 / 摘违规图的 CAS 条件靠它察觉并发 push），
      // 这里同样只包一层，让代码能跑通即可
      command: { push: (o) => ({ __push: o }), inc: (n) => ({ __inc: n }) },
      collection(name) {
        const api = {
          _cond: null,
          _doc: null,
          where(c) { api._cond = c; return api; },
          doc(id) { api._doc = id; return api; },
          limit() { return api; },
          get() {
            if (opt.failAll) return Promise.reject(new Error('db down'));
            // removeFriend 只读一次库：按 key 取那段会话
            return Promise.resolve({ data: name === 'chats' ? [CHAT_ROW] : [] });
          },
          remove() {
            if (opt.failAll) return Promise.reject(new Error('db down'));
            log.removed.push({ col: name, cond: api._cond });
            return Promise.resolve({ stats: { removed: 1 } });
          },
          update(o) {
            if (opt.failAll) return Promise.reject(new Error('db down'));
            log.updated.push({ col: name, cond: api._cond, doc: api._doc, data: o && o.data });
            return Promise.resolve({ stats: { updated: 1 } });
          }
        };
        return api;
      }
    };
    const fn = new Function(
      'db', 'COL_FRIENDS', 'COL_CONTACTS', 'COL_CHATS', 'chatKey',
      'STRANGER_QUOTA', 'CHAT_KEEP', 'now', 'pushNotify',
      sliceFn(src, 'countRemoved') + '\n' + sliceFn(src, 'removeFriend') + '\nreturn removeFriend;'
    )(
      db, 'friends', 'contacts', 'chats',
      function chatKey(a, b) { return [a, b].sort().join('_'); },
      Number((src.match(/const STRANGER_QUOTA = (\d+);/) || [])[1]) || 0,
      Number((src.match(/const CHAT_KEEP = (\d+);/) || [])[1]) || 0,
      function now() { return '2026-10-16 20:00'; },
      function pushNotify(to, n) {
        log.notifies.push(Object.assign({ to: to }, n || {}));
        return Promise.resolve();
      }
    );
    return { fn: fn, log: log };
  }

  const r1 = mkRemove();
  const res1 = await r1.fn('A', { toOpenid: 'B' });
  const rmFriends = r1.log.removed.filter((x) => x.col === 'friends');
  const rmContacts = r1.log.removed.filter((x) => x.col === 'contacts');
  const upChats = r1.log.updated.filter((x) => x.col === 'chats');
  ok('解除成功回 ok:true', res1.ok === true && res1.removed === true, res1);
  ok('friends 表两个方向各删一次', rmFriends.length === 2
    && rmFriends.some((x) => x.cond.openid === 'A' && x.cond.friend === 'B')
    && rmFriends.some((x) => x.cond.openid === 'B' && x.cond.friend === 'A'), rmFriends);
  ok('contacts 表两个方向各清一次', rmContacts.length === 2
    && rmContacts.some((x) => x.cond.fromOpenid === 'A' && x.cond.toOpenid === 'B')
    && rmContacts.some((x) => x.cond.fromOpenid === 'B' && x.cond.toOpenid === 'A'), rmContacts);
  ok('会话文档上盖了 quotaResetAt', upChats.length === 1
    && upChats[0].doc === 'c1' && typeof upChats[0].data.quotaResetAt === 'number', upChats);
  ok('回执里报了真正删掉几条关系', res1.friendDeleted === 2, res1);

  // —— 系统消息这条链（.9 新增）——
  const pushed = upChats[0] && upChats[0].data.messages && upChats[0].data.messages.__push;
  ok('会话记录是**追加**一条系统消息，不是整份覆盖（整份覆盖会把历史聊天记录清空）',
    !!pushed && Array.isArray(pushed.each) && pushed.each.length === 1, pushed);
  ok('追加时带了 slice: -CHAT_KEEP（老消息照旧按上限截断，不然会话文档会无限膨胀）',
    !!pushed && pushed.slice === -Number((src.match(/const CHAT_KEEP = (\d+);/) || [])[1]));
  ok('系统消息的 from 不是任何一方 —— 否则会被 chatQuota 算进某一侧的额度里，'
    + '系统消息不该吃掉用户的额度',
    !!pushed && pushed.each[0].from === 'system' && pushed.each[0].sys === true);
  ok('系统消息里带着「双方各自还能发 N 条」这个数（这才是对方最需要知道的事：'
    + '为什么我说不出话了）',
    !!pushed && String(pushed.each[0].text).indexOf(String(BE_QUOTA)) > 0,
    pushed && pushed.each[0].text);
  ok('解除时给对方推站内通知（这件事发生在他身上，他那边只有红点能发现）',
    r1.log.notifies.length === 1 && r1.log.notifies[0].to === 'B'
    && r1.log.notifies[0].type === 'unfriend', r1.log.notifies);

  const r2 = mkRemove();
  const res2 = await r2.fn('A', {});
  ok('缺参数 → 拒绝，且一次库都不碰', res2.ok === false && r2.log.removed.length === 0);

  const r3 = mkRemove();
  const res3 = await r3.fn('A', { toOpenid: 'A' });
  ok('解除自己 → 拒绝', res3.ok === false && res3.msg.indexOf('自己') >= 0);

  const r4 = mkRemove({ failAll: true });
  const res4 = await r4.fn('A', { toOpenid: 'B' });
  ok('库连不上 → 回 ok:false（不谎报已解除：谎报之后关系还在，用户会以为再点一次就行）',
    res4.ok === false, res4);

  const r5 = mkRemove();
  const res5 = await r5.fn('A', { openid: 'B' });
  ok('参数名 openid 也认（老调用方兼容）', res5.ok === true);

  /* ============ D. addRequest：解除之后还能加回来 ============ */
  console.log('\nD. addRequest：解除之后还能加回来（步骤 ② 的意义）');

  function mkAdd(tables) {
    const log = { added: [], updated: [], notifies: [] };
    const db = {
      collection(name) {
        const api = {
          _cond: {},
          where(c) { api._cond = c || {}; return api; },
          limit() { return api; },
          get() {
            const rows = (tables[name] || []).filter((r) =>
              Object.keys(api._cond).every((k) => r[k] === api._cond[k]));
            return Promise.resolve({ data: rows });
          },
          doc(id) {
            return {
              update(o) { log.updated.push({ col: name, id: id, data: o && o.data }); return Promise.resolve({ stats: { updated: 1 } }); },
              get() { return Promise.resolve({ data: (tables[name] || []).filter((r) => r._id === id)[0] || null }); },
              remove() { return Promise.resolve({}); }
            };
          },
          add(o) { log.added.push({ col: name, data: o && o.data }); return Promise.resolve({ _id: 'new' }); }
        };
        return api;
      }
    };
    const fn = new Function('db', 'COL_FRIENDS', 'COL_BLOCKS', 'COL_CONTACTS', 'now', 'isFriendPair',
      'notifyFriendReq', 'pushNotify', 'guard',
      sliceFn(src, 'addRequest') + '\nreturn addRequest;'
    )(db, 'friends', 'blocks', 'contacts', function now() { return '2026-10-16 20:00'; },
      async function isFriendPair() { return false; },
      // .9 起 addRequest 成功分支会推一条站内通知（订阅消息是一次性的，断了就靠它兜底）。
      // 这里打桩并把调用记下来，好断言「申请真的通知到对方了」
      async function notifyFriendReq(openid, to, message) {
        log.notifies.push({ to: to, message: message });
        return true;
      },
      async function pushNotify() { return true; },
      async function guard() { return { ok: true }; });
    return { fn: fn, log: log };
  }

  // 情形一：解除好友时**没**清 contacts → 那条 accepted 老记录把申请顶回去
  const d1 = mkAdd({
    friends: [],
    blocks: [],
    contacts: [{ _id: 'c1', fromOpenid: 'A', toOpenid: 'B', status: 'accepted', time: '2026-01-01 10:00' }]
  });
  const dr1 = await d1.fn('A', { toOpenid: 'B' });
  ok('★ 反证：contacts 里留着 accepted 老记录时，重新申请会被顶回「已经是好友啦」',
    dr1.ok === false && dr1.msg.indexOf('已经是好友') >= 0, dr1);

  // 情形二：解除好友时清了 contacts（removeFriend 的做法）→ 申请正常发得出去
  const d2 = mkAdd({ friends: [], blocks: [], contacts: [] });
  const dr2 = await d2.fn('A', { toOpenid: 'B', message: '一起自习吧' });
  ok('★★ 正证：contacts 清干净之后，两个人能重新加回来',
    dr2.ok === true && d2.log.added.length === 1, dr2);
  ok('留言跟着写进去（截到 50 字）', d2.log.added[0].data.message === '一起自习吧');
  ok('申请成功时给对方推一条站内通知（订阅消息是一次性的，用户点了「拒绝」之后'
    + '再也收不到模板消息，站内通知是唯一还留得住的提醒）',
    d2.log.notifies.length === 1 && d2.log.notifies[0].to === 'B'
    && d2.log.notifies[0].message === '一起自习吧', d2.log.notifies);
  ok('新申请是 pending 状态', d2.log.added[0].data.status === 'pending');

  /* ============ E. 前端纯函数 ============ */
  console.log('\nE. 会话页 quotaText / sendAllowed / lockText');
  const chatSrc = readProj('pages/user/chat/chat.js');
  const FE = new Function(
    sliceFn(chatSrc, 'quotaText') + '\n'
    + sliceFn(chatSrc, 'sendAllowed') + '\n'
    + sliceFn(chatSrc, 'lockText') + '\n'
    + 'return { quotaText: quotaText, sendAllowed: sendAllowed, lockText: lockText };'
  )();
  const { quotaText, sendAllowed, lockText } = FE;

  ok('好友：不给任何额度文案（isFriend 时一个字都不该提）', quotaText({ isFriend: true, left: 0 }) === '');
  ok('没有额度信息：也不提（云端旧版 / 断网时别凭空吓人）', quotaText(null) === '');

  const t1 = quotaText({ isFriend: false, limit: BE_QUOTA, left: 2, replied: false, peerUsed: 0 });
  ok('还有额度：说明还剩几条 + 共几条', t1.indexOf('2') >= 0 && t1.indexOf(String(BE_QUOTA)) >= 0, t1);
  ok('还有额度：说明加好友之后不限条数', t1.indexOf('不限') >= 0, t1);

  const t2 = quotaText({ isFriend: false, limit: BE_QUOTA, left: 0, replied: false, peerUsed: 0 });
  ok('发满且对方没回过：说清条数用完了', t2.indexOf('发完') >= 0, t2);
  ok('发满后给出下一步：加为好友', t2.indexOf('加为好友') >= 0, t2);
  ok('发满后不再提「对方还没同意」这种听上去像被拒的话', t2.indexOf('还没同意') < 0, t2);

  const t3 = quotaText({ isFriend: false, limit: BE_QUOTA, left: 0, replied: true, peerUsed: 2 });
  ok('对方回过时多一句安慰（「对方也回过你了」），但下一步动作完全一样',
    t3.indexOf('回过') >= 0 && t3.indexOf('加为好友') >= 0, t3);
  ok('两档的条数说明是同一条规则（都是 ' + BE_QUOTA + ' 条），不再有 20 条那一档',
    t2.indexOf(String(BE_QUOTA)) >= 0 && t3.indexOf(String(BE_QUOTA)) >= 0 && t3.indexOf('20') < 0);

  ok('sendAllowed：好友一律放行', sendAllowed({ isFriend: true, left: 0 }, false, false) === true);
  ok('sendAllowed：没有额度信息一律放行（云端不可用不能把人锁死）', sendAllowed(null, false, false) === true);
  ok('sendAllowed：还有 1 条就放行', sendAllowed({ isFriend: false, left: 1 }, false, false) === true);
  ok('sendAllowed：剩 0 条拦住', sendAllowed({ isFriend: false, left: 0 }, false, false) === false);
  ok('sendAllowed：我拉黑对方 → 拦住', sendAllowed({ isFriend: true }, true, false) === false);
  ok('sendAllowed：对方拉黑我 → 拦住', sendAllowed({ isFriend: true }, false, true) === false);
  ok('sendAllowed：left 是字符串 "0" 也认（云端回的是数字，但别在这上面栽跟头）',
    sendAllowed({ isFriend: false, left: '0' }, false, false) === false);

  ok('lockText：我拉黑时说拉黑', lockText({ blockedByMe: true, quota: null }).indexOf('拉黑') >= 0);
  ok('lockText：对方拉黑我说对方限制了消息', lockText({ blockedByThem: true, quota: null }).indexOf('限制') >= 0);
  ok('lockText：其余情况落到额度文案',
    lockText({ quota: { isFriend: false, limit: BE_QUOTA, left: 0, replied: false } })
      === quotaText({ isFriend: false, limit: BE_QUOTA, left: 0, replied: false }));
  ok('lockText：拉黑优先于额度（两件事同时成立时说更严重的那件）',
    lockText({ blockedByMe: true, quota: { isFriend: false, left: 0 } }).indexOf('拉黑') >= 0);

  /* ============ F. utils/friend.js ============ */
  console.log('\nF. utils/friend.js（加好友 / 解除好友的交互层）');

  const MEM = {};
  const NAVS = [];
  const CALLS = [];
  let CALL_REPLY = null; // (action, payload) => result | undefined（undefined 走默认）
  let onModal = null;    // (opts) => void —— 测试里决定这次弹窗用户点了什么

  const noop = () => undefined;
  const chain = (() => {
    const c = {};
    ['collection', 'doc', 'where', 'orderBy', 'limit', 'field', 'skip'].forEach((m) => { c[m] = () => c; });
    c.get = () => Promise.resolve({ data: [] });
    c.add = () => Promise.resolve({ _id: 'x' });
    c.update = () => Promise.resolve({});
    c.remove = () => Promise.resolve({});
    return c;
  })();
  const wxBase = {
    getStorageSync: (k) => (k in MEM ? MEM[k] : ''),
    setStorageSync: (k, v) => { MEM[k] = v; },
    removeStorageSync: (k) => { delete MEM[k]; },
    showToast: noop, showLoading: noop, hideLoading: noop,
    showModal: (o) => { if (onModal) onModal(o); },
    setNavigationBarTitle: noop, setNavigationBarColor: noop,
    navigateTo: (o) => { NAVS.push(String((o && o.url) || '')); },
    redirectTo: (o) => { NAVS.push(String((o && o.url) || '')); },
    nextTick: (fn) => fn(),
    getSystemInfoSync: () => ({}),
    getWindowInfo: () => ({}),
    cloud: {
      init: noop,
      database: () => chain,
      callFunction: (o) => {
        const action = (o && o.data && o.data.action) || o.name;
        const payload = (o && o.data) || {};
        CALLS.push({ action: action, payload: payload });
        if (CALL_REPLY) {
          const r = CALL_REPLY(action, payload);
          if (r !== undefined) return Promise.resolve({ result: r });
        }
        return Promise.resolve({ result: { ok: true } });
      }
    }
  };
  global.wx = new Proxy(wxBase, { get: (t, k) => (k in t ? t[k] : noop) });
  global.getApp = () => ({ globalData: {} });
  global.getCurrentPages = () => [{ route: 'pages/user/card/card', options: { openid: 'o2' } }];
  global.Component = noop;
  global.App = noop;

  const FR = require(path.join(PROJ, 'pages', 'user', 'utils', 'friend.js'));

  ok('friend.js 的条数与云函数 STRANGER_QUOTA 是同一个数字（这是「四个落点必须一致」里的一个）',
    FR.STRANGER_QUOTA === BE_QUOTA, { fe: FR.STRANGER_QUOTA, be: BE_QUOTA });
  ok('留言上限是 50（和服务端 addRequest 的 slice(0,50) 对齐，否则用户以为对方看到的是全的）',
    FR.MESSAGE_MAX === 50);

  // ask：用户取消 → 一个请求都不发
  let before = CALLS.length;
  onModal = (o) => o.success({ confirm: false, cancel: true });
  let ar = await FR.ask('o7');
  ok('ask：用户取消 → 不发请求', CALLS.length === before && ar.ok === false && ar.canceled === true, ar);

  // ask：确认 → 发 addRequest，留言 trim + 截到 50 字
  before = CALLS.length;
  onModal = (o) => o.success({ confirm: true, content: '  一起自习吧  ' });
  ar = await FR.ask('o7');
  const sent = CALLS[CALLS.length - 1];
  ok('ask：确认后发出 addRequest', CALLS.length === before + 1 && sent.action === 'addRequest', sent);
  ok('ask：留言去掉首尾空格', sent.payload.message === '一起自习吧', sent.payload);
  ok('ask：目标 openid 正确', sent.payload.toOpenid === 'o7');
  ok('ask：成功后 resolve ok:true', ar.ok === true);

  onModal = (o) => o.success({ confirm: true, content: 'x'.repeat(80) });
  await FR.ask('o7');
  ok('ask：超长留言截到 50 字（不能让用户以为打了 80 字对方看到 80 字）',
    CALLS[CALLS.length - 1].payload.message.length === 50);

  onModal = (o) => o.success({ confirm: true });
  await FR.ask('o7');
  ok('ask：没有 content（老基础库不支持 editable）也能发出去，留言为空',
    CALLS[CALLS.length - 1].payload.message === '');

  // ask：服务端如实拒了 → 原样把原因交回去
  CALL_REPLY = (a) => (a === 'addRequest' ? { ok: false, msg: '你们已经是好友啦' } : undefined);
  onModal = (o) => o.success({ confirm: true, content: '' });
  ar = await FR.ask('o7');
  ok('ask：服务端拒绝时原样转达原因（不另编一句更含糊的）',
    ar.ok === false && ar.msg === '你们已经是好友啦', ar);
  CALL_REPLY = null;

  ar = await FR.ask('');
  ok('ask：没有 openid → 直接拒绝，不弹窗', ar.ok === false && ar.canceled === undefined);

  // remove：二次确认
  before = CALLS.length;
  onModal = (o) => {
    ok('remove：确认框里带上了对方的名字（从名单里点错一行很常见）',
      String(o.content || '').indexOf('甲') >= 0, o.content);
    ok('remove：确认框写清了后果（重新申请 + 联系方式不可见）',
      String(o.content).indexOf('重新申请') >= 0 && String(o.content).indexOf('联系方式') >= 0, o.content);
    ok('remove：确认框说明聊天记录保留（否则用户以为记录会被清掉）',
      String(o.content).indexOf('保留') >= 0, o.content);
    ok('remove：条数与云端一致地写进文案', String(o.content).indexOf(String(BE_QUOTA)) >= 0, o.content);
    ok('remove：确认按钮是危险色', o.confirmColor === '#d9534f');
    o.success({ confirm: false, cancel: true });
  };
  let rr = await FR.remove('o8', '甲');
  ok('remove：用户取消 → 不发请求', CALLS.length === before && rr.canceled === true);

  onModal = (o) => o.success({ confirm: true });
  rr = await FR.remove('o8', '甲');
  const rmCall = CALLS[CALLS.length - 1];
  ok('remove：确认后调 removeFriend', rmCall.action === 'removeFriend' && rmCall.payload.toOpenid === 'o8', rmCall);
  ok('remove：成功后 resolve ok:true', rr.ok === true);

  CALL_REPLY = (a) => (a === 'removeFriend' ? null : undefined);
  onModal = (o) => o.success({ confirm: true });
  rr = await FR.remove('o8', '甲');
  ok('remove：云端没响应 → ok:false（绝不谎报「已解除」）', rr.ok === false, rr);
  CALL_REPLY = null;

  onModal = (o) => o.success({ confirm: true });
  rr = await FR.remove('', '');
  ok('remove：没有 openid → 直接拒绝，不弹窗', rr.ok === false && rr.canceled === undefined);

  ok('friend.js 不裸调 wx.showToast（提示一律走 utils/feedback.js）',
    readProj('pages/user/utils/friend.js').indexOf('wx.showToast(') < 0);

  /* ============ G. 页面事件 ============ */
  console.log('\nG. 页面事件（名片页 / 找同学 / 会话页）');

  let CAP = null;
  global.Page = (o) => { CAP = o; };
  function capturePage(rel) {
    CAP = null;
    const abs = path.join(PROJ, rel);
    delete require.cache[require.resolve(abs)];
    require(abs);
    if (!CAP) throw new Error('没捕获到 Page：' + rel);
    return CAP;
  }
  const CARD = capturePage(path.join('pages', 'user', 'card', 'card.js'));
  const FRIENDS = capturePage(path.join('pages', 'user', 'friends', 'friends.js'));
  const CT = capturePage(path.join('pages', 'user', 'chat', 'chat.js'));

  // proto 传页面对象：handler 里 this.xxx() 调的是同一个 Page 上的方法（真实运行时就是这样），
  // data / setData 则各自独立，互不串味
  const mkThis = (data, extra, proto) => Object.assign(Object.create(proto || null), {
    data: Object.assign({}, data),
    setData(p) { Object.assign(this.data, p); }
  }, extra || {});

  // 页面事件里那几个 handler 都是「发出去就不管」（不 return promise），
  // 弹窗回调 → 云调用 → setData 是一串微任务。用一记宏任务把它们全部冲干净，
  // 否则断言会跑在 state 还没落地的时候（这类「测试自己写错」最容易冤枉真代码）
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // ---- 名片页 ----
  ok('名片页不直接调 userApi.addRequest（加好友只有 utils/friend.js 一份实现）',
    readProj('pages/user/card/card.js').indexOf('userApi.addRequest') < 0);
  ok('找同学页也不直接调 userApi.addRequest', readProj('pages/user/friends/friends.js').indexOf('userApi.addRequest') < 0);

  onModal = (o) => o.success({ confirm: true, content: '我是隔壁班的' });
  const c1 = mkThis({ openid: 'o2', profile: { nickName: '甲' }, waiting: false }, null, CARD);
  await CARD.onRequest.call(c1);
  await tick();
  ok('名片页「加好友」→ 走 friend.ask（留言弹窗），成功后进入等待态', c1.data.waiting === true);
  ok('名片页「加好友」→ 调用的是 addRequest 且带上了弹窗里那句留言',
    CALLS[CALLS.length - 1].action === 'addRequest'
    && CALLS[CALLS.length - 1].payload.message === '我是隔壁班的'
    || CALLS.some((x) => x.action === 'addRequest' && x.payload.message === '我是隔壁班的'));
  // 关系状态条和关系数据必须同源：标题说「你已申请」而模板还按陌生人渲染，
  // 用户就会在同一页面上看到两种互相矛盾的关系描述
  ok('★「加好友」成功后关系状态条同步切成「已申请」（relTitle 由 relOf 统一算）',
    c1.data.relTitle === '你已申请，等对方通过', c1.data.relTitle);
  ok('★关系状态条图标也是一起算出来的，不靠模板里拼路径',
    /users-round--campus\.svg$|clock--muted\.svg$/.test(c1.data.relIcon || ''), c1.data.relIcon);

  onModal = (o) => o.success({ confirm: false });
  const c2 = mkThis({ openid: 'o2', profile: { nickName: '甲' }, waiting: false }, null, CARD);
  await CARD.onRequest.call(c2);
  await tick();
  ok('名片页「加好友」：用户取消 → 不进等待态', c2.data.waiting === false);

  onModal = (o) => o.success({ confirm: true });
  const c3 = mkThis({ openid: 'o3', isFriend: true, waiting: false, msg: 'x' }, { load: () => { c3.loaded = true; } }, CARD);
  await CARD.onUnfriend.call(c3);
  await tick();
  ok('名片页「解除好友」→ 调 removeFriend，目标正确',
    CALLS[CALLS.length - 1].action === 'removeFriend' && CALLS[CALLS.length - 1].payload.toOpenid === 'o3');
  ok('名片页「解除好友」→ 本地关系立刻翻成陌生人（不翻的话页面还挂着联系方式）',
    c3.data.isFriend === false);
  ok('名片页「解除好友」→ 申请态一并清掉', c3.data.waiting === false && c3.data.msg === '');
  ok('名片页「解除好友」→ 重拉一次页面数据', c3.loaded === true);
  ok('★解除好友后状态条立刻回到陌生人（不能还挂着「你们是同学」）',
    c3.data.relTitle === '你们还不是同学', c3.data.relTitle);

  onModal = (o) => o.success({ confirm: false });
  const c4 = mkThis({ openid: 'o3', isFriend: true }, { load: () => { c4.loaded = true; } }, CARD);
  await CARD.onUnfriend.call(c4);
  await tick();
  ok('名片页「解除好友」：用户取消 → 什么都不发生', c4.data.isFriend === true && !c4.loaded);

  const c5 = mkThis({ openid: 'o3', isFriend: true }, { load: () => {} }, CARD);
  await CARD.onUnfriend.call(c5);
  await tick();
  ok('名片页「解除好友」：没有待处理的弹窗回调时不崩（弹窗失败也要能收场）', true);

  ok('名片页的条数取自 utils/friend.js（不是自己写死一个 3）',
    readProj('pages/user/card/card.js').indexOf('const STRANGER_QUOTA = friend.STRANGER_QUOTA;') > 0);
  ok('名片页不再有「附一句留言」那个独立控件（整合进加好友的弹窗里了）',
    readProj('pages/user/card/card.wxml').indexOf('bindtap="toggleMsg"') < 0
    && readProj('pages/user/card/card.wxml').indexOf('<textarea') < 0);
  ok('名片页的死样式（留言输入框）已删干净',
    readProj('pages/user/card/card.wxss').indexOf('cd-msg-box') < 0
    && readProj('pages/user/card/card.wxss').indexOf('cd-msg-input') < 0);
  ok('名片页的 onMsg / toggleMsg / showMsg 也一并清掉（不留半截代码）',
    readProj('pages/user/card/card.js').indexOf('toggleMsg') < 0
    && readProj('pages/user/card/card.js').indexOf('showMsg') < 0);
  ok('名片页好友分支里有「解除好友关系」按钮', readProj('pages/user/card/card.wxml').indexOf('解除好友关系') > 0);
  // 配额说明的落点从模板挪进了 relOf()：它和「你们还不是同学」是同一句话的两半，
  // 分开放必然出现「标题说陌生人、副标题说已是同学」这种自相矛盾
  ok('★配额说明已挪进关系状态条（relOf 里与关系判断同源），文案是「互相最多发 N 条」',
    readProj('pages/user/card/card.wxml').indexOf('各自最多能发') < 0
    && readProj('pages/user/card/card.js').indexOf("'互相最多发 ' + STRANGER_QUOTA + ' 条消息；加为同学之后不限条数。'") > 0);
  ok('★关系状态条的三段文案都由 relOf() 一处算出，模板里不再有嵌套三元',
    readProj('pages/user/card/card.js').indexOf('function relOf(state)') > 0
    && readProj('pages/user/card/card.wxml').indexOf('assets/icons/{{') < 0
    && readProj('pages/user/card/card.wxml').indexOf('{{relIcon}}') > 0);

  // ---- 找同学 ----
  const decor = (openid, name) => ({ openid: openid, nickName: name, college: '', motto: '' });
  const f1 = mkThis({ keyword: '甲', searchMode: 'fuzzy', results: [] });
  f1._friendSet = { o2: true };
  f1._outSet = { o3: true };
  const flagged = FRIENDS.flagResults.call(f1, [decor('o2', '甲'), decor('o3', '乙'), decor('o4', '丙')]);
  ok('搜索结果：已经是同学的行标上 isFriend（那一行不给「加好友」按钮）', flagged[0].isFriend === true);
  ok('搜索结果：我已申请过的行标上 requested', flagged[1].requested === true);
  ok('搜索结果：陌生人两个标记都是假（这一行才给按钮）',
    !flagged[2].isFriend && !flagged[2].requested);
  ok('搜索结果：装饰字段（头像首字）还在，没被覆盖掉', flagged[2].avatarText === '丙');

  ok('一个词都没搜时 flagResults 不乱跑', FRIENDS.flagResults.call(mkThis({}), []).length === 0);
  ok('flagResults 对空值安全（云端返回 null 时不崩）', FRIENDS.flagResults.call(mkThis({}), null).length === 0);

  const f2 = mkThis({ results: [decor('o4', '丙')] }, null, FRIENDS);
  f2._outSet = {};
  onModal = (o) => o.success({ confirm: true, content: '一起自习吧' });
  await FRIENDS.onAddFriend.call(f2, { currentTarget: { dataset: { openid: 'o4' } } });
  await tick();
  ok('搜索结果「加好友」→ 调 addRequest，目标正确',
    CALLS[CALLS.length - 1].action === 'addRequest' && CALLS[CALLS.length - 1].payload.toOpenid === 'o4');
  ok('搜索结果「加好友」→ 那一行立刻变成「已申请」，不等下一次轮询（6 秒里按钮还在原地会被当成没点成功）',
    f2.data.results[0].requested === true);

  const f3 = mkThis({ results: [decor('o4', '丙')] }, null, FRIENDS);
  f3._outSet = {};
  const beforeCancel = CALLS.filter((x) => x.action === 'addRequest').length;
  onModal = (o) => o.success({ confirm: false });
  await FRIENDS.onAddFriend.call(f3, { currentTarget: { dataset: { openid: 'o4' } } });
  await tick();
  ok('搜索结果「加好友」：用户取消 → 那一行不变、也不发请求',
    !f3.data.results[0].requested
    && CALLS.filter((x) => x.action === 'addRequest').length === beforeCancel);

  const f4 = mkThis({ results: [] }, null, FRIENDS);
  await FRIENDS.onAddFriend.call(f4, { currentTarget: { dataset: {} } });
  await tick();
  ok('搜索结果「加好友」：没有 openid → 什么都不做', f4.data.results.length === 0);

  // friends.js 的 flagResults 在每次 onAddFriend 里都要能重算
  ok('flagResult / flagResults 是两个函数：一个纯粹算标记、一个负责批量（改一处全站一致）',
    FRIENDS.flagResults && typeof FRIENDS.flagResults === 'function');

  let reloaded = 0;
  onModal = (o) => o.success({ confirm: true });
  const rmThis = mkThis({ friends: [] }, { reloadAll: () => { reloaded += 1; return Promise.resolve(); } });
  await FRIENDS.onRemoveFriend.call(rmThis, { currentTarget: { dataset: { openid: 'o9', name: '丁' } } });
  await tick();
  ok('名单行「解除」→ 调 removeFriend，目标正确',
    CALLS[CALLS.length - 1].action === 'removeFriend' && CALLS[CALLS.length - 1].payload.toOpenid === 'o9');
  ok('名单行「解除」→ 整表重拉一次（不许只本地撕掉那一行：会留下「名单里没了、搜索里还是同学」）',
    reloaded === 1);

  onModal = (o) => o.success({ confirm: false });
  const rmThis2 = mkThis({ friends: [] }, { reloadAll: () => { reloaded += 1; return Promise.resolve(); } });
  await FRIENDS.onRemoveFriend.call(rmThis2, { currentTarget: { dataset: { openid: 'o9', name: '丁' } } });
  await tick();
  ok('名单行「解除」：用户取消 → 不重拉、不发请求', reloaded === 1);

  const rmThis3 = mkThis({ friends: [] }, { reloadAll: () => { reloaded += 1; return Promise.resolve(); } });
  await FRIENDS.onRemoveFriend.call(rmThis3, { currentTarget: { dataset: {} } });
  await tick();
  ok('名单行「解除」：没有 openid → 什么都不做', reloaded === 1);

  ok('名单行与搜索结果的两颗行内动作都用 catchtap（不 catch 会顺带跳进名片页，确认框被压后面）',
    readProj('pages/user/friends/friends.wxml').indexOf('catchtap="onRemoveFriend"') > 0
    && readProj('pages/user/friends/friends.wxml').indexOf('catchtap="onAddFriend"') > 0);
  ok('搜索结果行里给了「已是同学 / 已申请」两种状态，而不是给一个点了会报错的按钮',
    readProj('pages/user/friends/friends.wxml').indexOf('已是同学') > 0
    && readProj('pages/user/friends/friends.wxml').indexOf('已申请') > 0);
  ok('行内动作有独立样式类（不复用请求卡片的 .fr-op，那个 flex:1 会把行撑开）',
    readProj('pages/user/friends/friends.wxss').indexOf('.fr-act {') > 0
    && readProj('pages/user/friends/friends.wxss').indexOf('.fr-state {') > 0);

  // ---- 会话页 ----
  const a1 = mkThis({ blockedByMe: false, blockedByThem: false });
  CT.applyQuota.call(a1, { isFriend: false, limit: BE_QUOTA, used: BE_QUOTA, left: 0, replied: false });
  ok('applyQuota：额度用尽 → 输入区锁上', a1.data.canSend === false);
  ok('applyQuota：提示文案同步更新（说清下一步是加为好友）',
    String(a1.data.lockText).indexOf('加为好友') >= 0, a1.data.lockText);
  ok('applyQuota：isFriend 一起更新', a1.data.isFriend === false);
  ok('applyQuota：quota 原样存下来（模板还要用）', a1.data.quota.left === 0);

  const a2 = mkThis({ blockedByMe: false, blockedByThem: false });
  CT.applyQuota.call(a2, { isFriend: false, limit: BE_QUOTA, used: 1, left: 2, replied: false });
  ok('applyQuota：还有额度 → 输入区照常可用', a2.data.canSend === true);

  const a3 = mkThis({ blockedByMe: true, blockedByThem: false });
  CT.applyQuota.call(a3, { isFriend: true, limit: 0, used: 0, left: 0, replied: false });
  ok('applyQuota：我拉黑对方时，即便成了好友也拦住', a3.data.canSend === false);

  CT.applyQuota.call(a1, null);
  ok('applyQuota：null 直接忽略（云端没给就别乱改界面）', a1.data.quota.left === 0);

  const s1 = mkThis({ input: '你好', pending: [], canSend: false, lockText: '额度用完了' });
  s1.peer = 'o9';
  before = CALLS.length;
  await CT.send.call(s1);
  ok('额度用尽：本地就拦下，一次网络都不发', CALLS.length === before);
  ok('额度用尽：输入的字不被清掉（申请加好友之前先留着）', s1.data.input === '你好');

  const g1 = mkThis({ requested: false });
  g1.peer = 'o5';
  await CT.onAddFriend.call(g1);
  ok('会话页「申请加好友」：发出去后标记为「已申请」', g1.data.requested === true);
  const afterFirst = CALLS.filter((x) => x.action === 'addRequest').length;
  await CT.onAddFriend.call(g1);
  ok('会话页「申请加好友」：已申请后再点不会重发（连点只发一次）',
    CALLS.filter((x) => x.action === 'addRequest').length === afterFirst);

  const g2 = mkThis({ requested: false });
  g2.peer = '';
  await CT.onAddFriend.call(g2);
  ok('会话页「申请加好友」：没有 peer 时什么都不做', g2.data.requested === false);

  const g3 = mkThis({ incomingRequest: { id: 'req1' } }, { load: () => {} });
  g3.peer = 'o6';
  await CT.onAcceptFriend.call(g3);
  ok('会话页「同意加好友」：成功后清掉 incomingRequest', g3.data.incomingRequest === null);

  /* ============ H. friendIdSet 口径与版本一致性 ============ */
  console.log('\nH. friendIdSet 口径 / 版本指纹 / 文案落点');

  function mkDb(tables) {
    return {
      collection(name) {
        const rows = tables[name] || [];
        let cond = {};
        const api = {
          where(c) { cond = c || {}; return api; },
          limit() { return api; },
          get() {
            const out = rows.filter((r) => Object.keys(cond).every((k) => r[k] === cond[k]));
            return Promise.resolve({ data: out });
          }
        };
        return api;
      }
    };
  }

  const friendApi = new Function('db', 'COL_FRIENDS', 'COL_CONTACTS', 'FRIEND_MAX',
    sliceFn(src, 'friendSnapshot') + '\n'
    + sliceFn(src, 'friendIdSet') + '\n'
    + 'return { friendSnapshot, friendIdSet };')(mkDb({
    friends: [{ openid: ME, friend: 'A', alias: '老A' }, { openid: ME, friend: 'B' }, { openid: 'X', friend: ME }],
    contacts: [
      { fromOpenid: ME, toOpenid: 'C', status: 'accepted' },
      { fromOpenid: 'D', toOpenid: ME, status: 'accepted' },
      { fromOpenid: ME, toOpenid: 'E', status: 'pending' }
    ]
  }), 'friends', 'contacts', 200);
  const friendIdSet = friendApi.friendIdSet;

  const set = await friendIdSet(ME);
  ok('friends 表里我的好友全都算', set.A === true && set.B === true);
  ok('只有反向残留（别人那条记录里是我）不算我的好友', !set.X);
  ok('contacts 里 accepted 的老关系也算（升级兼容，别把老同学弄丢）', set.C === true && set.D === true);
  ok('还在 pending 的申请不算好友', !set.E);
  ok('自己不在集合里', !set[ME]);
  const snap = await friendApi.friendSnapshot(ME);
  ok('备注名随好友快照一次返回', snap.aliases.A === '老A' && !snap.aliases.B, snap.aliases);

  const listFriendsFn = sliceFn(src, 'listFriends');
  const friendsJsText = readProj('pages/user/friends/friends.js');
  const friendsWxmlText = readProj('pages/user/friends/friends.wxml');
  const cardJsText = readProj('pages/user/card/card.js');
  const cardWxmlText = readProj('pages/user/card/card.wxml');
  ok('未编辑资料的好友也用默认名片保留在名单里',
    /users\[id\] \|\| \{/.test(listFriendsFn) && !/if \(!u\) return/.test(listFriendsFn));
  ok('好友页先渲染本机缓存再刷新', /cachedFriends\(\)/.test(friendsJsText) && /function cachedFriends/.test(userApiText));
  ok('长按同学使用 catchlongpress（避免子元素吞事件）',
    /catchlongpress="onLongPressFriend"/.test(friendsWxmlText));
  ok('好友列表补齐 openid（否则点击会误报没登记资料）',
    /prof\.openid = prof\.openid \|\| id/.test(listFriendsFn));
  ok('好友列表渲染头像图片并带回退文字头像',
    /fr-avatar-img/.test(friendsWxmlText) && /onFriendAvatarError/.test(friendsJsText));
  ok('名片页有可直接编辑备注的入口',
    /bindtap="onEditAlias"/.test(cardWxmlText) && /onEditAlias\(\)/.test(cardJsText));
  ok('getProfile 空资料时仍保留 isFriend（不能把好友判成陌生人）',
    /\.then\(\(r\) => r \|\|/.test(userApiText));
  ok('名片页空资料时用默认名片渲染，而不是停在空状态',
    /res\.profile \|\| \{/.test(cardJsText) && /nickName: '浙小商'/.test(cardJsText));
  ok('名片页用本机好友缓存兜底关系状态',
    /userApi\.isFriend\(openid\)/.test(cardJsText) && /!!res\.isFriend \|\| localFriend/.test(cardJsText));

  ok('friendSnapshot 与 isFriendPair 查的是同一个方向（都以「我」为 openid）',
    sliceFn(src, 'friendSnapshot').indexOf('where({ openid: openid })') > 0
    && sliceFn(src, 'isFriendPair').indexOf('where({ openid: a, friend: b })') > 0);

  // 版本指纹三处一致
  const BE_BUILD = (src.match(/const BUILD = '([^']+)';/) || [])[1];
  const FE_BUILD = (readProj('pages/campus/campus.js').match(/const CLOUD_BUILD = '([^']+)';/) || [])[1];
  const RM_FEATURE = /FEATURES = \[([\s\S]*?)\];/.exec(src)[1];
  ok('云函数 BUILD = ' + BE_BUILD, !!BE_BUILD);
  ok('campus.js 的 CLOUD_BUILD 与云函数 BUILD 一致（不一致会把旧版翻译成人话的那条链弄错）',
    !!FE_BUILD && FE_BUILD === BE_BUILD, { be: BE_BUILD, fe: FE_BUILD });
  ok('FEATURES 里登记了 removeFriend（排查时看一眼 diag 就知道云端有没有这项能力）',
    RM_FEATURE.indexOf("'removeFriend'") > 0);
  ok('FEATURES 里也带着 chatQuota', RM_FEATURE.indexOf("'chatQuota'") > 0);

  // 加好友「不做独立入口」这条需求的可验证形式：
  // 动作只有一份实现，落点都在已有页面里，没有新增「加好友页」
  const appJson = readProj('app.json');
  ok('app.json 里没有新增「加好友 / 好友管理」这类独立页面',
    appJson.indexOf('add-friend') < 0 && appJson.indexOf('friend-add') < 0);
  ok('三个落点都 require utils/friend.js（动作只有一份实现）',
    readProj('pages/user/card/card.js').indexOf("utils/friend.js") > 0
    && readProj('pages/user/friends/friends.js').indexOf("utils/friend.js") > 0);
  ok('utils/friend.js 不自己拼云函数调用（走 utils/user.js 的接口层）',
    readProj('pages/user/utils/friend.js').indexOf("utils/user.js") > 0
    && readProj('pages/user/utils/friend.js').indexOf('callFunction') < 0);
  ok('utils/user.js 导出了 removeFriend', userApiText.indexOf('removeFriend,') > 0);
  // 头部索引这一轮重新排过版（一行放不下，按分类拆成了多行），
  // 所以判据从「某一行的原文」改成「在头部索引那一段里搜得到」——
  // 绑具体行文的断言，每次整理注释都会假报警
  const headIdx = src.slice(src.indexOf('action 路由索引'), src.indexOf('async function getSubMsgIds'));
  ok('云函数头部的 action 索引里记了 removeFriend（接手的人按索引就能找到）',
    headIdx.indexOf('removeFriend') > 0);

  // 会话列表里「非好友」标签的说明还是对的
  ok('会话列表的「非好友」标签仍在（这类对话有条数上限，不标用户会以为坏了）',
    readProj('pages/user/chats/chats.wxml').indexOf('cs-tag') > 0
    && readProj('pages/user/chats/chats.wxml').indexOf('非好友') > 0);

  /* ---------- I. 举报「人」 ---------- */

  const RP_SRC = readProj('pages/user/utils/report-person.js');

  // 理由枚举必须与云函数逐字一致：多一个会「菜单里能选、云端折成『其他』」，
  // 少一个则是用户根本没法举报那一类
  const cloudReasons = (src.match(/^const PERSON_REASONS = \[([^\]]+)\]/m) || [])[1];
  ok('★举报人的理由枚举与云函数 PERSON_REASONS 逐字一致（多一个会被云端折成「其他」）',
    !!cloudReasons
    && RP_SRC.indexOf('const PERSON_REASONS = [' + cloudReasons + ']') > 0,
    cloudReasons);

  // 最关键的一条：账号级举报**永不自动封号**。不把这句话说清，
  // 举报人以为对方已经被处置了，白等一个不会来的结果
  ok('★提交前的说明里明确写了「举报不会让 TA 被自动封号」（不给准确预期就会白等）',
    RP_SRC.indexOf('不会让 TA 被自动封号') > 0);
  ok('★同时给出了真正有效的出口（拉黑），而不是只说「没用」',
    RP_SRC.indexOf('拉黑') > 0);
  ok('★私信举报要说清会自动附上最近 10 条对话作为材料',
    RP_SRC.indexOf('最近 10 条对话') > 0 && RP_SRC.indexOf("kind === 'chat'") > 0);

  // 两个落点必须共用同一份交互，否则文案会各自漂移
  ok('名片页与私信页共用 utils/report-person.js（举报「人」只有一份实现）',
    readProj('pages/user/card/card.js').indexOf("utils/report-person.js") > 0
    && readProj('pages/user/chat/chat.js').indexOf("utils/report-person.js") > 0);

  // ⚠️ 断网时绝不能谎报「举报已提交」：服务端靠多人举报凑数才自动处置，
  // 用户以为算上了自己这一票、之后什么也不会发生
  ok('★断网时 reportPerson 回 degraded 而不是 ok:true（谎报会让用户白等）',
    /function reportPerson[\s\S]{0,400}degraded:\s*true/.test(userApiText));
  ok('★同理 reportPost / reportComment / setContentStatus 也不再谎报成功',
    !/function reportPost[\s\S]{0,400}?r === null \? \{ ok: true/.test(userApiText)
    && !/function reportComment[\s\S]{0,400}?r \|\| \{ ok: true, msg: '举报已提交' \}/.test(userApiText)
    && !/function setContentStatus[\s\S]{0,400}?r === null \? \{ ok: true/.test(userApiText));
  // 拉黑更不能谎报：界面显示「已拉黑」而消息照旧能发进来，是最坏的一种错
  ok('★拉黑 / 解除拉黑断网时也回 degraded（用户以为挡住了，其实没挡）',
    /function block\(toOpenid\)[\s\S]{0,200}degraded:\s*true/.test(userApiText)
    && /function unblock\(toOpenid\)[\s\S]{0,200}degraded:\s*true/.test(userApiText));
  // 页面侧真的读了这个标记（只定义不看等于没改）
  ok('★帖子详情页确实按 degraded 分流提示，而不是照旧提示「已提交」',
    /r && r\.degraded[\s\S]{0,200}没提交上/.test(readProj('sub/forum/detail/detail.js')));
  // 判的是顺序：degraded 分支必须先 return，之后才轮到「记一笔」。
  // 写反了的话断网也会把按钮变灰，用户再也点不了第二次。
  // 两个函数名都认：markReportedComment 是老入口，
  // markCommentReport 是本轮新增的（多记一份处理状态，内部仍会点亮前者）
  ok('★断网时不记「已举报」（否则按钮变灰、再也点不了第二次）',
    /r && r\.degraded[\s\S]{0,300}?return;[\s\S]{0,400}?mark(CommentReport|ReportedComment)/
      .test(readProj('sub/forum/detail/detail.js')));

  // 拉黑确认框要说清「拉黑不是举报」：这是两个不同后果的动作
  const cardJs = readProj('pages/user/card/card.js');
  ok('名片页拉黑确认框区分了「拉黑」与「举报」（两个动作后果完全不同）',
    cardJs.indexOf('不是举报') > 0 && cardJs.indexOf('进管理员的队列') > 0);

  console.log('\n' + (fail ? '✗ ' : '✓ ') + '共 ' + (pass + fail) + ' 项，通过 ' + pass + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(2);
});
