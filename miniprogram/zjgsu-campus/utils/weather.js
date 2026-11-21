// utils/weather.js —— 今日 + 明日天气（杭州·钱塘区）
//
// 数据源：Open-Meteo 公共天气预报 API（免密钥、走 HTTPS、按经纬度取逐日预报）。
//
// ⚠️ 取数路径是「云函数中转 → 直连兜底」，顺序不能反：
//    小程序在体验版 / 正式版会强制校验 request 合法域名，前端直连第三方接口
//    一旦没在后台配过就会被拦掉 —— 表现正是「开发工具里正常，体验版没反应」。
//    云函数出网不受这个限制，前端只调自己的云函数，永远合法。
//    直连只作为云函数没部署 / 报错时的兜底（开发工具里勾了「不校验域名」也能用）。
//
// 取不到天气时一律返回 { ok: false }，调用方负责不渲染 ——
// 天气是锦上添花的东西，绝不能因为它挂了让页面报错或空白。
const API = 'https://api.open-meteo.com/v1/forecast';
// 钱塘区区政府一带（下沙）
const LAT = 30.3167;
const LON = 120.5530;
const CACHE_KEY = 'zjgsu_weather_cache_v2';
// 缓存 3 小时：天气一天变不了几次，没必要每次进页面都打一次网络请求
const CACHE_TTL = 3 * 3600 * 1000;
// 云函数那一趟最多等 8 秒：启动弹窗也在等它，卡久了弹窗会迟迟不出现
const CLOUD_TIMEOUT_MS = 8000;
const REQ_TIMEOUT_MS = 6000;

// WMO 天气代码 → 中文。Open-Meteo 返回的是国际标准代码，得自己翻成人话
function codeText(code) {
  const c = Number(code);
  if (c === 0) return '晴';
  if (c === 1) return '少云';
  if (c === 2) return '多云';
  if (c === 3) return '阴';
  if (c === 45 || c === 48) return '有雾';
  if (c >= 51 && c <= 55) return '毛毛雨';
  if (c >= 56 && c <= 57) return '冻雨';
  if (c === 61) return '小雨';
  if (c === 63) return '中雨';
  if (c === 65) return '大雨';
  if (c >= 66 && c <= 67) return '冻雨';
  if (c === 71) return '小雪';
  if (c === 73) return '中雪';
  if (c === 75) return '大雪';
  if (c === 77) return '米雪';
  if (c >= 80 && c <= 82) return '阵雨';
  if (c >= 85 && c <= 86) return '阵雪';
  if (c === 95) return '雷阵雨';
  if (c >= 96 && c <= 99) return '雷阵雨伴冰雹';
  return '';
}

// 暖心文案池：随机抽一句。分冷/常两档 —— 大冷天给人一句「出去走走」不太合时宜
const WARM_TIPS = [
  '出门前看一眼天，别被淋着~',
  '天气不错，下课出去走走吧~',
  '早晚温差大，别感冒了~',
  '新的一天，慢慢来~',
  '记得喝水，好好吃饭~',
  '课再多，也别忘了抬头看看天~',
  '愿你今天遇到的都是好消息~',
  '路上注意安全呀~',
  '阳光正好，适合给自己加个鸡腿~',
  '今天也要开开心心的呀~',
  '别忘了给家里打个电话~',
  '忙完这阵，就去吃点喜欢的~'
];

const COLD_TIPS = [
  '记得添件衣服哦~',
  '天冷了，多穿一件别硬扛~',
  '手脚容易凉，记得带杯热的~',
  '风大，围巾帽子可以出场了~',
  '早晚最冷，别为了好看少穿~',
  '室内外温差大，进出记得加减衣服~',
  '降温了，外套记得带上~',
  '冷风一吹，帽子围巾安排上~',
  '手冷的话，揣兜里或带个暖手宝~',
  '回宿舍先喝口热的，暖暖身子~',
  '今天冷，秋裤可以不用硬撑了~',
  '早上出门冷，记得穿厚一点~'
];

// 按「今天」的气温挑一档文案再随机抽：冷天优先说保暖，其余日子随机
function pickTip(temp) {
  const pool = (typeof temp === 'number' && temp <= 12) ? COLD_TIPS : WARM_TIPS;
  const i = Math.floor(Math.random() * pool.length);
  return pool[Math.min(i, pool.length - 1)];
}

function readCache() {
  try {
    const c = wx.getStorageSync(CACHE_KEY);
    if (c && c.at && (Date.now() - Number(c.at)) < CACHE_TTL) return c;
  } catch (e) { /* 缓存坏了就当没有 */ }
  return null;
}

function writeCache(v) {
  try { wx.setStorageSync(CACHE_KEY, v); } catch (e) { /* 存不下不影响使用 */ }
}

// 把接口给的原始一天（code/max/min）翻成能直接上屏的样子。
// 拿不到就返回 null，调用方负责「这一格不显示」——绝不显示 undefined 或 NaN
function normalize(day) {
  if (!day || day.code === null || typeof day.code === 'undefined') return null;
  const desc = codeText(day.code);
  const max = typeof day.max === 'number' ? Math.round(day.max) : null;
  const min = typeof day.min === 'number' ? Math.round(day.min) : null;
  // 只显示最高温：一行里塞两个数（18~9℃）反而要停下来读
  const text = (desc && max !== null) ? (desc + ' ' + max + '℃')
    : (desc || (max !== null ? max + '℃' : ''));
  if (!text) return null;
  return {
    ok: true,
    date: day.date || '',
    desc: desc,
    max: max,
    min: min,
    // 最低温直接给成现成的字符串：WXML 里判断 null 太别扭，
    // 没有就给空串，模板用 wx:if="{{x.minText}}" 一句话搞定
    minText: (min !== null && max !== null && min !== max) ? ('最低 ' + min + '℃') : '',
    text: text
  };
}

// 组装最终交给页面的数据：今日 / 明日各一份 + 一句暖心话 + 弹窗整句
function buildPayload(today, tomorrow) {
  const t = normalize(today);
  const m = normalize(tomorrow);
  if (!t && !m) return { ok: false };
  // 文案跟着「今天」走：提醒的是眼前这一天
  const tip = pickTip(t && typeof t.max === 'number' ? t.max : (m ? m.max : null));
  const parts = [];
  if (t) parts.push('今日天气' + t.text);
  if (m) parts.push('明日天气' + m.text);
  const sentence = parts.length ? (parts.join('，') + '，' + tip) : '';
  return {
    ok: true,
    today: t,
    tomorrow: m,
    tip: tip,
    // 弹窗里那句现成的话，调用方直接拼就行
    sentence: sentence,
    at: Date.now()
  };
}

// 兜底路径：前端直连 API。只有云函数那条路走不通时才用
function fetchDirect() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done({ ok: false }), REQ_TIMEOUT_MS);
    wx.request({
      url: API,
      data: {
        latitude: LAT,
        longitude: LON,
        daily: 'weather_code,temperature_2m_max,temperature_2m_min',
        timezone: 'Asia/Shanghai',
        forecast_days: 2
      },
      timeout: REQ_TIMEOUT_MS,
      success: (res) => {
        clearTimeout(timer);
        try {
          const d = (res && res.data && res.data.daily) || {};
          const codes = d.weather_code || [];
          const maxs = d.temperature_2m_max || [];
          const mins = d.temperature_2m_min || [];
          const dates = d.time || [];
          if (!codes.length) { done({ ok: false }); return; }
          done(buildPayload(
            { date: dates[0], code: codes[0], max: maxs[0], min: mins[0] },
            codes.length > 1
              ? { date: dates[1], code: codes[1], max: maxs[1], min: mins[1] }
              : null
          ));
        } catch (e) {
          done({ ok: false });
        }
      },
      fail: () => { clearTimeout(timer); done({ ok: false }); }
    });
  });
}

// 主路径：问自己的云函数要天气（不受 request 合法域名限制）
function fetchViaCloud() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done({ ok: false }), CLOUD_TIMEOUT_MS);
    let api = null;
    try {
      // 惰性 require：云函数没部署时不该让引入就崩，
      // 这一层的所有失败都必须收在这里，不能冒到页面上
      api = require('./user.js');
    } catch (e) {
      clearTimeout(timer);
      done({ ok: false });
      return;
    }
    Promise.resolve(api.weather())
      .then((r) => {
        clearTimeout(timer);
        if (!r || r.ok === false || !r.today) { done({ ok: false }); return; }
        done(buildPayload(r.today, r.tomorrow || null));
      })
      .catch(() => { clearTimeout(timer); done({ ok: false }); });
  });
}

// 取今日 + 明日天气。永远 resolve（失败给 { ok:false }），不抛错
async function fetchWeather() {
  const hit = readCache();
  if (hit) return hit;

  const viaCloud = await fetchViaCloud();
  if (viaCloud && viaCloud.ok) {
    writeCache(viaCloud);
    return viaCloud;
  }
  // 云函数那条路没走通（没部署 / 报错 / 超时）：再试一次直连。
  // 开发工具里勾了「不校验合法域名」时这条路能出数，不至于整块空白
  const direct = await fetchDirect();
  if (direct && direct.ok) writeCache(direct);
  return direct || { ok: false };
}

// 兼容旧调用方：只想要明天那一格时用它
async function fetchTomorrow() {
  const w = await fetchWeather();
  if (!w || !w.ok) return { ok: false };
  return Object.assign({}, w, {
    // 老字段：desc / max / min / text 指向明日
    desc: w.tomorrow ? w.tomorrow.desc : '',
    max: w.tomorrow ? w.tomorrow.max : null,
    min: w.tomorrow ? w.tomorrow.min : null,
    text: w.tomorrow ? w.tomorrow.text : '',
    minText: w.tomorrow ? w.tomorrow.minText : '',
    sentence: w.tomorrow ? ('明日天气是' + w.tomorrow.text + '，' + w.tip) : ''
  });
}

// 同步拿一份（可能为空）：页面 onShow 时先摆上缓存里的旧值，网络结果回来再覆盖。
// 这样天气卡不会先空一块再突然冒出来
function peek() {
  const c = readCache();
  return c && c.ok ? c : null;
}

module.exports = { fetchWeather, fetchTomorrow, peek, pickTip, codeText, normalize };
