// test-pager.cjs —— 列表分页（utils/pager.js + 四个接入页面）
//
// 这个测试存在的理由：分页是那种「改的时候看着很简单、但会在别处悄悄弄坏东西」的改动。
// 本轮接入时就真的踩到两个：
//   ① 「我的帖子」的清空按钮遍历的是 data.posts —— 分页后它只是切片，
//      于是「清空」只会删掉已经展开的几条，剩下的留着，提示却写着「已清空」；
//   ② 页面上「共 N 条」「找到 N 位」写的是切片长度，往下划两屏数字会自己变大。
// 这两个都加断言钉住，以后谁再动分页会立刻撞上。
//
// 跑法：node test-pager.cjs（工作目录在 recon/ 下）

const fs = require('fs');
const path = require('path');
const Module = require('module');

const APP = path.join(__dirname, '..', 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');

// recon/package.json 是 "type": "module"，Node 22 会把小程序 .js 当 ESM。
// 强制把项目内的 .js 改回 CommonJS 编译。
const origJsExt = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (norm(filename).startsWith(norm(APP))) return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return origJsExt(mod, filename);
};

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}
function eq(name, a, b) { ok(name, a === b, '期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }

const readProj = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const range = (n) => Array.from({ length: n }, (_, i) => ({ id: 'x' + i }));

(async function () {

/* ============ ① pager 本身 ============ */

const pager = require(path.join(APP, 'utils', 'pager.js'));

ok('导出 create', typeof pager.create === 'function');
eq('默认页大小 20', pager.DEFAULT_SIZE, 20);

// 空列表
{
  const p = pager.create();
  const v = p.reset([]);
  eq('空列表：显示 0 条', v.list.length, 0);
  eq('空列表：hasMore 为假', v.hasMore, false);
  eq('空列表：不算到底（不该出现「已经到底啦」）', v.done, false);
  eq('空列表：paged 为假', v.paged, false);
  eq('空列表：more 返回 null', p.more(), null);
}

// 少于 1 页
{
  const p = pager.create();
  const v = p.reset(range(5));
  eq('5 条：全部显示', v.list.length, 5);
  eq('5 条：hasMore 为假', v.hasMore, false);
  eq('5 条：没分过页', v.paged, false);
  eq('5 条：done 为假（不该多一行「已经到底啦」）', v.done, false);
  eq('5 条：more 返回 null', p.more(), null);
}

// 正好 1 页
{
  const p = pager.create();
  const v = p.reset(range(20));
  eq('20 条：全部显示', v.list.length, 20);
  eq('20 条：hasMore 为假', v.hasMore, false);
  eq('20 条：算分过页（正好一页，paged 看的是 total > step 之外的情况）', v.paged, false);
  eq('20 条：more 返回 null', p.more(), null);
}

// 多页
{
  const p = pager.create();
  const v = p.reset(range(47));
  eq('47 条：第一页 20 条', v.list.length, 20);
  eq('47 条：total 是全量', v.total, 47);
  eq('47 条：hasMore 为真', v.hasMore, true);
  eq('47 条：paged 为真', v.paged, true);
  eq('47 条：还没到底', v.done, false);

  const v2 = p.more();
  eq('第二页 40 条', v2.list.length, 40);
  eq('第二页还没到底', v2.hasMore, true);

  const v3 = p.more();
  eq('第三页 47 条（全部）', v3.list.length, 47);
  eq('第三页 hasMore 为假', v3.hasMore, false);
  eq('第三页 done 为真', v3.done, true);
  eq('到底之后再 more 返回 null', p.more(), null);
}

// all() 是全量，不是切片
{
  const p = pager.create();
  p.reset(range(47));
  p.more(); // 展开到 40
  eq('all() 返回全量 47 条', p.all().length, 47);
  eq('view 仍然是 40 条（all 不改变视图）', p.view().list.length, 40);
  // all() 返回副本，改动不该影响内部状态
  const a = p.all();
  a.push({ id: 'hack' });
  eq('all() 是副本，外部改动不污染', p.all().length, 47);
}

// reset 归零
{
  const p = pager.create();
  p.reset(range(47));
  p.more(); p.more(); // 展开到 47
  eq('展开到 47', p.view().list.length, 47);
  // 换筛选成 3 条 → 必须回到第一页
  const v = p.reset(range(3));
  eq('reset 后回到第一页（3 条）', v.list.length, 3);
  eq('reset 后 hasMore 为假', v.hasMore, false);
}

// keep 保留进度
{
  const p = pager.create();
  p.reset(range(47));
  p.more(); // 40
  // 数据刷新（比如红点重算 / 6 秒轮询）—— 展开进度要留着
  const v = p.keep(range(47));
  eq('keep 保留已展开的 40 条', v.list.length, 40);
  eq('keep 后 hasMore 仍为真', v.hasMore, true);
}

// keep 时列表变短：必须跟着缩回去
{
  const p = pager.create();
  p.reset(range(60));
  p.more(); p.more(); // 展开到 60
  eq('展开到 60', p.view().list.length, 60);
  // 现在只剩 5 条（比如删掉了一批）
  const v = p.keep(range(5));
  eq('keep 到 5 条：缩回 5', v.list.length, 5);
  eq('keep 到 5 条：hasMore 为假', v.hasMore, false);
  eq('keep 到 5 条：不会留下「加载中」', v.done, false);
}

// keep 初次调用（shown 还是 0）要给满第一页
{
  const p = pager.create();
  const v = p.keep(range(47));
  eq('初次 keep 显示第一页', v.list.length, 20);
}

// 自定义页大小
{
  const p = pager.create(3);
  const v = p.reset(range(10));
  eq('页大小 3：第一页 3 条', v.list.length, 3);
  eq('页大小 3：paged 为真', v.paged, true);
  eq('size 暴露出来了', p.size, 3);
}

// 非法输入不能炸
{
  const p = pager.create();
  const v = p.reset(null);
  eq('reset(null) 当空列表处理', v.list.length, 0);
  const v2 = p.reset('not an array');
  eq('reset(非数组) 当空列表处理', v2.list.length, 0);
}

// create(0) / create('x') 要兜底成默认页大小，否则 step=0 会永远显示 0 条
{
  const p = pager.create(0);
  const v = p.reset(range(30));
  ok('create(0) 兜底成默认页大小', v.list.length === 20, v.list.length);
}

/* ============ ② 四个接入页面的接线 ============ */

const campusSrc = readProj('pages/campus/campus.js');
const campusWxml = readProj('pages/campus/campus.wxml');
const postsSrc = readProj('sub/mine/posts/posts.js');
const postsWxml = readProj('sub/mine/posts/posts.wxml');
const resSrc = readProj('pages/tool/resources/resources.js');
const resWxml = readProj('pages/tool/resources/resources.wxml');
const friendsSrc = readProj('pages/user/friends/friends.js');
const friendsWxml = readProj('pages/user/friends/friends.wxml');

// 四处都用了 pager，且都挂在实例上（this._pager）而不是 Page 对象字面量上
[['campus.js', campusSrc], ['posts.js', postsSrc], ['resources.js', resSrc], ['friends.js', friendsSrc]]
  .forEach(([n, s]) => {
    ok(n + ' 引用了 utils/pager.js', s.indexOf("require('") >= 0 && /utils\/pager\.js/.test(s));
    ok(n + ' 把实例挂在 this._pager 上（不能挂 Page 原型）', s.indexOf('this._pager') >= 0);
    ok(n + ' 有 onReachBottom', /onReachBottom\s*\(/.test(s));
  });

/* --- 我的帖子 --- */

// ① 清空必须作用于全量
ok('我的帖子：清空用 pager.all() 而不是 data.posts',
  postsSrc.indexOf('onClearAll') >= 0
  && /const list = this\.pg\(\)\.all\(\)/.test(postsSrc));
ok('我的帖子：清空不再读 data.posts',
  !/onClearAll[\s\S]{0,200}this\.data\.posts/.test(postsSrc));

// ② 计数用 total
ok('我的帖子：顶部计数用 total 不是 posts.length',
  postsWxml.indexOf('共 {{total}} 条') >= 0
  && postsWxml.indexOf('共 {{posts.length}} 条') < 0);

// ③ 用 keep（每次 onShow 重算红点，不该把人弹回顶部）
ok('我的帖子：用 keep 保留展开进度', /this\.pg\(\)\.keep\(posts\)/.test(postsSrc));
ok('我的帖子：不用 reset（会每次 onShow 归零）', !/this\.pg\(\)\.reset\(/.test(postsSrc));
ok('我的帖子：有 pg() 且挂在 this 上', /pg\(\)\s*\{\s*return this\._pager \|\| \(this\._pager = pager\.create\(\)\)/.test(postsSrc));

/* --- 同学名单 --- */

// ① 命中总数用 friendTotal
ok('同学名单：找到 N 位用 friendTotal',
  friendsWxml.indexOf('找到 {{friendTotal}} 位') >= 0
  && friendsWxml.indexOf('找到 {{friendView.length}} 位') < 0);

// ② 搜索关键词变了要归零
ok('同学名单：搜的时候页码归零（onFriendKeyword 传 true）',
  /onFriendKeyword[\s\S]{0,160}applyFriendFilter\(true\)/.test(friendsSrc));
ok('同学名单：清空搜索同样归零',
  /clearFriendKeyword[\s\S]{0,160}applyFriendFilter\(true\)/.test(friendsSrc));

// ③ 轮询刷新用 keep（这个页 6 秒刷一次）
ok('同学名单：默认走 keep（轮询不弹回顶部）',
  /resetPage \? this\.pg\(\)\.reset\(list\) : this\.pg\(\)\.keep\(list\)/.test(friendsSrc));

// ④ 触底只在同学那一档
ok('同学名单：触底限定在 friends 页签', /tab !== 'friends'/.test(friendsSrc));

// ⑤ 两条分支（没搜 / 搜了）和触底都走同一个出口，避免漏字段
ok('同学名单：两个分支都走 friendPageData', (friendsSrc.match(/friendPageData\(/g) || []).length >= 3);

/* --- 学习资料 --- */

ok('学习资料：切分类 / 搜索走 reset（换筛选要归零）', /this\.pg\(\)\.reset\(all\)/.test(resSrc));
ok('学习资料：触底有 hasMore 守卫', /if \(!this\.data\.hasMore\) return/.test(resSrc));

/* --- 校园活动 --- */

// 只给同学发起分页（官网那两块各有收口机制）
ok('校园活动：同学块走 pager',
  /resetPage \? this\.pg\(\)\.reset\(showStudent\) : this\.pg\(\)\.keep\(showStudent\)/.test(campusSrc));
ok('校园活动：切分类时传 true 归零', /onEvFilter[\s\S]{0,300}loadEvents\(true\)/.test(campusSrc));
ok('校园活动：触底限定在 events 档', /tab !== 'events'/.test(campusSrc));
ok('校园活动：招聘会直接全量展开，不再用「还有 N 场」收口',
  campusSrc.indexOf('JOBFAIR_PREVIEW') < 0
  && campusWxml.indexOf('还有 {{jobfairMore}} 场') < 0
  && /const jobfairShown = jobfair;/.test(campusSrc));

/* ============ ③ 底部提示的一致性 ============ */

// .load-more 必须是全局的（app.wxss），不能留私有副本
const appWxss = readProj('app.wxss');
ok('app.wxss 里有全局 .load-more', /\.load-more\s*\{/.test(appWxss));
const forumWxss = readProj('pages/forum/list/list.wxss');
ok('论坛页不再保留私有的 .load-more', !/\.load-more\s*\{/.test(forumWxss));

// 四处都用了 .load-more
[['campus.wxml', campusWxml], ['posts.wxml', postsWxml], ['resources.wxml', resWxml], ['friends.wxml', friendsWxml]]
  .forEach(([n, s]) => ok(n + ' 用了 .load-more', s.indexOf('class="load-more"') >= 0));

// 「到底」提示用 done 控制，不能出现硬编码的页数判断
ok('校园活动：到底用 studentDone 而不是硬编码页数',
  campusWxml.indexOf('wx:elif="{{studentDone}}"') >= 0);
ok('我的帖子：到底用 done', postsWxml.indexOf('wx:elif="{{done}}"') >= 0);
ok('学习资料：到底用 done', resWxml.indexOf('wx:elif="{{done}}"') >= 0);
ok('同学名单：到底用 friendDone', friendsWxml.indexOf('wx:elif="{{friendDone}}"') >= 0);
// 模板里不能出现 total > 20 这类把页大小抄进模板的写法
const allWxml = [campusWxml, postsWxml, resWxml, friendsWxml].join('\n');
ok('模板里没有硬编码的页大小判断', !/total\s*>\s*\d+/.test(allWxml));

/* ---------------- 汇总 ---------------- */

console.log('通过 ' + pass + ' 项');
if (fails.length) {
  console.log('\n失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('全部通过');
})();
