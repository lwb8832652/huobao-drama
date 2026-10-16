/**
 * 分镜拆解 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, getInsertId, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import { getDramaId, getEpisodeId } from '../context.js'
import { analyzePanelProduction, productionBlockingMessage } from '../../services/shot-planning.js'

type StoryboardDb = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>

function syncStoryboardCharacters(store: StoryboardDb, storyboardId: number, characterIds: number[]) {
  store.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).run()
  for (const characterId of new Set(characterIds)) store.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
}

function syncStoryboardProps(store: StoryboardDb, storyboardId: number, propIds: number[]) {
  store.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, storyboardId)).run()
  for (const propId of new Set(propIds)) store.insert(schema.storyboardProps).values({ storyboardId, propId }).run()
}

/** Validation is read-only, including for assets already linked to this episode. */
function validateStoryboardBindings(store: StoryboardDb, dramaId: number, sceneId: number | null | undefined, characterIds: number[] = [], propIds: number[] = []) {
  if (sceneId != null) {
    const scene = store.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId)).get()
    if (!scene || scene.dramaId !== dramaId || scene.deletedAt) throw new Error(`scene_id ${sceneId} 不属于当前项目`)
  }
  for (const characterId of new Set(characterIds)) {
    const character = store.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()
    if (!character || character.dramaId !== dramaId || character.deletedAt) throw new Error(`character_id ${characterId} 不属于当前项目`)
  }
  for (const propId of new Set(propIds)) {
    const prop = store.select().from(schema.props).where(eq(schema.props.id, propId)).get()
    if (!prop || prop.dramaId !== dramaId || prop.deletedAt) throw new Error(`prop_id ${propId} 不属于当前项目`)
  }
}

/** Called only after every input row has passed validation, inside the write transaction. */
function ensureEpisodeBindings(store: StoryboardDb, episodeId: number, sceneId: number | null | undefined, characterIds: number[] = [], propIds: number[] = []) {
  const sceneIds = new Set(store.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId)).all().map(link => link.sceneId))
  const characterIdsInEpisode = new Set(store.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId)).all().map(link => link.characterId))
  const propIdsInEpisode = new Set(store.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId)).all().map(link => link.propId))
  if (sceneId != null && !sceneIds.has(sceneId)) store.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: now() }).run()
  for (const characterId of new Set(characterIds)) if (!characterIdsInEpisode.has(characterId)) store.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: now() }).run()
  for (const propId of new Set(propIds)) if (!propIdsInEpisode.has(propId)) store.insert(schema.episodeProps).values({ episodeId, propId, createdAt: now() }).run()
}

function requireOwnedEpisode(store: StoryboardDb, episodeId: number, dramaId: number) {
  const episode = store.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode || episode.deletedAt || episode.dramaId !== dramaId) throw new Error('Episode not found in current project')
  return episode
}

function validateStoryboardProduction(row: { id?: number; title?: string | null; description?: string | null; videoPrompt?: string | null; duration?: number | null }, allowMissingPrompt: boolean) {
  const duration = row.duration
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) throw new Error('分镜时长必须为正数')
  const panel = { id: row.id || 0, title: row.title || '分镜', description: row.description || '', videoPrompt: row.videoPrompt || '', durationMs: Math.round(duration * 1000) }
  if (panel.videoPrompt.trim()) {
    const message = productionBlockingMessage(panel)
    if (message) throw new Error(message)
  } else if (!allowMissingPrompt) {
    throw new Error('视频提示词为空，请生成保留完整对白的视频提示词')
  } else {
    // Breakdown may save before prompt generation, but its source dialogue still has to fit.
    const failure = analyzePanelProduction(panel).issues.find(issue => issue.severity === 'fail' && issue.rule !== 'dialogue_missing' && issue.rule !== 'dialogue_mismatch')
    if (failure) throw new Error(failure.message)
  }
}

interface PromptWriteReceipt { videoPrompt: string; updatedAt: string }
const promptWrites = new WeakMap<object, Map<number, PromptWriteReceipt>>()
const breakdownWrites = new WeakMap<object, Set<number>>()
const correctionContexts = new WeakSet<object>()
export function setStoryboardCorrectionMode(requestContext: object, enabled: boolean) {
  if (enabled) correctionContexts.add(requestContext)
  else correctionContexts.delete(requestContext)
}
/** Successful writes only; text responses and failed transactions never count. */
export function getStoryboardBreakdownReceipt(requestContext: object | undefined) {
  return requestContext ? [...(breakdownWrites.get(requestContext) || [])] : []
}
function recordBreakdownWrites(requestContext: object | undefined, ids: number[], replace = false) {
  if (!requestContext) return
  const written = replace ? new Set<number>() : breakdownWrites.get(requestContext) || new Set<number>()
  ids.forEach(id => written.add(id))
  breakdownWrites.set(requestContext, written)
}
/** A receipt proves a successful prompt write from this exact agent request, even if text is unchanged. */
export function getStoryboardPromptWriteReceipt(requestContext: object | undefined, storyboardId: number) {
  return requestContext ? promptWrites.get(requestContext)?.get(storyboardId) : undefined
}

type ToolContext = ToolExecutionContext | undefined

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

const readStoryboardContext = createTool({
  id: 'read_storyboard_context',
  description: 'Read the screenplay, characters, scenes, and props for storyboard breakdown.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep || ep.deletedAt || ep.dramaId !== dramaId) return { error: 'Episode not found in current project' }
    const script = ep.scriptContent || ep.content
    if (!script) return { error: 'Episode has no script' }

    const charLinks = await db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId))
    const sceneLinks = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const propLinks = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))

    const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
    const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))
    const linkedPropIds = new Set(propLinks.map(link => link.propId))

    const chars = await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId))
    const scns = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId))
    const prps = await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId))
    const existingStoryboards = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))

    const characters = chars
      .filter(c => !c.deletedAt)
      .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
      .map(c => ({
        id: c.id,
        name: c.name,
        role: c.role || '',
        description: c.description || '',
        appearance: c.appearance || '',
        styling: c.styling || '',
        image_url: c.imageUrl || '',
        reference_images: c.referenceImages || '',
      }))

    const scenes = scns
      .filter(s => !s.deletedAt)
      .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
      .map(s => ({
        id: s.id,
        location: s.location,
        time: s.time,
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        image_url: s.imageUrl || '',
        storyboard_count: s.storyboardCount || 0,
      }))

    const props = prps
      .filter(p => !p.deletedAt)
      .filter(p => !linkedPropIds.size || linkedPropIds.has(p.id))
      .map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        image_url: p.imageUrl || '',
      }))

    const existingStoryboardPayload = await Promise.all(existingStoryboards
      .filter(sb => !sb.deletedAt)
      .map(async (sb) => {
        const links = await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
        const sbPropLinks = await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, sb.id))
        return {
          id: sb.id,
          shot_number: sb.storyboardNumber,
          title: sb.title || '',
          scene_id: sb.sceneId,
          character_ids: links.map(link => link.characterId),
          prop_ids: sbPropLinks.map(link => link.propId),
          shot_type: sb.shotType || '',
          duration: sb.duration || 0,
          description: sb.description || '',
          atmosphere: sb.atmosphere || '',
          video_prompt: sb.videoPrompt || '',
        }
      }))

    const payload = {
      episode: {
        id: ep.id,
        title: ep.title,
        episode_number: ep.episodeNumber,
        description: ep.description || '',
      },
      script,
      characters,
      scenes,
      props,
      existing_storyboards: existingStoryboardPayload,
    }
    logTaskSuccess('StoryboardTool', 'read-context', {
      episodeId,
      dramaId,
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      existingStoryboards: payload.existing_storyboards.length,
      scriptLength: script.length,
    })
    return payload
  },
})

// qwen3.8-flash 等模型会把布尔/数字参数序列化为字符串（"true" / "10"），
// zod 严格类型校验直接拒绝（"expected boolean, received string"），
// 实测曾导致整批保存连续失败 6 轮、浪费 4 分钟以上（模型靠删字段才绕过去）。
// 对标量字段统一宽松化：仅当值是字符串形式的布尔/数字时转换为原生类型
const looseBool = <A extends z.ZodTypeAny>(schema: A): A =>
  z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), schema) as unknown as A
const looseNum = <A extends z.ZodTypeAny>(schema: A): A =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : v), schema) as unknown as A

const storyboardFields = z.object({
  shot_number: looseNum(z.number()),
  title: z.string().optional(),
  shot_type: z.string().optional(),
  angle: z.string().optional(),
  movement: z.string().optional(),
  location: z.string().optional(),
  time: z.string().optional(),
  description: z.string().optional(),
  result: z.string().optional(),
  atmosphere: z.string().optional(),
  image_prompt: z.string().optional(),
  video_prompt: z.string().optional(),
  bgm_prompt: z.string().optional(),
  sound_effect: z.string().optional(),
  duration: looseNum(z.number().optional()),
  scene_id: looseNum(z.number().nullable().optional()),
  character_ids: z.array(z.number()).optional(),
  prop_ids: z.array(z.number()).optional(),
})

const saveStoryboards = createTool({
  id: 'save_storyboards',
  description: 'Save storyboards for this episode. Preferred batch size is 6-8 storyboards per call (up to 16 accepted; larger calls are rejected): the first batch must set replace_existing: true (clears all old storyboards for the episode, then writes), every following batch omits replace_existing (appends). Rows are upserted by shot_number, so overlapping batches and retries never create duplicates.',
  inputSchema: z.object({
    replace_existing: looseBool(z.boolean().optional()),
    // 软上限 16 条：建议每批 6~8，模型偶尔超限（9~16）时不再拒绝——校验失败→错误回传→重试
    // 的循环曾被证实会烧掉 3 分钟以上（qwen3.8-flash 纠错能力弱）。超过 16 仍拒绝，
    // 防止整集大 JSON 一次生成导致输出截断/超慢
    storyboards: z.array(storyboardFields).max(16),
  }),
  execute: async ({ storyboards, replace_existing }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    if (replace_existing && context?.requestContext && correctionContexts.has(context.requestContext)) {
      throw new Error('纠错期间不能清空或替换已保存分镜，请更新已有分镜或追加缺失段落')
    }
    const ts = now()
    logTaskProgress('StoryboardTool', 'save-begin', {
      episodeId, dramaId, replaceExisting: replace_existing === true,
      count: storyboards.length, shotNumbers: storyboards.map(sb => sb.shot_number).join(','),
    })
    const totalDuration = db.transaction(store => {
      requireOwnedEpisode(store, episodeId, dramaId)
      const existingRows = store.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
      const existingByShot = new Map(existingRows.filter(sb => !sb.deletedAt).map(sb => [sb.storyboardNumber, sb]))
      const effectiveByShot = new Map<number, {
        description?: string | null; videoPrompt?: string | null; duration?: number | null; sceneId?: number | null
      }>(replace_existing ? [] : existingByShot)
      // Preflight the ENTIRE batch before clearing rows or creating any asset links.
      const failures: string[] = []
      const prepared = storyboards.map(sb => {
        const previous = effectiveByShot.get(sb.shot_number)
        const values = {
          title: sb.title, shotType: sb.shot_type, angle: sb.angle, movement: sb.movement,
          location: sb.location, time: sb.time, description: sb.description ?? previous?.description,
          result: sb.result, atmosphere: sb.atmosphere, imagePrompt: sb.image_prompt,
          videoPrompt: sb.video_prompt ?? previous?.videoPrompt, bgmPrompt: sb.bgm_prompt,
          soundEffect: sb.sound_effect, sceneId: sb.scene_id === undefined ? previous?.sceneId : sb.scene_id,
          duration: sb.duration ?? previous?.duration ?? 10, updatedAt: ts,
        }
        const characterIds = sb.character_ids ?? []
        const propIds = sb.prop_ids ?? []
        try {
          validateStoryboardProduction(values, sb.video_prompt === undefined)
          validateStoryboardBindings(store, dramaId, values.sceneId, characterIds, propIds)
        } catch (error: any) { failures.push(`分镜 #${sb.shot_number}：${error.message}`) }
        effectiveByShot.set(sb.shot_number, values)
        return { sb, values, characterIds, propIds }
      })
      if (failures.length) throw new Error(`本批分镜未保存，请修正后重试：\n${failures.join('\n')}`)
      if (replace_existing === true) {
        for (const previous of existingRows) {
          store.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, previous.id)).run()
          store.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, previous.id)).run()
        }
        store.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run()
      }
      const shotToId = new Map(replace_existing ? [] : [...existingByShot].map(([shot, row]) => [shot, row.id]))
      for (const { sb, values, characterIds, propIds } of prepared) {
        ensureEpisodeBindings(store, episodeId, values.sceneId, characterIds, propIds)
        let storyboardId = shotToId.get(sb.shot_number)
        if (storyboardId !== undefined) store.update(schema.storyboards).set(values).where(eq(schema.storyboards.id, storyboardId)).run()
        else {
          storyboardId = getInsertId(store.insert(schema.storyboards).values({ ...values, episodeId, storyboardNumber: sb.shot_number, createdAt: ts }).run())
          shotToId.set(sb.shot_number, storyboardId)
        }
        syncStoryboardCharacters(store, storyboardId, characterIds)
        syncStoryboardProps(store, storyboardId, propIds)
      }
      const total = store.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
        .filter(sb => !sb.deletedAt).reduce((sum, sb) => sum + (sb.duration || 0), 0)
      store.update(schema.episodes).set({ duration: Math.ceil(total / 60), updatedAt: ts }).where(eq(schema.episodes.id, episodeId)).run()
      return total
    })

    const writtenIds = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
      .filter(row => !row.deletedAt && storyboards.some(sb => sb.shot_number === row.storyboardNumber)).map(row => row.id)
    recordBreakdownWrites(context?.requestContext, writtenIds, replace_existing === true)
    logTaskSuccess('StoryboardTool', 'save-complete', {
      episodeId,
      count: storyboards.length,
      totalDuration,
    })
    return { message: `Saved ${storyboards.length} storyboards`, count: storyboards.length, total_duration: totalDuration }
  },
})

const updateStoryboard = createTool({
  id: 'update_storyboard',
  description: 'Update a specific storyboard shot.',
  inputSchema: z.object({
    storyboard_id: looseNum(z.number()),
    title: z.string().optional(),
    shot_number: looseNum(z.number().int().positive().optional()),
    shot_type: z.string().optional(),
    angle: z.string().optional(),
    movement: z.string().optional(),
    location: z.string().optional(),
    time: z.string().optional(),
    result: z.string().optional(),
    atmosphere: z.string().optional(),
    image_prompt: z.string().optional(),
    video_prompt: z.string().optional(),
    bgm_prompt: z.string().optional(),
    sound_effect: z.string().optional(),
    description: z.string().optional(),
    scene_id: looseNum(z.number().nullable().optional()),
    character_ids: z.array(z.number()).optional(),
    prop_ids: z.array(z.number()).optional(),
    duration: looseNum(z.number().optional()),
  }),
  execute: async ({ storyboard_id, ...fields }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    requireOwnedEpisode(db, episodeId, dramaId)
    const storyboard = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).get()
    if (!storyboard || storyboard.deletedAt) return { error: `Storyboard ${storyboard_id} not found` }
    if (storyboard.episodeId !== episodeId) return { error: `Storyboard ${storyboard_id} does not belong to the current episode` }

    // 过滤模型回传的垃圾值：视频提示词 Agent 常把整行字段回传，
    // 拿不准的字符串字段写成 "null"/"undefined"，直接覆盖会毁掉已有内容
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const v = fields[key]
      if (typeof v === 'string' && (v === 'null' || v === 'undefined' || v === 'NULL' || v === 'Null')) {
        delete fields[key]
      }
    }

    logTaskProgress('StoryboardTool', 'update-begin', {
      episodeId,
      storyboardId: storyboard_id,
      fields: Object.keys(fields),
    })

    const updates: Record<string, any> = { updatedAt: now() }
    if ('shot_number' in fields) updates.storyboardNumber = fields.shot_number
    if ('title' in fields) updates.title = fields.title
    if ('shot_type' in fields) updates.shotType = fields.shot_type
    if ('angle' in fields) updates.angle = fields.angle
    if ('movement' in fields) updates.movement = fields.movement
    if ('location' in fields) updates.location = fields.location
    if ('time' in fields) updates.time = fields.time
    if ('result' in fields) updates.result = fields.result
    if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
    if ('image_prompt' in fields) updates.imagePrompt = fields.image_prompt
    if ('video_prompt' in fields) updates.videoPrompt = fields.video_prompt
    if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
    if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
    if ('description' in fields) updates.description = fields.description
    if ('scene_id' in fields) updates.sceneId = fields.scene_id
    if ('duration' in fields) updates.duration = fields.duration
    db.transaction(store => {
      requireOwnedEpisode(store, episodeId, dramaId)
      const current = store.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).get()
      if (!current || current.deletedAt || current.episodeId !== episodeId) throw new Error(`Storyboard ${storyboard_id} not found in current episode`)
      if ('shot_number' in fields && store.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
        .some(row => !row.deletedAt && row.id !== storyboard_id && row.storyboardNumber === fields.shot_number)) throw new Error('镜头编号已被占用，请先使用空闲编号调整顺序')
      if ('description' in fields || 'duration' in fields || 'video_prompt' in fields) validateStoryboardProduction({ ...current, ...updates }, false)
      const sceneId = 'scene_id' in fields ? fields.scene_id : current.sceneId
      const currentCharacterIds = fields.character_ids ?? store.select().from(schema.storyboardCharacters)
        .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)).all().map(link => link.characterId)
      const currentPropIds = fields.prop_ids ?? store.select().from(schema.storyboardProps)
        .where(eq(schema.storyboardProps.storyboardId, storyboard_id)).all().map(link => link.propId)
      validateStoryboardBindings(store, dramaId, sceneId, currentCharacterIds, currentPropIds)
      ensureEpisodeBindings(store, episodeId, sceneId, currentCharacterIds, currentPropIds)
      store.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id)).run()
      if ('character_ids' in fields) syncStoryboardCharacters(store, storyboard_id, fields.character_ids || [])
      if ('prop_ids' in fields) syncStoryboardProps(store, storyboard_id, fields.prop_ids || [])
    })
    if ('description' in fields || 'duration' in fields || 'video_prompt' in fields) recordBreakdownWrites(context?.requestContext, [storyboard_id])
    if ('video_prompt' in fields && context?.requestContext) {
      const receipts = promptWrites.get(context.requestContext) || new Map<number, PromptWriteReceipt>()
      receipts.set(storyboard_id, { videoPrompt: fields.video_prompt!, updatedAt: updates.updatedAt })
      promptWrites.set(context.requestContext, receipts)
    }
    logTaskSuccess('StoryboardTool', 'update-complete', {
      episodeId,
      storyboardId: storyboard_id,
      updatedFields: Object.keys(updates),
      characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      propIds: 'prop_ids' in fields ? (fields.prop_ids || []).join(',') : undefined,
    })
    return { message: `Storyboard ${storyboard_id} updated` }
  },
})

export const storyboardTools = { readStoryboardContext, saveStoryboards, updateStoryboard }
