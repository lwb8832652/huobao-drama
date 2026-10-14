<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { previsRequest, type AnimaticVersion, type Timeline } from '~/composables/usePrevis'
import { continuityRisks, relevantContinuityEdges, type ContinuityReviewSettings, type ContinuityReviewStatus, type EvaluationTaskPage, type EvaluationTask } from '~/composables/useContinuityReview'

const props = defineProps<{
  version?: AnimaticVersion | null
  timeline?: Timeline | null
  panelIds?: number[]
  textModel?: { configId: number; model: string } | null
  save: () => Promise<boolean>
  dirty?: boolean
}>()
const settings = ref<ContinuityReviewSettings>({ enabled: false, threshold: 70 })
const threshold = ref(70), enabled = ref(false), settingsLoaded = ref(false)
const status = ref<ContinuityReviewStatus>({ settings: settings.value, items: [] })
const error = ref(''), busy = ref(false), savingSettings = ref(false)
const dialog = ref<HTMLDialogElement>(), confirming = ref(false)
const expanded = ref(false)
const history = ref<EvaluationTaskPage>({ type: 'continuity', page: 1, pageSize: 20, total: 0, activeCount: 0, lowScore: 0, items: [] })
const page = ref(1), selectedId = ref<number | null>(null), historyLoading = ref(false), historyError = ref('')
const selected = computed(() => history.value.items.find(item => item.id === selectedId.value))
const dimensionNames = { subject: '人物与道具', scene: '场景与光线', action: '动作与视线', camera: '构图与机位' }
let historyToken = 0, polling = false
function selectTask(item: EvaluationTask) { selectedId.value = selectedId.value === item.id ? null : item.id }
async function loadHistory() {
  const id = props.version?.id, token = ++historyToken
  if (!id) return
  historyLoading.value = true
  try {
    const result = await previsRequest<EvaluationTaskPage>(`/animatic-versions/${id}/continuity-review-tasks?page=${page.value}&pageSize=20`)
    if (disposed || token !== historyToken || id !== props.version?.id) return
    history.value = result; historyError.value = ''
  } catch (cause: any) { if (!disposed && token === historyToken) historyError.value = cause.message || '读取历史评测失败' }
  finally { if (token === historyToken) historyLoading.value = false }
}
const drawer = ref<HTMLElement>(), trigger = ref<HTMLButtonElement>()
function closeDrawer() { expanded.value = false }
function trapDrawerFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const nodes = drawer.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]')
  if (!nodes?.length) return
  const first = nodes[0]!, last = nodes[nodes.length - 1]!
  if (event.shiftKey && (document.activeElement === first || document.activeElement === drawer.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
watch(expanded, async open => {
  if (open) { void loadHistory(); await nextTick(); drawer.value?.focus() }
  else trigger.value?.focus()
})
watch(page, () => { selectedId.value = null; void loadHistory() })
const riskRows = ref<ReturnType<typeof continuityRisks>>([])
const risks = computed(() => props.timeline ? continuityRisks(props.timeline, status.value, props.panelIds) : [])
const visibleItems = computed(() => {
  const edges = props.timeline ? relevantContinuityEdges(props.timeline, props.panelIds) : []
  return status.value.items.filter(item => edges.some(edge => edge.from === item.fromGroupId && edge.to === item.toGroupId))
})
const stateNames = { idle: '未评测 / 已过期', missing_images: '缺少画面', pending: '排队中', processing: '评测中', completed: '已完成', failed: '失败' }
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
  const result = await previsRequest<ContinuityReviewStatus>(`/animatic-versions/${id}/continuity-review-status`)
  if (disposed || id !== props.version?.id || token !== loadToken) return
  status.value = result
  settings.value = result.settings
  error.value = ''
}
async function loadSettings() {
  try {
    const result = await previsRequest<ContinuityReviewSettings>('/previs/continuity-review-settings')
    if (disposed) return
    settings.value = result; threshold.value = result.threshold; enabled.value = result.enabled; settingsLoaded.value = true
  } catch (cause: any) { error.value = cause.message || '读取评测设置失败' }
}
async function saveSettings() {
  if (savingSettings.value || !settingsLoaded.value) return
  if (!Number.isInteger(threshold.value) || threshold.value < 0 || threshold.value > 100) { error.value = '阈值须在 0–100 之间'; return }
  savingSettings.value = true; error.value = ''
  try {
    const result = await previsRequest<ContinuityReviewSettings>('/previs/continuity-review-settings', 'PUT', { enabled: enabled.value, threshold: threshold.value })
    if (disposed) return
    settings.value = result; enabled.value = result.enabled; threshold.value = result.threshold
    await refresh()
  } catch (cause: any) { error.value = cause.message || '保存评测设置失败' }
  finally { savingSettings.value = false }
}
async function score(toGroupId: string) {
  if (busy.value || confirming.value || !props.textModel) return
  busy.value = true; error.value = ''
  try {
    if (!await props.save() || !props.version || disposed) return
    await previsRequest(`/animatic-versions/${props.version.id}/continuity-reviews`, 'POST', {
      revision: props.version.revision, toGroupId, configId: props.textModel.configId, model: props.textModel.model, force: true,
    })
    await Promise.all([refresh(), loadHistory()])
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
      status.value = latest; settings.value = latest.settings
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
watch(() => [props.version?.id, props.version?.revision], () => {
  finish(false)
  status.value = { settings: settings.value, items: [] }
  ++historyToken
  history.value = { type: 'continuity', page: 1, pageSize: 20, total: 0, activeCount: 0, lowScore: 0, items: [] }
  page.value = 1; selectedId.value = null
  void loadHistory()
  void refresh().catch((cause: any) => { if (!disposed) error.value = cause.message })
}, { immediate: true })
void loadSettings()
const timer = setInterval(async () => {
  if (disposed || busy.value || polling) return
  polling = true
  try { await Promise.all([loadHistory(), refresh()]) }
  catch (cause: any) { if (!disposed) error.value = cause.message }
  finally { polling = false }
}, 4000)
onUnmounted(() => { disposed = true; ++loadToken; clearInterval(timer); finish(false) })
defineExpose({ confirmGeneration, refresh })
</script>

<template>
  <section class="evaluation-entry" aria-label="连续性评测" data-testid="continuity-review-panel">
    <button type="button" ref="trigger" class="btn evaluation-trigger" data-testid="evaluation-trigger" aria-haspopup="dialog" :aria-expanded="expanded" :title="historyError ? '评测状态查询异常' : '查看历史评测与设置'" @click="expanded = !expanded">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 5H5v16h14V5h-4M9 3h6v4H9zM8 12h8M8 16h5" /></svg>
      评测 <span v-if="history.activeCount" class="evaluation-badge" role="status" :aria-label="`${history.activeCount} 项评测排队或执行中`">{{ history.activeCount }}</span><span v-if="historyError" class="evaluation-query-error" aria-label="状态查询异常">!</span>
    </button>
    <Teleport to="body">
    <div v-if="expanded" class="evaluation-overlay" @click.self="closeDrawer" @keydown.esc.stop="closeDrawer">
    <aside ref="drawer" class="evaluation-drawer" @keydown="trapDrawerFocus" role="dialog" aria-modal="true" aria-labelledby="evaluation-title" tabindex="-1">
      <header class="evaluation-head"><div><small>QUALITY REVIEW</small><h2 id="evaluation-title">历史评测</h2><p>连续性 · {{ history.total }} 条记录 · {{ history.activeCount }} 项进行中</p></div><button type="button" class="btn btn-ghost" aria-label="关闭评测抽屉" @click="closeDrawer">关闭</button></header>
      <div class="evaluation-scroll">
    <details class="evaluation-settings">
      <summary>自动评测与告警设置 · {{ settings.enabled ? '已开启' : '已关闭' }} · 阈值 {{ settings.threshold }}</summary>
      <label><input v-model="enabled" type="checkbox" :disabled="!settingsLoaded || savingSettings">自动评测（默认关闭）</label>
      <p>开启后会调用当前文本模型并产生费用，模型须支持视觉。轮询仅查询状态，不触发 AI；不会自动重绘画面。</p>
      <label>低分阈值 <input v-model.number="threshold" type="number" min="0" max="100" step="1" :disabled="!settingsLoaded || savingSettings"></label>
      <button type="button" :disabled="!settingsLoaded || savingSettings" @click="saveSettings">{{ savingSettings ? '保存中…' : '保存设置' }}</button>
    </details>
    <p v-if="error" role="alert" class="review-warning">{{ error }}</p>
    <p v-if="dirty" class="review-warning">内容已修改，现有评测可能过期；生成前会先保存并重新查询风险。</p>
    <div class="evaluation-list-head"><strong>评测记录</strong><button type="button" class="btn btn-ghost" :disabled="historyLoading" @click="loadHistory">刷新</button></div>
    <p v-if="historyError" role="alert" class="review-warning">{{ historyError }} · 保留上次查询结果</p>
    <p v-if="historyLoading && !history.items.length" role="status">正在读取历史评测…</p>
    <p v-else-if="!history.items.length && !historyError" class="evaluation-empty">暂无历史评测。自动评测默认关闭；下方可对已有边界发起评测。</p>
    <article v-for="item in history.items" :key="item.id" class="evaluation-record">
      <button type="button" class="evaluation-record-button" :aria-expanded="selectedId === item.id" @click="selectTask(item)">
        <span class="evaluation-record-title">{{ item.fromGroupTitle || item.fromGroupId }} → {{ item.toGroupTitle || item.toGroupId }}</span>
        <span class="evaluation-tags"><span>{{ stateNames[item.status] }}</span><span v-if="!item.current" class="evaluation-stale">已过期</span><strong v-if="item.result">{{ item.result.overallScore }} / 100</strong></span>
        <small>#{{ item.id }} · 连续性 · {{ item.createdAt }} · {{ item.model || '等待分配模型' }}</small>
      </button>
      <div v-if="selected?.id === item.id" class="evaluation-detail">
        <p v-if="!item.current" class="review-warning">输入画面或时间线已变化，此记录仅供历史参考，不代表当前版本。</p>
        <div class="evaluation-images"><figure v-for="side in (['from', 'to'] as const)" :key="side"><img v-if="item.images[side]" :src="item.images[side]!" :alt="side === 'from' ? '前镜头边界历史画面' : '后镜头边界历史画面'" loading="lazy"><div v-else class="evaluation-no-image">无历史画面</div><figcaption>{{ side === 'from' ? '前镜头 · 结束画面' : '后镜头 · 起始画面' }}</figcaption></figure></div>
        <template v-if="item.result"><p>{{ item.result.summary }}</p><p>置信度：{{ { high: '高', medium: '中', low: '低' }[item.result.confidence] }}</p><div class="evaluation-dimensions"><div v-for="(dimension, key) in item.result.dimensions" :key="key"><b>{{ dimensionNames[key] }} <span>{{ dimension.score }} / 25</span></b><progress :value="dimension.score" max="25" :aria-label="dimensionNames[key]" /><p>{{ dimension.comment }}</p></div></div><h3>发现的问题</h3><p v-if="!item.result.issues.length">未发现明显问题</p><ul><li v-for="issue in item.result.issues" :key="issue">{{ issue }}</li></ul><h3>改进建议</h3><p v-if="!item.result.suggestions.length">暂无补充建议</p><ul><li v-for="suggestion in item.result.suggestions" :key="suggestion">{{ suggestion }}</li></ul></template>
        <p v-else>尚无评分结果{{ item.status === 'pending' || item.status === 'processing' ? '，任务仍在排队或执行。' : '。' }}</p><p v-if="item.error" role="alert" class="review-warning">{{ item.error }}</p>
      </div>
    </article>
    <nav v-if="history.total > history.pageSize" class="evaluation-pagination" aria-label="评测历史分页"><button class="btn" :disabled="page <= 1 || historyLoading" @click="page--">上一页</button><span>{{ page }} / {{ Math.ceil(history.total / history.pageSize) }}</span><button class="btn" :disabled="page * history.pageSize >= history.total || historyLoading" @click="page++">下一页</button></nav>
    <details class="evaluation-settings"><summary>当前边界与手动评测 · {{ risks.length }} 项风险</summary>
    <div v-for="risk in risks" :key="risk.key" class="review-warning" role="status"><b>{{ risk.title }}</b><p>{{ risk.reasons.join('；') }}</p></div>
    <details v-for="item in visibleItems" :key="`${item.fromGroupId}:${item.toGroupId}`" class="review-item">
      <summary>{{ timeline?.groups.find(g => g.id === item.fromGroupId)?.title }} → {{ timeline?.groups.find(g => g.id === item.toGroupId)?.title }} · {{ stateNames[item.status] }}<b v-if="item.result"> · {{ item.result.overallScore }} / 100</b></summary>
      <p v-if="item.result">{{ item.result.summary }}（{{ { high: '高', medium: '中', low: '低' }[item.result.confidence] }}置信度）</p>
      <template v-if="item.result"><p v-for="(dimension, key) in item.result.dimensions" :key="key">{{ { subject: '人物与道具', scene: '场景与光线', action: '动作与视线', camera: '构图与机位' }[key] }}：{{ dimension.score }} / 25 · {{ dimension.comment }}</p><p v-for="issue in item.result.issues" :key="issue">问题：{{ issue }}</p><p v-for="suggestion in item.result.suggestions" :key="suggestion">建议：{{ suggestion }}</p></template>
      <p v-if="item.error" class="review-warning">{{ item.error }}</p>
      <button type="button" :disabled="busy || confirming || !textModel || item.status === 'pending' || item.status === 'processing'" @click="score(item.toGroupId)">{{ busy ? '评测中…' : '手动 AI 评测（产生费用）' }}</button>
      <small v-if="!textModel">请先选择支持视觉的文本模型</small>
    </details>
    <p v-if="!status.items.length">当前没有相邻镜头边界，或尚未载入评测状态。</p>
    </details>
    <slot />
    </div></aside></div></Teleport>
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
.evaluation-badge { min-width: 17px; padding: 1px 5px; border-radius: 10px; background: var(--accent); color: var(--on-accent, #fff); font-size: 10px; line-height: 16px; font-variant-numeric: tabular-nums; }
.evaluation-query-error { color: var(--warning, #94610a); }
.evaluation-overlay { position: fixed; inset: 0; z-index: 1200; background: #15203338; display: flex; justify-content: flex-end; }
.evaluation-drawer { width: min(600px, 100vw); height: 100%; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--surface, #fff); color: var(--text-1, #303744); box-shadow: -12px 0 48px #14243b1a; font-size: 13px; }
.evaluation-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 24px; border-bottom: 1px solid var(--border); }
.evaluation-head small { font-size: 10px; letter-spacing: .14em; color: var(--text-3, #697588); }
.evaluation-head h2 { font-size: 20px; font-weight: 600; margin: 8px 0; color: var(--text-0); }
.evaluation-head p, .evaluation-record small { color: var(--text-2); }
.evaluation-scroll { padding: 20px 24px 32px; overflow-y: auto; min-height: 0; }
.evaluation-settings { padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-soft); }
.evaluation-list-head { display: flex; align-items: center; justify-content: space-between; margin: 24px 0 12px; }
.evaluation-empty { padding: 28px 16px; text-align: center; color: var(--text-2); border: 1px dashed var(--border); border-radius: 10px; }
.evaluation-record { border: 1px solid var(--border); border-radius: 10px; margin: 10px 0; overflow: hidden; }
.evaluation-record-button { display: flex; flex-direction: column; align-items: stretch; gap: 10px; width: 100%; padding: 16px; text-align: left; border: 0; color: inherit; background: var(--surface); }
.evaluation-record-button:hover, .evaluation-record-button[aria-expanded=true] { background: var(--surface-soft); }
.evaluation-record-title { font-weight: 600; overflow-wrap: anywhere; line-height: 1.6; }
.evaluation-tags { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--text-2); }
.evaluation-tags strong { margin-left: auto; color: var(--text-0); font-variant-numeric: tabular-nums; }
.evaluation-stale { color: var(--warning, #94610a); }
.evaluation-record small { overflow-wrap: anywhere; line-height: 1.6; }
.evaluation-detail { padding: 0 16px 16px; border-top: 1px solid var(--border); line-height: 1.7; }
.evaluation-detail h3 { font-size: 13px; margin: 18px 0 8px; }
.evaluation-detail ul { padding-left: 20px; }
.evaluation-images { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
.evaluation-images figure { margin: 0; min-width: 0; }
.evaluation-images img, .evaluation-no-image { width: 100%; height: 150px; object-fit: contain; background: var(--surface-soft); border: 1px solid var(--border); border-radius: 6px; }
.evaluation-no-image { display: grid; place-items: center; color: var(--text-2); }
.evaluation-images figcaption { color: var(--text-2); font-size: 11px; margin-top: 6px; }
.evaluation-dimensions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 16px; }
.evaluation-dimensions > div { padding: 12px; border-radius: 8px; background: var(--surface-soft); }
.evaluation-dimensions b { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; font-size: 12px; font-weight: 500; }
.evaluation-dimensions p { font-size: 12px; color: var(--text-2); }
.evaluation-dimensions progress { width: 100%; height: 5px; accent-color: var(--accent); }
.evaluation-pagination { display: flex; align-items: center; justify-content: space-between; margin: 16px 0; }
@media (max-width: 480px) { .evaluation-head, .evaluation-scroll { padding: 16px; } .evaluation-dimensions { grid-template-columns: 1fr; } .evaluation-images img, .evaluation-no-image { height: 110px; } }
details { margin: 8px 0; } summary { cursor: pointer; line-height: 1.6; } label { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
input[type=number] { width: 70px; } button, input { font: inherit; } button { cursor: pointer; } button:disabled { cursor: not-allowed; opacity: .5; }
p { margin: 6px 0; line-height: 1.6; } .review-warning { padding: 8px; margin: 8px 0; border-left: 3px solid var(--warning, #b87919); background: var(--surface-soft); }
.review-item { border-top: 1px solid var(--border); padding-top: 8px; } .review-dialog { margin: auto; width: min(560px, calc(100vw - 40px)); max-height: 80vh; overflow: auto; padding: 24px; border: 1px solid var(--border, #d9dde3); border-radius: 12px; background: var(--surface-raised, #fff); color: var(--text-0, #20242b); box-shadow: var(--shadow-elevated, 0 16px 48px #0003); }
.review-dialog::backdrop { background: #0008; } .review-dialog h2 { font-size: 18px; margin-top: 0; } .review-dialog article { margin: 12px 0; padding: 10px; background: var(--surface-soft); } footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
</style>
