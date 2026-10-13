/**
 * 分镜画面拆分 Agent 工具
 * 只读：只读取故事版版本内的镜头上下文，写入一律由用户确认后走 saveTimeline
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { getDramaStylePrompt } from '../../services/style-preset.js'
import { normalizeTimeline, orderedFrames, timelineSegments } from '../../services/previs-domain.js'
import { resolvePanelGridReferences } from '../../services/previs-grid-references.js'
import { getDramaId, getEpisodeId } from '../context.js'

type ToolContext = ToolExecutionContext | undefined

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

function assetsOf(table: 'characters' | 'props', ids: number[], dramaId: number) {
  return ids.map(id => {
    const item = table === 'characters'
      ? db.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
      : db.select().from(schema.props).where(eq(schema.props.id, id)).get()
    if (!item || item.dramaId !== dramaId || item.deletedAt) return { id, imageUrl: null, ready: false }
    return table === 'characters' ? {
      id: item.id, name: item.name, description: item.description,
      appearance: (item as typeof schema.characters.$inferSelect).appearance,
      styling: (item as typeof schema.characters.$inferSelect).styling,
      finalPrompt: item.finalPrompt, imageUrl: item.imageUrl, ready: Boolean(item.imageUrl?.trim()),
    } : {
      id: item.id, name: item.name, description: item.description,
      prompt: (item as typeof schema.props.$inferSelect).prompt, finalPrompt: item.finalPrompt,
      imageUrl: item.imageUrl, ready: Boolean(item.imageUrl?.trim()),
    }
  })
}

/** Shared readonly context used by the agent and the plan's input fingerprint. */
export async function readFramePlanningContext(versionId: number, panelIds: number[], episodeId: number, dramaId: number) {
  const row = db.select().from(schema.animaticVersions)
    .where(eq(schema.animaticVersions.id, versionId)).get()
  if (!row) return { error: 'Animatic version not found' }
  if (row.episodeId !== episodeId) return { error: 'Animatic version does not belong to current episode' }
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode || episode.deletedAt || episode.dramaId !== dramaId) return { error: 'Episode does not belong to current drama' }

  const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
  const style = await getDramaStylePrompt(dramaId)
  const segments = timelineSegments(timeline)
  function neighbor(panelId: number, delta: number) {
    const segment = segments[segments.findIndex(s => s.panel.id === panelId) + delta]
    if (!segment) return null
    const p = segment.panel, group = timeline.groups.find(g => g.id === segment.groupId)
    const ordered = orderedFrames(p)
    return { panelId: p.id, title: p.title, description: p.description, videoPrompt: p.videoPrompt,
      imagePrompt: p.imagePrompt, atmosphere: p.atmosphere, scene: p.scene, sceneId: p.sceneId,
      shotType: p.shotType, angle: p.angle, movement: p.movement, entry: group?.entry, exit: group?.exit,
      boundaryFrame: delta < 0 ? ordered.at(-1) : ordered[0],
      referenceManifest: resolvePanelGridReferences(p, dramaId),
      characters: assetsOf('characters', p.characterIds, dramaId), props: assetsOf('props', p.propIds, dramaId) }
  }
  const panels = []
  for (const panelId of panelIds) {
    const panel = timeline.panels.find(item => item.id === panelId)
    if (!panel) { panels.push({ panelId, error: 'Panel not found in this version' }); continue }
    const scene = panel.sceneId
      ? db.select().from(schema.scenes).where(eq(schema.scenes.id, panel.sceneId)).get()
      : null
    const frames = orderedFrames(panel).map(frame => ({
      id: frame.id, title: frame.title, offsetMs: frame.offsetMs, type: frame.type, url: frame.url, source: frame.source,
      prompt: frame.prompt, shotType: frame.shotType, angle: frame.angle,
      composition: frame.composition, continuity: frame.continuity, referenceImages: frame.referenceImages,
    }))
    panels.push({
      panelId: panel.id, title: panel.title, description: panel.description,
      videoPrompt: panel.videoPrompt, imagePrompt: panel.imagePrompt, atmosphere: panel.atmosphere,
      referenceImages: panel.referenceImages, referenceLabels: panel.referenceLabels,
      referenceManifest: resolvePanelGridReferences(panel, dramaId, { timeline, versionId }),
      previousPanel: neighbor(panelId, -1), nextPanel: neighbor(panelId, 1),
      durationSeconds: Number(((panel.durationMs || 0) / 1000).toFixed(1)), durationMs: panel.durationMs,
      shotType: panel.shotType, angle: panel.angle, movement: panel.movement,
      continuityConstraints: panel.continuityConstraints,
      scene: scene && scene.dramaId === dramaId && !scene.deletedAt ? {
        id: scene.id, location: scene.location, time: scene.time,
        prompt: scene.prompt, lighting: scene.lighting, finalPrompt: scene.finalPrompt,
        imageUrl: scene.imageUrl, ready: Boolean(scene.imageUrl?.trim()),
      } : { id: panel.sceneId, name: panel.scene, imageUrl: null, ready: false },
      characters: assetsOf('characters', panel.characterIds, dramaId),
      props: assetsOf('props', panel.propIds, dramaId),
      existingFrameCount: panel.frames.length,
      orderedFrames: frames,
      existingFrames: frames,
    })
  }
  return { style: style || undefined, panels }
}

const readPrevisContext = createTool({
  id: 'read_previs_context',
  description: 'Read the animatic version panels (shots) that need to be split into storyboard frames.',
  inputSchema: z.object({
    versionId: z.number().int().positive(),
    panelIds: z.array(z.number().int().positive()).min(1).max(50),
  }),
  execute: async (input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    return readFramePlanningContext(input.versionId, input.panelIds, ids.episodeId, ids.dramaId)
  },
})

export const frameSplitterTools = {
  read_previs_context: readPrevisContext,
}
