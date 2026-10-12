/**
 * 火山引擎 veImageX 图片生成 Adapter
 * 端点: /api/v3/images/generations (注意 /api/v3 前缀)
 * 响应格式: { data: [{ url: "..." }] }
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'
import { assertImageReferenceSupport, parseImageReferences } from './reference-images.js'

export class VolcEngineImageAdapter implements ImageProviderAdapter {
  provider = 'volcengine'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    // 火山引擎使用 seedream 模型
    const model = record.model || config.model || 'doubao-seedream-5-0-260128'
    const refs = parseImageReferences(record.referenceImages)
    assertImageReferenceSupport(config, model, refs)

    const body: any = {
      model,
      prompt: record.prompt,
      size: record.size || '2K',
      response_format: 'url',
      watermark: false,
    }
    if (refs.length) body.image = refs
    if (!/^doubao-seedream-5-0-(?:pro|flash)-/.test(model)) body.sequential_image_generation = 'disabled'

    return {
      url: joinProviderUrl(config.baseUrl, '/api/v3', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // 火山引擎可能返回 task_id 进行轮询
    if (result.task_id || result.id) {
      return { isAsync: true, taskId: result.task_id || result.id }
    }
    // 同步返回
    const imageUrl = result.data?.[0]?.url || result.url
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    throw new Error('No image URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/api/v3', `/images/generations/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    const status = result.status
    if (status === 'succeeded') {
      return {
        status: 'completed',
        imageUrl: result.data?.[0]?.url || result.image_url,
      }
    }
    if (status === 'failed') {
      // 上游 error 可能是对象 { code, message }，规范成字符串
      const err = result.error
      const msg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err) || 'Generation failed')
      const code = err && typeof err === 'object' && err.code ? `[${err.code}] ` : ''
      return { status: 'failed', error: `${code}${msg}` }
    }
    return { status: status || 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || result.image_url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    return null
  }
}
