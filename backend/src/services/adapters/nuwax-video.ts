/**
 * Nuwax 工作流视频生成 Adapter
 *
 * 与图片侧共用同一套工作流执行协议（见 nuwax-shared.ts）：
 * POST {baseUrl}/api/v1/workflow/{id}/execute，同步返回，从 data 中递归提取视频地址。
 *
 * 约定：「模型」字段填写**工作流 ID**（纯数字）。
 * 请求体按设置页「工作流参数」的映射配置组装，可用变量见 renderExtraParams 调用处
 * （prompt / duration / resolution / aspectRatio / firstFrame / referenceImages ...），
 * 保证项目侧已知信息都能按需传出、不丢失。
 *
 * 该接口同步返回，因此不提供轮询能力；取不到视频地址会直接失败并给出 tid 便于排查。
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import {
  assertNuwaxSuccess,
  buildNuwaxRequest,
  extractWorkflowId,
  findMediaUrl,
  nuwaxNoMediaError,
  parseUrlArray,
  renderExtraParams,
  resolveWorkflowSettings,
  stripMediaRefs,
} from './nuwax-shared'

export class NuwaxVideoAdapter implements VideoProviderAdapter {
  provider = 'nuwax'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const workflowId = extractWorkflowId(record.model || config.model)
    const wf = resolveWorkflowSettings(config)

    // 首帧优先，其后追加其余参考图
    const firstFrame = (record.firstFrameUrl || record.imageUrl || '').trim()
    const images = parseUrlArray(record.referenceImageUrls)
    const refs = firstFrame ? [firstFrame, ...images] : images

    const body: Record<string, unknown> = {
      // 附加参数先铺，随后提示词覆盖同名 key，保证提示词始终以 promptKey 为准
      ...renderExtraParams(wf.extraParams, {
        prompt: record.prompt || '',
        promptPlain: stripMediaRefs(record.prompt || ''),
        duration: record.duration ?? '',
        resolution: record.resolution || '',
        aspectRatio: record.aspectRatio || '',
        firstFrame,
        imageUrl: (record.imageUrl || '').trim(),
        referenceImages: refs,
        referenceImageUrls: images,
      }),
      [wf.promptKey]: record.prompt || '',
    }

    // 参考素材：仅当配置了入参名时才传
    if (wf.referenceKey && refs.length) body[wf.referenceKey] = refs

    return buildNuwaxRequest(config, workflowId, body)
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    assertNuwaxSuccess(result, '视频')

    const scope = result?.data ?? result
    const videoUrl = findMediaUrl(scope, 'video')
    if (videoUrl) return { isAsync: false, videoUrl }

    throw nuwaxNoMediaError('视频', result)
  }

  buildPollRequest(_config: AIConfig, _taskId: string): ProviderRequest {
    throw new Error('Nuwax 工作流为同步返回，不支持任务轮询')
  }

  parsePollResponse(_result: any): VideoPollResponse {
    throw new Error('Nuwax 工作流为同步返回，不支持任务轮询')
  }

  extractVideoUrl(result: any): string | null {
    return findMediaUrl(result?.data ?? result, 'video')
  }
}
