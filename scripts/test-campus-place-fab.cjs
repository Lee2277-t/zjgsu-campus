// scripts/test-campus-place-fab.cjs —— 校园页「地点地图」那一档右下角的 ➕
//
// 为什么要为这一个按钮写一份测试：
//   加地点的动作本来要三步 —— 划到底行「添加一个地点」→ 进完整页 → 再点一下把表单摊开。
//   这三步里任何一步被后来的改动拿掉，都不会报错、不会白屏，
//   只是「没有人再补地点了」，而过两周发现时已经说不清是从哪次改的。
//   所以这里既钉按钮的存在，也钉它落地后在做什么。
//
// 覆盖：
//   1. 校园页地点那一档有悬浮 ➕，且绑到 goAddPlace（不是复制黏贴成 goAddEvent）
//   2. 跳转带 add=1，并把当前分类一起带过去
//   3. 回来了会重拉地点列表（拉完把旗子放倒）
//   4. 地点页收到 add=1 就摊开表单 + 认 cat 参数（认得了才用，不认就不认）
//   5. 加完自动退回上一页；没上一页可退时不把人丢在成功提示后面

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const readProj = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
}

// 小程序的 .js 是 CommonJS，但 recon/package.json 写着 "type":"module"，
// 直接 require 会被当成 ESM 解析，报 "module is not defined"。
// 跟 utils/pager.js 一样，用 new Function 手动装载真源码。
function loadPlaceSearch() {
  const mod = { exports: {} };
  const searchMod = { exports: {} };
  const searchSrc = fs.readFileSync(path.join(PROJ, 'utils', 'search.js'), 'utf8');
  new Function('module', 'exports', searchSrc)(searchMod, searchMod.exports);
  const src = fs.readFileSync(path.join(PROJ, 'utils', 'place-search.js'), 'utf8');
  new Function('module', 'exports', 'require', src)(mod, mod.exports, (p) => (
    /search\.js/.test(p) ? searchMod.exports : {}
  ));
  return mod.exports;
}

/* ---------------- 静态：校园页那个按钮 ---------------- */

const CAMPUS_WXML = readProj('pages/campus/campus.wxml');
const CAMPUS_JS = readProj('pages/campus/campus.js');
const PLACES_WXML = readProj('pages/tool/places/places.wxml');

// 取 marker 所在的那一对尖括号，不在全文件里找 —— 地点那一档和活动那一档
// 都有 fab，全文件一搜必然命中活动那个，等于没测
function blockAfter(src, marker) {
  const i = src.indexOf(marker);
  return i < 0 ? '' : src.slice(i);
}
function tagOf(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) return '';
  const start = src.lastIndexOf('<view', i);
  const end = src.indexOf('>', i);
  if (start < 0 || end < 0) return '';
  return src.slice(start, end + 1);
}

const placesBlock = blockAfter(CAMPUS_WXML, "wx:elif=\"{{tab === 'places'}}\"");
ok('校园页有「地点地图」这一档', placesBlock.length > 0);
ok('地点那一档里有悬浮按钮', /class="fab hub-fab/.test(placesBlock));
const fabTag = tagOf(placesBlock, 'goAddPlace');
ok('悬浮按钮绑的是 goAddPlace（不是粘错成 goAddEvent）',
  fabTag !== '' && /bindtap="goAddPlace"/.test(fabTag) && !/goAddEvent/.test(fabTag), fabTag);
ok('校园页确实实现了 goAddPlace', /goAddPlace\(\)\s*\{/.test(CAMPUS_JS));
// 底层也没断：地点 url 指向那个带表单的页，不是某条不存在的路由
ok('跳转目标就是校园地点页', /goAddPlace[\s\S]{0,300}pages\/tool\/places\/places/.test(CAMPUS_JS));
// 不再保留那句旧的「添加一个地点」：加了 ➕ 之后这行再说同样的话，是两个长得一样的入口
ok('底行不再是第二个「添加地点」入口', !/hub-more__text">添加/.test(placesBlock));

/* ---------------- 跑真实源码：校园页侧 ---------------- */

const BASE_GLOBALS = {
  console, Date, Number, String, Array, Object, JSON, Math, RegExp, Promise,
  setTimeout, clearTimeout, isNaN, parseInt, parseFloat
};

let placeListCalls = 0;
const NAV_FIXTURES = [
  { id: 'p1', name: '菜鸟驿站', category: '快递', latitude: 30.3, longitude: 120.1 },
  { id: 'p2', name: '2 号教学楼', category: '教学楼', latitude: 30.31, longitude: 120.11 }
];

function loadCampus() {
  let page = null;
  const navCalls = [];
  const sandbox = Object.assign({}, BASE_GLOBALS, {
    Page: (def) => { page = def; },
    wx: {
      getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
      showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {},
      openLocation: () => {}
    },
    require: (p) => {
      if (/utils\/event/.test(p)) {
        return {
          getEvents: () => [], fetchEvents: () => Promise.resolve(0), fetchState: () => ({ ok: true }),
          typeIcon: () => 'sparkles', typeLabel: () => '其他', nowText: () => ''
        };
      }
      if (/utils\/user/.test(p)) {
        return {
          eventSync: () => Promise.resolve({ ok: true }),
          calendarList: () => Promise.resolve([]),
          placeList: () => { placeListCalls += 1; return Promise.resolve(NAV_FIXTURES); }
        };
      }
      if (/utils\/store/.test(p)) return { isFavorited: () => false, toggleFavorite: () => ({ ok: true }) };
      // 地点搜索的口径模块：校园页现在也要它（分类 + 关键词一起过）
      if (/utils\/place-search/.test(p)) return loadPlaceSearch();
      if (/utils\/pager/.test(p)) {
        // 直接跑 utils/pager.js 的真源码：它是纯逻辑、没有依赖，
        // 抄一份等价替身反而会在真改分页行为时继续按旧行为通过
        const mod = { exports: {} };
        const src = fs.readFileSync(path.resolve(PROJ, 'utils', 'pager.js'), 'utf8');
        new Function('module', 'exports', src)(mod, mod.exports);
        return mod.exports;
      }
      if (/utils\/report/.test(p)) return { report: () => Promise.resolve(true), reportIfCloud: () => Promise.resolve(true) };
      if (/utils\/nav/.test(p)) return { go: (arg) => { navCalls.push(typeof arg === 'string' ? arg : (arg && arg.url) || ''); return true; } };
      return {};
    }
  });
  vm.createContext(sandbox);
  vm.runInContext(readProj('pages/campus/campus.js'), sandbox, { filename: 'campus.js' });
  return { page: page, navCalls: navCalls };
}

(async () => {
  {
    const { page, navCalls } = loadCampus();
    const inst = Object.assign({}, page);
    inst.data = JSON.parse(JSON.stringify(page.data));
    inst.setData = function (d) { Object.assign(this.data, d); };

    ok('默认在没有 placeDirty 这个状态', inst.data.placeDirty === false, inst.data.placeDirty);

    // 「全部」分类：不多带一个空的 cat 参数
    inst.goAddPlace();
    const url0 = navCalls[navCalls.length - 1] || '';
    ok('➕ 跳到校园地点页并带上 add=1', /pages\/tool\/places\/places\?add=1/.test(url0), url0);
    ok('分类是「全部」时不带 cat 参数', url0.indexOf('cat=') < 0, url0);
    ok('跳之前记下「回来要刷新」', inst.data.placeDirty === true);

    // 换到具体分类：进去表单里的分类就该是它
    inst.setData({ placeCat: '快递', placeCatMap: {} });
    inst.goAddPlace();
    const url1 = navCalls[navCalls.length - 1] || '';
    ok('带着当前分类一起走', /cat=%E5%BF%AB%E9%80%92/.test(url1) || /cat=快递/.test(url1), url1);

    // 回来：重拉地点
    placeListCalls = 0;
    inst.setData({ loaded: { events: false, calendar: false, places: true } });
    inst.onShow();
    // vm 上下文里的 async 函数用的是那个 realm 自己的 Promise，
    // 光 await 几个空微任务不保证它的 await 已经落地 —— 用宏任务等更稳
    await new Promise((r) => setTimeout(r, 0));
    ok('退回来后重拉了一次地点', placeListCalls === 1, placeListCalls);
    // 这两条盯的是「loadPlaces 真的把数据写进去了」。
    // 原来这里钉的是 catIcon 装饰，那套映射后来被删掉了（不参与渲染，
    // 其中三个图标名在 assets/icons 里根本没有对应文件）
    ok('重拉之后全量进了缓存（不再按分类问云端）',
      (inst._allPlaces || []).length === 2, (inst._allPlaces || []).length);
    // 这一档当前停在「快递」，所以本地过完之后只剩快递那一条
    ok('拉回来就按当前分类过了一遍',
      (inst.data.placeList || []).map((p) => p.id).join(',') === 'p1', inst.data.placeList);
    ok('旗子用完就放倒（下次回前台不会白拉）', inst.data.placeDirty === false);

    // 还没加载过地点的，不该为了清旗子硬拉一次
    placeListCalls = 0;
    inst.setData({ placeDirty: true, loaded: { events: false, calendar: false, places: false } });
    inst.onShow();
    await Promise.resolve();
    ok('没进过这一档就不去拉', placeListCalls === 0, placeListCalls);
    ok('旗子照样放倒（不会攒到下次突然拉一堆）', inst.data.placeDirty === false);
  }

  /* ---------------- 跑真实源码：地点页侧 ---------------- */

  // opts.backFails = true 模拟「没有上一页可退」（分享链接直接落到这一页）
  function loadPlaces(opts) {
    const backFails = !!(opts && opts.backFails);
    let page = null;
    const backCalls = [];
    const addCalls = [];
    const scrollCalls = [];
    let loadCount = 0;
    const sandbox = Object.assign({}, BASE_GLOBALS, {
      Page: (def) => { page = def; },
      wx: {
        showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
        showModal: () => {}, openLocation: () => {}, makePhoneCall: () => {},
        chooseLocation: () => {},
        // 选择器 + 滚动：假表单排在 420rpx 处、当前在页头，
        // 只看「有没有滚」和滚到哪，不去真算布局
        createSelectorQuery: () => {
          const q = {};
          q.select = () => q;
          q.boundingClientRect = () => q;
          q.selectViewport = () => q;
          q.scrollOffset = () => q;
          q.exec = (cb) => { cb([{ top: 420, height: 260 }, { scrollTop: 0 }]); };
          return q;
        },
        pageScrollTo: (o) => { scrollCalls.push(o || {}); },
        navigateBack: (o) => {
          backCalls.push(o || {});
          // 微信的做法：失败回调放在 options.fail 里
          if (backFails && o && typeof o.fail === 'function') o.fail({ errMsg: 'navigateBack:fail' });
        },
        setStorageSync: () => {}, getStorageSync: () => ''
      },
      require: (p) => {
        if (/utils\/user/.test(p)) {
          return {
            placeList: () => { loadCount += 1; return Promise.resolve(NAV_FIXTURES); },
            placeAdd: (pl) => { addCalls.push(pl); return Promise.resolve({ ok: true }); },
            placeRemove: () => Promise.resolve({ ok: true })
          };
        }
        // 搜索口径模块：用真源码，别拿替身糊过去 ——
        // 替身一旦跟真实口径分叉，这里会一路绿着而线上搜不到
        if (/utils\/place-search/.test(p)) return loadPlaceSearch();
        return {};
      }
    });
    vm.createContext(sandbox);
    vm.runInContext(readProj('pages/tool/places/places.js'), sandbox, { filename: 'places.js' });
    return { page: page, backCalls: backCalls, addCalls: addCalls, scrollCalls: scrollCalls, count: () => loadCount };
  }

  function fresh(pkg) {
    const inst = Object.assign({}, pkg.page);
    inst.data = JSON.parse(JSON.stringify(pkg.page.data));
    inst.setData = function (d) { Object.assign(this.data, d); };
    return inst;
  }

  {
    const pkg = loadPlaces();

    const plain = fresh(pkg);
    plain.onLoad({});
    ok('普通进来：表单不摊开', plain.data.showForm === false);
    ok('普通进来：加完也不自动退', plain.data.backOnSave === false);

    const fab = fresh(pkg);
    fab.onLoad({ add: '1' });
    ok('带 add=1 进来：表单已经摊开', fab.data.showForm === true);
    ok('带 add=1 进来：加完自动退回上一页', fab.data.backOnSave === true);

    const withCat = fresh(pkg);
    withCat.onLoad({ add: '1', cat: '快递' });
    ok('分类带过来就预选它', withCat.data.form.category === '快递', withCat.data.form.category);
    ok('分类带过来，那一栏的高亮也跟着走', withCat.data.catFormMap['快递'] === true);

    const badCat = fresh(pkg);
    badCat.onLoad({ add: '1', cat: '火星évreywhere' });
    ok('认不出来的分类不硬塞（退回「其他」）', badCat.data.form.category === '其他', badCat.data.form.category);
    ok('认不出来时六个分类不会全灭', Object.keys(badCat.data.catFormMap).length === 6);
  }

  {
    // 表单在页面中间（地图、分类、列表之间），带 add=1 进来要替他滚到眼前
    const pkg = loadPlaces();
    const inst = fresh(pkg);
    inst.onLoad({ add: '1' });
    await new Promise((r) => setTimeout(r, 520));
    ok('带着 add=1 进来，落地就把表单滚到眼前', pkg.scrollCalls.length === 1, pkg.scrollCalls);
    ok('滚到的就是表单的位置', pkg.scrollCalls[0] && pkg.scrollCalls[0].scrollTop === 408, pkg.scrollCalls[0]);
  }

  {
    // 在本页自己点「补充一个地点」时不滚：那一眼看到的就是他自己点的按钮
    const pkg = loadPlaces();
    const inst = fresh(pkg);
    inst.onLoad({});
    inst.onToggleForm();
    await new Promise((r) => setTimeout(r, 520));
    ok('自己点开表单时不挪动页面', pkg.scrollCalls.length === 0, pkg.scrollCalls);
  }

  {
    const pkg = loadPlaces();
    const inst = fresh(pkg);
    inst.onLoad({ add: '1', cat: '快递' });
    inst.data.form.name = '菜鸟驿站（新）';
    inst.data.form.latitude = 30.3;
    inst.data.form.longitude = 120.1;

    await inst.onSubmit();
    ok('填好点保存：真的写进去了', pkg.addCalls.length === 1, pkg.addCalls);
    ok('写进去的分类就是带过来的那个', pkg.addCalls[0] && pkg.addCalls[0].category === '快递', pkg.addCalls[0]);
    const before = pkg.backCalls.length;
    await new Promise((r) => setTimeout(r, 900));
    ok('写完自动退回校园页', pkg.backCalls.length > before, pkg.backCalls.length);
  }

  {
    const pkg = loadPlaces();
    const inst = fresh(pkg);
    inst.onLoad({ add: '1' });
    // 没选位置：这一步漏了才会把同学导航到隔壁学校，必须拦在提交之前
    inst.data.form.name = '某个地点';
    await inst.onSubmit();
    ok('没在地图上选点，不给保存', pkg.addCalls.length === 0, pkg.addCalls);
    await new Promise((r) => setTimeout(r, 900));
    ok('没保存成功就不后退（留在原地接着填）', pkg.backCalls.length === 0, pkg.backCalls.length);
  }

  {
    // 没有上一页可退（分享链接直接进来）：退不了也不能把人丢在成功提示后面
    const pkg = loadPlaces({ backFails: true });
    const inst = fresh(pkg);
    inst.onLoad({ add: '1' });
    inst.data.form.name = '某个地点';
    inst.data.form.latitude = 30.3;
    inst.data.form.longitude = 120.1;
    await inst.onSubmit();
    const before = pkg.count();
    await new Promise((r) => setTimeout(r, 900));
    ok('退不回去时表单自己收起来', inst.data.showForm === false);
    ok('退不回去时列表照样刷新（新地点要看得见）', pkg.count() > before, [before, pkg.count()]);
    ok('退不回去时不再执着于后退', inst.data.backOnSave === false);
  }

  {
    // 本页「补充一个地点」那条老路径不能坏：加完留在原地、表单收起、列表刷新
    const pkg = loadPlaces();
    const inst = fresh(pkg);
    inst.onLoad({});
    inst.onToggleForm();
    ok('老入口：点一下摊开表单', inst.data.showForm === true);
    inst.data.form.name = '科教楼';
    inst.data.form.latitude = 30.3;
    inst.data.form.longitude = 120.1;
    const before = pkg.count();
    await inst.onSubmit();
    await new Promise((r) => setTimeout(r, 900));
    ok('老入口：加完不后退', pkg.backCalls.length === 0, pkg.backCalls.length);
    ok('老入口：表单收回去', inst.data.showForm === false);
    ok('老入口：列表重拉了', pkg.count() > before, [before, pkg.count()]);
    ok('老入口：清干净了下一次接着加', inst.data.form.name === '' && inst.data.picked === false);
  }

  console.log('\n  通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
})();
