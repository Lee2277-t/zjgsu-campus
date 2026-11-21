// utils/pager.js —— 列表分页（本地切片）
//
// 这个小程序里的列表数据基本都是「一次拉全量到本地、再渲染」的模式：
//   校园活动 = 云端一次给 100 条、学习资料 = 云端 limit 60、我的帖子和同学名单 = 本机存储。
// 所以分页要解决的不是「再发一次网络请求」，而是「别一次渲染几十上百条」——
// 一次 setData 几百条卡片，滚动会明显掉帧，这是真机上的实际卡顿来源，不是理论问题。
//
// 为什么不各自在页面里写 `slice(0, n)`：
//   这个写法四处都要重复，而它有几个容易漏的边界 —— 切筛选时忘了把页码归零、
//   到底了还在响应触底、并发触底时重复 setData。分散写四处，就会漏四处不同的。
//   收在这里，行为只在这里测一遍。
//
// ⚠️ 这里只管「切多少条」，不碰网络。真正需要向云端要下一页的
//    （目前只有论坛 loadMorePosts）仍然由页面自己负责。

const DEFAULT_SIZE = 20;

// 每页条数。20 条是卡片列表在手机上一屏半的量：
// 太少的话每次触底都要等，太多就又回到一次渲染太多的问题。
function create(size) {
  const step = Math.max(1, Number(size) || DEFAULT_SIZE);
  let all = [];
  let shown = 0;

  function view() {
    // 这一批是不是真的分了页。只有 3 条结果时也显示「已经到底啦」的话，
    // 那行字是纯粹的噪音，还会让人以为下面本来还有东西。
    const paged = all.length > step;
    return {
      list: all.slice(0, shown),
      total: all.length,
      // 还有没显示出来的
      hasMore: shown < all.length,
      // 已经全部显示了（列表本来就是空的时候也算到底，模板据此不显示「加载中」）
      noMore: all.length > 0 && shown >= all.length,
      // 模板直接拿这两个：paged 决定「到底」那一整行出不出现，
      // 免得每个页面各写一遍 total > 20 把页大小硬编码进模板
      paged: paged,
      done: paged && shown >= all.length
    };
  }

  return {
    // 换列表 / 换筛选条件时调用。页码必须归零 ——
    // 从「全部」切到「只看笔记」时如果还留着上次的 shown，
    // 会出现「筛选后结果明明只有 3 条，却直接全显示、且底部写着加载中」。
    reset(list) {
      all = Array.isArray(list) ? list.slice() : [];
      shown = Math.min(step, all.length);
      return view();
    },

    // 内容刷新但**不该**把用户弹回顶部时用（比如从详情页退回来重算红点）。
    // 这时候列表内容变了、但用户已经展开的进度要留着，
    // 否则每看一条帖子回来都要重新滑一遍 —— 分页反而添了麻烦。
    //
    // ⚠️ 新列表比已显示的还短时，要跟着缩回去，
    //    不然 shown 还停在 60，而 list 只有 5 条，底部会永远写着「加载中」。
    keep(list) {
      const prev = shown;
      all = Array.isArray(list) ? list.slice() : [];
      shown = Math.min(Math.max(prev, step), all.length);
      return view();
    },

    // 全量。页面里凡是「对列表全体做操作」的地方都必须用这个，
    // 不能用已经切过片的 data.list ——
    // 最典型的就是「清空」：分页之后 data.list 只有前 20 条，
    // 照着它删，剩下的会被悄悄留下，而界面上还提示「已清空」。
    all: () => all.slice(),

    // 触底时调用。已经到底了返回 null，调用方据此不做事 ——
    // 不返回 null 的话，到底之后再滑一次会白跑一次 setData，
    // 界面上「已经到底啦」也会跟着闪一下。
    more() {
      if (shown >= all.length) return null;
      shown = Math.min(all.length, shown + step);
      return view();
    },

    // 当前状态（页面 onLoad 之后、或者只是想读一下时用）
    view: view,

    // 每页条数，页面要在空态里如实说出来时才用得上
    size: step
  };
}

module.exports = { create, DEFAULT_SIZE };
