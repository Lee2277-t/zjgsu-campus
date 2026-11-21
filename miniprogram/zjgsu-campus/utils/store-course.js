// utils/store-course.js —— 课程 + 课程评价（决策卡 / 老师口碑 / 类型纠正）
// 基础设施（KEYS / read / write / 墓碑 / 工具函数）统一来自 store-base.js；
// 跨模块调用通过 require 同级 store-* 模块获取，不跨文件改写逻辑。

const { KEYS, read, write, myOpenid, cloud, seed, notTombstoned, addTombstone, genId, today, waitOpenid, ANON_NAME } = require('./store-base.js');
const { getUser } = require('./store-user.js');
const { isModerator } = require('./store-forum.js');

/* ---------------- 课程评价 ---------------- */

// 平均分实时由评价列表计算（跨设备一致），不再依赖课程对象里的计数器
function calcStats(course, reviews) {
  const cr = reviews.filter((r) => canonicalCourseId(r.courseId) === course.id);
  // score=0 表示“只有文字、没有打分”。它仍然是一条评价/课程信息，
  // 但不能进平均分和星级分布，否则会把所有客观信息当成 0 星差评。
  const scored = cr.filter((r) => Number(r.score) > 0);
  const avg = scored.length
    ? (scored.reduce((s, r) => s + Number(r.score), 0) / scored.length).toFixed(1)
    : '0.0';

  // 分布 + 标签热度一次遍历算完：原来要扫 6 遍评价数组，900+ 门课时直接把 JS 线程跑满
  const buckets = {};
  const heat = {};
  cr.forEach((r) => {
    const s = Number(r.score) || 0;
    if (s > 0) buckets[s] = (buckets[s] || 0) + 1;
    (r.tags || []).forEach((t) => { heat[t] = (heat[t] || 0) + 1; });
  });
  const dist = [];
  for (let s = 5; s >= 1; s -= 1) {
    dist.push({ star: s, count: buckets[s] || 0 });
  }
  const tagList = Object.keys(heat).map((k) => ({ name: k, count: heat[k] }))
    .sort((a, b) => b.count - a.count).slice(0, 5);

  return {
    avgScore: avg,
    reviewCount: cr.length,
    scoredCount: scored.length,
    unscoredCount: cr.length - scored.length,
    hasScore: scored.length > 0,
    starOn: Math.round(Number(avg)),
    dist,
    tags: tagList,
    hotTag: tagList.length ? tagList[0].name : ''
  };
}

// 评价排序统一按 at（毫秒）倒序；老评价没有 at 时退回 time 字符串。
// 导入的选课指南同一天写入，只有 at 能区分先后，不能只看 time。
function reviewTime(r) {
  const at = Number(r && r.at);
  if (at) return at;
  const t = Date.parse(String((r && r.time) || '').replace(/-/g, '/'));
  return isNaN(t) ? 0 : t;
}

// 课程页顶部的「决策卡」：让查课的同学直接看到结论，而不是自己去翻评论
function getCourseInsight(courseId) {
  const course = getCourseById(courseId);
  if (!course) return null;
  const reviews = read(KEYS.reviews, []);
  const stats = calcStats(course, reviews);
  if (!stats.reviewCount) {
    return Object.assign({}, course, stats, { summary: '还没有人评价，做第一个吧' });
  }
  if (!stats.scoredCount) {
    return Object.assign({}, course, stats, {
      summary: '已有 ' + stats.reviewCount + ' 条课程信息，暂无评分，选课前建议看看原文'
    });
  }
  let summary;
  const tagTip = stats.hotTag ? '，常提到「' + stats.hotTag + '」' : '';
  if (stats.scoredCount < 3) {
    // 样本太少不下结论，只陈述事实，免得误导后面选课的人
    summary = '综合 ' + stats.avgScore + ' 分，目前只有 ' + stats.scoredCount + ' 条评分，样本还少，建议看看原文';
  } else if (Number(stats.avgScore) >= 4) {
    summary = '综合 ' + stats.avgScore + ' 分，' + stats.scoredCount + ' 条评分整体偏好' + tagTip;
  } else {
    summary = '综合 ' + stats.avgScore + ' 分，评价偏谨慎' + tagTip + '，选课前建议看看原文';
  }
  return Object.assign({}, course, stats, { summary });
}

// 课程列表用的轻量统计：只算均分 / 评价数 / 星级 / 最热标签，不整块重算分布
// 列表页要渲染几十门课，逐门跑 calcStats 会在低端机上明显掉帧
// 结果按「评价数组的引用」缓存：评价没变就不重算，搜索框每敲一个字也不再反复扫 900+ 门课
//
// goodRate（好评率）= 打 4 星及以上的评价占比（百分比整数，四舍五入）。
// 「评分高」和「多数人说好」是两件事：一门 3.8 分但人人都说「还行」的课，
// 比一门 4.2 分但一半人给 1 星的课更值得选，排序时这是独立的一档。
// 课程名可能带空格、全角括号或不同写法；去重键必须和 seed.js 使用同一口径。
function courseNameKey(name) {
  return String(name || '').replace(/\s+/g, '').replace(/[（）()《》]/g, '').toLowerCase();
}

let _courseAliasCache = null;
function readCourseAlias() {
  if (_courseAliasCache) return _courseAliasCache;
  const v = read(KEYS.courseAlias, {});
  _courseAliasCache = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  return _courseAliasCache;
}

// 重复课程只保留一个 id，历史评价 / 旧链接仍能落到保留的那门课上。
function canonicalCourseId(id) {
  const raw = String(id || '');
  if (!raw) return '';
  const alias = readCourseAlias();
  let cur = raw;
  const seen = {};
  while (alias[cur] && !seen[cur]) {
    seen[cur] = true;
    cur = String(alias[cur]);
  }
  return cur;
}

let _statsCache = null;
function courseStatsMap() {
  const reviews = read(KEYS.reviews, []);
  if (_statsCache && _statsCache.src === reviews) return _statsCache.map;
  const map = {};
  reviews.forEach((r) => {
    const id = canonicalCourseId(r.courseId);
    if (!id) return;
    let s = map[id];
    if (!s) {
      s = map[id] = { sum: 0, scored: 0, count: 0, good: 0, heat: {} };
    }
    const score = Number(r.score) || 0;
    s.count += 1;
    if (score > 0) {
      s.sum += score;
      s.scored += 1;
      if (score >= 4) s.good += 1;
    }
    (r.tags || []).forEach((t) => { s.heat[t] = (s.heat[t] || 0) + 1; });
  });
  Object.keys(map).forEach((id) => {
    const s = map[id];
    const avg = s.scored ? s.sum / s.scored : 0;
    const hot = Object.keys(s.heat).sort((a, b) => s.heat[b] - s.heat[a])[0] || '';
    map[id] = {
      avgScore: avg.toFixed(1),
      reviewCount: s.count,
      scoredCount: s.scored,
      unscoredCount: s.count - s.scored,
      hasScore: s.scored > 0,
      starOn: Math.round(avg),
      hotTag: hot,
      goodRate: s.scored ? Math.round((s.good / s.scored) * 100) : -1
    };
  });
  _statsCache = { src: reviews, map: map };
  return map;
}

// 没有评价时的空统计（goodRate 用 -1 表示「还没人评，没有好评率」）
const EMPTY_STATS = { avgScore: '0.0', reviewCount: 0, scoredCount: 0, unscoredCount: 0, hasScore: false, starOn: 0, hotTag: '', goodRate: -1 };

// 课程类型（专业课 / 通识课 / 体育课 / 思政课）；旧专业类型自动归并。
// 老用户的本地课程缓存没有 ctype 字段（该字段是后加的），存储不能整份重写，
// 所以展示层统一在这里补：有 ctype 的照用，没有的按课名推断并缓存。
// 推断函数全站只有 seed.js 那一份，改判据只动那里。
const _ctypeCache = {};
// 课程类型纠错表：课程 id → 同学纠正后的类型。
// 缓存一份在内存里，setCourseType 写完置空，下次读库自动生效
let _ctypeFixes = null;
function ctypeFixMap() {
  if (_ctypeFixes) return _ctypeFixes;
  _ctypeFixes = read(KEYS.ctypeFix, {});
  return _ctypeFixes;
}

function attachCourseType(c) {
  // 同学纠正过的类型优先级最高：不管课名像什么，以纠错为准。
  // 这是「按类型筛选」能不能让人信得过的关键 —— 猜错了还没处改，筛选就废了
  const fixed = seed.normalizeCourseType(ctypeFixMap()[c.id]);
  if (fixed) return Object.assign({}, c, { ctype: fixed });
  const own = seed.normalizeCourseType(c.ctype);
  if (own) return Object.assign({}, c, { ctype: own });
  const cached = seed.normalizeCourseType(_ctypeCache[c.name]);
  if (cached) return Object.assign({}, c, { ctype: cached });
  const t = seed.guessCourseType(c.name);
  _ctypeCache[c.name] = t;
  return Object.assign({}, c, { ctype: t });
}

// 同学纠正一门课的类型：本机立即生效，云端异步存（所有同学共享这份纠正）。
// 返回云端结果 —— 云端没存住要如实说，别让改的人以为全校都已经看到
function setCourseType(id, ctype) {
  if (!id) return Promise.resolve({ ok: false, msg: '课程 id 丢了，改不了' });
  const t = seed.pickCourseType(ctype, '');
  const map = read(KEYS.ctypeFix, {});
  map[id] = t;
  write(KEYS.ctypeFix, map);
  _ctypeFixes = null;
  return require('./user.js').courseTypeSet(id, t)
    .then((r) => r || { ok: false, saved: false, msg: '云端连不上，先记在你手机上' });
}

// 开机拉一次全校的课程类型纠正，跟本机的合并。
// 一次就够：纠错数据很小，改动频率低，每次进页面都拉是浪费
let _ctypeSynced = false;
function syncCourseTypes() {
  if (_ctypeSynced) return;
  if (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud()) return;
  _ctypeSynced = true;
  require('./user.js').courseTypeList().then((r) => {
    if (!r || r.ok === false || !r.fixes) return;
    const map = read(KEYS.ctypeFix, {});
    Object.keys(r.fixes).forEach((k) => { map[k] = r.fixes[k]; });
    write(KEYS.ctypeFix, map);
    _ctypeFixes = null;
  }).catch(() => { _ctypeSynced = false; });
}

function getCourses() {
  const stats = courseStatsMap();
  const seen = {};
  return read(KEYS.courses, []).filter((c) => {
    if (!c || !c.id) return false;
    const key = courseNameKey(c.name) || c.id;
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  }).map((c) => attachCourseType(Object.assign({}, c, stats[c.id] || EMPTY_STATS)));
}

function getCourseById(id) {
  const cid = canonicalCourseId(id);
  const list = read(KEYS.courses, []);
  const c = list.find((x) => x.id === cid);
  if (!c) return null;
  const stats = courseStatsMap()[c.id] || EMPTY_STATS;
  return attachCourseType(Object.assign({}, c, stats));
}

function getColleges() {
  return seed.colleges;
}

// 按课程名查重：避免同学把同一门课重复添加多次
function findCourseByName(name) {
  const n = courseNameKey(name);
  if (!n) return null;
  const list = read(KEYS.courses, []);
  return list.find((c) => courseNameKey(c.name) === n) || null;
}

// 同学自建课程：官方目录覆盖不到的课由同学互助补齐，写入云端供全校共享
function addCourse({ name, college, major, credit, ctype }) {
  // 页面通常已经查过一次；这里再兜底一次，防止网络回来 / 并发点击造成同名双写。
  const existed = findCourseByName(name);
  if (existed) return existed;
  const course = {
    id: 'u' + Date.now() + Math.floor(Math.random() * 1000),
    name: String(name || '').trim(),
    college: college || '其他学院',
    major: major || '未分类',
    credit: Number(credit) || 3,
    tags: ['同学共建'],
    description: '同学互助添加的课程，还没有人写描述～ 快来补一条真实评价帮到学弟学妹。',
    builtin: false,
    // 课程类型：加课的人在页面上挑了就以他挑的为准，没挑才按课名推断
    // （官方目录几乎全是专业课，光看名字推不出体育课 / 思政课）
    ctype: seed.pickCourseType(ctype, name),
    // 谁加的必须记下来：不然误加了想删的时候，认不出这门课归谁，
    // 就只能删所有人的课（危险）或者谁都删不掉（就是之前的状况）
    openid: myOpenid()
  };
  const list = read(KEYS.userCourses, []);
  list.unshift(course);
  write(KEYS.userCourses, list);
  refreshCourses();

    if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
      // 走云函数：课程名也会被拿来塞广告，服务端一并过审
      try { require('./user.js').courseAdd(course); } catch (e) {}
    }
    return course;
}

// 这门课是不是「我加的」：
// ① 官方课程（builtin === true）谁都删不了；
// ② 双方 openid 都在手 → 严格比对，这是最可靠的一档；
// ③ 我是新加的课但本地还没拿到 openid（冷启动）→ 按 builtin === false 放行，
//    否则用户会碰上「自己刚加的课删不掉」；
// ④ 课上有别人的 openid 而我没有 → 不放行。
function isMineCourse(c) {
  if (!c) return false;
  if (c.builtin === true) return false;
  const oid = myOpenid();
  const owner = c.openid || c._openid || '';
  if (oid && owner) return owner === oid;
  if (owner && !oid) return false;   // 是别人加的，我还没拿到身份也不能删
  return c.builtin === false;        // 没有归属信息的旧数据：自建课程放行
}

// 删除同学自己误加的课程。
// 比删帖子多一道顾虑：这门课可能已经有人写过评价了，不能把别人的内容一起弄丢。
// 所以先查有没有评价，有就拦下来问清楚，由调用方决定要不要继续。
async function removeCourse(id, opts) {
  const force = !!(opts && opts.force);
  const course = read(KEYS.courses, []).find((c) => c.id === id);
  if (!course) return { ok: false, msg: '这门课找不到了' };
  if (course.builtin === true) return { ok: false, msg: '官方课程不能删除' };
  if (!isMineCourse(course)) return { ok: false, msg: '只能删除自己添加的课程' };

  // 有人评价过：除非明确说 force，否则先告诉调用方，别默默把别人的评价变成孤儿
  const used = read(KEYS.reviews, []).filter((r) => r.courseId === id);
  if (used.length && !force) {
    return { ok: false, needConfirm: true, reviewCount: used.length, msg: '这门课下已经有 ' + used.length + ' 条评价' };
  }

  // 先删云端再删本地：云端留一份没删掉的话，下次同步那门误加的课又会冒出来
  // （跟「删了重进还在」是同一个坑）。云端确认删掉了，本地才清。
  if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
    try {
      const r = await require('./user.js').courseRemove(id, course.name);
      if (r && r.ok === false) {
        return { ok: false, saved: false, msg: r.msg || '云端没能删掉', detail: r.detail || '' };
      }
    } catch (e) {
      return { ok: false, saved: false, msg: '云端暂时连不上，稍后再删', detail: String((e && e.message) || e || '') };
    }
  }

  write(KEYS.userCourses, read(KEYS.userCourses, []).filter((c) => c.id !== id));
  refreshCourses();
  // 连评价一起清：课程都没了，挂在它下面的评价点进去是无主页面
  if (used.length) {
    write(KEYS.reviews, read(KEYS.reviews, []).filter((r) => r.courseId !== id));
  }
  return { ok: true, reviewCount: used.length };
}

// 只清本地那份。用在「申请删除」凑够票的场景：
// 云端那边已经由云函数删掉了，前端再调一次 courseRemove 只会得到「只能删除自己添加的课程」，
// 所以这里不走权限校验，纯粹是把本地这份镜像丢掉，评价也一起清（否则点进去是无主页面）。
function dropCourseLocal(id) {
  const n = read(KEYS.reviews, []).filter((r) => r.courseId === id).length;
  write(KEYS.userCourses, read(KEYS.userCourses, []).filter((c) => c.id !== id));
  if (n) write(KEYS.reviews, read(KEYS.reviews, []).filter((r) => r.courseId !== id));
  refreshCourses();
  return { ok: true, reviewCount: n };
}

// 判断某条评价是不是「我」发的：和帖子一套逻辑（见 isMinePost 的说明）
function isMineReview(r) {
  const myOid = myOpenid();
  const rOid = r.openid || r._openid || '';
  if (myOid && rOid) return rOid === myOid;
  return !!r.nickName && r.nickName === getUser().nickName;
}

// 评价展示：匿名的一律显示成「匿名同学」，真名只留在数据里给自己看
function decorateReview(r) {
  const showName = (r.anonymous || (!r.openid && !r.nickName))
    ? ANON_NAME
    : (r.nickName || ANON_NAME);
  const score = Number(r.score) || 0;
  return Object.assign({}, r, {
    showName: showName,
    isMine: isMineReview(r),
    hasScore: score > 0,
    starOn: score,
    scoreText: score > 0 ? score.toFixed(1) : ''
  });
}

function getReviews(courseId) {
  const list = read(KEYS.reviews, []);
  return list
    .filter(notTombstoned('reviews'))
    .filter((r) => canonicalCourseId(r.courseId) === canonicalCourseId(courseId))
    .filter((r) => {
      if (!r.status || r.status === 'normal') return true;
      // 被下架的评价：作者本人和审核员还能看到，其余人看不到
      return isMineReview(r) || isModerator();
    })
    .sort((a, b) => reviewTime(b) - reviewTime(a))
    .map(decorateReview);
}

// 按 id 取一条评价：收藏里存了评价 id，得能拿回内容才知道标题是什么
function getReviewById(id) {
  const r = read(KEYS.reviews, []).find((x) => x.id === id);
  return r ? decorateReview(r) : null;
}

// 全部本地评价（含下架的）。老师聚合、跨课程看某位老师的评价都要遍历它，
// 不然同学补充的任课老师会和课程评价割裂成两拨数据。
function getAllReviews() {
  return read(KEYS.reviews, [])
    .filter(notTombstoned('reviews'))
    .map(decorateReview)
    .sort((a, b) => reviewTime(b) - reviewTime(a));
}

// 一门课里出现过的任课老师（同学填的 teacher 字段聚合出来的）
//
// 老师分和课程分必须分开算，这是两个意思：
// 「课给 5 分、老师给 2 分」是常态（课好、老师差），混在一起算，这位老师永远看不出问题。
// teacherScore 为 0 表示「这位同学没给老师打分」，不参与老师均分，但课程分照常计入。
const NO_TEACHER_SCORE = 0;

function scoreAvg(list) {
  const vals = (list || []).map(Number).filter((v) => v > 0);
  if (!vals.length) return 0;
  return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
}

function getCourseTeachers(courseId) {
  const map = {};
  getAllReviews().forEach((r) => {
    const t = String(r.teacher || '').trim();
    if (!t || canonicalCourseId(r.courseId) !== canonicalCourseId(courseId)) return;
    if (!map[t]) {
      map[t] = {
        name: t, count: 0, verified: false,
        teacherScores: [],   // 同学们给这位老师的分，一条一个，不去重（同分两条就是两个人的意见）
        courseScores: [],    // 同一批评价里的课程分，两摊数据各算各的
        explicit: 0          // 有几个人是认认真真打了老师分的（老数据没有这个字段）
      };
    }
    const it = map[t];
    const score = Number(r.score) || 0;
    const ts = Number(r.teacherScore) || NO_TEACHER_SCORE;
    it.count += 1;
    if (score > 0) it.courseScores.push(score);
    if (ts) {
      it.teacherScores.push(ts);
      it.explicit += 1;
    } else if (score > 0 && !r.importSource) {
      // 旧用户评价没有老师分字段，才用课程分兜底；导入的选课指南不能这样冒充老师分
      it.teacherScores.push(score);
    }
    // 命中过官方名录那条就一直留着勾：后续同学补充的失误不会把它抹掉
    if (r.teacherVerified) it.verified = true;
  });
  return Object.keys(map).map((k) => {
    const it = map[k];
    const avg = scoreAvg(it.teacherScores);
    return {
      name: it.name,
      count: it.count,
      verified: it.verified,
      // 老师分：没人单独打过分就先给 0，页面上显示「还没人打分」
      avg: avg,
      avgRound: Math.round(avg),
      scoredCount: it.explicit,
      courseScoredCount: it.courseScores.length,
      // 课程分：回答「提到这位老师的这些评价里，课本身是什么水平」
      courseAvg: scoreAvg(it.courseScores)
    };
  }).sort((a, b) => b.avg - a.avg || b.count - a.count);
}

// 全站老师口碑总表：课程列表页「老师评价」那一档就靠它。
//
// 为什么不在页面里自己算：老师档要的是「按人聚合」，而评价是一条条课程评价，
// 每个人名都要把课程分和老师分两摊分开算一遍，散在页面里改起来容易一处漏。
// 口径和课程详情页「老师评价」那一栏保持一致（老数据没打老师分的拿课程分顶上）。
function getTeacherBoard() {
  const map = {};
  getAllReviews().forEach((r) => {
    const t = String(r.teacher || '').trim();
    if (!t) return;
    if (!map[t]) {
      map[t] = { name: t, count: 0, tScores: [], cScores: [], good: 0, courseScored: 0, explicit: 0, verified: false, courses: [] };
    }
    const it = map[t];
    const score = Number(r.score) || 0;
    const ts = Number(r.teacherScore) || NO_TEACHER_SCORE;
    it.count += 1;
    if (score > 0) {
      it.cScores.push(score);
      it.courseScored += 1;
      if (score >= 4) it.good += 1;
    }
    if (ts) {
      it.tScores.push(ts);
      it.explicit += 1;
    } else if (score > 0 && !r.importSource) {
      it.tScores.push(score);
    }
    if (r.teacherVerified) it.verified = true;
    if (r.courseId && it.courses.indexOf(r.courseId) < 0) it.courses.push(r.courseId);
  });
  return Object.keys(map).map((k) => {
    const it = map[k];
    const avg = scoreAvg(it.tScores);
    const courseAvg = scoreAvg(it.cScores);
    // 课程名在这里查好：WXML 里拿不到 id 对应的课名，列表上只显示个课程 id 没人看得懂
    const names = it.courses
      .map((cid) => (getCourseById(cid) || {}).name)
      .filter(Boolean)
      .slice(0, 2);
    return {
      name: it.name,
      count: it.count,
      verified: it.verified,
      avg: avg,
      avgRound: Math.round(avg),
      courseAvg: courseAvg,
      courseCount: it.courses.length,
      courseNames: names.join('、'),
      scoredCount: it.explicit,
      courseScoredCount: it.courseScored,
      // 好评率：只算真正打了课程分的评价，未评分的课程信息不参与
      goodRate: it.courseScored ? Math.round((it.good / it.courseScored) * 100) : -1
    };
  }).sort((a, b) => b.avg - a.avg || b.count - a.count || a.name.localeCompare(b.name));
}

// 按老师名筛评价。courseId 传了就只看这门课，不传就是全站搜这位老师。
function getReviewsByTeacher(name, courseId) {
  const n = String(name || '').trim();
  if (!n) return [];
  return getAllReviews().filter((r) => {
    if (String(r.teacher || '').trim() !== n) return false;
    if (courseId && canonicalCourseId(r.courseId) !== canonicalCourseId(courseId)) return false;
    return !r.status || r.status === 'normal' || isMineReview(r) || isModerator();
  });
}

// teacher 是同学自己填的任课老师名（可选）。选填——很多人就是想吐槽整门课，
// 强制填会把评价卡在半路；但填了就能按老师聚合，别人查老师时找得到。
// teacherScore 是「给这位老师的分」，和上面的 score（给课程的分）是两码事：
// 同学想说「课 5 分、老师 2 分」时，两栏都会记下自己的数字，不会互相污染。
// 留 0 表示这位同学没单独给老师打分，别人看那位老师时不会把他算进去。
async function addReview({ courseId, score, content, tags, anonymous = false, teacher = '', teacherVerified = false, teacherScore = 0 }) {
  const review = {
    id: genId(),
    courseId,
    nickName: getUser().nickName,
    anonymous: !!anonymous,
    score: Number(score),
    content,
    time: today(),
    tags: tags || [],
    teacher: String(teacher || '').trim(),
    teacherVerified: !!teacherVerified,
    teacherScore: Math.max(0, Math.min(5, Math.round(Number(teacherScore) || 0)))
  };
  const oid = myOpenid();
  if (oid) review.openid = oid;

  // 本地先落地，断网也能看得到自己刚写的那条（见 addPost 的说明）
  const reviews = read(KEYS.reviews, []);
  reviews.unshift(review);
  write(KEYS.reviews, reviews);

  if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
    // 同 addPost：客户端拿不到 openid 不再拦着不发 —— 服务端身份来自微信 context，
    // 跟 login 云函数部署与否无关。等一轮只为本地「我的评价」能马上认领。
    if (!myOpenid()) await waitOpenid();
    // 走云函数：服务端过审，绕过云函数直接写库躲不过去
    try {
      const r = await require('./user.js').reviewAdd(review);
      if (r && r.ok === false) {
        // 同 addPost：审核驳回才撤本地；云端存不进去 / 云端侧问题必须留下用户写的那条
        const cloudSide = r.saved === false || /无法识别用户身份|未知操作/.test(String(r.msg || ''));
        if (!cloudSide) {
          write(KEYS.reviews, read(KEYS.reviews, []).filter((x) => x.id !== review.id));
          return { ok: false, msg: r.msg || '评价没能发出去', review: review };
        }
        return {
          ok: false,
          saved: false,
          msg: '已存在本机，但没能同步到云端（' + (r.msg || '写入失败') + '）',
          detail: r.detail || '',
          review: review
        };
      }
      // 发布成功：服务端回传的 doc 带真实 openid，补到本地这条上，「我的评价」立刻认领得上
      if (r && r.review && r.review.openid && !review.openid) {
        const cur = read(KEYS.reviews, []);
        const t = cur.find((x) => x.id === review.id);
        if (t) { t.openid = r.review.openid; write(KEYS.reviews, cur); }
        review.openid = r.review.openid;
      }
      // 名录核实以云端为准：本地是照「没查过」先写的，云端命中名录会补一个 true。
      // 不同步回来的话，作者自己看到的结果会和别人看到的不一样。
      if (r && r.review && r.review.teacherVerified && !review.teacherVerified) {
        review.teacherVerified = true;
        const cur2 = read(KEYS.reviews, []);
        const t2 = cur2.find((x) => x.id === review.id);
        if (t2) { t2.teacherVerified = true; write(KEYS.reviews, cur2); }
      }
    } catch (e) {
      return {
        ok: false,
        saved: false,
        msg: '已存在本机，云端暂时连不上',
        detail: String((e && e.message) || e || ''),
        review: review
      };
    }
  }
  return { ok: true, review: decorateReview(review) };
}

// 改自己那条评价（匿名设置跟随修改一起生效，云端确认后才算保存成功）
async function updateReview(id, patch) {
  const reviews = read(KEYS.reviews, []);
  const idx = reviews.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const oid = myOpenid();
  if (oid && reviews[idx].openid && reviews[idx].openid !== oid) return null;

  if (!isMineReview(reviews[idx])) return null;
  const before = Object.assign({}, reviews[idx]);
  const next = Object.assign({}, before, patch, { updatedAt: today() });
  reviews[idx] = next;
  write(KEYS.reviews, reviews);

  if (cloud.cfg.USE_CLOUD && cloud.ensureCloud()) {
    try {
      const r = await require('./user.js').patchContent('review', id, patch);
      if (!r || r.ok === false) {
        // 云端没保存成功：把本地也退回去，避免“界面改了、刷新又回去”。
        const cur = read(KEYS.reviews, []);
        const i = cur.findIndex((x) => x.id === id);
        if (i >= 0) { cur[i] = before; write(KEYS.reviews, cur); }
        return { ok: false, msg: (r && r.msg) || '评价没同步到云端，请重试' };
      }
    } catch (e) {
      const cur = read(KEYS.reviews, []);
      const i = cur.findIndex((x) => x.id === id);
      if (i >= 0) { cur[i] = before; write(KEYS.reviews, cur); }
      return { ok: false, msg: '网络不太稳，评价没保存' };
    }
  }
  return { ok: true, review: decorateReview(next) };
}

// 删自己那条评价（云端也删，别人不会还看到你那条）
//
// 和 deletePost 同一条规矩：先云端、后本地。返回 { ok, cloud, msg }，
// cloud='fail' 时本地没动，调用方该提示重试而不是说「已删除」。
function removeReview(id) {
  const oid = myOpenid();
  const hit = read(KEYS.reviews, []).find((r) => r.id === id);
  if (!hit || !isMineReview(hit)) {
    return Promise.resolve({ ok: false, cloud: 'skip', msg: '只能删除自己写的评价' });
  }

  const done = (!cloud.cfg.USE_CLOUD || !cloud.ensureCloud())
    ? Promise.resolve('skip')
    // 和 deletePost 同理：删除走云函数，客户端直连删不掉
    : require('./user.js').delContent('review', id)
      .then((r) => (r && r.ok ? 'ok' : 'fail'))
      .catch(() => 'fail');

  return done.then((r) => {
    if (r === 'fail') return { ok: false, cloud: 'fail', msg: '云端删除失败，请检查网络后重试' };
    // await 期间可能有别的写入，重新读一次再写回
    write(KEYS.reviews, read(KEYS.reviews, []).filter((x) => x.id !== id));
    addTombstone('reviews', id);
    return { ok: true, cloud: r, msg: '' };
  });
}

// 我的评价：云模式下按 openid 认领，匿名发出去也能找到自己那条
function getMyReviews() {
  const reviews = read(KEYS.reviews, []).filter(notTombstoned('reviews'));
  const oid = myOpenid();
  const mine = oid
    ? reviews.filter((r) => r.openid === oid)
    : reviews.filter((r) => r.nickName === getUser().nickName);
  return mine.sort((a, b) => reviewTime(b) - reviewTime(a)).map(decorateReview);
}

// 课程的「身份证」必须是唯一的，否则后面全乱：同一条课在列表里出现两次、
// 点进去找不到（详情页白屏）、删课删错对象。
// 老数据云端只给了 _id，前端那个 id 是空 —— 这里补一个稳定的，并且写回本地，
// 下次同步接着用同一个，不会一条课变出好几个身份。
function ensureCourseId(c) {
  if (!c) return '';
  if (c.id) return c.id;
  if (c._id) { c.id = String(c._id); return c.id; }
  c.id = 'u' + Date.now() + Math.floor(Math.random() * 1000);
  return c.id;
}

// 课程目录 = 官方 seed 课程 + 同学自建课程（自建排在前，避免被官方目录吞掉）
function refreshCourses() {
  const mine = read(KEYS.userCourses, []);
  // 顺手把缺 id 的自建课补上 id 并落盘：只补在内存里的话，
  // 下次读缓存又是没 id 的那条，白屏会一直复发
  let patched = false;
  mine.forEach((c) => {
    if (!c) return;
    if (!c.id) { ensureCourseId(c); patched = true; }
  });
  if (patched) write(KEYS.userCourses, mine);

  // 同名课程以官方 seed 为 canonical（保留 c1... 稳定 id）；自建同名课只留下
  // alias，不重复展示。这样既不会把旧评价变成孤儿，也不会出现两张一样的卡。
  const alias = readCourseAlias();
  const officialByName = {};
  seed.courses.forEach((c) => {
    const key = courseNameKey(c && c.name);
    if (key && !officialByName[key]) officialByName[key] = c;
  });

  const out = [];
  const keptIds = {};
  const byName = {};
  mine.forEach((c) => {
    if (!c || !c.id) return;
    const key = courseNameKey(c.name) || ('#' + c.id);
    const official = officialByName[key];
    if (official && official.id !== c.id) {
      alias[c.id] = official.id;
      return;
    }
    if (byName[key] || keptIds[c.id]) {
      if (byName[key] && byName[key].id !== c.id) alias[c.id] = byName[key].id;
      return;
    }
    byName[key] = c;
    keptIds[c.id] = true;
    out.push(c);
  });
  seed.courses.forEach((c) => {
    const key = courseNameKey(c && c.name) || ('#' + (c && c.id));
    if (!c || !c.id || keptIds[c.id]) return;
    if (byName[key]) {
      if (byName[key].id !== c.id) alias[c.id] = byName[key].id;
      return;
    }
    byName[key] = c;
    keptIds[c.id] = true;
    out.push(c);
  });

  _courseAliasCache = alias;
  write(KEYS.courseAlias, alias);
  write(KEYS.courses, out);

  // 把本机评价里的旧 courseId 归并到 canonical；云端以后同步回来的旧评价
  // 也会在 refreshCourses 时走同一条路。
  const reviews = read(KEYS.reviews, []);
  let changed = false;
  reviews.forEach((r) => {
    if (!r) return;
    const next = canonicalCourseId(r.courseId);
    if (next && next !== r.courseId) {
      r.courseId = next;
      changed = true;
    }
  });
  if (changed) write(KEYS.reviews, reviews);
}

module.exports = {
  calcStats,
  getCourseInsight,
  courseStatsMap,
  ctypeFixMap,
  attachCourseType,
  setCourseType,
  syncCourseTypes,
  getCourses,
  getCourseById,
  canonicalCourseId,
  courseNameKey,
  getColleges,
  findCourseByName,
  addCourse,
  isMineCourse,
  removeCourse,
  dropCourseLocal,
  isMineReview,
  decorateReview,
  getReviews,
  getReviewById,
  getAllReviews,
  scoreAvg,
  getCourseTeachers,
  getTeacherBoard,
  getReviewsByTeacher,
  addReview,
  updateReview,
  removeReview,
  getMyReviews,
  refreshCourses
};
