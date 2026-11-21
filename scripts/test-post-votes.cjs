// scripts/test-post-votes.cjs —— 帖子点赞 / 点踩
// 钉住三件事：
//   1) 点赞请求还没回来时点踩，本地立刻切到踩；点赞回执不能把踩盖回去；
//   2) 赞 / 踩互斥，再点同一边是取消；
//   3) 云端用一人一格 upsert，不靠 likes +1 累加。

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const UTIL = path.join(PROJ, 'utils');
const norm = (p) => p.replace(/\\/g, '/');
const origJs = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (norm(filename).startsWith(norm(PROJ))) {
    mod._compile(fs.readFileSync(filename, 'utf8'), filename);
    return;
  }
  return origJs(mod, filename);
};

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}

let MEM = {};
let calls = 0;
let resolvers = [];
function query() {
  const o = {};
  ['orderBy', 'skip', 'limit', 'where', 'field'].forEach((m) => { o[m] = () => o; });
  o.get = () => Promise.resolve({ data: [] });
  o.count = () => Promise.resolve({ total: 0 });
  o.doc = () => ({ get: () => Promise.resolve({ data: null }), update: () => Promise.resolve({}), remove: () => Promise.resolve({}) });
  return o;
}
global.wx = {
  getStorageSync: (k) => (k in MEM ? MEM[k] : ''),
  setStorageSync: (k, v) => { MEM[k] = v; },
  removeStorageSync: (k) => { delete MEM[k]; },
  showToast: () => {}, showModal: () => {},
  cloud: {
    init: () => {},
    database: () => query(),
    callFunction: () => {
      calls += 1;
      return new Promise((resolve) => resolvers.push(resolve));
    }
  }
};

const cfg = require(path.join(UTIL, 'config.js'));
cfg.USE_CLOUD = true;
// 直接加载 forum 数据层，避免 initStore 额外发起 login 请求把测试拖到 12 秒
const store = require(path.join(UTIL, 'store-forum.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = () => (MEM['zjgsu_posts'] || [])[0];
const vote = () => (MEM['zjgsu_votes'] || {})['p1'] || '';

(async () => {
  const CF = fs.readFileSync(path.join(PROJ, 'cloudfunctions', 'user', 'index.js'), 'utf8');
  const ST = fs.readFileSync(path.join(UTIL, 'store-forum.js'), 'utf8');
  ok('客户端有串行同步器', /voteDesired/.test(ST) && /drainVote/.test(ST));
  ok('云端用 doc().set 写一人一格', /doc\(voteId\)\.set/.test(CF));
  ok('云端同边再点是取消', /const next = cur === kind \? '' : kind/.test(CF));
  ok('云端用 addToSet 防止数组重复', /addToSet/.test(CF));
  ok('迁移按 openid 补齐，不因表里已有一条就跳过', /have\[String\(oid\)\]/.test(CF));
  ok('云端计数只认记名表，不再叠加旧 legacy', /const likes = tableLikes === null/.test(CF) && !/countWithLegacy\(tableLikes/.test(CF));

  const LIST = fs.readFileSync(path.join(PROJ, 'pages', 'forum', 'list', 'list.js'), 'utf8');
  const HOLE = fs.readFileSync(path.join(PROJ, 'sub', 'forum', 'hole', 'hole.js'), 'utf8');
  const listVoteFn = LIST.slice(LIST.lastIndexOf('onPostVote'), LIST.indexOf('goHole'));
  const holeVoteFn = HOLE.slice(HOLE.lastIndexOf('onPostVote'), HOLE.indexOf('onReact'));
  ok('热门列表点赞只改卡片，不重新排序', /this\.setData\(\{ posts/.test(listVoteFn) && !/this\.load\(\)/.test(listVoteFn));
  ok('树洞热门点赞只改卡片，不重新排序', /this\.setData\(\{ posts/.test(holeVoteFn) && !/this\.load\(\)/.test(holeVoteFn));

  MEM['zjgsu_posts'] = [{ id: 'p1', board: '闲聊', title: 't', content: 'c', author: 'a', likes: 0, dislikes: 0, comments: [], time: '2026-10-20', at: Date.now() }];

  // 关键复现：点赞请求还在飞，马上点踩。本地必须立刻变成踩，且不能先发第二个请求。
  store.toggleVote('p1', 'like');
  ok('第一次点赞发出一个请求', calls === 1, calls);
  store.toggleVote('p1', 'dislike');
  ok('点赞未回执时点踩，本地立刻切到踩', vote() === 'dislike' && post().likes === 0 && post().dislikes === 1, post());
  ok('点赞未回执时不会并发发第二个请求', calls === 1, calls);

  // 点赞回执回来：不能把本地的踩盖回赞；串行器接着发“切到踩”。
  resolvers.shift()({ result: { ok: true, liked: true, disliked: false, likes: 1, dislikes: 0 } });
  await wait(50);
  ok('点赞回执不会把踩盖回去', vote() === 'dislike' && post().likes === 0 && post().dislikes === 1, post());
  ok('随后串行发出踩请求', calls === 2, calls);

  resolvers.shift()({ result: { ok: true, liked: false, disliked: true, likes: 0, dislikes: 1 } });
  await wait(50);
  ok('云端最终是踩', vote() === 'dislike' && post().likes === 0 && post().dislikes === 1, post());

  // 再点同一边是取消，随后可以重新点赞。
  await wait(380);
  store.toggleVote('p1', 'dislike');
  ok('再点踩发取消请求', calls === 3, calls);
  resolvers.shift()({ result: { ok: true, liked: false, disliked: false, likes: 0, dislikes: 0 } });
  await wait(50);
  ok('取消踩后归零', !vote() && post().likes === 0 && post().dislikes === 0, post());

  await wait(380);
  store.toggleVote('p1', 'like');
  ok('取消后能重新点赞', calls === 4, calls);
  resolvers.shift()({ result: { ok: true, liked: true, disliked: false, likes: 1, dislikes: 0 } });
  await wait(50);
  ok('最终点赞数 1', vote() === 'like' && post().likes === 1 && post().dislikes === 0, post());

  // 已有赞踩的帖子：来回点必须回到原来的 2 赞 1 踩，不能越点越少。
  await wait(380);
  MEM['zjgsu_posts'] = [{ id: 'p2', board: '闲聊', title: 't2', content: 'c2', author: 'a', likes: 2, dislikes: 1, comments: [], time: '2026-10-20', at: Date.now() }];
  MEM['zjgsu_votes'] = {};
  MEM['zjgsu_vote_base'] = {};
  MEM['zjgsu_liked_set'] = {};
  calls = 0; resolvers = [];
  const p2 = () => (MEM['zjgsu_posts'] || []).find((x) => x.id === 'p2');
  store.toggleVote('p2', 'like');
  ok('已有 2 赞 1 踩时点赞先到 3/1', p2().likes === 3 && p2().dislikes === 1, p2());
  resolvers.shift()({ result: { ok: true, liked: true, disliked: false, likes: 3, dislikes: 1 } });
  await wait(50);
  await wait(380);
  store.toggleVote('p2', 'dislike');
  ok('切到踩后是 2/2', p2().likes === 2 && p2().dislikes === 2, p2());
  resolvers.shift()({ result: { ok: true, liked: false, disliked: true, likes: 2, dislikes: 2 } });
  await wait(50);
  await wait(380);
  store.toggleVote('p2', 'like');
  ok('再切回赞仍回到 3/1', p2().likes === 3 && p2().dislikes === 1, p2());
  resolvers.shift()({ result: { ok: true, liked: true, disliked: false, likes: 3, dislikes: 1 } });
  await wait(50);
  ok('来回点后原有赞踩没有变少', p2().likes === 3 && p2().dislikes === 1, p2());

  // 旧版 likedSet 的迁移：取消点赞时如果只删 voteSet、不删 likedSet，
  // myVote() 会从旧表把 like 读回来，界面就永远取消不掉。
  await wait(380);
  MEM['zjgsu_posts'] = [{ id: 'p1', board: '闲聊', title: 't', content: 'c', author: 'a', likes: 1, dislikes: 0, comments: [], time: '2026-10-20', at: Date.now() }];
  MEM['zjgsu_votes'] = {};
  MEM['zjgsu_vote_base'] = {};
  MEM['zjgsu_liked_set'] = { p1: true };
  resolvers = [];
  store.toggleVote('p1', 'like');
  ok('旧版 likedSet 里的赞可以正常取消', !vote() && post().liked === false && post().likes === 0, post());
  if (resolvers.length) {
    resolvers.shift()({ result: { ok: true, liked: false, disliked: false, likes: 0, dislikes: 0 } });
    await wait(30);
  }

  if (fails.length) {
    console.log('  失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.log('   ✗ ' + f));
    console.log('\n  通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
    process.exit(1);
  }
  console.log('  通过 ' + pass + ' 项，失败 0 项');
})();
