import { createHash } from 'node:crypto'
import { z } from 'zod'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import {
  autoGroup, checkContinuity, defaultStrategy, rebuildTransitions, normalizeTimeline, frameKey, retimeBoundAudio,
  timelineSegments, panelImageFallback, type Timeline, type Panel, type AnimaticVersion, type BatchRun,
  type Keyframe, type VideoOutput, type VideoGenerationMode,
} from './previs-domain.js'

export class PrevisError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 = 400) { super(message) }
}
const text = z.string().max(30_000)
const id = z.number().int().positive()
const ms = z.number().int().min(0).max(86_400_000)
const url = z.string().max(4000).refine(v => !v || /^(\/?static\/[^?#]+|https?:\/\/)/.test(v), '媒体地址必须为 static 路径或 HTTP(S) URL')
const state = z.record(z.string().max(80), z.string().max(2000))
const constraint = z.enum(['auto', 'first_last', 'first', 'reference', 'text'])
export const timelineSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  groups: z.array(z.object({
    id: z.string().min(1).max(100), title: text, note: text, panelIds: z.array(id).max(1000),
    entry: state, exit: state,
  })).max(1000),
  panels: z.array(z.object({
    id, title: text, description: text, atmosphere: text.optional(), imagePrompt: text, videoPrompt: text, durationMs: ms.min(100),
    sceneId: id.nullable(), scene: text, shotType: text, angle: text, movement: text,
    characterIds: z.array(id), propIds: z.array(id), referenceImages: z.array(url).max(30), videoUrl: url,
    referenceLabels: z.array(text).max(30).optional(), sourceFingerprint: z.string().optional(),
    generation: z.object({ constraint, includeAssets: z.boolean() }).optional(),
    coverFrameId: z.string().max(100).optional(),
    frames: z.array(z.object({
      id: z.string().min(1).max(100).optional(), title: z.string().max(200).optional(), offsetMs: ms.optional(),
      useForVideo: z.boolean().optional(), history: z.array(z.object({ url, taskId: id.optional() })).max(200).optional(),
      referenceImages: z.array(url).max(30).optional(),
      shotType: z.string().max(200).optional(), angle: z.string().max(200).optional(), composition: z.string().max(1000).optional(),
      type: z.enum(['start', 'middle', 'end', 'beat']), url, prompt: text, locked: z.boolean(), taskId: id.optional(),
    })).max(100),
  })).max(1000),
  transitions: z.array(z.object({
    from: z.string(), to: z.string(),
    type: z.enum(['cut', 'match_cut', 'occlusion', 'insert', 'establishing', 'audio_bridge']),
    continuity: z.enum(['strong', 'normal', 'scene_change']), allowedChanges: z.array(z.string()).max(50),
  })).max(1000),
  audio: z.array(z.object({
    id: z.string().min(1).max(100), type: z.enum(['dialogue', 'narration', 'sound']), panelId: id.nullable(),
    character: text, text, url, startMs: ms, durationMs: ms.min(100),
  })).max(2000),
  strategy: z.object({
    mode: z.enum(['storyboard', 'group']), constraint,
    fallback: z.enum(['first', 'reference', 'text']), minDurationMs: ms.min(1000), maxDurationMs: ms.min(1000),
  }),
  acknowledgements: z.record(z.string().max(20_000), z.string().trim().min(1).max(2000)),
  inheritedOutputs: z.array(z.object({
    key: z.string(), panelIds: z.array(id), url, taskId: id.optional(),
    generationMode: z.enum(['direct', 'storyboard_frames']).optional(), stale: z.boolean(),
  })).optional(),
})

export function hashContent(value: unknown) {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
export function validateTimeline(input: unknown, original?: Timeline): Timeline {
  const result = timelineSchema.safeParse(input)
  if (!result.success) throw new PrevisError(`时间线数据无效：${result.error.issues[0]?.message}`)
  const t = normalizeTimeline(result.data as Timeline)
  if (original) original = normalizeTimeline(original)
  const panelIds = t.panels.map(p => p.id)
  const grouped = t.groups.flatMap(g => g.panelIds)
  if (new Set(panelIds).size !== panelIds.length || new Set(t.groups.map(g => g.id)).size !== t.groups.length
    || grouped.length !== panelIds.length || new Set(grouped).size !== grouped.length
    || grouped.some(p => !panelIds.includes(p))) throw new PrevisError('每个分镜必须且只能属于一个镜头组')
  if (original && (panelIds.length !== original.panels.length || panelIds.some(p => !original.panels.some(o => o.id === p)))) {
    throw new PrevisError('分镜集合已变化，请通过同步分镜创建新草稿')
  }
  if (t.strategy.minDurationMs > t.strategy.maxDurationMs) throw new PrevisError('最短组时长不能超过最长组时长')
  if (new Set(t.audio.map(a => a.id)).size !== t.audio.length) throw new PrevisError('音频片段 ID 重复')
  for (const p of t.panels) {
    if (new Set(p.frames.map(frameKey)).size !== p.frames.length) throw new PrevisError('同一分镜的画面 ID 不能重复')
    if (p.frames.some(f => (f.offsetMs || 0) >= p.durationMs)) throw new PrevisError('画面时间点必须在分镜时长以内')
    if (p.frames.some(f => f.referenceImages?.some(url => !p.referenceImages.includes(url)))) {
      throw new PrevisError('画面引用的素材已从当前分镜解绑，请重新选择参考素材')
    }
    if (p.coverFrameId && !p.frames.some(f => frameKey(f) === p.coverFrameId)) p.coverFrameId = p.frames[0]?.id
  }
  for (const clip of t.audio) if (clip.panelId && !panelIds.includes(clip.panelId)) throw new PrevisError('音频引用的分镜不属于当前版本')
  if (t.transitions.length !== Math.max(0, t.groups.length - 1)
    || t.transitions.some((edge, i) => edge.from !== t.groups[i].id || edge.to !== t.groups[i + 1].id)) {
    throw new PrevisError('组间连接必须与当前组顺序一致')
  }
  return t as Timeline
}
export function frameFingerprint(frame: Keyframe, panel?: Panel) {
  return hashContent({
    id: frameKey(frame), prompt: frame.prompt || (panel ? panelImageFallback(panel) : ''), url: frame.url,
    referenceImages: frame.referenceImages ?? panel?.referenceImages,
    shotType: frame.shotType || panel?.shotType, angle: frame.angle || panel?.angle,
    movement: panel?.movement, composition: frame.composition,
  })
}
export function videoFingerprint(t: Timeline, panels: Panel[], generationMode: VideoGenerationMode = 'storyboard_frames') {
  return hashContent({
    mode: t.strategy.mode,
    generationMode,
    panels: panels.map(p => ({
      id: p.id, description: p.description, atmosphere: p.atmosphere, prompt: p.videoPrompt, durationMs: p.durationMs,
      references: generationMode === 'direct' ? p.referenceImages : undefined,
      referenceLabels: generationMode === 'direct' ? p.referenceLabels : undefined,
      frames: generationMode === 'storyboard_frames'
        ? p.frames.map(f => ({ id: frameKey(f), url: f.url, offsetMs: f.offsetMs, type: f.type }))
        : undefined,
    })),
  })
}
function sourceMetadata(p: Panel) {
  return {
    title: p.title, description: p.description, atmosphere: p.atmosphere,
    imagePrompt: p.imagePrompt, videoPrompt: p.videoPrompt,
    durationMs: p.durationMs, sceneId: p.sceneId, scene: p.scene, shotType: p.shotType, angle: p.angle,
    movement: p.movement, characterIds: p.characterIds, propIds: p.propIds,
    referenceImages: p.referenceImages, referenceLabels: p.referenceLabels,
  }
}
export function isCurrentVersion(versionId: number) {
  const row = versionRow(versionId)
  return listVersions(row.episodeId)[0]?.id === versionId
}
/** Mirror the current working version for legacy consumers (agents, asset selectors and exports). */
export function mirrorCurrent(versionId: number, timeline: Timeline) {
  if (!isCurrentVersion(versionId)) return
  for (const p of timeline.panels) {
    const cover = p.frames.find(f => frameKey(f) === p.coverFrameId && f.url) || p.frames.find(f => f.url)
    const values: Record<string, unknown> = {
      title: p.title, description: p.description, atmosphere: p.atmosphere,
      imagePrompt: p.imagePrompt, videoPrompt: p.videoPrompt,
      duration: p.durationMs / 1000, sceneId: p.sceneId, shotType: p.shotType, angle: p.angle, movement: p.movement,
      composedImage: cover?.url || null, firstFrameImage: p.frames.find(f => f.type === 'start')?.url || null,
      lastFrameImage: p.frames.find(f => f.type === 'end')?.url || null, updatedAt: now(),
    }
    // A draft without a selected video must not erase the legacy/current export fallback.
    if (p.videoUrl) values.videoUrl = p.videoUrl
    db.update(schema.storyboards).set(values).where(eq(schema.storyboards.id, p.id)).run()
    db.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, p.id)).run()
    for (const characterId of new Set(p.characterIds)) db.insert(schema.storyboardCharacters).values({ storyboardId: p.id, characterId }).run()
    db.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, p.id)).run()
    for (const propId of new Set(p.propIds)) db.insert(schema.storyboardProps).values({ storyboardId: p.id, propId }).run()
  }
}

export function episodeForPrevis(episodeId: number) {
  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!ep || ep.deletedAt) throw new PrevisError('剧集不存在', 404)
  return ep
}
export function versionRow(versionId: number) {
  const row = db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, versionId)).get()
  if (!row) throw new PrevisError('故事版版本不存在', 404)
  episodeForPrevis(row.episodeId)
  return row
}
export function listVersions(episodeId: number) {
  episodeForPrevis(episodeId)
  return db.select({
    id: schema.animaticVersions.id, versionNo: schema.animaticVersions.versionNo,
    status: schema.animaticVersions.status, revision: schema.animaticVersions.revision,
    lockedAt: schema.animaticVersions.lockedAt, updatedAt: schema.animaticVersions.updatedAt,
  }).from(schema.animaticVersions).where(eq(schema.animaticVersions.episodeId, episodeId))
    .orderBy(desc(schema.animaticVersions.versionNo)).all()
}
function initialTimeline(episodeId: number): Timeline {
  const rows = db.select().from(schema.storyboards).where(and(
    eq(schema.storyboards.episodeId, episodeId),
    isNull(schema.storyboards.deletedAt),
  )).orderBy(schema.storyboards.storyboardNumber).all()
  const storyboardIds = rows.map(row => row.id)
  const characterLinks = storyboardIds.length
    ? db.select().from(schema.storyboardCharacters)
      .where(inArray(schema.storyboardCharacters.storyboardId, storyboardIds)).all()
    : []
  const propLinks = storyboardIds.length
    ? db.select().from(schema.storyboardProps)
      .where(inArray(schema.storyboardProps.storyboardId, storyboardIds)).all()
    : []
  const sceneIds = [...new Set(rows.flatMap(row => row.sceneId ? [row.sceneId] : []))]
  const characterIds = [...new Set(characterLinks.map(link => link.characterId))]
  const propIds = [...new Set(propLinks.map(link => link.propId))]
  const scenes = sceneIds.length
    ? db.select().from(schema.scenes).where(and(inArray(schema.scenes.id, sceneIds), isNull(schema.scenes.deletedAt))).all()
    : []
  const characters = characterIds.length
    ? db.select().from(schema.characters).where(and(inArray(schema.characters.id, characterIds), isNull(schema.characters.deletedAt))).all()
    : []
  const props = propIds.length
    ? db.select().from(schema.props).where(and(inArray(schema.props.id, propIds), isNull(schema.props.deletedAt))).all()
    : []
  const sceneById = new Map(scenes.map(scene => [scene.id, scene]))
  const characterById = new Map(characters.map(character => [character.id, character]))
  const propById = new Map(props.map(prop => [prop.id, prop]))
  const charactersByStoryboard = new Map<number, typeof characterLinks>()
  const propsByStoryboard = new Map<number, typeof propLinks>()
  for (const link of characterLinks) {
    const links = charactersByStoryboard.get(link.storyboardId) || []
    links.push(link)
    charactersByStoryboard.set(link.storyboardId, links)
  }
  for (const link of propLinks) {
    const links = propsByStoryboard.get(link.storyboardId) || []
    links.push(link)
    propsByStoryboard.set(link.storyboardId, links)
  }
  const panels: Panel[] = rows.map(s => {
    const chars = charactersByStoryboard.get(s.id) || []
    const panelProps = propsByStoryboard.get(s.id) || []
    const scene = s.sceneId ? sceneById.get(s.sceneId) : null
    const references = [
      { url: scene?.imageUrl, label: scene?.location || '场景' },
      ...chars.map(link => {
        const character = characterById.get(link.characterId)
        return { url: character?.imageUrl, label: character?.name || '角色' }
      }),
      ...panelProps.map(link => {
        const prop = propById.get(link.propId)
        return { url: prop?.imageUrl, label: prop?.name || '道具' }
      }),
    ].filter(r => !!r.url)
    const panel: Panel = {
      id: s.id, title: s.title || `镜头 ${s.storyboardNumber}`, description: s.description || '',
      atmosphere: s.atmosphere || '', imagePrompt: s.imagePrompt || '', videoPrompt: s.videoPrompt || '',
      durationMs: Math.max(100, Math.round((s.duration || 5) * 1000)),
      sceneId: s.sceneId, scene: [scene?.location || s.location, scene?.time || s.time].filter(Boolean).join(' / '),
      shotType: s.shotType || '', angle: s.angle || '', movement: s.movement || '',
      characterIds: chars.map(c => c.characterId), propIds: panelProps.map(p => p.propId),
      referenceImages: references.map(r => r.url!), referenceLabels: references.map(r => r.label),
      videoUrl: s.videoUrl || '',
      frames: [
        { type: 'start', url: s.firstFrameImage || '', prompt: '', locked: false },
        { type: 'middle', url: s.composedImage || '', prompt: '', locked: false },
        { type: 'end', url: s.lastFrameImage || '', prompt: '', locked: false },
      ],
    }
    panel.sourceFingerprint = hashContent(sourceMetadata(panel))
    return panel
  })
  const t: Timeline = { schemaVersion: 1, groups: autoGroup(panels), panels, transitions: [], audio: [], strategy: { ...defaultStrategy }, acknowledgements: {} }
  rebuildTransitions(t)
  // Parse explicit script labels only; do not fabricate dialogue from a visual description.
  for (const seg of timelineSegments(t)) {
    const lines = seg.panel.description.split('\n')
    lines.forEach((line, i) => {
      const match = line.match(/(?:^|\s|【)(旁白|对白|台词|内心独白)[】\s]*[：:]\s*(.+)/)
      if (match) t.audio.push({
        id: `script-${seg.panel.id}-${i}`, panelId: seg.panel.id, type: match[1] === '旁白' ? 'narration' : 'dialogue',
        character: '', text: match[2], url: '', startMs: seg.startMs,
        durationMs: Math.max(1000, Math.ceil(match[2].length / 4) * 1000),
      })
    })
  }
  return normalizeTimeline(t)
}
export function createVersion(episodeId: number, sourceId?: number): AnimaticVersion {
  episodeForPrevis(episodeId)
  const source = sourceId ? versionRow(sourceId) : null
  if (source && source.episodeId !== episodeId) throw new PrevisError('源版本不属于当前剧集')
  const timeline = source ? normalizeTimeline(JSON.parse(source.timelineJson)) : initialTimeline(episodeId)
  if (source) {
    timeline.inheritedOutputs = resolveVideoOutputs(source.id, timeline)
    for (const p of timeline.panels) {
      const output = timeline.inheritedOutputs.find(o => o.panelIds.length === 1 && o.panelIds[0] === p.id && !o.stale)
      if (output) p.videoUrl = output.url
      p.sourceFingerprint = hashContent(sourceMetadata(p))
    }
  }
  // New drafts start with fresh acknowledgements; generated media remains available.
  timeline.acknowledgements = {}
  const newId = db.transaction(tx => {
    const last = tx.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.episodeId, episodeId))
      .orderBy(desc(schema.animaticVersions.versionNo)).get()
    const id = Number(tx.insert(schema.animaticVersions).values({
      episodeId, versionNo: (last?.versionNo || 0) + 1, timelineJson: JSON.stringify(timeline),
      createdAt: now(), updatedAt: now(),
    }).run().lastInsertRowid)
    mirrorCurrent(id, timeline)
    return id
  })
  return getVersion(newId)
}
export function readBatches(versionId: number): BatchRun[] {
  const batches = db.select().from(schema.batchRuns).where(eq(schema.batchRuns.versionId, versionId))
    .orderBy(desc(schema.batchRuns.id)).all()
  const batchIds = batches.map(batch => batch.id)
  const items = batchIds.length
    ? db.select().from(schema.batchRunItems).where(inArray(schema.batchRunItems.batchId, batchIds))
      .orderBy(schema.batchRunItems.id).all()
    : []
  const taskIds = [...new Set(items.flatMap(item => item.taskId ? [item.taskId] : []))]
  const tasks = taskIds.length
    ? db.select().from(schema.sysTask).where(inArray(schema.sysTask.id, taskIds)).all()
    : []
  const taskById = new Map(tasks.map(task => [task.id, task]))
  const itemsByBatch = new Map<number, typeof items>()
  for (const item of items) {
    const group = itemsByBatch.get(item.batchId) || []
    group.push(item)
    itemsByBatch.set(item.batchId, group)
  }
  return batches.map(batch => ({
    id: batch.id, versionId: batch.versionId, type: batch.type as 'image' | 'video', status: batch.status,
    items: (itemsByBatch.get(batch.id) || []).map(item => {
      const task = item.taskId ? taskById.get(item.taskId) : null
      const request = JSON.parse(item.requestJson)
      return {
        id: item.id, groupId: item.groupId, panelId: item.panelId, frameType: item.frameType as any,
        status: item.status, taskId: item.taskId, error: item.error, frameId: request.frameId,
        localPath: task?.localPath, resultUrl: task?.resultUrl,
        actualStrategy: request.actualStrategy, generationMode: request.generationMode,
        panelIds: request.panelIds, inputHash: request.inputHash,
      }
    }),
  }))
}
export function isBusy(versionId: number, batches = readBatches(versionId)) {
  return batches.some(b => b.type === 'image' && b.items.some(i => ['pending', 'processing'].includes(i.status)))
}
export function getVersion(versionId: number): AnimaticVersion {
  const row = versionRow(versionId)
  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
  const batches = readBatches(versionId)
  return { ...row, status: row.status as AnimaticVersion['status'], timeline, issues: checkContinuity(timeline),
    isCurrent: isCurrentVersion(versionId), outputs: resolveVideoOutputs(versionId, timeline, batches),
    busy: isBusy(versionId, batches), batches }
}
export function resolveVideoOutputs(
  versionId: number,
  timeline = getVersionTimeline(versionId),
  batches = readBatches(versionId),
): VideoOutput[] {
  const results: VideoOutput[] = []
  const claimed = new Set<number>()
  const trackedUrls = new Set<string>()
  for (const batch of batches.filter(batch => batch.type === 'video')) for (const item of batch.items) {
    if (item.status !== 'completed' || !item.taskId) continue
    const ids: number[] = item.panelIds || (item.panelId ? [item.panelId] : timeline.groups.find(g => g.id === item.groupId)?.panelIds || [])
    if (!ids.length || ids.some(id => claimed.has(id) || !timeline.panels.some(p => p.id === id))) continue
    const url = item.localPath || item.resultUrl
    if (!url) continue
    trackedUrls.add(url)
    const panels = ids.map(id => timeline.panels.find(p => p.id === id)!)
    const stale = !!item.inputHash && item.inputHash !== videoFingerprint(
      timeline, panels, item.generationMode || 'storyboard_frames',
    )
    results.push({
      key: `task-${item.taskId}`, panelIds: ids, url, taskId: item.taskId,
      generationMode: item.generationMode, stale,
    })
    if (!stale) ids.forEach(id => claimed.add(id))
  }
  for (const output of timeline.inheritedOutputs || []) {
    trackedUrls.add(output.url)
    if (output.panelIds.some(id => claimed.has(id) || !timeline.panels.some(p => p.id === id))) continue
    results.push(output)
    if (!output.stale) output.panelIds.forEach(id => claimed.add(id))
  }
  for (const p of timeline.panels) if (!claimed.has(p.id) && p.videoUrl && !trackedUrls.has(p.videoUrl)) {
    results.push({ key: `import-${p.id}`, panelIds: [p.id], url: p.videoUrl, stale: false })
  }
  const order = timelineSegments(timeline).map(s => s.panel.id)
  return results.sort((a, b) => order.indexOf(a.panelIds[0]) - order.indexOf(b.panelIds[0]))
}
function getVersionTimeline(versionId: number) { return normalizeTimeline(JSON.parse(versionRow(versionId).timelineJson)) }
function sourceChanged(before: Timeline, source: Timeline) {
  const collectionChanged = source.panels.length !== before.panels.length
    || source.panels.some(panel => !before.panels.some(existing => existing.id === panel.id))
  const metadataChanged = source.panels.some(panel => {
    const existing = before.panels.find(candidate => candidate.id === panel.id)
    return existing && hashContent(sourceMetadata(panel))
      !== (existing.sourceFingerprint || hashContent(sourceMetadata(existing)))
  })
  return { collectionChanged, changed: collectionChanged || metadataChanged }
}

function versionState(
  row: typeof schema.animaticVersions.$inferSelect,
  timeline: Timeline,
  isCurrent: boolean,
) {
  const batches = readBatches(row.id)
  return {
    id: row.id,
    revision: row.revision,
    status: row.status as AnimaticVersion['status'],
    isCurrent,
    busy: isBusy(row.id, batches),
    batches,
    outputs: resolveVideoOutputs(row.id, timeline, batches),
  }
}

export function getVersionState(versionId: number) {
  const row = versionRow(versionId)
  return { ...versionState(row, normalizeTimeline(JSON.parse(row.timelineJson)), isCurrentVersion(versionId)), requiresRefresh: false }
}

export function getWorkspaceState(episodeId: number, versionId: number) {
  const latest = listVersions(episodeId)[0]
  if (!latest || latest.id !== versionId) {
    return { id: latest?.id || null, revision: latest?.revision || null, requiresRefresh: true }
  }
  const row = versionRow(latest.id)
  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
  if (sourceChanged(timeline, initialTimeline(episodeId)).changed) {
    return { id: row.id, revision: row.revision, requiresRefresh: true }
  }
  return { ...versionState(row, timeline, true), requiresRefresh: false }
}

/** Only the latest version follows outside edits. Viewing a historical version never activates it. */
export function getWorkspace(episodeId: number): AnimaticVersion {
  const latest = listVersions(episodeId)[0]
  if (!latest) return createVersion(episodeId)
  const row = versionRow(latest.id), before = getVersionTimeline(row.id)
  const source = initialTimeline(episodeId)
  const sourceState = sourceChanged(before, source)
  if (!sourceState.changed) return getVersion(row.id)
  const next = structuredClone(before)
  next.panels = source.panels.map(p => {
    const old = before.panels.find(o => o.id === p.id)
    if (!old) return p
    // Keep image choices, generation settings and histories while importing source edits.
    const merged = { ...old, ...sourceMetadata(p), sourceFingerprint: p.sourceFingerprint }
    merged.frames = merged.frames.map(f => ({
      ...f,
      offsetMs: Math.min(f.offsetMs || 0, merged.durationMs - 1),
      referenceImages: f.referenceImages?.filter(url => merged.referenceImages.includes(url)),
    }))
    return merged
  })
  if (sourceState.collectionChanged) {
    next.groups = autoGroup(next.panels, next.strategy)
    rebuildTransitions(next)
    next.audio = next.audio.filter(a => !a.panelId || next.panels.some(p => p.id === a.panelId))
  }
  retimeBoundAudio(before, next)
  next.acknowledgements = {}
  if (row.status === 'locked' || sourceState.collectionChanged) {
    const id = db.transaction(tx => {
      const id = Number(tx.insert(schema.animaticVersions).values({
        episodeId, versionNo: row.versionNo + 1, timelineJson: JSON.stringify(next), createdAt: now(), updatedAt: now(),
      }).run().lastInsertRowid)
      mirrorCurrent(id, next)
      return id
    })
    return getVersion(id)
  }
  db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(next), revision: row.revision + 1,
    status: 'draft', contentHash: null, updatedAt: now() }).where(eq(schema.animaticVersions.id, row.id)).run()
  return getVersion(row.id)
}
export function requireEditable(versionId: number, revision: number) {
  const row = versionRow(versionId)
  if (!Number.isInteger(revision) || row.revision !== revision) throw new PrevisError('版本已更新，请先刷新；本地修改可复制后重新应用。', 409)
  if (row.status === 'locked') throw new PrevisError('锁定版本不可修改，请复制为新草稿', 409)
  return row
}
export function saveTimeline(versionId: number, revision: number, input: unknown) {
  db.transaction(tx => {
    const row = requireEditable(versionId, revision)
    const original = normalizeTimeline(JSON.parse(row.timelineJson))
    const timeline = validateTimeline(input, original)
    timeline.inheritedOutputs = original.inheritedOutputs?.map(o => ({
      ...o, stale: o.stale || videoFingerprint(
        original, original.panels.filter(p => o.panelIds.includes(p.id)), o.generationMode || 'storyboard_frames',
      ) !== videoFingerprint(
        timeline, timeline.panels.filter(p => o.panelIds.includes(p.id)), o.generationMode || 'storyboard_frames',
      ),
    }))
    // Metadata baselines are server-owned; keep optimistic concurrency across the two pages.
    if (isCurrentVersion(versionId)) {
      const source = initialTimeline(row.episodeId)
      if (source.panels.length !== original.panels.length || source.panels.some(p => {
        const old = original.panels.find(o => o.id === p.id)
        return !old || (old.sourceFingerprint && old.sourceFingerprint !== p.sourceFingerprint)
      })) throw new PrevisError('分镜资料已在其他页面更新，请刷新当前工作版后重试。', 409)
    }
    for (const p of timeline.panels) {
      p.sourceFingerprint = hashContent(sourceMetadata(p))
      for (const f of p.frames) {
        const old = original.panels.find(o => o.id === p.id)?.frames.find(o => frameKey(o) === frameKey(f))
        f.history = [...(old?.history || []), ...(old?.url ? [{ url: old.url, taskId: old.taskId }] : []), ...(f.url ? [{ url: f.url, taskId: f.taskId }] : [])]
          .filter((h, i, all) => all.findIndex(v => v.url === h.url) === i).slice(-200)
      }
    }
    tx.update(schema.animaticVersions).set({
      timelineJson: JSON.stringify(timeline), revision: revision + 1, status: 'draft', contentHash: null, updatedAt: now(),
    }).where(and(eq(schema.animaticVersions.id, versionId), eq(schema.animaticVersions.revision, revision))).run()
    mirrorCurrent(versionId, timeline)
  })
  return getVersion(versionId)
}
export function checkOrLock(versionId: number, revision: number, lock: boolean) {
  db.transaction(tx => {
    const row = requireEditable(versionId, revision)
    if (lock && isBusy(versionId)) throw new PrevisError('画面正在生成，请等待完成后再锁定', 409)
    const t = validateTimeline(JSON.parse(row.timelineJson))
    const issues = checkContinuity(t)
    if (lock && issues.some(i => i.severity === 'fail')) throw new PrevisError('请修复时间线中的阻断问题后再锁定', 409)
    tx.update(schema.animaticVersions).set({
      status: lock ? 'locked' : issues.some(i => i.severity === 'fail') ? 'draft' : 'ready',
      timelineJson: JSON.stringify(t), revision: revision + 1, contentHash: hashContent(t), lockedAt: lock ? now() : null, updatedAt: now(),
    }).where(eq(schema.animaticVersions.id, versionId)).run()
  })
  return getVersion(versionId)
}
