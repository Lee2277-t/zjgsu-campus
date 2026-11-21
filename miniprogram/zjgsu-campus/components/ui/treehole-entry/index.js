// components/ui/treehole-entry/index.js
// 迁移自 src/components/forum/TreeHoleEntryCard.vue
// 三套插画任选一套（默认 night-light / 小夜灯），主题面具已移除。
// Web 版用 mask 图标，这里换成线性 outline 插画 + 盾牌隐私提示。
//
// variant（卡片版式）：
//   hero（默认）—— 整宽横排：插画 + 文案 + 「进入」按钮 + 隐私胶囊，用在「我的」页和搜索态。
//   grid       —— 半宽竖排：插画在上、两行文案在下，用在论坛首屏的入口双卡里。
//     半宽只有约 343rpx，横排放不下插画 + 文案 + 按钮，改成竖排后
//     不需要牺牲任何一句文案。
const VARIANTS = {
  'night-light': '/assets/illustrations/treehole-night-light.svg',
  animal: '/assets/illustrations/treehole-animal.svg',
  'cloud-moon': '/assets/illustrations/treehole-cloud-moon.svg',
};

Component({
  properties: {
    variant: { type: String, value: 'hero' }, // hero | grid
    iconVariant: { type: String, value: 'night-light' },
    title: { type: String, value: '匿名树洞' },
    subtitle: { type: String, value: '说不出口的心事，可以放这里' },
  },

  data: {
    art: VARIANTS['night-light'],
  },

  observers: {
    'iconVariant': function (v) {
      this.setData({ art: VARIANTS[v] || VARIANTS['night-light'] });
    },
  },

  methods: {
    onTap() {
      this.triggerEvent('tap');
    },
  },
});
