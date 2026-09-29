/**
 * Nuwax 工作流图片生成 Adapter
 *
 * 与视频侧共用同一套工作流执行协议（见 nuwax-shared.ts）：
 * POST {baseUrl}/api/v1/workflow/{id}/execute，同步返回，从 data 中递归提取图片地址。
 *
 * 约定：「模型」字段填写**工作流 ID**（纯数字）。
 * 请求体按设置页「工作流参数」的映射配置组装：
 *   1. 附加参数（支持 {{变量}} 占位）
 *   2. 提示词（key 由 promptKey 指定，始终覆盖同名附加参数）
 *   3. 参考图（仅当配置了 referenceKey 且有参考图时）
 *
 * 支持两种返回形态：图片 URL（由 generation.ts 下载落盘）或 base64。
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import {
  assertNuwaxSuccess,
  buildNuwaxRequest,
  extractWorkflowId,
  findMediaBase64,
  findMediaUrl,
  nuwaxNoMediaError,
  parseUrlArray,
  renderExtraParams,
  resolveWorkflowSettings,
  stripMediaRefs,
} from './nuwax-shared'

export class NuwaxImageAdapter implements ImageProviderAdapter {
  provider = 'nuwax'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const workflowId = extractWorkflowId(record.model || config.model)
    const wf = resolveWorkflowSettings(config)
    const refs = parseUrlArray(record.referenceImages)

    const body: Record<string, unknown> = {
      // 附加参数先铺，随后提示词覆盖同名 key，保证提示词始终以 promptKey 为准
      ...renderExtraParams(wf.extraParams, {
        prompt: record.prompt || '',
        promptPlain: stripMediaRefs(record.prompt || ''),
        size: record.size || '',
        frameType: record.frameType || '',
        referenceImages: refs,
      }),
      [wf.promptKey]: record.prompt || '',
    }

    // 参考图：仅当配置了入参名时才传，避免未知字段被工作流校验拒绝
    if (wf.referenceKey && refs.length) body[wf.referenceKey] = refs

    return buildNuwaxRequest(config, workflowId, body)
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    assertNuwaxSuccess(result, '图片')

    const scope = result?.data ?? result
    const imageUrl = findMediaUrl(scope, 'image')
    if (imageUrl) return { isAsync: false, imageUrl }

    // 同步但无 URL：交给 extractImageBase64 处理
    if (findMediaBase64(scope)) return { isAsync: false }

    throw nuwaxNoMediaError('图片', result)
  }

  buildPollRequest(_config: AIConfig, _taskId: string): ProviderRequest {
    throw new Error('Nuwax 工作流为同步返回，不支持任务轮询')
  }

  parsePollResponse(_result: any): ImagePollResponse {
    throw new Error('Nuwax 工作流为同步返回，不支持任务轮询')
  }

  extractImageUrl(result: any): string | null {
    return findMediaUrl(result?.data ?? result, 'image')
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    return findMediaBase64(result?.data ?? result)
  }
}
