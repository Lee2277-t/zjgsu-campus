/**
 * 审核队列回执契约测试（scripts/test-modqueue.cjs）
 * 运行：node scripts/test-modqueue.cjs
 *
 * 为什么单独为「审核队列」写一个测试：
 *
 * 这里出过一次真实的静默故障 —— 队列里有个 evidence 字段，前端那个证据区是
 * `src="{{src}}"` 直接拿它当图片地址渲染的。而举报「人」那条链路存进去的是
 * **对象数组**（{from, text, time} / {nickName, college}），也挂在 evidence 上。
 * 结果是：名片举报那一栏从上线起就一直是一块加载不出来的碎图，没人报过来，
 * 因为审核员会以为「这条举报本来就没截图」——它长得跟「没有证据」一模一样。
 *
 * 这类故障有三个特点，凑齐了就必须上测试：
 *   ① 前台不报错（图片加载失败在小程序里没有任何提示）
 *   ② 长得像正常状态（碎图 ≈ 没图）
 *   ③ 只有审核员看得到，而审核员不会来提 bug
 *
 * 所以这里钉的是「契约」：evidence 只能是 URL 字符串数组，
 * 人的证据走 personEvidence + desc 文本，两者不许再混。
 */

'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram', 'zjgsu-campus');

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  ok   ' + name);
  } else {
    fail += 1;
    console.log('  FAIL ' + name + (extra ? '\n       → ' + extra : ''));
  }
}

function read(rel) {
  try {
    return fs.readFileSync(path.join(APP, rel), 'utf8');
  } catch (e) {
    return '';
  }
}

// 取出 getQueue 函数体（到下一个顶格 `}` 为止）
function fnBody(src, name) {
  const start = src.indexOf('async function ' + name);
  if (start < 0) return '';
  const brace = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(brace + 1, i);
    }
  }
  return '';
}

const readCloudSource = require('./cloud-source.cjs');
const cloudSrc = readCloudSource();
const wxmlSrc = read('pages/admin/moderation/moderation.wxml');
const modJs = read('pages/admin/moderation/moderation.js');
const cardWxml = read('pages/user/card/card.wxml');
const userSrc = read('utils/user.js');
const resourcesJs = read('pages/tool/resources/resources.js');
const resourcesWxml = read('pages/tool/resources/resources.wxml');
const queue = fnBody(cloudSrc, 'getQueue');

console.log('\n审核队列回执契约（getQueue × 审核页证据区）\n');

// ── ① 契约前提：前端证据区只吃 URL 字符串 ──────────────────────────────
// 如果哪天前端改成能渲染对象，下面这组断言就得跟着改，否则会变成假绿。
ok('取到了 getQueue 函数体', queue.length > 200, '长度 ' + queue.length);
ok('审核页证据区是直接当图片地址渲染的', /src="\{\{src\}\}"/.test(wxmlSrc));
ok('证据区的循环项是 evidence', /wx:for="\{\{item\.evidence\}\}"/.test(wxmlSrc));

// ── ② 举报「人」：证据走 personEvidence，不许再挂 evidence ─────────────
// 分支名换过一次：原来逐条举报取名 r，队列按内容合并后叫 g（见 report-votes.js）。
// 这里两种都认，但**必须真的取到** —— 取不到就说明 getQueue 的结构又变了，
// 该回来看这几条断言还成不成立
const personStart = queue.indexOf('if (isPersonType(g.targetType))') >= 0
  ? queue.indexOf('if (isPersonType(g.targetType))')
  : queue.indexOf('if (isPerson(r.targetType))');
const personBody = personStart >= 0 ? queue.slice(personStart, queue.indexOf('return;', personStart)) : '';
ok('取到了 person 分支', personBody.length > 100, '长度 ' + personBody.length);

ok('人的证据挂在 personEvidence 上', /personEvidence:\s*ev/.test(personBody));
ok('person 分支不再写 evidence: ev（会渲染成碎图）',
  !/evidence:\s*ev\b/.test(personBody),
  '又挂回 evidence 了 —— 审核页会拿对象当图片地址');
ok('person 分支的文本证据仍然拼进 desc', /desc:\s*ev\.length/.test(personBody));

// ── ③ 内容类举报：把配图带下去，且必须是字符串、有上限 ────────────────
ok('内容分支带了 evidence（审核员要看得见图）',
  /evidence:\s*pics/.test(queue));
ok('pics 只收字符串（脏数据不能进 src）',
  /filter\(\(s\)\s*=>\s*typeof\s+s\s*===\s*'string'\s*&&\s*s\)/.test(queue));
ok('pics 有数量上限（队列首屏不能并发下载一堆图）',
  /slice\(0,\s*3\)/.test(queue));
ok('pics 取自内容自己的 images 字段',
  /Array\.isArray\(content\.images\)\s*\?\s*content\.images\s*:\s*\[\]/.test(queue));

// ── ④ 两条链路不能互相踩 ──────────────────────────────────────────────
// 内容分支的 evidence 与 person 分支的 personEvidence 是两套东西，
// 只要再出现一次「把对象数组塞进 evidence」，前端就会碎图。
const evidenceAssign = queue.match(/^\s*evidence:/gm) || [];
ok('getQueue 里 evidence 只被赋值一次', evidenceAssign.length === 1,
  '出现 ' + evidenceAssign.length + ' 处 —— 说明有分支在抢这个字段');

// ── ⑤ 注释留了警示，防止后来的人改回去 ────────────────────────────────
ok('云侧说明了为什么叫 personEvidence',
  /personEvidence 而不是 evidence/.test(queue));
ok('前端证据区也留了同一条警示',
  /evidence 只能是 URL 字符串数组/.test(wxmlSrc));

// ── ⑥ 审核员能从举报卡片进入被举报人主页并封号 ─────────────────────────
ok('举报卡片作者行可点进主页', /catchtap="openReportedUser"/.test(wxmlSrc));
ok('举报卡片有「查看主页」按钮', /查看主页/.test(wxmlSrc));
ok('主页跳转带被举报人 openid', /pages\/user\/card\/card\?openid=/.test(modJs) && /openReportedUser\(e\)/.test(modJs));
ok('被举报人名片页保留审核员封禁入口', /isMod && !isMe/.test(cardWxml) && /bindtap="onBan"/.test(cardWxml));

// ── ⑦ 批量驳回：失败不能显示成“已驳回 0 条” ────────────────────────────
const resolveBody = fnBody(cloudSrc, 'resolveReports');
ok('驳回失败会显示云端真实原因', /r\.ok === false/.test(modJs) && /r\.msg/.test(modJs));
ok('批量驳回按 _id in 批量读取/更新', (resolveBody.match(/db\.command\.in\(/g) || []).length >= 2);
ok('裁决字段不与云函数路由 action 冲突', /decision: action/.test(userSrc) && /payload\.decision/.test(cloudSrc));
ok('学习资料已纳入举报目标类型', /'resource'/.test(cloudSrc) && /targetType === 'resource'/.test(cloudSrc));
ok('学习资料卡片有举报入口', /onReport\(e\)/.test(resourcesJs) && /'resource'/.test(resourcesJs) && /catchtap="onReport"/.test(resourcesWxml));
ok('资料下架后下载和感谢接口会拒绝', /资料已被下架/.test(cloudSrc));
ok('审核页能显示“学习资料”类型', /学习资料/.test(wxmlSrc));
ok('已处置归档带被举报人 openid', /targetOpenid: g\.targetOpenid/.test(cloudSrc));
ok('已处置归档可点进被举报人主页', /查看主页/.test(wxmlSrc) && /data-item="\{\{a\}\}"[^>]*catchtap="openReportedUser"/.test(wxmlSrc));
ok('不再逐条 where 查询举报记录', !/for \(const id of ids\)/.test(resolveBody));

console.log('\n' + (fail === 0 ? '全部通过' : '有失败项') + '：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail === 0 ? 0 : 1);
