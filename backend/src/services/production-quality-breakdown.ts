import { getStoryboardBreakdownReceipt, setStoryboardCorrectionMode } from '../agents/tools/storyboard-tools.js'
import { initialTimeline, episodeForPrevis, getWorkspace, PrevisError } from './previs.js'
import { evaluateProductionRules, type QualityIssue } from './production-quality-domain.js'
import { checkProductionQuality } from './production-quality.js'

type Options = { configId?: number; model?: string }
async function inspect(episodeId: number) {
  const episode = (await episodeForPrevis(episodeId)), timeline = (await initialTimeline(episodeId))
  const input = { script: episode.scriptContent || episode.content || '', panels: timeline.panels }
  const rules = evaluateProductionRules(input)
  const missingIds = new Set(input.panels.filter(p => !p.videoPrompt.trim()).map(p => p.id))
  // Missing prompts are supplemented by the existing batch. Do not ask a second
  // agent to repair their absence while the first batch is still pending.
  const actionable = rules.issues.filter(issue => issue.severity === 'fail'
    && !(issue.panelIds.length && issue.panelIds.every(id => missingIds.has(id)) && /^(dialogue_missing|dialogue_mismatch|prompt_)/.test(issue.rule)))
  return { rules, actionable, missingPrompts: missingIds.size, panelIds: input.panels.map(p => p.id) }
}

/** Called after breakdown or after the entire prompt batch settles. */
export async function finalizeEpisodeQuality(episodeId: number, options: Options = {}) {
  const state = (await inspect(episodeId)), version = (await getWorkspace(episodeId))
  const report = await checkProductionQuality(version.id, { ai: !state.missingPrompts, source: 'automatic', ...options })
  return {
    status: state.actionable.length ? 'needs_attention' as const : state.missingPrompts ? 'awaiting_prompts' as const : 'passed' as const,
    issueCount: state.actionable.length, missingPrompts: state.missingPrompts,
    taskId: report.task.id, versionId: version.id, aiTaskId: report.aiTask?.id, aiError: report.aiError,
  }
}

/** At most one bounded correction, then persist honest results for human review. */
export async function finishStoryboardBreakdown(episodeId: number, options: Options & {
  requestContext: object
  repair?: (issues: QualityIssue[]) => Promise<unknown>
}) {
  let state = (await inspect(episodeId))
  if (!getStoryboardBreakdownReceipt(options.requestContext).some(id => state.panelIds.includes(id))) {
    throw new PrevisError('Agent 未保存本次分镜，拆分未完成；请重试或更换文本模型')
  }
  let correctionAttempts = 0, correctionError: string | undefined
  if (state.actionable.length && options.repair) {
    correctionAttempts = 1
    setStoryboardCorrectionMode(options.requestContext, true)
    try { await options.repair(state.actionable) }
    catch (error: any) { correctionError = error.message || '自动纠错未完成' }
    finally { setStoryboardCorrectionMode(options.requestContext, false) }
  }
  const result = await finalizeEpisodeQuality(episodeId, options)
  return { ...result, correctionAttempts, correctionError }
}
