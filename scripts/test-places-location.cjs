// scripts/test-places-location.cjs —— 校园地点的「位置权限」链路
//
// 起因（2026-10-18）：真机打开「校园地点」页，微信直接弹一个白框
//   「需要在 app.json 中声明 permission scope.userLocation 字段」
// 卡在那里既加不了地点，也点不了「在地图上选位置」——因为授权框压根弹不出来。
//
// 这份测试钉四件事：
//   1. app.json 里既有 requiredPrivateInfos（管「能不能调用」），
//      也有 permission.scope.userLocation.desc（管「弹窗说什么」），两样缺一不可；
//   2. 地图的 show-location 不再写死 —— 一渲染就要权限，等于用户没点任何东西就被弹框；
//   3. 静默查授权用 getSetting（不弹框），只有已授权的人才显示定位点；
//   4. 工程侧漏声明的报错要译成「暂不可用，请联系管理员」，
//      不能译成「去微信设置里开一下」——那是让用户去修工程的 bug。

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

/* ---------------- 一、app.json 的两处声明 ---------------- */

const APP_JSON = JSON.parse(readProj('app.json'));
const perm = (APP_JSON.permission || {})['scope.userLocation'] || {};
const rpi = APP_JSON.requiredPrivateInfos || [];

ok('app.json 能正常解析（没写注释）', !!APP_JSON);
ok('requiredPrivateInfos 里有 chooseLocation', rpi.indexOf('chooseLocation') >= 0, rpi);
ok('permission.scope.userLocation.desc 存在', typeof perm.desc === 'string' && perm.desc.length > 0, perm);
ok('desc 写的是具体用途（不是「提升用户体验」这种空话）',
  /位置/.test(perm.desc || '') && /地图/.test(perm.desc || ''), perm.desc);
ok('desc 长度够（10~60 字，弹窗里看得清也不被截断）',
  (perm.desc || '').length >= 10 && (perm.desc || '').length <= 60, (perm.desc || '').length);
// 互斥：这两个同时声明会直接报错，本工程只用 chooseLocation 选点
ok('没有同时声明互斥的 getLocation / getFuzzyLocation',
  !(rpi.indexOf('getLocation') >= 0 && rpi.indexOf('getFuzzyLocation') >= 0), rpi);

/* ---------------- 二、wxml 里不再写死 show-location ---------------- */

const PLACES_WXML = readProj('pages/tool/places/places.wxml');
const mapTag = (() => {
  const i = PLACES_WXML.indexOf('<map');
  const j = PLACES_WXML.indexOf('>', i);
  return i < 0 ? '' : PLACES_WXML.slice(i, j + 1);
})();
ok('地点页有 map 组件', mapTag !== '');
ok('show-location 绑到变量，不是裸属性', /show-location="\{\{showLoc\}\}"/.test(mapTag), mapTag);
ok('没有留下裸的 show-location（写死 true 等于一进页面就要权限）',
  !/show-location(\s|>|\/)/.test(mapTag.replace(/show-location="[^"]*"/g, '')), mapTag);

/* ---------------- 三、真跑 places.js，看它怎么用权限 ---------------- */

function loadPlaces(setting) {
  let page = null;
  const calls = { toast: [], getSetting: 0, chooseLocation: 0, getLocation: 0, authorize: 0, modal: [] };
  let chooseResult = null; // 由用例设置：{ ok:true, res } / { ok:false, errMsg }
  const sandbox = {
    console, Date, Number, String, Array, Object, JSON, Math, RegExp, Promise,
    setTimeout, clearTimeout, isNaN, parseInt, parseFloat,
    Page: (def) => { page = def; },
    wx: {
      getSetting: (o) => {
        calls.getSetting += 1;
        if (o && o.success) o.success(setting);
      },
      getLocation: () => { calls.getLocation += 1; },
      authorize: () => { calls.authorize += 1; },
      chooseLocation: (o) => {
        calls.chooseLocation += 1;
        if (!chooseResult) return;
        if (chooseResult.ok) { if (o && o.success) o.success(chooseResult.res); }
        else if (o && o.fail) o.fail({ errMsg: chooseResult.errMsg });
      },
      showToast: (o) => { calls.toast.push(o || {}); },
      showModal: (o) => { calls.modal.push(o || {}); },
      showLoading: () => {}, hideLoading: () => {},
      openLocation: () => {}, makePhoneCall: () => {},
      navigateBack: () => {},
      pageScrollTo: () => {},
      createSelectorQuery: () => {
        const q = {};
        q.select = () => q; q.boundingClientRect = () => q;
        q.selectViewport = () => q; q.scrollOffset = () => q;
        q.exec = (cb) => cb([{ top: 420 }, { scrollTop: 0 }]);
        return q;
      },
      setStorageSync: () => {}, getStorageSync: () => ''
    },
    require: (p) => {
      if (/utils\/user/.test(p)) {
        return {
          placeList: () => Promise.resolve([]),
          placeAdd: () => Promise.resolve({ ok: true }),
          placeRemove: () => Promise.resolve({ ok: true })
        };
      }
      // 地点页的过滤口径来自这个模块；缺了它 load() 会在异步里炸，
      // 而且是在所有断言跑完之后才炸，看上去像「测试莫名红」
      if (/utils\/place-search/.test(p)) {
        const mod = { exports: {} };
        const searchMod = { exports: {} };
        new Function('module', 'exports', fs.readFileSync(path.resolve(PROJ, 'utils', 'search.js'), 'utf8'))(searchMod, searchMod.exports);
        new Function('module', 'exports', 'require', fs.readFileSync(path.resolve(PROJ, 'utils', 'place-search.js'), 'utf8'))(
          mod, mod.exports, (x) => (/search\.js/.test(x) ? searchMod.exports : {})
        );
        return mod.exports;
      }
      return {};
    }
  };
  sandbox.setChooseResult = (v) => { chooseResult = v; };
  vm.createContext(sandbox);
  vm.runInContext(readProj('pages/tool/places/places.js'), sandbox, { filename: 'places.js' });

  const inst = Object.assign({}, page);
  inst.data = JSON.parse(JSON.stringify(page.data));
  inst.setData = function (d) { Object.assign(this.data, d); };
  // 让用例能在「加载后」再改选点结果（pickLocation 是后面才调的）
  sandbox.setChooseResult(null);
  return { inst: inst, calls: calls, setChoose: (v) => sandbox.setChooseResult(v) };
}

(async () => {
  {
    // 从没给过位置权限：不显示定位点，也不许为了判断去调定位接口
    const { inst, calls } = loadPlaces({ authSetting: {} });
    inst.onLoad({});
    await Promise.resolve();
    ok('没授权时默认不显示定位点', inst.data.showLoc === false, inst.data.showLoc);
    ok('用 getSetting 静默查（不弹框）', calls.getSetting === 1, calls.getSetting);
    ok('没有偷偷调 getLocation', calls.getLocation === 0, calls.getLocation);
    ok('没有擅自调 authorize（那会弹授权框）', calls.authorize === 0, calls.authorize);
    ok('没有弹任何框', calls.toast.length === 0 && calls.modal.length === 0);
  }

  {
    // 之前授过（比如别处选过点）：直接显示，用户不会被再问一次
    const { inst } = loadPlaces({ authSetting: { 'scope.userLocation': true } });
    inst.onLoad({});
    await Promise.resolve();
    ok('已授权时显示定位点', inst.data.showLoc === true);
  }

  {
    // 在地图上选点成功：坐标入表单，同时把定位点打开
    const { inst, calls, setChoose } = loadPlaces({ authSetting: {} });
    inst.onLoad({});
    await Promise.resolve();
    setChoose({ ok: true, res: { latitude: 30.31, longitude: 120.35, address: '浙江省杭州市钱塘区学正街18号', name: '浙江工商大学' } });
    inst.pickLocation();
    ok('选点成功：纬度进了表单', inst.data.form.latitude === 30.31, inst.data.form.latitude);
    ok('选点成功：地址进了表单', inst.data.form.address.indexOf('学正街') >= 0, inst.data.form.address);
    ok('选点成功：名字用了地图给的', inst.data.form.name === '浙江工商大学', inst.data.form.name);
    ok('选点成功：定位点顺手打开（他刚表达过要用位置）', inst.data.showLoc === true);
    ok('选点成功不打扰', calls.toast.length === 0);
  }

  {
    // 工程侧漏声明（就是截图那个错）：提示必须是「暂不可用，联系管理员」
    const { inst, calls, setChoose } = loadPlaces({ authSetting: {} });
    inst.onLoad({});
    setChoose({ ok: false, errMsg: 'chooseLocation:fail 需要在 app.json 中声明 permission scope.userLocation 字段' });
    inst.pickLocation();
    const msg = (calls.toast[0] && calls.toast[0].title) || '';
    ok('漏声明时给的是「暂不可用」类提示', /暂不可用/.test(msg), msg);
    ok('不把工程 bug 说成用户没给权限', !/微信设置/.test(msg), msg);
  }

  {
    // 用户自己拒绝 / 取消：取消不打扰，拒绝要能看出是权限问题
    const { inst, calls, setChoose } = loadPlaces({ authSetting: { 'scope.userLocation': false } });
    inst.onLoad({});
    setChoose({ ok: false, errMsg: 'chooseLocation:fail cancel' });
    inst.pickLocation();
    ok('用户主动取消时不弹提示', calls.toast.length === 0, calls.toast);

    setChoose({ ok: false, errMsg: 'chooseLocation:fail auth deny' });
    inst.pickLocation();
    const msg = (calls.toast[0] && calls.toast[0].title) || '';
    ok('拒绝权限时提示去设置里开', /微信设置/.test(msg), msg);
  }

  console.log('\n  通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) {
    fails.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
})();
