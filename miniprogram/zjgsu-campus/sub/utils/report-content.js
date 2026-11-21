// utils/report-content.js —— 举报「内容」的交互（帖子 / 评价 / 闲置 / 活动 / 留言）
//
// 为什么单开一个文件：
// 举报内容这件事在六七个页面里各写了一遍 wx.showActionSheet + wx.showModal，
// 每次都是 30 行。真正麻烦的是它们会各改各的：有一处加了「匿名报不了」的拦截，
// 另一处没有；有一处提交后刷新列表，另一处不刷新 —— 看起来都是「举报了」，
// 用户拿到的结果不一样。收成一份，行为就只有一个口径。
//
// 与 utils/report-person.js 的分工：
//   那个人 → 只累计、永不自动处置，理由枚举是另一套（PERSON_REASONS）
//   这个内容 → 凑够人数会被自动下架 / 删除，理由枚举是 moderation.REPORT_REASONS

const userApi = require('../../utils/user.js');
const feedback = require('../../utils/feedback.js');
const moderation = require('../../utils/moderation.js');

// 各种内容在补充弹窗里给的例子。写具体场景不是为了好看：
// 举报框里那句灰字是用户唯一能看到的「什么样算违规」的说明，
// 空泛的「请补充说明」会让人以为随便写，写出来的东西没法作为处置依据
const PLACEHOLDER = {
  review: '例如：这条在推销校外培训班',
  post: '例如：这个帖子在刷单引流',
  market: '例如：这条不是失物，是广告',
  event: '例如：这个活动在收费拉人',
  comment: '例如：这条留言在发广告',
  resource: '例如：这份资料与标题不符，或夹带广告'
};

/**
 * 选理由 → 补充说明 → 提交。
 *
 * @param {string} targetId   内容 id
 * @param {string} targetType review / post / market / event / comment
 * @param {object} opts
 *   opts.openid   作者 openid。**可以为空**：匿名评价的作者由云端按内容认定，
 *                 前端拿不到也照样能举报（见云函数 report 里 ① 的说明）。
 *                 早期版本在这里就 return 了，结果最需要被举报的匿名内容一条都报不了。
 *   opts.placeholder 覆盖默认的补充例子
 *   opts.onDone  提交后的回调，收到云端返回的 r（含 action）。
 *                服务端当场下架 / 删除时，页面要拿它去刷新列表 ——
 *                不刷新的话，用户举报完看到内容还在，会以为没生效
 * @returns {Promise<null>} 弹窗是异步回调，这里不 resolve 真实结果 ——
 *          与 report-person.js 同一套口径：结论由 feedback.toast 直接告诉用户
 */
function ask(targetId, targetType, opts) {
  opts = opts || {};
  if (!targetId) return Promise.resolve(null);
  const type = String(targetType || 'post');
  const placeholder = opts.placeholder || PLACEHOLDER[type] || '补充说明（选填）';

  wx.showActionSheet({
    itemList: moderation.REPORT_REASONS,
    success: (res) => {
      const reason = moderation.REPORT_REASONS[res.tapIndex];
      if (!reason) return;
      wx.showModal({
        title: '举报：' + reason,
        content: moderation.reportTip(reason),
        placeholderText: placeholder,
        editable: true,
        confirmColor: '#d9534f',
        success: async (m) => {
          if (!m.confirm) return;
          // 作者交给云端认定，这里照实传（匿名时是空串）—— 不在这里判空。
          // 判空等于前端替服务端决定「这条能不能举报」，而前端恰恰没有足够信息
          const r = await userApi.reportPost(
            String(opts.openid || ''), reason,
            String(m.content || '').slice(0, 200), targetId, type
          );
          // 断网时云端一条记录都没写。谎报「已提交」会让用户以为这一票算进去了，
          // 而服务端正要靠「凑够人数」才自动处置
          if (r && r.degraded) {
            feedback.toast('网络不太顺，没提交上');
            return;
          }
          if (r && r.ok === false) {
            feedback.toast((r && r.msg) || '没提交上，再试一次');
            return;
          }
          if (opts.onDone) opts.onDone(r || {});
          feedback.toast((r && r.msg) || '已提交');
        }
      });
    },
    fail: () => {}
  });

  return Promise.resolve(null);
}

module.exports = { ask, PLACEHOLDER };
