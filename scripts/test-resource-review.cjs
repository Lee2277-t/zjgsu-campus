// scripts/test-resource-review.cjs —— 学习资料先审后发
//
// 资料是文件，不是图片：微信的图片/文本审核看不到 PDF / Word 里面。
// 所以这里把「新上传先 pending、审核员通过后才 normal」钉死。
// 只测静态契约，目录里的文件内容仍需人工判断；但状态机不能被改回自动公开。

'use strict';

const fs = require('fs');
const path = require('path');

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

const addFn = fnBody(cloudSrc, 'resourceAdd');
const listFn = fnBody(cloudSrc, 'resourceList');
const queueFn = fnBody(cloudSrc, 'resourceQueue');
const reviewFn = fnBody(cloudSrc, 'resourceReview');
const urlFn = fnBody(cloudSrc, 'resourceUrl');
const thanksFn = fnBody(cloudSrc, 'resourceThanks');
const js = read('pages/tool/resources/resources.js');
const wxml = read('pages/tool/resources/resources.wxml');

console.log('\nA. 云端状态机');
ok('resourceAdd 默认写 pending，不再直接公开',
  /status:\s*'pending'/.test(addFn) && /pending:\s*true/.test(addFn),
  '新资料会被直接放进公开列表');
ok('公开列表只放 normal；作者仍能看到自己的 pending / rejected',
  /if \(st === 'normal'\) return true/.test(listFn)
  && /mine && \(st === 'pending' \|\| st === 'rejected'\)/.test(listFn),
  '作者刚传完会像凭空消失了');
ok('资料审核队列只给审核员',
  queueFn.length > 0 && /denyReason\(openid\)/.test(queueFn),
  '普通用户也能拉到待审文件');
ok('云端注册了资料审核队列与审核接口',
  /case 'resourceQueue'/.test(cloudSrc) && /case 'resourceReview'/.test(cloudSrc));
ok('resourceReview 被登记为写操作',
  /'postPin',(?: 'postPinOrder',)? 'setAdmin', 'cfgSave', 'resourceUrl', 'resourceReview'/.test(cloudSrc));
ok('通过后改成 normal',
  /status:\s*'normal'/.test(reviewFn) && /reviewStatus:\s*'approved'/.test(reviewFn));
ok('驳回写 rejected 并保留原因',
  /status:\s*'rejected'/.test(reviewFn) && /reviewReason:\s*reason/.test(reviewFn),
  '作者看不到为什么没通过');
ok('驳回必须写原因',
  /decision === 'reject' && !reason/.test(reviewFn));
ok('审核结果会通知上传者',
  /pushNotify\(rec\.openid/.test(reviewFn) && /资料审核通过/.test(reviewFn));
ok('pending 文件允许作者和审核员预览',
  /const mod = mine \? false : await isModerator\(openid\)/.test(urlFn),
  '审核员打不开待审文件就无法判断内容');
ok('「感谢」只对已公开资料开放',
  /\(rec\.status \|\| 'normal'\) !== 'normal'/.test(thanksFn)
  && !/mine && !\(await isModerator/.test(thanksFn),
  '审核中/驳回的资料不应该累计感谢');

console.log('\nB. 页面入口');
ok('资料页会请求待审核队列', /userApi\.resourceQueue\(\)/.test(js));
ok('资料页有通过与驳回动作',
  /resourceReview\(id, 'approve'/.test(js) && /resourceReview\(id, 'reject'/.test(js));
ok('普通用户看不到待审区', /wx:if="\{\{isMod\}\}"/.test(wxml));
ok('待审资料可打开 / 通过 / 驳回',
  /onOpenPending/.test(wxml) && /onApproveResource/.test(wxml) && /onRejectResource/.test(wxml));
ok('提交后明确告知需要审核',
  /提交后需审核/.test(wxml) && /审核通过后公开/.test(js));
ok('作者能看到「审核中 / 未通过」状态',
  /item\.statusText/.test(wxml) && /statusText/.test(cloudSrc));
ok('未通过原因会展示给作者',
  /item\.reviewReason/.test(wxml) && /reviewReason/.test(cloudSrc));

console.log('\n' + (fail ? '✗ ' : '✓ ') + '共 ' + (pass + fail) + ' 项，通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);