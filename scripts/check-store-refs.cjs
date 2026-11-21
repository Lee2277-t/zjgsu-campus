/* 静态交叉引用检查（数据层模块化专用）
 * 作用：扫描 utils/store-*.js 之间「用了某个顶层名字，却没 require 进来」的情况。
 *      拆单文件为多模块时，最容易漏的就是跨模块引用的顶层常量（PAGE_SIZE / SEED_VERSION …）
 *      和共享工具函数（today / genId / searchCore …），漏了就是真机 ReferenceError。
 *
 * 用法：node scripts/check-store-refs.cjs
 * 说明：纯静态文本分析（去注释/字符串后按标识符匹配），命中即需人工确认，属高置信度告警。
 */
const fs = require('fs');
const path = require('path');

// 项目根 = 本脚本上一级（recon/），数据层目录相对定位，换机器也能跑
const UTIL = path.resolve(__dirname, '..', 'miniprogram', 'zjgsu-campus', 'utils');
const MODS = ['store-base', 'store-user', 'store-course', 'store-forum', 'store-sync', 'store-search', 'store-favorite', 'store-draft'];

// ---- 1. 去掉注释与字符串字面量，只留代码骨架 ----
function strip(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      out += '""';
      continue;
    }
    out += c; i++;
  }
  return out;
}

// ---- 2. 收集「顶层声明」/「require 进来的」/「module.exports 列出的」名字 ----
function topDecls(code) {
  const names = new Set();
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)|^class\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code))) names.add(m[1] || m[2] || m[3]);
  return names;
}
function imported(code) {
  const names = new Set();
  const re = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(/g;
  let m;
  while ((m = re.exec(code))) {
    m[1].split(',').forEach((s) => {
      const t = s.split(':').pop().trim();
      if (t) names.add(t);
    });
  }
  return names;
}
function exported(code) {
  const names = new Set();
  const re = /module\.exports\s*=\s*\{([\s\S]*?)\n\};/g;
  let m;
  while ((m = re.exec(code))) {
    m[1].split(/[,\n]/).forEach((s) => {
      const t = s.replace(/\/\/.*/, '').split(':')[0].trim();
      if (t && /^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    });
  }
  return names;
}

// ---- 3. JS 内建/宿主全局，不计入 ----
const GLOBALS = new Set(['wx', 'console', 'module', 'exports', 'require', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Math', 'JSON', 'Date', 'Promise', 'Set', 'Map', 'RegExp', 'Error', 'TypeError', 'isNaN', 'parseInt', 'parseFloat',
  'undefined', 'null', 'true', 'false', 'this', 'arguments', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout',
  'clearTimeout', 'getApp', 'globalThis', 'Symbol', 'async', 'await', 'function', 'return', 'if', 'else']);

const info = {};
MODS.forEach((mn) => {
  const code = strip(fs.readFileSync(path.join(UTIL, mn + '.js'), 'utf8'));
  info[mn] = { code, own: topDecls(code), imp: imported(code), exp: exported(code) };
});

let problems = 0;
MODS.forEach((mn) => {
  const me = info[mn];
  const available = new Set([...me.own, ...me.imp, ...me.exp]);   // 本模块可用的名字
  MODS.forEach((on) => {
    if (on === mn) return;
    const other = info[on];
    const provided = new Set([...other.own, ...other.exp]);       // 该模块提供的名字
    provided.forEach((name) => {
      if (GLOBALS.has(name)) return;
      if (available.has(name)) return;
      const used = new RegExp('(^|[^\\w$.])' + name.replace(/\$/g, '\\$') + '([^\\w$]|$)', 'm').test(me.code);
      if (used) {
        problems++;
        console.log(`❌ ${mn}.js 用到了 ${name}（定义/导出在 ${on}.js），但未 require 进来`);
      }
    });
  });
});

console.log(problems ? `\n共发现 ${problems} 处潜在漏引` : '\n✅ 未发现跨模块漏引');
process.exit(problems ? 1 : 0);
