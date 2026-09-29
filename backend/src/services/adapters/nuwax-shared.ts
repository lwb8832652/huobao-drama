/**
 * Nuwax 工作流适配器共用逻辑（图片 / 视频共用）
 *
 * 开放接口：POST {baseUrl}/api/v1/workflow/{id}/execute
 * 鉴权：Authorization: Bearer ak-xxxx
 * 请求体：工作流自定义动态入参（入参名默认 question，可用 NUWAX_INPUT_KEY 覆盖）
 * 响应：{ code: '0000' 成功, displayCode, message, data: object, tid, success }
 *
 * 使用约定：
 * - 「模型」字段填写**工作流 ID**（支持 20 / wf-20 / workflow:20，内部取其中的数字）
 * - data 的结构由工作流自身定义，这里先按常见字段匹配，匹配不到再递归深搜兜底
 * - 同步返回：解析到媒体 URL 即由 generation.ts 下载落盘 /static
 *
 * 环境变量：
 * - NUWAX_INPUT_KEY            工作流入参名，默认 question
 * - NUWAX_REFERENCE_INPUT_KEY  参考素材入参名；未配置则不传（避免未知字段被工作流拒绝）
 */
import type { AIConfig, ProviderRequest } from './types'
import { joinProviderUrl } from './url'
import { logTaskWarn } from '../../utils/task-logger.js'

export type MediaKind = 'image' | 'video'

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i
const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v|avi|mkv)(\?|#|$)/i
const DATA_MEDIA_RE = /^data:(image|video)\/([a-z0-9.+-]+);base64,/i

/** 常见媒体地址字段，按命中优先级排列（data 为兜底，允许进入下一层） */
const CANDIDATE_URL_KEYS = [
  'imageUrl', 'image_url', 'videoUrl', 'video_url', 'imgUrl', 'img_url',
  'url', 'image', 'img', 'video', 'output', 'result', 'content',
  'fileUrl', 'file_url', 'downloadUrl', 'download_url',
  'images', 'videos', 'files', 'data',
]

/** 工作流入参名（提示词所属字段） */
export function nuwaxInputKey(): string {
  return (process.env.NUWAX_INPUT_KEY || 'question').trim() || 'question'
}

/** 参考素材入参名；未配置则不传参考素材 */
export function nuwaxReferenceKey(): string {
  return (process.env.NUWAX_REFERENCE_INPUT_KEY || '').trim()
}

/**
 * 从「模型」字段解析工作流 ID。
 * 允许 20 / wf-20 / workflow:20 等写法，取其中第一段数字。
 */
export function extractWorkflowId(raw?: string | null): string {
  const s = String(raw || '').trim()
  if (!s) {
    throw new Error('Nuwax 配置缺少工作流 ID：请在「工作流 ID」字段填写工作流 ID（纯数字，如 20）')
  }
  const m = s.match(/\d+/)
  if (!m) throw new Error(`Nuwax 工作流 ID 无效：${s}（应为纯数字工作流 ID）`)
  return m[0]
}

/** 组装工作流执行请求（图片/视频共用） */
export function buildNuwaxRequest(
  config: AIConfig,
  workflowId: string,
  body: Record<string, unknown>,
): ProviderRequest {
  return {
    url: joinProviderUrl(config.baseUrl, '/api/v1', `/workflow/${workflowId}/execute`),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body,
  }
}

/** 校验 Nuwax 业务码；非 0000 抛错并带上 displayCode / message / tid 便于排查 */
export function assertNuwaxSuccess(result: any, kind: string): void {
  if (!result || typeof result !== 'object' || !('code' in result)) return
  if (String(result.code) !== '0000') {
    throw new Error(
      `Nuwax ${kind}工作流执行失败 [${result.displayCode || result.code}] ${result.message || ''}`
      + (result.tid ? ` (tid: ${result.tid})` : ''),
    )
  }
}

function isMediaUrl(value: string, kind: MediaKind): boolean {
  if (!/^https?:\/\//i.test(value)) return false
  return kind === 'video'
    ? (VIDEO_EXT_RE.test(value) || /video|mp4/i.test(value))
    : (IMAGE_EXT_RE.test(value) || /image|img/i.test(value))
}

/** 递归查找媒体 URL：先按候选字段，再遍历全部值；depth 防深嵌套 */
export function findMediaUrl(node: unknown, kind: MediaKind, depth = 0): string | null {
  if (node == null || depth > 6) return null

  if (typeof node === 'string') {
    return isMediaUrl(node, kind) ? node : null
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findMediaUrl(item, kind, depth + 1)
      if (found) return found
    }
    return null
  }

  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const key of CANDIDATE_URL_KEYS) {
      if (key in obj) {
        const found = findMediaUrl(obj[key], kind, depth + 1)
        if (found) return found
      }
    }
    for (const value of Object.values(obj)) {
      const found = findMediaUrl(value, kind, depth + 1)
      if (found) return found
    }
  }
  return null
}

/** 递归查找 base64 媒体（data:image/... 或 data:video/...;base64,xxx） */
export function findMediaBase64(node: unknown, depth = 0): { data: string; mimeType: string } | null {
  if (node == null || depth > 6) return null

  if (typeof node === 'string') {
    const m = node.match(DATA_MEDIA_RE)
    if (!m) return null
    return { data: node.slice(m[0].length), mimeType: `${m[1]}/${m[2] === 'jpg' ? 'jpeg' : m[2]}` }
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findMediaBase64(item, depth + 1)
      if (found) return found
    }
    return null
  }

  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const key of ['b64_json', 'base64', 'image_base64', 'imageBase64', 'video_base64', 'data'] as const) {
      if (typeof obj[key] === 'string') {
        const found = findMediaBase64(obj[key], depth + 1)
        if (found) return found
      }
    }
    for (const value of Object.values(obj)) {
      const found = findMediaBase64(value, depth + 1)
      if (found) return found
    }
  }
  return null
}

/** 解析 JSON 数组字符串，失败返回空数组 */
export function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u: unknown) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

/** 找不到媒体时抛出的统一错误（带 tid 与响应预览，便于对齐工作流出参） */
export function nuwaxNoMediaError(kind: string, result: any): Error {
  return new Error(
    `Nuwax 响应中未找到${kind}地址，请确认该工作流的输出节点确实返回${kind}`
    + `（tid: ${result?.tid ?? '-'}，响应预览: ${JSON.stringify(result).slice(0, 200)}）`,
  )
}

/**
 * 工作流参数映射配置，存于 ai_service_configs.settings.workflow
 * （在设置页「工作流参数」区块填写，图片/视频各自独立）
 */
export interface NuwaxWorkflowSettings {
  /** 提示词入参名，如 question / prompt */
  promptKey: string
  /** 参考素材入参名；空字符串表示不传 */
  referenceKey: string
  /** 附加参数：入参名 -> 值（值支持 {{变量}} 占位，见 renderExtraParams） */
  extraParams: Record<string, string>
}

/**
 * 解析参数映射配置，优先级：**配置 > 环境变量 > 内置默认值**。
 * 环境变量为 NUWAX_INPUT_KEY / NUWAX_REFERENCE_INPUT_KEY（见文件头）。
 */
export function resolveWorkflowSettings(config: AIConfig): NuwaxWorkflowSettings {
  const wf = (config as any)?.settings?.workflow

  const promptKey = String(wf?.promptKey ?? '').trim() || nuwaxInputKey()
  const referenceKey = String(wf?.referenceKey ?? '').trim() || nuwaxReferenceKey()

  const extraParams: Record<string, string> = {}
  const raw = wf?.extraParams
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      const key = String(k ?? '').trim()
      if (key) extraParams[key] = String(v ?? '')
    }
  }

  return { promptKey, referenceKey, extraParams }
}

/**
 * 渲染附加参数：把 `{{变量}}` 占位替换为本次生成的实际值。
 *
 * - 整个值就是一个变量（如 `images={{referenceImages}}`）→ 保留原始类型（可传数组）
 * - 变量嵌在文本中（如 `风格={{aspectRatio}} 高清`）→ 字符串插值
 * - 变量不存在（如视频配置里写了图片专属的 {{size}}）→ 替换为空并记录警告日志
 * - 渲染结果为空 → 该参数不传，避免给工作流塞空值
 */
export function renderExtraParams(
  extraParams: Record<string, string>,
  vars: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const unknown = new Set<string>()

  const lookup = (name: string): unknown => {
    if (name in vars) return vars[name]
    unknown.add(name)
    return ''
  }

  for (const [key, raw] of Object.entries(extraParams)) {
    let value: unknown = raw

    const single = /^\s*\{\{\s*(\w+)\s*\}\}\s*$/.exec(raw)
    if (single) {
      value = lookup(single[1])
    } else {
      value = String(raw).replace(/\{\{\s*(\w+)\s*\}\}/g, (_matched, name: string) => {
        const v = lookup(name)
        if (v === null || v === undefined || v === '') return ''
        return Array.isArray(v) ? v.join(',') : String(v)
      })
    }

    if (value === null || value === undefined || value === '') continue
    out[key] = value
  }

  if (unknown.size) {
    logTaskWarn('Nuwax', 'unknown-workflow-variable', {
      names: [...unknown],
      available: Object.keys(vars),
    })
  }

  return out
}

/**
 * 去掉项目内部的 `@图片N` 引用标记，只保留名字本身（`@图片1小明` → `小明`）。
 * 用于提示词入参：通用工作流不认识内部标记，清洗后是自然语句；
 * 需要保留标记时改用 `{{prompt}}`，需要清洗版用 `{{promptPlain}}`。
 */
export function stripMediaRefs(text: string): string {
  return String(text || '').replace(/@图片\d+/g, '')
}
