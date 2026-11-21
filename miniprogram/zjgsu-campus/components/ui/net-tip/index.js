// components/ui/net-tip/index.js
// 「没读到」和「真的没有」是两件事，界面必须分开说。
//
// 以前列表页只有一种空态：拉取失败也显示「这个板块还没有帖子」——
// 用户看到的是一个我们并不知道结论的判断，于是退出重进、反复下拉，
// 而真正该做的是给一个能点的重试。
//
// 两种形态：
//   block = false（默认）—— 列表顶上一条细提示，列表里有缓存内容时用
//   block = true         —— 居中卡片，列表一条都渲染不出来时用
Component({
  properties: {
    show: { type: Boolean, value: false },
    block: { type: Boolean, value: false },
    title: { type: String, value: '网络不太顺，内容没拉下来' },
    desc: { type: String, value: '' },
    busy: { type: Boolean, value: false },
    busyText: { type: String, value: '正在重试' },
    retryText: { type: String, value: '重试' }
  },

  methods: {
    onRetry() {
      // 正在重试时不要再点：重试本身要发网络请求，连点只会堆一串请求
      if (this.data.busy) return;
      this.triggerEvent('retry');
    }
  }
});
