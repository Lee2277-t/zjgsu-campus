// scripts/test-places-search.cjs —— 校园地点的搜索
//
// 为什么要单写一份：
//   搜索这类功能「坏了」的样子不是报错，是**安静地不对** ——
//   输进去没反应、明明有却搜不到、切了分类又看不出是谁在起作用。
//   这里除了钉住控件在不在，更主要的是把匹配口径钉死：
//   搜名字之外还能搜地址 / 简介 / 分类，多词之间是「都要有」，
//   以及最要紧的一条 —— 有关键词时不被当前分类卡住。
//
// 覆盖：
//   1. 静态：搜索框 / 输入与确认的绑定 / 清空按钮 / 地图不再跟着结果一起空掉
//   2. 行为：全量只拉一次 + 切分类不再发请求
//   3. 行为：名字 / 地址 / 简介 / 分类四个字段都能搜到
//   4. 行为：多词是「且」，且忽略空格差异（2 号 / 2号 互通）
//   5. 行为：搜索跨分类；点分类即退出搜索

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

const PLACES_WXML = readProj('pages/tool/places/places.wxml');
const PLACES_JS = readProj('pages/tool/places/places.js');

/* ---------------- 静态 ---------------- */

// 只看搜索框那一段，别在全文件里找 —— 本页还有别的 input（表单里的名字 / 说明）
const searchTag = (() => {
  const i = PLACES_WXML.indexOf('class="search-bar pl-search"');
  if (i < 0) return '';
  const start = PLACES_WXML.lastIndexOf('<view', i);
  const end = PLACES_WXML.indexOf('</view>', i);
  return PLACES_WXML.slice(start, end);
})();

ok('地点页有搜索框', searchTag.length > 0);
ok('搜索框里是输入框而不是摆设', /<input/.test(searchTag));
ok('输入即筛（bindinput="onKeyword"）', /bindinput="onKeyword"/.test(searchTag));
ok('键盘上的「搜索」也有反应（bindconfirm）', /bindconfirm="onSearchConfirm"/.test(searchTag));
ok('只在有词时才出现清空按钮', /wx:if="{{hasKeyword}}"/.test(searchTag));
ok('有提示说明「搜索时不限分类」', /pl-search__note/.test(PLACES_WXML));
ok('提示里给了退路（点分类可退出搜索）', /点上面任意分类可退出搜索/.test(PLACES_WXML));
ok('搜索有结果时不会被「没找到」空态挡住',
  /hasKeyword && list\.length === 0/.test(PLACES_WXML) && !/wx:elif="{{hasKeyword}}"/.test(PLACES_WXML));

// 地图：显隐看 hasAny，中心看 mapCenter。
// 若哪天又被改回 list[0]，一次没搜到地图就整块消失，页面会跟着跳一下
ok('地图不再跟着筛选结果一起空掉', /wx:if="{{hasAny}}"/.test(PLACES_WXML));
ok('地图中心用的是独立的 mapCenter', /latitude="{{mapCenter.latitude}}"/.test(PLACES_WXML));
ok('地图中心不再取 list[0]', !/latitude="{{list\[0\]\.latitude}}"/.test(PLACES_WXML));

ok('有 onKeyword', /onKeyword\(/.test(PLACES_JS));
ok('有 onClearKeyword', /onClearKeyword\(/.test(PLACES_JS));
ok('有 applyFilter', /applyFilter\(/.test(PLACES_JS));

// 匹配口径只在 utils/place-search.js 里存在一份。
// 这条是防「两个页面各写一份」的闸门：哪天有人在 places.js 里又抄一个 matchPlace，
// 校园页和完整页就会开始给出不一样的结果，而且不会报错
ok('地点页用的是公共口径而不是自己再写一份',
  /utils\/place-search/.test(PLACES_JS) && !/function matchPlace\(/.test(PLACES_JS));
const SHARED_JS = readProj('utils/place-search.js');
ok('公共口径里确实有 matchPlace', /function matchPlace\(/.test(SHARED_JS));
ok('公共口径里有关键词时忽略分类', /const c = k \? '' : String\(cat \|\| ''\)/.test(SHARED_JS));

// 校园页那一档也必须有搜索（截图问的那一页）
const CAMPUS_JS = readProj('pages/campus/campus.js');
const CAMPUS_WXML = readProj('pages/campus/campus.wxml');
ok('校园页地点那一档也接了公共口径', /utils\/place-search/.test(CAMPUS_JS));
ok('校园页不再自己写匹配逻辑', !/function matchPlace\(/.test(CAMPUS_JS));
const hubSearch = (() => {
  const i = CAMPUS_WXML.indexOf('class="search-bar hub-search"');
  if (i < 0) return '';
  const start = CAMPUS_WXML.lastIndexOf('<view', i);
  const end = CAMPUS_WXML.indexOf('</view>', i);
  return CAMPUS_WXML.slice(start, end);
})();
ok('校园页地点那一档有搜索框', hubSearch.length > 0);
ok('校园页的输入框绑的是 onPlaceKeyword', /bindinput="onPlaceKeyword"/.test(hubSearch));
ok('校园页有清空按钮', /wx:if="{{hasPlaceKeyword}}"/.test(hubSearch));
ok('校园页给了「搜索时不限分类」的提示', /hub-search__note/.test(CAMPUS_WXML));
ok('校园页搜索有结果时不会被「没找到」空态挡住',
  /hasPlaceKeyword && placeList\.length === 0/.test(CAMPUS_WXML) && !/wx:elif="{{hasPlaceKeyword}}"/.test(CAMPUS_WXML));
// 「搜不到」和「这个分类下没有」必须是两句话，不能共用一句
ok('校园页把「搜不到」和「分类下没有」分开了',
  /没找到匹配的地点/.test(CAMPUS_WXML) && /这个分类下还没有地点/.test(CAMPUS_WXML));

/* ---------------- 跑真实源码 ---------------- */

const BASE_GLOBALS = {
  console, Date, Number, String, Array, Object, JSON, Math, RegExp, Promise,
  setTimeout, clearTimeout, isNaN, parseInt, parseFloat
};

// 小程序的 .js 是 CommonJS，但 recon/package.json 写着 "type":"module"，
// 直接 require 会被当成 ESM 解析并报 "module is not defined"。
// 跟 utils/pager.js 一样，用 new Function 手动装载真源码
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

const FIX = [
  { id: 'p1', name: '菜鸟驿站', category: '快递', latitude: 30.30, longitude: 120.10, address: '生活区 5 号楼下', desc: '取件要带身份证' },
  { id: 'p2', name: '2 号教学楼', category: '教学楼', latitude: 30.31, longitude: 120.11, address: '求真楼东侧', desc: '一到三楼都有插座' },
  { id: 'p3', name: '图书馆 Library', category: '教学楼', latitude: 30.32, longitude: 120.12, address: '中轴线尽头', desc: '三楼有研讨间' },
  { id: 'p4', name: '清风食堂', category: '食堂', latitude: 30.33, longitude: 120.13, address: '生活区南门', desc: '二楼有清真窗口' }
];

function loadPlaces() {
  let page = null;
  let listCalls = 0;
  const listArgs = [];
  const scrollCalls = [];
  const hideKeyboardCalls = [];
  const sandbox = Object.assign({}, BASE_GLOBALS, {
    Page: (def) => { page = def; },
    wx: {
      showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
      showModal: () => {}, openLocation: () => {}, makePhoneCall: () => {},
      chooseLocation: () => {},
      hideKeyboard: (o) => { hideKeyboardCalls.push(o || {}); },
      getSetting: () => {},
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
      navigateBack: () => {},
      setStorageSync: () => {}, getStorageSync: () => ''
    },
    require: (p) => {
      if (/utils\/user/.test(p)) {
        return {
          placeList: (c) => { listCalls += 1; listArgs.push(c); return Promise.resolve(FIX); },
          placeAdd: () => Promise.resolve({ ok: true }),
          placeRemove: () => Promise.resolve({ ok: true })
        };
      }
      // 用真源码，别拿替身 —— 替身跟真实口径分叉时，这里的断言会一路绿着而线上搜不到
      if (/utils\/place-search/.test(p)) return loadPlaceSearch();
      return {};
    }
  });
  vm.createContext(sandbox);
  vm.runInContext(readProj('pages/tool/places/places.js'), sandbox, { filename: 'places.js' });
  return {
    page: page,
    scrollCalls: scrollCalls,
    hideKeyboardCalls: hideKeyboardCalls,
    allArgs: listArgs,
    count: () => listCalls
  };
}

function fresh(pkg) {
  const inst = Object.assign({}, pkg.page);
  inst.data = JSON.parse(JSON.stringify(pkg.page.data));
  inst.setData = function (d) { Object.assign(this.data, d); };
  return inst;
}

// 等 load() 里那个 await 落地
const tick = () => new Promise((r) => setTimeout(r, 0));

// 模拟在搜索框里敲字
function type(inst, text) {
  inst.onKeyword({ detail: { value: text } });
}

(async () => {
  /* ---- 只拉一次全量，切分类不再发请求 ---- */
  {
    const pkg = loadPlaces();
    const inst = fresh(pkg);
    inst.onLoad({});
    await tick();
    ok('进来只拉一次', pkg.count() === 1, pkg.count());
    ok('拉的是全量（不按分类在云端过滤）', pkg.allArgs[0] === '', pkg.allArgs);
    ok('全量四条都在列表里', inst.data.list.length === 4, inst.data.list.length);
    ok('地图画出来了', inst.data.hasAny === true);

    // 切到「食堂」：走本地过滤，不该再打一次云端
    inst.onCategory({ currentTarget: { dataset: { c: '食堂' } } });
    await tick();
    ok('切分类不再发请求', pkg.count() === 1, pkg.count());
    ok('只出食堂那一条',
      inst.data.list.length === 1 && inst.data.list[0].name === '清风食堂', inst.data.list);
  }

  /* ---- 四个字段都能搜到 ---- */
  {
    const pkg = loadPlaces();
    const inst = fresh(pkg);
    inst.onLoad({});
    await tick();

    type(inst, '菜鸟');
    ok('搜名字能中', inst.data.list.length === 1 && inst.data.list[0].id === 'p1', inst.data.list);

    type(inst, '求真楼');
    ok('搜地址能中', inst.data.list.length === 1 && inst.data.list[0].id === 'p2', inst.data.list);

    type(inst, '研讨间');
    ok('搜简介能中', inst.data.list.length === 1 && inst.data.list[0].id === 'p3', inst.data.list);

    type(inst, '食堂');
    ok('搜分类能把这一类都找出来',
      inst.data.list.length === 1 && inst.data.list[0].category === '食堂', inst.data.list);

    type(inst, '');
    ok('清空后恢复全量', inst.data.list.length === 4, inst.data.list.length);
  }

  /* ---- 多词是「且」，且忽略空格差异 ---- */
  {
    const pkg = loadPlaces();
    const inst = fresh(pkg);
    inst.onLoad({});
    await tick();

    // 名字里是「2 号教学楼」（数字和「号」之间有空格），
    // 同学多半直接敲「2号教学楼」—— 去掉空格再比一次才搜得到
    type(inst, '2号教学楼');
    ok('「2号教学楼」能找到「2 号教学楼」', inst.data.list.length === 1 && inst.data.list[0].id === 'p2', inst.data.list);

    type(inst, '2号 教学楼');
    ok('中间敲了空格也能中', inst.data.list.length === 1 && inst.data.list[0].id === 'p2', inst.data.list);

    type(inst, '2号 操场');
    ok('两个词都要有，凑不上的就不出', inst.data.list.length === 0, inst.data.list);

    type(inst, '图书馆 library');
    ok('英文不区分大小写', inst.data.list.length === 1 && inst.data.list[0].id === 'p3', inst.data.list);

    // 模糊搜索：少字 / 错字 / 乱序也要有结果
    type(inst, '图书管');
    ok('错一个字也能搜到图书馆', inst.data.list.length === 1 && inst.data.list[0].id === 'p3', inst.data.list);
    type(inst, '图馆');
    ok('少一个字也能搜到图书馆', inst.data.list.length === 1 && inst.data.list[0].id === 'p3', inst.data.list);
    type(inst, '2号教楼');
    ok('少一个字也能搜到 2 号教学楼', inst.data.list.length === 1 && inst.data.list[0].id === 'p2', inst.data.list);
    type(inst, '2号教学楼在哪');
    ok('带「在哪」也能搜到', inst.data.list.length === 1 && inst.data.list[0].id === 'p2', inst.data.list);
    const ps = loadPlaceSearch();
    ok('「二教」只命中 B 教学楼，不把 A 教学楼捞进来',
      ps.matchPlace({ name: 'B 教学楼' }, '二教') && !ps.matchPlace({ name: 'A 教学楼' }, '二教'));
  }

  /* ---- 搜索跨分类，点分类即退出搜索 ---- */
  {
    const pkg = loadPlaces();
    const inst = fresh(pkg);
    inst.onLoad({});
    await tick();

    // 先切到「食堂」，再搜教学楼。
    // 若搜索被分类卡住，这里就是「明明有，却一条都搜不到」
    inst.onCategory({ currentTarget: { dataset: { c: '食堂' } } });
    await tick();
    type(inst, '教学楼');
    ok('搜的时候不被当前分类卡住', inst.data.list.length === 2, inst.data.list);
    ok('搜出来的确实是那一类',
      inst.data.list.every((p) => p.category === '教学楼'), inst.data.list);

    // 没搜到时地图不该跟着空掉：那只是「这次没找到」
    type(inst, '不存在的楼');
    ok('没搜到时列表是空的', inst.data.list.length === 0, inst.data.list.length);
    ok('没搜到时地图还在（hasAny 不跟着变）', inst.data.hasAny === true);
    // 回落点是「全量第一条」（30.30），不是 0,0 ——
    // 真落到 0,0 的话地图会甩到几内亚湾，比空掉还糟
    ok('没搜到时地图中心回落到全量第一条，不会跳到 0,0',
      inst.data.mapCenter.latitude === 30.30 && inst.data.mapCenter.longitude === 120.10,
      inst.data.mapCenter);

    // 点分类 = 回到按分类浏览，搜索词要一起清掉
    inst.onCategory({ currentTarget: { dataset: { c: '快递' } } });
    await tick();
    ok('点分类会清掉搜索词', inst.data.keyword === '' && inst.data.hasKeyword === false);
    ok('清掉之后按分类出结果',
      inst.data.list.length === 1 && inst.data.list[0].category === '快递', inst.data.list);
  }

  /* ---- 标记跟着结果走；点「搜索」收键盘并滚到列表 ---- */
  {
    const pkg = loadPlaces();
    const inst = fresh(pkg);
    inst.onLoad({});
    await tick();
    ok('标记覆盖全部四条', inst.data.markers.length === 4, inst.data.markers.length);

    type(inst, '教学楼');
    ok('过滤后标记只剩两条', inst.data.markers.length === 2, inst.data.markers.length);
    ok('标记带的是过滤后的名字',
      inst.data.markers.some((m) => m.name === '2 号教学楼'), inst.data.markers);

    inst.onSearchConfirm();
    ok('点键盘上的「搜索」会收起键盘', pkg.hideKeyboardCalls.length === 1, pkg.hideKeyboardCalls);
    await new Promise((r) => setTimeout(r, 30));
    ok('收完键盘把列表滚到眼前', pkg.scrollCalls.length === 1, pkg.scrollCalls);
  }

  /* ---- 卡片上的 catIcon 还在（装饰不能因为改了过滤就丢） ---- */
  {
    const pkg = loadPlaces();
    const inst = fresh(pkg);
    inst.onLoad({});
    await tick();
    type(inst, '教学楼');
    ok('过滤后的卡片照样带 catIcon',
      inst.data.list.every((p) => typeof p.catIcon === 'string'), inst.data.list);
    ok('教学楼用的是毕业帽图标',
      inst.data.list[0].catIcon === 'graduation-cap', inst.data.list[0].catIcon);
  }

  /* ================= 校园页「地点地图」那一档 =================
     同一个搜索框在两处出现，最容易出的问题不是「坏了一个」，
     而是「两边慢慢长得不一样」—— 所以这里把同一组行为在校园页再跑一遍。
     任何一边单独改了口径，这条线会红。 */

  function loadCampus() {
    let page = null;
    let listCalls = 0;
    const listArgs = [];
    const hidden = [];
    const sandbox = Object.assign({}, BASE_GLOBALS, {
      Page: (def) => { page = def; },
      wx: {
        hideKeyboard: (o) => { hidden.push(o || {}); },
        getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
        showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {},
        getSystemInfoSync: () => ({ platform: 'devtools', windowHeight: 667 }),
        getWindowInfo: () => ({ windowHeight: 667 })
      },
      require: (p) => {
        if (/utils\/place-search/.test(p)) return loadPlaceSearch();
        if (/utils\/user/.test(p)) {
          return {
            placeList: (c) => { listCalls += 1; listArgs.push(c); return Promise.resolve(FIX); },
            calendarList: () => Promise.resolve([]),
            eventSync: () => Promise.resolve({ ok: true })
          };
        }
        if (/utils\/event/.test(p)) {
          return {
            getEvents: () => [], fetchEvents: () => Promise.resolve(0),
            fetchState: () => ({ ok: true }), typeIcon: () => 'sparkles',
            typeLabel: () => '其他', nowText: () => ''
          };
        }
        if (/utils\/nav/.test(p)) return { go: () => true };
        if (/utils\/store/.test(p)) return { isFavorited: () => false, toggleFavorite: () => ({ ok: true }) };
        if (/utils\/pager/.test(p)) return {};
        if (/utils\/report/.test(p)) return { report: () => Promise.resolve(true), reportIfCloud: () => Promise.resolve(true) };
        return {};
      }
    });
    vm.createContext(sandbox);
    vm.runInContext(readProj('pages/campus/campus.js'), sandbox, { filename: 'campus.js' });
    return {
      page: page,
      allArgs: listArgs,
      count: () => listCalls,
      hiddenCalls: hidden
    };
  }

  {
    const pkg = loadCampus();
    const inst = Object.assign({}, pkg.page);
    inst.data = JSON.parse(JSON.stringify(pkg.page.data));
    inst.setData = function (d) { Object.assign(this.data, d); };

    await inst.loadPlaces();
    ok('校园页一次拉全量（分类不在云端过滤）', pkg.allArgs[0] === '', pkg.allArgs);
    ok('校园页进来四条都在', inst.data.placeList.length === 4, inst.data.placeList.length);

    // 切分类：本地过滤，不再打请求
    const before = pkg.count();
    inst.onPlaceCat({ currentTarget: { dataset: { c: '食堂' } } });
    ok('校园页切分类不再发请求', pkg.count() === before, pkg.count());
    ok('校园页切到食堂只剩一条',
      inst.data.placeList.length === 1 && inst.data.placeList[0].name === '清风食堂', inst.data.placeList);

    // 搜索跨分类：正停在「食堂」，搜教学楼也该出来
    inst.onPlaceKeyword({ detail: { value: '教学楼' } });
    ok('校园页搜索同样跨分类', inst.data.placeList.length === 2, inst.data.placeList);
    ok('校园页搜出来的是那一类',
      inst.data.placeList.every((p) => p.category === '教学楼'), inst.data.placeList);

    // 空格差异和地址字段：跟完整页同一份实现，这里抽两条抽查
    inst.onPlaceKeyword({ detail: { value: '2号' } });
    ok('校园页也认「2号」这种写法', inst.data.placeList.length === 1, inst.data.placeList);
    inst.onPlaceKeyword({ detail: { value: '求真楼' } });
    ok('校园页也能按地址搜', inst.data.placeList.length === 1, inst.data.placeList);

    // 点分类 = 退出搜索
    inst.onPlaceCat({ currentTarget: { dataset: { c: '快递' } } });
    ok('校园页点分类会清掉搜索词',
      inst.data.placeKeyword === '' && inst.data.hasPlaceKeyword === false);
    ok('校园页清词后按分类出结果',
      inst.data.placeList.length === 1 && inst.data.placeList[0].category === '快递', inst.data.placeList);

    // 清空按钮
    inst.onPlaceKeyword({ detail: { value: '菜鸟' } });
    ok('校园页搜「菜鸟」剩一条', inst.data.placeList.length === 1);
    inst.onPlaceKeywordClear();
    // 清空不是「显示全部」，是回到当前分类该有的样子（这一档停在「快递」）
    ok('校园页清空后回到当前分类的结果',
      inst.data.placeList.length === 1 && inst.data.placeList[0].category === '快递', inst.data.placeList);
    ok('校园页清空后不再是搜索态', inst.data.hasPlaceKeyword === false);

    // 键盘上的「搜索」：收起键盘就好，这一档列表就在下面，不用滚
    inst.onPlaceSearchConfirm();
    ok('校园页点「搜索」会收起键盘', pkg.hiddenCalls.length === 1, pkg.hiddenCalls.length);
  }

  console.log('');
  if (fails.length) {
    console.log('  失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.log('   ✗ ' + f));
    console.log('\n  通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
    process.exit(1);
  }
  console.log('  通过 ' + pass + ' 项，失败 0 项');
})();
