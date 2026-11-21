// utils/store-draft.js —— 草稿（发帖 / 评价写到一半）
// 基础设施（KEYS / read / write / 墓碑 / 工具函数）统一来自 store-base.js；
// 跨模块调用通过 require 同级 store-* 模块获取，不跨文件改写逻辑。

const { KEYS, read, write } = require('./store-base.js');
const cloud = require('./cloud.js');

/* ---------------- 云端同步 ---------------- */

// 草稿上云的三条规则（和云函数 draftSave 一一对应，改一边要改两边）：
//   ① 后写者胜：updatedAt 大的那份赢，不做字段级合并 ——
//      半篇文字比丢一篇更糟
//   ② 删除留墓碑：云端回 removed 列表，本地照着删；
//      只回「还活着的」话，另一台设备会把删掉的草稿当成「还没上传」推回去
//   ③ 只推本机独有的：不整份覆盖云端，否则旧设备一同步就洗掉新设备刚写的内容

function cloudOn() {
  return !!(cloud.cfg.USE_CLOUD && cloud.ensureCloud());
}

function pushDraft(d) {
  if (!cloudOn() || !d || !d.id) return Promise.resolve(null);
  return cloud.callFunction('draftSave', { draft: d }).catch(() => null);
}

function pushRemove(id) {
  if (!cloudOn() || !id) return Promise.resolve(null);
  return cloud.callFunction('draftRemove', { id: id }).catch(() => null);
}

// 拉云端并合并。返回 { ok, count } / { ok:false, degraded } —— 
// degraded 时调用方不能拿空列表去覆盖本地（那等于把用户写到一半的东西删了）
async function pullDrafts() {
  if (!cloudOn()) return { ok: false, skipped: true };
  const r = await cloud.callFunction('draftList');
  if (!r || r.ok === false || !Array.isArray(r.list)) return { ok: false, degraded: true };

  const removed = {};
  (r.removed || []).forEach((id) => { removed[String(id)] = true; });

  const merged = {};
  getDrafts().forEach((d) => {
    // 云端有墓碑 = 这条在别的设备上删了，本机也得删，且不许再推上去
    if (!removed[d.id]) merged[d.id] = d;
  });
  r.list.forEach((rd) => {
    const ld = merged[rd.id];
    if (!ld || (Number(rd.updatedAt) || 0) >= (Number(ld.updatedAt) || 0)) {
      merged[rd.id] = Object.assign({}, rd);
    }
  });

  const list = Object.keys(merged).map((k) => merged[k])
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, 20);
  write(KEYS.drafts, list);

  // 本机独有 / 本地更新的推上去（不 await：草稿箱要先出内容，不是等网络）
  const remoteAt = {};
  r.list.forEach((rd) => { remoteAt[rd.id] = Number(rd.updatedAt) || 0; });
  list.forEach((d) => {
    if (remoteAt[d.id] === undefined || (Number(d.updatedAt) || 0) > remoteAt[d.id]) {
      pushDraft(d).catch(() => {});
    }
  });
  return { ok: true, count: list.length };
}

/* ---------------- 草稿 ---------------- */

function getDrafts() {
  const list = read(KEYS.drafts, []);
  return Array.isArray(list) ? list : [];
}

// 标题和正文都空的东西不算草稿：连着误触点两下会攒出一堆垃圾
function hasDraftText(d) {
  return !!(String((d && d.title) || '').trim() || String((d && d.content) || '').trim());
}

// draft: { type:'post'|'review', board, courseId, courseName, title, content, tags }
// 有 id 就更新原来那条，没有就新建；同一个「类型+业务 id」永远只留一份
function saveDraft(draft) {
  const d = Object.assign({}, draft || {});
  if (!hasDraftText(d)) return getDrafts();
  // 课程关联必须一起存。以前只存了 board，恢复草稿后课程链接丢了，
  // 用户改完一切点发布，被「先选一门课程」卡住 —— 表现就是「草稿恢复后来发不出去」
  d.courseId = String(d.courseId || '');
  d.courseName = String(d.courseName || '');
  d.type = d.type || 'post';
  d.title = String(d.title || '');
  d.content = String(d.content || '');
  // 页面每次点「存草稿」都新建，不带 id。所以除了按 id 认人，
  // 还得按「类型+标题+正文」认：连点两下、或者改了又改回来，
  // 都该更新原来那条，而不是在草稿箱里攒出一堆看起来一模一样的重复条目。
  const exist = getDrafts().find((x) => x.id && x.id === d.id)
    || getDrafts().find((x) => x.type === d.type && x.title === d.title && x.content === d.content);
  d.id = exist ? exist.id : ('d' + Date.now() + Math.floor(Math.random() * 1000));
  d.updatedAt = Date.now();
  const rest = getDrafts().filter((x) => x.id !== d.id);
  rest.unshift(d);
  // 草稿上限 20 条：再多说明是反复犹豫，留着反而碍事
  write(KEYS.drafts, rest.slice(0, 20));
  // 本地先落，再推云端：写草稿不该等网络。推失败也不提示 ——
  // 草稿本来就在本机，下次保存 / 打开草稿箱时会再试
  pushDraft(d).catch(() => {});
  return d;
}

function getDraft(id) {
  return getDrafts().find((d) => d.id === id) || null;
}

function removeDraft(id) {
  write(KEYS.drafts, getDrafts().filter((d) => d.id !== id));
  // 云端打墓碑（不是物理删）：另一台设备同步时才认得出「这是删了」
  pushRemove(id).catch(() => {});
  return true;
}

function clearDrafts() {
  const all = getDrafts();
  write(KEYS.drafts, []);
  all.forEach((d) => { pushRemove(d.id).catch(() => {}); });
  return [];
}

module.exports = {
  getDrafts,
  hasDraftText,
  saveDraft,
  getDraft,
  removeDraft,
  clearDrafts,
  pullDrafts,
  pushDraft
};
