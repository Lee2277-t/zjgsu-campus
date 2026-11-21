// utils/config.js —— 云开发开关配置
// 已启用云端共享：评价/帖子/评论/点赞/同学自建课程 均存到微信云开发，所有用户可见。
// 环境 ID 来自用户微信公众平台「开发 → 开发设置」。
//
// 云端需要的集合（云开发控制台 → 数据库 → 新建集合），一个都不能少：
//   users       —— 个人资料（openid 作 _id，昵称/头像/学院/联系方式）
//   contacts    —— 「想认识」请求与好友关系（status: pending / accepted / rejected）
//   blocks      —— 拉黑名单
//   reports     —— 举报记录
//   posts       —— 论坛帖子（含 courseId / courseName / authorOpenid）
//   reviews     —— 课程评价
//   courses     —— 同学共建课程（官方 928 门课在前端 seed 里，这里只存同学新加的课）
//   admins      —— 审核员名册
//   favorites   —— 收藏（_id = openid，一个人一条）
//   market      —— 失物招领 / 二手交易
//   chats       —— 私信会话
//   resources   —— 学习资料元数据（文件本体在云存储）
//   calendar    —— 校历节点
//   places      —— 校园地点
//   memos       —— 备忘录（个人数据）
//   events      —— 校园活动
//   event_joins —— 活动报名
//   teachers    —— 教师名录
//   course_reqs —— 删除课程的申请
//   post_votes  —— 赞踩记名表（_id = 帖子id_openid，一个用户对一条帖子只有一条）。
//                  计数由这张表统计得出，不再靠 posts.likes 一路 inc 累加
//   app_config  —— 运行配置（订阅消息模板 ID 等）
//
// 注意：早期版本的「点赞记录」likes 集合已经不用了 —— 赞踩收口到 posts 的
// likedBy / dislikedBy 两个数组里。谁要是照着老文档去建 likes，建了也没人写。
// 权限统一设为「所有用户可读，仅创建者可写」。
// users 和 contacts 里的联系方式只在云函数里做过滤后再返回，前端拿不到别人的原始数据。
module.exports = {
  USE_CLOUD: true,
  CLOUD_ENV: 'cloud1-your-env-id',
  // 示例内容开关：false = 不再灌入/展示 16 条示例帖和 14 条示例评价。
  // 关掉后：新环境不再灌种子；本地缓存与云端拉回的示例帖在展示层自动过滤。
  // 课程库（928 门课）不受影响，始终保留。
  KEEP_SEED_CONTENTS: false,

  // 浏览数的显示门槛：低于这个数**不显示**。
  //
  // 为什么不「有就显示」：浏览数在低区间是负资产。一条内容写「3 人看过」，
  // 读者读到的不是「这条没人看」，而是「这个平台没人」—— 校园应用里样本太小，
  // 这两件事读者分不出来。1–10 是负区间，10–50 勉强，50 以上才转正。
  //
  // 定 50 的理由：50 个**独立的人**看过（去重、不含作者），推广期够得着
  // （校园群转发一次就可能过），而且到这一步「有人在用」这句话才立得住。
  // ⚠️ 别调到 20 以下，那还在负区间；觉得太严最多降到 30。
  //
  // 门槛只决定「显不显示」，**不影响举报下架的分档** ——
  // 后者用的是真实浏览人数（含 1、2 这种小数字），跟这里无关。
  VIEW_SHOW_MIN: 50,

  // 订阅消息模板 ID（留空则不弹授权、也不发通知，其他功能照常）。
  // 从 mp 后台「订阅消息 → 公共模板库」选用后把 ID 粘进来。
  // 三个模板对应三种不同通知，按**关键词**认，不按模板名认：
  //   comment —— 我的帖子被留言：模板第二格要「文章标题」
  //   reply   —— 我的留言被回复：模板第二格要「原评论」
  //   chat    —— 收到新的私信：提醒内容 / 温馨提示 / 更新时间
  // 前端只负责「要授权」，真正下发在云函数（云函数那侧也要配 SUBMSG_*）。
  SUBMSG: {
    // 「留言回复通知」：回复人 / 文章标题 / 回复内容 / 更新时间
    // 字段得是 thing1 / thing2 / thing3 / time4
    comment: 'Wl9-nyb5A8TgkqWuVQMkZEbB3znrOPvxgX-AKuhVjrk',
    // 「评论回复通知」：回复者 / 原评论 / 回复内容 / 更新时间
    // 字段得是 thing1 / thing2 / thing3 / time4（和上面那条同名不同内容：这格第二格是「原评论」）
    reply: 'eidM0dYYAqlFapVyvT144sSUK0pxginWmItFAcgN-ZY',
    // 「新信件提醒」：提醒内容 / 温馨提示 / 更新时间（thing1 / thing2 / time3）
    chat: '005M-ET7zREZMxsyx0Gqy9Oe-FCmTvjtdzwPgMXRliQ'
  },

  // 审核员白名单（前端展示用：决定「我的」页显不显示内容审核 / 复制身份 ID / 环境自检）。
  // ⚠️ 真正的门禁在云函数环境变量 MODERATORS 里，两边要一起维护 ——
  //    这份只管「入口显不显示」，改了这里的名单并不给谁开权限。
  // 留空时这三个入口对所有人隐藏；填 openid 后，名单里的人在「我的」页能看到这些入口。
  MODERATORS: ['oXXXXXXXXXXXXXXXXXXXXXXXXXXX'],

  // 审核相关：目前只留一个展示用的标签。
  // ⚠️ 想改自动处置的门槛，别在这里找 —— 这一大串阈值曾经照着云函数抄了一份，
  //    但审核页 wxml 里的「3 人下架 / 5 人删除」是写死的文案，压根不读这里，
  //    结果是整整 20 个键没人引用，纯属两份会各自漂移的死数据，已经删掉。
  //    真正的权威值在两处：云函数 cloudfunctions/user 的 MOD_RULES（生效的那份），
  //    utils/moderation.js 的词表与原因清单（即时提示用的那份）。
  MODERATION: {
    ABUSER_BADGE: '观察期' // 观察期内在审核队列里显示的标签
  }
};
