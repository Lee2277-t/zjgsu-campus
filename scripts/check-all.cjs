// scripts/check-all.cjs —— 一键跑完所有检查
//
// 之前这些脚本散在 _trash/ 里，每轮功能现写一次、用完就删，
// 下次重构没有回归网。现在全部固化在 scripts/ 下，用这一条命令串起来：
//     npm run check
//
// 分组是为了让人看清楚「到底是哪一类挂了」：
//   static   纯静态分析，秒级，不依赖网络也不依赖云环境
//   behavior 行为测试，跑的是小程序真实源码（Page / utils 都从源文件读）
//   net      真出网（打就业网接口），断网或对方改版时会红，允许单独跳过
//
// 用法：
//   node scripts/check-all.cjs              # 全跑
//   node scripts/check-all.cjs --no-net     # 跳过联网那组
//   node scripts/check-all.cjs --only net   # 只跑某组

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');

const GROUPS = [
  {
    key: 'static',
    name: '静态检查',
    scripts: [
      'run-syncheck.cjs',        // 全量语法体检
      'check-page-load.cjs',
      'check-require-case.cjs',
      'check-store-refs.cjs',
      'check-theme.cjs',         // 深色模式令牌一致性
      'check-ui-scales.cjs',     // 字号 / 圆角 / 间距 / 字重 的尺度合法性
      'check-build-fingerprint.cjs', // 云函数 / 校园页 / 关于页 三处版本号必须对上
      'check-package-size.cjs',      // 主包 < 1.5M / 图片音频 < 200K 两条体积红线
      'check-pull-refresh.cjs',  // 下拉刷新：开了就得接、就得收尾，列表不能被 scroll-view 吞掉手势
      'check-eol.cjs',           // 行尾风格：被整体翻转的话 git diff 会变成整文件重写
      'smoke-flow.cjs',
      'smoke-perf.cjs',
      'smoke-privacy.cjs',
      'smoke-send.cjs',
      'smoke-store.cjs',
      'smoke-system.cjs'
    ]
  },
  {
    key: 'behavior',
    name: '行为测试（跑真实源码）',
    scripts: [
      'test-friend-v2.cjs',      // 好友配额 / 解除好友 / 撤销申请
      'test-chatbox.cjs',        // 私信配额 / 撤回 / 请求箱
      'test-postedit.cjs',       // 帖子编辑的提交与回滚
      'test-pager.cjs',          // 四处列表分页
      'test-jobfav.cjs',         // 收藏招聘会
      'test-byline.cjs',         // 作者 / 评论者头像署名
      'test-campus-jobfair.cjs', // 招聘会展示口径
      'test-report.cjs',         // 客户端错误上报的去重 / 封顶 / 不冒泡
      'test-modqueue.cjs',       // 审核队列 evidence 只吃 URL（修过碎图）
      'test-admin-delete-post.cjs', // 审核员详情页直删：不走举报、失败不跳页、云端失败本地不删
      'test-comment-actions.cjs', // 评论区赞踩 / 举报 / 二级回复（互斥、取消、连点、层级）
      'test-post-votes.cjs',      // 帖子赞踩：一人一格 / 取消 / 云端未回执时不再发第二个请求
      'test-comment-table.cjs',  // 留言拆表 / 软删 / 迁移 / 举报防刷 / 申诉（这一轮改的是存储结构）
      'test-protect-pin.cjs',    // 内容保护只挡自动处置 / 限时置顶到期失效
      'test-market-categories.cjs', // 闲置分类：发布页与筛选栏共用同一份来源，前后端白名单比对
      'test-fix-20261017.cjs',   // tabBar 跳转 / 先云端后本地 / 同步分页 / 通知分页 / 已读回执
      'test-exam-papers.cjs',    // 历年真题：写进 resources 的字段契约 / 检索命中 / 排序 / 云端条数
      'test-batch-upload.cjs',   // 资料批量上传：真跑页面验「选 N 个就是发 N 份」/ 失败留队列
      'test-resource-review.cjs', // 学习资料先审后发：pending 状态 / 审核员队列 / 通过驳回
      'test-teacher-roster.cjs',  // 教师名录：取数必须分页翻过 1000 上限 / 段名别用缩写 / 原始稿格式
      // 内容风控：事前告知 / 事中留痕 / 事后通道与处置必须都在；发帖标题选填的两端口径一致
      'test-content-defense.cjs',
      'test-mine-gate.cjs',      // 「我的」页的管理员专属件必须挂在 isMod 后面（含真跑警示条的走向）
      'test-campus-place-fab.cjs', // 校园页地点那一档的 ➕：add=1 摊表单 / 带分类 / 回来重拉 / 写完退回
      'test-places-location.cjs',  // 地点页位置权限：app.json 两处声明齐全 / 定位点不提前申请权限
      // 地点搜索：四个字段都能搜 / 多词是「且」/ 忽略空格差异 / 有词时跨分类 / 点分类即退出搜索
      'test-places-search.cjs',
      // 举报计票：一个人只算一票（旧版换理由能投 8 次）/ 队列一条内容一行 /
      // 处置后能回看（带内容快照）
      'test-report-votes.cjs',
      // 举报门槛按独立浏览人数分档（0-49→3 / 50-199→5 / 200-499→7 / 500+→10）：
      // 火帖不该被三个人搞掉；并且系统只下架、不删除
      'test-report-thresholds.cjs',
      // 匿名代号按**帖子 id** 取名（旧版按 openid 后四位，同一人所有匿名帖同名，
      // 看两条就能串成一个人）：同帖稳定 + 跨帖不同，两个性质都要
      'test-anon-name.cjs',
      // 匿名帖的**评论区**也匿名：楼主用主贴代号、其他人按「帖子id+openid」取名、
      // 「回复 @某某」不许带回真名、头像点不进名片（那里是真名 + 他所有帖子）、
      // 云端下发前就把真名摘掉（前端换代号只是遮住屏幕）
      'test-anon-comment.cjs',
      'test-release-hardening.cjs',
      'test-cloud-load.cjs',
      'test-course-extra.cjs',
      'test-20261020-fixes.cjs', // 2026-10-20 上线前 22 项体验 / 数据 / 审核修复
      'test-release-fixes-20261019.cjs',
      'test-official-article.cjs'
    ]
  },
  {
    key: 'net',
    name: '联网测试',
    net: true,
    scripts: [
      'test-jobtalk.cjs'         // 真打就业网，并刷新 scripts/fixtures/jobs.json
    ]
  }
];

// Python 写的检查单独放：python 不在 PATH 上时跳过并提示，
// 而不是让整条 check 因为「这台机器没装 python」变红
const PY_CHECKS = [
  {
    name: 'check-tabbar-icons.py',
    args: [],
    hint: 'tabBar 图标在深色底上的对比度'
  },
  {
    name: 'normalize-tabbar-icons.py',
    args: [],
    // 不带 --fix 时是纯检查：墨迹尺寸/画心不一致就报错。
    // tabBar 是唯一「微信不会自动对齐」的地方，图标一旦换新就很容易又歪回去
    hint: 'tabBar 图标墨迹尺寸与画心是否对齐'
  }
];

function pickPython() {
  const cands = (process.env.PY || '').split(',').filter(Boolean).concat(['python', 'python3']);
  for (const c of cands) {
    const r = spawnSync(c, ['-c', 'print(1)'], { stdio: 'ignore' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

const args = process.argv.slice(2);
const noNet = args.indexOf('--no-net') >= 0;
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const results = [];
let failed = 0;
let skipped = 0;

function run(cmd, scriptAbs, extraArgs) {
  const t0 = Date.now();
  const r = spawnSync(cmd, [scriptAbs].concat(extraArgs || []), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000
  });
  const ms = Date.now() - t0;
  const out = (r.stdout || '') + (r.stderr || '');
  return {
    ok: r.status === 0 && !r.error,
    ms: ms,
    tail: out.trim().split('\n').slice(-1)[0] || '',
    err: r.error ? String(r.error.message) : (r.signal ? 'killed by ' + r.signal : '')
  };
}

console.log('商砖小站 · 全量检查\n');

GROUPS.forEach((g) => {
  if (only && g.key !== only) return;
  if (noNet && g.net) return;
  console.log('── ' + g.name + ' ' + '─'.repeat(Math.max(0, 46 - g.name.length)));
  g.scripts.forEach((s) => {
    const abs = path.join(HERE, s);
    if (!fs.existsSync(abs)) {
      console.log('  ? ' + s + '  （文件不存在，跳过）');
      skipped += 1;
      return;
    }
    const res = run(process.execPath, abs, []);
    const mark = res.ok ? '✓' : '✗';
    console.log('  ' + mark + ' ' + s + '  ' + (res.ms / 1000).toFixed(1) + 's'
      + (res.ok ? '' : (res.err ? '  ' + res.err : '  ' + res.tail)));
    if (!res.ok) failed += 1;
    results.push({ group: g.name, script: s, ok: res.ok, ms: res.ms });
  });
  console.log('');
});

// Python 检查
if (!only || only === 'static') {
  const py = pickPython();
  if (!py) {
    console.log('── Python 检查（跳过：没找到可用的 python）');
    console.log('  ' + PY_CHECKS.map((c) => c.name).join(', ')
      + '\n    设置 PY 环境变量指向解释器即可启用，例如 PY=C:/path/to/python.exe npm run check\n');
  } else {
    console.log('── Python 检查（' + py + '）');
    PY_CHECKS.forEach((c) => {
      const abs = path.join(HERE, c.name);
      if (!fs.existsSync(abs)) return;
      const res = run(py, abs, c.args);
      const mark = res.ok ? '✓' : '✗';
      console.log('  ' + mark + ' ' + c.name + '  ' + (res.ms / 1000).toFixed(1) + 's'
        + (res.ok ? '' : '  ' + res.tail));
      if (!res.ok) failed += 1;
    });
  }
  console.log('');
}

/* ---------------- 汇总 ---------------- */

const total = results.length;
const okCount = results.filter((r) => r.ok).length;
const ms = results.reduce((a, b) => a + b.ms, 0);

console.log('='.repeat(52));
console.log('脚本 ' + total + ' 个：通过 ' + okCount + ' / 失败 ' + failed
  + (skipped ? ' / 缺失 ' + skipped : '')
  + '　耗时 ' + (ms / 1000).toFixed(1) + 's');
if (failed) {
  console.log('\n失败的：');
  results.filter((r) => !r.ok).forEach((r) => console.log('  ✗ [' + r.group + '] ' + r.script));
}
console.log('');
process.exit(failed ? 1 : 0);
