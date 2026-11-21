// utils/friend.js —— 同学关系的两个动作：加为好友 / 解除好友
//
// 为什么单独一层，而不是把弹窗写在页面里：
// 「加好友」现在有**三个**触发点 —— 同学名片、找同学的搜索结果、私信发满 3 条之后。
// 三处都要走「问一句留言 → 调云函数 → 按回执说人话」这一套；
// 各写一遍的话，迟早出现「名片页会提示已发出、搜索结果页点了没反应」这种分叉，
// 而且文案会慢慢长歪（一边说「等对方同意」，一边说「已发送」）。
//
// 这里只管「一个加好友动作长什么样」，不管按钮摆在哪 ——
// 摆位是页面的事（刻意不给「好友」做独立入口，见 pages/user/card 与 friends）。
const userApi = require('../../../utils/user.js');
// 提示统一走反馈层：裸调 wx.showToast 会被同一时刻的 Loading 抹掉，也会被键盘挡住
const feedback = require('../../../utils/feedback.js');

// 非好友之间每人能发几条。**只用于文案**，权威值在云函数 STRANGER_QUOTA：
// 这里写大了不会放宽任何限制，只会让人以为「还能发」然后被打回来
const STRANGER_QUOTA = 3;

// 留言长度：和服务端 addRequest 的 slice(0, 50) 对齐。
// 两边不一致的话，用户打了 60 字、发送时被悄悄砍掉 10 字，他会以为对方看到的是全的
const MESSAGE_MAX = 50;

// 发起加好友。留言可空。
//
// 用 wx.showModal 的 editable 而不是页面里摆一个输入框：加好友是「在哪儿想起来就在哪儿点」的
// 动作，每个触发点都摆一个输入框，会让名片页多出一排控件（原来就有「附一句留言」这个
// 独立按钮），而十次里有九次留言是空的。收进弹窗之后，动作只剩「点加好友 →（可选）写一句 → 发送」。
//
// base library 2.17.1+ 才支持 editable；更老的版本上 content 为空、留言为空，
// 加好友本身照样成立（申请照样发得出去，只是没有附言），不会卡住。
//
// 返回值：{ ok, msg?, canceled? }
//   canceled —— 用户自己取消的，调用方不要弹任何提示
function ask(toOpenid) {
  return new Promise((resolve) => {
    if (!toOpenid) {
      resolve({ ok: false, msg: '没有指定同学' });
      return;
    }
    wx.showModal({
      title: '加为同学',
      editable: true,
      placeholderText: '说一句（可不填，' + MESSAGE_MAX + ' 字内）',
      content: '',
      confirmText: '发送申请',
      success: (res) => {
        if (!res.confirm) {
          resolve({ ok: false, canceled: true });
          return;
        }
        const msg = String(res.content || '').trim().slice(0, MESSAGE_MAX);
        userApi.addRequest(toOpenid, msg).then((r) => {
          // 云函数如实报原因就照它说的说（已经是好友 / 已经发起过 / 24 小时冷却 /
          // 对方设置了消息限制），不要在这里另编一句更含糊的
          if (r && r.ok === false) {
            feedback.toast(r.msg || '没发出去，再试一次');
            resolve(r);
            return;
          }
          feedback.toast('已发出，等对方同意');
          resolve({ ok: true });
        }).catch(() => {
          feedback.toast('网络不太顺，再试一次');
          resolve({ ok: false });
        });
      },
      fail: () => resolve({ ok: false, canceled: true })
    });
  });
}

// 解除好友。要重新加回来得对方再同意一次，所以必须二次确认，
// 且确认文案里带上对方的名字 —— 从名单里点错一行是很常见的事。
//
// 这也是为什么这里用 content 把后果写全：联系方式会看不到、私信回到 3 条上限、
// 聊天记录保留。只说「确定解除吗？」的话，用户是按「取消」还是「确定」全靠猜。
//
// 返回值：{ ok, msg?, canceled? }
function remove(toOpenid, nickName) {
  return new Promise((resolve) => {
    if (!toOpenid) {
      resolve({ ok: false, msg: '没有指定同学' });
      return;
    }
    wx.showModal({
      title: '解除好友关系',
      content: '解除后你和「' + (nickName || '这位同学') + '」要重新申请、互相同意才能再加为同学。'
        + '联系方式不再可见，私信回到每人 ' + STRANGER_QUOTA + ' 条。聊天记录会保留。',
      confirmText: '解除',
      confirmColor: '#d9534f',
      success: (res) => {
        if (!res.confirm) {
          resolve({ ok: false, canceled: true });
          return;
        }
        userApi.removeFriend(toOpenid).then((r) => {
          if (!r || r.ok === false) {
            feedback.toast((r && r.msg) || '没解成，再试一次');
            resolve(r || { ok: false });
            return;
          }
          feedback.toast('已解除好友');
          resolve({ ok: true });
        }).catch(() => {
          feedback.toast('网络不太顺，再试一次');
          resolve({ ok: false });
        });
      },
      fail: () => resolve({ ok: false, canceled: true })
    });
  });
}

module.exports = { STRANGER_QUOTA, MESSAGE_MAX, ask, remove };
