/** Model-aware endpoint capability and immutable video boundary snapshots. */
import { localReferenceDigest } from './previs-reference-media.js'
import type { PanelContinuity } from './previs-continuity.js'
import { continuityMatchesTimeline } from './previs-continuity.js'
import { frameKey, orderedFrames, type Panel, type Timeline } from './previs-domain.js'
export type VideoContinuityMode = 'auto' | 'reference' | 'first_last'
export interface VideoEndpoint {
  panelId: number
  frameId: string
  sourceUrl: string
  frozenUrl: string
  digest: string
  offsetMs: number
}
export interface VideoContinuitySnapshot {
  version: 1
  requested: VideoContinuityMode
  actual: 'reference' | 'first_last'
  fallbackReason?: string
  aspectRatio: string
  continuity?: PanelContinuity
  first?: VideoEndpoint
  last?: VideoEndpoint
  frames?: { panelId: number; frameId: string; sourceUrl: string; digest: string; offsetMs: number }[]
}
export function modelVideoContinuityCapabilities(provider: string, model: string) {
  const firstLast = (provider === 'aliyun' && ['wan3.0-video', 'wan3.0-video-prime'].includes(model))
    || (provider === 'minimax' && /^minimax-h3(?:[.-][a-z0-9.-]+)?$/i.test(model))
  const reference = firstLast || (provider === 'volcengine' && model.startsWith('doubao-seedance-2-0')) || (provider === 'nuwax' && /^\d+$/.test(model))
  return { provider, model, firstLast, reference,
    maxImages: provider === 'aliyun' && reference ? 10 : reference ? 9 : 0,
    reason: firstLast ? '当前适配器和模型支持独立首尾帧。' : reference ? '当前适配器或模型仅声明参考图模式，将使用画面参考。' : '当前服务尚未声明视频连续性能力。' }
}
export async function videoContinuityCapabilities(configId?: number, model?: string) {
  const { getActiveConfigId, getConfigById } = await import('./ai.js')
  const id = configId || await getActiveConfigId('video'), config = id ? await getConfigById(id) : null
  return config ? modelVideoContinuityCapabilities(config.provider, model || config.model)
    : { firstLast: false, reference: false, reason: '请先配置并启用视频模型。', maxImages: 0 }
}
export function videoContinuityMatchesTimeline(snapshot: VideoContinuitySnapshot, timeline: Timeline, panels: Panel[]) {
  if (snapshot.continuity && !continuityMatchesTimeline(snapshot.continuity, timeline)) return false
  if (snapshot.actual !== 'first_last') return true
  if ([snapshot.first, snapshot.last].some(endpoint => {
    if (!endpoint) return true
    const digest = localReferenceDigest(endpoint.sourceUrl)
    return digest !== null && digest !== endpoint.digest
  })) return false
  if (snapshot.frames?.some(frame => { const digest = localReferenceDigest(frame.sourceUrl); return digest !== null && digest !== frame.digest })) return false
  const sources = panels.flatMap(p => orderedFrames(p).map(f => ({ panelId: p.id, frameId: frameKey(f), sourceUrl: f.url, offsetMs: f.offsetMs || 0 })))
  if (snapshot.frames?.length !== sources.length || !snapshot.frames.every((f, i) => f.panelId === sources[i].panelId && f.frameId === sources[i].frameId && f.sourceUrl === sources[i].sourceUrl && f.offsetMs === sources[i].offsetMs)) return false
  return [snapshot.first, snapshot.last].every(endpoint => {
    const p = timeline.panels.find(p => p.id === endpoint?.panelId), f = p && orderedFrames(p).find(f => frameKey(f) === endpoint?.frameId)
    return !!f && f.url === endpoint?.sourceUrl && (f.offsetMs || 0) === endpoint?.offsetMs
  })
}

export function chooseVideoContinuity(provider: string, model: string, requested: VideoContinuityMode, panels: Panel[], scope: 'storyboard' | 'group') {
  const caps = modelVideoContinuityCapabilities(provider, model)
  const fallbackReason = !caps.firstLast ? caps.reason : scope === 'group' || panels.length !== 1
    ? '首尾帧仅支持按单个分镜生成；按组生成将使用画面参考。'
    : panels[0].frames.length < 2 ? '首尾帧至少需要 2 张完整分镜画面；单画面将使用参考图。' : undefined
  if (requested === 'first_last' && fallbackReason) throw new Error(fallbackReason)
  return { actual: requested !== 'reference' && !fallbackReason ? 'first_last' as const : 'reference' as const,
    fallbackReason: requested === 'auto' ? fallbackReason : undefined }
}

export async function buildVideoContinuitySnapshot(timeline: Timeline, panels: Panel[], versionId: number, aspectRatio: string,
  requested: VideoContinuityMode, actual: 'reference' | 'first_last', fallbackReason?: string,
  freeze?: (url: string) => Promise<{ url: string; digest: string }>): Promise<VideoContinuitySnapshot> {
  const { resolvePanelContinuity } = await import('./previs-continuity.js')
  const { freezeReferenceMedia, readReferenceMedia } = await import('./previs-reference-media.js')
  const sharp = (await import('sharp')).default
  const continuity = panels.length === 1 ? resolvePanelContinuity(timeline, panels[0].id, versionId) : undefined
  const snapshot: VideoContinuitySnapshot = { version: 1, requested, actual, fallbackReason, aspectRatio, continuity }
  if (actual !== 'first_last') return snapshot
  const p = panels[0], ordered = orderedFrames(p)
  if (ordered.some(f => !f.url)) throw new Error(`「${p.title}」仍有分镜画面未完成，请全部生成或上传`)
  const freezeSource = freeze || freezeReferenceMedia
  snapshot.frames = await Promise.all(ordered.map(async frame => {
    const frozen = await freezeSource(frame.url)
    // All planned images must decode, including middle states that are represented as prompt text.
    await sharp(await readReferenceMedia(frozen.url), { limitInputPixels: 80_000_000 }).raw().toBuffer()
    return { panelId: p.id, frameId: frameKey(frame), sourceUrl: frame.url, offsetMs: frame.offsetMs || 0, digest: frozen.digest }
  }))
  const endpoint = async (panelId: number, frameId: string, sourceUrl: string, offsetMs: number): Promise<VideoEndpoint> => {
    const frozen = await freezeSource(sourceUrl)
    return { panelId, frameId, sourceUrl, offsetMs, frozenUrl: frozen.url, digest: frozen.digest }
  }
  const previous = continuity?.exactVideoBoundary && continuity.previous
  snapshot.first = previous ? await endpoint(previous.panelId, previous.frameId, previous.sourceUrl, previous.offsetMs)
    : await endpoint(p.id, frameKey(ordered[0]), ordered[0].url, ordered[0].offsetMs || 0)
  const last = ordered.at(-1)!
  snapshot.last = await endpoint(p.id, frameKey(last), last.url, last.offsetMs || 0)
  if (previous) Object.assign(previous, { frozenUrl: snapshot.first.frozenUrl, digest: snapshot.first.digest })
  return snapshot
}

/** Preserve original endpoint bytes: shared boundary remains identical at the provider. */
export async function normalizeVideoEndpoints(snapshot: VideoContinuitySnapshot) {
  const { readReferenceMedia, mediaDigest } = await import('./previs-reference-media.js')
  const sharp = (await import('sharp')).default
  if (snapshot.actual !== 'first_last' || !snapshot.first || !snapshot.last) throw new Error('视频首尾帧快照不完整')
  const urls = await Promise.all([snapshot.first, snapshot.last].map(async endpoint => {
    const buffer = await readReferenceMedia(endpoint.frozenUrl)
    if (mediaDigest(buffer) !== endpoint.digest) throw new Error('视频首尾帧冻结文件发生变化，请重新提交')
    const image = sharp(buffer, { limitInputPixels: 80_000_000 }), metadata = await image.metadata()
    await image.raw().toBuffer()
    const mime = metadata.format === 'jpeg' ? 'jpeg' : metadata.format === 'png' ? 'png' : metadata.format === 'webp' ? 'webp' : undefined
    if (!mime) throw new Error('首尾帧仅支持 PNG、JPEG 或 WebP 图片，请转换格式后重试')
    return `data:image/${mime};base64,${buffer.toString('base64')}`
  }))
  if (urls.reduce((sum, url) => sum + url.length, 0) > 48 * 1024 * 1024) throw new Error('视频首尾帧请求超过传输上限')
  return { firstFrameUrl: urls[0], lastFrameUrl: urls[1] }
}

export function videoEndpointLegend(snapshot: VideoContinuitySnapshot, panels: Panel[]) {
  return ['独立首帧与尾帧固定视频开场和结尾；中间按以下静态规划与本分镜动作自然推进，全屏呈现，不绘制宫格、分屏、文字或角标。',
    snapshot.continuity?.exactVideoBoundary ? '首帧共用前序分镜末帧，承接其静态结束状态，不重复前序整段动作。' : '',
    ...panels.flatMap(p => orderedFrames(p).map((f, i) => `计划状态${i + 1}（${(f.offsetMs || 0) / 1000}秒）：${f.prompt || p.description}；景别：${f.shotType || p.shotType}；机位：${f.angle || p.angle}；构图：${f.composition || '按画面描述'}；衔接：${f.continuity || '自然推进'}。`))].filter(Boolean).join('\n')
}
