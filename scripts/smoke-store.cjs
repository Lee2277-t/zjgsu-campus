/* 数据层运行时冒烟测试
 * 作用：真加载 utils/store.js（聚合入口），逐个调用导出函数，并独立加载 8 个子模块。
 *      任何「用了但没引进来」的未定义引用都会当场抛 ReferenceError —— 这是静态检查之外的最后一道网。
 *      接口齐全 ≠ 行为正确：只验证导出名字存在，是抓不到这类 bug 的。
 *
 * 用法：node scripts/smoke-store.cjs
 * 说明：自带 CommonJS 强制加载器，绕过祖先目录 package.json 的 "type":"module"，
 *      因此无需临时改写任何 package.json。本地 / 云端两种模式各跑一遍。
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const PROJ = path.resolve(__dirname, '..', 'miniprogram', 'zjgsu-campus');
const UTIL = path.join(PROJ, 'utils');
const MODS = ['store-base', 'store-user', 'store-course', 'store-forum', 'store-sync', 'store-search', 'store-favorite', 'store-draft'];

// ---- 强制把小程序目录下的 .js 按 CommonJS 编译（祖先 package.json 是 type:module）----
const norm = (p) => p.replace(/\\/g, '/');
const origJs = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (norm(filename).startsWith(norm(PROJ))) {
    mod._compile(fs.readFileSync(filename, 'utf8'), filename);
    return;
  }
  return origJs(mod, filename);
};

// ---- mock wx：内存版本地存储 + 可链式调用的空壳云开发 ----
let MEM = {};
function query() {
  const o = {};
  ['orderBy', 'skip', 'limit', 'where', 'field', 'collection', 'doc'].forEach((m) => { o[m] = () => o; });
  o.get = () => Promise.resolve({ data: [] });
  o.count = () => Promise.resolve({ total: 0 });
  return o;
}
global.wx = {
  getStorageSync: (k) => (k in MEM ? MEM[k] : ''),
  setStorageSync: (k, v) => { MEM[k] = v; },
  removeStorageSync: (k) => { delete MEM[k]; },
  showToast: () => {}, showModal: () => {},
  cloud: {
    init: () => {}, database: () => query(),
    callFunction: () => Promise.resolve({ result: { ok: true, data: [], list: [], openid: 'mock-openid' } })
  }
};

// 清掉已加载的小程序模块，让两种模式各拿一份干净状态
function purge() {
  Object.keys(require.cache).forEach((k) => { if (norm(k).startsWith(norm(PROJ))) delete require.cache[k]; });
}

const CALLS = [
  ['initStore', []], ['getUser', []], ['openidTrouble', []], ['myOpenid', []],
  ['getCourses', []], ['getColleges', []], ['getCourseById', ['u1']], ['findCourseByName', ['高等数学']],
  ['getCourseInsight', ['u1']], ['getAllReviews', []], ['getReviews', ['u1']], ['getCourseTeachers', ['u1']],
  ['getTeacherBoard', []], ['getMyReviews', []],
  ['getBoards', []], ['getPosts', [{ board: '', sort: 'new' }]], ['getPostById', ['p1']], ['getMyPosts', []],
  ['getHolePosts', []], ['getHiddenPosts', []], ['myVote', ['p1', 'poll1']], ['hasReported', ['p1']],
  ['isModerator', []],
  ['getFavorites', []], ['isFavorited', ['post', 'p1']],
  ['getDrafts', []], ['hasDraftText', ['post', 'p1']], ['getDraft', ['post', 'p1']],
  ['getSearchHistory', []], ['getHotKeywords', []], ['searchPosts', ['课程']],
  // 异步（云端）分支：本地模式下应安全返回，云端模式下走 mock 云
  ['fetchPostsFromCloud', [1, true]], ['ensureSeed', []], ['loadMorePosts', []],
  ['syncNow', []], ['mergeFavorites', []], ['pullFavorites', []], ['pushFavoritesToCloud', []]
];

async function runMode(mode) {
  MEM = {}; purge();
  const store = require(path.join(UTIL, 'store.js'));
  const cfg = require(path.join(UTIL, 'config.js'));
  cfg.USE_CLOUD = (mode === 'cloud');
  console.log(`\n### 运行模式：${mode}（USE_CLOUD=${cfg.USE_CLOUD}）`);

  console.log('--- 常量导出核对 ---');
  [['PAGE', store.PAGE], ['HOLE_BOARD', store.HOLE_BOARD], ['REACT_KINDS', store.REACT_KINDS], ['REACT_META', store.REACT_META]]
    .forEach(([k, v]) => console.log(`  ${k}: ${JSON.stringify(v)}`));

  console.log('--- 逐个调用导出函数 ---');
  let bad = 0;
  const pending = [];
  CALLS.forEach(([name, args]) => {
    const fn = store[name];
    if (typeof fn !== 'function') { bad++; console.log(`  ❌ ${name} 不是函数`); return; }
    try {
      const r = fn.apply(null, args);
      if (r && typeof r.then === 'function') {
        pending.push(r.then(() => {}, (e) => { bad++; console.log(`  ❌ ${name}（异步拒绝）: ${e && e.message}`); }));
      }
    } catch (e) {
      bad++;
      console.log(`  ❌ ${name}: ${(e && e.constructor && e.constructor.name) || 'Error'}: ${e && e.message}`);
    }
  });
  await Promise.all(pending);

  console.log('--- 子模块独立加载 ---');
  MODS.forEach((m) => {
    try { require(path.join(UTIL, m + '.js')); }
    catch (e) { bad++; console.log(`  ❌ ${m}: ${e.message}`); }
  });

  console.log(bad ? `  → [${mode}] 共 ${bad} 处失败` : `  → ✅ [${mode}] 通过：无未定义引用、无运行期异常`);
  return bad;
}

(async () => {
  const a = await runMode('local');
  const b = await runMode('cloud');
  const total = a + b;
  console.log(total ? `\n共 ${total} 处失败` : '\n✅ 冒烟测试全部通过（本地 + 云端）');
  process.exit(total ? 1 : 0);
})();
