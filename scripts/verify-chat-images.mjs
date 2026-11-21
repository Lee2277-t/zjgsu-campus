// scripts/verify-chat-images.mjs —— 私信图片功能回归测试
//
// 测的不是「复刻版」而是真源码：
//   - 云函数的 sanitizeChatImages / sanitizeCommentImages 从 index.js 里按花括号配平抽出来跑；
//   - 小程序的 uploader.js / dataset.js 用 node:vm 加载真文件，wx.cloud.uploadFile 打桩捕获 cloudPath。
// 两端规则对不上（图传得上去、消息发不出去）这类割裂，靠「跨模块契约」用例兜底。
//
// 运行：node scripts/verify-chat-images.mjs（无需启动任何服务）
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MP = path.join(root, 'miniprogram', 'zjgsu-campus')

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  ok ? pass++ : fail++
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name)
  if (!ok) console.log('     期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual))
}

/* ---------------- 小程序 CommonJS 模块的 vm 加载器 ---------------- */

// uploader 上传时捕获的 cloudPath / filePath，断言完再清空
const captured = []
const wxStub = {
  cloud: {
    init() {},
    database() {},
    uploadFile({ cloudPath, filePath }) {
      captured.push({ cloudPath, filePath })
      // 真机上微信返回的 fileID 就是 cloud://{环境ID}/{cloudPath}
      return Promise.resolve({ fileID: 'cloud://cloud1-testenv.zz/' + cloudPath })
    },
  },
  chooseMedia() {},
}

function loadCjs(relPath) {
  const file = path.join(MP, relPath)
  const mod = { exports: {} }
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    wx: wxStub,
    require: (req) => (req.startsWith('.') ? loadCjs(path.join(path.dirname(relPath), req)) : null),
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file })
  return mod.exports
}

/* ---------------- 云函数源码抽取 ---------------- */

const cfSrc = readFileSync(path.join(MP, 'cloudfunctions', 'user', 'index.js'), 'utf8')

// 按花括号配平抠出一个函数定义（被测函数体内没有含花括号的字符串）
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('云函数里找不到 ' + name)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('函数体配平失败: ' + name)
}

function extractConst(src, name) {
  const m = src.match(new RegExp('const ' + name + ' = (\\d+)'))
  if (!m) throw new Error('云函数里找不到常量 ' + name)
  return Number(m[1])
}

const cf = new Function(
  'CHAT_IMAGE_MAX',
  'COMMENT_IMAGE_MAX',
  extractFunction(cfSrc, 'sanitizeChatImages')
  + '\n' + extractFunction(cfSrc, 'sanitizeCommentImages')
  + '\nreturn { sanitizeChatImages, sanitizeCommentImages }',
)(extractConst(cfSrc, 'CHAT_IMAGE_MAX'), extractConst(cfSrc, 'COMMENT_IMAGE_MAX'))

const uploader = loadCjs('utils/uploader.js')
const dataset = loadCjs('utils/dataset.js')

/* ---------------- 用例 ---------------- */

const fid = 'cloud://cloud1-testenv.zz/chat/oAbCd123_1699999999999_456.jpg'

console.log('— sanitizeChatImages 白名单 —')
check('合法 fileID', cf.sanitizeChatImages([fid]), [fid])
check('纯文字消息（空数组）', cf.sanitizeChatImages([]), [])
check('未传字段（undefined）', cf.sanitizeChatImages(undefined), [])
check('非数组（字符串）', cf.sanitizeChatImages(fid), [])
check('http 外链被拒', cf.sanitizeChatImages(['https://evil.com/x.jpg']), null)
check('相对路径被拒', cf.sanitizeChatImages(['/chat/x.jpg']), null)
check('跨目录 fileID 被拒（forum）', cf.sanitizeChatImages(['cloud://env-1.abc/forum/x.jpg']), null)
check('跨目录 fileID 被拒（comment）', cf.sanitizeChatImages(['cloud://env-1.abc/comment/p1/x.jpg']), null)
check('空串项被拒', cf.sanitizeChatImages(['']), null)
check('超长 fileID 整条退回', cf.sanitizeChatImages([fid + 'x'.repeat(600)]), null)
check('超过 3 张只取前 3', cf.sanitizeChatImages([fid, fid, fid, fid, fid]).length, 3)
check('首张非法整条退回', cf.sanitizeChatImages(['https://evil.com/x.jpg', fid]), null)
check('前后空格容忍', cf.sanitizeChatImages([' ' + fid + ' ']), [fid])
check('大小写混合 fileID', cf.sanitizeChatImages(['CLOUD://Env-1.ABC/CHAT/x.jpg']), ['CLOUD://Env-1.ABC/CHAT/x.jpg'])

console.log('— sanitizeCommentImages 未被本次改动破坏 —')
const cfid = 'cloud://env-1.abc/comment/post-1/oAbCd_1_2.jpg'
check('评论合法 fileID', cf.sanitizeCommentImages([cfid], 'post-1'), [cfid])
check('评论单段路径被拒（缺 postId）', cf.sanitizeCommentImages(['cloud://env-1.abc/comment/x.jpg'], 'post-1'), null)
check('评论三段路径被拒', cf.sanitizeCommentImages(['cloud://env-1.abc/comment/a/b/c.jpg'], 'post-1'), null)
check('评论跨帖被拒', cf.sanitizeCommentImages([cfid], 'post-2'), null)
check('评论外链被拒', cf.sanitizeCommentImages(['https://evil.com/x.jpg'], 'post-1'), null)
check('评论空数组', cf.sanitizeCommentImages([], 'post-1'), [])

console.log('— 跨模块契约：uploader 真实 cloudPath 过云函数白名单 —')
// chooseMedia 的临时路径形态
const tmpFiles = ['wxfile://tmp_1234.jpg', 'wxfile://tmp_abc.png', 'wxfile://tmp_x.webp', 'wxfile://tmp_y.gif', 'wxfile://tmp_z.jpeg']
for (const tmp of tmpFiles) {
  captured.length = 0
  const fileIDs = await uploader.uploadToCloud([tmp], 'chat')
  const fileID = fileIDs && fileIDs[0]
  check(`${tmp.split('.').pop()} 上传路径过白名单`, cf.sanitizeChatImages([fileID]), [fileID])
  check(`${tmp.split('.').pop()} 路径落在 chat/ 目录`, /^chat\/[\w\-.]{1,64}_\d+_\d{1,3}\.\w+$/.test(captured[0].cloudPath), true)
}
// 并发上传不互相覆盖：两个文件的 cloudPath 必须不同
captured.length = 0
await uploader.uploadToCloud(['wxfile://tmp_a.jpg', 'wxfile://tmp_b.png'], 'chat')
check('并发上传 cloudPath 不重复', new Set(captured.map((c) => c.cloudPath)).size, 2)

// 别的目录的图混进私信必须被拒（防越权配图）
for (const folder of ['forum', 'comment/post-1']) {
  captured.length = 0
  const fileIDs = await uploader.uploadToCloud(['wxfile://tmp_1.jpg'], folder)
  check(`${folder} 目录的图不能当私信图片`, cf.sanitizeChatImages(fileIDs), null)
}

console.log('— dataset 工具（WXML 数据集数组往返）—')
const fids = ['cloud://a.b/chat/x_1_2.jpg', 'cloud://a.b/chat/y_3_4.png']
check('数组 → 字符串 → 数组', dataset.toList(fids.join(',')), fids)
check('空值兜底', dataset.toList(undefined), [])
check('空串兜底', dataset.toList(''), [])

console.log(`\n${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
