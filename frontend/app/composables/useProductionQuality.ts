import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { previsRequest, type AnimaticVersion } from './usePrevis'
import type { QueueMetadata } from './useTaskQueue'
import type { QualityResult, QualityEdit } from '../../../backend/src/services/production-quality-domain'
import type { ProductionSegment } from '../../../backend/src/services/shot-planning'

export type { QualityResult }
export interface QualityPreview {
  beforeDurationMs: number
  afterDurationMs: number
  extraGenerations: number
  proposals: { panelId: number; title: string; beforeDurationMs: number; afterDurationMs: number; beforeVideoUrl?: string; retainedFrames: number; error: string | null; segments: ProductionSegment[] }[]
}
export interface QualityOptimization { summary: string; edits: QualityEdit[]; preview: QualityPreview }
export interface QualityTask extends QueueMetadata {
  id: number
  type: 'planning'
  versionId: number
  kind: 'rules' | 'review' | 'optimization'
  parentId: number | null
  round: number
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'
  current: boolean
  inputHash: string
  result: QualityResult | QualityOptimization | null
  error: string | null
  configId: number
  model: string
  appliedVersionId: number | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}
export interface ProductionQualityState { inputHash: string; rules: QualityResult; task: QualityTask | null; latest: QualityTask | null }
export function qualityReport(task?: QualityTask | null): QualityResult | null {
  return task?.result && task.kind !== 'optimization' ? task.result as QualityResult : null
}
export function qualityCandidate(task?: QualityTask | null): QualityOptimization | null {
  return task?.result && task.kind === 'optimization' ? task.result as QualityOptimization : null
}

/** Reads are free. Model requests are only submitted by explicit review/optimize actions. */
export function useProductionQuality(options: {
  version: () => AnimaticVersion | null | undefined
  save: () => Promise<boolean>
  dirty: () => boolean | undefined
  busy: () => boolean | undefined
  model: () => { configId: number; model: string } | null | undefined
  applied: (version: AnimaticVersion) => Promise<void | boolean> | void | boolean
}) {
  const state = ref<ProductionQualityState | null>(null), loading = ref(false), busy = ref(false), error = ref('')
  let disposed = false, readToken = 0, actionToken = 0, loadedIdentity = ''
  const identity = () => JSON.stringify([options.version()?.id, options.version()?.revision, options.version()?.timeline])
  const editable = () => !!options.version() && options.version()!.status !== 'locked' && options.version()!.isCurrent !== false && !options.version()!.busy && !options.busy()
  const fresh = (task: QualityTask) => !disposed && editable() && !options.dirty() && loadedIdentity === identity()
    && task.current && task.versionId === options.version()?.id && task.inputHash === state.value?.inputHash
  const summary = computed(() => {
    if (error.value && !state.value) return '读取失败'
    if (!state.value) return '读取中…'
    if (loadedIdentity !== identity() || options.dirty()) return '待重新检查'
    const active = [state.value.task, state.value.latest].some(task => task?.current && ['pending', 'processing'].includes(task.status))
    if (active) return '评测中'
    const issues = qualityReport(state.value.task)?.issues || state.value.rules.issues
    return issues.length ? `${issues.length} 项待处理` : '已通过'
  })
  async function refresh() {
    const id = options.version()?.id, snapshot = identity(), token = ++readToken
    if (!id || disposed) return
    loading.value = true
    try {
      const result = await previsRequest<ProductionQualityState>(`/animatic-versions/${id}/production-quality`)
      if (disposed || token !== readToken || snapshot !== identity()) return
      state.value = result; loadedIdentity = snapshot; error.value = ''
    } catch (cause: any) { if (!disposed && token === readToken && snapshot === identity()) error.value = cause.message || '读取分镜质检失败' }
    finally { if (token === readToken) loading.value = false }
  }
  async function submit(kind: 'check' | 'reviews') {
    if (disposed || busy.value || !editable() || (kind === 'reviews' && !options.model())) return null
    const id = options.version()!.id, token = ++actionToken
    busy.value = true; error.value = ''
    try {
      if (!await options.save()) throw new Error('保存未完成，请先保存后重新检查。')
      await nextTick()
      if (disposed || token !== actionToken || id !== options.version()?.id || !editable() || options.dirty()) return null
      const snapshot = identity(), revision = options.version()!.revision
      const result = await previsRequest<QualityTask | { task: QualityTask }>(`/animatic-versions/${id}/production-quality/${kind}`, 'POST',
        { revision, ...(kind === 'check' ? { ai: false } : options.model()!) })
      if (disposed || token !== actionToken || snapshot !== identity()) return null
      await refresh()
      return 'task' in result ? result.task : result
    } catch (cause: any) { if (!disposed && token === actionToken && id === options.version()?.id) error.value = cause.message || '提交质检失败'; return null }
    finally { if (token === actionToken) busy.value = false }
  }
  function optimizeReason(task: QualityTask) {
    if (busy.value) return '正在提交，请稍候'
    if (!fresh(task)) return '内容已变化，请保存后重新检查当前分镜'
    if (task.id !== state.value?.task?.id || task.kind === 'optimization' || task.status !== 'completed') return '请选择当前已完成的评测报告'
    if (task.round >= 2) return '已完成两轮优化，请人工核对后重新规划'
    if (!options.model()) return '请先选择文本模型'
    return ''
  }
  async function optimize(task: QualityTask, issueIds: string[]) {
    if (optimizeReason(task) || !issueIds.length || new Set(issueIds).size !== issueIds.length || issueIds.some(id => !qualityReport(task)?.issues.some(issue => issue.id === id))) return null
    const token = ++actionToken, snapshot = identity()
    busy.value = true; error.value = ''
    try {
      const result = await previsRequest<QualityTask>(`/animatic-versions/${task.versionId}/production-quality/tasks/${task.id}/optimize`, 'POST', { inputHash: task.inputHash, issueIds, ...options.model()! })
      if (disposed || token !== actionToken || snapshot !== identity()) return null
      await refresh(); return result
    } catch (cause: any) { if (!disposed && token === actionToken && snapshot === identity()) error.value = cause.message || '创建优化候选失败'; return null }
    finally { if (token === actionToken) busy.value = false }
  }
  function applyReason(task: QualityTask) {
    if (busy.value) return '正在应用，请稍候'
    if (!fresh(task)) return '候选已过期，请重新检查并生成优化候选'
    if (task.appliedVersionId) return '此候选已应用'
    const preview = qualityCandidate(task)?.preview
    if (task.status !== 'completed' || !preview?.proposals.length || preview.proposals.some(proposal => proposal.error || !proposal.segments.length)) return '候选尚未准备好或存在规划错误'
    return ''
  }
  async function apply(task: QualityTask, confirmed = false) {
    if (!confirmed || applyReason(task)) return false
    const token = ++actionToken, snapshot = identity()
    busy.value = true; error.value = ''
    try {
      const adopted = await previsRequest<AnimaticVersion>(`/animatic-versions/${task.versionId}/production-quality/tasks/${task.id}/apply`, 'POST', { inputHash: task.inputHash })
      const alreadyAccepted = options.version()?.id === adopted.id && options.version()?.revision === adopted.revision && JSON.stringify(options.version()?.timeline) === JSON.stringify(adopted.timeline)
      if (disposed || token !== actionToken || (snapshot !== identity() && !alreadyAccepted) || options.dirty()) return false
      if (await options.applied(adopted) === false) throw new Error('候选已在服务端应用，但尚未加载新工作版，请保存当前修改后刷新。')
      await refresh()
      return true
    } catch (cause: any) { if (!disposed && token === actionToken) error.value = cause.message || '应用候选失败'; return false }
    finally { if (token === actionToken) busy.value = false }
  }
  watch(() => `${options.version()?.id}:${options.version()?.revision}`, (current, previous) => {
    ++readToken; loading.value = false
    if (current.split(':')[0] !== previous?.split(':')[0]) { state.value = null; loadedIdentity = ''; error.value = '' }
    void refresh()
  }, { immediate: true })
  onUnmounted(() => { disposed = true; ++readToken; ++actionToken })
  return { state, loading, busy, error, summary, refresh, check: () => submit('check'), review: () => submit('reviews'), optimizeReason, optimize, applyReason, apply }
}
