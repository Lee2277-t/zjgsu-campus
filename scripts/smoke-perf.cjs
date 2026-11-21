/**
 * 冒烟：性能专项新增的三块逻辑
 *   1. utils/perf.js    —— throttle 的「首次立刻 + 末尾补一次（用最新参数）」与缓存淘汰
 *   2. utils/market.js  —— 内存缓存层（避免每次切分类都把整份 JSON 反序列化一遍）
 *   3. utils/upload.js  —— uploadMany 的并发上限 / 顺序保持 / 保底回调 / 进度单调 / 按需压缩
 *
 * 用法：node scripts/smoke-perf.cjs
 *
 * ⚠️ 上级 recon/package.json 是 "type":"module"，直接 require(项目里的 .js) 会被当
 *    ESM 报 "module is not defined"，所以这里手动搭 CommonJS 壳执行文件内容。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram', 'zjgsu-campus');

function loadFile(abs, wxStub) {
  const code = fs.readFileSync(abs, 'utf8');
  const module = { exports: {} };
  const dir = path.dirname(abs);
  const req = (p) => (p.startsWith('.') ? loadFile(path.resolve(dir, p), wxStub) : {});
  // 只注入小程序环境里「本来就有」的几个名字；Date / setTimeout 等交给宿主全局，
  // 别在参数里同名遮蔽（否则函数体里拿到的会是 undefined）
  const fn = new Function('module', 'exports', 'wx', 'require', 'console', code);
  fn(module, module.exports, wxStub, req, console);
  return module.exports;
}

let all = true;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) all = false;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + ' => ' + JSON.stringify(got) + (ok ? '' : ' (期望 ' + JSON.stringify(want) + ')'));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ 1. perf.throttle ============ */
async function testThrottle() {
  const perf = loadFile(path.join(ROOT, 'utils', 'perf.js'), {});
  const calls = [];
  const fn = perf.throttle(function (tag) { calls.push(tag); }, 120);

  fn('A');            // 首次：立刻执行
  eq('1.1 首次立刻执行', calls.slice(), ['A']);
  fn('B');            // 间隔内：排一个补跑
  fn('C');            // 再触发：用最新参数覆盖补跑
  eq('1.2 间隔内不立刻执行', calls.slice(), ['A']);
  await sleep(200);   // 等补跑
  eq('1.3 补跑用最新参数（连点 A→B→C 落在 C）', calls.slice(), ['A', 'C']);
  await sleep(150);   // 补跑本身也刷新了时间起点，再等一个间隔
  fn('D');            // 间隔已过：立刻执行
  eq('1.4 间隔过后立刻执行', calls.slice(), ['A', 'C', 'D']);
}

/* ============ 2. perf.createCache ============ */
function testCache() {
  const perf = loadFile(path.join(ROOT, 'utils', 'perf.js'), {});
  const c = perf.createCache(4);
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  eq('2.1 取得到', c.get('a'), 1);
  eq('2.2 没有的键', c.get('zzz'), undefined);
  c.set('d', 4); c.set('e', 5); c.set('f', 6); // 超过上限 4 → 淘汰最久没用的
  eq('2.3 超限后条数不失控', c.size() <= 4, true);
  eq('2.4 有 has', c.has('f'), true);
  c.clear();
  eq('2.5 clear 清空', c.size(), 0);
}

/* ============ 3. market 内存缓存 ============ */
function testMarketCache() {
  let reads = 0;
  const backing = { zjgsu_market: [{ id: 'm1', type: 'sell', at: 2, category: 'book' }, { id: 'm2', type: 'lost', at: 1 }] };
  const wxStub = {
    getStorageSync: (k) => { reads += 1; return backing[k]; },
    setStorageSync: (k, v) => { backing[k] = v; },
    getStorageSyncRaw: true,
  };
  const market = loadFile(path.join(ROOT, 'utils', 'market.js'), wxStub);

  const first = market.getMarkets('sell');
  reads = 0;
  market.getMarkets('sell');
  market.getMarkets('lost');
  market.searchMarkets('sell', '书', false);
  eq('3.1 后续读取不再碰 storage（内存命中）', reads, 0);
  eq('3.2 过滤结果正确', first.length, 1);

  market.invalidate();
  market.getMarkets('sell');
  eq('3.3 作废后重新读一次 storage', reads, 1);

  // 分类筛选仍然只对 sell 生效
  const sell = market.getMarkets('sell');
  eq('3.4 filterByCategory', market.filterByCategory(sell, 'book').length, 1);
  eq('3.5 filterByCategory 全部', market.filterByCategory(sell, 'all').length, 1);
}

/* ============ 4. upload.uploadMany ============ */
async function testUploadMany() {
  let running = 0;
  let maxRunning = 0;
  const uploaded = [];
  const sizes = { a: 1024 * 1024, b: 2 * 1024, c: 900 * 1024, d: 5 * 1024, e: 700 * 1024 };

  const wxStub = {
    cloud: {
      init: () => {},
      database: () => ({}),
      uploadFile: (opt) => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        const delay = 20;
        setTimeout(() => {
          running -= 1;
          uploaded.push(opt.filePath);
          // 第二张故意失败，验证保底回调
          if (opt.filePath.indexOf('b.jpg') >= 0) {
            if (opt.fail) opt.fail({ errMsg: 'uploadFile:fail boom' });
          } else if (opt.success) {
            opt.success({ fileID: 'cloud://' + opt.filePath });
          }
        }, delay);
        return { then: () => ({ catch: () => {} }) };
      }
    },
    getFileSystemManager: () => ({
      getFileInfo: (opt) => {
        const name = String(opt.filePath).split('/').pop();
        const key = name.split('.')[0];
        let size = sizes[key] || 0;
        // 压缩产物体积砍半：不这样的话「压完没变小」分支会命中，测不到压缩路径
        if (name.indexOf('.compressed') >= 0) size = Math.floor(size / 2);
        if (opt.success) opt.success({ size: size });
      }
    }),
    compressImage: (opt) => {
      if (opt.success) opt.success({ tempFilePath: opt.src + '.compressed' });
    }
  };

  const upload = loadFile(path.join(ROOT, 'utils', 'upload.js'), wxStub);

  const progress = [];
  const fallbacks = [];
  const files = ['/tmp/a.jpg', '/tmp/b.jpg', '/tmp/c.jpg', '/tmp/d.jpg', '/tmp/e.jpg'];
  const r = await upload.uploadMany(files, {
    prefix: 'forum',
    onProgress: (p) => progress.push(p),
    fallback: async (f, i) => { fallbacks.push(i); return 'local://' + i; }
  });

  eq('4.1 并发不超过 3', maxRunning <= 3, true);
  eq('4.2 并发确实拉起来了（不是串行）', maxRunning >= 2, true);
  eq('4.3 顺序与入参一致', r.list.map((x) => (String(x).indexOf('local://') === 0 ? 'F' : String(x).replace('cloud:///tmp/', '').replace('.compressed', ''))), ['a.jpg', 'F', 'c.jpg', 'd.jpg', 'e.jpg']);
  eq('4.4 失败的那张走了保底', fallbacks, [1]);
  // ok = 「拿到了可用结果」的张数（含保底存下来的本地路径），failed = 连保底都没救回来的
  eq('4.5 可用结果数（含保底）', r.ok.length, 5);
  eq('4.6 保底救回来后不算失败', r.failed, 0);
  // 云端路径的扩展名必须按原始文件算，不能是压缩产物的 'compressed'
  const cloudPaths = uploaded.filter((x) => x.indexOf('/tmp/') === 0);
  eq('4.6b 大图传的是压缩产物', cloudPaths.filter((x) => x.indexOf('a.jpg.compressed') >= 0).length, 1);
  const firstRun = uploaded.slice(); // 后面还要再跑一次，先把这一轮的上传清单定格
  const r2 = await upload.uploadMany(['/tmp/b.jpg'], { prefix: 'forum' }); // 这张必失败且无保底
  eq('4.6c 无保底时如实计失败', r2.failed, 1);
  eq('4.6d 无保底时该位置是空串', r2.list, ['']);
  eq('4.7 进度收尾到 100', progress[progress.length - 1], 100);
  let mono = true;
  for (let i = 1; i < progress.length; i += 1) if (progress[i] < progress[i - 1]) mono = false;
  eq('4.8 进度单调不回退', mono, true);

  // 大图（>300KB）走压缩，小图（b=2KB、d=5KB）原样传
  eq('4.9 大图被压缩后上传', firstRun.filter((x) => x.indexOf('a.jpg.compressed') >= 0).length, 1);
  eq('4.10 小图原样上传（b、d 都没被压缩）', firstRun.filter((x) => x === '/tmp/b.jpg' || x === '/tmp/d.jpg').length, 2);
  eq('4.11 压完确实变小才采用（900KB 的 c 也压了）', firstRun.filter((x) => x.indexOf('c.jpg.compressed') >= 0).length, 1);
}

/* ============ 5. 隐私授权门：不再让用户白等 ============ */
async function testPrivacyGate() {
  const log = { probe: 0, authorize: 0, toasts: [] };
  let need = false;
  let mode = 'success'; // success | hang | failPrivacy | failOther

  const stub = {
    showToast: (o) => log.toasts.push(o.title),
    getPrivacySetting: (o) => {
      log.probe += 1;
      if (o && o.success) o.success({ needAuthorization: need });
    },
    requirePrivacyAuthorize: (o) => {
      log.authorize += 1;
      if (mode === 'success' && o.success) o.success({});
      else if (mode === 'failPrivacy' && o.fail) {
        o.fail({ errMsg: 'requirePrivacyAuthorize:fail privacy permission is unauthorized' });
      } else if (mode === 'failOther' && o.fail) {
        o.fail({ errMsg: 'requirePrivacyAuthorize:fail not support' });
      }
      // mode === 'hang'：什么都不回调，模拟后台隐私指引没配好时的永久挂起
    }
  };
  const fresh = () => loadFile(path.join(ROOT, 'utils', 'upload.js'), stub);

  // 场景 A：本来就不需要授权（绝大多数用户走这条）
  need = false; mode = 'success';
  eq('5.1 不需要授权时放行', await fresh().ensurePrivacy(), true);
  eq('5.2 不需要授权时不弹授权窗', log.authorize, 0);
  eq('5.3 只探测了一次', log.probe, 1);

  // 场景 B：确认过一次后要缓存，别每次点「加图」都问一遍
  // （第一次那次探测 unavoidable，测的是「之后」不再重复问）
  const up1 = fresh();
  await up1.ensurePrivacy();
  log.probe = 0; log.authorize = 0;
  await up1.ensurePrivacy();
  await up1.ensurePrivacy();
  await up1.ensurePrivacy();
  eq('5.4 授权结果被缓存（后续零探测）', log.probe, 0);
  eq('5.5 授权结果被缓存（后续零弹窗）', log.authorize, 0);

  // 场景 C：确实需要授权，用户同意
  log.probe = 0; log.authorize = 0;
  need = true; mode = 'success';
  const up2 = fresh();
  eq('5.6 需要授权且用户同意', await up2.ensurePrivacy(), true);
  eq('5.7 确实走了授权接口', log.authorize, 1);
  await up2.ensurePrivacy();
  eq('5.8 同意后不再重复弹', log.authorize, 1);

  // 场景 D：授权接口永久挂起（后台隐私指引漏勾时的真实表现）
  // 旧实现在这里会让用户白等 8 秒；现在必须在 3 秒级放行
  log.toasts = [];
  need = true; mode = 'hang';
  const t0 = Date.now();
  const okHang = await fresh().ensurePrivacy();
  const cost = Date.now() - t0;
  eq('5.9 授权无响应时放行（不把用户晾着）', okHang, true);
  eq('5.10 等待压到 3 秒级（原为 8 秒）', cost < 4000, true);
  // 提示现在走反馈层，是隔一帧（30ms）才弹的，断言前给它这点时间
  await sleep(80);
  eq('5.11 给出可读提示', log.toasts.length, 1);

  // 场景 E：明确被拒
  need = true; mode = 'failPrivacy';
  eq('5.12 明确被拒时如实返回 false', await fresh().ensurePrivacy(), false);

  // 场景 F：与隐私无关的失败（老基础库不支持）= 本来就不拦
  need = true; mode = 'failOther';
  eq('5.13 与隐私无关的失败视为不拦', await fresh().ensurePrivacy(), true);

  // 场景 G：老版本根本没有这些接口
  eq('5.14 老基础库直接放行', await loadFile(path.join(ROOT, 'utils', 'upload.js'), {}).ensurePrivacy(), true);
}

/* ============ 6. 压缩：降分辨率 + 预热不重复压 ============ */
async function testCompress() {
  const sizes = { big: 3 * 1024 * 1024, tall: 3 * 1024 * 1024, small: 2 * 1024, tiny: 400 * 1024 };
  const dims = {
    big: { width: 4000, height: 3000 },
    tall: { width: 3000, height: 4000 },
    tiny: { width: 800, height: 600 }
  };
  let calls = [];

  const stub = {
    getFileSystemManager: () => ({
      getFileInfo: (opt) => {
        const name = String(opt.filePath).split('/').pop();
        const key = name.split('.')[0];
        let size = sizes[key] || 0;
        if (name.indexOf('.compressed') >= 0) size = Math.floor(size / 4);
        if (opt.success) opt.success({ size: size });
      }
    }),
    getImageInfo: (opt) => {
      const key = String(opt.src).split('/').pop().split('.')[0];
      if (dims[key] && opt.success) opt.success(dims[key]);
      else if (opt.fail) opt.fail({ errMsg: 'getImageInfo:fail' });
    },
    compressImage: (opt) => {
      calls.push({ src: opt.src, quality: opt.quality, w: opt.compressedWidth, h: opt.compressedHeight });
      if (opt.success) opt.success({ tempFilePath: opt.src + '.compressed' });
    }
  };
  const up = loadFile(path.join(ROOT, 'utils', 'upload.js'), stub);

  await up.compressIfNeeded('/tmp/big.jpg');
  eq('6.1 大图被压缩', calls.length, 1);
  eq('6.2 横图按长边给宽 1280', calls[0].w, 1280);
  eq('6.3 横图不给高（交给微信等比算）', calls[0].h === undefined, true);

  await up.compressIfNeeded('/tmp/tall.jpg');
  eq('6.4 竖图改为给高 1280', calls[1].h, 1280);
  eq('6.5 竖图不给宽', calls[1].w === undefined, true);

  const small = await up.compressIfNeeded('/tmp/small.jpg');
  eq('6.6 小体积直接不压', small.compressed, false);
  eq('6.7 小体积不调 compressImage', calls.length, 2);

  await up.compressIfNeeded('/tmp/tiny.jpg'); // 400KB 但只有 800×600
  eq('6.8 分辨率未超标时不放大（只压质量）', calls[2].w === undefined && calls[2].h === undefined, true);

  // 预热：同一张图绝不能压两遍
  let calls2 = 0;
  const stub2 = Object.assign({}, stub, {
    compressImage: (opt) => {
      calls2 += 1;
      if (opt.success) opt.success({ tempFilePath: opt.src + '.compressed' });
    }
  });
  const up2 = loadFile(path.join(ROOT, 'utils', 'upload.js'), stub2);
  await up2.prewarm(['/tmp/big.jpg']);
  eq('6.9 预热压了一张', calls2, 1);
  const hit = await up2.compressIfNeeded('/tmp/big.jpg');
  eq('6.10 正式读取命中预热结果', hit.compressed, true);
  eq('6.11 没有重复压缩', calls2, 1);

  // 最刁的情况：预热还没压完，上传那边就来要了 —— 也只允许压一遍
  let calls3 = 0;
  const stub3 = Object.assign({}, stub, {
    compressImage: (opt) => {
      calls3 += 1;
      setTimeout(() => { if (opt.success) opt.success({ tempFilePath: opt.src + '.compressed' }); }, 120);
    }
  });
  const up3 = loadFile(path.join(ROOT, 'utils', 'upload.js'), stub3);
  const p = up3.prewarm(['/tmp/big.jpg']);
  const q = up3.compressIfNeeded('/tmp/big.jpg'); // 此刻预热还在进行中
  const [pw, got] = await Promise.all([p, q]);
  eq('6.12 预热未完成时也只压一遍', calls3, 1);
  eq('6.13 预热报告压缩成功 1 张', pw, 1);
  eq('6.14 排队等到的是同一个压缩结果', got.compressed, true);
}

/* ============ 7. 上传超时按体积动态给 ============ */
function testTimeout() {
  const up = loadFile(path.join(ROOT, 'utils', 'upload.js'), {});
  eq('7.1 空体积按起步 20 秒', up.timeoutFor(0), 20000);
  eq('7.2 1MB 多给 4 秒', up.timeoutFor(1024 * 1024), 24000);
  eq('7.3 15MB 给到 80 秒', up.timeoutFor(15 * 1024 * 1024), 80000);
  eq('7.4 超大文件封顶 90 秒', up.timeoutFor(50 * 1024 * 1024), 90000);
}

(async function main() {
  console.log('--- perf.throttle ---');
  await testThrottle();
  console.log('--- perf.createCache ---');
  testCache();
  console.log('--- market 内存缓存 ---');
  testMarketCache();
  console.log('--- upload.uploadMany ---');
  await testUploadMany();
  console.log('--- 隐私授权门 ---');
  await testPrivacyGate();
  console.log('--- 压缩：降分辨率 + 预热 ---');
  await testCompress();
  console.log('--- 上传超时 ---');
  testTimeout();
  console.log(all ? '\n== 全部通过 ==' : '\n== 有失败项 ==');
  process.exit(all ? 0 : 1);
})();
