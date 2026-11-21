// scripts/test-content-defense.cjs —— 内容风控 + 自由发帖的守门测试
//
// 两件事被钉在这里：
//
// 一、学生恶意评价老师 → 老师起诉小程序，这套抗辩机制必须都在。
//     法律上平台能站住脚靠的是三样：事前告知、事中留痕、事后有通道 + 有处置。
//     缺任何一样，对方律师都能说「平台明知而不作为」。
//     这里逐条盯住它们还在不在 —— 静默被删掉一段文案，风险就回来了。
//
// 二、发帖的自由度一旦收紧就会反弹（改回「标题必填」只是加一行 if）。
//     所以前端和云函数的放行条件必须**同一套口径**，
//     不然会出现「按钮能点、云端拦回来」这种最难查的错。
//
// 跑法：node scripts/test-content-defense.cjs（工作目录在 recon/ 下）

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram', 'zjgsu-campus');

let pass = 0;
const fails = [];

function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra === undefined ? '' : '  ← ' + JSON.stringify(extra)));
}
function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
const readCloudSource = require('./cloud-source.cjs');
function readProj(rel) {
  return read(path.join(APP, rel));
}

const CLOUD = readCloudSource();
const POST_JS = readProj('sub/forum/post/post.js');
const POST_WXML = readProj('sub/forum/post/post.wxml');
const REVIEW_WXML = readProj('sub/course/review/review.wxml');
const ABOUT_WXML = readProj('pages/user/about/about.wxml');
const ABOUT_JS = readProj('pages/user/about/about.js');
const TEACHER_JS = readProj('sub/course/teacher/teacher.js');
const TEACHER_WXML = readProj('sub/course/teacher/teacher.wxml');
const DETAIL_JS = readProj('sub/course/detail/detail.js');
const REPORT_CONTENT = readProj('sub/utils/report-content.js');
const MOD_JS = readProj('pages/admin/moderation/moderation.js');
const MOD_WXML = readProj('pages/admin/moderation/moderation.wxml');

/* ---------------- 1. 发帖：一句话 / 一张图都能发出去 ---------------- */

// 只看 postAdd 自己那段：全文件里还有资料 / 活动的标题必填，那是别的功能，
// 扫全文件会把它们算进来 —— 「误报」比「漏报」更害人，它会让人以为这里没问题
const postAddDoc = (CLOUD.match(/async function postAdd\([\s\S]*?\n}\n/) || [''])[0];
ok('postAdd 不再无条件下拦空标题',
  !/\bif\s*\(\s*!title\s*\)\s*return/.test(postAddDoc),
  'postAdd 里还在无条件拦空标题');
ok('云函数放行条件里带上了图片',
  /!content\s*&&\s*!imgs\.length/.test(CLOUD),
  '没有把图片算作内容');
ok('云函数对主题帖仍要标题',
  /topic\s*&&\s*!title/.test(CLOUD), '主题帖丢了标题就等于没有内容');
ok('云函数对投票帖仍要标题',
  /isVote\s*&&\s*!title/.test(CLOUD), '投票帖丢了标题，选项就没处挂');

ok('前端不再拦普通帖的空标题',
  !/\bif\s*\(\s*!title\s*\)\s*\{\s*\n?\s*feedback\.toast/.test(POST_JS),
  'post.js 里还有「先过标题」那一刀');
ok('前端按类型分别要求标题',
  /!title\s*&&\s*kind\s*!==\s*'normal'/.test(POST_JS), '普通帖标题应彻底选填');
ok('前端把图片算作内容',
  /kind\s*===\s*'normal'\s*&&\s*!content\s*&&\s*!this\.data\.images\.length/.test(POST_JS),
  '只发图还是发不出去');

// 渲染：没标题时不能留一条空白行
ok('列表卡片标题行为空时不渲染',
  /wx:if="\{\{p\.title\}\}"[^>]*class="title-md post__title"/.test(
    readProj('pages/forum/list/list.wxml')),
  '列表会留一行空标题');
ok('详情页标题行为空时不渲染',
  /wx:if="\{\{post\.title\}\}"[^>]*class="title-lg detail__title"/.test(
    readProj('sub/forum/detail/detail.wxml')),
  '详情页会留一行空标题');
ok('搜索结果对图片帖有兜底标题',
  /（图片）/.test(readProj('sub/search/search.js')),
  '图片帖在搜索里会显示「（无标题）」，看着像数据坏了');

/* ---------------- 2. 事前告知：发布前必须看得到规矩 ---------------- */

ok('评价页有发布须知',
  /rv-tip[\s\S]{0,200}说事实、不说人/.test(REVIEW_WXML), '评价页没有发布前提示');
ok('发帖页有发布须知',
  /composer__notice[\s\S]{0,200}说事实、不说人/.test(POST_WXML), '发帖页没有发布前提示');
ok('发帖页写明匿名不等于查不到',
  /匿名只是不对外显示昵称[\s\S]{0,80}留存发布者标识/.test(POST_WXML),
  '匿名那句法律风险提示丢了');

/* ---------------- 3. 事中留痕：匿名也要能追到人 ---------------- */

// 留痕是整套抗辩的地基：拿不出发布者，平台就要独自面对权利人
const reviewAddDoc = (CLOUD.match(/async function reviewAdd\([\s\S]*?\n}\n/) || [''])[0];
ok('帖子入库必存 openid', /openid:\s*openid/.test(postAddDoc), '帖子留不下发布者');
ok('评价入库必存 openid', /openid:\s*openid/.test(reviewAddDoc), '评价留不下发布者');
// 匿名只是前端不显示，服务端必须认得出
ok('帖子匿名字段与 openid 并存',
  /anonymous:\s*!!p\.anonymous/.test(postAddDoc) && /openid:\s*openid/.test(postAddDoc),
  '匿名字段覆盖了留痕');
ok('评价匿名字段与 openid 并存',
  /anonymous:\s*!!r\.anonymous/.test(reviewAddDoc) && /openid:\s*openid/.test(reviewAddDoc),
  '匿名字段覆盖了留痕');

/* ---------------- 4. 事后：对外投诉通道真的存在 ---------------- */

// 民法典 1195 条的避风港，前提是权利人能把通知送进来。
// 邮箱还是 example.com 的话，这条通道等于不存在 —— 必须挂在这里提醒
const aboutMail = (ABOUT_JS.match(/contact:\s*'([^']+)'/) || ['', ''])[1];
ok('投诉邮箱不是占位符', !!aboutMail && !/example\.com$/i.test(aboutMail), aboutMail);
ok('关于页写了侵权投诉通道',
  /侵权投诉与内容处理/.test(ABOUT_WXML), '对外没有投诉入口');
ok('对外承诺了响应时限', /48\s*小时内响应/.test(ABOUT_WXML), '没有时限承诺的空话等于没写');
ok('对外承诺了处理时限', /7\s*个工作日内处理完毕/.test(ABOUT_WXML), '没有处理时限');
ok('告知了留痕会被依法提供',
  /留存发布者标识|留存发布者的微信标识|留存/.test(ABOUT_WXML)
  && /依法需要提供|如实提供/.test(ABOUT_WXML), '没写留痕与依法提供');

/* ---------------- 5. 事后：收到投诉后真的处置得动 ---------------- */

const hideFn = (CLOUD.match(/async function teacherHideReviews\([\s\S]*?\n}\n/) || [''])[0];
ok('存在老师名下评价批量下架', !!hideFn, '投诉来了只能一条条找');
ok('批量下架只做审核员',
  /isModerator\(openid\)/.test(hideFn), '谁都能下架比没有更糟');
ok('批量下架只下架不删除',
  /'hidden'/.test(hideFn) && !/\.remove\(/.test(hideFn),
  '物理删除会让撤回投诉和申诉无据可查');
ok('批量下架会留操作日志', /logMod\(/.test(hideFn), '处置没有台账，说不清什么时候处理的');
ok('批量下架翻页取全量',
  /REVIEW_PAGE/.test(hideFn) && /skip\(/.test(hideFn),
  '不翻页会漏掉后半截，以为下架干净了其实没有');
ok('批量下架有单次上限防超时',
  /slice\(0,\s*\d+\)/.test(hideFn), '没有上限会把云函数拖超时，结果一条都没改成');
ok('批量下架已注册路由',
  /case 'teacherHideReviews'/.test(CLOUD), '接口没注册，前端调了只会报不存在');
ok('老师页接了批量下架',
  /userApi\.teacherHideReviews/.test(TEACHER_JS)
  && /onHideAllReviews/.test(TEACHER_WXML),
  '老师页没有这个按钮');
ok('批量下架前有二次确认',
  /showModal/.test(TEACHER_JS), '批量动作不能一点就生效');

// 下架必须真的改到了才算数：update 不匹配时不报错，只给 updated: 0。
// 不看这一位，台账上写「已下架 30 条」可能一条都没改
ok('下架按真实改动数返回',
  /stats\s*&&\s*w\.stats\.updated\s*>\s*0/.test(CLOUD),
  '没改到也会报成功，台账就成了假的');

/* ---------------- 6. 处置必须可逆 ---------------- */

// 原文在，撤回投诉和申诉才有得谈
const setStatusFn = (CLOUD.match(/async function setContentStatus\([\s\S]*?\n\}\n/) || [''])[0];
ok('评价下架是改状态不是删记录',
  /COL_REVIEWS[\s\S]{0,200}\.update\(/.test(setStatusFn), '直接删了就恢复不了');

/* ---------------- 7. 评价可举报（含匿名） ---------------- */

// 老师被诽谤的两条路都要走得通：老师本人走邮箱（第 4 节已经盯住），
// 同学看到造谣评价走举报。后者的要害在匿名 —— 骂人的几乎都勾了匿名，
// 而匿名评价的 openid 前端拿不到。采信前端那个 openid，
// 就等于最该被举报的那一类内容一条都报不了。
//
// 反向的坑同样致命：openid 由客户端随手填，采信它就能把账记到别人头上。
const reportFn = (CLOUD.match(/async function report\(openid, payload\) \{[\s\S]*?\n\}\n/) || [''])[0];
ok('定位得到 report 函数', reportFn.length > 0, 'report 改名或结构变了，下面几条就没在测');
ok('作者由云端按内容认定，不信客户端报的',
  /const doc = await fetchTarget\(targetType, targetId\);[\s\S]{0,220}\(doc && doc\.openid\) \|\| payload\.targetOpenid/.test(reportFn),
  '改回直接采信 payload.targetOpenid 了：匿名报不了，且能栽赃给别人');

// 前端不许再替服务端做「这条能不能举报」的决定
ok('举报模块不因拿不到作者就拦下',
  !/if\s*\(\s*!opts\.openid\s*\)\s*return/.test(REPORT_CONTENT),
  '又加上「匿名的报不了」了');
ok('页面里不再有「匿名评价没法举报」这句话',
  !/这条评价是匿名的/.test(DETAIL_JS) && !/这条评价是匿名的/.test(TEACHER_JS));

// 老师页是全校骂人最集中的地方，两个列表（本课的 / 其他课的）都要有入口
ok('老师页的每条评价都能举报',
  (TEACHER_WXML.match(/onReportReview/g) || []).length >= 2,
  '两个列表里有一个漏了');

// 缺 isMine 时「举报」会连自己的评价也显示出来 —— 自己举报自己，
// 攒够两票还能把自己的评价自动下架，且被记录成「被举报的人」
ok('老师页评价带 isMine（否则能举报自己）',
  /isMine:\s*store\.isMineReview\(r\)/.test(TEACHER_JS),
  'decorateReview 里少了 isMine，自己的评价也会挂出举报按钮');

/* ---------------- 8. 诽谤词能加得上 ---------------- */

// 老师说「这条评价在诽谤我」，最快的处置不是删评价，是把那类词加进词表 ——
// 前提是审核员有地方加。云端 cfgSave(words) 早就在，但没有任何页面调它，
// 词表实际上是个只能靠改代码的配置项
ok('审核页能把屏蔽词存到云端',
  /cfgSaveWords\(words\)/.test(MOD_JS) && /bind:tap="saveWords"/.test(MOD_WXML),
  '存词接口在，没有界面调它');
// 把「讲课差 / 给分低 / 作业多」也加进去是最容易犯的错：
// 那些是正常教学评价，拦了它们课程评价这个功能本身就废了
ok('词表界面写明了不该加哪些词',
  /讲课差/.test(MOD_WXML) && /作业多/.test(MOD_WXML),
  '不写明，审核员迟早会把正常评价也加进去');
ok('词表界面如实说明生效延迟',
  /最多 5 分钟/.test(MOD_WXML) || /最多 5 分钟/.test(MOD_JS),
  '云函数每实例各缓存一份，说「立刻生效」会让人以为没保存上');

/* ---------------- 9. 图片审核命中后必须真的下线 ---------------- */

// 闲置的 status 是 open / done（交易状态），列表过滤的是 hidden。
// 曾经这里只写 status='hidden'，结果异步图片审核判违规后，
// 列表里那条闲置还在 —— 审核记录显示已处理，用户却仍看得见。
const blockMediaFn = (CLOUD.match(/async function blockRiskyMedia\([\s\S]*?\n\}\n/) || [''])[0];
const marketMediaBranch = (blockMediaFn.match(/t === 'market'[\s\S]*?\.catch\(\(\) => \{\}\);\n    \}/) || [''])[0];
ok('找到闲置图片处置分支', marketMediaBranch.length > 0, 'blockRiskyMedia 结构变了，下面的断言不再有效');
ok('闲置图片违规后写入 hidden=true（列表才会真的下线）',
  /hidden:\s*true/.test(marketMediaBranch), '只写 status 不够，市场列表只认 hidden');
ok('闲置图片违规不篡改交易状态 status',
  !/status:\s*'hidden'/.test(marketMediaBranch), 'status 被改成 hidden 会把 open/done 语义弄坏');
ok('闲置图片违规会留下 hiddenReason',
  /hiddenReason:\s*'图片违规'/.test(marketMediaBranch), '审核员/作者看不到下架原因');
/* ---------------- 10. 头像也是公开 UGC 图片 ---------------- */

const upsertProfileFn = (CLOUD.match(/async function upsertProfile\([\s\S]*?\n\}\n/) || [''])[0];
const publicProfileFn = (CLOUD.match(/function publicProfile\([\s\S]*?\n\}\n/) || [''])[0];
ok('找到 upsertProfile / publicProfile', upsertProfileFn.length > 0 && publicProfileFn.length > 0);
ok('头像写入只认 avatars/ 下的云文件（拒绝站外 URL）',
  /avatarUrl:\s*safeAvatar\(payload\.avatarUrl\)/.test(upsertProfileFn),
  'upsertProfile 直接存 payload.avatarUrl 会变成站外图床入口');
ok('头像读取也过白名单（保护老数据）',
  (/avatarUrl:\s*safeAvatar\(u\.avatarUrl\)/.test(publicProfileFn)
    || /const avatarUrl = safeAvatar\(u\.avatarUrl\)/.test(publicProfileFn)),
  '名片页可能继续请求历史外链头像');
ok('换头像会先做同步图片审核',
  /checkImageRiskSync\(\[normalized\.avatarUrl\]\)/.test(upsertProfileFn),
  '头像没有接入图片安全审核');
ok('违规头像会在保存前被拒绝',
  /risk\.risky[\s\S]{0,160}头像含有违规内容/.test(upsertProfileFn),
  '审核命中后仍会把违规头像存进资料');
/* ---------------- 输出 ---------------- */

if (fails.length) {
  console.log('内容风控测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log('内容风控测试：' + pass + ' 项全部通过');
}
