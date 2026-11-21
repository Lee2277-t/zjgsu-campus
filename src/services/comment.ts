import { API_BASE, COMMENT_API_ENABLED } from '@/config/app'
import { apiRequest } from '@/services/http'
import type { Comment, CommentImage } from '@/types'

/** 单条评论最多携带的图片数量 */
export const COMMENT_IMAGE_MAX_COUNT = 3
/** 单张图片大小上限：5MB */
export const COMMENT_IMAGE_MAX_SIZE = 5 * 1024 * 1024
/**
 * 允许的图片类型：MIME → 合法扩展名。
 * 刻意不放 image/svg+xml：SVG 可携带脚本，属于 XSS 入口。
 * 扩展名与 MIME 对不上（改后缀伪装格式）时拒绝。
 */
const EXT_BY_MIME: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
}
/** 允许的 MIME 类型（由 EXT_BY_MIME 派生，避免两处清单各写一遍对不上） */
export const COMMENT_IMAGE_ACCEPT = Object.keys(EXT_BY_MIME)
/** file input 的 accept 属性与提示文案用的扩展名清单 */
export const COMMENT_IMAGE_ACCEPT_EXT = Object.values(EXT_BY_MIME)
  .flat()
  .map((ext) => `.${ext}`)
  .join(',')

export class CommentImageError extends Error {
  constructor(
    message: string,
    /** 机器可读的错误码，前端按码给出针对性提示与重试入口 */
    readonly code:
      | 'too-many'
      | 'too-large'
      | 'bad-format'
      | 'not-image'
      | 'network'
      | 'server'
      | 'aborted',
  ) {
    super(message)
    this.name = 'CommentImageError'
  }
}

/** 读取文件头 magic bytes，确认内容真的是图片（改扩展名伪造 MIME 的常见绕过手法） */
async function sniffImageType(file: File): Promise<string | null> {
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const startsWith = (...bytes: number[]) => bytes.every((byte, index) => header[index] === byte)
  const ascii = (...chars: string[]) =>
    chars.every((char, index) => String.fromCharCode(header[index]) === char)

  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (ascii('G', 'I', 'F', '8')) return 'image/gif'
  if (ascii('R', 'I', 'F', 'F') && ascii('W', 'E', 'B', 'P')) return 'image/webp'
  return null
}

/**
 * 上传前的本地校验。分三层：数量 → 大小 → 格式（MIME + 扩展名 + 文件头）。
 * 任何一层不过都抛出带错误码的 CommentImageError，调用方按码提示。
 */
export async function validateCommentImage(file: File, currentCount = 0): Promise<void> {
  if (currentCount >= COMMENT_IMAGE_MAX_COUNT) {
    throw new CommentImageError(`每条评论最多上传 ${COMMENT_IMAGE_MAX_COUNT} 张图片`, 'too-many')
  }
  if (file.size > COMMENT_IMAGE_MAX_SIZE) {
    throw new CommentImageError(
      `图片超过 ${Math.floor(COMMENT_IMAGE_MAX_SIZE / 1024 / 1024)}MB 上限`,
      'too-large',
    )
  }
  if (!file.type.startsWith('image/')) {
    throw new CommentImageError('只能上传图片文件', 'not-image')
  }
  if (!COMMENT_IMAGE_ACCEPT.includes(file.type)) {
    throw new CommentImageError('仅支持 JPG / PNG / WebP / GIF 格式', 'bad-format')
  }
  const extension = (file.name.split('.').pop() || '').toLowerCase()
  if (!EXT_BY_MIME[file.type]?.includes(extension)) {
    throw new CommentImageError('文件扩展名与图片格式不符', 'bad-format')
  }
  const sniffed = await sniffImageType(file)
  if (!sniffed || sniffed !== file.type) {
    throw new CommentImageError('文件内容不是有效的图片', 'bad-format')
  }
}

/** 生成前端本地 ID。接入服务端后改用服务端返回的图片 ID */
function createImageId() {
  return `img-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const probe = new Image()
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight })
    probe.onerror = () => resolve({ width: 0, height: 0 })
    probe.src = url
  })
}

/**
 * 上传单张评论配图。
 * - COMMENT_API_ENABLED=false（原型模式）：仅创建对象 URL 模拟一次上传，带进度回调。
 * - 接入后端后：POST multipart/form-data 到 /comment-images，用 XHR 拿真实进度，
 *   支持 AbortController 取消；失败时抛出 CommentImageError 供调用方重试。
 */
export function uploadCommentImage(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<CommentImage> {
  return new Promise((resolve, reject) => {
    const id = createImageId()
    const objectUrl = URL.createObjectURL(file)

    const finish = async () => {
      const size = await readImageSize(objectUrl)
      resolve({
        id,
        url: objectUrl,
        name: file.name,
        size: file.size,
        width: size.width,
        height: size.height,
      })
    }

    if (!COMMENT_API_ENABLED) {
      // 原型模式：模拟 600ms 上传，进度从 10% 走到 100%
      let percent = 10
      const timer = window.setInterval(() => {
        percent = Math.min(95, percent + 18)
        onProgress?.(percent)
      }, 90)
      window.setTimeout(() => {
        window.clearInterval(timer)
        onProgress?.(100)
        void finish()
      }, 600)
      return
    }

    const form = new FormData()
    form.append('file', file, file.name)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/comment-images`)
    xhr.withCredentials = true

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.round((event.loaded / event.total) * 100))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as { image?: CommentImage }
          if (body.image?.url) {
            resolve(body.image)
            return
          }
        } catch {
          // 响应体不符合约定时按服务端错误处理
        }
        reject(new CommentImageError('服务端返回了无法识别的结果', 'server'))
        return
      }
      const code = xhr.status >= 500 ? 'server' : 'network'
      reject(new CommentImageError(`图片上传失败（${xhr.status}）`, code))
    }
    xhr.onerror = () => reject(new CommentImageError('网络异常，图片没能传上去', 'network'))
    xhr.onabort = () => reject(new CommentImageError('上传已取消', 'aborted'))
    xhr.send(form)
  })
}

export interface SubmitCommentPayload {
  postId: string
  content: string
  images?: CommentImage[]
}

/** 提交评论（文字 + 图片 ID 列表）。原型模式下由调用方本地落地，此处仅预留接口形状 */
export function submitComment(payload: SubmitCommentPayload) {
  if (!COMMENT_API_ENABLED) return Promise.resolve(null)
  return apiRequest<{ comment: Comment }>('/comments', {
    method: 'POST',
    body: JSON.stringify({
      postId: payload.postId,
      content: payload.content,
      imageIds: (payload.images || []).map((image) => image.id),
    }),
  })
}

/** 上传任务在组件内的状态机：等待校验 → 上传中（带进度）→ 成功 / 失败（可重试） */
export type UploadTaskStatus = 'uploading' | 'done' | 'error'

export interface UploadTask {
  id: string
  file: File
  status: UploadTaskStatus
  progress: number
  /** 本地对象 URL，上传过程中先给缩略图占位；任务结束时由组件回收 */
  localUrl?: string
  image?: CommentImage
  error?: string
  /** 失败原因的错误码，用于区分「可重试」与「必须换图」 */
  errorCode?: CommentImageError['code']
}
