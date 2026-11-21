// scripts/cloud-source.cjs —— 回退版云函数源码读取
const fs = require('fs');
const path = require('path');
const base = path.join(__dirname, '..', 'miniprogram', 'zjgsu-campus', 'cloudfunctions', 'user');
const files = ['index.js', 'report-votes.js', 'report-rules.js'];
module.exports = function readCloudSource() {
  return files.map((f) => fs.readFileSync(path.join(base, f), 'utf8')).join('\n\n');
};
