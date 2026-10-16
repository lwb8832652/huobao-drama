import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { analyzePanelProduction, buildProductionPlan, renderProductionPrompt, restoreScriptDialogue } from './shot-planning.js'
import { normalizeTimeline, rebuildTransitions, retimeBoundAudio, type Panel, type StoryboardGroup } from './previs-domain.js'
import { getVersion, hashContent, isBusy, isCurrentVersion, mirrorCurrent, PrevisError, sourceMetadata, validateTimeline, versionRow, episodeForPrevis, initialTimeline } from './previs.js'

export interface RepairOptions { revision: number; panelIds: number[]; maxSeconds: number }
/** Only trusted service callers provide overrides; public routes never accept them. */
export type ProductionOverrides = Record<number, { description: string; atmosphere?: string }>
export function previewProductionRepair(versionId: number, options: RepairOptions, overrides: ProductionOverrides = {}) {
  const row = versionRow(versionId), episode = episodeForPrevis(row.episodeId)
  if (row.revision !== options.revision) throw new PrevisError('版本已更新，请重新预览', 409)
  if (!isCurrentVersion(versionId)) throw new PrevisError('请在当前工作版预览优化', 409)
  if (!Number.isInteger(options.maxSeconds) || options.maxSeconds < 5 || options.maxSeconds > 15) throw new PrevisError('单段规划上限需为5—15秒；更长工作流需先验证能力')
  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
  if (!options.panelIds.length || new Set(options.panelIds).size !== options.panelIds.length || options.panelIds.some(id => !timeline.panels.some(p => p.id === id))) throw new PrevisError('选择的分镜不属于当前工作版')
  const script = episode.scriptContent || episode.content || ''
  const proposals = timeline.panels.filter(p => options.panelIds.includes(p.id)).map(panel => {
    const target = { ...panel, ...overrides[panel.id] }
    const restored = overrides[panel.id] ? { description: target.description, restorations: [] } : restoreScriptDialogue(target.description, script)
    try {
      const result = buildProductionPlan({ ...target, description: restored.description }, { maxSeconds: options.maxSeconds, minSeconds: 4 })
      return { panelId: panel.id, title: panel.title, beforeDurationMs: panel.durationMs, beforeVideoUrl: panel.videoUrl,
        issues: analyzePanelProduction(panel).issues, restorations: restored.restorations, segments: result.segments,
        afterDurationMs: result.segments.reduce((sum, s) => sum + s.durationMs, 0), error: null as string | null,
        retainedFrames: panel.frames.filter(f => !!f.url).length,
      }
    } catch (err: any) {
      return { panelId: panel.id, title: panel.title, beforeDurationMs: panel.durationMs, beforeVideoUrl: panel.videoUrl,
        issues: analyzePanelProduction(panel).issues, restorations: restored.restorations, segments: [],
        afterDurationMs: panel.durationMs, error: String(err.message || '无法自动规划'), retainedFrames: panel.frames.filter(f => !!f.url).length }
    }
  })
  return { versionId, revision: row.revision, inputHash: hashContent({ versionId, revision: row.revision, timeline: row.timelineJson, source: initialTimeline(row.episodeId).panels.map(sourceMetadata), script, options, overrides }),
    maxSeconds: options.maxSeconds, proposals,
    beforeDurationMs: proposals.reduce((sum, p) => sum + p.beforeDurationMs, 0),
    afterDurationMs: proposals.reduce((sum, p) => sum + p.afterDurationMs, 0),
    extraGenerations: proposals.reduce((sum, p) => sum + Math.max(0, p.segments.length - 1), 0),
  }
}

/** A reviewable new draft is created atomically. The old version and media stay intact. */
export function applyProductionRepair(versionId: number, options: RepairOptions & { inputHash: string }, overrides: ProductionOverrides = {}) {
  const { inputHash, ...request } = options
  let newId = 0
  db.transaction(tx => {
    const before = getVersion(versionId), row = versionRow(versionId)
    const preview = previewProductionRepair(versionId, request, overrides)
    if (preview.inputHash !== inputHash) throw new PrevisError('资料已变化，请重新预览优化方案', 409)
    if (isBusy(versionId) || before.batches.some(batch => batch.type === 'video' && batch.items.some(item => ['pending', 'processing'].includes(item.status)))
      || db.select().from(schema.framePlans).where(eq(schema.framePlans.versionId, versionId)).all().some(p => ['pending', 'processing'].includes(p.status))) throw new PrevisError('生成或画面规划任务正在运行，请完成或取消后再应用', 409)
    if (preview.proposals.some(p => p.error)) throw new PrevisError('有对白无法自动拆句，请先修正描述后重新预览')
    const sourceRows = tx.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, row.episodeId)).all().filter(s => !s.deletedAt)
    const sourcePanels = initialTimeline(row.episodeId).panels
    if (sourcePanels.length !== before.timeline.panels.length || before.timeline.panels.some(panel => {
      const source = sourcePanels.find(item => item.id === panel.id)
      return !source || source.sourceFingerprint !== (panel.sourceFingerprint || hashContent(sourceMetadata(panel)))
    })) throw new PrevisError('分镜已在其他页面更新，请刷新后重新预览', 409)
    const next = structuredClone(before.timeline), changed = new Set(request.panelIds)
    const panels: Panel[] = [], groups: StoryboardGroup[] = []
    const firstGroupIds = new Map<string, string>(), lastGroupIds = new Map<string, string>()
    for (const originalGroup of before.timeline.groups) {
      const original = next.panels.find(panel => panel.id === originalGroup.panelIds[0])!
      const proposal = preview.proposals.find(p => p.panelId === original.id)
      if (!proposal) {
        panels.push(original); groups.push(structuredClone(originalGroup))
        firstGroupIds.set(originalGroup.id, originalGroup.id); lastGroupIds.set(originalGroup.id, originalGroup.id)
        continue
      }
      const oldRow = sourceRows.find(s => s.id === original.id)!
      for (const [index, segment] of proposal.segments.entries()) {
        const id = index === 0 ? original.id : Number(tx.insert(schema.storyboards).values({
          episodeId: row.episodeId, storyboardNumber: 0, title: original.title,
          sceneId: oldRow.sceneId, location: oldRow.location, time: oldRow.time,
          shotType: oldRow.shotType, angle: oldRow.angle, movement: oldRow.movement,
          atmosphere: oldRow.atmosphere, bgmPrompt: oldRow.bgmPrompt, soundEffect: oldRow.soundEffect,
          createdAt: now(), updatedAt: now(), status: 'pending',
        }).run().lastInsertRowid)
        const panel: Panel = { ...structuredClone(original), id,
          title: proposal.segments.length > 1 ? `${original.title} · ${index + 1}/${proposal.segments.length}` : original.title,
          description: segment.description, durationMs: segment.durationMs, productionPlan: segment.plan, atmosphere: segment.plan.atmosphere,
          videoPrompt: renderProductionPrompt(segment.plan),
          frames: index === 0 ? original.frames.map(frame => ({ ...frame, offsetMs: Math.min(frame.offsetMs || 0, segment.durationMs - 1) })) : [],
          videoUrl: index === 0 ? original.videoUrl : '', coverFrameId: index === 0 ? original.coverFrameId : undefined,
          framePlanNeedsReview: true,
        }
        panels.push(panel)
        const first = index === 0, last = index === proposal.segments.length - 1
        const groupId = first ? originalGroup.id : `panel-${id}`
        groups.push({ ...structuredClone(originalGroup), id: groupId, title: panel.title, panelIds: [id],
          note: first ? originalGroup.note : '',
          entry: { ...originalGroup.entry }, exit: { ...(last ? originalGroup.exit : originalGroup.entry) },
        })
        if (first) firstGroupIds.set(originalGroup.id, groupId)
        if (last) lastGroupIds.set(originalGroup.id, groupId)
      }
    }
    next.panels = panels
    next.groups = groups
    next.transitions = before.timeline.transitions.map(edge => ({ ...structuredClone(edge),
      from: lastGroupIds.get(edge.from) || edge.from, to: firstGroupIds.get(edge.to) || edge.to,
    }))
    rebuildTransitions(next)
    // Audio files are retained; affected timing is flagged by normal timeline diagnostics.
    retimeBoundAudio(before.timeline, next)
    next.inheritedOutputs = before.outputs.map(output => ({ ...output, stale: output.stale || output.panelIds.some(id => changed.has(id)) }))
    next.acknowledgements = {}
    validateTimeline(next)
    const stamp = now()
    newId = Number(tx.insert(schema.animaticVersions).values({ episodeId: row.episodeId, versionNo: row.versionNo + 1,
      revision: 1, status: 'draft', timelineJson: JSON.stringify(next), createdAt: stamp, updatedAt: stamp }).run().lastInsertRowid)
    for (const [index, panel] of next.panels.entries()) tx.update(schema.storyboards).set({ storyboardNumber: index + 1 }).where(eq(schema.storyboards.id, panel.id)).run()
    mirrorCurrent(newId, next)
    // Timeline-only reference choices are not mirrored into legacy source rows.
    // Fingerprint the source actually written, so refresh never imports away those choices.
    const baselines = new Map(initialTimeline(row.episodeId).panels.map(panel => [panel.id, panel.sourceFingerprint]))
    for (const panel of next.panels) panel.sourceFingerprint = baselines.get(panel.id)!
    tx.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(next) }).where(eq(schema.animaticVersions.id, newId)).run()
    tx.update(schema.episodes).set({ duration: Math.ceil(next.panels.reduce((sum, p) => sum + p.durationMs, 0) / 60000), updatedAt: stamp }).where(eq(schema.episodes.id, row.episodeId)).run()
  })
  return getVersion(newId)
}
