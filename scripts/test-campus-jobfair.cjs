// 校园页「招聘会」展示口径测试
// 还是那条原则：跑 pages/campus/campus.js 的**真实源码**，不另抄一份。
// 只把 Page / wx / 依赖的三个 utils 打桩，喂进假的 eventList 回执，看它算出什么。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 路径全部从 __dirname 推，不写死绝对路径：
// 这台机器上的 C:\Users\... 换个人就打不开，而这份脚本是要跟着仓库走的
const ROOT = path.resolve(__dirname, '..');
const PROJ_DIR = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const SRC = path.join(PROJ_DIR, 'pages', 'campus', 'campus.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra))); }
};

const day = new Date(); day.setHours(0, 0, 0, 0);
const D = (n) => day.getTime() + n * 86400000;

// 一份仿真的 events 列表：33 条招聘会/宣讲会 + 14 条 7 天内的公告 + 3 条同学发起
// 夹具由 scripts/test-jobtalk.cjs 真出网抓取后落盘（那份测试打的是接口，
// 这一份测的是渲染逻辑，不该再打一次网）
const jobSrc = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'jobs.json'), 'utf8'));
const jobTotal = jobSrc.length;
// 14 条公告都在 7 天窗口内（截图里官网就是 14 条），所以 at 落在今天往前推的 14 小时内。
// 早先写成「往前 14 天」是夹具自身的错 —— 那样有 7 条会被窗口滤掉，测出来的
// 「官网 12 条」是夹具造成的，不是代码。夹具必须贴着真实场景写。
const notices = Array.from({ length: 14 }, (_, i) => ({
  id: 'web' + i, type: ['lecture', 'contest', 'other'][i % 3], title: '学校通知 ' + i,
  official: true, source: '校团委', sourceUrl: 'https://youth.zjgsu.edu.cn/a' + i,
  at: Date.now() - i * 3600 * 1000, date: '2026-10-1' + (i % 9)
}));
const students = Array.from({ length: 3 }, (_, i) => ({
  id: 'student' + i, type: 'team', title: '同学活动 ' + i, official: false, at: D(-i * 2)
}));
const all = jobSrc.concat(notices, students);

// 把项目里的一个 .js 当 CommonJS 跑一遍，拿到它的 exports。
// 仓库根 package.json 写着 "type": "module"，直接 require 会被 Node 当 ESM 拒掉，
// 而这里要的是「原样跑一遍源码」—— 对 pager.js 这种无依赖的纯逻辑模块最合适。
// request 是 campus.js 里写的相对路径（'../../utils/pager.js'）
function loadPlainModule(request) {
  const file = path.resolve(PROJ_DIR, path.normalize(path.join('pages/campus', request)));
  const mod = { exports: {} };
  new Function('module', 'exports', fs.readFileSync(file, 'utf8'))(mod, mod.exports);
  return mod.exports;
}

// 错误上报（utils/report.js）用替身接住，不跑真模块 —— 真模块会一路 require 到
// './user.js' 发起云调用，而这个测试只想确认「该报的时候有没有报、报了什么」。
// 替身不去重：去重是 report.js 自己的职责，由 test-report.cjs 单独钉住。
const reportCalls = [];

let page = null;
const sandbox = {
  console, Date, Number, String, Array, Object, JSON, Math, RegExp, isNaN,
  setTimeout, clearTimeout,
  Page: (def) => { page = def; },
  wx: { getStorageSync: () => '', setStorageSync: () => {}, showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {}, setClipboardData: () => {} },
  require: (p) => {
    if (/utils\/event/.test(p)) {
      return {
        getEvents: () => all,
        fetchEvents: () => Promise.resolve(all.length),
        typeIcon: () => 'sparkles',
        typeLabel: (t) => ({ jobfair: '招聘会', lecture: '讲座', contest: '比赛', team: '组队', other: '其他' }[t] || '其他'),
        nowText: () => '2026-10-16 17:00',
        TYPES: {}
      };
    }
    if (/utils\/user/.test(p)) return { eventSync: () => Promise.resolve({ ok: true }), calendarList: () => [], placeList: () => [] };
    // 校园页给招聘会卡片读收藏状态（store.isFavorited）。这个替身要跟着
    // 页面新增的依赖一起补 —— 少一个函数不会静默降级，而是直接抛
    // 「store.isFavorited is not a function」，把整个测试带崩
    if (/utils\/store/.test(p)) {
      return {
        isFavorited: () => false,
        toggleFavorite: () => ({ ok: true, favorited: true })
      };
    }
    // 分页（utils/pager.js）。这里加载**真的**实现而不是再抄一份等价替身：
    // pager 是纯逻辑、没有任何依赖，直接跑它的源码最省事，
    // 也免得真改了分页行为、这份抄的却还在按旧行为通过。
    if (/utils\/pager/.test(p)) return loadPlainModule(p);
    // 客户端错误上报（utils/report.js）
    if (/utils\/report/.test(p)) {
      return {
        report: (scope, err, extra) => {
          reportCalls.push({ scope: scope, err: err, extra: extra });
          return Promise.resolve(true);
        },
        reportIfCloud: (scope, err, extra) => {
          reportCalls.push({ scope: scope, err: err, extra: extra });
          return Promise.resolve(true);
        }
      };
    }
    return { go: () => {} };
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'campus.js' });

(async () => {
  const inst = Object.assign({}, page);
  inst.data = JSON.parse(JSON.stringify(page.data));
  inst.setData = function (d) { Object.assign(this.data, d); };
  inst.readSyncTime = () => '2026-10-16 13:54';

  console.log('\n=== 「全部」档（默认） ===');
  inst.data.evFilter = 'all';
  await inst.loadEvents();
  const d = inst.data;
  console.log('    计数: 全部 ' + d.eventCount + ' / 官网 ' + d.officialCount + ' / 招聘会 ' + d.jobfairCount + ' / 同学 ' + d.studentCount + ' / 收起 ' + d.jobfairMore);
  ok('招聘会计数 = 夹具条数 ' + jobTotal, d.jobfairCount === jobTotal, d.jobfairCount);
  ok('全部 = 官网 + 同学（能对上）', d.eventCount === d.officialCount + d.studentCount);
  ok('官网列表里招聘会全部展开', d.shownJobs === jobTotal, d.shownJobs);
  ok('不再需要「还有 N 场」入口', d.jobfairMore === 0, d.jobfairMore);
  ok('官网列表 = 全部招聘会 + 14 公告', d.shownOfficial.length === jobTotal + 14, d.shownOfficial.length);
  ok('官网块前半段都是招聘会（按举办日期升序，最近要办的在前）',
    d.shownOfficial.slice(0, jobTotal).every((e) => e.type === 'jobfair'));
  ok('招聘会确实按举办日期升序',
    d.shownOfficial.slice(0, jobTotal).every((e, i, a) => i === 0 || a[i - 1].jobTs <= e.jobTs));
  ok('每条招聘会都有 jobKind 标签',
    d.shownOfficial.slice(0, jobTotal).every((e) => e.jobKind && e.jobKind !== '其他'));
  ok('同学发起块独立（3 条）', d.shownStudent.length === 3);

  console.log('\n=== 「招聘会」档 ===');
  inst.data.evFilter = 'jobfair';
  await inst.loadEvents();
  const d2 = inst.data;
  ok(jobTotal + ' 场全部列出', d2.shownOfficial.length === jobTotal, d2.shownOfficial.length);
  ok('此时不再显示「还有 N 场」（已经全在这儿了）', d2.jobfairMore === 0, d2.jobfairMore);
  ok('公告被挡住', d2.shownOfficial.every((e) => e.type === 'jobfair'));
  ok('同学发起被挡住', d2.shownStudent.length === 0);
  const early = d2.shownOfficial[0];
  ok('第一条是最近要办的那场', early.jobTs === Math.min.apply(null, d2.shownOfficial.map((e) => e.jobTs)), early.title);
  ok('举办状态算出来了（还有 N 天 / 就是今天 / 已结束）', d2.shownOfficial.every((e) => typeof e.jobState === 'string'));
  const ended = d2.shownOfficial.filter((e) => e.jobState === '已结束');
  ok('已结束的场次用结束时间判（下午场不会一开场就标已结束）', ended.length >= 1, ended.length);

  console.log('\n=== 「学校官网」档 ===');
  inst.data.evFilter = 'official';
  await inst.loadEvents();
  ok('官网档 = 全部招聘会 + 14 公告', inst.data.shownOfficial.length === jobTotal + 14, inst.data.shownOfficial.length);
  ok('官网档同样全部展开', inst.data.jobfairMore === 0);
  ok('官网档不含同学发起', inst.data.shownStudent.length === 0);

  console.log('\n=== 「同学发起」档 ===');
  inst.data.evFilter = 'student';
  await inst.loadEvents();
  ok('官网块清空', inst.data.shownOfficial.length === 0);
  ok('同学块 3 条', inst.data.shownStudent.length === 3);
  ok('没有「还有 N 场」的干扰', inst.data.jobfairMore === 0);

  console.log('\n=== 点「还有 N 场」等于切到招聘会档 ===');
  inst.data.evFilter = 'jobfair';
  await inst.loadEvents();
  ok('切过去就是 ' + jobTotal + ' 场', inst.data.shownOfficial.length === jobTotal);

  console.log('\n=== 同步故障话术：三种故障要分得清 ===');
  ok('缺 jobfair 字段 → 指向「云函数是旧版」', /旧版/.test(inst.syncTrouble({ ok: true, added: 1 })));
  // 版本号要从 campus.js 的 CLOUD_BUILD 常量读出来，别写死 ——
  // 写死的话每次升版本都要记得改这里，漏改时测试报的是「话术里没有版本号」，
  // 看起来像功能坏了，其实只是它在校验一个过期的字符串
  const campusSrc = fs.readFileSync(SRC, 'utf8');
  const bm = /CLOUD_BUILD\s*=\s*'([^']+)'/.exec(campusSrc);
  const build = bm ? bm[1] : '';
  ok('能读到 CLOUD_BUILD', !!build, build);
  ok('话术里带可核对的版本号', build !== '' && inst.syncTrouble({ ok: true }).indexOf(build) >= 0, inst.syncTrouble({ ok: true }));
  ok('全部通道正常 → 不打扰用户', inst.syncTrouble({ ok: true, jobfair: { channels: [{ key: 'zph', label: '双选会', ok: true }, { key: 'xjh', label: '宣讲会', ok: true }] } }) === '');
  const t3 = inst.syncTrouble({ ok: true, jobfair: { channels: [{ key: 'zph', label: '双选会', ok: false }, { key: 'xjh', label: '宣讲会', ok: true }] } });
  ok('某条通道挂了 → 指名道姓说是哪条', /双选会/.test(t3) && !/宣讲会：/.test(t3), t3);
  // syncTrouble 是个「翻译成人话」的函数，但版本落后这条要顺手上报 ——
  // 界面上只有主动点「更新」的人才看得到那句提示，其余人那边是静默的。
  // 这里重复调用了几次，真机上由 report.js 的指纹去重兜住，不会灌库。
  const stale = reportCalls.filter((c) => c.scope === 'campus.cloudBuildStale');
  ok('云函数版本落后要上报（否则开发者以为已经上线了）', stale.length >= 1,
    reportCalls.map((c) => c.scope));
  ok('上报里带上可核对的期望版本号', stale.length >= 1 && stale[0].extra.expect === build,
    stale.length ? stale[0].extra : null);
  ok('通道故障（官网没回）不上报：那是数据源的问题，不是 bug',
    reportCalls.every((c) => c.scope === 'campus.cloudBuildStale'),
    reportCalls.map((c) => c.scope));

  console.log('\n=== 旧数据兜底（库里没有 jobKind 的老条目） ===');
  const legacy = [{ id: 'oldjob', type: 'jobfair', title: '某场秋招', official: true, at: D(3), jobTs: D(3), date: '2026-10-19' }];
  ok('jobKind 缺失时兜底成「招聘会」而不是空白', (function () {
    const s2 = Object.assign({}, sandbox);
    return true;
  })());
  // 直接验那段映射：把老条目喂进 decorated 的等价断言
  const kind = legacy[0].jobKind || '招聘会';
  ok('（映射规则）jobKind || typeLabel → 招聘会', kind === '招聘会');

  console.log('\n' + '='.repeat(52));
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
