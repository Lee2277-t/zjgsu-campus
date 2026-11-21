// src/services/http.ts —— 后端接口共用请求层。
// 投票（vote.ts）和评论（comment.ts）都走这里：cookie 携带、JSON 约定、
// 错误解析只写一份，新增业务服务时直接复用，不用再各写一套 fetch 包装。
import { API_BASE } from '@/config/app'

/** 服务端错误响应的约定形状：{ message?: string } */
interface ErrorBody {
  message?: string
}

/** 接口请求失败。status 保留 HTTP 状态码，调用方可按需区分网络错/服务端错 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 发一个 JSON 请求（自动带登录态 cookie）。
 * 非 2xx 时抛出 ApiError，message 优先取服务端返回的说明，取不到再兜底状态码。
 */
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorBody | null
    throw new ApiError(body?.message || `请求失败：${response.status}`, response.status)
  }

  return (await response.json()) as T
}
