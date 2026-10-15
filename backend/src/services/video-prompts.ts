/**
 * 批量视频提示词任务 — 异步为缺少 video_prompt 的分镜逐个运行 prompt_generator Agent
 * 进程内内存态：按集跟踪一份任务，运行中不重复启动；重启后状态丢失
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { buildAgentRequestContext } from '../agents/context.js'
import { getStoryboardPromptWriteReceipt } from '../agents/tools/storyboard-tools.js'
import { productionBlockingMessage } from './shot-planning.js'
import { logTaskError, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

export interface VideoPromptBatchStatus {
  status: 'running' | 'done' | 'error'
  total: number
  completed: number
  failed: number
  current_storyboard_id?: number
  started_at: string
  finished_at?: string
  error?: string
}

const tasks = new Map<number, VideoPromptBatchStatus>()

/** 启动批量生成（立即返回）；运行中返回 started:false,total:-1；无待生成分镜返回 started:false,total:0；
 *  传入 storyboardIds 时只处理所选分镜（即使已有提示词也重新生成），否则处理全部缺失提示词的分镜 */
export async function startVideoPromptBatch(
  episodeId: number,
  dramaId: number,
  opts: { model?: string; configId?: number } = {},
  storyboardIds?: number[],
): Promise<{ started: boolean; total: number }> {
  // SQLite reads are synchronous so ownership/pending lookup and claiming the task cannot interleave.
  const ep = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!ep || ep.deletedAt || ep.dramaId !== dramaId) throw new Error('Episode not found in current project')
  if (tasks.get(episodeId)?.status === 'running') return { started: false, total: -1 }

  const sbs = db.select().from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber).all()
  const live = sbs.filter(sb => !sb.deletedAt)
  const pending = storyboardIds?.length
    ? live.filter(sb => storyboardIds.includes(sb.id))
    : live.filter(sb => !(sb.videoPrompt || '').trim())
  if (!pending.length) return { started: false, total: 0 }

  // 视频模型标签：跟随该集锁定的视频配置，供 Agent 按模型特性生成
  let videoLabel = '默认'
  if (ep?.videoConfigId) {
    const cfg = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, ep.videoConfigId)).get()
    if (cfg) videoLabel = `${cfg.name} (${cfg.provider})`
  }

  const task: VideoPromptBatchStatus = {
    status: 'running',
    total: pending.length,
    completed: 0,
    failed: 0,
    started_at: new Date().toISOString(),
  }
  tasks.set(episodeId, task)

  logTaskStart('VideoPrompt', 'batch', { episodeId, dramaId, total: pending.length, model: opts.model || undefined })
  ;(async () => {
    const agent = mastra.getAgent('prompt_generator')
    if (!agent) throw new Error('视频提示词 Agent 不可用')
    for (const sb of pending) {
      task.current_storyboard_id = sb.id
      logTaskProgress('VideoPrompt', 'batch-shot', { episodeId, storyboardId: sb.id, index: task.completed + task.failed + 1, total: task.total })
      try {
        // Isolate write receipts for each attempt; old content or other shots cannot count as a save.
        const requestContext = buildAgentRequestContext({
          episodeId, dramaId,
          modelOverride: opts.model || undefined,
          textConfigId: opts.configId || undefined,
        })
        await agent.generate([{
          role: 'user',
          content: `请为分镜 #${sb.storyboardNumber}(ID:${sb.id})生成视频提示词(video_prompt)。视频模型:${videoLabel},请根据该模型的特性和时长限制生成。
请先调用 read_storyboard_context 获取该分镜的画面描述(含【镜头N】子镜头与台词/旁白)、氛围及时长。完整保留台词、旁白、说话人和顺序，中文按每秒 4 个汉字并另留标点与句间停顿、换人接话和必要动作/表演时间；其他语言按自然语速保守估时。video_prompt 第一行列出实际出场人物与场景，用 @角色名/@场景名/@道具名 引用参考素材；之后按自然语义、动作完成和切镜边界写可变时长时间行，从 0 连续覆盖到 duration，不重叠、不留空缺，不按固定秒数切块。保持 description 的【镜头N】顺序，段落内可以切镜但不跨场景；多个关键画面仍属于同一个格组，不要求每句台词或每次切镜新建格组。若完整对白预算超出现有 duration 或模型时长范围，不保存该条，报告分镜 ID、原时长、所需时长和完整语义拆分建议，不得删减台词解决。然后调用 update_storyboard 保存到分镜 ID:${sb.id}，参数只传 storyboard_id 和 video_prompt 两个键，不要回传其他字段，不要重新拆分整集。`,
        }], { maxSteps: 8, requestContext })
        // Require a successful prompt write from this request and validate the actual persisted row.
        const [fresh] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id))
        const receipt = getStoryboardPromptWriteReceipt(requestContext, sb.id)
        const persistedPrompt = (fresh?.videoPrompt || '').trim()
        if (!fresh || fresh.deletedAt || fresh.episodeId !== episodeId || !persistedPrompt
          || !receipt || receipt.videoPrompt !== fresh.videoPrompt || receipt.updatedAt !== fresh.updatedAt) {
          throw new Error('Agent 未保存本次有效视频提示词，已有提示词不计为生成成功')
        }
        if (!Number.isFinite(fresh.duration) || (fresh.duration || 0) <= 0) throw new Error('分镜时长无效')
        const message = productionBlockingMessage({ id: fresh.id, title: fresh.title || '分镜', description: fresh.description || '',
          videoPrompt: fresh.videoPrompt || '', durationMs: Math.round((fresh.duration || 0) * 1000) })
        if (message) throw new Error(message)
        task.completed++
      } catch (err: any) {
        task.failed++
        logTaskError('VideoPrompt', 'batch-shot', { storyboardId: sb.id, error: err?.message })
      }
    }
  })()
    .then(() => {
      task.status = 'done'
      task.finished_at = new Date().toISOString()
      task.current_storyboard_id = undefined
      logTaskSuccess('VideoPrompt', 'batch', { episodeId, total: task.total, completed: task.completed, failed: task.failed })
    })
    .catch((err: any) => {
      task.status = 'error'
      task.finished_at = new Date().toISOString()
      task.error = err?.message || '批量生成失败'
      logTaskError('VideoPrompt', 'batch', { episodeId, error: err?.message })
    })
  return { started: true, total: pending.length }
}

export function getVideoPromptBatchStatus(episodeId: number): VideoPromptBatchStatus | null {
  return tasks.get(episodeId) || null
}
