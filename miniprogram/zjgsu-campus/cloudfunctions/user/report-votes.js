// cloudfunctions/user/report-votes.js —— 举报计票与队列分组的**纯函数**
//
// 为什么单开一个文件而不是写在 index.js 里：
//   云函数一 require 就要 wx-server-sdk + 真数据库，本地跑不起来。而这里这两件事
//   恰恰最该被测 —— 它们错的时候**不报错**：
//     · 票数虚高 → 正常内容被自动删掉，作者只会觉得「莫名其妙没了」；
//     · 分组写错 → 同一条内容在队列里出现三遍，审核员对着空气点第二次。
//   所以把口径抽成无副作用的函数，scripts/test-report-votes.cjs 直接灌数据验行为。
//
// 阈值不在这里定：下架 / 删除的门槛在 index.js 的 MOD_RULES 里，
// 本文件只回答两个问题：**几个人**说的、这些举报说的是**哪几件事**。

// 「举报人」而不是「举报内容」的两条链路：私信骚扰、名片冒名
const PERSON_TYPES = ['chat', 'profile'];

function isPersonType(t) {
  return PERSON_TYPES.indexOf(String(t || '')) >= 0;
}

// 一条举报属于哪件「事」。
//   内容：类型 + 内容 id —— 同一条帖被 3 个人举报，是 1 行，不是 3 行
//   人  ：类型 + 被举报人 —— 同一个人被 3 个人指认，也是 1 行
//        （而且这种人肉指控本来就该「这个人被几个人说」，不是三张一模一样的卡）
function groupKey(r) {
  const t = String((r && r.targetType) || 'post');
  const id = isPersonType(t)
    ? String((r && r.target) || '')
    : String((r && r.targetId) || (r && r.target) || '');
  return t + '|' + id;
}

// 数人头：一个人对一条内容只算一票。
//
// ⚠️ 这里是整套「多人举报才动手」的地基。旧版查重键是
//    openid + target + targetId + **reason**，而理由有 8 种 ——
//    同一个人换 3 个理由就能独自推过下架线，换 5 个就够触发直接删除。
//    也就是说「三个人都说不行」实际等于「一个人点几次」。
//    现在写入口收敛成一人一票，这里再按 openid 合并一遍：
//    历史数据（旧版留下的同人多条）也会被算成一张票，不会继续把票数顶高。
//
// excludeOpenid：正在观察期的那个人。他那票照样留痕、照样进人工队列，
//   只是判「要不要自动动手」时不算 —— 所以从这个人头统计里剔掉。
//
// 返回 { total, risky }：total = 有多少**个人**举报，
//   risky = 其中选了高敏理由的人数（同一个人写了两条、一条高敏，只算一个高敏的人）。
function countVoices(list, excludeOpenid, highRisk) {
  const ex = String(excludeOpenid || '');
  const risks = Array.isArray(highRisk) ? highRisk : [];
  const people = Object.create(null);

  (Array.isArray(list) ? list : []).forEach((r) => {
    if (!r) return;
    const who = String(r.openid || '');
    if (ex && who === ex) return;
    // 没有 openid 的老数据没法合并，各自算一票：宁可多算，也别凭空吞掉一票
    const key = who || ('_' + String(r._id || Math.random()));
    const slot = people[key] || (people[key] = { risky: false, rows: 0 });
    slot.rows += 1;
    if (risks.indexOf(String(r.reason || '')) >= 0) slot.risky = true;
  });

  const keys = Object.keys(people);
  return {
    total: keys.length,
    risky: keys.filter((k) => people[k].risky).length
  };
}

// 把一批举报按「事」合并。传进来的顺序就是展示顺序（云端按 at 倒序取），
// 所以合并时保持首次出现的次序，不另外排序 —— 排序是调用方的事。
function groupReports(list) {
  const buckets = Object.create(null);
  const order = [];

  (Array.isArray(list) ? list : []).forEach((r) => {
    if (!r) return;
    const key = groupKey(r);
    let b = buckets[key];
    if (!b) {
      b = buckets[key] = { key: key, rows: [] };
      order.push(key);
    }
    b.rows.push(r);
  });

  return order.map((k) => summarize(buckets[k]));
}

// 一组举报 → 一张卡片要的字段。
// 时间、理由、说明都取**最新那条**：审核员要看的是「现在的状态」，
// 而不是最早那个人当初怎么说的（后者在 reasons 的分布里还看得到）。
function summarize(bucket) {
  const rows = bucket.rows.slice().sort((x, y) => (Number(y.at) || 0) - (Number(x.at) || 0));
  const newest = rows[0] || {};

  // 去重人头：同一个人可能在旧数据里留下好几条
  const people = Object.create(null);
  rows.forEach((r) => {
    const who = String(r.openid || '');
    if (who) people[who] = true;
  });

  // 理由分布。同名理由合并计数，顺序按「先出现的优先、数量多的优先」
  const counts = Object.create(null);
  const firstAt = Object.create(null);
  rows.forEach((r, i) => {
    const name = String(r.reason || '其他');
    counts[name] = (counts[name] || 0) + 1;
    if (firstAt[name] === undefined) firstAt[name] = i;
  });
  const reasons = Object.keys(counts).map((name) => ({ name: name, count: counts[name] }))
    .sort((a, b) => (b.count - a.count) || (firstAt[a.name] - firstAt[b.name]));

  // 说明取最新那条**写了内容的**：最新一条常常是「我也觉得有问题」，一句空话
  const withDetail = rows.filter((r) => String(r.detail || '').trim())[0];

  return {
    key: bucket.key,
    repId: String(newest._id || ''),
    repIds: rows.map((r) => String(r._id || '')).filter(Boolean),
    reason: reasons.length ? reasons[0].name : '其他',
    reasons: reasons,
    detail: withDetail ? String(withDetail.detail) : '',
    time: String(newest.time || ''),
    // 人数优先；整批都没有 openid（极老的数据）时退回记录条数，别显示成 0 人
    reportCount: Object.keys(people).length || rows.length,
    reporterCount: rows.reduce((m, r) => Math.max(m, Number(r.reporterCount) || 0), 0),
    reviewOnly: rows.some((r) => !!r.reviewOnly),
    escalated: rows.some((r) => !!r.escalated),
    targetId: String(newest.targetId || ''),
    targetType: String(newest.targetType || 'post'),
    targetOpenid: String(newest.target || ''),
    rows: rows,     // 原始记录：短信骚扰要合并证据、归档要读处置结果
    last: newest
  };
}

module.exports = {
  countVoices: countVoices,
  groupReports: groupReports,
  groupKey: groupKey,
  isPersonType: isPersonType
};
