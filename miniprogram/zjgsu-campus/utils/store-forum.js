// utils/store-forum.js —— 校园论坛（帖子 / 投票 / 点赞 / 树洞互动 / 举报 / 审核置顶）
// 基础设施（KEYS / read / write / 墓碑 / 工具函数）统一来自 store-base.js；
// 跨模块调用通过 require 同级 store-* 模块获取，不跨文件改写逻辑。

const { KEYS, read, write, myOpenid, cloud, commentTomb, notTombstoned, addTombstone, HOLE_BOARD, waitOpenid, nowText, genId } = require('./store-base.js');
const { getUser } = require('./store-user.js');
// 这里不再直接弹提示：留言成功 / 失败 / 图被云端吞掉，都由页面拿到
// addComment 返回的 done 之后再决定说什么（页面才知道该不该先收键盘）

/* ---------------- 匿名代号 ---------------- */

// 匿名名的词池（两字为主，好记、也不像真名）。
//
// ⚠️ 池子只有一百多个词，**偶尔会撞名**，这是有意的取舍：
// 撞名意味着「两个不相干的匿名帖恰好同名」，读者会当成两个同名的人，
// 不会因此把两个人的历史串起来 —— 方向对隐私有利。
// 反过来把池子做成几千个也换不来多少隐私，因为真正的底线是
// 「不按 openid 取名」，而不是「名字够独特」。
const ANON_WORDS = [
  // 植物
  '青柠', '薄荷', '橘子', '梧桐', '白鹭', '柚子', '芒果', '蓝莓', '青柚', '银杏',
  '枫叶', '柳絮', '蒲公英', '苔藓', '木棉', '栀子', '茉莉', '桂花', '竹叶', '松果',
  '栗子', '葡萄', '樱桃', '草莓', '桑葚', '杨梅', '枇杷', '石榴', '甘蔗', '莲藕',
  // 吃的
  '蘑菇', '海带', '紫菜', '豆浆', '油条', '烧麦', '汤圆', '年糕', '麻薯', '布丁',
  '奶盖', '拿铁', '美式', '可可', '抹茶', '蜜桃', '西瓜', '哈密瓜', '杏仁', '芝麻',
  // 动物
  '贝壳', '海星', '水母', '鲸鱼', '海豚', '企鹅', '松鼠', '刺猬', '狐狸', '兔子',
  '猫咪', '柴犬', '柯基', '仓鼠', '麋鹿', '山雀', '燕子', '麻雀', '海鸥', '蜻蜓',
  // 日常物件
  '路灯', '旧书', '雨伞', '单车', '纸鹤', '信笺', '钢笔', '粉笔', '黑板', '课桌',
  '台灯', '闹钟', '邮筒', '车票', '钥匙', '窗台', '楼梯', '操场', '跑道', '食堂',
  '天桥', '渡口', '码头', '风铃', '沙漏',
  // 时间与氛围
  '晚风', '清晨', '午后', '黄昏', '深夜', '初雪', '春分', '白露', '霜降', '小满',
  '惊蛰', '谷雨', '立夏', '秋分', '冬至', '云朵', '月牙', '南桥', '麦田', '星空',
  '萤火', '潮汐', '微风', '薄雾', '晴空'
];

// FNV-1a 字符串哈希。
//
// 用它而不是 Math.random 的原因：前端每次进页面都要重算一遍代号，
// 真随机会让**同一条帖子每打开一次换一个名字** —— 读者连「刚才那条」都对不上，
// 楼里的对话关系也散了。按 id 哈希则是确定的：同一条帖子永远同一个名字，
// 不落库也不会变，换设备、重新同步都一致。
function hashStr(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 一条内容算不算匿名。口径有两条：字段为真，或发在树洞板块。
//
// 光看 anonymous 字段不够 —— 树洞是「强制匿名」的板块，万一某条历史数据
// 把这个字段弄丢了，它就会实名挂在那儿。云端 isAnonContent 用的也是这两条，
// 两边必须一致，否则会出现「帖子匿名、评论区实名」这种半截状态。
function isAnonPost(post) {
  const p = post || {};
  return !!p.anonymous || String(p.board || '') === HOLE_BOARD;
}

// 匿名代号：同一个 nameSeed 永远得到同一个名字。
//
// nameSeed 只允许两种：
//   ① 帖子 id            —— 楼主（主贴和他在评论区说的话都用它，读者才对得上）
//   ② 帖子 id + openid   —— 其他留言者（同帖内稳定能对话，跨帖串不起来）
// 绝不允许直接传 openid：那正是改造前的老毛病，一个人发过的所有匿名内容
// 会被连成一条线，「匿名」只剩「不知道真名」。
//
// ⚠️ 参数名别叫 seed —— store-base 里有个同名导出，check-store-refs
// 会把它当成「用了没 require」当场报红
function anonCodeOf(nameSeed) {
  return '匿名·' + ANON_WORDS[hashStr(nameSeed) % ANON_WORDS.length];
}

/* ---------------- 校园论坛 ---------------- */

// 课程 / 闲置 / 失物 / 组队已经有独立主页面，继续在论坛话题里重复出现只会让
// 筛选栏变成一排同义词。旧帖子保留，只隐藏这四类话题入口。
const HIDDEN_BOARD_NAMES = { '课程评价': 1, '闲置分享': 1, '失物招领': 1, '活动组队': 1 };
function getBoards() {
  return read(KEYS.boards, []).filter((b) => b && !HIDDEN_BOARD_NAMES[String(b.name || '')]);
}

// 审核员白名单：和云函数里的 MODERATORS 一致，这里只决定「我能不能看到被下架的内容」
function isModerator() {
  const list = (cloud.cfg.MODERATORS) || [];
  const oid = myOpenid();
  return !!oid && Array.isArray(list) && list.indexOf(oid) >= 0;
}

// 内容可见性：被下架的内容，只有作者本人和审核员还能看到（方便申诉恢复）
function visibleToMe(p) {
  if (!p.status || p.status === 'normal') return true;
  return isMinePost(p) || isModerator();
}

// 我在这条帖子上的投票：'like' / 'dislike' / ''（没投过）。
// 老版本只存了「赞没赞」的布尔值，这里读的时候顺手认下来，升级后不会丢点赞状态
function myVote(postId) {
  const votes = read(KEYS.voteSet, {});
  if (votes[postId]) return votes[postId] === 'dislike' ? 'dislike' : 'like';
  const old = read(KEYS.likedSet, {});
  return old[postId] ? 'like' : '';
}

// 给帖子补上 liked / disliked 标记与图片兜底（老帖没有 images 字段）
// 云端写库会自动补一个 _openid，这里统一成 openid，避免「我的帖子」认不出来
function decoratePost(p) {
  const oid = p.openid || p._openid || p.authorOpenid || '';
  const status = p.status || 'normal';
  const vote = myVote(p.id);
  // 匿名帖：昵称换成代号、头像留空。WXML 的 {{}} 里不能调方法，
  // 所以代号必须在这里算好再交给模板。
  //
  // 代号**按帖子 id 算**，不按 openid 算。
  // 以前取的是 openid 后四位 —— 同一个账号每发一条都是同一个名字，
  // 看过两条就把人串起来了（「这人又发了」「这两条是同一个人写的」），
  // 匿名只剩「不知道真名」，等于把人发过什么全交代了。
  // 按 id 算之后：同一条帖子永远同一个名字，不同帖子名字不同，跨帖串不起来。
  const anon = isAnonPost(p);
  const anonCode = anonCodeOf(p.id || p.time || '');
  const tomb = commentTomb();
  // 被删掉的留言（多人举报自动删 / 帖主手动删）要在展示层挡掉：
  // 云端那一刀砍的是帖子的 comments 数组，本地缓存却只在同步时整条替换，
  // 不同步的页面上那条留言就会一直挂着，看着像举报没生效
  const shown = (p.comments || []).filter((c) => !c.removed && !tomb[c.id]);
  return Object.assign({}, p, {
    openid: oid,
    pinOrder: Number(p.pinOrder) || 0,
    // 作者身份统一兜底：老帖只有云端自动写入的 _openid（没有 authorOpenid 字段），
    // 详情页「看TA的主页」依赖 authorOpenid，这里补齐，旧帖也能点进名片
    authorOpenid: p.authorOpenid || oid,
    status: status,
    // 云端历史数据里的 time 可能是旧版按 UTC 写出来的；at 是绝对时间，
    // 用本机时区重新格式化，能同时修正新帖和历史帖。
    time: displayTimeOf(p.at, p.time),
    hidden: status !== 'normal',
    // 帖子类型：'topic' 是「只发标题」的主题帖（信息收在评论区），
    // 'vote' 是投票帖（数据在 vote 字段，展示数据在 voteData）。
    // 老帖没有这个字段，一律按 'normal' 当普通帖处理
    kind: p.kind === 'topic' ? 'topic' : (p.kind === 'vote' ? 'vote' : 'normal'),
    // 留言条数单独给一份：信息墙页面上「N 条信息」是标题的一部分，
    // 让模板去数 comments.length 既啰嗦又容易和「N 条评论」看串。
    // 拆表之后**以云端的 commentCount 为准** —— 本地 comments 只是缓存，
    // 没打开过详情页时它是空的，拿它当总数会把「12 条留言」显示成 0
    commentCount: Number.isFinite(Number(p.commentCount)) ? Number(p.commentCount) : shown.length,

    liked: vote === 'like',
    disliked: vote === 'dislike',
    // 赞踩数一律由「基线 + 我这一票」算出，不再直接读帖子上的 likes 字段。
    // 帖子上的数字是云端同步来的权威值，只作为基线的来源，不直接上屏 ——
    // 否则「点一下 → 本地 +1 → 云端旧值盖回来」这种来回会让数字反复跳
    // 展示数字直接信云端同步下来的权威值；不再用本地 baseline 反算。
    // 来回点赞导致“越点越少”的根，就是 baseline 和旧计数互相扣减。
    likes: Math.max(0, Number(p.likes) || 0),
    dislikes: Math.max(0, Number(p.dislikes) || 0),
    // 树洞三连（抱抱 / 递茶 / 摸摸头）：计数和「我点过没」都在数据层算好。
    // 列表页和详情页读的是同一份，两边数字与高亮永远一致 ——
    // 详情页点了抱抱，回到列表立刻是亮着的，不需要额外的同步代码
    react: reactCounts(p.id, p),
    myReact: myReact(p.id),
    comments: shown,
    images: p.images || [],
    anonymous: anon,
    anonCode: anonCode,
    showAuthor: anon ? anonCode : (p.author || '浙小商'),
    // 匿名帖一律走「默认头像 + 默认名」：头像留空（前端渲染成「匿」字圆），
    // 名字用上面的代号。真实头像一亮出来，前面那串代号就白取了 ——
    // 头像是全校唯一能一眼认人的东西，匿名帖挂上它等于当众点名
    showAvatar: anon ? '' : (p.avatarUrl || ''),
    // 文字头像的取字也在这里算好：WXML 的 {{}} 里调不了 charAt。
    // 匿名帖固定「匿」，不再从代号的「匿」字上取，语义更直白
    avatarText: anon ? '匿' : String(p.author || '浙小商').charAt(0),
    // 置顶帖由审核员在云端设置，这里只负责带到界面上显示徽标。
    // 限时置顶到点即失效 —— 判断放在 pinAliveNow 里，
    // 列表、「置顶」类别、管理页的置顶计数用的是同一个口径
    pinned: pinAliveNow(p),
    pinUntil: Number(p.pinUntil) || 0,
    // 热榜排行号由页面算好传进来，这里只留热度分
    hotScore: hotScore(p),
    // 投票帖的展示数据：WXML 的 {{}} 里调不了函数，票数、百分比、
    // 「我投过没」都必须在这里算好再交给模板（vote-card 和概览条共用）
    voteData: buildVoteData(p)
  });
}

// ---- 投票帖 ---------------------------------------------------------------
// 数据模型（存在 post.vote 里，随帖子本体一起本地落库 / 上云）：
//   options:   [{ id: 'o1', label, votes }]  选项与票数
//   multiple:  true=多选 / false=单选
//   deadlineAt: 截止时间戳（毫秒），过了就是「已结束」
//   anonymous: 是否匿名投票
//   voters:    { openid: [选项id] }  记名投票表 —— 票数永远从它重算，
//              计数和记录各写各的迟早打架（评价重复 bug 的同款教训）
function buildVoteData(p) {
  const v = p && p.vote;
  if (!v || !Array.isArray(v.options) || v.options.length < 2) return null;
  const myOid = myOpenid() || 'local';
  const voters = v.voters && typeof v.voters === 'object' ? v.voters : {};
  // 每个选项的票数从 voters 重算：单一事实来源，永不出现「票数对不上」
  const counts = {};
  Object.keys(voters).forEach((k) => {
    (voters[k] || []).forEach((oid2) => { counts[oid2] = (counts[oid2] || 0) + 1; });
  });
  const options = v.options.map((o) => ({
    id: o.id,
    label: o.label,
    votes: counts[o.id] || 0
  }));
  const ended = v.deadlineAt ? Date.now() > Number(v.deadlineAt) : false;
  // 我的投票：优先认 voters 里的记录（云端权威），openid 没到手时投的
  // 那份在本机 pollVotes 里也存了一份，两边都查 —— 不然投完刷新身份，
  // 「已投票」变回「没投」，会诱导同一个人再投一次
  const localMine = read(KEYS.pollVotes, {})[p.id] || [];
  const myOptionIds = (Array.isArray(voters[myOid]) && voters[myOid].length)
    ? voters[myOid]
    : (ended ? [] : localMine);
  const hasVoted = myOptionIds.length > 0;
  // ⚠️ 两个数字必须分开算，混用就是「顶部 1 人、底部 2 人」的由来：
  //   参与人数 = 投票的人头数（voters 去重）
  //   总选择数 = 各选项被选次数之和（多选时一个人贡献多条）
  // 顶部概览条和底部 vote-card 都读 totalVotes，口径因此永远一致
  const totalVotes = Object.keys(voters).length;
  const totalSelections = options.reduce((t, o) => t + o.votes, 0);
  // 百分比按「最大余数法」分配，保证各项相加恰好 100%。
  // 逐项四舍五入会出现 33%+33%+33%=99% 或 67%+33%=101% 这种看着就不对的数
  const withPct = largestRemainder(options, totalSelections);
  const remainingMs = Math.max(0, (Number(v.deadlineAt) || 0) - Date.now());
  return {
    options: withPct,
    multiple: !!v.multiple,
    anonymous: v.anonymous !== false,
    ended: ended,
    remainingHours: ended ? 0 : Math.ceil(remainingMs / 3600000),
    // 参与人数（人头）—— 界面上所有「N 人已参与」都读它
    totalVotes: totalVotes,
    // 总选择数（多选时大于人数）—— 百分比的分母，单独给模板用
    totalSelections: totalSelections,
    hasVoted: hasVoted,
    myOptionIds: myOptionIds
  };
}

// 最大余数法分配百分比：先按整数部分分，剩下的名额按小数部分从大到小补，
// 分完必然刚好 100%。total=0 时全给 0（一张还没人投的投票不该显示 NaN%）
function largestRemainder(options, total) {
  if (!total) return options.map((o) => Object.assign({}, o, { pct: 0 }));
  const raw = options.map((o) => {
    const exact = (o.votes / total) * 100;
    return { opt: o, exact: exact, floor: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let used = raw.reduce((t, x) => t + x.floor, 0);
  const left = 100 - used;
  // 小数部分大的先补；一样大时票数多的先补（并列时结果稳定，不会每次刷新都跳）
  const order = raw.slice().sort((a, b) => (b.rest - a.rest) || (b.opt.votes - a.opt.votes));
  for (let i = 0; i < left && i < order.length; i += 1) order[i].floor += 1;
  // left 可能为负（浮点误差下 floor 之和偶尔到 101），这时从余数最小的开始退
  if (left < 0) {
    const back = raw.slice().sort((a, b) => (a.rest - b.rest) || (a.opt.votes - b.opt.votes));
    for (let i = 0; i < -left && i < back.length; i += 1) {
      if (back[i].floor > 0) back[i].floor -= 1;
    }
  }
  return raw.map((x) => Object.assign({}, x.opt, { pct: x.floor }));
}

// 投一票。本地先行（断网/云函数没部署也能投），云端 best-effort 同步。
// 返回最新的 voteData，详情页拿它直接刷新界面，不用再查一遍
function castVote(postId, optionIds) {
  const posts = read(KEYS.posts, []);
  const p = posts.find((x) => x.id === postId);
  if (!p || p.kind !== 'vote' || !p.vote) return { ok: false, msg: '这条不是投票帖' };
  const v = p.vote;
  if (v.deadlineAt && Date.now() > Number(v.deadlineAt)) {
    return { ok: false, msg: '投票已结束' };
  }
  const valid = {};
  (v.options || []).forEach((o) => { valid[o.id] = true; });
  let ids = (Array.isArray(optionIds) ? optionIds : [optionIds])
    .map(String).filter((x) => valid[x]);
  if (!ids.length) return { ok: false, msg: '先选择一个选项' };
  // 单选只认第一个：就算前端传来多个，也按单选规则收
  if (!v.multiple) ids = [ids[0]];
  const myOid = myOpenid() || 'local';
  v.voters = v.voters && typeof v.voters === 'object' ? v.voters : {};
  if (Array.isArray(v.voters[myOid]) && v.voters[myOid].length) {
    return { ok: false, msg: '你已经投过票了' };
  }
  v.voters[myOid] = ids;
  write(KEYS.posts, posts);
  // 本机再记一份：openid 之后才到手时，「已投过」的判断靠它兜底
  const mine = read(KEYS.pollVotes, {});
  mine[postId] = ids;
  write(KEYS.pollVotes, mine);
  // 云端同步：服务端按它自己的 context openid 再记一遍（防刷票的权威源）。
  // 失败不拦着 —— 本地结果已经生效，跟发帖「本地先行」是同一套策略
  if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
    try {
      require('./user.js').voteCast(postId, ids).catch(() => {});
    } catch (e) { /* 云函数模块出问题不拦本地投票 */ }
  }
  return { ok: true, voteData: buildVoteData(p) };
}

// 热度 =（点赞 - 点踩 + 评论×2）× 时间衰减。
// 只按点赞排会让「上学期的高赞帖」永远霸榜，新帖永远出不了头，
// 所以 72 小时外的帖衰减到两成，热榜才天天有新东西。
// 点踩进分子：踩得多的帖子热度往下掉，热门榜才不会长期被同一批人霸着。
function hotScore(p) {
  const at = Number(p.at) || 0;
  const hours = at ? (Date.now() - at) / 3600000 : 999;
  const decay = Math.max(0.2, 1 - hours / 72);
  const likes = Number(p.likes) || 0;
  const dislikes = Number(p.dislikes) || 0;
  // 留言数改读云端维护的 commentCount：留言已经拆到独立集合，
  // 帖子文档里不再带留言数组，本地缓存里那几条只是「上次打开详情页看到的」
  const comments = Number(p.commentCount) || (p.comments || []).length;

  return Math.round((likes - dislikes + comments * 2) * decay * 10) / 10;
}

// 判断某条帖子是不是「我」发的：
// ① 我的 openid 和帖子的 openid 都在手 → 严格比对，这是最可靠的一档；
// ② 其中一边还没有身份（我的 openid 没取回来 / 老帖没身份字段）→ 按作者昵称兜底。
//    之前「帖子带 _openid 但我的 openid 还没拿到」时直接判否，
//    结果云端同步回来的自己的帖子反而认不出，变成「无人贴」、删除按钮也消失
function isMinePost(p) {
  const myOid = myOpenid();
  const pOid = p.openid || p._openid || p.authorOpenid || '';
  if (myOid && pOid) return pOid === myOid;
  return !!p.author && p.author === getUser().nickName;
}

// 公开列表只看正常内容：任何被下架的（不管是自己的还是别人的）都不进列表，
// 但作者本人 / 审核员仍能通过 getPostById 打开它，方便申诉和恢复
// hole=true 表示树洞页要数据：只出树洞板块；默认主论坛：树洞帖一律不混入
function getPosts({ board = '全部', sort = 'latest', courseId = '', hole = false } = {}) {
  let list = read(KEYS.posts, []).map(decoratePost)
    .filter(notTombstoned('posts'))
    .filter((p) => !p.hidden);
  if (hole) {
    list = list.filter((p) => p.board === HOLE_BOARD);
  } else if (!board || board === '全部') {
    list = list.filter((p) => p.board !== HOLE_BOARD);
  } else {
    list = list.filter((p) => p.board === board);
  }
  if (courseId) {
    list = list.filter((p) => p.courseId === courseId);
  }
  // 排序：最新 / 热门（带时间衰减）/ 最多赞 / 最多踩 / 最多评论 / 置顶。
  // 「置顶」类别必须先于 SORTS 兜底判断：SORTS 里没有 pinned 这一档，
  // 先兜底的话 pinned 会被改写成 latest，切过去就像「没反应」（逻辑测试抓过这个错）
  if (sort === 'pinned') {
    // 「置顶」类别：只出置顶帖，按置顶时间新→旧。运营位单独一档，
    // 不再混进普通排序里
    return list.filter((p) => p.pinned)
      .sort((a, b) => {
        const ao = Number(a.pinOrder) || 0;
        const bo = Number(b.pinOrder) || 0;
        if (ao && bo) return ao - bo;
        if (ao) return -1;
        if (bo) return 1;
        return (Number(b.pinnedAt) || 0) - (Number(a.pinnedAt) || 0);
      });
  }
  const s = SORTS[sort] ? sort : 'latest';
  list = list.slice().sort(SORTS[s]);
  // 置顶帖在普通分类里按原有排序正常出现，不强制压到最上面
  // ——「置顶」已经有单独的类别档承接，普通列表只保留「置顶」徽标，
  // 不因置顶打乱各类别原有的排序
  return list;
}

// 排序用的真实时间戳。
//
// ⚠️ 绝不能拿 time 字段比大小 —— 那是**给人看的展示串**，不是可排序的值：
//   · 本地刚发的帖子写的是 today()，只有「2026-10-17」，没有时分；
//   · 云端同步下来的帖子写的是 now()，是「2026-10-17 08:30」，比上面那个**长**。
//   字符串比较里「更长」就更大，于是「刚刚发的」永远排在「今天早上那条」后面，
//   用户看到的就是「最新分类里新帖跑到老帖后面」。日期跨天时更乱。
//
// 正确做法是一律用 at（毫秒时间戳）比；只有老数据没有 at 时才回退解析一次 time，
// 且必须把日期里的 `-` 换成 `/` —— iOS / 微信内置引擎不认 `2026-10-17 08:30` 这种写法，
// 直接 Date.parse 会得到 NaN。
function displayTimeOf(at, fallback) {
  const n = Number(at);
  if (!(n > 0)) return String(fallback || '');
  const d = new Date(n);
  const p = (x) => (x < 10 ? '0' + x : '' + x);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function atOf(p) {
  const n = Number(p && p.at);
  if (n > 0) return n;
  const t = String((p && p.time) || '').trim();
  if (!t) return 0;
  const ms = Date.parse(t.replace(/-/g, '/'));
  return isNaN(ms) ? 0 : ms;
}

// 几种排法。时间相同时按 id 兜底，免得两条内容顺序在每次刷新之间乱跳
const SORTS = {
  latest: (a, b) => (atOf(b) - atOf(a)) || (a.id < b.id ? -1 : 1),
  hot: (a, b) => ((b.hotScore || 0) - (a.hotScore || 0)) || (atOf(b) - atOf(a)),
  likes: (a, b) => ((Number(b.likes) || 0) - (Number(a.likes) || 0)) || (atOf(b) - atOf(a)),
  dislikes: (a, b) => ((Number(b.dislikes) || 0) - (Number(a.dislikes) || 0)) || (atOf(b) - atOf(a)),
  comments: (a, b) => ((Number(b.commentCount) || 0) - (Number(a.commentCount) || 0)) || (atOf(b) - atOf(a))
};

// 树洞页数据源：只出匿名树洞帖
function getHolePosts(sort) {
  return getPosts({ board: HOLE_BOARD, sort: sort === 'hot' ? 'hot' : 'latest', hole: true });
}

// 被举报暂停展示的内容（不含已经删除的，那个是真没了）。
// 系统只下架、不删除（删除一律人工），所以「暂停展示」是个会长期存在的状态，
// 必须留一个公开出口：作者要知道自己那条怎么了，同学也要能补充举报 ——
// 多出来的票不会自动删内容，但会作为审核员判断的分量留在队列里。
function getHiddenPosts() {
  return read(KEYS.posts, [])
    .map(decoratePost)
    .filter((p) => p.status === 'hidden')
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
}

function getPostById(id) {
  const list = read(KEYS.posts, []);
  const p = list.find((x) => x.id === id);
  if (!p) return null;
  const d = decoratePost(p);
  if (!notTombstoned('posts')(p)) return null;
  return visibleToMe(d) ? d : null;
}

// 内容状态：'normal'（正常）/ 'hidden'（暂停展示）/ 'deleted'（已删除）
// 系统自动处置只走 hidden —— 删除一律人工（见云函数 MOD_RULES 处的说明）。
// 只改本地标记，等下次云端同步会被云端状态覆盖 —— 云端那侧才是最终态
const POST_STATUS_TEXT = {
  hidden: '被举报后暂停展示',
  deleted: '已被删除'
};

function setPostStatus(postId, status) {
  const posts = read(KEYS.posts, []);
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx < 0) return false;
  const next = status === 'hidden' || status === 'deleted' || status === 'normal' ? status : 'normal';
  posts[idx].status = next;
  posts[idx].hiddenReason = POST_STATUS_TEXT[next] || '';
  write(KEYS.posts, posts);
  if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
    // 走云函数而不是直接改库：审核员恢复别人的内容时，客户端没有写权限。
    // 这一路是「服务端已经改过、这里同步一下本地」的内部场景（自动处置 / 审核员操作），
    // 所以不阻塞、也不回滚；用户主动点「恢复」走下面的 restorePost。
    try {
      require('./user.js').setContentStatus(postId, next, 'post');
    } catch (e) {
      // 以前这里把 next（字符串）当对象取 next.status，写进云端的全是 undefined ——
      // 兜底分支自己就坏着，等于没有兜底
      cloud.db().collection('posts').where({ id: postId })
        .update({ data: { status: next, hiddenReason: POST_STATUS_TEXT[next] || '' } })
        .catch(() => {});
    }
  }
  return true;
}

// 恢复展示（作者自己发现被误判 / 申诉成功后点的那一下）。
// 顺序是「先云端、后本地」：本地先改的话，云端没改成时下次同步会把「恢复」抹回去，
// 用户看到的是「点了恢复，过一会儿又变回已下架」，比不给按钮更让人迷惑。
// @returns {Promise<{ok:boolean, cloud:string, msg:string}>}
function restorePost(postId) {
  const posts = read(KEYS.posts, []);
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx < 0) return Promise.resolve({ ok: false, cloud: 'skip', msg: '这条内容不在这台设备上' });

  const applyLocal = () => {
    const list = read(KEYS.posts, []);
    const i = list.findIndex((p) => p.id === postId);
    if (i < 0) return;
    list[i].status = 'normal';
    list[i].hiddenReason = '';
    write(KEYS.posts, list);
  };

  if (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud()) {
    applyLocal();
    return Promise.resolve({ ok: true, cloud: 'skip', msg: '' });
  }
  return require('./user.js').setContentStatus(postId, 'normal', 'post')
    .then((r) => {
      if (!r || !r.ok) return { ok: false, cloud: 'fail', msg: (r && r.msg) || '云端没响应，恢复没生效' };
      applyLocal();
      return { ok: true, cloud: 'ok', msg: '' };
    })
    .catch(() => ({ ok: false, cloud: 'fail', msg: '网络不太好，恢复没生效' }));
}

// 改自己的帖子（标题 / 正文 / 配图）。
//
// ⚠️ 顺序是「本地先写、云端再写」，和 setPostStatus 相反 —— 这里刻意如此：
// 改帖子的动机就是修一个错字，用户最在意的是「改了之后立刻看到新内容」。
// 而云端这次必然成功或明确失败，失败时下面会把内容回滚并说清原因，
// 不会出现「本地改了、云端没改，两处不一致」的静默状态
//
// 只接受这三个字段：板块、课程关联、匿名与否都是「这条帖子是什么」而不是
// 「这段话说得对不对」，改内容不该动它们（云函数 postEdit 同样不接受）
function updatePost(postId, patch) {
  const posts = read(KEYS.posts, []);
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx < 0) return false;
  const before = {
    title: posts[idx].title,
    content: posts[idx].content,
    images: (posts[idx].images || []).slice()
  };
  if (patch.title !== undefined) posts[idx].title = String(patch.title);
  if (patch.content !== undefined) posts[idx].content = String(patch.content);
  if (patch.images !== undefined) posts[idx].images = (patch.images || []).slice();
  // 存一份原文用于回滚。云端拒绝时（命中屏蔽词之类）把内容还回去，
  // 而不是让页面停在一个「本地已改、云端没改」的中间态
  posts[idx]._preEdit = before;
  posts[idx].edited = true;
  write(KEYS.posts, posts);
  return true;
}

// 云端拒绝了这次修改：把 updatePost 存下的原文还回去。
// 不还的话用户会看到「改完了」的样子，而实际上一刷新就回去了 ——
// 那比直接不让他保存更难理解
function rollbackPost(postId) {
  const posts = read(KEYS.posts, []);
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx < 0) return false;
  const before = posts[idx]._preEdit;
  if (!before) return false;
  posts[idx].title = before.title;
  posts[idx].content = before.content;
  posts[idx].images = (before.images || []).slice();
  delete posts[idx]._preEdit;
  write(KEYS.posts, posts);
  return true;
}

// 云端确认改成功了：把回滚用的原文撤掉。
//
// ⚠️ 这一步不能省，也不能拿 rollbackPost 顶替 —— 那样会把内容**还原成旧值**，
// 恰好和想要的相反。而留着 _preEdit 也不行：它是临时字段，
// 会被 setPostStatus / deletePost 之类照单读写，一份永远撤不掉的「原文」
// 迟早在别处被当成真实内容显示出来
function commitPost(postId) {
  const posts = read(KEYS.posts, []);
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx < 0) return false;
  if (!('_preEdit' in posts[idx])) return false;
  delete posts[idx]._preEdit;
  write(KEYS.posts, posts);
  return true;
}

// 返回 Promise：等云端审完再决定要不要带用户离开当前页。
// 之前是「本地写完就报成功」，云端违规内容会晚几秒才冒出来，用户会以为是bug。
//
// kind: 'normal'（默认，普通帖）| 'topic'（主题帖）。
// 主题帖只有标题没有正文，信息全部收在评论区 —— 发「浙工商同好群」这类贴用得上。
// ⚠️ 正文留空是这类帖的定义本身，所以本地这边不能拿「正文为空」当失败条件；
//    真正拦内容的是云函数的词表，客户端只是别自作聪明把空正文拦下来。
async function addPost({ board, title, content = '', courseId = '', courseName = '', images = [], anonymous = false, kind = 'normal', vote = null, clientId = '' }) {
  // 幂等键：同一个 clientId 只会落地一条帖子。
  // 发帖页在第一次提交时生成它，超时/失败重试时**复用同一个值**——
  // 于是「云端其实写成功了，但前端没等到回执」这种情况重发一次，
  // 不会变成两条一模一样的帖子（云函数那边也按 id 去重，见 postAdd）。
  // 正常发第二条时页面会换一个新的 clientId，所以不影响「真的想发两次」。
  const postId = String(clientId || genId());
  const dup = read(KEYS.posts, []).find((x) => x && x.id === postId);
  if (dup) return { ok: true, post: dup, reused: true };
  // 投票帖的 vote 数据在这里成型：选项 2-8 个、截止时间从发帖时刻起算。
  // 数据不完整（选项不足 2 个）时退回普通帖 —— 宁可发一条普通帖，
  // 也不能发一张谁都没法投的空投票出去
  const isVote = kind === 'vote' && vote && Array.isArray(vote.labels);
  const voteLabels = isVote
    ? vote.labels.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const post = {
    id: postId,
    board,
    title,
    content,
    kind: kind === 'topic' ? 'topic' : (isVote && voteLabels.length >= 2 ? 'vote' : 'normal'),
    author: getUser().nickName,
    // 头像跟着昵称一起拍快照存进来（云函数侧还会再校验一遍只认 avatars/ 云文件）。
    // 本地这份是给自己看的：云端没通时也得有个头像，不能光秃秃一个名字
    avatarUrl: String(getUser().avatar || ''),
    time: nowText(),
    at: Date.now(),
    likes: 0,
    comments: [],
    images: images || [],
    courseId: courseId || '',
    courseName: courseName || '',
    anonymous: !!anonymous,
    // 发帖人的 openid：别人点作者名就能进名片，进而「想认识」
    authorOpenid: myOpenid(),
    // openid 用来认领「这是我的帖子」，deletePost / 详情页删除按钮都靠它
    openid: myOpenid()
  };
  if (post.kind === 'vote') {
    post.vote = {
      options: voteLabels.map((label, i) => ({ id: 'o' + (i + 1), label: label.slice(0, 30), votes: 0 })),
      multiple: !!vote.multiple,
      deadlineAt: Date.now() + (Number(vote.deadlineHours) || 72) * 3600000,
      anonymous: vote.anonymous !== false,
      voters: {}
    };
  }
  // 本地先落地：云函数没部署、断网的时候照样发得出去，不会白写
  const posts = read(KEYS.posts, []);
  posts.unshift(post);
  write(KEYS.posts, posts);

  if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
    // 客户端拿不到 openid 不再拦着不发。云函数的身份来自微信平台注入的 context
    // （getWXContext().OPENID），跟客户端有没有拿到 openid 毫无关系 ——
    // login 云函数只是「让客户端知道自己是谁」，它不部署，帖子照样发得出去。
    // 之前拦在这儿的结果就是「预览正常、体验版全废」：login 没部署时论坛/评价永远
    // 被「身份还没拿到」卡死，而不检查身份的闲置却一直能发。
    // 这里等一轮只是为了让本地「我的帖子」能马上认领，等不到也照发。
    if (!myOpenid()) await waitOpenid();
    // 走云函数而不是直接写库：服务端要过屏蔽词和微信官方内容安全接口，
    // 客户端直连写库等于把审核绕过去 —— 真上架时这是必须堵死的口子。
    try {
      const r = await require('./user.js').postAdd(post);
      if (r && r.ok === false) {
        // 失败必须分类型处理，以前一律删本地，用户看到的就是「写完好好的一转头没了」：
        //   ① 内容被审核驳回（命中屏蔽词）→ 撤掉本地，别把违规内容留在界面上；
        //   ② 云端存不进去（集合没建/没权限/网络）→ 本地必须留着，并如实告诉用户；
        //   ③ 「无法识别用户身份」「未知操作（云函数版本太老）」是云端的问题，
        //      不是内容违规 —— 同样按 ② 处理，别把用户写的东西撤掉。
        const cloudSide = r.saved === false || /无法识别用户身份|未知操作/.test(String(r.msg || ''));
        if (!cloudSide) {
          write(KEYS.posts, read(KEYS.posts, []).filter((x) => x.id !== post.id));
          return { ok: false, msg: r.msg || '内容没能发出去' };
        }
        return {
          ok: false,
          saved: false,
          msg: '已存在本机，但没能同步到云端（' + (r.msg || '写入失败') + '）',
          detail: r.detail || ''
        };
      }
      // 发布成功：服务端用微信 context 认人，回传的 doc 带着真实 openid。
      // 本地这条如果还空着身份就顺手补上，「我的帖子」立刻认得出，不用等下次全量同步。
      if (r && r.post && r.post.openid && !post.openid) {
        const cur = read(KEYS.posts, []);
        const t = cur.find((x) => x.id === post.id);
        if (t) {
          t.openid = r.post.openid;
          t.authorOpenid = r.post.authorOpenid || r.post.openid;
          write(KEYS.posts, cur);
        }
      }
    } catch (e) {
      // 云函数自己崩了 / 调不通：本地那份留着，别让人白写一场
      return {
        ok: false,
        saved: false,
        msg: '已存在本机，云端暂时连不上',
        detail: String((e && e.message) || e || '')
      };
    }
  }
  return { ok: true };
}

// 加一条留言。
//
// 返回值是 { comment, done }，而不是 comment 本身：
//   comment —— 本地立刻落地的那条（同步返回，界面不用等网络就能刷出来）；
//   done    —— 「云端那一步」的 Promise，页面据此决定最后提示什么。
// 以前这里返回 comment、云端结果自己 catch 掉，页面想针对云端结果说句话
// （比如云函数是旧版、图被悄悄吞了）根本没有机会，只能眼睁睁看着
// 「评论成功」把真正该说的话盖掉。
//
// images：已上传好的云存储 fileID 数组（最多 3 张，白名单在云函数侧校验）
// reply ：{ parentId, replyToOpenid, replyToAuthor } —— 回复某条留言时才传。
//         层级（parentId / depth）在这里归一化，服务端还有一份同样的算法兜底
function addComment(postId, content, images, reply) {
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];
  const posts = read(KEYS.posts, []);
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx < 0) {
    return { comment: null, done: Promise.resolve({ ok: false, msg: '这条内容已经不在了' }) };
  }
  // 回复的挂载点：四级及以上一律折回三级（理由见 replyTargetOf 的注释）
  const where = replyTargetOf(posts[idx].comments || [], reply && reply.parentId);
  const comment = {
    id: genId(),
    // 回复链的四个字段。parentId 决定它挂在哪条下面、depth 决定缩进到第几层，
    // replyTo* 决定界面上那句「回复 @某某」写谁的名字 ——
    // 折叠到二级之后这三个不再同指一条，所以必须分开存
    parentId: where.parentId,
    depth: where.depth,
    replyToOpenid: String((reply && reply.replyToOpenid) || ''),
    replyToAuthor: String((reply && reply.replyToAuthor) || ''),
    // 赞踩：新留言从 0 起算。云端回执带回来的也是 0，
    // 两边同构 —— 不然自己这条没有计数、同步回来的有，看着像坏了
    likes: 0,
    dislikes: 0,
    author: getUser().nickName,
    // 头像和昵称一样，发出去的那一刻存一份。云端 return 回来的那条也带这个字段，
    // 两边同构 —— 不然同步一下就发现「自己的留言有头像、同步回来的没有」
    avatarUrl: String(getUser().avatar || ''),
    content,
    // 图也要一起落地：本地这条和云端那条字段必须同构 ——
    // 别人同步下来的是带图的，自己这条不带，同一条留言在两个入口长得不一样
    images: imgs,
    // 和帖子一样带时分：留言列表里本地这条与云端回来的那条时间格式必须一致，
    // 否则同屏一行「2026-10-17」一行「2026-10-17 19:02」，看着像两条不同来源的数据
    time: nowText(),
    // 云端那份评论带 authorOpenid / at，本地这份先落地时也要带上：
    // 「谁留的、什么时候留的」是信息墙的基本信息，缺了它本地和云端对不上号，
    // 后面要删也认不出是哪一条
    authorOpenid: myOpenid(),
    at: Date.now()
  };
  posts[idx].comments = posts[idx].comments || [];
  posts[idx].comments.push(comment);
  // 计数跟着本地这一条走一步：列表页读的是 commentCount，
  // 不跟着加的话发完回到列表还是「0 条」，看着像没发出去
  posts[idx].commentCount = (Number(posts[idx].commentCount) || (posts[idx].comments.length - 1)) + 1;
  write(KEYS.posts, posts);

  if (!(cloud.cfg.USE_CLOUD && cloud.ensureCloud())) {
    return { comment: comment, done: Promise.resolve({ ok: true, local: true }) };
  }

  // 走云函数：服务端过一遍审核，顺便给作者推「有人回复你」的订阅消息。
  // 被驳回就把本地这条撤掉，别让违规评论留在界面上
  const done = require('./user.js').postComment(postId, content, imgs, {
    parentId: where.parentId,
    replyToOpenid: comment.replyToOpenid,
    replyToAuthor: comment.replyToAuthor
  }, comment.id).then((r) => {
    const cur = read(KEYS.posts, []);
    const i = cur.findIndex((x) => x.id === postId);
    if (r && r.ok === false) {
      if (i >= 0) {
        if (r.saved === false) {
          // 云端没落库：保留这条本机评论，但明确标记未同步。
          cur[i].comments = (cur[i].comments || []).map((c) => (
            c.id === comment.id
              ? Object.assign({}, c, { localOnly: true, pending: false, syncMsg: r.msg || '未同步' })
              : c
          ));
        } else {
          // 内容被审核拒绝：本地这条必须撤掉。
          cur[i].comments = (cur[i].comments || []).filter((c) => c.id !== comment.id);
        }
        write(KEYS.posts, cur);
      }
      return r;
    }
    // 服务端成功回执里的 comment 才是权威版本：用同一个 id 替换本地临时对象，
    // 后续回复 / 删除 / 点赞就不会再拿本地 id 去云端找一个不存在的东西。
    if (i >= 0 && r && r.comment) {
      cur[i].comments = (cur[i].comments || []).map((c) => (
        c.id === comment.id ? Object.assign({}, c, r.comment, { localOnly: false, pending: false }) : c
      ));
      write(KEYS.posts, cur);
    }
    // 图文留言提交「成功」了，但图被旧版云函数吞掉：本地这份的图也得撤。
    if (r && r.warn) {
      const cur2 = read(KEYS.posts, []);
      const i2 = cur2.findIndex((x) => x.id === postId);
      if (i2 >= 0) {
        cur2[i2].comments = (cur2[i2].comments || []).map((c) => (
          c.id === comment.id ? Object.assign({}, c, { images: [] }) : c
        ));
        write(KEYS.posts, cur2);
      }
    }
    return r || { ok: false, msg: '云端没返回评论结果' };
  }).catch(() => {
    const cur = read(KEYS.posts, []);
    const i = cur.findIndex((x) => x.id === postId);
    if (i >= 0) {
      cur[i].comments = (cur[i].comments || []).map((c) => (
        c.id === comment.id
          ? Object.assign({}, c, { localOnly: true, pending: false, syncMsg: '云端没响应' })
          : c
      ));
      write(KEYS.posts, cur);
    }
    return { ok: false, saved: false, local: true, msg: '云端没响应，评论先留在本机' };
  });
  return { comment: comment, done: done };
}

// 删掉一条留言（信息墙专用）。
//
// 普通帖的评论区删不删都无所谓，信息墙不行：群号会过期、群会满、有人留错群、
// 还有人往里塞广告 —— 这些都得等帖主自己动手清掉。
// 帖主是唯一有动力维护这面墙的人，没有这个口子，墙三个月就烂成垃圾堆了。
// 云端校验在 commentRemove 里（留言作者本人 / 帖主 / 审核员都能删），
// 这边只负责把本地那份同步撤掉，别让界面上留着一条刚被删掉的留言。
function removeComment(postId, commentId) {
  if (!postId || !commentId) return false;
  const posts = read(KEYS.posts, []);
  const i = posts.findIndex((p) => p.id === postId);
  if (i < 0) return false;
  const before = (posts[i].comments || []).slice();
  if (!before.some((c) => c.id === commentId)) return false;

  // 连子回复一起撤：二级回复是挂在父留言下面的，父没了它就成了一句
  // 「回复 @某某」却找不到被回复的那条 —— 留着比删掉更糟。
  // 逐层收（而不是只收一层）：万一哪天层级放开，这里不用跟着改
  const doomed = {};
  doomed[commentId] = true;
  let grew = true;
  while (grew) {
    grew = false;
    before.forEach((c) => {
      if (doomed[c.id]) return;
      if (doomed[String(c.parentId || '')]) { doomed[c.id] = true; grew = true; }
    });
  }
  const after = before.filter((c) => !doomed[c.id]);
  posts[i].comments = after;
  // 减掉这一次真实撤掉的条数（含子回复），别让列表页还显示旧数字
  posts[i].commentCount = Math.max(0,
    (Number(posts[i].commentCount) || before.length) - (before.length - after.length));
  // 光改本地那份还不够：留言是长在帖子里的，本地缓存只在同步时整条替换，
  // 不同步的页面上那条留言会一直挂着，看着像没删掉。墓碑跟缓存无关。
  // 子回复也要各记一笔墓碑，否则它们会在别人手机上留下来
  Object.keys(doomed).forEach((id) => markCommentRemoved(id));
  write(KEYS.posts, posts);
  return true;
}

// 留言删除墓碑：记下这条留言已经没了。
// 留言不是一条独立内容，而是帖子里的一个元素；云端那一刀改的是帖子的 comments 数组，
// 手机上的本地缓存却只在同步时整条替换 —— 不同步的页面上那条留言就会一直挂着，
// 举报的人会以为系统没反应。墓碑让「已经删掉」这件事跟缓存有没有刷新无关，
// 见 decoratePost 里的过滤。
function markCommentRemoved(commentId) {
  if (!commentId) return false;
  const t = read(KEYS.commentTomb, {});
  if (t[commentId]) return true;
  t[commentId] = true;
  write(KEYS.commentTomb, t);
  return true;
}

/* ============ 留言的赞 / 踩 / 举报 / 二级回复 ============ */

// 留言回复的层级上限：0 = 一级留言，1 = 二级回复，2 = 三级回复。
// 四级及以上一律折叠回三级 —— 评论区不是聊天室，再深一层就变成两个人在别人的
// 帖子底下私聊，第三人读到的只是一串没有上下文的「回复 @某某」。
// 折叠而不是拒绝：用户点了「回复」就该有回应，把他的话挂到同一个父下更自然。
//
// 三级回复（depth 2）的**挂载点**是它上面那条二级回复，但**展示**时和二级回复
// 并列排在一级留言下面、缩进一致 —— 见 buildCommentTree 的扁平化。
// 也就是说：数据上是一条链（谁回谁清清楚楚），视觉上只有两档（一级 / 回复）。
// 只靠缩进表达层级的话，一条帖子里挂四层回复就会把正文挤成一条竖线，
// 而多数人真正需要的只是「这几条都是在这条留言下面的讨论」
const REPLY_MAX_DEPTH = 2;
// 一条留言默认露几条二级回复，剩下的收在「展开 N 条回复」里。
// 信息墙上一条群号下面挂十几条追问是常态，不折叠首屏就被回复填满了
const REPLY_PREVIEW = 3;

function commentKey(postId, commentId) {
  return String(postId || '') + '#' + String(commentId || '');
}

// 我对某条留言的态度：'like' / 'dislike' / ''。
// 一个人一格，互斥是数据结构保证的 —— 不存在「既赞又踩」，
// 换边就是覆盖同一个字段，不需要两处代码都记得去清对方
function myCommentVote(postId, commentId) {
  const v = read(KEYS.commentVoteSet, {})[commentKey(postId, commentId)];
  return v === 'dislike' ? 'dislike' : (v ? 'like' : '');
}

function commentVoteBaseOf(postId, commentId) {
  const b = read(KEYS.commentVoteBase, {})[commentKey(postId, commentId)];
  if (!b || typeof b !== 'object') return null;
  return { likes: Number(b.likes) || 0, dislikes: Number(b.dislikes) || 0 };
}

// 展示用的赞踩数 = 基线 + 我这一票（和帖子同款纯函数）
function commentVoteCounts(postId, commentId, c, myKind) {
  const vote = myKind === undefined ? myCommentVote(postId, commentId) : myKind;
  const base = commentVoteBaseOf(postId, commentId);
  if (base) {
    return {
      likes: Math.max(0, base.likes + (vote === 'like' ? 1 : 0)),
      dislikes: Math.max(0, base.dislikes + (vote === 'dislike' ? 1 : 0))
    };
  }
  return { likes: Number(c && c.likes) || 0, dislikes: Number(c && c.dislikes) || 0 };
}

function ensureCommentVoteBase(postId, commentId, c, myKind) {
  const cur = commentVoteBaseOf(postId, commentId);
  if (cur) return cur;
  const base = {
    likes: Math.max(0, (Number(c && c.likes) || 0) - (myKind === 'like' ? 1 : 0)),
    dislikes: Math.max(0, (Number(c && c.dislikes) || 0) - (myKind === 'dislike' ? 1 : 0))
  };
  const all = read(KEYS.commentVoteBase, {});
  all[commentKey(postId, commentId)] = base;
  write(KEYS.commentVoteBase, all);
  return base;
}

// 云端权威值回来后刷新基线（云端给的是含我的总数，先扣掉我这份）
function saveCommentVoteBase(postId, commentId, likes, dislikes, liked, disliked) {
  const all = read(KEYS.commentVoteBase, {});
  all[commentKey(postId, commentId)] = {
    likes: Math.max(0, (Number(likes) || 0) - (liked ? 1 : 0)),
    dislikes: Math.max(0, (Number(dislikes) || 0) - (disliked ? 1 : 0))
  };
  write(KEYS.commentVoteBase, all);
}

// 把一条留言的赞踩回滚到某个已知态度（只在云端明确拒绝时用）。
// 不发请求、不过节流闸：它是在撤销一次已经发生过的乐观更新，
// 再走一遍 toggle 会把它当成「又点了一次」
function rollbackCommentVote(postId, commentId, kind) {
  const posts = read(KEYS.posts, []);
  const pi = posts.findIndex((p) => p.id === postId);
  if (pi < 0) return false;
  const cs = posts[pi].comments || [];
  const ci = cs.findIndex((c) => c.id === commentId);
  if (ci < 0) return false;
  const set = read(KEYS.commentVoteSet, {});
  if (kind) set[commentKey(postId, commentId)] = kind;
  else delete set[commentKey(postId, commentId)];
  write(KEYS.commentVoteSet, set);
  const counts = commentVoteCounts(postId, commentId, cs[ci], kind || '');
  cs[ci] = Object.assign({}, cs[ci], { likes: counts.likes, dislikes: counts.dislikes });
  write(KEYS.posts, posts);
  return true;
}

// 赞 / 踩一条留言：和帖子那套完全一致 ——
//   点同一边 = 取消，点另一边 = 换边，计数由「基线 + 我这一票」算出。
// 返回 { liked, disliked, likes, dislikes, done }：done 是云端那一步的 Promise，
// 页面据此决定要不要补一句「没记到云端」（和 addComment 一个套路）
function toggleCommentVote(postId, commentId, kind) {
  const k = kind === 'dislike' ? 'dislike' : 'like';
  const posts = read(KEYS.posts, []);
  const pi = posts.findIndex((p) => p.id === postId);
  if (pi < 0) return null;
  const list = posts[pi].comments || [];
  const ci = list.findIndex((c) => c.id === commentId);
  if (ci < 0) return null;
  const c = list[ci];
  const was = myCommentVote(postId, commentId);

  // 连点保护：350ms 内的第二下不动数据也不发请求，但仍返回当前状态 ——
  // 返回旧字段会让数字在极短时间内闪回去，看着像坏了
  if (voteThrottled('c#' + commentKey(postId, commentId))) {
    const cur = commentVoteCounts(postId, commentId, c, was);
    return {
      liked: was === 'like', disliked: was === 'dislike',
      likes: cur.likes, dislikes: cur.dislikes, throttled: true, done: null
    };
  }

  const next = was === k ? '' : k;
  const set = read(KEYS.commentVoteSet, {});
  if (next) set[commentKey(postId, commentId)] = next;
  else delete set[commentKey(postId, commentId)];
  write(KEYS.commentVoteSet, set);

  // 基线必须先于计数落定（反推要用的是「改之前」的那份）
  ensureCommentVoteBase(postId, commentId, c, was);
  const counts = commentVoteCounts(postId, commentId, c, next);
  list[ci] = Object.assign({}, c, {
    likes: counts.likes, dislikes: counts.dislikes
  });
  write(KEYS.posts, posts);

  let done = null;
  if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
    done = require('./user.js').commentVote(postId, commentId, k).then((r) => {
      if (!r || r.ok === false) {
        // 断网（offline / 云端没响应）**不回滚**：界面上已经是「本机这一下生效」的样子，
        // 撤回去反而像没点上，而请求迟早会被重试（下次点或下次进页面）。
        // 但被**明确拒绝**（云端判定不能给自己的留言点赞这类）必须回滚 ——
        // 本地显示「已赞」而云端一条没写，下次同步数字又跳回去，比当场说清更让人困惑
        if (r && r.ok === false && !r.offline && r.msg) rollbackCommentVote(postId, commentId, was);
        return r || { ok: false };
      }
      // 服务端数人头给出权威计数，扣掉我这份存成基线，再按同一个公式重算 ——
      // 两边口径一致，数字不会在本地值和云端值之间来回跳
      saveCommentVoteBase(postId, commentId, r.likes, r.dislikes, !!r.liked, !!r.disliked);
      const cur = read(KEYS.posts, []);
      const t = cur.find((x) => x.id === postId);
      if (t) {
        const cs = t.comments || [];
        const i = cs.findIndex((x) => x.id === commentId);
        if (i >= 0) {
          const rv = r.liked ? 'like' : (r.disliked ? 'dislike' : '');
          const cc = commentVoteCounts(postId, commentId, cs[i], rv);
          cs[i] = Object.assign({}, cs[i], { likes: cc.likes, dislikes: cc.dislikes });
          write(KEYS.posts, cur);
        }
      }
      return r;
    }).catch(() => ({ ok: false, offline: true }));
  }
  return {
    liked: next === 'like', disliked: next === 'dislike',
    likes: counts.likes, dislikes: counts.dislikes, done: done
  };
}

// 我举报过这条留言吗 / 举报到哪一步了。
// reportedSet 那个 true 只够把按钮变灰，这里多带一份状态给界面用 ——
// 举报是一条有去有回的流程，给它一个看得见的去处，举报的人才不会以为没人管
function commentReportOf(postId, commentId) {
  const s = read(KEYS.commentReportState, {})[commentKey(postId, commentId)];
  return (s && typeof s === 'object') ? s : null;
}

function markCommentReport(postId, commentId, reason, status) {
  const key = commentKey(postId, commentId);
  if (key === '#') return false;
  const all = read(KEYS.commentReportState, {});
  all[key] = { reason: String(reason || ''), status: String(status || 'pending'), at: Date.now() };
  write(KEYS.commentReportState, all);
  markReportedComment(postId, commentId); // 顺手点亮 reportedSet，两个入口共用一份「举报过」的事实
  return true;
}

// 举报状态的人话。status 跟云端 reports 集合里的取值一致
function commentReportLabel(status) {
  if (status === 'confirmed') return '已举报·已处理';
  if (status === 'rejected') return '已举报·未成立';
  return '已举报·待核实';
}

// 回复该挂在哪一层：给「我要回复这条」算好 parentId 与 depth。
//
// 四级及以上的回复在这里被折回三级 —— 保留「回复的是谁」（replyTo 照旧指向
// 被点的那条），只把挂载点上提一层。这样深度永远 ≤ REPLY_MAX_DEPTH，
// 而「回复 @某某」的语义一点没丢。
//
// 三级回复不折回：它就挂在自己上面那条二级回复下面（parentId = 那条二级的 id），
// 靠 replyTo* 记着「回复的是谁」。展示时再由 buildCommentTree 拉平到一级下面。
// 数据层保留链条是为了「谁在跟谁说话」不丢 —— 折叠只在视觉那一层发生
// ⚠️ 服务端（云函数 postComment）有一份同样的归一化，改这边必须同步改那边，
//    否则会出现「手机上挂在一级、云端挂在二级」的两副面孔
function replyTargetOf(comments, parentId) {
  const pid = String(parentId || '');
  const parent = pid ? (comments || []).find((c) => c.id === pid) : null;
  if (!parent) return { parentId: '', depth: 0 };
  const pd = Number(parent.depth) || 0;
  if (pd < REPLY_MAX_DEPTH) return { parentId: pid, depth: pd + 1 };
  // 已经在最深层：挂到它的父下面（父一定是一级，不会再往上递归）
  const up = String(parent.parentId || '');
  return { parentId: up, depth: REPLY_MAX_DEPTH };
}

// 把扁平的 comments 数组编成「一级留言 + 挂在它下面的所有回复」。
//
// 组织成树而不是在模板里靠 depth 缩进：缩进只能让人看出层级，
// 看不出「这几条是同一条留言下面的」。而回复是要折叠的 ——
// 不建树就没法数「这条下面还有几条」。
//
// 二级、三级回复在树里是**并列**挂在同一个一级下面的，缩进一模一样：
// 三级回复的 parentId 指向二级那条（谁回谁的关系在数据层留着），
// 这里统一把挂载点上提到这一条链最顶端的一级留言 —— 见 topAncestorId。
// 于是视觉上永远只有两档，一屏能多放两行，也不会出现「越往下越窄」的漏斗。
//
// 父留言已经被删掉时，它的回复提升为一级：宁可位置变一变，也别让一条有用的
// 群号因为父留言被删就跟着消失
function buildCommentTree(list) {
  const nodes = {};
  const roots = [];
  list.forEach((c) => { nodes[c.id] = Object.assign({}, c, { replies: [] }); });
  list.forEach((c) => {
    const node = nodes[c.id];
    const pid = topAncestorId(nodes, c);
    const parent = pid ? nodes[pid] : null;
    if (parent && parent.id !== node.id) parent.replies.push(node);
    else roots.push(node);
  });
  return roots;
}

// 顺着 parentId 往上走到这条链最顶端的一级留言，返回它的 id。
//
// 返回空串 = 这条回复的父已经不在了（被删 / 数据缺失），交给调用方提升为一级。
// 循环带 8 步上限：万一哪天写出 parentId 成环的脏数据，这里是兜底，
// 不会让整个详情页卡死在一个死循环里
function topAncestorId(nodes, c) {
  let cur = c;
  for (let i = 0; i < 8; i += 1) {
    const upId = String((cur && cur.parentId) || '');
    if (!upId) return (Number(cur && cur.depth) || 0) === 0 ? String(cur.id || '') : '';
    const up = nodes[upId];
    if (!up || up.id === cur.id) return ''; // 父没了 / 成环：都提升为一级
    cur = up;
  }
  return '';
}

// 给每条留言算好模板要用的东西，再编成树（一级留言 + 并列挂在它下面的回复）。
//
// 为什么必须在这里算：WXML 的 {{}} 里调不了函数，也做不了 charAt / 三元之外的判断。
// 所有「我能不能删」「我赞过没」「回复的是谁」都得先落成一个个字段。
// 页面那份同名函数已经搬到这里 —— 赞踩、举报状态、回复层级加进来之后，
// 这份装饰成了四个功能的公共出口，留在页面里就没法被行为测试覆盖。
//
// expanded：{ 留言id: true }，页面记住哪些二级回复已经被展开过
function decorateComments(post, isMine, expanded, isMod, protectMap) {
  const myOid = String(myOpenid() || '');
  const mod = !!isMod || !!isModerator();
  const pm = protectMap || {};
  const exp = expanded || {};
  const src = post || {};
  const pid = String(src.id || '');
  // 匿名帖：评论区一并匿名。
  //
  // 只让帖子匿名是不够的。楼主在下面回一句「补充一下」，昵称一露，前面那串
  // 代号就白取了；别人实名留言，等于在一个匿名话题下被挨个点名。
  // 「我匿名说、你们实名回」这种组合，会让树洞的评论区迅速没人敢说话 ——
  // 那这个功能就不是「少了点匿名」，而是主贴变成单向广播。
  //
  // ⚠️ 这里**不给审核员开特例**。他在详情页看到的也是代号。
  // 要追人是走审核队列（那边有 openid 和真名），不该靠屏幕上一行字 ——
  // 屏幕上的东西一截图就外传，而匿名承诺是给所有人的。
  const anonPost = isAnonPost(src);
  const posterOid = String(src.authorOpenid || src.openid || src._openid || '');
  const raw = (src.comments || []);
  // openid → 代号。必须先整轮算完再渲染：「回复 @某某」那条链里只存了 openid，
  // 名字只能从这里反查；而回复可能指向列表里排在后面的某条，
  // 边算边查就会查不到，退回一句「匿名同学」
  const aliasOf = {};
  const codeOf = (c) => {
    const who = String(c.authorOpenid || c._openid || '');
    // 楼主用主贴那个代号 —— 读者才能把「这条回复」和「主贴」对上
    if (who && who === posterOid) return anonCodeOf(pid);
    // 其他留言者按「帖子 id + openid」取：同一帖内稳定（能对话），跨帖串不起来。
    // openid 缺失的老留言退回用留言 id，至少同一条不会每次换一个名字
    return anonCodeOf(pid + ':' + (who || String(c.id || '')));
  };
  if (anonPost) {
    raw.forEach((c) => {
      const who = String((c && (c.authorOpenid || c._openid)) || '');
      if (who) aliasOf[who] = codeOf(c);
    });
  }
  const list = raw.map((c) => {
    const who = String(c.authorOpenid || c._openid || '');
    const anonCode = anonPost ? codeOf(c) : '';
    const vote = myCommentVote(pid, c.id);
    const counts = commentVoteCounts(pid, c.id, c, vote);
    const rep = commentReportOf(pid, c.id);
    return Object.assign({}, c, {
      // 老留言没有 images 字段，而模板里要写 c.images.length ——
      // 拿到 undefined 会让那块图片区直接渲染不出来（甚至报错），所以在这里补成数组
      images: Array.isArray(c.images) ? c.images : [],
      // 老留言可能只有云端自动写入的 _openid（没有 authorOpenid 字段），
      // 点头像进名片靠的就是它，这里补齐，旧留言也能点
      authorOpenid: who,
      // 匿名帖下昵称和头像一起换掉。头像不能留 —— 它是全校唯一能一眼认人的
      // 东西，名字换成代号、头像还是那张脸，等于白换
      author: anonPost ? anonCode : c.author,
      showAvatar: anonPost ? '' : String(c.avatarUrl || ''),
      avatarText: anonPost ? '匿' : (String(c.author || '浙小商').charAt(0) || '同'),
      // 头像点不点得开。匿名帖下不给入口：点进去就是这位同学的主页 ——
      // 真名、他发过的所有帖子全在那儿，匿名当场破功。
      // 模板和 goCommenter 各拦一次，任何一处都不能单独成立
      canProfile: !anonPost && !!who,
      avaErr: false,
      // 赞踩：和帖子同一个口径（基线 + 我这一票），不再直接读留言上的数字
      liked: vote === 'like',
      disliked: vote === 'dislike',
      likes: counts.likes,
      dislikes: counts.dislikes,
      // 「回复 @某某」写谁的名字：折叠到二级之后，被回复的那条和挂载的那条
      // 可能不是同一条，所以名字单独存一份，不能靠 parentId 反查。
      //
      // 匿名帖下**只认 openid 反查出来的代号**，绝不退回 replyToAuthor：
      // 那个字段里是真名，而它恰好会以「回复 @张三」的形式明晃晃印在界面上
      replyToName: anonPost
        ? (aliasOf[String(c.replyToOpenid || '')] || '匿名同学')
        : String(c.replyToAuthor || ''),
      // 是回复（二级或三级都算）。渲染时两者缩进一致，所以只看这一位就够了
      isReply: (Number(c.depth) || 0) > 0,
      // 是我留的。点头像时要用：本地先落地的那条 authorOpenid 可能是空的
      // （还没拿到 openid 就写进了缓存），没有这个标记就会「点了没反应」
      mine: !!myOid && who === myOid,
      canRemove: !!isMine || (!!myOid && who === myOid) || mod,
      // 审核员在详情页直接保护/解除保护这一条留言
      canProtect: mod,
      protected: !!pm['comment_' + String(c.id || '')],
      reported: hasReportedComment(pid, c.id),
      // 举报进行到哪一步：没举报过是空串，模板据此决定显不显示
      reportLabel: rep ? commentReportLabel(rep.status) : ''
    });
  });
  const tree = buildCommentTree(list);
  tree.forEach((n) => {
    n.replyCount = (n.replies || []).length;
    n.hiddenCount = Math.max(0, n.replyCount - REPLY_PREVIEW);
    // 回复不超过预览条数时永远是展开的 —— 否则会冒出一个「展开 0 条」的按钮
    n.expanded = !!exp[n.id] || n.hiddenCount === 0;
  });
  return Object.assign({}, post, {
    comments: list,
    commentTree: tree,
    // 总数以云端为准：详情页只拉得回前 200 条，本地列表不等于全部；
    // 而列表页上的「12 条评论」在没打开过详情页时压根没有本地列表
    commentCount: Number.isFinite(Number(post.commentCount)) ? Number(post.commentCount) : list.length
  });
}

// 详情页从云端拉到留言后写回本地缓存。
//
// 拆表之后「帖子」和「留言」是两个来源：帖子从同步来，留言要单独拉一次。
// 拉回来的这份是权威的（别人的新留言在、被删的不在），整份替换本地缓存；
// 但墓碑里记着的仍然要挡掉 —— 云端可能还留着一条我们这边已经确认删掉的
function applyCloudComments(postId, list, total) {
  const posts = read(KEYS.posts, []);
  const i = posts.findIndex((p) => p.id === postId);
  if (i < 0) return false;
  const arr = Array.isArray(list) ? list : [];
  const tomb = commentTomb();
  posts[i].comments = arr.filter((c) => c && c.id && !c.removed && !tomb[c.id]);
  const n = Number(total);
  posts[i].commentCount = Number.isFinite(n) ? Math.max(0, n) : posts[i].comments.length;
  write(KEYS.posts, posts);
  return true;
}

// 连点保护：同一条帖子这么久之内只认第一下。
// 手指连点、网络卡顿时的焦虑性重复点击都会在这道闸上被吃掉 ——
// 每一下都发一次请求的话，服务端还没写完第二下就到了，「点一下涨两个踩」就是这么来的
const VOTE_THROTTLE_MS = 350;
// 记的是「这条帖子的这个动作上一次被点的时间」。
// 按 postId + kind 分开：点赞后马上去点踩不能被“同一条帖子”的闸挡住。
const voteAt = {};
function voteThrottled(key) {
  const now = Date.now();
  const last = Number(voteAt[key]) || 0;
  if (last && now - last < VOTE_THROTTLE_MS) return true;
  voteAt[key] = now;
  const keys = Object.keys(voteAt);
  if (keys.length > 100) {
    keys.forEach((k) => { if (now - (Number(voteAt[k]) || 0) > 5000) delete voteAt[k]; });
  }
  return false;
}

// 云端最近一次确认的状态 / 本地最新想要的状态 / 串行同步器。
// 点赞后马上点踩时，本地先切到踩，等点赞请求回来后再串行发“切到踩”，
// 不会丢点击，也不会两个请求并发把最终状态弄反。
const voteServer = {};
const voteDesired = {};
const voteRunning = {};

function serverVoteOf(r) {
  return r && r.liked ? 'like' : (r && r.disliked ? 'dislike' : '');
}

// 云端回执到了：先刷新基线，再按本地最新态度重算显示值。
// 如果用户在上一个请求飞行期间又点了别的，不能拿旧回执把界面盖回去。
function applyVoteServer(postId, r) {
  const cur = read(KEYS.posts, []);
  const t = cur.find((x) => x.id === postId);
  if (!t) return;
  // 云端回执是记名表当场数出来的人数。若用户在上一个请求飞行期间又点了别的，
  // 就在这份权威计数上做一次临时 ±1，把界面保持在“最新意图”，等下一次回执追平。
  // 这不是持久 baseline，不会跨请求累计。
  const serverVote = serverVoteOf(r);
  const localVote = myVote(postId);
  let likes = Math.max(0, Number(r.likes) || 0);
  let dislikes = Math.max(0, Number(r.dislikes) || 0);
  if (localVote !== serverVote) {
    if (serverVote === 'like') likes = Math.max(0, likes - 1);
    if (serverVote === 'dislike') dislikes = Math.max(0, dislikes - 1);
    if (localVote === 'like') likes += 1;
    if (localVote === 'dislike') dislikes += 1;
  }
  t.likes = likes;
  t.dislikes = dislikes;
  t.liked = localVote === 'like';
  t.disliked = localVote === 'dislike';
  write(KEYS.posts, cur);
}

function drainVote(postId) {
  if (voteRunning[postId]) return;
  voteRunning[postId] = true;
  const step = () => {
    const desired = voteDesired[postId];
    if (desired === undefined) { delete voteRunning[postId]; return; }
    const server = voteServer[postId];
    if (server !== undefined && server === desired) {
      delete voteDesired[postId];
      delete voteRunning[postId];
      return;
    }
    // 云端接口是 toggle：想要 like/dislike 就发同方向；想要取消就发当前服务端方向。
    let kind;
    if (server === undefined) kind = desired || 'like';
    else if (desired) kind = desired;
    else kind = server || 'like';
    let ok = false;
    Promise.resolve(require('./user.js').voteToggle(postId, kind))
      .then((r) => {
        if (!r || r.ok === false) return;
        ok = true;
        voteServer[postId] = serverVoteOf(r);
        applyVoteServer(postId, r);
        if (voteDesired[postId] === voteServer[postId]) delete voteDesired[postId];
      })
      .catch(() => {})
      .then(() => {
        if (!ok) { delete voteRunning[postId]; return; }
        if (voteDesired[postId] !== undefined) step();
        else delete voteRunning[postId];
      });
  };
  step();
}

// 赞 / 踩：一个人对一条帖子只能占一个位置，赞和踩互斥。
// kind 传 'like'（默认）或 'dislike'，再点一次同一个就是取消。
function toggleVote(postId, kind) {
  const k = kind === 'dislike' ? 'dislike' : 'like';
  const posts = read(KEYS.posts, []);
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx < 0) return null;
  const p = posts[idx];

  // ① 我的态度：voteSet 是唯一事实来源，一条帖子只有三种取值
  //    （'like' / 'dislike' / 没有）。不存在「既赞又踩」这种状态。
  const votes = read(KEYS.voteSet, {});
  const legacy = read(KEYS.likedSet, {});
  const was = votes[postId] === 'dislike' ? 'dislike'
    : (votes[postId] ? 'like' : (legacy[postId] ? 'like' : ''));
  // 旧版 likedSet 只记“赞过”。如果用户把它点掉，只删 voteSet 而不删 likedSet，
  // myVote() 下一轮又会从旧表读回 like —— 表现就是“赞怎么都取消不掉”。
  // 第一次真实操作时把它迁走并清掉，之后只认 voteSet。
  if (legacy[postId]) {
    delete legacy[postId];
    write(KEYS.likedSet, legacy);
  }

  // ② 同一边 350ms 内的第二下吃掉；赞和踩是不同 key，所以“赞完立刻踩”不会被挡。
  if (voteThrottled(postId + '#' + k)) {
    return Object.assign({}, p, {
      liked: was === 'like',
      disliked: was === 'dislike',
      likes: Math.max(0, Number(p.likes) || 0),
      dislikes: Math.max(0, Number(p.dislikes) || 0),
      votePending: !!voteRunning[postId]
    });
  }

  // ③ 目标状态：点同一边 = 取消，点另一边 = 换边。
  const next = was === k ? '' : k;
  if (next) votes[postId] = next;
  else delete votes[postId];
  write(KEYS.voteSet, votes);

  // ④ 本地只做一次 ±1 的乐观变化，让按钮立刻有反馈；
  //    真正的权威计数等云端回执后整份覆盖，不再维护 baseline。
  let likes = Math.max(0, Number(p.likes) || 0);
  let dislikes = Math.max(0, Number(p.dislikes) || 0);
  if (was === 'like') likes = Math.max(0, likes - 1);
  if (was === 'dislike') dislikes = Math.max(0, dislikes - 1);
  if (next === 'like') likes += 1;
  if (next === 'dislike') dislikes += 1;
  p.likes = likes;
  p.dislikes = dislikes;
  p.liked = next === 'like';
  p.disliked = next === 'dislike';
  write(KEYS.posts, posts);

  // ⑥ 云端串行同步：本地已经切到最新态度，云端按顺序把状态追平。
  if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
    voteDesired[postId] = next;
    drainVote(postId);
  } else {
    delete voteDesired[postId];
  }
  return Object.assign({}, p, { votePending: !!voteRunning[postId] });
}

// 老接口：点个赞。留着是为了别处不用跟着改
function toggleLike(postId) {
  return toggleVote(postId, 'like');
}

// ============ 树洞三连：抱抱 / 递茶 / 摸摸头 ============
// 和赞踩最大的区别：这三个可以同时给（抱完再递茶很正常），
// 所以「我的选择」是三个独立开关，不是三选一。
// 但每一项的计数逻辑和赞踩完全一致：基线 + 我这一份，点多少次都只算一份。
const REACT_KINDS = ['hug', 'tea', 'pat'];
const REACT_META = {
  hug: { label: '抱抱', emoji: '💖' },
  tea: { label: '递茶', emoji: '🍵' },
  pat: { label: '摸摸头', emoji: '🐾' }
};

function myReact(postId) {
  const m = read(KEYS.reactSet, {})[postId];
  return { hug: !!(m && m.hug), tea: !!(m && m.tea), pat: !!(m && m.pat) };
}

// 展示用的三项计数 = 基线 + 我那一份
function reactCounts(postId, p, mine) {
  const m = mine || myReact(postId);
  const base = read(KEYS.reactBase, {})[postId] || null;
  const raw = (p && p.react) || {};
  const out = {};
  REACT_KINDS.forEach((k) => {
    out[k] = (base && typeof base[k] === 'number')
      ? Math.max(0, base[k] + (m[k] ? 1 : 0))
      : (Number(raw[k]) || 0);
  });
  return out;
}

// 首次互动反推基线：把我这一份从现有数字里扣掉
function ensureReactBase(postId, p, mine) {
  const all = read(KEYS.reactBase, {});
  if (all[postId]) return all[postId];
  const raw = (p && p.react) || {};
  const base = {};
  REACT_KINDS.forEach((k) => {
    base[k] = Math.max(0, (Number(raw[k]) || 0) - (mine[k] ? 1 : 0));
  });
  all[postId] = base;
  write(KEYS.reactBase, all);
  return base;
}

// 云端权威值回来后刷新基线（云端给的是含我的总数）
function saveReactBase(postId, counts, mine) {
  const all = read(KEYS.reactBase, {});
  const base = {};
  REACT_KINDS.forEach((k) => {
    base[k] = Math.max(0, (Number(counts && counts[k]) || 0) - (mine && mine[k] ? 1 : 0));
  });
  all[postId] = base;
  write(KEYS.reactBase, all);
}

// 点一下树洞回应：同一项再点是收回，不同项互不影响
function toggleReact(postId, kind) {
  const k = REACT_KINDS.indexOf(kind) >= 0 ? kind : 'hug';
  const posts = read(KEYS.posts, []);
  const idx = posts.findIndex((p) => p.id === postId);
  if (idx < 0) return null;
  const p = posts[idx];

  const mine = myReact(postId);
  const was = !!mine[k];

  // 连点保护：和赞踩同一套，只是 key 带上动作名，抱抱和递茶互不挡
  if (voteThrottled(postId + '#r#' + k)) {
    const c = reactCounts(postId, p, mine);
    return Object.assign({}, p, { react: c, myReact: mine });
  }

  const nextMine = Object.assign({}, mine);
  nextMine[k] = !was;

  // 先写「我的选择」，再用旧状态反推基线（顺序反过来会把刚点的这份算进基线里）
  const all = read(KEYS.reactSet, {});
  all[postId] = nextMine;
  write(KEYS.reactSet, all);
  ensureReactBase(postId, p, mine);

  const counts = reactCounts(postId, p, nextMine);
  p.react = counts;
  write(KEYS.posts, posts);

  if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
    try {
      require('./user.js').holeReact(postId, k, !was).then((r) => {
        if (r && r.ok && r.counts) {
          const serverMine = r.mine || nextMine;
          saveReactBase(postId, r.counts, serverMine);
          const cur = read(KEYS.posts, []);
          const t = cur.find((x) => x.id === postId);
          if (t) {
            t.react = reactCounts(postId, t, serverMine);
            write(KEYS.posts, cur);
          }
        } else if (r && r.msg) {
          // 云端没记上（多半是 post_reactions 集合还没建）。这句话以前只在云函数里
          // 返回、前端从不看，用户以为别人也看得到这个抱抱 —— 必须说出来
          require('./feedback.js').toast(r.msg);
        }
      }).catch(() => {});
    } catch (e) {}
  }
  return Object.assign({}, p, { react: counts, myReact: nextMine });
}

// 我举报过这条内容吗？只看本地那份记录（服务端才是权威，这边只管按钮状态）
function hasReported(id) {
  return !!read(KEYS.reportedSet, {})[id];
}

// 记下「我举报过了」。只记本地：云端 reports 集合里已经有权威记录，
// 同一个人重复举报云端会返回「已经举报过了」，本地这份纯粹是给按钮用的
function markReported(id) {
  if (!id) return false;
  const set = read(KEYS.reportedSet, {});
  set[id] = true;
  write(KEYS.reportedSet, set);
  return true;
}

// 同一套记录，只是多带一个帖子 id：留言长在帖子里面，
// 光靠留言自己的 id 认人，换一条帖子就有可能认错
function commentReportKey(postId, commentId) {
  return String(postId || '') + '#' + String(commentId || '');
}
function hasReportedComment(postId, commentId) {
  return !!read(KEYS.reportedSet, {})[commentReportKey(postId, commentId)];
}
function markReportedComment(postId, commentId) {
  const key = commentReportKey(postId, commentId);
  if (key === '#') return false;
  const set = read(KEYS.reportedSet, {});
  if (set[key]) return true;
  set[key] = true;
  write(KEYS.reportedSet, set);
  return true;
}

// 审核员置顶 / 取消置顶：本地先改（点了马上就有徽标），云端同步（别人手机上也看得到）。
// 云端会再验一次是不是审核员，所以前端改不了别人的帖子。
//
// until：置顶截止的毫秒时间戳，0 或不传 = 永久。
// 到期不靠谁来点一下 —— 读侧按 pinUntil 过滤（见 pinAliveNow），
// 云端每天一次的 pinSweep 再把 pinned 字段真正清掉
function setPostPinned(postId, pinned, until) {
  const posts = read(KEYS.posts, []);
  const hit = posts.find((p) => p.id === postId);
  if (!hit) return Promise.resolve({ ok: false, msg: '帖子不存在' });
  const u = pinned ? (Number(until) || 0) : 0;
  hit.pinned = !!pinned;
  hit.pinnedAt = pinned ? Date.now() : 0;
  hit.pinUntil = u;
  hit.pinOrder = pinned ? (Number(hit.pinOrder) || 0) : 0;
  write(KEYS.posts, posts);
  if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
    return Promise.resolve(require('./user.js').postPin(postId, !!pinned, u))
      .catch(() => ({ ok: true }));
  }
  return Promise.resolve({ ok: true });
}

// 管理员保存自定义置顶顺序：云端成功后再改本地，失败不会出现“本机顺序变了、全校没变”。
function setPinOrder(ids) {
  const list = [];
  (Array.isArray(ids) ? ids : []).forEach((id) => {
    const v = String(id || '');
    if (v && list.indexOf(v) < 0) list.push(v);
  });
  const apply = () => {
    const posts = read(KEYS.posts, []);
    const pos = {};
    list.forEach((id, i) => { pos[id] = i + 1; });
    let changed = false;
    posts.forEach((p) => {
      if (!p || !p.pinned) return;
      const n = pos[p.id] || 0;
      if ((Number(p.pinOrder) || 0) !== n) { p.pinOrder = n; changed = true; }
    });
    if (changed) write(KEYS.posts, posts);
    return { ok: true, ids: list };
  };
  if (!(cloud.cfg.USE_CLOUD && cloud.ensureCloud())) return Promise.resolve(apply());
  return require('./user.js').postPinOrder(list).then((r) => {
    if (!r || r.ok === false) return r || { ok: false, msg: '置顶顺序没保存' };
    return apply();
  }).catch(() => ({ ok: false, msg: '网络异常，置顶顺序没保存' }));
}

// 这条帖子此刻算不算置顶。
//
// 必须在这一层算，而不是只信 pinned 字段：定时清理一天只跑一次，
// 「今天 10 点到期」的帖子如果只靠云端清，会一直顶到明天 7:30。
// 读的一侧自己按时间判断，到期那一刻界面就恢复 —— 清理任务只是补写库，
// 不是正确性的唯一依靠
function pinAliveNow(p) {
  if (!p || !p.pinned) return false;
  const until = Number(p.pinUntil) || 0;
  return until === 0 || until > Date.now();
}

function getMyPosts() {
  return read(KEYS.posts, [])
    .map(decoratePost)
    .filter(notTombstoned('posts'))
    .filter(isMinePost)
    .sort((a, b) => atOf(b) - atOf(a));
}

// 云端 postsByAuthor 回来的摘要不一定带完整 comments，但评论区计数是权威值。
// 把它合并回本地帖子，unread.replyMap 才能立即看见“别人刚回了我”。
function applyCloudPostSummaries(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id);
  if (!list.length) return false;
  const posts = read(KEYS.posts, []);
  const byId = {};
  posts.forEach((p) => { if (p && p.id) byId[p.id] = p; });
  let changed = false;
  list.forEach((r) => {
    const p = byId[r.id];
    if (!p) {
      posts.push(Object.assign({}, r, {
        openid: r.openid || r._openid || r.authorOpenid || '',
        authorOpenid: r.authorOpenid || r.openid || r._openid || ''
      }));
      changed = true;
      return;
    }
    const fields = ['title', 'content', 'commentCount', 'status', 'pinned', 'pinUntil', 'pinOrder', 'time', 'edited', 'editedAt', 'board', 'courseId', 'courseName', 'images'];
    fields.forEach((k) => {
      if (r[k] !== undefined && r[k] !== p[k]) {
        p[k] = r[k];
        changed = true;
      }
    });
  });
  if (changed) write(KEYS.posts, posts);
  return changed;
}

// 名片页「TA 的历史发帖」的**本地兜底**那份。
//
// 权威数据在云端（见 utils/user.js 的 postsByAuthor）：本地缓存只有最近 20 条
// （PAGE_SIZE），拿它当准会把「发过 50 条的人」显示成 3 条。但云端那条路要云函数
// 支持，未部署 / 断网时是空的 —— 那时候有本地这几条，总比空着说「TA 没发过帖子」强。
// 所以名片页是「先本地立即渲染 → 云端结果回来覆盖」。
//
// ⚠️ 匿名帖与树洞帖必须排除，和云函数侧同一条规矩：匿名是发帖人可依赖的承诺，
//    把匿名帖挂在某人名下等于当众点名。两处各写一套过滤条件迟早漂移，
//    所以这里取「保守过滤」—— 只要有任何一项对不上就不显示。
function getPostsBy(openid) {
  const who = String(openid || '');
  if (!who) return [];
  return read(KEYS.posts, [])
    .map(decoratePost)
    .filter(notTombstoned('posts'))
    .filter((p) => p.openid === who)
    .filter((p) => !p.anonymous && p.board !== HOLE_BOARD)
    .filter((p) => !p.hidden)
    .sort((a, b) => atOf(b) - atOf(a));
}

// 云端删除的唯一出口。三种结果说清楚，调用方才不会把「没开云」当成失败：
//   'ok'   云端删掉了
//   'skip' 没开云 / 没有云环境（本地模式）：删本地就算完成
//   'fail' 调了但没成功（断网、云函数没部署、没有权限）
function removeOnCloud(targetType, id) {
  if (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud()) return Promise.resolve('skip');
  return require('./user.js').delContent(targetType, id)
    .then((r) => (r && r.ok ? 'ok' : 'fail'))
    .catch(() => 'fail');
}

// 删除帖子（force=true 表示审核员删他人内容，跳过归属校验）
//
// 顺序是「先云端、后本地」。反过来的话，云端失败会留下一个更糟的状态：
// 本机看不见、别人还看得见，下次同步又把它拉回来 —— 用户会以为「删了又冒出来」。
// 宁可这次删不掉并明确让他重试，也不制造这种两份数据。
//
// @returns {Promise<{ok:boolean, cloud:string, msg:string}>}
//   ok=false 且 cloud='fail' → 云端没删掉，本地也没动，可以重试
//   ok=false 且 cloud='skip' → 没有权限（msg 里有原因）
async function deletePost(postId, force) {
  const posts = read(KEYS.posts, []);
  const oid = myOpenid();
  const hit = posts.find((p) => p.id === postId);
  // 云端帖子上来时字段是 _openid / authorOpenid，本地新帖是 openid，三种都认
  const hitOpenid = hit ? (hit.openid || hit._openid || hit.authorOpenid || '') : '';
  if (!force && hit && oid && hitOpenid && hitOpenid !== oid) {
    return { ok: false, cloud: 'skip', msg: '只能删除自己发布的内容' };
  }

  // 必须走云函数删：客户端 SDK 在安全规则下不允许 where().remove() 批量删除，
  // 而示例帖的 _openid 是空的，「仅创建者可写」权限下前端一条都删不掉，
  // 本地删了云端还在，下次同步又回来——这就是「删了重进还在」的根源
  const r = await removeOnCloud('post', postId);
  if (r === 'fail') {
    return { ok: false, cloud: 'fail', msg: '云端删除失败，请检查网络后重试' };
  }

  // 重新读一次：await 期间可能有别的写入（点赞、新帖），拿旧数组整份写回会覆盖掉
  write(KEYS.posts, read(KEYS.posts, []).filter((p) => p.id !== postId));
  addTombstone('posts', postId);
  return { ok: true, cloud: r, msg: '' };
}

// 评价下架 / 恢复：被举报的评价自动下架后，这里能给作者一个申诉入口
function setReviewStatus(reviewId, status) {
  const reviews = read(KEYS.reviews, []);
  const idx = reviews.findIndex((r) => r.id === reviewId);
  if (idx < 0) return false;
  reviews[idx].status = status === 'hidden' ? 'hidden' : 'normal';
  write(KEYS.reviews, reviews);
    if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
      // 改状态走云函数：客户端在「仅创建者可写」权限下改不动云端记录，
      // 本地改了云端没改，下次同步又被覆盖回去
      try {
        require('./user.js').patchContent('review', reviewId, { status: reviews[idx].status });
      } catch (e) {}
    }
    return true;
}

module.exports = {
  getBoards,
  isModerator,
  visibleToMe,
  myVote,
  decoratePost,
  // 匿名的两个口径：谁算匿名内容、代号怎么取。
  // 页面别自己写一遍 —— 一旦和这里不一致，就会出现「帖匿名、评论实名」这种半截状态
  isAnonPost,
  anonCodeOf,
  buildVoteData,
  largestRemainder,
  castVote,
  hotScore,
  isMinePost,
  getPosts,
  getHolePosts,
  getHiddenPosts,
  getPostById,
  setPostStatus,
  restorePost,
  updatePost,
  rollbackPost,
  commitPost,
  addPost,
  addComment,
  removeComment,
  markCommentRemoved,
  // 留言的赞 / 踩 / 举报 / 二级回复（本轮新增）
  REPLY_MAX_DEPTH,
  REPLY_PREVIEW,
  buildCommentTree,
  decorateComments,
  applyCloudComments,
  replyTargetOf,
  myCommentVote,
  commentVoteCounts,
  toggleCommentVote,
  commentReportOf,
  markCommentReport,
  commentReportLabel,
  voteThrottled,
  toggleVote,
  toggleLike,
  myReact,
  reactCounts,
  ensureReactBase,
  saveReactBase,
  toggleReact,
  hasReported,
  markReported,
  commentReportKey,
  hasReportedComment,
  markReportedComment,
  setPostPinned,
  setPinOrder,
  pinAliveNow,
  getMyPosts,
  applyCloudPostSummaries,
  getPostsBy,
  deletePost,
  setReviewStatus,
  REACT_KINDS,
  REACT_META
};
