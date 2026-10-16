import { queueStatusLabel, type QueueMetadata, type QueueStats } from './useTaskQueue'
import type { Timeline, ContinuityReviewResult } from './usePrevis'
import type { QualityTask, QualityResult } from './useProductionQuality'

export type EvaluationType = 'continuity' | 'planning'
export interface EvaluationTask extends QueueMetadata {
  id: number
  type: 'continuity'
  versionId: number
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  current: boolean
  inputHash: string
  result: ContinuityReviewResult | null
  error: string | null
  configId: number
  model: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  fromGroupId: string
  toGroupId: string
  fromGroupTitle: string | null
  toGroupTitle: string | null
  images: { from: string | null; to: string | null }
}
export type AnyEvaluationTask = EvaluationTask | QualityTask
export interface EvaluationTaskPage {
  type: EvaluationType | 'all'
  page: number
  pageSize: number
  total: number
  activeCount: number
  lowScore: number
  items: AnyEvaluationTask[]
  summary?: { total: number; active: number; completed: number; failed: number; pending?: number; processing?: number }
}
/** 不依赖连续性输入/评分结构的列表展示契约，可供其他评测类型复用。 */
export interface EvaluationListItem extends QueueMetadata {
  key: string
  typeLabel: string
  title: string
  status: EvaluationTask['status']
  summary: string
  meta: string
  preview: string | null
  score?: number
  current: boolean
  attention: boolean
}
export type EvaluationTaskFilter = 'all' | 'active' | 'completed' | 'failed'
export type EvaluationTypeFilter = 'all' | EvaluationType
export function evaluationTaskRow(item: AnyEvaluationTask, threshold: number): EvaluationListItem {
  const time = item.createdAt ? new Date(item.createdAt) : null
  const formattedTime = time && !Number.isNaN(time.getTime()) ? time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
  const planning = item.type === 'planning'
  const result = item.result
  const score = result && 'overallScore' in result ? result.overallScore ?? undefined : undefined
  return {
    key: `${item.type}:${item.id}`, typeLabel: planning ? '分镜规划质量' : '连续性',
    title: planning ? item.kind === 'optimization' ? `AI 优化候选 · 第 ${item.round} 轮` : item.kind === 'rules' ? '分镜规划质量 · 规则检查' : '分镜规划质量 · AI 评测' : `${item.fromGroupTitle || item.fromGroupId || '前镜头'} → ${item.toGroupTitle || item.toGroupId || '后镜头'}`,
    queueJobId: item.queueJobId, phase: item.phase, queueReason: item.queueReason, canCancel: item.canCancel, canRetry: item.canRetry,
    status: item.status, summary: item.queueReason || item.error || item.result?.summary || (item.status === 'completed' ? '未提供摘要' : queueStatusLabel(item)),
    meta: [planning && item.kind === 'rules' ? '免费规则检查' : item.model || '等待分配模型', formattedTime, `#${item.id}`].filter(Boolean).join(' · '),
    preview: planning ? null : item.images.from || item.images.to, score,
    current: item.current, attention: !!result && ((score !== undefined && score < threshold) || ('confidence' in result && result.confidence === 'low') || (planning && 'issues' in result && (result as QualityResult).issues.length > 0)),
  }
}
export interface ContinuityReviewSettings { enabled: boolean; threshold: number }
export interface EvaluationTaskSettings extends ContinuityReviewSettings { revision: number; concurrency: number; paused: boolean; globalTotal: number; stats: QueueStats }
export interface ContinuityReviewStatusItem {
  id: number | null
  fromGroupId: string
  toGroupId: string
  inputHash: string
  hasImages?: boolean
  status: 'idle' | 'missing_images' | 'pending' | 'processing' | 'completed' | 'failed'
  result: ContinuityReviewResult | null
  error: string | null
  lowScore: boolean
}
export interface ContinuityReviewStatus {
  settings: ContinuityReviewSettings
  items: ContinuityReviewStatusItem[]
}
export function relevantContinuityEdges(timeline: Timeline, panelIds?: number[]) {
  if (!panelIds?.length) return timeline.transitions
  const selected = new Set(panelIds)
  return timeline.transitions.filter(edge => {
    const from = timeline.groups.find(g => g.id === edge.from)
    const to = timeline.groups.find(g => g.id === edge.to)
    return (from && selected.has(from.panelIds.at(-1)!)) || (to && selected.has(to.panelIds[0]!))
  })
}
export function continuityRisks(timeline: Timeline, status: ContinuityReviewStatus, panelIds?: number[]) {
  return relevantContinuityEdges(timeline, panelIds).flatMap(edge => {
    const item = status.items.find(i => i.fromGroupId === edge.from && i.toGroupId === edge.to)
    const reasons: string[] = []
    if (!item || item.status === 'idle') reasons.push('未评测或评测已过期')
    else if (item.status === 'missing_images') reasons.push('缺少边界画面，尚未评测')
    else if (item.status === 'failed') reasons.push(`评测失败${item.error ? `：${item.error}` : ''}`)
    else if (item.status === 'pending' || item.status === 'processing') reasons.push('评测进行中')
    else if (!item.result) reasons.push('尚无有效评测结果')
    if (item?.result) {
      if (item.lowScore || item.result.overallScore < status.settings.threshold) reasons.push(`低分 ${item.result.overallScore} / 100（阈值 ${status.settings.threshold}）`)
      if (item.result.confidence === 'low') reasons.push('低置信度')
    }
    const name = (id: string) => timeline.groups.find(g => g.id === id)?.title || id
    return reasons.length ? [{ key: `${edge.from}:${edge.to}`, title: `${name(edge.from)} → ${name(edge.to)}`, reasons }] : []
  })
}
