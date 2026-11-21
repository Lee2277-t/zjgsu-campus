// scripts/test-batch-upload.cjs —— 学习资料「一次选多个文件」的守卫
//
// 这里刻意把页面真跑起来（桩掉 Page / wx / 上传 / 云调用），
// 而不是只拿正则去源码里找字符串 ——
// 「批量」这类需求最容易做成「界面有了、行为还是单个」：
// 按钮写着「发布 3 份」，实际只发第一份，静态检查一点都看不出来。
//
// 覆盖：
//   1. 选多个 → 队列里真的有多份，标题默认就是文件名
//   2. 队列里能改标题、能去掉某一项
//   3. 发布是逐份发出去的（调了几次 resourceAdd 就说几份，不靠文案猜）
//   4. 一部分失败时，只清掉成功的，失败的留在队列里能重发

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');

// 项目 package.json 是 "type":"module"，小程序 .js 会被 Node 当 ESM 解析。
// 强制按 CommonJS 编译小程序目录下的文件
const origJs = Module._extensions['.js'];
Module._extensions['.js'] = function (m, f) {
  if (norm(f).indexOf(norm(ROOT)) === 0) return m._compile(fs.readFileSync(f, 'utf8'), f);
  return origJs(m, f);
};

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}

const readProj = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

const upload = require(path.join(APP, 'utils/upload.js'));
const userApi = require(path.join(APP, 'utils/user.js'));

/* ---------------- 一、契约 ---------------- */

const uploadSrc = readProj('utils/upload.js');

ok('upload.js 导出 pickFiles（批量选文件的入口）',
  typeof upload.pickFiles === 'function');

// count 必须真的传进 chooseMessageFile，写死 1 的话多选是不生效的
ok('pickFiles 把 count 传给了 chooseMessageFile',
  uploadSrc.indexOf('{ count: want }') >= 0);
ok('pickFiles 的 count 有上限（不让一次选 100 个）',
  /MAX_PICK_FILES\s*=\s*\d+/.test(uploadSrc) && /Math\.min\(MAX_PICK_FILES/.test(uploadSrc));

// 单选必须走批量那一套，否则两处降级逻辑迟早不一致：
// 会出现「单选能用、多选卡住」这种最难查的问题
ok('pickFile 委托给 pickFiles（降级逻辑只有一份）',
  /async function pickFile\([\s\S]{0,200}?pickFiles\(extensions, 1\)/.test(uploadSrc));

const resSrc = readProj('pages/tool/resources/resources.js');
ok('资料页改用 pickFiles 选文件', resSrc.indexOf('upload.pickFiles(') >= 0);
ok('资料页不再用单选的 pickFile', !/upload\.pickFile\(/.test(resSrc));
ok('标题默认取文件名（去扩展名的函数存在）',
  /function titleFromName/.test(resSrc) && /replace\(\/\\\.\[\^\.\]\+\$\//.test(resSrc));

const resWxml = readProj('pages/tool/resources/resources.wxml');
// 按钮文案随队列份数变（「发布资料」→「发布这 3 份资料」）
ok('发布按钮按队列份数显示',
  /queue\.length > 1 \? '发布这 '/.test(resWxml) && resWxml.indexOf('份资料') >= 0);
ok('队列空时发布按钮是禁用的',
  /disabled="\{\{uploading \|\| queue\.length === 0\}\}"/.test(resWxml));
ok('队列里每一项都能单独改标题',
  resWxml.indexOf('bindinput="onQueueInput"') >= 0 && resWxml.indexOf('data-i="{{index}}"') >= 0);

/* ---------------- 二、把页面跑起来 ---------------- */

// —— 桩 ——
const wxCalls = [];
global.wx = {
  showToast(o) { wxCalls.push('toast:' + String((o && o.title) || '')); },
  showLoading(o) { wxCalls.push('loading:' + String((o && o.title) || '')); },
  hideLoading() {},
  getFileSystemManager() { return null; },
  cloud: { uploadFile() {}, downloadFile() { return Promise.resolve({}); } }
};

let cfg = null;
global.Page = function (c) { cfg = c; return c; };

// 上传桩：可控地成功 / 失败
let uploadPlan = [];
let uploaded = [];
upload.uploadFile = function (filePath, cloudPath) {
  uploaded.push({ filePath: filePath, cloudPath: cloudPath });
  const r = uploadPlan.shift();
  return Promise.resolve(r === false
    ? { ok: false, msg: '网络不顺' }
    : { ok: true, fileID: 'cloud://x/' + String(filePath).split('/').pop() });
};
upload.cloudPathFor = function (prefix, ext) { return prefix + '/stub.' + ext; };

// 云调用桩：记录每次提交的标题
let added = [];
let addPlan = [];
userApi.resourceAdd = function (p) {
  added.push(p);
  const r = addPlan.shift();
  if (r === false) return Promise.resolve({ ok: false, msg: '发布失败' });
  return Promise.resolve({ ok: true });
};

// 云存储可用
const cloud = require(path.join(APP, 'utils/cloud.js'));
cloud.ensureCloud = function () { return true; };

require(path.join(APP, 'pages/tool/resources/resources.js'));
// 列表加载：本测试只关心上传这一段，让 load 空转
cfg.load = function () { return Promise.resolve(); };

function make() {
  const p = Object.assign({}, cfg);
  p.data = JSON.parse(JSON.stringify(cfg.data));
  p.setData = function (patch) { Object.assign(p.data, patch); };
  return p;
}

const files = [
  { path: '/tmp/a.pdf', name: '中级财务会计_期末重点.pdf', size: 1024 },
  { path: '/tmp/b.docx', name: '毛概笔记.docx', size: 2048 },
  { path: '/tmp/c.pptx', name: '线代讲义.pptx', size: 4096 }
];

/* ---------------- 三、行为 ---------------- */

(async () => {
  // 1) 选 3 个 → 队列 3 份，标题默认是文件名（去扩展名、下划线转空格）
  uploadPlan = [true, true, true];
  uploaded = [];
  const p = make();
  p.data.queue = [];
  await p.uploadBatch(files);

  ok('传 3 个文件，队列里就是 3 份', p.data.queue.length === 3, p.data.queue.length);
  ok('每个文件都真的上传了一次', uploaded.length === 3, uploaded.length);
  ok('标题默认取文件名并去掉扩展名',
    p.data.queue[0].title === '中级财务会计 期末重点', p.data.queue[0].title);
  ok('第二个文件的标题也是它自己的（不是共用第一个）',
    p.data.queue[1].title === '毛概笔记', p.data.queue[1].title);
  ok('队列里带着 fileID 和原始文件名',
    !!p.data.queue[0].fileID && p.data.queue[0].name === '中级财务会计_期末重点.pdf');

  // 2) 队列里改标题 / 删一项
  p.onQueueInput({ currentTarget: { dataset: { i: 1 } }, detail: { value: '毛概 2023 版笔记' } });
  ok('能单独改某一项的标题',
    p.data.queue[1].title === '毛概 2023 版笔记', p.data.queue[1].title);
  ok('改一项不会动到别的项',
    p.data.queue[0].title === '中级财务会计 期末重点', p.data.queue[0].title);

  p.onQueueRemove({ currentTarget: { dataset: { i: 0 } } });
  ok('能去掉某一项', p.data.queue.length === 2, p.data.queue.length);
  ok('去掉的是指定那一项', p.data.queue[0].title === '毛概 2023 版笔记', p.data.queue[0].title);

  // 3) 发布：逐份发出去
  added = [];
  addPlan = [true, true];
  const q = make();
  q.data.queue = [
    { name: 'a.pdf', fileID: 'cloud://x/a', size: 1, title: '甲' },
    { name: 'b.pdf', fileID: 'cloud://x/b', size: 2, title: '乙' }
  ];
  q.data.form = { courseName: '会计学', desc: '期末整理', category: '真题' };
  await q.onSubmit();

  ok('两份就调两次发布接口（不是只发第一份）', added.length === 2, added.length);
  ok('两份各自的标题分别发出去',
    added[0] && added[0].title === '甲' && added[1] && added[1].title === '乙',
    added.map((x) => x.title));
  ok('分类 / 课程名是整批共用的',
    added[0].category === '真题' && added[0].courseName === '会计学');
  ok('每份带自己的 fileID', added[0].fileID === 'cloud://x/a' && added[1].fileID === 'cloud://x/b');
  ok('全部成功后队列清空', q.data.queue.length === 0, q.data.queue.length);

  // 4) 一部分失败：只清成功的，失败的留着能重发
  added = [];
  addPlan = [true, false];
  const r2 = make();
  r2.data.queue = [
    { name: 'a.pdf', fileID: 'cloud://x/a', size: 1, title: '甲' },
    { name: 'b.pdf', fileID: 'cloud://x/b', size: 2, title: '乙' }
  ];
  r2.data.form = { courseName: '', desc: '', category: '笔记' };
  await r2.onSubmit();

  ok('失败的发布不会中断后面的（两次都试了）', added.length === 2, added.length);
  ok('失败的留在队列里，不用重新选文件',
    r2.data.queue.length === 1 && r2.data.queue[0].title === '乙', r2.data.queue.map((x) => x.title));
  ok('提示里说清了几份成功几份失败',
    wxCalls.some((c) => c.indexOf('发出 1 份，1 份失败') >= 0), wxCalls.slice(-3));

  // 5) 空队列点了不该发
  added = [];
  const r3 = make();
  r3.data.queue = [];
  r3.data.form = { courseName: '', desc: '', category: '笔记' };
  await r3.onSubmit();
  ok('队列空时不发请求', added.length === 0, added.length);

  // 6) 有标题为空的，整批拦下（不然发出去一条没名字的资料）
  added = [];
  addPlan = [];
  const r4 = make();
  r4.data.queue = [
    { name: 'a.pdf', fileID: 'cloud://x/a', size: 1, title: '甲' },
    { name: 'b.pdf', fileID: 'cloud://x/b', size: 2, title: '  ' }
  ];
  r4.data.form = { courseName: '', desc: '', category: '笔记' };
  await r4.onSubmit();
  ok('有一份没名字就整批拦下', added.length === 0, added.length);

  /* ---------------- 汇总 ---------------- */
  console.log('');
  if (fails.length) {
    console.log('失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('批量上传：' + pass + ' 通过 / 0 失败');
})();
