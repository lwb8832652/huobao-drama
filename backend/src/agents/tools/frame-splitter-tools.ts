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
import { normalizeTimeline } from '../../services/previs-domain.js'
import { getDramaId, getEpisodeId } from '../context.js'

type ToolContext = ToolExecutionContext | undefined

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

async function namesOf(table: 'characters' | 'props', ids: number[]) {
  return ids.map(id => (table === 'characters'
    ? db.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
    : db.select().from(schema.props).where(eq(schema.props.id, id)).get()))
    .filter(Boolean)
    .map(item => ({ id: item!.id, name: item!.name }))
    .filter(item => item.name)
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
    const { episodeId, dramaId } = ids
    const row = db.select().from(schema.animaticVersions)
      .where(eq(schema.animaticVersions.id, input.versionId)).get()
    if (!row) return { error: 'Animatic version not found' }
    if (row.episodeId !== episodeId) return { error: 'Animatic version does not belong to current episode' }

    const timeline = normalizeTimeline(JSON.parse(row.timelineJson))
    const style = await getDramaStylePrompt(dramaId)
    const panels = []
    for (const panelId of input.panelIds) {
      const panel = timeline.panels.find(item => item.id === panelId)
      if (!panel) { panels.push({ panelId, error: 'Panel not found in this version' }); continue }
      const scene = panel.sceneId
        ? db.select().from(schema.scenes).where(eq(schema.scenes.id, panel.sceneId)).get()
        : null
      panels.push({
        panelId: panel.id,
        title: panel.title,
        description: panel.description,
        atmosphere: panel.atmosphere,
        durationSeconds: Number(((panel.durationMs || 0) / 1000).toFixed(1)),
        shotType: panel.shotType,
        angle: panel.angle,
        movement: panel.movement,
        scene: scene ? { id: scene.id, location: scene.location, time: scene.time } : { name: panel.scene },
        characters: await namesOf('characters', panel.characterIds),
        props: await namesOf('props', panel.propIds),
        existingFrameCount: panel.frames.length,
      })
    }
    return { style: style || undefined, panels }
  },
})

export const frameSplitterTools = {
  read_previs_context: readPrevisContext,
}
