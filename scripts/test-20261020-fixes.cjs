/* 2026-10-20 上线前 22 项修复的回归测试
 * 覆盖：课程去重/评价倒序、论坛话题隐藏、评论输入与刷新、通知去重/未读、
 * 保护内容不进队列、保护/置顶详情操作、页头三点、名片按钮、联系方式、回到顶部。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const PROJ = path.join(ROOT, 'miniprogram', 'zjgsu-campus');
const norm = (p) => p.replace(/\\/g, '/');
const oldExt = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (norm(filename).startsWith(norm(PROJ))) return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return oldExt(mod, filename);
};

const MEM = {};
const noop = () => undefined;
const chain = (() => {
  const c = {};
  ['collection', 'doc', 'where', 'orderBy', 'limit', 'field', 'skip'].forEach((m) => { c[m] = () => c; });
  c.get = () => Promise.resolve({ data: [] });
  c.add = () => Promise.resolve({ _id: 'x' });
  c.update = () => Promise.resolve({});
  c.remove = () => Promise.resolve({});
  c.count = () => Promise.resolve({ total: 0 });
  return c;
})();
global.wx = new Proxy({
  getStorageSync: (k) => (k in MEM ? MEM[k] : ''),
  setStorageSync: (k, v) => { MEM[k] = v; },
  removeStorageSync: (k) => { delete MEM[k]; },
  showToast: noop, showModal: noop, showLoading: noop, hideLoading: noop,
  showActionSheet: noop, previewImage: noop, hideKeyboard: noop,
  setNavigationBarTitle: noop, setNavigationBarColor: noop,
  navigateTo: noop, redirectTo: noop, pageScrollTo: noop, stopPullDownRefresh: noop,
  nextTick: (fn) => fn && fn(),
  getSystemInfoSync: () => ({}), getWindowInfo: () => ({}), vibrateShort: noop,
  cloud: { init: noop, database: () => chain, callFunction: () => Promise.resolve({ result: { ok: true } }) }
}, { get: (t, k) => (k in t ? t[k] : noop) });
global.getApp = () => ({ globalData: {} });
global.getCurrentPages = () => [];
global.Page = noop; global.Component = noop; global.App = noop;

let pass = 0; let fail = 0;
function ok(name, cond, extra) { if (cond) pass += 1; else { fail += 1; console.log('  ✗ ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra))); } }
const read = (rel) => fs.readFileSync(path.join(PROJ, rel), 'utf8');
const cloud = require('./cloud-source.cjs')();

(async function main() {
  const base = require(path.join(PROJ, 'utils/store-base.js'));
  const seed = require(path.join(PROJ, 'data/seed.js'));
  const course = require(path.join(PROJ, 'utils/store-course.js'));
  const forum = require(path.join(PROJ, 'utils/store-forum.js'));

  // 1. 课程去重：种子与运行时两层都要保证课程名唯一。
  const nameKey = (s) => String(s || '').replace(/\s+/g, '').replace(/[（）()《》]/g, '').toLowerCase();
  ok('种子课程按名称唯一', new Set(seed.courses.map((c) => nameKey(c.name))).size === seed.courses.length);
  MEM[base.KEYS.userCourses] = [{ id: 'dup-course', name: seed.courses[0].name, college: '重复学院', major: '重复专业', ctype: '专业课' }];
  MEM[base.KEYS.reviews] = [{ id: 'r-dup', courseId: 'dup-course', content: '重复课评价', score: 4, at: 2 }];
  course.refreshCourses();
  ok('运行时刷新后课程名唯一', new Set(course.getCourses().map((c) => nameKey(c.name))).size === course.getCourses().length);
  ok('重复课程 id 归并到保留课程', course.canonicalCourseId('dup-course') === seed.courses[0].id);
  ok('重复课程评价不丢并归并', course.getReviews(seed.courses[0].id).some((r) => r.id === 'r-dup'));

  // 2. 评价倒序
  const cid = seed.courses[1].id;
  MEM[base.KEYS.reviews] = [
    { id: 'old', courseId: cid, content: '旧', score: 3, at: 1, time: '2026-01-01' },
    { id: 'new', courseId: cid, content: '新', score: 4, at: 2, time: '2026-01-02' }
  ];
  ok('课程评价按 at 倒序', course.getReviews(cid)[0].id === 'new');
  const reviewsHtml = read('sub/course/detail/detail.wxml') + read('sub/course/teacher/teacher.wxml');
  ok('课程/老师评价页都使用同一倒序数据源', /getReviewsByTeacher/.test(read('utils/store-course.js')) && /for=\"{{\s*reviews/.test(reviewsHtml));

  // 3. 论坛话题隐藏
  MEM[base.KEYS.boards] = seed.boards.concat([{ key: 'course', name: '课程评价' }, { key: 'trade', name: '闲置分享' }, { key: 'lost', name: '失物招领' }, { key: 'team', name: '活动组队' }]);
  const boardNames = forum.getBoards().map((b) => b.name);
  ok('论坛不再展示四个重复话题', !boardNames.some((x) => ['课程评价', '闲置分享', '失物招领', '活动组队'].includes(x)), boardNames);
  ok('论坛仍保留闲聊等业务话题', boardNames.includes('闲聊') && boardNames.includes('校园吐槽'));

  // 4. 静态 UI 验收
  const head = read('components/ui/app-header/index.wxml');
  ok('页头三点已删除', head.indexOf('app-header__more') < 0);
  const detailWxml = read('sub/forum/detail/detail.wxml');
  ok('评论输入改成 textarea', /<textarea[^>]+class="input-bar__input"/.test(detailWxml));
  ok('评论回车不再绑定立即发送', detailWxml.indexOf('bindconfirm="sendComment"') < 0);
  ok('评论内容保留换行样式', /white-space:\s*pre-wrap/.test(read('sub/forum/detail/detail.wxss')));
  ok('详情页开启下拉刷新并实现收尾', /enablePullDownRefresh/.test(read('sub/forum/detail/detail.json')) && /onPullDownRefresh\(\)/.test(read('sub/forum/detail/detail.js')) && /stopPullDownRefresh/.test(read('sub/forum/detail/detail.js')));
  const courseWxml = read('pages/course/list/list.wxml');
  const forumWxml = read('pages/forum/list/list.wxml');
  ok('课程折叠操作使用淡蓝类', /fold-toggle/.test(courseWxml) && /fold-toggle/.test(forumWxml));
  ok('漂流瓶文案替代盲盒', read('pages/forum/list/list.wxml').includes('漂流瓶') && !read('sub/campus/blindbox/blindbox.json').includes('校园盲盒'));

  const cardWxml = read('pages/user/card/card.wxml');
  ok('名片操作区不使用带边框按钮', cardWxml.indexOf('cd-act') < 0 && /cd-text-actions/.test(cardWxml));
  const profileJs = read('pages/user/profile/profile.js');
  ok('联系方式不再提供 QQ 选项', !/privacyItems:[^\n]*qq/.test(profileJs) && !/key: 'qq'/.test(profileJs) && !/仅好友可见（QQ）/.test(profileJs) && !/QQ号/.test(read('pages/user/profile/profile.wxml')));
  ok('分享按钮字号与操作行一致', /detail__op--btn text[^}]*font-size/.test(read('sub/forum/detail/detail.wxss')));
  ok('评论和课程页面具备页面级回到顶部入口', /class="backtop-fab/.test(read('pages/forum/list/list.wxml')) && /class="backtop-fab/.test(read('sub/course/detail/detail.wxml')) && /class="backtop-fab/.test(read('sub/forum/detail/detail.wxml')) && /backTop()/.test(read('pages/forum/list/list.js')));
  ok('长按私信文字可系统选择复制', /user-select="\{\{true\}\}"/.test(read('pages/user/chat/chat.wxml')));
  ok('论坛帖子和评论支持长按选中复制', /user-select="\{\{true\}\}"/.test(read('pages/forum/list/list.wxml')) && (read('sub/forum/detail/detail.wxml').match(/user-select="\{\{true\}\}"/g) || []).length >= 4);
  ok('深色模式同步原生导航栏和 tabBar', /applyNative/.test(read('utils/theme.js')) && /setNavigationBarColor/.test(read('utils/theme.js')) && /setTabBarStyle/.test(read('utils/theme.js')));

  // 联系方式三项（微信 / 手机 / 暂不公开）仍能正确落到 contactTypeIdx。
  let profilePage = null;
  global.Page = (o) => { profilePage = o; };
  require(path.join(PROJ, 'pages/user/profile/profile.js'));
  const pData = { contactTypeIdx: 0, contactPlaceholder: '' };
  profilePage.setData = function (patch) { Object.assign(pData, patch); };
  profilePage.data = pData;
  profilePage.onPrivacy({ detail: { value: 'phone' } });
  ok('手机号档位可选中', pData.contactTypeIdx === 1 && /手机号/.test(pData.contactPlaceholder));
  profilePage.onPrivacy({ detail: { value: '' } });
  ok('暂不公开档位可选中', pData.contactTypeIdx === 2 && /暂不公开/.test(pData.contactPlaceholder));
  profilePage.onPrivacy({ detail: { value: 'wechat' } });
  ok('微信号档位可选中', pData.contactTypeIdx === 0 && /微信号/.test(pData.contactPlaceholder));

  // 深色模式下，功能大色块和好友按钮布局
  ok('深色个人卡/树洞/漂流瓶使用主题令牌', /--c-hero-from/.test(read('app.wxss')) && /--c-hero-from/.test(read('pages/mine/mine.wxss')) && /--c-hole-from/.test(read('components/ui/treehole-entry/index.wxss')) && /--c-bottle-from/.test(read('pages/forum/list/list.wxss')));
  ok('四个 tab 的发布按钮位置统一', read('pages/market/list/list.wxss').indexOf('bottom: calc(32rpx + env(safe-area-inset-bottom))') >= 0 && read('pages/campus/campus.wxss').indexOf('bottom: calc(32rpx + env(safe-area-inset-bottom))') >= 0);
  ok('好友操作彻底改为两列纯文字', /cd-text-actions/.test(read('pages/user/card/card.wxml')) && /cd-text-main/.test(read('pages/user/card/card.wxss')) && !/cd-pair-row|cd-act/.test(read('pages/user/card/card.wxml')) && /拉黑 TA/.test(read('pages/user/card/card.wxml')) && /举报 TA/.test(read('pages/user/card/card.wxml')));
  ok('回到顶部常驻显示且不依赖组件', !/back-top visible=/.test(read('pages/forum/list/list.wxml')) && /backtop-fab/.test(read('app.wxss')));
  ok('帖子/评论有长按复制处理器', /bindlongpress="onCopyPost"/.test(read('pages/forum/list/list.wxml')) && /onCopyCommentText/.test(read('sub/forum/detail/detail.wxml')));

  ok('私信支持选择 GIF 且不压缩动图', /chooseGif/.test(read('pages/user/chat/chat.wxml')) && /pickGif/.test(read('pages/user/chat/chat.js')) && /pickGif/.test(read('utils/upload.js')) && /isGifPath\(path\)/.test(read('utils/upload.js')));

  ok('自己读取帖子返回完整正文，避免摘要覆盖全文', cloud.indexOf('isSelf ? 2000 : 60') >= 0 && cloud.indexOf('isSelf ? 9 : 3') >= 0);

  // 自定义置顶顺序：前台按 pinOrder，后台有上移/下移入口，云端有专用 action。
  MEM[base.KEYS.posts] = [
    { id: 'pin-a', title: 'A', board: '闲聊', pinned: true, pinOrder: 2, pinnedAt: 20, at: 20, comments: [] },
    { id: 'pin-b', title: 'B', board: '闲聊', pinned: true, pinOrder: 1, pinnedAt: 10, at: 10, comments: [] }
  ];
  ok('论坛置顶按管理员自定义顺序展示', forum.getPosts({ sort: 'pinned' }).map((p) => p.id).join(',') === 'pin-b,pin-a');
  ok('管理员页面有置顶排序入口', /pinnedOrder/.test(read('pages/admin/moderation/moderation.wxml')) && /movePin/.test(read('pages/admin/moderation/moderation.js')));
  ok('云端有自定义置顶顺序 action', /async function postPinOrder/.test(cloud) && /case 'postPinOrder'/.test(cloud));

  ok('置顶帖独立补拉，不依赖最新一页', /fetchPinnedPostsFromCloud/.test(read('utils/store-sync.js')) && /pinned: true/.test(read('utils/store-sync.js')) && /syncPinned/.test(read('pages/forum/list/list.js')));

  const backtopPages = ['pages/course/list/list.wxml','pages/forum/list/list.wxml','pages/market/list/list.wxml','pages/campus/campus.wxml','sub/course/teacher/teacher.wxml','sub/course/detail/detail.wxml','sub/forum/detail/detail.wxml'];
  ok('所有带回到顶部的页面都有刷新入口', backtopPages.every((rel) => /class="refresh-fab/.test(read(rel))));

  // 5. 云端审核 / 通知静态契约
  ok('举报事件使用评论 id 作为去重键', /eventKey: 'reply_'/.test(cloud));
  ok('通知写入使用稳定 doc id', /const docId = eventKey/.test(cloud) && /_id: docId/.test(cloud));
  ok('保护内容举报标记为 protected', /status: guarded \? 'protected' : 'pending'/.test(cloud));
  ok('审核队列跳过保护内容', /detail\[i\]\.guarded && !isPersonType/.test(cloud));
  ok('保护帖子仍可置顶（详情页与后台都不再拦截）', !/先取消保护，才能把这帖子置顶/.test(read('pages/admin/moderation/moderation.js')) && /onTogglePostPin/.test(read('sub/forum/detail/detail.wxml')) && /onTogglePostProtect/.test(read('sub/forum/detail/detail.wxml')));
  ok('详情页评论支持保护', /onToggleCommentProtect/.test(read('sub/forum/detail/detail.wxml')) && /canProtect/.test(read('utils/store-forum.js')));
  ok('课程/老师页有倒序开关', /ls-reverse/.test(read('pages/course/list/list.wxml')) && /onToggleReverse/.test(read('pages/course/list/list.js')));
  ok('自己评论自己的帖子会推进已读水位', /自己评论自己的帖子不是/.test(read('sub/forum/detail/detail.js')));
  ok('未读汇总包含通知数', /notifyUnreadCount/.test(read('utils/unread.js')) && /notifyList\(1\)/.test(read('utils/unread.js')));
  ok('我的帖子支持批量已读', /onReadAll/.test(read('sub/mine/posts/posts.js')) && /一键已读/.test(read('sub/mine/posts/posts.wxml')));
  ok('我的帖子按未读优先排序', /sort\(\(a, b\) => \(Number\(b\.unread\)/.test(read('sub/mine/posts/posts.js')));

  console.log('\n2026-10-20 修复回归：通过 ' + pass + ' 项' + (fail ? '，失败 ' + fail + ' 项' : '，全部通过'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
