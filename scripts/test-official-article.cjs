// scripts/test-official-article.cjs —— 官网正文提取与 Markdown 渲染
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

function takeFn(text, name) {
  const start = text.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const brace = text.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return '';
}

const fns = [
  'decodeHtmlEntities', 'stripHtmlTags', 'sliceBalancedElement', 'fallbackArticleHtml', 'pickArticleHtml',
  'officialArticleUrl', 'htmlToMarkdown', 'extractOfficialArticle', 'toAbs', 'secureSchoolUrl'
].map((name) => takeFn(cloudSrc, name));
ok('取到了官网正文提取函数', fns.every((x) => x.length > 0));

const sandbox = { module: { exports: {} }, exports: {}, URL: URL };
vm.runInNewContext(fns.join('\n') + '\nmodule.exports = { pickArticleHtml, officialArticleUrl, htmlToMarkdown, extractOfficialArticle };', sandbox);
const api = sandbox.module.exports;

const newsHtml = `
<html><body>
<dl><dt>学校新闻</dt>
<dd id="the_content" style="font-size:16px"><p>第一段正文。</p><h2>小标题</h2><ul><li>甲</li><li>乙</li></ul><p><strong>加粗</strong>和<a href="/2/view_1.html">链接</a></p><img src="/images/a.jpg"></dd>
</dl></body></html>`;
const youthHtml = `
<html><body><div class="article" frag="窗口3"><div class="meta">发布者：某人</div><div class='wp_articlecontent'><div>正文第一段</div><p>第二段<strong>加粗</strong></p></div></div></body></html>`;

const newsContent = api.pickArticleHtml(newsHtml);
const youthContent = api.pickArticleHtml(youthHtml);
ok('提取 news 的 dd#the_content', newsContent.indexOf('第一段正文') >= 0 && newsContent.indexOf('学校新闻') < 0);
ok('提取 youth/xsc 的 wp_articlecontent 且避开外层元信息',
  youthContent.indexOf('正文第一段') >= 0 && youthContent.indexOf('发布者') < 0,
  youthContent.slice(0, 120));

const md = api.extractOfficialArticle(newsHtml, 'https://news.zjgsu.edu.cn/2/view_1.html').markdown;
ok('正文转成 Markdown 后有标题', /## 小标题/.test(md), md.slice(0, 120));
ok('正文转成 Markdown 后有列表', /- 甲/.test(md) && /- 乙/.test(md));
ok('正文转成 Markdown 后有加粗', /\*\*加粗\*\*/.test(md));
ok('正文转成 Markdown 后有站内绝对链接', /\[链接\]\(https:\/\/news\.zjgsu\.edu\.cn\/2\/view_1\.html\)/.test(md));
ok('正文转成 Markdown 后有绝对图片地址', /!\[图片\]\(https:\/\/news\.zjgsu\.edu\.cn\/images\/a\.jpg\)/.test(md));
ok('学校 http 图片升级为 https', /!\[图片\]\(https:\/\/news\.zjgsu\.edu\.cn\/upload\/a\.jpg\)/.test(api.htmlToMarkdown('<p><img src="http://news.zjgsu.edu.cn/upload/a.jpg"></p>', 'https://news.zjgsu.edu.cn/')));

ok('学校 http 链接升级为 https', /^https:\/\/tgb\.zjgsu\.edu\.cn/.test(api.officialArticleUrl('http://tgb.zjgsu.edu.cn/List-54.html')));
ok('拒绝外站链接', api.officialArticleUrl('https://example.com/a') === '');
const genericHtml = '<html><body><div class="foo-detail-text">' + ('这是一段没有命中已知 CMS 容器的正文。'.repeat(8)) + '</div><div class="nav-menu">导航</div></body></html>';
const generic = api.extractOfficialArticle(genericHtml, 'https://www.zjgsu.edu.cn/a.html');
ok('未知 CMS 容器也能兜底提取正文', generic.picked && generic.markdown.indexOf('没有命中') >= 0);

const mdSandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(read('sub/utils/markdown.js'), mdSandbox);
const nodes = mdSandbox.module.exports.toNodes('# 标题\n\n正文**加粗**\n\n- 甲\n- 乙\n\n![图](https://news.zjgsu.edu.cn/a.jpg)');
ok('Markdown 渲染出节点', nodes.length >= 4, nodes.length);
ok('Markdown 标题节点存在', nodes.some((n) => n.name === 'h3'));
ok('Markdown 列表节点存在', nodes.some((n) => n.name === 'ul' && n.children.length === 2));
ok('Markdown 图片节点存在', nodes.some((n) => n.name === 'img' && n.attrs.src.indexOf('https://') === 0));

ok('云端注册了 eventArticle 路由', /case 'eventArticle'/.test(cloudSrc));
ok('活动详情页有正文渲染容器', /rich-text[^>]*nodes="\{\{articleNodes\}\}"/.test(read('sub/campus/event/event.wxml')));
ok('活动列表剔除了 articleMd 大字段', /delete out\.articleMd/.test(cloudSrc));

console.log('\n' + (fail ? '✗ ' : '✓ ') + '共 ' + (pass + fail) + ' 项，通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);