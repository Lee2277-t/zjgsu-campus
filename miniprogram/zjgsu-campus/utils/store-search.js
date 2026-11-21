// utils/store-search.js —— 论坛搜索（历史 / 热词 / 高亮 / 模糊匹配）
// 基础设施（KEYS / read / write / 墓碑 / 工具函数）统一来自 store-base.js；
// 跨模块调用通过 require 同级 store-* 模块获取，不跨文件改写逻辑。

const { KEYS, read, write, notTombstoned, searchCore } = require('./store-base.js');
const { decoratePost } = require('./store-forum.js');
const { visibleToMe } = require('./store-forum.js');

/* ---------------- 论坛搜索 ---------------- */

// 搜索历史最多留几条：再多就变成「信息噪音」，用户根本不会往下翻
const HISTORY_MAX = 6;
// 热门词：新同学不知道搜什么时，点一下就能看到这个圈子里常聊的话题。
// ⚠️ 这是写死的预设词，不是统计出来的热度 —— 所以界面上写「常搜话题」而不是
//    「大家都在搜」：后者是在宣称一个我们并没有在统计的事实。
//    真要按热度排，得由服务端按检索日志聚合，那是另一件事
const HOT_KEYWORDS = ['选课', '食堂', '图书馆', '宿舍', '社团', '实习'];

function getSearchHistory() {
  const list = read(KEYS.searchHistory, []);
  return Array.isArray(list) ? list : [];
}

function pushSearchHistory(keyword) {
  const k = String(keyword || '').trim();
  if (!k) return getSearchHistory();
  let list = getSearchHistory().filter((x) => x !== k);
  list.unshift(k);
  if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX);
  write(KEYS.searchHistory, list);
  return list;
}

function clearSearchHistory() {
  write(KEYS.searchHistory, []);
  return [];
}

function getHotKeywords() {
  return HOT_KEYWORDS.slice();
}

// 把一段文字按关键词切成若干片段，标记命中的位置。
// 必须在 JS 里算好：WXML 的模板表达式不支持任何函数调用，高亮逻辑放模板里会整页崩溃。
function buildParts(text, kw) {
  const t = String(text || '');
  if (!kw) return [{ idx: 0, t: t, hit: false }];
  const lower = t.toLowerCase();
  const parts = [];
  let from = 0;
  let idx = lower.indexOf(kw);
  while (idx >= 0) {
    if (idx > from) parts.push({ idx: parts.length, t: t.slice(from, idx), hit: false });
    parts.push({ idx: parts.length, t: t.slice(idx, idx + kw.length), hit: true });
    from = idx + kw.length;
    idx = lower.indexOf(kw, from);
  }
  if (from < t.length) parts.push({ idx: parts.length, t: t.slice(from), hit: false });
  return parts.length ? parts : [{ idx: 0, t: t, hit: false }];
}

function matchPost(p, kw) {
  // 标题、正文、板块、作者、课程名任一命中即算搜到，逐条扫一遍本地缓存即可，不用联网。
  // 命中判定走全站共用的那套（精准 / 模糊），而不是这里再写一次 indexOf：
  // 同学把标题打错一个字，本来是该搜得到的。
  // 这里必须把「等级」原样返回，压成 true/false 的话精准档就形同虚设了
  // （passLevel 拿到 true 只会放行，永远挡不住打错字的结果）
  return searchCore.matchFields([p.title, p.content, p.board, p.author, p.courseName], kw);
}

// 按关键词找帖子。kw 已经转小写；不传关键词返回空数组，由调用方决定退回普通列表。
// exact 传 true 只找完全一致的（精准档），默认模糊档 —— 打错字也搜得到
function searchPosts(keyword, exact) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return [];
  const alive = notTombstoned('posts');
  return read(KEYS.posts, [])
    .filter(alive)
    .filter((p) => visibleToMe(decoratePost(p)))
    .filter((p) => searchCore.passLevel(matchPost(p, kw), exact))
    .sort((a, b) => (a.time < b.time ? 1 : -1))
    .map((p) => {
      const d = decoratePost(p);
      d.titleParts = buildParts(d.title, kw);
      d.contentParts = buildParts(d.content, kw);
      return d;
    });
}

module.exports = {
  getSearchHistory,
  pushSearchHistory,
  clearSearchHistory,
  getHotKeywords,
  buildParts,
  matchPost,
  searchPosts
};
