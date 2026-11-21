// 跑 miniprogram 下的 _syncheck.js。
// 为什么要一层壳：仓库根 package.json 有 "type":"module"，Node 顺着目录往上找到它，
// 会把 miniprogram 里的 .js 当 ESM 加载，_syncheck.js 第一行 require 就炸。
// 这里跟 scripts/check-page-load.cjs 一样，对 miniprogram 下的文件强制走 CommonJS 编译。
const fs = require('fs');
const path = require('path');
const Module = require('module');

const MP = path.resolve(__dirname, '..', 'miniprogram');
const orig = Module._extensions['.js'];
Module._extensions['.js'] = function (mod, filename) {
  if (filename.indexOf(MP) === 0) return mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return orig(mod, filename);
};

require(path.join(MP, 'zjgsu-campus', '_syncheck.js'));
