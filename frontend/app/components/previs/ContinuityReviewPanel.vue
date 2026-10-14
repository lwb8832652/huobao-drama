<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { previsRequest, type AnimaticVersion, type Timeline } from '~/composables/usePrevis'
import { continuityRisks, relevantContinuityEdges, evaluationTaskRow, type EvaluationTaskSettings, type ContinuityReviewStatus, type EvaluationTaskPage, type EvaluationTask, type EvaluationTaskFilter } from '~/composables/useContinuityReview'
import QueueSettingsButton from '../QueueSettingsButton.vue'
import EvaluationTaskList from './EvaluationTaskList.vue'
import ContinuityReviewDetail from './ContinuityReviewDetail.vue'

const props = defineProps<{
  version?: AnimaticVersion | null
  timeline?: Timeline | null
  panelIds?: number[]
  textModel?: { configId: number; model: string } | null
  save: () => Promise<boolean>
  dirty?: boolean
}>()
const settings = ref<EvaluationTaskSettings>({ revision: 0, concurrency: 1, paused: false, enabled: false, threshold: 70, globalTotal: 6, stats: { active: 0, pending: 0 } })
const concurrency = ref(1), paused = ref(false), settingsConflict = ref(false)
const threshold = ref(70), enabled = ref(false), settingsLoaded = ref(false)
const status = ref<ContinuityReviewStatus>({ settings: settings.value, items: [] })
const error = ref(''), busy = ref(false), savingSettings = ref(false)
const dialog = ref<HTMLDialogElement>(), confirming = ref(false)
const expanded = ref(false)
const view = ref<'tasks' | 'detail' | 'create' | 'settings'>('tasks')
const taskFilter = ref<EvaluationTaskFilter>('all'), keyword = ref('')
const statusError = ref(''), statusLoaded = ref(false), settingsMessage = ref('')
const taskMessage = ref('')
const newReviewGroupId = ref('')
const history = ref<EvaluationTaskPage>({ type: 'continuity', page: 1, pageSize: 20, total: 0, activeCount: 0, lowScore: 0, items: [] })
const page = ref(1), selectedId = ref<number | null>(null), historyLoading = ref(false), historyError = ref('')
const selectedRecord = ref<EvaluationTask | null>(null), detailError = ref(''), detailLoading = ref(false)
const selected = computed(() => selectedRecord.value?.id === selectedId.value ? selectedRecord.value : history.value.items.find(item => item.id === selectedId.value))
const taskRows = computed(() => history.value.items.map(item => evaluationTaskRow(item, settings.value.threshold)))
const settingsDirty = computed(() => enabled.value !== settings.value.enabled || threshold.value !== settings.value.threshold || concurrency.value !== settings.value.concurrency || paused.value !== settings.value.paused)
let historyToken = 0, detailToken = 0, settingsToken = 0, polling = false
let correctingPage = false
let searchTimer: ReturnType<typeof setTimeout> | undefined
function selectTask(item: EvaluationTask) { selectedRecord.value = item; selectedId.value = item.id; detailError.value = ''; view.value = 'detail'; if (expanded.value) void loadSelectedTask() }
function selectRow(key: string) { const item = history.value.items.find(item => String(item.id) === key); if (item) selectTask(item) }
const taskListScroll = ref(0)
function backToTasks() { view.value = 'tasks' }
function changeFilter(filter: EvaluationTaskFilter) {
  if (filter === taskFilter.value) return
  taskFilter.value = filter; selectedId.value = null
  if (page.value !== 1) page.value = 1
  else void loadHistory()
}
async function loadHistory() {
  const id = props.version?.id, token = ++historyToken
  if (!id) return
  historyLoading.value = true
  try {
    const query = `page=${page.value}&pageSize=20&status=${taskFilter.value}&keyword=${encodeURIComponent(keyword.value.trim())}`
    const result = await previsRequest<EvaluationTaskPage>(`/animatic-versions/${id}/continuity-review-tasks?${query}`)
    if (disposed || token !== historyToken || id !== props.version?.id) return
    history.value = result; historyError.value = ''
    if (view.value === 'detail' && selectedId.value !== null) await loadSelectedTask()
    if (disposed || token !== historyToken || id !== props.version?.id) return
    const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize))
    if (page.value > lastPage) {
      correctingPage = true
      try { page.value = lastPage } finally { correctingPage = false }
    }
  } catch (cause: any) { if (!disposed && token === historyToken) historyError.value = cause.message || '读取历史评测失败' }
  finally { if (token === historyToken) historyLoading.value = false }
}
async function loadSelectedTask() {
  const versionId = props.version?.id, taskId = selectedId.value, token = ++detailToken
  if (!versionId || taskId === null) return
  detailLoading.value = true
  try {
    const item = await previsRequest<EvaluationTask>(`/animatic-versions/${versionId}/continuity-review-tasks/${taskId}`)
    if (disposed || token !== detailToken || versionId !== props.version?.id || taskId !== selectedId.value) return
    selectedRecord.value = item; detailError.value = ''
  } catch (cause: any) {
    if (!disposed && token === detailToken && versionId === props.version?.id && taskId === selectedId.value) detailError.value = cause.message || '读取任务详情失败'
  } finally { if (token === detailToken) detailLoading.value = false }
}
const drawer = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>()
let originalBodyOverflow: string | undefined, lastTaskKey = ''
function closeDrawer() { expanded.value = false }
function trapDrawerFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const nodes = Array.from(drawer.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || []).filter(node => node.getClientRects().length)
  if (!nodes.length) return
  const first = nodes[0]!, last = nodes[nodes.length - 1]!
  if (!drawer.value?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
function handleDrawerKeys(event: KeyboardEvent) {
  if (!expanded.value || (typeof document !== 'undefined' && document.querySelector('dialog[open]'))) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDrawer() }
  else if (event.key === 'Tab') { trapDrawerFocus(event); if (event.defaultPrevented) event.stopPropagation() }
}
watch(expanded, async open => {
  if (typeof window !== 'undefined') {
    if (open) window.addEventListener('keydown', handleDrawerKeys, true)
    else window.removeEventListener('keydown', handleDrawerKeys, true)
  }
  if (open) {
    view.value = 'tasks'
    if (typeof document !== 'undefined') { originalBodyOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden' }
    void loadHistory(); void refresh().catch(() => {}); await nextTick(); drawer.value?.focus()
  } else {
    if (typeof document !== 'undefined' && originalBodyOverflow !== undefined) { document.body.style.overflow = originalBodyOverflow; originalBodyOverflow = undefined }
    trigger.value?.focus()
  }
})
watch(view, async (current, previous) => {
  if (!expanded.value || !drawer.value) return
  if (previous === 'tasks') {
    taskListScroll.value = drawer.value.querySelector('.evaluation-records')?.scrollTop || 0
    lastTaskKey = selectedId.value === null ? '' : String(selectedId.value)
  }
  await nextTick()
  if (current === 'tasks') {
    const list = drawer.value.querySelector('.evaluation-records'); if (list) list.scrollTop = taskListScroll.value
    const buttons = drawer.value.querySelectorAll<HTMLButtonElement>('.evaluation-task-row')
    const index = taskRows.value.findIndex(row => row.key === lastTaskKey)
    if (index >= 0) buttons[index]?.focus({ preventScroll: true }); else drawer.value.focus()
  } else drawer.value.querySelector<HTMLButtonElement>('.evaluation-back')?.focus()
})
watch(page, () => {
  // 自动缩页只更新返回列表的页码；用户翻页才离开已选详情。
  if (!correctingPage) { selectedId.value = null; if (view.value === 'detail') view.value = 'tasks'; taskListScroll.value = 0 }
  void loadHistory()
}, { flush: 'sync' })
watch(keyword, () => {
  ++historyToken; historyLoading.value = false; selectedId.value = null; clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { if (page.value !== 1) page.value = 1; else void loadHistory() }, 250)
})
const riskRows = ref<ReturnType<typeof continuityRisks>>([])
const visibleItems = computed(() => {
  const edges = props.timeline ? relevantContinuityEdges(props.timeline, props.panelIds) : []
  return status.value.items.filter(item => edges.some(edge => edge.from === item.fromGroupId && edge.to === item.toGroupId))
})
const stateNames = { cancelled: '已取消', idle: '未评测 / 已过期', missing_images: '缺少画面', pending: '排队中', processing: '评测中', completed: '已完成', failed: '失败' }
function groupTitle(id: string) { return props.timeline?.groups.find(group => group.id === id)?.title || id }
function disabledReason(toGroupId: string) {
  if (!props.version) return '请先加载当前版本'
  if (!statusLoaded.value || statusError.value) return statusError.value ? '状态查询失败，请刷新后再试' : '正在读取当前画面状态'
  const item = status.value.items.find(item => item.toGroupId === toGroupId)
  if (!item) return '这条镜头衔接已不存在'
  if (item.hasImages === false || item.status === 'missing_images') return '请先生成两侧的边界画面'
  if (item.status === 'pending' || item.status === 'processing') return '这条衔接已有评测正在进行'
  if (!props.textModel) return '请先选择支持视觉的文本模型'
  return ''
}
const retryDisabledReason = computed(() => {
  if (detailLoading.value) return '正在更新任务状态'
  if (detailError.value) return '详情查询失败，请刷新后再试'
  const item = selected.value
  if (!item) return '请选择评测任务'
  if (!item.current) return '画面已变化，请通过「发起评测」检查当前镜头'
  return disabledReason(item.toGroupId)
})
async function retrySelected() { if (selected.value && !retryDisabledReason.value) await score(selected.value.toGroupId) }
function openCreate() { view.value = 'create'; taskMessage.value = ''; newReviewGroupId.value = ''; void refresh().catch(() => {}) }
async function refreshAll() { await Promise.all([loadHistory(), refresh().catch(() => {})]) }
let disposed = false, loadToken = 0, resolveConfirmation: ((ok: boolean) => void) | undefined
function finish(ok = false) {
  const resolve = resolveConfirmation
  resolveConfirmation = undefined
  if (dialog.value?.open) dialog.value.close()
  resolve?.(ok)
}
function onDialogClose() {
  // close 事件异步派发；上一轮的事件不能取消已经重新打开的确认。
  if (!dialog.value?.open) finish(false)
}
async function refresh() {
  const id = props.version?.id, token = ++loadToken
  if (!id) return
  try {
    const result = await previsRequest<ContinuityReviewStatus>(`/animatic-versions/${id}/continuity-review-status`)
    if (disposed || id !== props.version?.id || token !== loadToken) return
    status.value = result
    statusLoaded.value = true; statusError.value = ''

  } catch (cause: any) {
    if (disposed || id !== props.version?.id || token !== loadToken) return
    statusError.value = cause.message || '读取当前状态失败'
    throw cause
  }
}
async function loadSettings(reload = true) {
  if (savingSettings.value) return
  const token = ++settingsToken
  try {
    const result = await previsRequest<EvaluationTaskSettings>('/settings/evaluation-tasks')
    if (disposed || token !== settingsToken) return
    if (!reload && (settingsDirty.value || settingsConflict.value)) { settings.value.stats = result.stats; settings.value.globalTotal = result.globalTotal; return }
    settings.value = result; threshold.value = result.threshold; enabled.value = result.enabled; concurrency.value = result.concurrency; paused.value = result.paused; settingsLoaded.value = true; settingsConflict.value = false; error.value = ''
  } catch (cause: any) { if (!disposed && token === settingsToken) error.value = cause.message || '读取评测设置失败' }
}
async function saveSettings() {
  if (savingSettings.value || !settingsLoaded.value || settingsConflict.value) return
  if (!Number.isInteger(concurrency.value) || concurrency.value < 1 || concurrency.value > 32) { error.value = '评测并发须为 1–32 的整数'; return }
  if (!Number.isInteger(threshold.value) || threshold.value < 0 || threshold.value > 100) { error.value = '阈值须在 0–100 之间'; return }
  ++settingsToken; savingSettings.value = true; error.value = ''; settingsMessage.value = ''
  try {
    const result = await previsRequest<EvaluationTaskSettings>('/settings/evaluation-tasks', 'PUT', { revision: settings.value.revision, concurrency: concurrency.value, paused: paused.value, enabled: enabled.value, threshold: threshold.value })
    if (disposed) return
    settings.value = result; enabled.value = result.enabled; threshold.value = result.threshold; concurrency.value = result.concurrency; paused.value = result.paused
    settingsMessage.value = '设置已保存'
    await refresh()
  } catch (cause: any) { settingsConflict.value = cause.status === 409; error.value = settingsConflict.value ? '评测任务设置已被其他页面修改。草稿已保留，请重新载入后再保存。' : cause.message || '保存评测设置失败' }
  finally { savingSettings.value = false; await nextTick(); if (expanded.value && view.value === 'settings' && typeof document !== 'undefined' && document.activeElement === document.body) drawer.value?.focus() }
}
async function score(toGroupId: string) {
  if (busy.value || confirming.value || disabledReason(toGroupId)) return
  const versionId = props.version!.id
  const model = props.textModel!
  const creating = view.value === 'create'
  busy.value = true; error.value = ''
  try {
    if (!await props.save() || !props.version || disposed) return
    if (props.version.id !== versionId) return
    await refresh()
    if (disposed || props.version?.id !== versionId || disabledReason(toGroupId)) return
    const result = await previsRequest<{ id: number }>(`/animatic-versions/${versionId}/continuity-reviews`, 'POST', {
      revision: props.version.revision, toGroupId, configId: model.configId, model: model.model, force: true,
    })
    if (disposed || props.version?.id !== versionId) return
    if (creating) { taskFilter.value = 'all'; keyword.value = ''; page.value = 1 }
    await Promise.all([refresh(), loadHistory()])
    taskMessage.value = `已加入队列 · #${result.id || ''}，可在任务列表查看进度`
    if (view.value === 'create') view.value = 'tasks'
  } catch (cause: any) { error.value = cause.message || '连续性评测失败' }
  finally { busy.value = false }
}
async function confirmGeneration(panelIds?: number[]) {
  if (confirming.value || disposed || busy.value) return false
  confirming.value = true; error.value = ''
  try {
    if (!await props.save() || !props.version || !props.timeline || disposed) return false
    const id = props.version.id, revision = props.version.revision
    let latest: ContinuityReviewStatus
    try {
      latest = await previsRequest<ContinuityReviewStatus>(`/animatic-versions/${id}/continuity-review-status`)
      if (disposed || props.version?.id !== id || props.version.revision !== revision) return false
      status.value = latest
      riskRows.value = continuityRisks(props.timeline, latest, panelIds)
    } catch (cause: any) {
      if (disposed) return false
      riskRows.value = [{ key: 'unavailable', title: '无法获取最新连续性风险', reasons: [cause.message || '评测服务不可用，请明确确认后继续'] }]
    }
    if (!riskRows.value.length) return true
    const answer = new Promise<boolean>(resolve => { resolveConfirmation = resolve })
    await nextTick()
    if (disposed || !dialog.value || props.version?.id !== id || props.version.revision !== revision) { finish(false); return false }
    try { dialog.value.showModal() }
    catch (cause) { finish(false); throw cause }
    const accepted = await answer
    return accepted && !disposed && props.version?.id === id && props.version.revision === revision && !props.dirty
  } catch (cause: any) { error.value = cause.message || '生成前检查失败'; return false }
  finally { confirming.value = false }
}
watch(() => props.version ? `${props.version.id}:${props.version.revision}` : '', (current, previous) => {
  const versionChanged = current.split(':')[0] !== (previous || '').split(':')[0]
  finish(false)
  status.value = { settings: settings.value, items: [] }
  statusLoaded.value = false; statusError.value = ''
  taskMessage.value = ''
  ++historyToken
  ++detailToken; detailError.value = ''; detailLoading.value = false
  if (versionChanged) {
    selectedRecord.value = null
    history.value = { type: 'continuity', page: 1, pageSize: 20, total: 0, activeCount: 0, lowScore: 0, items: [] }
    page.value = 1; selectedId.value = null
    if (view.value === 'detail') view.value = 'tasks'
  } else if (view.value === 'detail' && selectedId.value !== null) void loadSelectedTask()
  void loadHistory()
  void refresh().catch(() => {})
}, { immediate: true })
void loadSettings()
const timer = setInterval(async () => {
  if (disposed || busy.value || polling) return
  polling = true
  try { await Promise.all([loadHistory(), refresh(), ...(expanded.value && view.value === 'settings' ? [loadSettings(false)] : [])]) }
  catch { /* refresh 已记录有效上下文的异常；历史异常由 loadHistory 记录。 */ }
  finally { polling = false }
}, 4000)
onUnmounted(() => { if (typeof window !== 'undefined') window.removeEventListener('keydown', handleDrawerKeys, true); disposed = true; ++settingsToken; ++loadToken; ++historyToken; ++detailToken; clearTimeout(searchTimer); clearInterval(timer); finish(false); if (typeof document !== 'undefined' && originalBodyOverflow !== undefined) document.body.style.overflow = originalBodyOverflow })
defineExpose({ confirmGeneration, refresh })
</script>

<template>
  <section class="evaluation-entry" aria-label="连续性评测" data-testid="continuity-review-panel">
    <button type="button" ref="trigger" class="btn evaluation-trigger" data-testid="evaluation-trigger" aria-haspopup="dialog" :aria-expanded="expanded" :title="historyError ? '评测状态查询异常' : '查看评测任务'" @click="expanded = !expanded">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H5v16h14V5h-4M9 3h6v4H9zM8 12h8M8 16h5" /></svg>
      评测 <span v-if="history.activeCount" class="evaluation-badge" role="status" :aria-label="`${history.activeCount} 项评测排队或执行中`">{{ history.activeCount }}</span><span v-if="historyError" class="evaluation-query-error" aria-label="状态查询异常">!</span>
    </button>
    <Teleport to="body">
      <div v-if="expanded" class="evaluation-overlay" @click.self="closeDrawer" @keydown.esc.stop.prevent="closeDrawer">
        <aside ref="drawer" class="evaluation-drawer" :class="{ 'is-detail': view === 'detail' }" @keydown="trapDrawerFocus" role="dialog" aria-modal="true" aria-labelledby="evaluation-title" tabindex="-1">
          <header class="evaluation-head">
            <div class="evaluation-head-title"><button v-if="view !== 'tasks'" class="evaluation-back evaluation-icon-button" type="button" aria-label="返回评测任务列表" @click="backToTasks"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m14 6-6 6 6 6" /></svg></button><span v-else class="evaluation-head-icon"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V2h6v2M9 10h6m-6 4h6m-6 4h3" /></svg></span><div><h2 id="evaluation-title">{{ { tasks: '评测任务', detail: '任务详情', create: '发起评测', settings: '评测任务设置' }[view] }}</h2><p>{{ view === 'tasks' ? '查看评测进度与结果，点击任务查看详情' : view === 'settings' ? '全局设置 · 对所有项目生效' : view === 'create' ? '选择需要检查的镜头衔接' : '画面对比、评分与改进建议' }}</p></div></div>
            <div class="evaluation-head-actions"><template v-if="view === 'tasks'"><button class="evaluation-icon-button" type="button" :disabled="historyLoading" aria-label="刷新评测任务" title="刷新" @click="refreshAll"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" :class="{ spin: historyLoading }"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></svg></button><QueueSettingsButton label="评测任务设置" @click="view = 'settings'; settingsMessage = ''; loadSettings(false)" /><button class="evaluation-button primary evaluation-create" type="button" :disabled="!version" @click="openCreate"><span aria-hidden="true">+</span>发起评测</button></template><button type="button" class="evaluation-icon-button evaluation-close" aria-label="关闭评测抽屉" @click="closeDrawer"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
          </header>
          <p v-if="error" role="alert" class="evaluation-notice">{{ error }}</p>
          <p v-if="view === 'tasks' && taskMessage" role="status" class="evaluation-notice is-success">{{ taskMessage }}</p>
          <p v-if="view === 'detail' && detailError" role="alert" class="evaluation-notice">{{ detailError }} · 暂时显示上次读取的详情<button type="button" @click="loadSelectedTask">重新加载</button></p>
          <p v-if="dirty" class="evaluation-notice">有未保存的修改，发起评测和生成视频前会先保存并检查当前画面。</p>
          <EvaluationTaskList v-if="view === 'tasks'" :items="taskRows" :total="history.total" :summary="history.summary" :active-count="history.activeCount" :page="page" :page-size="history.pageSize" :filter="taskFilter" :keyword="keyword" :loading="historyLoading" :error="historyError" :can-create="!!version" @select="selectRow" @filter="changeFilter" @search="keyword = $event" @page="page = $event" @refresh="loadHistory" @create="openCreate" />
          <ContinuityReviewDetail v-else-if="view === 'detail' && selected" :key="selected.id" :item="selected" :threshold="settings.threshold" :retry-disabled-reason="retryDisabledReason" :busy="busy || confirming" @retry="retrySelected" @changed="refreshAll" />
          <div v-else-if="view === 'settings'" class="evaluation-form" data-testid="evaluation-settings">
            <div class="evaluation-form-intro"><span class="evaluation-type-chip">全局设置 · 对所有项目生效</span><h3>评测任务设置</h3><p>手动与自动评测共享并发。后台任务总并发 {{ settings.globalTotal }}（只读），在任务设置中调整；服务商配额组也可能约束评测。</p><p>全局评测执行 {{ settings.stats.byKind?.evaluation?.active ?? settings.stats.active }} / {{ settings.concurrency }} · 排队 {{ settings.stats.byKind?.evaluation?.pending ?? settings.stats.pending }}</p><p v-if="(settings.stats.byKind?.evaluation?.active ?? settings.stats.active) > settings.concurrency">等待已有任务完成</p></div>
            <p v-if="settingsConflict" class="evaluation-notice" role="alert">草稿已保留<button type="button" @click="loadSettings()">舍弃草稿并重新载入</button></p>
            <div class="evaluation-form-row"><div><label for="evaluation-concurrency">评测并发</label><p>评测开始时同时受总上限与配额组上限约束。</p></div><div class="evaluation-number"><input id="evaluation-concurrency" v-model.number="concurrency" type="number" min="1" max="32" step="1" :disabled="!settingsLoaded || savingSettings"></div></div>
            <div class="evaluation-form-row"><div><label for="evaluation-paused">暂停评测队列</label><p>暂停所有项目尚未开始的评测；执行中评测继续。</p></div><button id="evaluation-paused" type="button" role="switch" :aria-checked="paused" aria-label="暂停评测队列" :class="['evaluation-switch', { on: paused }]" :disabled="!settingsLoaded || savingSettings" @click="paused = !paused"><i /></button></div>
            <div class="evaluation-form-row"><div><label for="evaluation-enabled">自动评测</label><p>默认关闭，仅在画面更新后触发。</p></div><button id="evaluation-enabled" type="button" role="switch" :aria-checked="enabled" aria-label="自动评测" :class="['evaluation-switch', { on: enabled }]" :disabled="!settingsLoaded || savingSettings" @click="enabled = !enabled"><i /></button></div>
            <div class="evaluation-form-row"><div><label for="evaluation-threshold">关注阈值</label><p>当前结果低于此分数时标记为“需关注”。</p></div><div class="evaluation-number"><input id="evaluation-threshold" v-model.number="threshold" type="number" min="0" max="100" step="1" :disabled="!settingsLoaded || savingSettings"><span>/ 100</span></div></div>
            <div class="evaluation-form-info"><strong>模型与费用</strong><p>自动评测使用配置的视觉文本模型，会产生模型调用费用。不会自动修改画面。</p><p>这些设置对所有项目共享；浏览列表和查询状态不会触发模型调用。</p></div>
            <div class="evaluation-form-footer"><span v-if="!settingsLoaded" class="evaluation-form-muted">设置未载入<button type="button" class="evaluation-button" @click="loadSettings()">重新加载</button></span><span v-else-if="settingsMessage && !settingsDirty" class="evaluation-success" role="status">✓ {{ settingsMessage }}</span><span v-else-if="settingsDirty" class="evaluation-form-muted">设置尚未保存</span><span v-else class="evaluation-form-muted">当前设置已生效</span><button type="button" class="evaluation-button primary" :disabled="!settingsLoaded || savingSettings || !settingsDirty || settingsConflict" @click="saveSettings">{{ savingSettings ? '保存中…' : '保存设置' }}</button></div>
          </div>
          <div v-else-if="view === 'create'" class="evaluation-form evaluation-new" data-testid="evaluation-create-form">
            <div class="evaluation-form-intro"><span class="evaluation-type-chip">连续性评测</span><h3>检查前后镜头是否接得上</h3><p>对比前镜头的结束画面与后镜头的起始画面，检查人物、场景、动作和构图。</p></div>
            <p v-if="statusError" class="evaluation-notice" role="alert">{{ statusError }}<button type="button" @click="refreshAll">重新加载</button></p>
            <p v-if="!statusLoaded && !statusError" class="evaluation-form-muted" role="status">正在读取镜头衔接…</p>
            <fieldset v-else-if="visibleItems.length" class="evaluation-targets"><legend>选择镜头衔接 <small>{{ visibleItems.length }} 项</small></legend><label v-for="item in visibleItems" :key="`${item.fromGroupId}:${item.toGroupId}`" class="evaluation-target" :class="{ selected: newReviewGroupId === item.toGroupId, disabled: !!disabledReason(item.toGroupId) }"><input v-model="newReviewGroupId" type="radio" name="evaluation-target" :value="item.toGroupId" :disabled="!!disabledReason(item.toGroupId) || busy || confirming"><span><strong>{{ groupTitle(item.fromGroupId) }} → {{ groupTitle(item.toGroupId) }}</strong><small>{{ disabledReason(item.toGroupId) || (item.result ? `最近评分 ${item.result.overallScore} / 100` : '画面已就绪，可以开始评测') }}</small></span><em>{{ stateNames[item.status] }}</em></label></fieldset>
            <div v-else class="evaluation-form-empty"><strong>暂无可评测的镜头衔接</strong><p>请先规划相邻镜头，并生成两侧的边界画面。</p></div>
            <div class="evaluation-form-info"><strong>使用模型</strong><p>{{ textModel?.model || '请先选择支持视觉的文本模型' }}</p><p>每次开始会产生模型调用费用。内容会先保存，再对当前画面发起评测。</p></div>
            <div class="evaluation-form-footer"><span class="evaluation-form-muted">{{ newReviewGroupId ? disabledReason(newReviewGroupId) || '已选择 1 项衔接' : '请选择要评测的镜头衔接' }}</span><button type="button" class="evaluation-button primary" :disabled="!newReviewGroupId || busy || confirming || !!disabledReason(newReviewGroupId)" @click="score(newReviewGroupId)">{{ busy ? '正在提交…' : '加入评测队列' }}</button></div>
          </div>
          <slot />
        </aside>
      </div>
    </Teleport>
    <Teleport to="body"><dialog ref="dialog" class="review-dialog" aria-labelledby="continuity-risk-title" @cancel.prevent="finish(false)" @close="onDialogClose" @click="event => { if (event.target === dialog) finish(false) }">
      <h2 id="continuity-risk-title">生成视频前确认连续性风险</h2>
      <p>以下仅汇总本次生成目标相关的边界。你可以取消并检查画面，或明确继续生成；不会自动重绘。</p>
      <article v-for="risk in riskRows" :key="risk.key"><strong>{{ risk.title }}</strong><ul><li v-for="reason in risk.reasons" :key="reason">{{ reason }}</li></ul></article>
      <footer><button type="button" autofocus @click="finish(false)">取消生成</button><button type="button" class="btn btn-primary" @click="finish(true)">已了解风险，继续生成</button></footer>
    </dialog></Teleport>
  </section>
</template>

<style scoped>
.evaluation-entry { display: inline-flex; flex-shrink: 0; }
.evaluation-trigger { position: relative; gap: 6px; white-space: nowrap; }
.evaluation-trigger:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--button-focus); }
.evaluation-badge { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; background: var(--accent); color: var(--action-primary-text, #fff); font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; line-height: 1; font-variant-numeric: tabular-nums; }
.evaluation-query-error { color: var(--warning, #ad7839); }
.evaluation-overlay { position: fixed; inset: 0; z-index: 1200; background: var(--scrim, #15203338); backdrop-filter: blur(5px); display: flex; justify-content: flex-end; }
.evaluation-drawer { width: min(680px, 100vw); height: 100%; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--border, #e5e9f0); background: var(--surface-raised, #fff); color: var(--text-1, #536172); box-shadow: -12px 0 48px #14243b1a; font-size: 13px; animation: evaluation-in .2s ease-out; outline: 0; }
.evaluation-drawer.is-detail { width: min(980px, 100vw); }
.evaluation-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 20px 24px; border-bottom: 1px solid var(--border, #e7ebf1); flex-shrink: 0; }
.evaluation-head-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.evaluation-head-icon { display: grid; place-items: center; background: var(--accent-bg, #fff0e4); color: var(--accent-text, #d77d34); width: 38px; height: 38px; border-radius: 11px; flex-shrink: 0; }
.evaluation-head h2 { font-size: 17px; font-weight: 600; margin: 0 0 5px; color: var(--text-0, #2e3847); letter-spacing: -.2px; }
.evaluation-head p { margin: 0; font-size: 10px; line-height: 1.7; color: var(--text-3, #94a0af); }
.evaluation-head-actions { display: flex; align-items: center; gap: 7px; flex-shrink: 0; }
.evaluation-icon-button { border: 1px solid transparent; background: transparent; color: var(--text-2, #8b97a7); width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; cursor: pointer; flex-shrink: 0; }
.evaluation-icon-button:hover { background: var(--surface-soft, #f3f5f8); color: var(--text-0, #354253); }
.evaluation-icon-button:disabled { opacity: .4; cursor: not-allowed; }
.evaluation-close { margin-left: 4px; }
.evaluation-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid var(--border, #e5e9ef); border-radius: 8px; background: var(--surface-raised, #fff); color: var(--text-1, #5b6777); font: inherit; font-size: 12px; padding: 9px 14px; cursor: pointer; white-space: nowrap; }
.evaluation-button.primary { border-color: transparent; background: var(--accent, #f58b36); color: var(--action-primary-text, #fff); }
.evaluation-button:disabled { opacity: .45; cursor: not-allowed; }
.evaluation-create { padding: 8px 10px; font-size: 11px; }
.evaluation-create span { font-size: 16px; line-height: 1; }
.evaluation-notice { margin: 12px 24px 0; padding: 10px 13px; background: var(--warning-bg, #fff7ee); color: var(--warning, #ae7d42); border-radius: 8px; font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; }
.evaluation-notice button { border: 0; color: inherit; background: transparent; text-decoration: underline; font: inherit; cursor: pointer; margin-left: 7px; }
.evaluation-notice.is-success { background: var(--success-bg, #eef7f1); color: var(--success, #459471); }
.evaluation-form { padding: 26px 28px; overflow-y: auto; flex: 1; min-height: 0; }
.evaluation-form-intro { margin-bottom: 25px; }
.evaluation-type-chip { display: inline-block; padding: 4px 7px; border-radius: 5px; background: var(--accent-bg, #fff2e7); color: var(--accent-text, #cf7e37); font-size: 10px; }
.evaluation-form-intro h3 { font-size: 18px; font-weight: 600; margin: 15px 0 9px; color: var(--text-0, #354252); }
.evaluation-form p { font-size: 12px; color: var(--text-2, #8290a0); line-height: 1.9; margin: 4px 0; }
.evaluation-form-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 22px 0; border-bottom: 1px solid var(--border, #e7ebf2); }
.evaluation-form-row label { font-size: 13px; font-weight: 500; color: var(--text-1, #546475); }
.evaluation-form-row p { margin-top: 6px; font-size: 11px; }
.evaluation-switch { width: 38px; height: 22px; border-radius: 20px; border: 0; background: var(--border-strong, #dde3eb); cursor: pointer; position: relative; flex-shrink: 0; }
.evaluation-switch.on { background: var(--accent, #f58b36); }
.evaluation-switch i { width: 16px; height: 16px; position: absolute; top: 3px; left: 3px; background: #fff; border-radius: 50%; box-shadow: 0 1px 3px #0001; transition: transform .15s; }
.evaluation-switch.on i { transform: translateX(16px); }
.evaluation-switch:disabled { opacity: .4; cursor: not-allowed; }
.evaluation-number { display: flex; align-items: center; gap: 9px; color: var(--text-3, #9ba7b4); font-size: 11px; flex-shrink: 0; }
.evaluation-number input { width: 68px; padding: 9px 8px; border: 1px solid var(--border, #dfe5ed); border-radius: 8px; background: var(--surface-input, #fafbfc); color: var(--text-1, #677789); font: inherit; font-size: 13px; }
.evaluation-form-info { margin-top: 25px; padding: 15px 17px; background: var(--surface-soft, #f8fafc); border: 1px solid var(--border, #e6ebf2); border-radius: 10px; }
.evaluation-form-info strong { font-size: 11px; font-weight: 600; color: var(--text-2, #7e8d9e); }
.evaluation-form-info p { font-size: 11px; margin: 7px 0 0; }
.evaluation-form-footer { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-top: 26px; }
.evaluation-form-muted { color: var(--text-3, #95a1b0); font-size: 11px; }
.evaluation-success { color: var(--success, #479674); font-size: 11px; }
.evaluation-targets { margin: 22px 0 0; border: 0; padding: 0; min-width: 0; }
.evaluation-targets legend { margin-bottom: 14px; width: 100%; display: flex; justify-content: space-between; gap: 10px; font-size: 12px; color: var(--text-2, #7a899b); }
.evaluation-targets legend small { font-size: 10px; color: var(--text-3, #9aa6b6); }
.evaluation-target { display: flex; align-items: center; gap: 12px; padding: 15px 12px; border: 1px solid var(--border, #e5ebf2); border-radius: 9px; margin-bottom: 9px; cursor: pointer; }
.evaluation-target.selected { border-color: color-mix(in srgb, var(--accent, #f58b36) 45%, var(--border, #e6eaf0)); background: var(--accent-bg, #fff4eb); }
.evaluation-target.disabled { background: var(--surface-soft, #fafbfc); cursor: not-allowed; }
.evaluation-target input { accent-color: var(--accent, #f58b36); margin: 0; }
.evaluation-target > span { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.evaluation-target strong { font-size: 12px; font-weight: 500; color: var(--text-1, #526173); overflow-wrap: anywhere; }
.evaluation-target small { font-size: 10px; color: var(--text-3, #95a2b2); }
.evaluation-target em { font-size: 10px; color: var(--text-3, #97a4b3); font-style: normal; white-space: nowrap; }
.evaluation-form-empty { padding: 40px 20px; text-align: center; border: 1px dashed var(--border, #e1e8f1); border-radius: 10px; }
.evaluation-form-empty strong { font-size: 13px; font-weight: 500; color: var(--text-2, #8491a2); }
.evaluation-form-empty p { font-size: 11px; margin-top: 12px; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent, #f58b36); outline-offset: 3px; }
.review-dialog { margin: auto; width: min(560px, calc(100vw - 40px)); max-height: 80vh; overflow: auto; padding: 24px; border: 1px solid var(--border, #d9dde3); border-radius: 12px; background: var(--surface-raised, #fff); color: var(--text-0, #20242b); box-shadow: var(--shadow-elevated, 0 16px 48px #0003); }
.review-dialog::backdrop { background: #0008; }
.review-dialog h2 { font-size: 18px; margin-top: 0; }
.review-dialog p { font-size: 12px; color: var(--text-2, #7e8d9e); line-height: 1.8; }
.review-dialog article { margin: 12px 0; padding: 12px; background: var(--surface-soft, #f8fafc); border-radius: 8px; }
.review-dialog article strong { font-size: 13px; }
.review-dialog ul { padding-left: 18px; font-size: 12px; line-height: 1.8; }
.review-dialog footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
.review-dialog footer button { font: inherit; padding: 9px 13px; border: 1px solid var(--border, #e5e9ef); border-radius: 8px; background: var(--surface-soft, #f7f9fc); color: var(--text-1, #536273); cursor: pointer; font-size: 12px; }
.review-dialog footer button.btn-primary { background: var(--accent, #f58b36); border-color: transparent; color: var(--action-primary-text, #fff); }
.spin { animation: evaluation-spin 1.3s linear infinite; }
@keyframes evaluation-in { from { transform: translateX(18px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
@keyframes evaluation-spin { to { transform: rotate(360deg); } }
@media (max-width: 600px) { .evaluation-head { padding: 16px; gap: 10px; }.evaluation-head-icon { display: none; }.evaluation-head p { max-width: 190px; }.evaluation-head-actions { gap: 3px; }.evaluation-create { padding: 8px; font-size: 10px; }.evaluation-form { padding: 22px 18px; }.evaluation-form-row { gap: 15px; }.evaluation-notice { margin-left: 16px; margin-right: 16px; } }
@media (max-width: 420px) { .evaluation-head p { display: none; }.evaluation-head h2 { font-size: 15px; margin: 0; }.evaluation-head-actions { gap: 0; } }
@media (prefers-reduced-motion: reduce) { .evaluation-drawer, .spin { animation: none; }.evaluation-switch i { transition: none; } }
</style>
