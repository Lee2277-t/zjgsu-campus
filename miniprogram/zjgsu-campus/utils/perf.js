// utils/perf.js —— 交互性能小工具：节流 + 结果缓存
//
// 为什么单独抽一层：
//   列表页的「切分类 / 切板块 / 换排序」三件事，本质上都是「点一下 → 重新过滤
//   全量数据 → 重新排序 → setData 一大片」。这段代码本身不慢，慢在它被触发得太频繁：
//     ① 手指连点、胶囊组件连发 change，同一帧里能跑两三遍；
//     ② 每次从别的页面退回来（onShow）都要重算一遍，哪怕数据一条没变；
//     ③ 切分类时顺手又去云端拉一次，等于把「本地点一下」变成了「一次网络往返」。
//   节流治 ①，缓存治 ②，把网络调用挪出切换路径治 ③。三件事都在这层提供工具。

/* ---------------- 节流 ---------------- */

/**
 * 节流：一段时间内只执行一次，但**最后一次点击不会丢**。
 *
 * 为什么不是「丢弃重复点击」（leading only）：
 *   用户快速点了 A 又点了 B，只认第一次的话界面停在 A，看着就像 B 没点上。
 *   这里按 lodash 的做法：开头立刻执行一次，间隔内再触发就在间隔末尾用**最新参数**
 *   补一次 —— 连点 A→B 最终停在 B，且中间只多跑一次。
 *
 * @param {Function} fn 真正要跑的函数
 * @param {number} wait 间隔（毫秒），默认 300
 * @returns {Function} 包好的函数，可直接挂到 bindtap
 */
function throttle(fn, wait) {
  const gap = Number(wait) || 300;
  let last = 0;
  let timer = null;
  let pendingArgs = null;
  let pendingCtx = null;

  function run(ctx, args) {
    last = Date.now();
    timer = null;
    pendingArgs = null;
    pendingCtx = null;
    fn.apply(ctx, args);
  }

  return function throttled() {
    const now = Date.now();
    const left = gap - (now - last);
    pendingArgs = Array.prototype.slice.call(arguments);
    pendingCtx = this;

    if (left <= 0) {
      // 间隔已过：立刻跑。之前的补跑计划作废，避免连点后补出一串
      if (timer) { clearTimeout(timer); timer = null; }
      run(pendingCtx, pendingArgs);
    } else if (!timer) {
      // 间隔内第一次重复触发：排一个补跑，用的是触发那一刻的最新参数
      timer = setTimeout(() => run(pendingCtx, pendingArgs), left);
    }
    // 间隔内第 N 次触发：只更新 pendingArgs，补跑时用最后一次的参数
  };
}

/* ---------------- 结果缓存 ---------------- */

/**
 * 建一个「有上限」的结果缓存。
 *
 * 为什么要有上限：筛选结果里存着整份列表的引用，板块 × 排序 × 课程 组合一多，
 * 缓存自己就变成内存负担。满了就淘汰一半最久没用过的（近似 LRU）。
 *
 * ⚠️ 缓存里存的是引用，调用方**不要**就地改里面的对象；
 *    需要改就先复制一份（列表页渲染前本来就要 map 出新数组）。
 *
 * @param {number} limit 最多存几份，默认 12
 */
function createCache(limit) {
  const max = Math.max(1, Number(limit) || 12);
  const map = {};

  function trim() {
    const keys = Object.keys(map);
    if (keys.length <= max) return;
    keys.sort((a, b) => (map[a].used || 0) - (map[b].used || 0));
    const drop = Math.ceil(max / 2);
    for (let i = 0; i < drop && i < keys.length; i += 1) delete map[keys[i]];
  }

  return {
    get(k) {
      const hit = map[k];
      if (!hit) return undefined;
      hit.used = Date.now();
      return hit.value;
    },
    set(k, v) {
      map[k] = { value: v, used: Date.now() };
      trim();
      return v;
    },
    has(k) {
      return Object.prototype.hasOwnProperty.call(map, k);
    },
    clear() {
      Object.keys(map).forEach((k) => { delete map[k]; });
    },
    size() {
      return Object.keys(map).length;
    }
  };
}

module.exports = {
  throttle,
  createCache
};
