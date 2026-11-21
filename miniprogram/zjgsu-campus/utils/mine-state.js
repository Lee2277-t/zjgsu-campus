// utils/mine-state.js —— 「我发的那条现在还挂着吗」
//
// 闲置和活动被举报处置之后（自动下架 / 审核删除），公开列表里就查不到了：
// 云端过滤一次、本地读侧再过滤一次。可作者手里那份缓存还停在「上次看到的样子」——
// 在「我发布的」里正常显示，点进去却说「这条记录不见了」，也不知道是被谁动了。
//
// 所以每次进「我发布的」都跟云端对一次账，把 hidden / deleted 落回本地。
// 这段合并逻辑两边一字不差，抽出来共用，也省得写两份测试。

// list   本地缓存数组
// states 云端给的 [{id, hidden, deleted}]；传 null 表示这一侧没读到
//
// 返回 { list, dropped, paused, degraded }
//   dropped 这次清掉几条（云端说已删除）
//   paused  现在处于暂停展示的有几条（给页面做提示用）
function mergeStates(list, states) {
  const src = Array.isArray(list) ? list : [];
  // 读不到就原样返回，一个字都不动。
  // 否则一次网络抖动就能把作者整个列表清空 —— 那种 bug 用户会当成「我的东西全没了」
  if (!Array.isArray(states)) {
    return { list: src, dropped: 0, paused: 0, degraded: true };
  }
  const map = {};
  states.forEach((s) => { if (s && s.id) map[String(s.id)] = s; });

  const out = [];
  let dropped = 0;
  let paused = 0;
  src.forEach((it) => {
    if (!it || !it.id) return;
    const s = map[String(it.id)];
    // 云端这次没提到它：可能是老数据、也可能刚发完还没同步上去。
    // 一律保留 —— 「没返回」不等于「不存在」，凭这个删本地是最伤人的一种自作聪明
    if (!s) { out.push(it); return; }
    if (s.deleted) { dropped += 1; return; }
    const hidden = s.hidden === true;
    if (hidden) paused += 1;
    if ((it.hidden === true) === hidden) { out.push(it); return; }
    out.push(Object.assign({}, it, { hidden: hidden }));
  });
  return { list: out, dropped: dropped, paused: paused, degraded: false };
}

// 把云端回传的「我这条被下架了」的完整内容补进本地。
//
// 为什么需要这一步：换台设备就是一份空缓存，而公开列表永远查不到被下架的内容。
// 只靠 id / hidden 去对账，那条东西在「我发布的」里根本不会出现 ——
// 恢复入口对「换过手机的人」等于不存在，而这恰恰是最容易撞上误伤的场景
// （新设备登录、缓存被清、重装）。
function adoptPaused(list, docs) {
  const src = Array.isArray(list) ? list : [];
  if (!Array.isArray(docs)) return { list: src, added: 0 };
  const seen = {};
  src.forEach((x) => { if (x && x.id) seen[String(x.id)] = true; });
  const out = src.slice();
  let added = 0;
  docs.forEach((d) => {
    if (!d || !d.id || d.deleted === true) return;
    const id = String(d.id);
    if (seen[id]) return;
    seen[id] = true;
    // 打上 hidden：它不该出现在公开列表里，只该出现在「我的」
    out.push(Object.assign({}, d, { hidden: true }));
    added += 1;
  });
  return { list: out, added: added };
}

module.exports = { mergeStates, adoptPaused };
