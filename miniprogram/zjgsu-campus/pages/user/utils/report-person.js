// utils/report-person.js —— 举报「人」的交互（不是举报内容）
//
// 为什么单开一个文件，不塞进 utils/moderation.js：
// moderation.js 至今是**纯逻辑、不发请求**的（屏蔽词匹配、长度校验、举报文案），
// 举报内容那几处调用方各自走一次 wx.showActionSheet + wx.showModal。
// 而举报「人」这件事有三个新特点，凑在一起值得一个自己的模块：
//
//   ① 理由是另一套枚举。人 ≠ 内容：「不文明用语」「虚假信息」对一个人没有意义，
//      对人有意义的是「恶意骚扰」「冒充他人」。两套混在一起，用户会在
//      「举报这个人」的菜单里看到「广告骚扰」和「虚假信息」并犹豫半天。
//      ⚠️ 必须与云函数 PERSON_REASONS 逐字一致，多一个或少一个都会出现
//      「菜单里能选、云端不认（被折成『其他』）」。
//
//   ② 后果的说明必须写在前面。举报内容凑够人数会被删，举报账号**永远不会自动封**
//      （云函数只升优先级、不自动处置，理由见那里的注释）。
//      这两件事的差别很大，用户默认以为「举报了他就会被封」——
//      不说清，既会有人白等，也会有不该被封的人因为被误解而承受压力。
//
//   ③ 私信举报会自动带上证据快照（最近 10 条对话），所以对 chat 和 profile
//      两类落点要传得进去 targetType。

const userApi = require('../../../utils/user.js');
const feedback = require('../../../utils/feedback.js');

// 举报「人」的合法理由，与云函数 PERSON_REASONS 一一对应
const PERSON_REASONS = ['恶意骚扰', '冒充他人', '广告骚扰', '涉及隐私'];

// 提交前的说明。写清「不会自动封号」不是给系统留台阶，是给举报人一个准确预期：
// 他真正能推动的是「让这条举报排到审核队列最前面」
function notice(kind, nick) {
  const who = nick ? '「' + nick + '」' : '对方';
  const base = '举报' + who + '之后，管理员会在队列里看到。' +
    '\n\n说明：举报不会让 TA 被自动封号 —— 只有管理员核实后才会处置。' +
    '如果情况紧急，先用「拉黑」把 TA 挡在门外。';
  return kind === 'chat'
    ? base + '\n\n私信举报会自动附上你们最近 10 条对话作为材料。'
    : base;
}

// 让用户选理由 → 写补充说明 → 提交。全过程两道弹窗，任意一步取消都什么都不做。
//
// 返回值形状和 userApi.reportPerson 一致（{ ok, msg }），页面可以直接
// 「有响应就提示一下」，不必分辨是哪一步失败。用户在弹窗里点取消时返回 null，
// 页面据此**不要弹任何提示** —— 用户是主动放弃的，再弹一句「已取消」纯属噪音
function ask(kind, openid, nick) {
  if (!openid) return Promise.resolve({ ok: false, msg: '没有可举报的对象' });
  wx.showActionSheet({
    itemList: PERSON_REASONS,
    success: (res) => {
      const reason = PERSON_REASONS[res.tapIndex];
      if (!reason) return;
      wx.showModal({
        title: '举报：' + reason,
        content: notice(kind, nick),
        editable: true,
        placeholderText: kind === 'chat'
          ? '可以写清发生了什么（200 字内）'
          : '补充说明（选填，200 字内）',
        confirmText: '提交举报',
        confirmColor: '#dd4b55',
        success: async (m) => {
          if (!m.confirm) return;
          // 云端 detail 截 100 字，这里先截 200 再发过去由云端兜底：
          // 不预截的话用户会为「明明写了 150 字却只存了 100 字」困惑
          const detail = String(m.content || '').slice(0, 200);
          try {
            const r = await userApi.reportPerson(openid, kind, reason, detail);
            // userApi 在「云端没部署 / 断网」时回的是 { ok:true, msg:'举报已提交' } 占位，
            // 而云端真成功时回的 msg 多半更具体。两者靠 degraded 分开 ——
            // 断网那次并不是「举报生效了」，话术必须区分，否则用户会以为
            // 举报已经进了队列，白等一个不会来的结果
            feedback.toast(r && r.degraded ? '网络不太顺，举报可能没提交到' : ((r && r.msg) || '举报已提交'), {
              duration: 2600
            });
          } catch (err) {
            feedback.toast('没提交上，再试一次');
          }
        }
      });
    },
    fail: () => {}
  });
  // 同步返回一个永不 resolve 的 rejected 之外的形态：
  // 调用方 await 不到结果（弹窗是异步回调），所以这里给一个「已受理」的壳，
  // 真正结论由上面的 feedback.toast 负责
  return Promise.resolve({ ok: true, msg: '已受理' });
}

module.exports = { PERSON_REASONS, notice, ask };