import type { AIConfig } from './adapters/types.js'
import { resolveWorkflowSettings } from './adapters/nuwax-shared.js'

export type GridResolution = '1K' | '2K' | '4K'
export interface GridImageSize {
  size: string
  width: number
  height: number
  aspectRatio: string
  resolution: GridResolution
}
export interface GridImageCapabilities {
  provider: string
  model: string
  enabled: boolean
  supportsReferences: boolean
  supportsEdit: boolean
  maxReferences: number
  aspectRatios: string[]
  resolutions: GridResolution[]
  sizes: GridImageSize[]
  reason?: string
}

// Native sizes and limits, verified against the providers' official API documentation.
// https://ai.google.dev/gemini-api/docs/generate-content/image-generation
// https://developers.openai.com/api/docs/guides/image-generation
// https://docs.volcengine.com/docs/ark/image-generation-api
const ratios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const geminiBase = [[1024, 1024], [848, 1264], [1264, 848], [896, 1200], [1200, 896], [928, 1152], [1152, 928], [768, 1376], [1376, 768], [1584, 672]]
const seedreamRatios = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9']
const seedreamBase = [[1024, 1024], [1152, 864], [864, 1152], [1280, 720], [720, 1280], [1248, 832], [832, 1248], [1512, 648]]

/**
 * 未在能力表里声明的模型默认按常见原生尺寸开放宫格：图片模型默认支持整组宫格，
 * 真正不支持时会在提交生成时由模型返回错误，而不是在界面上静默禁用。
 * 切分用的是相对坐标，实际返回尺寸与声明值不同也能正确落格。
 */
const DEFAULT_GRID_REFERENCES = 6
const defaultGridSizes = () => scaledSizes(ratios, geminiBase, ['1K', '2K'], tier => (tier === '2K' ? 2 : 1))

function size(aspectRatio: string, resolution: GridResolution, width: number, height: number): GridImageSize {
  return { size: `${width}x${height}`, width, height, aspectRatio, resolution }
}
function scaledSizes(ratioNames: string[], dimensions: number[][], tiers: GridResolution[], factor: (tier: GridResolution) => number): GridImageSize[] {
  return tiers.flatMap(tier => dimensions.map(([w, h], i) => size(ratioNames[i], tier, Math.round(w * factor(tier)), Math.round(h * factor(tier)))))
}
function result(provider: string, model: string, maxReferences: number, sizes: GridImageSize[], supportsEdit = true): GridImageCapabilities {
  return {
    provider, model, enabled: sizes.length > 0, supportsReferences: true, supportsEdit, maxReferences, sizes,
    aspectRatios: [...new Set(sizes.map(item => item.aspectRatio))],
    resolutions: [...new Set(sizes.map(item => item.resolution))],
  }
}
function disabled(provider: string, model: string, reason: string): GridImageCapabilities {
  return { provider, model, enabled: false, supportsReferences: false, supportsEdit: false, maxReferences: 0, aspectRatios: [], resolutions: [], sizes: [], reason }
}

/** Unknown models and opaque endpoint IDs are disabled until their image capabilities are identified. */
export function gridImageCapabilities(config: AIConfig, model: string): GridImageCapabilities {
  const provider = config.provider.toLowerCase()
  const name = (model || config.model).replace(/^models\//, '')
  if (provider === 'openai') {
    if (/^gpt-image-(?:2(?:-2026-04-21)?|2\.5-(?:sunburst|flare)(?:-2026-09-08)?)$/.test(name)) {
      return result(provider, name, 16, [
        size('1:1', '1K', 1024, 1024), size('16:9', '1K', 1536, 864), size('9:16', '1K', 864, 1536),
        size('3:2', '1K', 1536, 1024), size('2:3', '1K', 1024, 1536),
        size('1:1', '2K', 2048, 2048), size('16:9', '2K', 2048, 1152), size('9:16', '2K', 1152, 2048),
        size('3:2', '2K', 2048, 1376), size('2:3', '2K', 1376, 2048),
        // 4096 square violates GPT Image's edge/pixel limit. Only valid native 4K sizes are offered.
        size('16:9', '4K', 3840, 2160), size('9:16', '4K', 2160, 3840),
      ])
    }
    if (/^(?:gpt-image-1(?:\.5|-mini)?|chatgpt-image-latest)$/.test(name)) {
      return result(provider, name, 16, [size('1:1', '1K', 1024, 1024), size('3:2', '1K', 1536, 1024), size('2:3', '1K', 1024, 1536)])
    }
  }
  if (provider === 'gemini') {
    if (/^gemini-(?:3-pro|3\.1-flash)-image(?:-preview)?$/.test(name)) {
      return result(provider, name, 14, scaledSizes(ratios, geminiBase, ['1K', '2K', '4K'], tier => tier === '1K' ? 1 : tier === '2K' ? 2 : 4))
    }
    if (/^gemini-2\.5-flash-image(?:-preview)?$/.test(name)) {
      return result(provider, name, 3, scaledSizes(ratios, geminiBase, ['1K'], () => 1))
    }
  }
  if (provider === 'volcengine') {
    const modern = /^doubao-seedream-5-0-(?:pro|flash)-\d{6}$/.test(name)
    const four = /^doubao-seedream-4-0-\d{6,8}$/.test(name)
    const other = /^doubao-seedream-(?:4-5-\d{6}|5-0-(?:lite-)?\d{6})$/.test(name)
    if (modern || four || other) {
      const tiers: GridResolution[] = modern ? ['1K', '2K'] : four ? ['1K', '2K', '4K'] : ['2K', '4K']
      return result(provider, name, modern ? 10 : 14, scaledSizes(seedreamRatios, seedreamBase, tiers, tier => tier === '1K' ? 1 : tier === '2K' ? 2.1 : 4))
    }
  }
  if (provider === 'nuwax') {
    const wf = resolveWorkflowSettings(config)
    if (wf.referenceKey && wf.referenceKey === wf.promptKey) return disabled(provider, name, '参考图字段不能覆盖提示词字段，请使用独立入参')
    const mapped = !!wf.referenceKey && wf.referenceKey !== wf.promptKey
      || Object.entries(wf.extraParams).some(([key, value]) => key !== wf.promptKey && /^\s*\{\{\s*referenceImages\s*\}\}\s*$/.test(value))
    if (!mapped) return disabled(provider, name, '工作流没有可实际传输参考图的独立入参映射')
    const declared = config.settings?.workflow?.gridImage
    const maxReferences = Number(declared?.maxReferences)
    const hasSizeMapping = Object.entries(wf.extraParams).some(([key, value]) => key !== wf.promptKey && key !== wf.referenceKey && /^\s*\{\{\s*size\s*\}\}\s*$/.test(value))
    if (!hasSizeMapping || !Number.isInteger(maxReferences) || maxReferences < 1 || maxReferences > 16 || !Array.isArray(declared?.sizes)) {
      // 工作流未显式声明 gridImage 时不再整体禁用：按默认尺寸开放，
      // 已确认有独立参考图入参（mapped），宫格请求可以照常发出。
      return result(provider, name, DEFAULT_GRID_REFERENCES, defaultGridSizes())
    }
    const sizes = declared.sizes.filter((item: any) => ratios.includes(item?.aspectRatio) && ['1K', '2K', '4K'].includes(item?.resolution)
      && Number.isInteger(item?.width) && item.width > 0 && Number.isInteger(item?.height) && item.height > 0)
      .map((item: any) => size(item.aspectRatio, item.resolution, item.width, item.height))
    if (!sizes.length) return disabled(provider, name, '工作流未声明有效原生尺寸')
    return result(provider, name, maxReferences, sizes, declared.supportsEdit === true)
  }
  // 白名单之外的模型一并按默认能力开放，不再因"未声明"而禁用。
  return result(provider, name, DEFAULT_GRID_REFERENCES, defaultGridSizes())
}

/** Refuse unsupported dimensions instead of stretching a different native ratio or silently lowering resolution. */
export function chooseGridSize(capabilities: GridImageCapabilities, aspectRatio: string, resolution: GridResolution): GridImageSize {
  if (!capabilities.enabled) throw new Error(capabilities.reason || '当前模型不支持联合宫格生成')
  const selected = capabilities.sizes.find(item => item.aspectRatio === aspectRatio && item.resolution === resolution)
  if (!selected) throw new Error(`当前模型不支持 ${aspectRatio} / ${resolution} 原生输出尺寸`)
  return { ...selected }
}
