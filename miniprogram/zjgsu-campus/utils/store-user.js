// utils/store-user.js —— 用户资料（昵称 / 头像 / 格言）
// 基础设施（KEYS / read / write / 墓碑 / 工具函数）统一来自 store-base.js；
// 跨模块调用通过 require 同级 store-* 模块获取，不跨文件改写逻辑。

const { KEYS, read, write } = require('./store-base.js');

/* ---------------- 用户 ---------------- */

function getUser() {
  return read(KEYS.user, { nickName: '浙小商', avatar: '', motto: '浙江工商大学 · 在读' });
}
function setUser(user) {
  write(KEYS.user, user);
}

module.exports = {
  getUser,
  setUser
};
