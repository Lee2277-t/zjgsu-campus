// cloudfunctions/user/report-rules.js —— 举报门槛的分档表（纯函数）
//
// 为什么门槛要跟浏览量挂钩：
//   固定「3 个人举报就下架」对两种内容是两件完全不同的事。
//   一条只有 8 个人看过的帖子，3 个人说不行 = 37%，那确实有问题；
//   一条 800 个人看过的帖子，3 个人说不行 = 0.4%，多半只是三个人看不顺眼。
//   而后者恰恰是最容易被举报三次的 —— 看得人越多，遇到「不同意」的人越多。
//   固定门槛惩罚的是「火」，不是「坏」。
//
// 所以门槛按**独立浏览人数**分档：冷门内容 3 人就能藏起来（成本低、救得回），
// 热门内容要 10 个人。封顶 10 是刻意的：再火的内容也不能要求「无限多的人」
//   才肯下架，否则热门违规内容等于免检。10 个不同的人说不行，
//   在校园应用里已经是明确的信号了。
//
// 为什么不用连续公式（比如 3% 的曝光率）：
//   分档表能直接说给用户听 ——「这条有 200 多人看过，要 5 个人举报才会下架」。
//   百分比算出来是 3.47% 这种数字，解释成本高，边界还会因为一票之差来回跳。
//
// ⚠️ 这张表只决定**下架**（hide）。删除一律人工，不给任何人数门槛 ——
//    删除不可逆，一旦自动删了，作者申诉、同学举证、撤回投诉全都失去了凭据。
//
// 改这张表 = 改全网的下架速度。改完必须跑 scripts/test-report-thresholds.cjs，
// 它会验边界（49/50/199/200/499/500）、单调递增、封顶。

// max 是这一档的**上界（不含）**：views < max 就落这一档。
// 49 → 3 人，50 → 5 人 —— 边界往下取，宁可稍严，也别让刚好 50 人看过的内容
// 因为「少一票」的取整差异落在更松的档里。
const VIEW_TIERS = [
  { max: 50, need: 3 },      // 几乎没人看：3 个人说不行就够了
  { max: 200, need: 5 },
  { max: 500, need: 7 },
  { max: Infinity, need: 10 } // 500 人以上：封顶 10 人
];

// 一条内容要下架，需要多少个**不同的人**举报。
// views 是独立浏览人数（去重、不含作者本人，见 index.js 的 countViews）。
//
// 没有浏览量数据时（老内容、统计没跑起来、count 失败）一律按 0 处理 →
// 落到第一档 3 人。这是**改造前的原始门槛**，不是「更松」：
// 宁可临时按老规矩办，也不要因为读不到浏览量就把门槛抬高，
// 那样会让举报的人点完什么都没发生。
function hideNeed(views) {
  const v = Number(views) > 0 ? Number(views) : 0;
  for (let i = 0; i < VIEW_TIERS.length; i += 1) {
    if (v < VIEW_TIERS[i].max) return VIEW_TIERS[i].need;
  }
  return VIEW_TIERS[VIEW_TIERS.length - 1].need;
}

// 低可信单票自动筛除：只有一个人举报、没有可核实说明、没有命中屏蔽词、
// 不是高敏理由、也不是观察期举报时，只归档、不进人工队列。
// 不处罚举报人；多人举报、带说明、高敏理由和屏蔽词命中仍会进入人工审核。
function shouldAutoDismiss(info) {
  const x = info || {};
  return !x.guarded && !x.blocked && !x.highRisk && !x.reporterLimited
    && Number(x.total) <= 1 && String(x.detail || '').trim().length < 4;
}

// 给审核员看的一句话：这条为什么需要这么多人。
// 审核队列里光显示「还差 3 人」不够 —— 差 3 人可能因为没人管，
// 也可能因为这条有 900 人看过。后者根本不用管，前者要盯着。
function describe(views) {
  const v = Number(views) > 0 ? Number(views) : 0;
  const need = hideNeed(v);
  return v > 0 ? v + ' 人看过，需 ' + need + ' 人举报' : '暂无浏览数据，按 ' + need + ' 人算';
}

module.exports = {
  VIEW_TIERS: VIEW_TIERS,
  hideNeed: hideNeed,
  shouldAutoDismiss: shouldAutoDismiss,
  describeTier: describe
};
