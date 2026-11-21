// utils/markdown.js —— 官网正文的轻量 Markdown → rich-text 节点
//
// 不引入第三方 Markdown 库：官网正文只用到标题、段落、列表、链接、图片和少量加粗，
// 一套小解析器足够，也不会把主包再撑大。
// 输出直接给 <rich-text nodes="{{nodes}}"> 使用。

const P_STYLE = 'font-size:15px;line-height:1.75;color:#374151;margin:0 0 8px;';
const H_STYLE = 'font-size:17px;line-height:1.5;font-weight:600;color:#1f2937;margin:14px 0 8px;';
const LI_STYLE = 'font-size:15px;line-height:1.7;color:#374151;margin:0 0 4px;';
const QUOTE_STYLE = 'border-left:3px solid #dbeafe;padding-left:10px;color:#6b7280;margin:8px 0;font-size:14px;line-height:1.7;';

function safeUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

function textNode(text) {
  return { type: 'text', text: String(text || '') };
}

function inlineNodes(text) {
  const src = String(text || '');
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(textNode(src.slice(last, m.index)));
    const t = m[0];
    if (t.slice(0, 2) === '**') {
      out.push({ name: 'strong', attrs: { style: 'font-weight:600;' }, children: [textNode(t.slice(2, -2))] });
    } else if (t.charAt(0) === '`') {
      out.push({ name: 'code', attrs: { style: 'font-size:14px;background:#f1f5f9;border-radius:4px;padding:0 4px;' }, children: [textNode(t.slice(1, -1))] });
    } else if (t.charAt(0) === '[') {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t);
      const url = mm ? safeUrl(mm[2]) : '';
      if (mm && url) {
        out.push({ name: 'a', attrs: { href: url, style: 'color:#2b5aed;' }, children: [textNode(mm[1])] });
      } else if (mm) {
        out.push(textNode(mm[1]));
      }
    } else {
      out.push({ name: 'em', attrs: { style: 'font-style:italic;' }, children: [textNode(t.slice(1, -1))] });
    }
    last = re.lastIndex;
  }
  if (last < src.length) out.push(textNode(src.slice(last)));
  return out;
}

function imgNode(line) {
  const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(String(line || '').trim());
  const url = m ? safeUrl(m[2]) : '';
  if (!url) return null;
  return {
    name: 'img',
    attrs: {
      src: url,
      alt: m[1] || '图片',
      style: 'max-width:100%;height:auto;display:block;margin:8px 0;border-radius:8px;'
    }
  };
}

function toNodes(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const nodes = [];
  let para = [];
  let list = null;
  let quote = [];

  const flushPara = () => {
    if (!para.length) return;
    nodes.push({ name: 'p', attrs: { style: P_STYLE }, children: inlineNodes(para.join(' ')) });
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    nodes.push({ name: list.type, attrs: { style: 'margin:6px 0 10px;padding-left:18px;' }, children: list.items });
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    nodes.push({ name: 'blockquote', attrs: { style: QUOTE_STYLE }, children: [textNode(quote.join(' '))] });
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  lines.forEach((raw) => {
    const line = String(raw || '').trim();
    if (!line) { flushAll(); return; }

    const img = imgNode(line);
    if (img) { flushAll(); nodes.push(img); return; }

    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      flushAll();
      nodes.push({ name: 'h3', attrs: { style: H_STYLE }, children: inlineNodes(h[2]) });
      return;
    }
    if (/^---+$/.test(line)) {
      flushAll();
      nodes.push({ name: 'div', attrs: { style: 'height:1px;background:#e5e7eb;margin:12px 0;' }, children: [] });
      return;
    }
    const ul = /^[-*]\s+(.+)$/.exec(line);
    const ol = /^\d+\.\s+(.+)$/.exec(line);
    if (ul || ol) {
      flushPara(); flushQuote();
      const type = ol ? 'ol' : 'ul';
      if (!list || list.type !== type) { flushList(); list = { type: type, items: [] }; }
      const item = (ol || ul)[1];
      list.items.push({ name: 'li', attrs: { style: LI_STYLE }, children: inlineNodes(item) });
      return;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) { flushPara(); flushList(); quote.push(q[1]); return; }

    flushList(); flushQuote();
    para.push(line);
  });
  flushAll();
  return nodes;
}

module.exports = { toNodes };