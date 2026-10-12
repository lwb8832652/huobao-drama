import type { AIConfig } from './types.js'
import { parseDataUrl } from '../../utils/storage.js'
import { gridImageCapabilities } from '../previs-grid-capabilities.js'

/** Keep the caller's order exactly: invalid references must fail, never disappear or renumber. */
export function parseImageReferences(raw?: string | null): string[] {
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('参考图片列表不是有效 JSON') }
  if (!Array.isArray(parsed) || parsed.some(ref => typeof ref !== 'string' || !ref.trim())) throw new Error('参考图片必须是非空图片地址数组')
  for (const [index, ref] of parsed.entries()) {
    const data = parseDataUrl(ref)
    if (!/^https?:\/\//i.test(ref) && !(data?.mimeType.startsWith('image/') && data.data)) throw new Error(`参考图片 ${index + 1} 无法解析`)
  }
  return parsed
}

export function assertImageReferenceSupport(config: AIConfig, model: string, refs: string[]): void {
  if (!refs.length) return
  const caps = gridImageCapabilities(config, model)
  if (!caps.supportsReferences) throw new Error(`当前模型不支持参考图片输入：${caps.reason || '未声明参考图能力'}`)
  if (refs.length > caps.maxReferences) throw new Error(`参考图片超过模型上限：最多 ${caps.maxReferences} 张，当前 ${refs.length} 张`)
}
