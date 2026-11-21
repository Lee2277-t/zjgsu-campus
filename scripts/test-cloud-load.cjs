// scripts/test-cloud-load.cjs —— 拆分后的云函数模块必须能在无云环境加载并真实走通举报
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const INDEX = path.join(PROJ, 'cloudfunctions', 'user', 'index.js');
const oldLoad = Module._load;
const oldExt = Module._extensions['.js'];

let failDb = true;
const command = {
  neq: (v) => ({ op: 'neq', v }),
  gte: (v) => ({ op: 'gte', v }),
  lte: (v) => ({ op: 'lte', v }),
  in: (v) => ({ op: 'in', v }),
  nin: (v) => ({ op: 'nin', v })
};
function query(col) {
  return {
    where() { return this; },
    limit() { return this; },
    skip() { return this; },
    orderBy() { return this; },
    get() {
      return Promise.resolve({
        data: col === 'reviews'
          ? [{ _id: 'r1', id: 'r1', openid: 'peer-openid', title: '测试评价', content: '测试正文', board: '课程评价' }]
          : []
      });
    },
    count() { return Promise.resolve({ total: 0 }); },
    update() { return Promise.resolve({ stats: { updated: 1 } }); },
    remove() { return Promise.resolve({ stats: { removed: 1 } }); }
  };
}
function collection(col) {
  if (failDb) throw new Error('unexpected db access during load');
  return {
    where() { return query(col); },
    limit() { return query(col); },
    skip() { return query(col); },
    orderBy() { return query(col); },
    get() { return query(col).get(); },
    count() { return query(col).count(); },
    add() { return Promise.resolve({ _id: 'fake-report' }); },
    doc() {
      return {
        get() { return Promise.resolve({ data: col === 'app_config' ? {} : null }); },
        set() { return Promise.resolve({}); },
        update() { return Promise.resolve({ stats: { updated: 1 } }); },
        remove() { return Promise.resolve({ stats: { removed: 1 } }); }
      };
    }
  };
}
const db = { collection: collection, command: command };
const cloud = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init() {},
  database() { return db; },
  getWXContext() { return { OPENID: 'test-openid' }; },
  openapi: {}
};
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloud;
  return oldLoad.call(this, request, parent, isMain);
};
Module._extensions['.js'] = function (mod, filename) {
  if (path.resolve(filename).startsWith(path.resolve(PROJ))) {
    return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  }
  return oldExt(mod, filename);
};

(async () => {
  try {
    const fn = require(INDEX);
    if (!fn || typeof fn.main !== 'function') throw new Error('exports.main missing');

    const r = await fn.main({ action: 'checkText', title: 'hello' });
    if (!r || r.ok !== true) throw new Error('router checkText failed: ' + JSON.stringify(r));

    // 真实走一遍举报：如果 hideNeed / countVoices / groupReports 等依赖没注入，
    // 这里会直接 ReferenceError，不能只靠静态正则。
    failDb = false;
    const reported = await fn.main({
      action: 'report', targetType: 'review', targetId: 'r1',
      targetOpenid: 'peer-openid', reason: '虚假信息', detail: '测试举报'
    });
    if (!reported || reported.ok !== true || !/举报已收到/.test(String(reported.msg || ''))) {
      throw new Error('report path failed: ' + JSON.stringify(reported));
    }
    console.log('云函数拆分模块加载、异步兜底与举报链路通过');
  } catch (e) {
    console.error(e.stack || e);
    process.exitCode = 1;
  } finally {
    Module._load = oldLoad;
    Module._extensions['.js'] = oldExt;
  }
})();
