/**
 * 统一生成任务服务 — 图片/视频生成共用 sys_task 表与同一条生命周期：
 * 创建(pending) → 全局队列领取 → 同步完成或等待异步轮询 → 下载落盘 → 回写业务表
 */
import { db, getInsertId, schema } from '../db/index.js'
import { hashContent } from './previs.js'
import { frameKey, normalizeTimeline } from './previs-domain.js'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT } from '../utils/paths.js'
import { readReferenceMedia, mediaDigest, freezeReferenceMedia } from './previs-reference-media.js'
import { and, eq, inArray } from 'drizzle-orm'
import { Agent } from 'undici'
import { getActiveConfigId, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { downloadFile, fetchImageAsCompressedDataUrl, generateImageThumb, readImageAsCompressedDataUrl, saveBase64Image } from '../utils/storage.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { getImageAdapter, getVideoAdapter } from './adapters/registry'
import type { AIConfig } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { retryRejectedRateLimit } from './task-queue-retry.js'
import { activateQueueJob, cancelQueueJob, enqueueQueueJob, finishQueueJob, getQueueJob, registerQueueExecutor, tickTaskQueue, updateQueueJob, type QueueJob } from './task-queue.js'

type TaskType = 'image' | 'video'

const taskLabel = (type: TaskType) => (type === 'image' ? 'ImageTask' : 'VideoTask')

// 生成类上游（同步工作流如 Nuwax）响应可达 5 分钟以上；Node 全局 fetch 底层默认
// headersTimeout 仅 300s，会先于下方的 AbortSignal.timeout(600s) 掐断请求，
// 表现为上游还在生成、任务却落 "fetch failed"（sys_task #25/#31 即此因）。
// 挂 10 分钟 dispatcher 后，实际超时由 AbortSignal 统一控制。
// 注意：需与 Node 内置 undici 同大版本（Node 22 = undici 6.x），跨大版本会报 invalid onRequestStart。
const generationDispatcher = new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 })

// 轮询节奏：图片 5s×120（上限 10 分钟）；视频 10s×300
const POLL_PROFILES: Record<TaskType, { attempts: number; intervalMs: number; maxDurationMs: number | null }> = {
  image: { attempts: 120, intervalMs: 5000, maxDurationMs: 600_000 },
  video: { attempts: 300, intervalMs: 10_000, maxDurationMs: null },
}

interface GenerateImageParams {
  frozenConfigHash?: string
  frozenReferences?: { url: string; digest: string }[]
  previs?: { versionId: number; itemKey: string }
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  propId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  configId?: number
}

interface GenerateVideoParams {
  frozenConfigHash?: string
  videoContinuity?: import('./previs-video-continuity.js').VideoContinuitySnapshot
  referenceInput?: import('./previs-video-reference-domain.js').VideoReferenceInput
  previs?: { versionId: number; itemKey: string }
  storyboardId?: number
  dramaId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  referenceVideoUrls?: string[]
  referenceAudioUrls?: string[]
  referenceFileUrl?: string
  referenceLinkUrl?: string
  generateAudio?: boolean
  duration?: number
  aspectRatio?: string
  resolution?: string
  seed?: number
  promptExtend?: boolean
  watermark?: boolean
  configId?: number
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置，避免生成被旧引用卡死
  const { config, configId } = await effectiveConfig('image', params.configId)
  if (!config) throw new Error('未配置图片模型，请先到「设置」页添加并启用 AI 服务')
  if (params.frozenConfigHash && hashContent(config) !== params.frozenConfigHash) throw new Error('图片配置已变化，请核对后重新提交')

  const id = await createTask('image', config, {
    animaticVersionId: params.previs?.versionId,
    previsItemKey: params.previs?.itemKey,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    propId: params.propId,
    prompt: params.prompt,
    model: params.model || config.model,
  }, {
    configId,
    size: params.size || '1920x1080',
    frameType: params.frameType,
    referenceImages: params.referenceImages,
    frozenConfigHash: hashContent(config),
    strictImageSize: !!params.frozenConfigHash && !!params.previs?.itemKey.startsWith('grid-'),
    frozenReferences: params.frozenReferences || await Promise.all(uniqueReferences(params.referenceImages).slice(0, 6).map(freezeReferenceMedia)),
  })

  logTaskStart('ImageTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  if (!params.previs) logTaskPayload('ImageTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
}

export async function generateVideo(params: GenerateVideoParams): Promise<number> {
  // 指定配置（集锁定）可能已停用/删除/厂商收敛，失效时回退到当前启用配置
  const { config, configId } = await effectiveConfig('video', params.configId)
  if (!config) throw new Error('未配置视频模型，请先到「设置」页添加并启用 AI 服务')
  if (params.frozenConfigHash && hashContent(config) !== params.frozenConfigHash) throw new Error('视频配置已变化，请核对后重新提交')

  const id = await createTask('video', config, {
    animaticVersionId: params.previs?.versionId,
    previsItemKey: params.previs?.itemKey,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    prompt: params.prompt,
    model: params.model || config.model,
  }, {
    configId,
    frozenConfigHash: hashContent(config),
    frozenVideoImages: await freezeVideoImages(params),
    frozenMedia: await Promise.all(uniqueReferences([
      ...(params.referenceVideoUrls || []), ...(params.referenceAudioUrls || []), params.referenceFileUrl || '',
    ]).map(async url => ({ url, digest: await referenceFileDigest(url) }))),
    referenceMode: params.referenceMode || 'reference',
    imageUrl: params.imageUrl,
    firstFrameUrl: params.firstFrameUrl,
    lastFrameUrl: params.lastFrameUrl,
    referenceImageUrls: params.referenceImageUrls,
    referenceInput: params.referenceInput,
    videoContinuity: params.videoContinuity,
    referenceVideoUrls: params.referenceVideoUrls,
    referenceAudioUrls: params.referenceAudioUrls,
    referenceFileUrl: params.referenceFileUrl,
    referenceLinkUrl: params.referenceLinkUrl,
    generateAudio: params.generateAudio === false ? 0 : 1,
    duration: params.duration,
    aspectRatio: params.aspectRatio,
    // 统一存为项目内部格式，各适配器再转换为官方大小写与枚举。
    resolution: normalizeStoredVideoResolution(params.resolution),
    seed: params.seed,
    promptExtend: params.promptExtend,
    watermark: params.watermark,
  })

  logTaskStart('VideoTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    referenceMode: params.referenceMode || 'reference',
    duration: params.duration || 5,
  })
  if (!params.previs) logTaskPayload('VideoTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
}

async function effectiveConfig(type: TaskType, requestedId?: number) {
  const requested = requestedId ? await getConfigById(requestedId) : null
  const configId = requested ? requestedId! : await getActiveConfigId(type)
  return { configId, config: requested || (configId ? await getConfigById(configId) : null) }
}

function uniqueReferences(refs?: string[] | null) {
  return [...new Set((refs || []).map(value => String(value || '').trim()).filter(Boolean))]
}

async function freezeVideoImages(params: GenerateVideoParams) {
  const sources = uniqueReferences([
    params.imageUrl || '', params.firstFrameUrl || '', params.lastFrameUrl || '',
    ...(params.referenceInput ? [] : params.referenceImageUrls || []),
  ])
  return Object.fromEntries(await Promise.all(sources.map(async source => [source, await freezeReferenceMedia(source)])))
}

/** Video/audio files are streamed, avoiding an image-size limit or buffering large uploads. */
async function referenceFileDigest(url: string): Promise<string> {
  const hash = createHash('sha256')
  if (url.startsWith('data:')) {
    const match = /^data:[^,]+;base64,(.*)$/s.exec(url)
    if (!match) throw new Error('参考媒体数据格式无效')
    return hash.update(Buffer.from(match[1], 'base64')).digest('hex')
  }
  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(600_000) })
    if (!response.ok || !response.body) throw new Error(`读取参考媒体失败：HTTP ${response.status}`)
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
      }
    } finally { await reader.cancel().catch(() => {}) }
  } else {
    const root = await realpath(STORAGE_ROOT)
    const file = await realpath(path.resolve(STORAGE_ROOT, url.replace(/^\/?static\//, '')))
    if (!file.startsWith(root + path.sep)) throw new Error('参考媒体文件路径无效')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
  }
  return hash.digest('hex')
}

async function createTask(
  type: TaskType,
  config: AIConfig,
  fields: {
    animaticVersionId?: number
    previsItemKey?: string
    storyboardId?: number
    dramaId?: number
    sceneId?: number
    characterId?: number
    propId?: number
    prompt: string
    model?: string | null
  },
  params: Record<string, unknown>,
): Promise<number> {
  const ts = now()
  const id = (await db.transaction(async tx => {
    const res = (await tx.insert(schema.sysTask).values({
      type, ...fields, provider: config.provider, params: JSON.stringify(params),
      status: 'pending', createdAt: ts, updatedAt: ts,
    }).run())
    const id = getInsertId(res)
    const record = (await tx.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get())!
    ;await enqueueGenerationTask(record, { ready: !fields.previsItemKey })
    return id
  }))
  return id
}

/** Previs parents link their child before opening the queue submission gate. */
export async function startQueuedPrevisTask(id: number) {
  const record = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get())
  if (!record?.previsItemKey || record.status !== 'pending') return
  let job = (await getQueueJob('sys_task', id))
  if (!job) {
    ;await enqueueGenerationTask(record, { ready: false })
    job = (await getQueueJob('sys_task', id))!
  }
  if (!(await previsParentReady(record))) return
  try {
    await validateQueuedConfig(record)
    validateTaskSnapshot(record, job)
    await activateQueueJob('sys_task', id)
    await tickTaskQueue()
  } catch (error) {
    const message = (error as Error).message
    await failTask(id, message)
    await finishQueueJob(job.id, { status: 'failed', error: message })
  }
}

/** Legacy task migration only; the global queue owns all restart recovery. */
export async function recoverPrevisTasks() {
  const tasks = (await db.select().from(schema.sysTask)
    .where(inArray(schema.sysTask.status, ['pending', 'processing'])).all())
  for (const task of tasks) {
    if ((await getQueueJob('sys_task', task.id))) continue
    const params = parseTaskParams(task.params)
    // Existing accepted tasks keep their original tracking, even if the config is no longer usable.
    if (!params.configId && task.status === 'pending') {
      const selected = await effectiveConfig(task.type as TaskType)
      if (selected.config && selected.configId) {
        params.configId = selected.configId
        params.frozenConfigHash = hashContent(selected.config)
        ;await db.update(schema.sysTask).set({ params: JSON.stringify(params) }).where(eq(schema.sysTask.id, task.id)).run()
        task.params = JSON.stringify(params)
      }
    }
    ;await enqueueGenerationTask(task, { ready: !task.previsItemKey || (await previsParentReady(task)), legacy: true })
  }
}

function generationSnapshot(task: SysTaskRecord) {
  const { submissionStarted: _submitted, submissionRejected: _rejected, ...params } = parseTaskParams(task.params)
  return { type: task.type, provider: task.provider, prompt: task.prompt, model: task.model,
    animaticVersionId: task.animaticVersionId, previsItemKey: task.previsItemKey,
    storyboardId: task.storyboardId, dramaId: task.dramaId, sceneId: task.sceneId,
    characterId: task.characterId, propId: task.propId, params }
}

async function enqueueGenerationTask(task: SysTaskRecord, options: { ready: boolean; legacy?: boolean }) {
  const snapshot = generationSnapshot(task), params = snapshot.params
  return (await enqueueQueueJob({ ownerType: 'sys_task', ownerId: task.id, kind: task.type as TaskType,
    projectId: (await generationProjectId(task)), configId: params.configId || undefined,
    inputHash: hashContent(snapshot), snapshotJson: JSON.stringify(snapshot),
    source: task.previsItemKey ? 'previs' : 'generation', ready: options.ready,
    ...(options.legacy ? { initialStatus: task.status === 'processing' ? 'processing' as const : 'pending' as const,
      initialPhase: task.resultUrl || task.localPath ? 'saving' : task.taskId ? 'polling' : params.submissionStarted ? 'submitting' : 'queued',
      // Older ordinary tasks never stored a submission boundary. A processing row
      // without a queue record must be treated as accepted/ambiguous, never resubmitted.
      submitted: task.status === 'processing' || !!(params.submissionStarted || task.taskId || task.resultUrl || task.localPath),
      externalTaskId: task.taskId, upstreamDone: !!(task.resultUrl || task.localPath) } : {}),
  }))
}

async function generationProjectId(task: SysTaskRecord): Promise<number | undefined> {
  if (task.dramaId) return task.dramaId
  if (task.characterId) return (await db.select().from(schema.characters).where(eq(schema.characters.id, task.characterId)).get())?.dramaId
  if (task.sceneId) return (await db.select().from(schema.scenes).where(eq(schema.scenes.id, task.sceneId)).get())?.dramaId
  if (task.propId) return (await db.select().from(schema.props).where(eq(schema.props.id, task.propId)).get())?.dramaId
  const storyboard = task.storyboardId ? (await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, task.storyboardId)).get()) : null
  const version = task.animaticVersionId ? (await db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, task.animaticVersionId)).get()) : null
  const episodeId = storyboard?.episodeId || version?.episodeId
  return episodeId ? (await db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get())?.dramaId : undefined
}

async function retryPrevisParent(task: SysTaskRecord) {
  if (!task.previsItemKey) return
  const version = task.animaticVersionId ? (await db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, task.animaticVersionId)).get()) : null
  if (!version || (task.type === 'image' && version.status === 'locked')) throw new Error('故事版已锁定或不存在，无法重试生成')
  const gridId = /^grid-(\d+)$/.exec(task.previsItemKey), batchKey = /^(\d+):(\d+)$/.exec(task.previsItemKey)
  if (gridId) {
    const parent = (await db.select().from(schema.gridCandidates).where(eq(schema.gridCandidates.id, Number(gridId[1]))).get())
    if (!parent || parent.taskId !== task.id || parent.status === 'discarded') throw new Error('宫格生成已取消，无法重试')
    ;await db.update(schema.gridCandidates).set({ status: 'pending', error: null, updatedAt: now() }).where(eq(schema.gridCandidates.id, parent.id)).run()
  }
  if (batchKey) {
    const item = (await db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, Number(batchKey[1]))).get())
    const batch = item ? (await db.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, item.batchId)).get()) : null
    if (!item || item.taskId !== task.id || item.attempt !== Number(batchKey[2]) || !batch || batch.status === 'cancelled') throw new Error('批次任务已取消或已替换，无法重试')
    if (task.type === 'image') {
      const request = JSON.parse(item.requestJson), timeline = normalizeTimeline(JSON.parse(version.timelineJson))
      const frame = timeline.panels.find(panel => panel.id === item.panelId)?.frames.find(frame => request.frameId ? frameKey(frame) === request.frameId : frame.type === item.frameType)
      if (frame?.locked) throw new Error('画面已锁定，请解除画面锁定后再重试')
    }
    ;await db.update(schema.batchRunItems).set({ status: 'pending', error: null }).where(eq(schema.batchRunItems.id, item.id)).run()
    ;await db.update(schema.batchRuns).set({ status: 'pending' }).where(eq(schema.batchRuns.id, batch.id)).run()
  }
}

async function cancelPrevisParent(task: SysTaskRecord) {
  const gridId = /^grid-(\d+)$/.exec(task.previsItemKey || ''), batchKey = /^(\d+):(\d+)$/.exec(task.previsItemKey || '')
  if (gridId) await db.update(schema.gridCandidates).set({ status: 'discarded', updatedAt: now() })
    .where(and(eq(schema.gridCandidates.id, Number(gridId[1])), inArray(schema.gridCandidates.status, ['pending', 'processing']))).run()
  if (batchKey) await db.update(schema.batchRunItems).set({ status: 'cancelled' })
    .where(and(eq(schema.batchRunItems.id, Number(batchKey[1])), eq(schema.batchRunItems.taskId, task.id), eq(schema.batchRunItems.attempt, Number(batchKey[2])))).run()
}

function validateTaskSnapshot(task: SysTaskRecord, job: QueueJob) {
  if (hashContent(generationSnapshot(task)) !== job.inputHash) throw new Error('排队任务输入已变化，请重新提交')
}

async function validateQueuedConfig(task: SysTaskRecord): Promise<AIConfig> {
  const params = parseTaskParams(task.params)
  const config = params.configId ? await getConfigById(params.configId) : null
  if (!config) throw new Error('生成配置已停用，请启用后重试')
  if (params.frozenConfigHash && hashContent(config) !== params.frozenConfigHash) {
    throw new Error('生成配置已变化，请核对后重新提交')
  }
  return config
}

async function previsParentReady(task: SysTaskRecord): Promise<boolean> {
  const key = task.previsItemKey
  if (!key) return true
  const gridId = /^grid-(\d+)$/.exec(key), batchKey = /^(\d+):(\d+)$/.exec(key)
  if (gridId) {
    const parent = (await db.select().from(schema.gridCandidates).where(eq(schema.gridCandidates.id, Number(gridId[1]))).get())
    return !!parent && parent.taskId === task.id && ['pending', 'processing'].includes(parent.status || '')
  }
  if (batchKey) {
    const item = (await db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, Number(batchKey[1]))).get())
    const batch = item ? (await db.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, item.batchId)).get()) : null
    return !!item && item.taskId === task.id && ['pending', 'processing'].includes(item.status || '')
      && item.attempt === Number(batchKey[2]) && !!batch && batch.status !== 'cancelled'
  }
  return true
}

function parseTaskParams(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) || {}
  } catch {
    return {}
  }
}

/** Cancels queued/reference preparation work, but retains submitted task tracking. */
export async function cancelUnsubmittedPrevisTask(id: number) {
  const record = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get())
  if (!record?.previsItemKey || !['pending', 'processing'].includes(record.status || '')) return
  const job = (await getQueueJob('sys_task', id))
  if (job && !job.submitted) { (await cancelQueueJob(job.id)); return }
  return (await db.transaction(async tx => {
    const task = (await tx.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get())
    if (!task?.previsItemKey || !['pending', 'processing'].includes(task.status || '')
      || parseTaskParams(task.params).submissionStarted || task.taskId || task.resultUrl || task.localPath) return
    await tx.update(schema.sysTask).set({ status: 'cancelled', updatedAt: now() })
      .where(eq(schema.sysTask.id, id)).run()
  }))
}

// This synchronous boundary runs immediately before fetch: discard during async
// image reads prevents submission; once started, tracking continues until completion.
async function beginPrevisSubmission(id: number): Promise<boolean> {
  return (await db.transaction(async tx => {
    const task = (await tx.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get())
    if (!task || task.status !== 'processing') return false
    const gridId = /^grid-(\d+)$/.exec(task.previsItemKey || '')
    const batchKey = /^(\d+):(\d+)$/.exec(task.previsItemKey || '')
    const item = batchKey ? (await tx.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, Number(batchKey[1]))).get()) : null
    const batch = item ? (await tx.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, item.batchId)).get()) : null
    const grid = gridId ? await tx.select().from(schema.gridCandidates).where(eq(schema.gridCandidates.id, Number(gridId[1]))).get() : null
    const cancelledGrid = gridId && grid?.status !== 'processing'
    const cancelledBatch = batchKey && (!item || item.status !== 'processing' || item.attempt !== Number(batchKey[2]) || !batch || batch.status === 'cancelled')
    if (cancelledGrid || cancelledBatch) {
      await tx.update(schema.sysTask).set({ status: 'cancelled', updatedAt: now() }).where(eq(schema.sysTask.id, id)).run()
      return false
    }
    await tx.update(schema.sysTask).set({ params: JSON.stringify({ ...parseTaskParams(task.params), submissionStarted: true }), updatedAt: now() })
      .where(eq(schema.sysTask.id, id)).run()
    const job = (await getQueueJob('sys_task', id))
    if (job) (await updateQueueJob(job.id, { phase: 'submitting', submitted: true }))
    return true
  }))
}

async function processTask(id: number, config: AIConfig) {
  try {
    const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (!record) return
    const type = record.type as TaskType
    const label = taskLabel(type)
    const params = parseTaskParams(record.params)
    logTaskProgress(label, 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
    })

    let url: string, method: string, headers: Record<string, string>, body: unknown

    if (type === 'image') {
      const adapter = getImageAdapter(config.provider)
      const resolvedReferenceImages = params.frozenReferences
        ? await normalizeFrozenImageReferences(params.frozenReferences)
        : await normalizeReferenceImages(params.referenceImages)
      ;({ url, method, headers, body } = adapter.buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        size: params.size,
        strictSize: params.strictImageSize ?? !!(record.previsItemKey && params.frozenConfigHash),
        frameType: params.frameType,
        referenceImages: resolvedReferenceImages.length ? JSON.stringify(resolvedReferenceImages) : null,
      }))
    } else {
      const adapter = getVideoAdapter(config.provider)
      for (const ref of params.frozenMedia || []) {
        if (await referenceFileDigest(ref.url) !== ref.digest) throw new Error('冻结的参考媒体已变化，停止提交')
      }
      const frozenVideoImage = async (value: string | undefined) => value && params.frozenVideoImages?.[value]
        ? (await normalizeFrozenImageReferences([params.frozenVideoImages[value]]))[0] : await normalizeVideoReferenceUrl(value)
      const resolvedImageUrl = await frozenVideoImage(params.imageUrl)
      const endpoints = params.videoContinuity?.actual === 'first_last'
        ? await (await import('./previs-video-continuity.js')).normalizeVideoEndpoints(params.videoContinuity) : undefined
      const resolvedFirstFrameUrl = endpoints?.firstFrameUrl || await frozenVideoImage(params.firstFrameUrl)
      const resolvedLastFrameUrl = endpoints?.lastFrameUrl || await frozenVideoImage(params.lastFrameUrl)
      const resolvedReferenceImageUrls = params.referenceInput
        ? await (await import('./previs-video-reference-normalizer.js')).normalizeSnapshotImages(params.referenceInput)
        : (await Promise.all(uniqueReferences(params.referenceImageUrls).map(frozenVideoImage))).filter((value): value is string => !!value)
      if (record.animaticVersionId && ((params.firstFrameUrl && !resolvedFirstFrameUrl)
        || (params.lastFrameUrl && !resolvedLastFrameUrl)
        || resolvedReferenceImageUrls.length !== (params.referenceInput ? params.referenceInput.imageUrls.length : new Set(params.referenceImageUrls || []).size))) {
        throw new Error('选用的分镜画面无法读取，请重新上传或重新选择；本次未提交视频生成')
      }
      // 参考视频/音频文件较大，不适合 dataURL 内联，需解析为公网可访问 URL
      const resolvedReferenceVideoUrls = resolvePublicMediaUrls(params.referenceVideoUrls, 'video')
      const resolvedReferenceAudioUrls = resolvePublicMediaUrls(params.referenceAudioUrls, 'audio')
      const resolvedReferenceFileUrl = resolvePublicMediaUrl(params.referenceFileUrl, 'file')
      ;({ url, method, headers, body } = adapter.buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        referenceMode: params.referenceMode,
        imageUrl: resolvedImageUrl,
        firstFrameUrl: resolvedFirstFrameUrl,
        lastFrameUrl: resolvedLastFrameUrl,
        referenceImageUrls: resolvedReferenceImageUrls.length ? JSON.stringify(resolvedReferenceImageUrls) : null,
        referenceVideoUrls: resolvedReferenceVideoUrls.length ? JSON.stringify(resolvedReferenceVideoUrls) : null,
        referenceAudioUrls: resolvedReferenceAudioUrls.length ? JSON.stringify(resolvedReferenceAudioUrls) : null,
        referenceFileUrl: resolvedReferenceFileUrl,
        referenceLinkUrl: params.referenceLinkUrl,
        generateAudio: params.generateAudio,
        duration: params.duration,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        seed: params.seed,
        promptExtend: params.promptExtend,
        watermark: params.watermark,
      }))
    }

    logTaskProgress(label, 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })

    const isMultipart = body instanceof FormData
    if (!record.animaticVersionId) logTaskPayload(label, 'request payload', {
      id, method, url, headers,
      // multipart 表单（如 OpenAI /v1/images/edits）无法 JSON 化，记录字段摘要
      body: isMultipart ? `[multipart/form-data: ${[...(body as FormData).keys()].join(', ')}]` : body,
    })

    const resp = await retryRejectedRateLimit(async attempt => {
      if (attempt) {
        await validateQueuedConfig(record)
        for (const ref of params.frozenMedia || []) {
          if (await referenceFileDigest(ref.url) !== ref.digest) throw new Error('冻结的参考媒体已变化，停止提交')
        }
      }
      if (!(await beginPrevisSubmission(id))) return null
      const response = await fetch(url, {
        method, headers,
        body: isMultipart ? (body as FormData) : JSON.stringify(body),
        signal: AbortSignal.timeout(600_000), dispatcher: generationDispatcher,
      } as RequestInit)
      if (!response.ok) {
        const message = `API error ${response.status}: ${await response.text()}`
        const error = Object.assign(new Error(message), { status: response.status, responseHeaders: response.headers })
        // Gateways and server errors may occur after an upstream accepted the paid job.
        if (![400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status)) throw error
        const job = (await getQueueJob('sys_task', id))
        const current = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get())!
        ;await db.update(schema.sysTask).set({ params: JSON.stringify({ ...parseTaskParams(current.params), submissionStarted: false, submissionRejected: true }) }).where(eq(schema.sysTask.id, id)).run()
        if (job) (await updateQueueJob(job.id, { submitted: false, phase: 'rejected' }))
        throw error
      }
      return response
    }, async (_error, retry, delayMs) => {
      const job = (await getQueueJob('sys_task', id))
      if (job) (await updateQueueJob(job.id, { phase: 'retry_wait' }))
      logTaskWarn(label, 'rate-limit-retry', { id, retry, delayMs })
    })
    if (!resp) return
    const result = await resp.json() as any
    logTaskPayload(label, 'response payload', { id, provider: config.provider, result })

    if (type === 'image') {
      const adapter = getImageAdapter(config.provider)
      const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

      if (!isAsync && imageUrl) {
        logTaskProgress(label, 'sync-complete', { id, imageUrl })
        await handleImageComplete(record, imageUrl)
        return
      }

      if (!isAsync && !imageUrl) {
        // 同步模式但无 URL（Gemini 等返回 base64）
        const b64 = adapter.extractImageBase64(result)
        if (b64) {
          logTaskProgress(label, 'sync-base64-complete', { id, mimeType: b64.mimeType })
          await handleImageCompleteBase64(record, b64.data, b64.mimeType)
          return
        }
        throw new Error('No image URL or base64 data in response')
      }

      await markPolling(id, taskId)
      await pollTask(record, config, taskId!)
      return
    }

    const adapter = getVideoAdapter(config.provider)
    const { isAsync, taskId, videoUrl } = adapter.parseGenerateResponse(result)

    if (!isAsync && videoUrl) {
      logTaskProgress(label, 'sync-complete', { id, videoUrl })
      await handleVideoComplete(record, videoUrl, params.duration)
      return
    }

    await markPolling(id, taskId)
    await pollTask(record, config, taskId!)
  } catch (err: any) {
    const task = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get())
    const job = (await getQueueJob('sys_task', id))
    if (task?.status !== 'cancelled') {
      if (job?.submitted && !job.upstreamDone) await needsConfirmation(id, err.message)
      else await failTask(id, err.message)
    }
  }
}

async function markPolling(id: number, taskId: string | undefined) {
  if (!taskId) throw new Error('上游响应缺少任务编号，请核对服务商记录')
  await db.update(schema.sysTask)
    .set({ taskId, status: 'processing', updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
  const job = (await getQueueJob('sys_task', id))
  if (job) (await updateQueueJob(job.id, { externalTaskId: taskId, phase: 'polling', submitted: true }))
  logTaskProgress('SysTask', 'poll-start', { id, taskId })
}

async function failTask(id: number, message: string) {
  logTaskError('SysTask', 'failed', { id, error: message })
  await db.update(schema.sysTask)
    .set({ status: 'failed', errorMsg: message, updatedAt: now() })
    .where(eq(schema.sysTask.id, id))
}

type SysTaskRecord = typeof schema.sysTask.$inferSelect

async function needsConfirmation(id: number, message: string) {
  const error = `提交结果待确认，请核对服务商记录，避免重复扣费：${message}`
  ;await db.update(schema.sysTask).set({ status: 'processing', errorMsg: error, updatedAt: now() }).where(eq(schema.sysTask.id, id)).run()
  const job = (await getQueueJob('sys_task', id))
  if (job) (await updateQueueJob(job.id, { phase: 'needs_confirmation', error }))
}

async function upstreamDone(id: number) {
  const job = (await getQueueJob('sys_task', id))
  if (job) (await updateQueueJob(job.id, { upstreamDone: true, phase: 'saving' }))
}

async function executeGenerationJob(job: QueueJob) {
  try {
    const task = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, job.ownerId)).get())
    if (!task) return { status: 'failed' as const, error: '生成任务不存在' }
    if (task.status === 'completed') return { status: 'completed' as const }
    validateTaskSnapshot(task, job)
    if (!job.submitted && task.previsItemKey && !(await previsParentReady(task))) throw new Error('预演任务父项已取消或已变化')
    ;await db.update(schema.sysTask).set({ status: 'processing', errorMsg: null, updatedAt: now() }).where(eq(schema.sysTask.id, task.id)).run()
    if (!job.submitted && task.previsItemKey) {
      const grid = /^grid-(\d+)$/.exec(task.previsItemKey), batch = /^(\d+):(\d+)$/.exec(task.previsItemKey)
      if (grid) await db.update(schema.gridCandidates).set({ status: 'processing', updatedAt: now() }).where(eq(schema.gridCandidates.id, Number(grid[1]))).run()
      if (batch) await db.update(schema.batchRunItems).set({ status: 'processing' }).where(eq(schema.batchRunItems.id, Number(batch[1]))).run()
    }
    if (task.localPath) {
      if (task.type === 'image') {
        await readReferenceMedia(task.localPath)
        await generateImageThumb(task.localPath)
        await writeBackImageAssets(task, task.localPath)
      } else {
        await referenceFileDigest(task.localPath)
        await extractVideoPoster(task.localPath)
        await writeBackVideoAssets(task, task.localPath, parseTaskParams(task.params).duration)
      }
      upstreamDone(task.id)
      ;await db.update(schema.sysTask).set({ status: 'completed', completedAt: now(), updatedAt: now() }).where(eq(schema.sysTask.id, task.id)).run()
    } else if (task.resultUrl) {
      const data = /^data:([^;]+);base64,(.+)$/s.exec(task.resultUrl)
      if (task.type === 'image' && data) await handleImageCompleteBase64(task, data[2], data[1])
      else if (task.type === 'image') await handleImageComplete(task, task.resultUrl)
      else await handleVideoComplete(task, task.resultUrl, parseTaskParams(task.params).duration)
    } else if (task.taskId || job.externalTaskId) {
      const config = await validateQueuedConfig(task)
      await pollTask(task, config, task.taskId || job.externalTaskId!)
    } else if (job.submitted) {
      await needsConfirmation(task.id, '服务重启或响应中断时尚未取得外部任务编号')
    } else {
      const config = await validateQueuedConfig(task)
      await processTask(task.id, config)
    }
  } catch (error) {
    const current = (await getQueueJob('sys_task', job.ownerId))
    if (current?.submitted && !current.upstreamDone) await needsConfirmation(job.ownerId, (error as Error).message)
    else await failTask(job.ownerId, (error as Error).message)
  }
  const task = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, job.ownerId)).get())
  const current = (await getQueueJob('sys_task', job.ownerId))
  return { status: task?.status === 'completed' ? 'completed' as const
    : current?.phase === 'needs_confirmation' ? 'needs_confirmation' as const : 'failed' as const,
    error: task?.errorMsg || undefined }
}

registerQueueExecutor('sys_task', {
  execute: executeGenerationJob,
  recover: executeGenerationJob,
  async onRequeue(job) {
    await db.update(schema.sysTask).set({ status: 'pending', errorMsg: null, updatedAt: now() })
      .where(and(eq(schema.sysTask.id, job.ownerId), eq(schema.sysTask.status, 'processing'))).run()
  },
  async onCancel(job) {
    const task = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, job.ownerId)).get())
    if (task) await cancelPrevisParent(task)
    ;await db.update(schema.sysTask).set({ status: 'cancelled', updatedAt: now() }).where(eq(schema.sysTask.id, job.ownerId)).run()
  },
  async onReconcile(job) {
    await db.update(schema.sysTask).set({ status: 'failed', errorMsg: '已人工确认上游任务结束，可根据需要重新提交', updatedAt: now() })
      .where(eq(schema.sysTask.id, job.ownerId)).run()
  },
  async onRetry(job) {
    const task = (await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, job.ownerId)).get())
    if (!task) return
    ;await retryPrevisParent(task)
    const params = parseTaskParams(task.params)
    if (!task.resultUrl && !task.localPath) {
      delete params.submissionStarted
      delete params.submissionRejected
      await updateQueueJob(job.id, { submitted: false, externalTaskId: null, upstreamDone: false })
    }
    await db.update(schema.sysTask).set({ status: 'pending', errorMsg: null, params: JSON.stringify(params),
      ...(!task.resultUrl && !task.localPath ? { taskId: null } : {}), updatedAt: now() }).where(eq(schema.sysTask.id, job.ownerId)).run()
  },
})

async function pollTask(record: SysTaskRecord, config: AIConfig, taskId: string) {
  const type = record.type as TaskType
  const label = taskLabel(type)
  const profile = POLL_PROFILES[type]
  const adapter = type === 'image' ? getImageAdapter(config.provider) : getVideoAdapter(config.provider)
  const startedAt = Date.now()

  for (let i = 0; i < profile.attempts; i++) {
    if (profile.maxDurationMs && Date.now() - startedAt >= profile.maxDurationMs) {
      await needsConfirmation(record.id, 'Timeout: Polling exceeded 10 minutes')
      return
    }
    await new Promise(r => setTimeout(r, profile.intervalMs))
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId)
      logTaskProgress(label, 'poll-request', {
        id: record.id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = profile.maxDurationMs
        ? Math.max(1_000, profile.maxDurationMs - (Date.now() - startedAt))
        : 600_000
      const resp = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(remainingMs),
        dispatcher: generationDispatcher,
      } as RequestInit)
      if (!resp.ok) continue
      const result = await resp.json() as any

      // 图片/视频 PollResponse 结构不同，这里统一按 any 取值后按 type 分支
      const pollResp: any = adapter.parsePollResponse(result)

      if (pollResp.status === 'completed') {
        if (type === 'image') {
          if (pollResp.imageUrl) {
            logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, imageUrl: pollResp.imageUrl })
            await handleImageComplete(record, pollResp.imageUrl)
            return
          }
          if (adapter.provider === 'gemini') {
            // Gemini 可能返回 base64
            const b64 = (adapter as ReturnType<typeof getImageAdapter>).extractImageBase64(result)
            if (b64) {
              logTaskSuccess(label, 'poll-base64-complete', { id: record.id, taskId, mimeType: b64.mimeType })
              await handleImageCompleteBase64(record, b64.data, b64.mimeType)
              return
            }
          }
        } else if (pollResp.videoUrl) {
          logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, videoUrl: pollResp.videoUrl })
          await handleVideoComplete(record, pollResp.videoUrl, pollResp.duration)
          return
        }
      }
      if (pollResp.status === 'failed') {
        // 上游明确失败（如内容审核拦截）属终态：立即落库，不重试不等待超时
        const job = (await getQueueJob('sys_task', record.id))
        if (job) (await updateQueueJob(job.id, { upstreamDone: true, phase: 'upstream_failed' }))
        await failTask(record.id, pollResp.error || 'Generation failed')
        return
      }
    } catch (err: any) {
      if ((await getQueueJob('sys_task', record.id))?.upstreamDone) {
        await failTask(record.id, `已保留模型结果，本地保存失败：${err.message}`)
        return
      }
      const exhausted = i === profile.attempts - 1
        || (profile.maxDurationMs != null && Date.now() - startedAt >= profile.maxDurationMs)
      if (exhausted) {
        await needsConfirmation(record.id, `Timeout: ${err.message}`)
        return
      }
      logTaskWarn(label, 'poll-retry', { id: record.id, taskId, attempt: i + 1, error: err.message })
    }
  }
  await needsConfirmation(record.id, 'Timeout: polling attempts exhausted')
}

async function handleImageComplete(record: SysTaskRecord, imageUrl: string) {
  // Persist the paid upstream result before local I/O so download failures can be repaired freely.
  await db.update(schema.sysTask).set({ resultUrl: imageUrl, updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
  upstreamDone(record.id)
  const localPath = await downloadFile(imageUrl, 'images')
  // 列表页缩略图（前端按命名约定推导地址，失败不影响主流程）
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ resultUrl: imageUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'downloaded', { id: record.id, provider: record.provider, localPath })

  await writeBackImageAssets(record, localPath)
}

async function handleImageCompleteBase64(record: SysTaskRecord, base64Data: string, mimeType: string) {
  await db.update(schema.sysTask).set({ resultUrl: `data:${mimeType};base64,${base64Data}`, updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
  upstreamDone(record.id)
  const localPath = await saveBase64Image(base64Data, mimeType, 'images')
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'saved-base64', { id: record.id, provider: record.provider, mimeType, localPath })

  await writeBackImageAssets(record, localPath)
}

// 图片完成后回写业务表：分镜(按 frameType)、角色、场景、道具
async function writeBackImageAssets(record: SysTaskRecord, localPath: string) {
  // 故事版任务通过 previs-batch 绑定结果，回写共享资产前会校验最新意图
  if (record.animaticVersionId) return
  const params = parseTaskParams(record.params)
  if (record.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (params.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (params.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    await db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId))
  }
  if (record.characterId) {
    await db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId))
  }
  if (record.sceneId) {
    await db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId))
  }
  if (record.propId) {
    await db.update(schema.props).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.props.id, record.propId))
  }
}

async function handleVideoComplete(record: SysTaskRecord, videoUrl: string, duration: number | null | undefined) {
  await db.update(schema.sysTask).set({ resultUrl: videoUrl, updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
  upstreamDone(record.id)
  const localPath = await downloadFile(videoUrl, 'videos')
  // 海报帧供列表/封面展示，避免前端为显示首帧缓冲整个视频
  await extractVideoPoster(localPath)
  await db.update(schema.sysTask)
    .set({ resultUrl: videoUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('VideoTask', 'downloaded', { id: record.id, localPath, storyboardId: record.storyboardId, duration })

  await writeBackVideoAssets(record, localPath, duration)
}

async function writeBackVideoAssets(record: SysTaskRecord, localPath: string, duration: number | null | undefined) {
  if (record.storyboardId && !record.animaticVersionId) {
    await db.update(schema.storyboards)
      .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
      .where(eq(schema.storyboards.id, record.storyboardId))
  }
}

// ─── 参考素材归一化 ───────────────────────────────────────────────

export async function normalizeFrozenImageReferences(refs: { url: string; digest: string }[]): Promise<string[]> {
  return Promise.all(refs.map(async ref => {
    const buffer = await readReferenceMedia(ref.url)
    if (mediaDigest(buffer) !== ref.digest) throw new Error('冻结的参考图片已变化，停止提交')
    const metadata = await sharp(buffer, { limitInputPixels: 80_000_000 }).metadata()
    if (!metadata.width || !metadata.height) throw new Error('参考图片无法解码，停止提交')
    const format = metadata.format
    if (format === 'jpeg' || format === 'png' || format === 'webp') return `data:image/${format};base64,${buffer.toString('base64')}`
    const png = await sharp(buffer).rotate().png().toBuffer()
    return `data:image/png;base64,${png.toString('base64')}`
  }))
}

async function normalizeReferenceImages(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []

  const deduped = Array.from(
    new Set(
      refs
        .map((item) => String(item || '').trim())
        .filter(Boolean),
    ),
  )

  const normalized = await Promise.all(deduped.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        return null
      }
    }
    // 远程 URL：下载压缩为 data URL，保证 multipart 上传（OpenAI edits）/ inline_data（Gemini）都可用
    if (/^https?:\/\//.test(value)) {
      try {
        return await fetchImageAsCompressedDataUrl(value, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-fetch-failed', { url: value, error: (err as Error).message })
        return null
      }
    }
    return value
  }))

  return normalized.filter((item): item is string => !!item).slice(0, 6)
}

async function normalizeVideoReferenceUrl(value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    try {
      return await readImageAsCompressedDataUrl(localPath, {
        maxWidth: 768,
        maxHeight: 768,
        quality: 68,
      })
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      return null
    }
  }
  return raw
}

async function normalizeVideoReferenceUrls(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map(async (item) => (await normalizeVideoReferenceUrl(item))),
  )
  return normalized.filter((item): item is string => !!item)
}

/**
 * 将参考视频/音频解析为 Seedance API 可访问的 URL。
 * http(s)/dataURL 直通；本地 static 路径需要 PUBLIC_BASE_URL 拼成公网地址，
 * 未配置时抛出可操作的中文错误（落入 catch 写入 error_msg 供前端展示）。
 */
function resolvePublicMediaUrl(value: string | null | undefined, kind: 'video' | 'audio' | 'file'): string | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')
    if (!base) {
      const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文件'
      throw new Error(
        `参考${label}为本地路径 ${raw}，但后端未配置 PUBLIC_BASE_URL，上游视频生成 API 无法访问内网地址。` +
        `请在 backend/.env 配置 PUBLIC_BASE_URL（如 https://your-domain.com）后重试，或改用公网 URL。`,
      )
    }
    const p = raw.startsWith('/') ? raw : `/${raw}`
    return `${base}${p}`
  }
  return raw
}

function resolvePublicMediaUrls(refs: string[] | null | undefined, kind: 'video' | 'audio'): string[] {
  if (!Array.isArray(refs) || !refs.length) return []
  const items = Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean)))
  return items.map((item) => resolvePublicMediaUrl(item, kind)).filter((item): item is string => !!item)
}

function normalizeStoredVideoResolution(resolution: string | null | undefined): string | undefined {
  const value = String(resolution || '').trim().toLowerCase()
  if (value === '480p' || value === '720p' || value === '1080p') return value
  if (value === '2k') return '2K'
  return undefined
}
