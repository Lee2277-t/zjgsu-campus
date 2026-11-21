// sub/mine/drafts/drafts.js —— 草稿箱
// 草稿只有「跳回对应编辑页继续写」这一件事，所以这里只管列出和转发，
// 真正恢复在 post.js / review / market/edit 里按 draftId 取。
const store = require('../../../utils/store.js');
const nav = require('../../../utils/nav.js');

// 每种草稿通往哪去，写在一处，免得页面里散落一堆路径字符串
function targetOf(type) {
  if (type === 'review') return '/sub/course/review/review';
  if (type === 'market') return '/sub/market/edit/edit';
  if (type === 'hole') return '/sub/forum/hole/hole';
  return '/sub/forum/post/post';
}

function typeLabel(type) {
  if (type === 'review') return '课程评价';
  if (type === 'market') return '失物闲置';
  if (type === 'hole') return '匿名树洞';
  return '论坛';
}

Page({
  data: {
    items: [],
    loading: true
  },

  onShow() {
    // 先出本机那份（秒开），再从云端补一次：换设备 / 重装后草稿只在云端，
    // 不补的话这页永远是空的，而用户会以为「草稿丢了」
    this.load();
    this.sync();
  },

  async sync() {
    const r = await store.pullDrafts();
    // 拉不到就保持本机那份，不要因为一次网络失败把列表清空
    if (r && r.ok) this.load();
  },

  load() {
    const items = store.getDrafts().map((d) => ({
      id: d.id,
      type: d.type,
      typeName: typeLabel(d.type),
      title: d.title || '（没写标题）',
      preview: d.content || '（没写正文）',
      time: d.updatedAt ? stamp(d.updatedAt) : ''
    }));
    this.setData({ items: items, loading: false });
  },

  open(e) {
    const d = e.currentTarget.dataset;
    nav.go({
      url: targetOf(d.type) + '?draftId=' + d.id
    });
  },

  remove(e) {
    const d = e.currentTarget.dataset;
    wx.showModal({
      title: '删掉这篇草稿',
      content: '删了就找不回来了，确定吗？',
      confirmColor: '#d9534f',
      success: (res) => {
        if (!res.confirm) return;
        store.removeDraft(d.id);
        this.load();
      }
    });
  },

  clear() {
    if (!this.data.items.length) return;
    wx.showModal({
      title: '清空草稿箱',
      content: '全部草稿都会被删掉，确定吗？',
      confirmColor: '#d9534f',
      success: (res) => {
        if (!res.confirm) return;
        store.clearDrafts();
        this.load();
      }
    });
  }
});

// 草稿时间只显示到「月日 时:分」：说不清什么时候写的反而更该看清具体时间
function stamp(ts) {
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '';
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
