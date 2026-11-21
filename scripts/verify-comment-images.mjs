// scripts/verify-comment-images.mjs —— 评论区图片发布功能端到端验证
//
// 覆盖：上传入列、非法文件 / 超限文件拒绝、发布后图片展示、全屏预览与翻页、
//       上传中禁用发布、普通帖详情页同样有讨论区。
// 与 verify.mjs（32 路由）互补：那个管「页面不崩」，这个管「功能真的能用」。
//
// 运行：node scripts/verify-comment-images.mjs（需先 npm run build）
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

const baseURL = 'http://127.0.0.1:4173'
const screenshotDir = fileURLToPath(new URL('../test-results/screenshots/', import.meta.url))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForServer(url, timeout = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Vite 还在起
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`等待服务器超时：${url}`)
}

// 1x1 透明 PNG（最小合法图片，用于走通完整上传链路）
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// 文件头是 PNG、体积超过 5MB：过格式、撞大小上限
function oversizePng() {
  const head = Buffer.from(PNG_BASE64, 'base64').subarray(0, 8)
  return Buffer.concat([head, Buffer.alloc(6 * 1024 * 1024, 0x41)])
}

const server = spawn(
  process.execPath,
  ['./node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4173'],
  { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'ignore', windowsHide: true },
)

let browser

try {
  await waitForServer(baseURL)
  await mkdir(screenshotDir, { recursive: true })
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  // 评论区（投票帖详情页）：发布框在帖子卡片下方
  await page.goto(`${baseURL}/forum/detail/poll-1`, { waitUntil: 'networkidle' })
  const draft = page.getByPlaceholder('友善评论，理性发言，也可以带图说明…')
  await draft.waitFor({ state: 'visible' })
  const fileInput = page.locator('input[type="file"]').first()
  const publishButton = page.getByRole('button', { name: '发布评论' })

  // ① 上传成功：缩略图进入已上传列表（alt 为「评论配图」的那批）
  await fileInput.setInputFiles({
    name: 'scene.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64'),
  })
  await expectVisible(page.locator('button[aria-label^="移除图片"]'), '上传成功后应出现可移除的缩略图')
  await page.screenshot({ path: `${screenshotDir}comment-uploaded.png` })

  // ② 上传中禁用发布：先写文字让按钮可用，再传一张，按钮应立刻禁用并给出说明
  await draft.fill('现场返场太炸了')
  await expectEnabled(publishButton, '有文字时发布按钮应可用')
  await fileInput.setInputFiles({
    name: 'second.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64'),
  })
  await expectDisabled(publishButton, '仍有图片在上传时发布按钮应禁用')
  await expectVisible(page.getByText('图片上传中，稍候即可发布…'), '应提示图片上传中')
  await expectEnabled(publishButton, '上传完成后发布按钮应恢复可用')

  // ③ 非图片文件（txt 改后缀 + 伪造 MIME）：拒收，不进列表，提示格式不符
  const thumbnailsBefore = await page.locator('button[aria-label^="移除图片"]').count()
  await fileInput.setInputFiles({
    name: 'fake.png',
    mimeType: 'image/png',
    buffer: Buffer.from('this is not an image at all'),
  })
  await expectVisible(page.getByText('文件内容不是有效的图片'), '伪造图片应被文件头校验拒收')
  assert(
    (await page.locator('button[aria-label^="移除图片"]').count()) === thumbnailsBefore,
    '被拒的文件不应占据缩略图位',
  )

  // ④ 超限文件：提示 5MB 上限
  await fileInput.setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: oversizePng() })
  await expectVisible(page.getByText('图片超过 5MB 上限'), '超过 5MB 的图片应被拒绝')

  // ⑤ 发布：新评论带图进入列表，输入框与配图清空。
  //    注意不能按「第一条」找：示例评论 comment-2 是置顶的，永远排在最新评论前面
  await publishButton.click()
  const published = page.locator('article', { hasText: '现场返场太炸了' })
  await expectVisible(published, '发布的评论应出现在列表中')
  await expectVisible(published.locator('img[alt="评论配图"]').first(), '新评论应展示配图')
  assert((await draft.inputValue()) === '', '发布成功后输入框应清空')
  assert(
    (await page.locator('button[aria-label^="移除图片"]').count()) === 0,
    '发布成功后配图区应清空',
  )
  await page.screenshot({ path: `${screenshotDir}comment-published.png` })

  // ⑥ 全屏预览：点新评论的图 → 打开 → Esc 关闭
  await published.locator('img[alt="评论配图"]').first().click()
  const viewer = page.getByRole('dialog', { name: '评论图片预览' })
  await expectVisible(viewer, '点击评论图片应打开全屏预览')
  await page.screenshot({ path: `${screenshotDir}comment-preview.png` })
  await page.keyboard.press('Escape')
  await expectHidden(viewer, 'Esc 应关闭预览')

  // ⑦ 多图预览翻页：示例评论 comment-2 带两张图
  const seeded = page.locator('article', { hasText: '建议把最终节目单和投票结果一起公布' })
  await seeded.locator('img[alt="评论配图"]').first().click()
  await expectVisible(page.getByText('1 / 2'), '多图预览应显示 1 / 2')
  await page.getByRole('button', { name: '下一张' }).click()
  await expectVisible(page.getByText('2 / 2'), '点下一张应切换到 2 / 2')
  await page.keyboard.press('Escape')

  // ⑧ 普通帖详情页同样有讨论区（评论区已抽成独立组件，两类帖子复用）
  await page.goto(`${baseURL}/forum/detail/post-1`, { waitUntil: 'networkidle' })
  await expectVisible(page.getByPlaceholder('友善评论，理性发言，也可以带图说明…'), '普通帖详情页应有评论区')

  // ⑨ 发帖页配图：上传后出现缩略图
  await page.goto(`${baseURL}/forum/post`, { waitUntil: 'networkidle' })
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'post.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64'),
  })
  await expectVisible(
    page.locator('button[aria-label^="移除图片"]').first(),
    '发帖页配图上传后应出现缩略图',
  )

  assert(pageErrors.length === 0, `页面错误: ${pageErrors.join('; ')}`)
  console.log('评论区图片功能验证通过：上传 / 校验 / 发布 / 预览 / 翻页 / 禁用发布 / 普通帖复用')
} finally {
  await browser?.close()
  server.kill()
}

/* ---------------- 断言辅助（expect 自带轮询重试） ---------------- */

async function expectVisible(locator, message) {
  try {
    await expect(locator.first()).toBeVisible({ timeout: 5_000 })
  } catch {
    throw new Error(`断言失败：${message}`)
  }
}

async function expectHidden(locator, message) {
  try {
    await expect(locator.first()).toBeHidden({ timeout: 5_000 })
  } catch {
    throw new Error(`断言失败：${message}`)
  }
}

async function expectEnabled(locator, message) {
  try {
    await expect(locator).toBeEnabled({ timeout: 5_000 })
  } catch {
    throw new Error(`断言失败：${message}`)
  }
}

async function expectDisabled(locator, message) {
  try {
    await expect(locator).toBeDisabled({ timeout: 5_000 })
  } catch {
    throw new Error(`断言失败：${message}`)
  }
}
