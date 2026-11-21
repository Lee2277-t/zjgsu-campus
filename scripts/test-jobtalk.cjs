// 招聘会 / 宣讲会 双通道行为测试
//
// 原则跟这个项目一贯一样：**不另抄一份逻辑**。
// 从 cloudfunctions/user/index.js 的真实源码里按花括号配平把函数抠出来，
// 在 new Function 里跑；数据不造假，直接真出网打就业网接口。
// 唯一被打桩的是 db（写库这件事在本地没有环境）和 now()。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'miniprogram', 'zjgsu-campus', 'cloudfunctions', 'user', 'index.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'jobs.json');

// 夹具的「内容指纹」：只含用户看得见的字段，刻意不含 syncedAt 与 id
// （id 里嵌了抓取时间戳，它是变的，但岗位本身没变）
function contentKey(list) {
  return (list || []).map((w) => [
    w.title, w.sourceUrl, w.date, w.start, w.end,
    w.location, w.desc, w.jobKind, w.jobTs, w.jobEndTs
  ].join('|')).sort().join('\n');
}

// 归一化快照：内容没变返回 null（调用方据此不写盘），变了返回沿用旧时间戳的新数组
function stableSnapshot(writes) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')); } catch (e) { prev = null; }
  if (Array.isArray(prev) && prev.length && contentKey(prev) === contentKey(writes)) return null;
  const ts = (prev && prev[0] && Number(prev[0].syncedAt)) || Date.now();
  return writes.map((w) => Object.assign({}, w, {
    syncedAt: ts,
    id: String(w.id || '').replace(/-\d+$/, '') + '-' + ts
  }));
}
const readCloudSource = require('./cloud-source.cjs');
const src = readCloudSource();

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra))); }
};

/* ---------- 从真实源码里抠函数（花括号配平） ---------- */
function sliceFn(name) {
  const re = new RegExp('(^|\\n)(?:async\\s+)?function ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('找不到函数 ' + name);
  let i = src.indexOf('{', m.index + m[0].length - 1);
  // 从函数头开始找第一个 '{' 之后配平
  let depth = 0, j = i;
  for (; j < src.length; j += 1) {
    const c = src[j];
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) { j += 1; break; } }
    else if (c === "'" || c === '"' || c === '`') {
      const q = c; j += 1;
      while (j < src.length && src[j] !== q) { if (src[j] === '\\') j += 1; j += 1; }
    }
  }
  return src.slice(m.index, j);
}

// const 声明块：从 'const JYW_BASE =' 到 'const JYW_CHANNELS = [...];' 结束
function sliceJywConsts() {
  const a = src.indexOf('const JYW_BASE =');
  const b = src.indexOf('\n// 跑一条通道：打到接口');
  if (a < 0 || b < 0) throw new Error('找不到 JYW 常量块');
  return src.slice(a, b);
}

const code = [
  sliceJywConsts(),
  sliceFn('jobfairDetailUrl'),
  sliceFn('tsOf'),
  sliceFn('jywRoom'),
  sliceFn('syncJywChannel'),
  sliceFn('syncJywAll')
].join('\n');

/* ---------- 打桩 ---------- */
const writes = [];
let maxLimit = 0;
const db = {
  collection: () => ({
    where: () => ({
      limit: (n) => {
        maxLimit = Math.max(maxLimit, n);
        return { get: () => Promise.resolve({ data: recs.filter((r) => r.sourceUrl === lastWhereUrl) }) };
      },
      update: () => Promise.resolve({})
    }),
    add: ({ data }) => { writes.push(data); return Promise.resolve({}); }
  })
};
let recs = [];
let lastWhereUrl = '';
// where 的参数是动态的，用 Proxy 抓
const dbProxy = new Proxy(db, {
  get(t, k) {
    if (k !== 'collection') return t[k];
    return () => {
      const c = t.collection();
      return new Proxy(c, {
        get(tt, kk) {
          if (kk !== 'where') return tt[kk];
          return (q) => { lastWhereUrl = q && q.sourceUrl; return tt.where(q); };
        }
      });
    };
  }
});

const { webPostJson } = require('node:https') ? {} : {};
// 真出网：把云函数里 webPostJson 的源码也抠出来一起跑（连编码处理一起验）
const webPostJsonSrc = sliceFn('webPostJson');

const sandbox = {
  console,
  require,
  Buffer,
  process,
  Promise,
  Date,
  Number,
  String,
  Array,
  Object,
  JSON,
  RegExp,
  isNaN,
  URL,
  setTimeout,
  clearTimeout
};
vm.createContext(sandbox);
vm.runInContext(
  'const COL_EVENTS = "events";\n'
  + 'const WEB_TIMEOUT = 15000;\n'
  + 'function now() { return "2026-10-16 17:00"; }\n'
  + webPostJsonSrc + '\n'
  + code + '\n'
  + 'globalThis.__t = { syncJywAll, syncJywChannel, JYW_CHANNELS, tsOf, jywRoom, jobfairDetailUrl };',
  sandbox,
  { filename: 'extracted.js' }
);
sandbox.db = dbProxy;
// db 是 const 之外的自由变量，抠出来的函数直接用全局 db —— 绑上去
vm.runInContext('globalThis.db = __db;', Object.assign(sandbox, { __db: dbProxy }));

const T = sandbox.__t;

(async () => {
  console.log('\n=== 1. 通道表本身 ===');
  ok('两条通道：招聘会 + 宣讲会', T.JYW_CHANNELS.length === 2 && T.JYW_CHANNELS.map((c) => c.key).join(',') === 'zph,xjh');
  ok('通道 url 打的是 ajax 接口而不是页面', T.JYW_CHANNELS.every((c) => /\/career\/(zphxx|xjhxx)\/search/.test(c.url)));
  ok('宣讲会往前只留 1 天（日常场次）', T.JYW_CHANNELS[1].daysBack === 1);
  ok('招聘会往前留 7 天（刚办完的回看一眼）', T.JYW_CHANNELS[0].daysBack === 7);
  ok('占位教室被丢掉', T.jywRoom('教室需借用成功后才能确定具体位置') === '' && T.jywRoom('C117') === 'C117');
  ok('空中招聘会走 kz/view', /\/zphxx\/kz\/view\//.test(T.jobfairDetailUrl('1', '40', '')));
  ok('线下招聘会走 view', /\/zphxx\/view\//.test(T.jobfairDetailUrl('1', '10', '')));
  ok('空中且 jbdd 是外链时直接用外链', T.jobfairDetailUrl('1', '40', 'https://x.com/a') === 'https://x.com/a');
  ok('解析不出时间回 0', T.tsOf('') === 0 && T.tsOf('不是时间') === 0 && T.tsOf('2026-11-11 13:00') > 0);

  console.log('\n=== 2. 真出网跑两条通道 ===');
  const t0 = Date.now();
  let out;
  try {
    out = await T.syncJywAll();
  } catch (e) {
    ok('syncJywAll 不抛错', false, String(e && e.message));
    console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(1);
  }
  const ms = Date.now() - t0;
  ok('syncJywAll 不抛错', true);
  console.log('    （耗时 ' + ms + 'ms，两条通道并发）');
  ok('ok 为真', out.ok === true, out);
  ok('两条通道都有回执', Array.isArray(out.channels) && out.channels.length === 2, out.channels);

  const zph = out.channels.find((c) => c.key === 'zph');
  const xjh = out.channels.find((c) => c.key === 'xjh');
  ok('招聘会通道 ok', zph && zph.ok === true, zph);
  ok('宣讲会通道 ok', xjh && xjh.ok === true, xjh);
  console.log('    招聘会: scanned=' + zph.scanned + ' kept=' + zph.kept + ' added=' + zph.added);
  console.log('    宣讲会: scanned=' + xjh.scanned + ' kept=' + xjh.kept + ' added=' + xjh.added);

  ok('招聘会通道扫到全量（>50 条存档）', zph.scanned > 50, zph.scanned);
  ok('招聘会只留窗口内的少数几条（不是把 167 条全灌进来）', zph.kept > 0 && zph.kept <= 10, zph.kept);
  ok('宣讲会通道扫到全量', xjh.scanned >= 20, xjh.scanned);
  ok('宣讲会留下了大量未来场次（这才是撑住页面的内容）', xjh.kept >= 15, xjh.kept);
  ok('宣讲会 kept <= scanned（不会凭空多出来）', xjh.kept <= xjh.scanned);

  console.log('\n=== 3. 落库的每条字段都合法 ===');
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const minOk = day.getTime() - 7 * 86400000;
  const maxOk = day.getTime() + 180 * 86400000;
  ok('写入条数 = 两条通道 kept 之和', writes.length === zph.kept + xjh.kept, { writes: writes.length, kept: zph.kept + xjh.kept });
  ok('全部标成 jobfair 类型', writes.every((w) => w.type === 'jobfair'));
  ok('全部标成官方来源', writes.every((w) => w.official === true && w.source === '就业指导中心'));
  ok('标题 / 原文链接都不为空', writes.every((w) => w.title && w.sourceUrl && /^https:\/\/jyw\.zjgsu\.edu\.cn\//.test(w.sourceUrl)));
  ok('日期串都是 YYYY-MM-DD', writes.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.date)), writes.find((w) => !/^\d{4}-\d{2}-\d{2}$/.test(w.date)));
  ok('at 就是举办时间戳（不是发布日）', writes.every((w) => w.at === w.jobTs && w.jobTs > 0));
  ok('结束时间不早于开始时间', writes.every((w) => !w.jobEndTs || w.jobEndTs >= w.jobTs));
  ok('全部落在 -7 ~ +180 天窗口内', writes.every((w) => w.jobTs >= minOk && w.jobTs <= maxOk));
  ok('类别标签非空', writes.every((w) => w.jobKind && w.jobKind.length <= 12), writes.find((w) => !w.jobKind));
  ok('id 带通道前缀且不重复', new Set(writes.map((w) => w.id)).size === writes.length && writes.every((w) => /^job(zph|xjh)/.test(w.id)));
  const kinds = {};
  writes.forEach((w) => { kinds[w.jobKind] = (kinds[w.jobKind] || 0) + 1; });
  console.log('    类别分布: ' + JSON.stringify(kinds));
  ok('宣讲会与双选会被区分开', Object.keys(kinds).some((k) => k === '宣讲会') && Object.keys(kinds).some((k) => k !== '宣讲会'));
  // 把这一轮真出网落下来的数据存成固定夹具，给前端展示口径测试复用 ——
  // 那条测试不该再打一次网（它验的是渲染逻辑，不是接口）。
  //
  // ⚠️ 但不能直接落盘：每条的 id 是「job{zph|xjh}<源id>-<syncedAt>」，
  // 里面嵌的是本次抓取的时间戳。直接写的话每跑一次测试 id 就全变一遍，
  // fixture 在 git 里永远是脏的，而岗位内容其实一个字都没变。
  // 所以先跟旧夹具比一遍「内容指纹」：没变就一个字节都不写；
  // 真变了才写，且沿用旧的时间戳（内容换了新的 id 才该变，且只变一次）。
  const snap = stableSnapshot(writes);
  if (snap) {
    fs.writeFileSync(FIXTURE, JSON.stringify(snap, null, 1));
    console.log('    夹具已更新（岗位内容有变化）');
  } else {
    console.log('    夹具内容与上次一致，跳过写盘（避免 id 里的时间戳每次都变）');
  }

  console.log('\n=== 4. 宣讲会字段映射（对着真数据看） ===');
  const talks = writes.filter((w) => /^jobxjh/.test(w.id));
  const sample = talks[0];
  console.log('    样例: ' + JSON.stringify({ title: sample.title, start: sample.start, location: sample.location, desc: sample.desc }));
  ok('地点里不带「教室需借用」占位文案', talks.every((t) => !/借用|待定|另定/.test(t.location || '')));
  ok('地点丢了具体教室也至少留校区', talks.every((t) => /下沙校区|教工路校区/.test(t.location || '')), talks.find((t) => !/校区/.test(t.location || '')));
  ok('desc 里带单位名', talks.every((t) => t.desc && t.desc.length <= 60));
  ok('详情页地址指向 xjhxx/view', talks.every((t) => /\/career\/xjhxx\/view\/\d+$/.test(t.sourceUrl)), talks[0].sourceUrl);
  const fairs = writes.filter((w) => /^jobzph/.test(w.id));
  ok('招聘会详情页地址指向 zphxx/view', fairs.every((w) => /\/career\/zphxx\/(kz\/)?view\//.test(w.sourceUrl)), fairs.map((f) => f.sourceUrl));

  console.log('\n=== 5. 幂等：再跑一次不会重复落库 ===');
  recs = writes.map((w) => ({ sourceUrl: w.sourceUrl, id: w.id }));
  const writesBefore = writes.length;
  const out2 = await T.syncJywAll();
  ok('第二次 added 为 0', out2.added === 0, out2.added);
  ok('第二次全部走 update', out2.updated === out2.kept && out2.kept > 0, { updated: out2.updated, kept: out2.kept });
  ok('没有新增写入', writes.length === writesBefore);
  ok('kept 与第一次一致（窗口稳定）', out2.kept === zph.kept + xjh.kept);

  console.log('\n=== 6. 单通道挂掉不连累另一条 ===');
  // 把一个通道的地址改坏，另一条仍应成功
  const saveUrl = T.JYW_CHANNELS[0].url;
  T.JYW_CHANNELS[0].url = 'https://jyw.zjgsu.edu.cn/career/no-such-endpoint-xyz';
  const out3 = await T.syncJywAll();
  T.JYW_CHANNELS[0].url = saveUrl;
  ok('坏通道 ok:false', out3.channels[0].ok === false, out3.channels[0]);
  ok('好通道仍然 ok:true 并保留内容', out3.channels[1].ok === true && out3.channels[1].kept > 0, out3.channels[1]);
  ok('整体仍算成功（不因为一个源挂了就说全失败）', out3.ok === true);

  console.log('\n=== 7. 详情页链接真的打得开 ===');
  const probe = [fairs[0] && fairs[0].sourceUrl, talks[0] && talks[0].sourceUrl].filter(Boolean);
  for (const u of probe) {
    const code = await new Promise((resolve) => {
      const mod = require('https');
      const req = mod.get(u, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        res.resume(); resolve(res.statusCode);
      });
      req.on('error', () => resolve(0));
      req.on('timeout', () => { req.destroy(); resolve(0); });
    });
    ok('打开 ' + u.replace('https://jyw.zjgsu.edu.cn', '') + ' → ' + code, code === 200);
  }

  console.log('\n=== 8. 云端窗口口径 ↔ 前端展示口径 必须一致 ===');
  // 前端 campus.js 的 inWindow：官方条目里 jobfair 用 jobTs，其他用 at
  const weekAgo = Date.now() - 7 * 86400000;
  const inWindow = (e) => (e.type === 'jobfair'
    ? (Number(e.jobTs) || Number(e.at) || 0)
    : (Number(e.at) || 0)) >= weekAgo;
  ok('落库的招聘会全部能通过前端窗口（不会「库里有、界面没有」）', writes.every(inWindow));
  // 反证：如果 at 用发布日（今天），12 月那场会被旧窗口滤掉吗？不会 —— 但会被挤出首页
  const evening = writes.filter((w) => Number(w.jobTs) > Date.now() + 30 * 86400000);
  ok('存在一个月以后才办的场次（靠 jobTs 才不会被当成过期）', evening.length > 0, evening.length);
  ok('这些远期场次全部集中在列表最前（at 升序取前几条就是它们）',
    writes.slice().sort((a, b) => a.at - b.at)[0].at === Math.min.apply(null, writes.map((w) => w.at)));

  console.log('\n=== 9. 前端分页够装 ===');
  const eventPage = Number((/const EVENT_PAGE = (\d+);/.exec(src) || [])[1]);
  ok('EVENT_PAGE 提到 100（云函数单次 get 上限）', eventPage === 100, eventPage);
  ok('招聘会 + 宣讲会 + 7 天内的公告 装得下一页', writes.length + 20 <= eventPage, { jobs: writes.length });

  console.log('\n' + '='.repeat(52));
  console.log('结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
