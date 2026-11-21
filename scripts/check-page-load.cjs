// 真机模拟加载器：在 Node 里真实 require 页面 js（带 wx/Page 桩），
// 抓「加载期抛错」——这种错误会让整个 Page() 不执行，所有 bindtap 失效，
// 但 hover-class（渲染层）照样生效，表现就是「按下去有变色、之后毫无反应」。
// 开发者工具能跑，往往是因为它解析了某个失败路径或转译差异；真机没这层保护。
const path = require('path');
const fs = require('fs');
const Module = require('module');

// 小程序页面是 CommonJS，但仓库根的 package.json 写了 "type": "module"，
// Node 22 会顺着目录往上找到它、把这些 .js 当 ESM 加载 —— 结果是本脚本恒报
// 「require is not defined in ES module scope」，页面一行都没执行到，检查形同虚设。
// 这里对 miniprogram 下的文件强制走 CommonJS 编译，让本脚本重新真的能验东西。
const MP_ROOT = path.resolve(__dirname, '..', 'miniprogram');
const origJsLoader = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (filename.indexOf(MP_ROOT) === 0) {
    return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  }
  return origJsLoader(mod, filename);
};

const noop = () => {};
function makeWx() {
  const handler = {
    get(t, k) {
      if (k === 'cloud') {
        return {
          init: noop,
          database() {
            const chain = {
              get: () => Promise.resolve({ data: [] }),
              add: () => Promise.resolve({ _id: 'x' }),
              where: () => chain, orderBy: () => chain, limit: () => chain,
              field: () => chain, skip: () => chain,
              doc: () => ({ get: () => Promise.resolve({ data: {} }), update: () => Promise.resolve({}), remove: () => Promise.resolve({}) })
            };
            return { collection: () => chain };
          }
        };
      }
      if (k === 'getStorageSync') return () => ({});
      if (k === 'setStorageSync') return noop;
      if (k === 'getSystemInfoSync' || k === 'getWindowInfo' || k === 'getDeviceInfo') return () => ({});
      if (k === 'getAppBaseInfo' || k === 'getDeviceInfo') return () => ({});
      // 其余 API：不主动触发回调，避免无限递归；返回 undefined 即可
      return () => undefined;
    }
  };
  return new Proxy({}, handler);
}
global.wx = makeWx();
global.getApp = () => ({});
const captured = [];
global.Page = (o) => { captured.push(o); };
global.Component = () => {};
global.App = () => {};
global.getApp = () => ({});

const targets = [
  { name: '发帖页', file: path.resolve(__dirname, '..', 'miniprogram', 'zjgsu-campus', 'sub', 'forum', 'post', 'post.js') },
  { name: '树洞页', file: path.resolve(__dirname, '..', 'miniprogram', 'zjgsu-campus', 'sub', 'forum', 'hole', 'hole.js') }
];

let failed = 0;
for (const t of targets) {
  try {
    captured.length = 0;
    require(t.file);
    const obj = captured[captured.length - 1];
    if (!obj) {
      console.log('❌', t.name, '：Page() 没有被调用（模块未导出页面对象）');
      failed++;
      continue;
    }
    const methods = ['submit', 'send'];
    const miss = methods.filter((m) => !(m in obj) || typeof obj[m] !== 'function');
    // 只关心该页面自己的方法（发帖页看 submit，树洞页看 send）
    const need = t.name === '发帖页' ? ['submit'] : ['send'];
    const missNeed = need.filter((m) => !(m in obj) || typeof obj[m] !== 'function');
    if (missNeed.length) {
      console.log('❌', t.name, '：关键方法缺失或不是函数 ->', missNeed.join(','));
      failed++;
    } else {
      console.log('✅', t.name, '：模块加载成功，', need.join('/'), '已注册为 function');
    }
  } catch (e) {
    failed++;
    console.log('❌', t.name, '：加载期抛错 ->', e && e.message);
    console.log('   错误栈前 6 行：');
    console.log((e && e.stack || '').split('\n').slice(0, 7).join('\n'));
  }
}
console.log(failed ? ('\n有 ' + failed + ' 个页面加载失败') : '\n✅ 两个页面均加载成功，方法均已注册');
process.exit(failed ? 1 : 0);
