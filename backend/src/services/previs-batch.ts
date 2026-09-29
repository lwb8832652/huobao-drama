import { and, eq, gt, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfigId, getConfigById } from './ai.js'
import { getImageAdapter, getVideoAdapter } from './adapters/registry.js'
import { generateImage, generateVideo, recoverPrevisTasks, startQueuedPrevisTask } from './generation.js'
import { now } from '../utils/response.js'
import { getDramaStylePrompt } from './style-preset.js'
import {
  frameKey, normalizeTimeline, orderedFrames, groupPanels, panelImageFallback,
  type FrameType, type Timeline, type Panel, type VideoGenerationMode,
} from './previs-domain.js'
import { getVersion, hashContent, frameFingerprint, videoFingerprint, isCurrentVersion,
  PrevisError, readBatches, requireEditable, versionRow, episodeForPrevis } from './previs.js'

/** Reflect the actual adapters: Seedance's current adapter supports reference images only. */
export const videoCapabilities = {
  aliyun: { modes: ['direct', 'storyboard_frames'], constraints: ['reference'], minSeconds: 2, maxSeconds: 30, maxImages: 10, group: true },
  minimax: { modes: ['direct', 'storyboard_frames'], constraints: ['reference'], minSeconds: 4, maxSeconds: 15, maxImages: 9, group: true },
  volcengine: { modes: ['direct', 'storyboard_frames'], constraints: ['reference'], minSeconds: 4, maxSeconds: 15, maxImages: 9, group: true },
  nuwax: { modes: ['direct', 'storyboard_frames'], constraints: ['reference'], minSeconds: 1, maxSeconds: 30, maxImages: 9, group: false },
} as const

interface BatchOptions {
  revision: number
  type: 'image' | 'video'
  configId?: number
  model?: string
  panelIds?: number[]
  frameTypes?: FrameType[]
  frameIds?: string[]
  force?: boolean
  generationMode?: VideoGenerationMode
}
export function videoInputs(
  t: Timeline,
  panels: Panel[],
  provider: string,
  generationMode: VideoGenerationMode = 'direct',
) {
  const cap = videoCapabilities[provider as keyof typeof videoCapabilities]
  if (!cap) throw new PrevisError('当前视频服务尚未声明预演生成能力')
  if (t.strategy.mode === 'group' && !cap.group) throw new PrevisError('当前服务不支持按组生成，请改用按分镜生成')
  const seconds = panels.reduce((s, p) => s + p.durationMs, 0) / 1000
  if (!Number.isInteger(seconds) || seconds < cap.minSeconds || seconds > cap.maxSeconds) {
    throw new PrevisError(`「${panels[0].title}」时长 ${seconds} 秒；当前模型要求 ${cap.minSeconds}–${cap.maxSeconds} 的整数秒，请调整时长`)
  }
  const allFrames = panels.flatMap(p => orderedFrames(p))
  if (generationMode === 'storyboard_frames' && !allFrames.length) {
    throw new PrevisError(`「${panels[0].title}」尚无分镜画面，请先添加并生成画面`)
  }
  const missing = generationMode === 'storyboard_frames' ? allFrames.filter(frame => !frame.url) : []
  if (missing.length) {
    throw new PrevisError(`「${panels[0].title}」还有 ${missing.length} 张分镜画面未完成，请全部生成或上传后再生成视频`)
  }
  const availableReferences = [...new Set(generationMode === 'storyboard_frames'
    ? allFrames.map(frame => frame.url)
    : panels.flatMap(panel => panel.referenceImages).filter(Boolean))]
  if (generationMode === 'storyboard_frames' && availableReferences.length > cap.maxImages) {
    throw new PrevisError(`「${panels[0].title}」共有 ${availableReferences.length} 张分镜画面，当前模型最多接收 ${cap.maxImages} 张，请减少输入图片`)
  }
  // Keep the legacy direct-generation behavior: bound assets beyond the provider limit are ignored.
  const references = availableReferences.slice(0, cap.maxImages)
  if (generationMode === 'storyboard_frames' && !(cap.constraints as readonly string[]).includes('reference')) {
    throw new PrevisError('当前视频模型不支持分镜画面参考模式，请更换模型')
  }
  return {
    generationMode, actualStrategy: generationMode === 'direct' ? 'direct' : 'reference', duration: seconds,
    firstFrameUrl: undefined, lastFrameUrl: undefined, referenceImageUrls: references,
  }
}
export async function createBatch(versionId: number, options: BatchOptions) {
  const row = versionRow(versionId)
  const ep = episodeForPrevis(row.episodeId)
  const raw = JSON.parse(row.timelineJson)
  const t = normalizeTimeline(raw)
  if (row.revision !== options.revision) throw new PrevisError('版本已更新，请刷新后生成', 409)
  if (row.status === 'locked' && row.contentHash !== hashContent(raw)) throw new PrevisError('锁定版本内容校验失败', 409)
  if (options.type === 'image') requireEditable(versionId, options.revision)
  const configId = options.configId || (options.type === 'image' ? ep.imageConfigId : ep.videoConfigId) || await getActiveConfigId(options.type)
  const configRow = configId ? db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId)).get() : null
  if (!configRow?.isActive || configRow.serviceType !== options.type) throw new PrevisError(`请先在设置中启用${options.type === 'image' ? '图片' : '视频'}模型`)
  const config = await getConfigById(configRow.id)
  if (!config) throw new PrevisError('生成模型配置不可用')
  const model = options.model || config.model
  const generationMode = options.generationMode || 'direct'
  const allowedModels: string[] = JSON.parse(configRow.model || '[]')
  if (!allowedModels.includes(model)) throw new PrevisError('所选模型不属于当前服务配置')
  const drama = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).get()
  const style = await getDramaStylePrompt(ep.dramaId)
  const items: { groupId: string; panelId: number | null; frameType: FrameType | null; requestJson: string }[] = []
  if (options.panelIds?.some(id => !t.panels.some(p => p.id === id))) throw new PrevisError('选择的分镜不属于当前版本')
  for (const group of t.groups) {
    const allPanels = groupPanels(t, group)
    const selected = allPanels.filter(p => !options.panelIds?.length || options.panelIds.includes(p.id))
    // A group job always represents the complete group, including its timing and endpoints.
    const panels = options.type === 'video' && t.strategy.mode === 'group' && selected.length ? allPanels : selected
    if (options.type === 'image') {
      getImageAdapter(config.provider)
      for (const panel of panels) {
        for (const frame of panel.frames) {
          const type = frame.type
          if (options.frameTypes?.length && !options.frameTypes.includes(type)) continue
          if (options.frameIds?.length && !options.frameIds.includes(frameKey(frame))) continue
          if (frame.url && !options.force) continue
          const referenceImages = frame.referenceImages ?? panel.referenceImages
          if (!referenceImages.length) {
            throw new PrevisError(`「${panel.title} / ${frame.title || '分镜画面'}」尚未选择资产参考素材，请先绑定角色、场景或道具图片`)
          }
          const referenceLegend = referenceImages.map((url, index) => {
            const panelIndex = panel.referenceImages.indexOf(url)
            return `@图片${index + 1}：${panel.referenceLabels?.[panelIndex] || '参考素材'}`
          })
          const prompt = [
            style, ...referenceLegend, frame.prompt || panelImageFallback(panel),
            `场景：${panel.scene}。景别：${frame.shotType || panel.shotType}。机位：${frame.angle || panel.angle}。运镜：${panel.movement}。构图：${frame.composition || '遵循画面描述'}。`,
            `画面：${frame.title || '分镜画面'}，位于本段 ${(frame.offsetMs || 0) / 1000} 秒。`,
            '只绘制一张完整的电影分镜画面，不要拼图、文字、水印。保持参考素材的人物身份、服装、道具与场景一致。',
          ].filter(Boolean).join('\n')
          items.push({
            groupId: group.id, panelId: panel.id, frameType: type,
            requestJson: JSON.stringify({
              storyboardId: panel.id, dramaId: ep.dramaId, prompt, model, configId,
              frameId: frameKey(frame), inputHash: frameFingerprint(frame, panel),
              frameType: type === 'start' ? 'first_frame' : type === 'end' ? 'last_frame' : 'middle',
              size: drama?.aspectRatio === '9:16' ? '1080x1920' : '1920x1080',
              referenceImages,
            }),
          })
        }
      }
    } else {
      for (const unit of t.strategy.mode === 'group' ? (panels.length ? [panels] : []) : panels.map(p => [p])) {
        const inputs = videoInputs(t, unit, config.provider, generationMode)
        const referenceLegend = generationMode === 'storyboard_frames'
          ? unit.flatMap(p => orderedFrames(p).map((frame, i) => {
            const index = inputs.referenceImageUrls.indexOf(frame.url)
            return index < 0 ? '' : `@图片${index + 1}：${p.title} / ${frame.title || `画面 ${i + 1}`}`
          })).filter(Boolean)
          : unit.flatMap(p => p.referenceImages.map((url, i) => {
            const index = inputs.referenceImageUrls.indexOf(url)
            return index < 0 ? '' : `@图片${index + 1}：${p.referenceLabels?.[i] || '绑定素材'}`
          })).filter(Boolean)
        const prompt = [style, ...new Set(referenceLegend), ...unit.map(p => {
          let text = (p.videoPrompt || [p.description, p.atmosphere].filter(Boolean).join('\n')).replace(/@图片(\d+)/g, (_, n) => {
            const index = inputs.referenceImageUrls.indexOf(p.referenceImages[Number(n) - 1])
            return index < 0 ? (p.referenceLabels?.[Number(n) - 1] || '') : `@图片${index + 1}`
          })
          if (generationMode === 'direct') {
            const labels = p.referenceImages.map((url, index) => ({
              label: p.referenceLabels?.[index] || '',
              inputIndex: inputs.referenceImageUrls.indexOf(url),
            })).filter(item => item.label && item.inputIndex >= 0).sort((a, b) => b.label.length - a.label.length)
            text = text.replace(/@([^\s@]+)/g, (whole, raw) => {
              const match = labels.find(item => raw.startsWith(item.label))
              return match ? `@图片${match.inputIndex + 1}${raw}` : whole
            })
          }
          return `[${p.durationMs / 1000}秒] ${text}`
        })].filter(Boolean).join('\n')
        const request = { ...inputs, storyboardId: t.strategy.mode === 'storyboard' ? unit[0].id : undefined,
          panelIds: unit.map(p => p.id), inputHash: videoFingerprint(t, unit, generationMode),
          dramaId: ep.dramaId, prompt, model, configId, aspectRatio: drama?.aspectRatio || '16:9', resolution: ep.resolution || '720p' }
        // Validate the contract before persisting any jobs or making a paid call.
        // Static images are converted to data URLs by generation.ts; use web URLs for contract validation only.
        const validationUrl = (url?: string) => url && /^\/?static\//.test(url) ? `https://local.invalid/${url}` : url
        getVideoAdapter(config.provider).buildGenerateRequest(config, {
          ...request, id: 0, firstFrameUrl: validationUrl(request.firstFrameUrl), lastFrameUrl: validationUrl(request.lastFrameUrl),
          referenceImageUrls: JSON.stringify(request.referenceImageUrls.map(validationUrl)),
        })
        items.push({ groupId: group.id, panelId: request.storyboardId || null, frameType: null, requestJson: JSON.stringify(request) })
      }
    }
  }
  if (!items.length) throw new PrevisError(options.type === 'video'
    ? '没有可生成的视频镜头'
    : '没有需要生成的画面；请先添加画面，已有图片会自动跳过')
  const baseHash = hashContent({ type: options.type, configId, model, items })
  const prior = db.select().from(schema.batchRuns)
    .where(and(eq(schema.batchRuns.versionId, versionId), eq(schema.batchRuns.requestHash, baseHash))).get()
  // Rapid duplicate clicks share an active batch. Once it finishes, the same inputs may be regenerated.
  const requestHash = prior && !['pending', 'processing'].includes(prior.status)
    ? hashContent({ baseHash, afterBatch: prior.id, requestedAt: now() })
    : baseHash
  db.transaction(tx => {
    // Config lookup above is asynchronous; recheck revision and locks inside the write transaction.
    if (options.type === 'image') requireEditable(versionId, options.revision)
    else if (versionRow(versionId).revision !== options.revision) throw new PrevisError('版本已更新，请刷新后生成', 409)
    if (tx.select().from(schema.batchRuns).where(and(eq(schema.batchRuns.versionId, versionId), eq(schema.batchRuns.requestHash, requestHash))).get()) return
    const batchId = Number(tx.insert(schema.batchRuns).values({
      versionId, type: options.type, requestHash, configId: configRow.id, model, createdAt: now(),
    }).run().lastInsertRowid)
    for (const item of items) tx.insert(schema.batchRunItems).values({ ...item, batchId }).run()
  })
  void tickPrevisBatches().catch(e => console.error('Previs worker:', e.message))
  return getVersion(versionId)
}

/** Completion binding is guarded by the version and batch item, so later drafts cannot be overwritten. */
function reconcile() {
  const activeBatches = db.select().from(schema.batchRuns)
    .where(inArray(schema.batchRuns.status, ['pending', 'processing'])).all()
  const processingItems = db.select().from(schema.batchRunItems)
    .where(eq(schema.batchRunItems.status, 'processing')).all()
  const knownBatchIds = new Set(activeBatches.map(batch => batch.id))
  const missingBatchIds = [...new Set(processingItems
    .map(item => item.batchId)
    .filter(batchId => !knownBatchIds.has(batchId)))]
  const batches = missingBatchIds.length
    ? [...activeBatches, ...db.select().from(schema.batchRuns).where(inArray(schema.batchRuns.id, missingBatchIds)).all()]
    : activeBatches
  if (!batches.length) return
  const batchById = new Map(batches.map(batch => [batch.id, batch]))
  const items = db.select().from(schema.batchRunItems)
    .where(inArray(schema.batchRunItems.batchId, batches.map(batch => batch.id))).all()
  const itemsByBatch = new Map<number, typeof items>()
  for (const item of items) {
    const group = itemsByBatch.get(item.batchId) || []
    group.push(item)
    itemsByBatch.set(item.batchId, group)
  }
  const taskIds = [...new Set(processingItems.flatMap(item => item.taskId ? [item.taskId] : []))]
  const tasks = taskIds.length
    ? db.select().from(schema.sysTask).where(inArray(schema.sysTask.id, taskIds)).all()
    : []
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const completedFloor = new Map<string, number>()
  for (const item of processingItems) {
    const batch = batchById.get(item.batchId)
    if (!batch || taskById.get(item.taskId || 0)?.status !== 'completed') continue
    const key = `${batch.versionId}:${batch.type}`
    completedFloor.set(key, Math.min(completedFloor.get(key) ?? item.id, item.id))
  }
  type SiblingItem = Pick<typeof schema.batchRunItems.$inferSelect, 'id' | 'panelId' | 'frameType' | 'requestJson'>
  const siblingCache = new Map<string, SiblingItem[]>()
  const siblingsFor = (batch: typeof schema.batchRuns.$inferSelect) => {
    const key = `${batch.versionId}:${batch.type}`
    const cached = siblingCache.get(key)
    if (cached) return cached
    const siblings = db.select({
      id: schema.batchRunItems.id,
      panelId: schema.batchRunItems.panelId,
      frameType: schema.batchRunItems.frameType,
      requestJson: schema.batchRunItems.requestJson,
    }).from(schema.batchRunItems).innerJoin(
      schema.batchRuns,
      eq(schema.batchRunItems.batchId, schema.batchRuns.id),
    ).where(and(
      eq(schema.batchRuns.versionId, batch.versionId),
      eq(schema.batchRuns.type, batch.type),
      gt(schema.batchRunItems.id, completedFloor.get(key) || 0),
    )).all()
    siblingCache.set(key, siblings)
    return siblings
  }
  for (const batch of batches) {
    const batchItems = itemsByBatch.get(batch.id) || []
    for (const item of batchItems.filter(i => i.status === 'processing')) {
      const task = item.taskId ? taskById.get(item.taskId) : null
      if (!task || !['completed', 'failed'].includes(task.status || '')) continue
      const siblings = task.status === 'completed' ? siblingsFor(batch) : []
      db.transaction(tx => {
        if (task.status === 'completed') {
          const row = tx.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, batch.versionId)).get()
          if (row) {
            const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
            const request = JSON.parse(item.requestJson)
            const panel = timeline.panels.find(p => p.id === item.panelId)
            const url = task.localPath || task.resultUrl || ''
            let changed = false
            if (batch.type === 'image' && panel && row.status !== 'locked') {
              const frame = panel.frames.find(f => request.frameId ? frameKey(f) === request.frameId : f.type === item.frameType)
              const newer = siblings.some(i => i.id > item.id && i.panelId === item.panelId
                && (JSON.parse(i.requestJson).frameId || i.frameType) === (request.frameId || item.frameType))
              if (frame && url) {
                frame.history = [
                  ...(frame.history || []),
                  ...(frame.url ? [{ url: frame.url, taskId: frame.taskId }] : []),
                  { url, taskId: task.id },
                ].filter((entry, index, all) =>
                  entry.url && all.findIndex(candidate => candidate.url === entry.url) === index,
                ).slice(-200)
                if (!newer && (!request.inputHash || request.inputHash === frameFingerprint(frame, panel))) {
                  frame.url = url; frame.taskId = task.id
                  panel.coverFrameId ||= frameKey(frame)
                }
                changed = true
              }
            } else if (batch.type === 'video' && panel && url) {
              const newer = siblings.some(i => {
                const r = JSON.parse(i.requestJson)
                return i.id > item.id && (r.panelIds || (i.panelId ? [i.panelId] : [])).includes(panel.id)
              })
              if (!newer && (!request.inputHash || request.inputHash === videoFingerprint(
                timeline, [panel], request.generationMode || 'storyboard_frames',
              ))) {
                if (row.status !== 'locked') { panel.videoUrl = url; changed = true }
                if (isCurrentVersion(row.id)) tx.update(schema.storyboards).set({ videoUrl: url, updatedAt: now() })
                  .where(eq(schema.storyboards.id, panel.id)).run()
              }
            }
            if (changed) {
              tx.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(timeline), revision: row.revision + 1, status: 'draft', contentHash: null, updatedAt: now() })
                .where(eq(schema.animaticVersions.id, row.id)).run()
              if (batch.type === 'image' && panel && isCurrentVersion(row.id)) {
                const cover = panel.frames.find(f => frameKey(f) === panel.coverFrameId && f.url) || panel.frames.find(f => f.url)
                tx.update(schema.storyboards).set({
                  composedImage: cover?.url || null,
                  firstFrameImage: panel.frames.find(f => f.type === 'start')?.url || null,
                  lastFrameImage: panel.frames.find(f => f.type === 'end')?.url || null,
                  updatedAt: now(),
                }).where(eq(schema.storyboards.id, panel.id)).run()
              }
            }
          }
        }
        tx.update(schema.batchRunItems).set({ status: task.status!, error: task.errorMsg }).where(eq(schema.batchRunItems.id, item.id)).run()
      })
      item.status = task.status!
      item.error = task.errorMsg
    }
    const states = batchItems.map(item => item.status)
    const status = batch.status === 'cancelled' ? 'cancelled'
      : states.some(s => s === 'pending' || s === 'processing') ? 'processing'
      : states.some(s => s === 'failed') ? 'partial_failed' : 'completed'
    if (status !== batch.status) db.update(schema.batchRuns).set({ status }).where(eq(schema.batchRuns.id, batch.id)).run()
  }
}
let ticking = false
export async function tickPrevisBatches() {
  if (ticking) return
  ticking = true
  try {
    reconcile()
    const batches = db.select().from(schema.batchRuns)
      .where(inArray(schema.batchRuns.status, ['pending', 'processing'])).all()
    const processingItems = db.select().from(schema.batchRunItems)
      .where(eq(schema.batchRunItems.status, 'processing')).all()
    const processingBatchIds = [...new Set(processingItems.map(item => item.batchId))]
    const processingBatches = processingBatchIds.length
      ? db.select().from(schema.batchRuns).where(inArray(schema.batchRuns.id, processingBatchIds)).all()
      : []
    const processingBatchById = new Map(processingBatches.map(batch => [batch.id, batch]))
    const activeByConfig = new Map<number, number>()
    // Cancelled batches may still have already-submitted work occupying a slot.
    for (const item of processingItems) {
      const batch = processingBatchById.get(item.batchId)
      if (batch) activeByConfig.set(batch.configId, (activeByConfig.get(batch.configId) || 0) + 1)
    }
    const batchIds = batches.map(batch => batch.id)
    const pendingItems = batchIds.length
      ? db.select().from(schema.batchRunItems).where(and(
        inArray(schema.batchRunItems.batchId, batchIds),
        eq(schema.batchRunItems.status, 'pending'),
      )).all()
      : []
    const pendingByBatch = new Map<number, typeof pendingItems>()
    for (const item of pendingItems) {
      const group = pendingByBatch.get(item.batchId) || []
      group.push(item)
      pendingByBatch.set(item.batchId, group)
    }
    const itemKeys = pendingItems.map(item => `${item.id}:${item.attempt}`)
    const existingTasks = itemKeys.length
      ? db.select().from(schema.sysTask).where(inArray(schema.sysTask.previsItemKey, itemKeys)).all()
      : []
    const existingTaskByKey = new Map(existingTasks.map(task => [task.previsItemKey, task]))
    for (const batch of batches) {
      for (const item of pendingByBatch.get(batch.id) || []) {
        if ((activeByConfig.get(batch.configId) || 0) >= 2) continue
        if (db.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, batch.id)).get()?.status === 'cancelled') break
        if (db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, item.id)).get()?.status !== 'pending') continue
        try {
          const itemKey = `${item.id}:${item.attempt}`
          const existing = existingTaskByKey.get(itemKey)
          const request = { ...JSON.parse(item.requestJson), previs: { versionId: batch.versionId, itemKey } }
          const taskId = existing?.id || await (batch.type === 'image' ? generateImage(request) : generateVideo(request))
          const latestItem = db.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.id, item.id)).get()
          const latestBatch = db.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, batch.id)).get()
          if (latestItem?.status !== 'pending' || latestBatch?.status === 'cancelled') {
            db.update(schema.sysTask).set({ status: 'cancelled' })
              .where(and(eq(schema.sysTask.id, taskId), eq(schema.sysTask.status, 'pending'))).run()
            continue
          }
          db.update(schema.batchRunItems).set({ taskId, status: 'processing' }).where(eq(schema.batchRunItems.id, item.id)).run()
          activeByConfig.set(batch.configId, (activeByConfig.get(batch.configId) || 0) + 1)
          await startQueuedPrevisTask(taskId)
        } catch (e: any) {
          db.update(schema.batchRunItems).set({ status: 'failed', error: e.message }).where(eq(schema.batchRunItems.id, item.id)).run()
        }
      }
    }
    reconcile()
  } finally { ticking = false }
}
export function updateBatch(batchId: number, action: 'retry' | 'cancel', itemIds?: number[]) {
  const batch = db.select().from(schema.batchRuns).where(eq(schema.batchRuns.id, batchId)).get()
  if (!batch) throw new PrevisError('批次不存在', 404)
  const row = versionRow(batch.versionId)
  if (action === 'retry' && batch.type === 'image') requireEditable(row.id, row.revision)
  db.transaction(tx => {
    const items = tx.select().from(schema.batchRunItems).where(eq(schema.batchRunItems.batchId, batchId)).all()
    for (const item of items) {
      if (itemIds?.length && !itemIds.includes(item.id)) continue
      if (action === 'retry' && item.status === 'failed') tx.update(schema.batchRunItems)
        .set({ status: 'pending', error: null, taskId: null, attempt: item.attempt + 1 }).where(eq(schema.batchRunItems.id, item.id)).run()
      if (action === 'cancel' && item.status === 'pending') tx.update(schema.batchRunItems)
        .set({ status: 'cancelled' }).where(eq(schema.batchRunItems.id, item.id)).run()
    }
    tx.update(schema.batchRuns).set({ status: action === 'cancel' ? 'cancelled' : 'pending' }).where(eq(schema.batchRuns.id, batchId)).run()
  })
  return readBatches(batch.versionId).find(b => b.id === batchId)
}
export async function startPrevisWorker() {
  await recoverPrevisTasks()
  // A crash can leave a linked but not yet started task. Resume these without creating a new task.
  for (const item of db.select().from(schema.batchRunItems)
    .where(eq(schema.batchRunItems.status, 'processing')).all().filter(item => item.taskId)) {
    await startQueuedPrevisTask(item.taskId!)
  }
  await tickPrevisBatches()
  const timer = setInterval(() => { void tickPrevisBatches().catch(e => console.error('Previs worker:', e.message)) }, 1500)
  timer.unref()
  return () => clearInterval(timer)
}
