// scripts/test-release-fixes-20261019.cjs —— 上线前 10 项问题的总守卫
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const cloudSrc = require('./cloud-source.cjs')();

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : '  →  ' + JSON.stringify(extra))); }
};

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const campusJs = read('pages/campus/campus.js');
const eventJs = read('sub/campus/event/event.js');
const forumJs = read('pages/forum/list/list.js');
const courseJs = read('pages/course/list/list.js');
const mineWxml = read('pages/mine/mine.wxml');
const detailJs = read('sub/forum/detail/detail.js');
const detailWxml = read('sub/forum/detail/detail.wxml');
const postJs = read('sub/forum/post/post.js');
const forumWxml = read('pages/forum/list/list.wxml');
const campusWxml = read('pages/campus/campus.wxml');
const appCfg = JSON.parse(read('app.json'));

console.log('\nA. 官网白名单');
{
  const sandbox = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(read('utils/official.js'), sandbox);
  const official = sandbox.module.exports;
  ok('接受学校主域名', official.isOfficialUrl('https://zjgsu.edu.cn/a'));
  ok('接受学校子域名', official.isOfficialUrl('https://jww.zjgsu.edu.cn/a'));
  ok('拒绝外站', !official.isOfficialUrl('https://example.com/a'));
  ok('拒绝外站 http', !official.isOfficialUrl('http://example.com/a'));
  ok('tgb 无可用 HTTPS，保留复制兜底', !official.isOfficialUrl('https://tgb.zjgsu.edu.cn/List-54.html'));
  const sub = (appCfg.subPackages || []).find((p) => p.root === 'sub');
  const pc = JSON.parse(read('project.config.json'));
  const ignored = ((pc.packOptions && pc.packOptions.ignore) || []).map((x) => x.value);
  ok('个人主体不再注册 web-view 页面', !sub || sub.pages.indexOf('campus/webview/webview') < 0);
  ok('校园页不再打开 web-view，只复制原文链接',
    !/official\.webviewPath/.test(campusJs) && /setClipboardData/.test(campusJs));
  ok('活动详情用 Markdown 正文 + 复制链接，不再打开 web-view',
    !/official\.webviewPath/.test(eventJs)
      && /rich-text[^>]*nodes="\{\{articleNodes\}\}"/.test(read('sub/campus/event/event.wxml'))
      && /setClipboardData/.test(eventJs));
  ok('web-view 目录已从打包中排除', ignored.indexOf('sub/campus/webview') >= 0, ignored);
}

console.log('\nB. 时间与通知');
ok('云函数时间固定按 UTC+8', /Date\.now\(\) \+ 8 \* 60 \* 60 \* 1000/.test(cloudSrc));
ok('客户端用 at 重新格式化帖子时间', /time:\s*displayTimeOf\(p\.at,\s*p\.time\)/.test(read('utils/store-forum.js')));
ok('notifyRead 支持按 targetId 已读', /const targetId = String\(payload\.targetId/.test(cloudSrc));
ok('前端导出 notifyReadByTarget', /function notifyReadByTarget/.test(read('utils/user.js')));
ok('详情页打开自己的帖子会清通知红点', /notifyReadByTarget\(post\.id\)/.test(detailJs));
ok('云端不会给自己发回复通知', /notifyOid && notifyOid !== openid/.test(cloudSrc));
ok('自己回复成功后也会清同帖通知红点', /r\.ok !== false && this\.data\.isMine/.test(detailJs) && /notifyReadByTarget/.test(detailJs));

console.log('\nC. 默认名片与旧帖点赞');
ok('云端返回默认名片而不是 null', /fallbackProfile\(target\)/.test(cloudSrc) && /fallbackProfile\(openid\)/.test(cloudSrc));
ok('名片页显示资料未完善提示', /profile\.profileIncomplete/.test(read('pages/user/card/card.wxml')));
const legacyFn = extractFn(cloudSrc, 'countWithLegacy');
ok('找到点赞 legacy 计数函数', legacyFn.length > 0);
const legacy = new Function('return (' + legacyFn + ')')();
ok('旧帖 5 赞 + 点一次 = 6', legacy(0, 5, '', 'like', 'like') === 6, legacy(0, 5, '', 'like', 'like'));
ok('旧帖取消赞不会归零', legacy(0, 5, 'like', '', 'like') === 4, legacy(0, 5, 'like', '', 'like'));
ok('表里已有 2 票、旧帖 7 赞时取消仍为 6', legacy(2, 7, 'like', '', 'like') === 6);

console.log('\nD. 论坛与地点');
ok('切板块会同步最新帖子', /store\.loadMorePosts\(true\)/.test(forumJs) && /this\.invalidate\(\)/.test(forumJs));
ok('切排序不再弹 Toast', !/正在看置顶帖|按' \+ hit\.label/.test(forumJs));
ok('发帖默认落到闲聊', /board:\s*'闲聊'/.test(postJs));
ok('论坛置顶排在最新前面', /k:\s*'pinned'[\s\S]{0,180}k:\s*'latest'/.test(forumJs));
ok('论坛默认查看置顶', /sort:\s*'pinned'/.test(forumJs));
ok('论坛话题类型默认收起', /boardExpanded:\s*false/.test(forumJs) && /!searching && boardExpanded/.test(forumWxml));
ok('论坛热门话题默认收起', /topicOpen:\s*false/.test(forumJs) && /wx:if="\{\{topicOpen\}\}"/.test(forumWxml));
ok('树洞/盲盒副标题已删除', !/全程匿名，不进主论坛|漂流瓶 · 每天 3 次/.test(forumWxml));
ok('地点搜索有云端关键词兜底', /fetchRemoteKeyword/.test(read('pages/tool/places/places.js')));
ok('校园地点搜索也有兜底', /fetchRemotePlaceKeyword/.test(campusJs));
ok('placeList 支持 keyword', /payload\.keyword/.test(cloudSrc));

console.log('\nE. 界面密度');
ok('课程页学院筛选默认收起', /collegeOpen:\s*false/.test(courseJs));
ok('课程页学院可展开', /onToggleCollege/.test(courseJs) && /collegeOpen/.test(read('pages/course/list/list.wxml')));
ok('课程页课程类型默认收起', /ctypeOpen:\s*false/.test(courseJs) && /onToggleCtype/.test(courseJs));
ok('校园活动筛选常驻展开、没有二次收起', /全部 \{\{eventCount\}\}/.test(campusWxml) && /学校官网 \{\{officialCount\}\}/.test(campusWxml) && /招聘会 \{\{jobfairCount\}\}/.test(campusWxml) && /同学发起 \{\{studentCount\}\}/.test(campusWxml) && !/onToggleEvFilter/.test(campusWxml) && !/evFilterOpen/.test(campusWxml));
ok('详情页非作者始终有举报入口', /catchtap="onReport">举报/.test(detailWxml));
ok('校园发布入口副标题已删除', !/讲座、比赛和组队都可以发布/.test(campusWxml));
ok('校园官网同步时间副标题已删除', !/上次更新/.test(campusWxml));
ok('官网卡片不再显示同步来源说明', /!item\.official/.test(campusWxml));
ok('我的页通用副标题已删除', !/回复、好友申请、举报处理结果|记下今天要做的事|继续没有写完的内容/.test(mineWxml));

console.log('\n' + (fail ? '✗ ' : '✓ ') + '共 ' + (pass + fail) + ' 项，通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);