// utils/place-search.js —— 校园地点的搜索口径
//
// 为什么要单独一个模块：搜索在两个地方都要用 ——
//   ① pages/campus/campus.wxml 的「地点地图」那一档（列表就摆在那儿）
//   ② pages/tool/places/places 完整页（带地图）
// 两份各写一份的结果是「同一个词，两个页面搜出来的不一样」，
// 而且这种不一致不会报错，只会让人觉得「怎么有时候搜不到」。
//
// 口径（改动前先读完这段）：
//   - 命中字段：名字 / 简介 / 地址 / 分类，任一命中就算。地点数据里没有别的可搜的了。
//   - 多个词之间是「且」：「2号 教学楼」两个词都得有。
//   - 忽略空格差异：库里存「2 号教学楼」，同学多半敲「2号教学楼」——
//     只比原文的话这种最顺手的输入一条都搜不到，看着就像坏了。
//   - 英文不区分大小写；支持少字、错字、乱序和常见叫法（如“二教”→B教学楼）。
//   - **有关键词时不叠加分类**：想找「2 号教学楼」的人不会先想它属于哪个分类，
//     叠着筛只会出现「明明有，却搜不到」。

const searchCore = require('./search.js');

// 常见叫法 / 缩写 / 拼音。只做明确的地名别名，不做无边界的同义词扩展。
const PLACE_ALIASES = {
  'a楼': 'a教学楼', 'a座': 'a教学楼', 'a教': 'a教学楼', '一教': 'a教学楼',
  'b楼': 'b教学楼', 'b座': 'b教学楼', 'b教': 'b教学楼', '二教': 'b教学楼',
  'c楼': 'c教学楼', 'c座': 'c教学楼', 'c教': 'c教学楼', '三教': 'c教学楼',
  'd楼': 'd教学楼', 'd座': 'd教学楼', 'd教': 'd教学楼', '四教': 'd教学楼',
  'e楼': 'e教学楼', 'e座': 'e教学楼', 'e教': 'e教学楼', '五教': 'e教学楼',
  'f楼': 'f教学楼', 'f座': 'f教学楼', 'f教': 'f教学楼', '六教': 'f教学楼',
  'tushuguan': '图书馆', 'tsg': '图书馆',
  'shitang': '食堂', 'st': '食堂',
  'jiaoxuelou': '教学楼', 'jxl': '教学楼',
  'sushe': '宿舍', 'ss': '宿舍',
  'kuaidi': '快递', 'kd': '快递',
  'yundong': '运动', 'yd': '运动',
  'xiaoyiyuan': '校医院', 'xyy': '校医院',
  'tineng': '体育中心', 'tiyu': '体育中心'
};

function compact(s) {
  return String(s || '').toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[·,，。.!！?？:：;；\-—_/\\|（）()\[\]【】《》<>“”"']/g, '');
}

// 单词匹配：先按原文/空格差异找，再走全站同一套模糊内核（包含 / 错字 / 乱序 / 少字）。
// 只在“地名”主字段上放宽，地址、简介、分类仍然只做包含匹配，避免搜“食堂”把全校都捞出来。
function matchWord(p, word) {
  const w = compact(word);
  if (!w) return true;
  const fields = [p && p.name, p && p.desc, p && p.address, p && p.category];
  const packed = fields.map(compact);
  const hay = packed.join(' ');
  if (hay.indexOf(w) >= 0) return true;
  const rank = searchCore.matchFields([packed[0], packed[1], packed[2], packed[3]], w);
  return rank >= 0;
}

function matchPlace(p, kw) {
  const raw = String(kw || '').trim().toLowerCase();
  if (!raw) return true;
  // 别名（二教 / b楼 / tsg）只认目标词本身，不再走字符模糊，
  // 否则“二教”→“B教学楼”会把 A 教学楼也算成 3/4 字命中。
  const cleaned = raw.replace(/(在哪|在哪里|怎么走|位置|地址|地图)/g, '').trim();
  const base = compact(cleaned);
  const alias = PLACE_ALIASES[base];
  if (alias) {
    const target = compact(alias);
    return [p && p.name, p && p.desc, p && p.address, p && p.category]
      .map(compact).some((f) => f.indexOf(target) >= 0);
  }
  const words = cleaned.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    if (!matchWord(p, words[i])) return false;
  }
  return true;
}

// 分类 + 关键词一起过。有关键词时分类不起作用（见文件头最后一条）
function filterPlaces(list, cat, kw) {
  const k = String(kw || '').trim();
  const c = k ? '' : String(cat || '');
  return (list || []).filter((p) => {
    if (c && c !== '全部' && (p.category || '其他') !== c) return false;
    return matchPlace(p, k);
  });
}

module.exports = { matchPlace: matchPlace, filterPlaces: filterPlaces };
