<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { analyzePanelProduction, type ProductionIssue, type ProductionSegment } from '../../../../backend/src/services/shot-planning'
import { previsRequest, type AnimaticVersion } from '~/composables/usePrevis'

interface ProductionProposal {
  panelId: number
  title: string
  beforeDurationMs: number
  afterDurationMs: number
  beforeVideoUrl?: string
  issues: ProductionIssue[]
  restorations: { before: string; after: string; speaker: string }[]
  segments: ProductionSegment[]
  error: string | null
  retainedFrames: number
}
interface ProductionPreview {
  versionId: number
  revision: number
  inputHash: string
  maxSeconds: number
  proposals: ProductionProposal[]
  beforeDurationMs: number
  afterDurationMs: number
  extraGenerations: number
}
const props = defineProps<{
  version: AnimaticVersion | null
  panelId?: number
  editable?: boolean
  busy?: boolean
  secondary?: boolean
  headless?: boolean
  beforeAction?: () => Promise<{ versionId: number; revision: number } | false>
}>()
const emit = defineEmits<{
  applied: [version: AnimaticVersion]
  select: [panelId: number]
}>()

const dialog = ref<HTMLDialogElement>()
const previewSummary = ref<HTMLElement>()
const open = ref(false)
const selectedIds = ref<number[]>([])
const preview = ref<ProductionPreview | null>(null)
const error = ref('')
const phase = ref<'idle' | 'saving' | 'preview' | 'apply'>('idle')
const titleId = useId(), descriptionId = useId(), previewTitleId = useId()
const maxSeconds = 15
let requestToken = 0, disposed = false
let returnFocus: HTMLElement | null = null
let reviewedTimeline = ''

const panels = computed(() => props.version?.timeline.panels || [])
const diagnostics = computed(() => panels.value.map(panel => ({ panel, ...analyzePanelProduction(panel) })))
const selectedDiagnostic = computed(() => diagnostics.value.find(item => item.panelId === props.panelId))
const failureCount = computed(() => selectedDiagnostic.value?.issues.filter(issue => issue.severity === 'fail').length || 0)
const timePlanPassed = computed(() => !!selectedDiagnostic.value?.panel.productionPlan
  && selectedDiagnostic.value.issues.every(issue => ['frame_plan_review', 'invalid_frame_prompt'].includes(issue.rule)))
const problemCount = computed(() => diagnostics.value.filter(item => item.issues.length).length)
const localBusy = computed(() => phase.value !== 'idle')
const canEdit = computed(() => !!props.version && !!props.editable && !props.busy && !props.version.busy
  && props.version.status !== 'locked' && props.version.isCurrent !== false)
const canPreview = computed(() => open.value && canEdit.value && !localBusy.value && selectedIds.value.length > 0)
const timelineIdentity = () => JSON.stringify(props.version?.timeline)
const previewMatches = () => !!preview.value && props.version?.id === preview.value.versionId
  && props.version.revision === preview.value.revision && reviewedTimeline === timelineIdentity()
const canApply = computed(() => canPreview.value && previewMatches() && !!preview.value?.proposals.length
  && !preview.value.proposals.some(proposal => proposal.error || !proposal.segments.length))
const seconds = (value: number) => (value / 1000).toFixed(1)

function invalidate(message = '') {
  // Let an active write settle before enabling another action in this dialog.
  if (phase.value !== 'apply') requestToken++
  preview.value = null
  reviewedTimeline = ''
  if (phase.value !== 'apply') phase.value = 'idle'
  error.value = message
}
function togglePanel(panelId: number, selected: boolean) {
  if (phase.value === 'apply' || !panels.value.some(panel => panel.id === panelId)) return
  const next = selected ? [...new Set([...selectedIds.value, panelId])] : selectedIds.value.filter(id => id !== panelId)
  if (next.join(',') === selectedIds.value.join(',')) return
  selectedIds.value = next
  invalidate()
}
function selectAll(problematicOnly = false) {
  if (phase.value === 'apply') return
  selectedIds.value = diagnostics.value.filter(item => !problematicOnly || item.issues.length).map(item => item.panelId)
  invalidate()
}
async function openDialog() {
  if (!props.version || !panels.value.length || open.value || disposed) return
  returnFocus = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null
  selectAll(true)
  open.value = true
  await nextTick()
  if (open.value && !disposed && !dialog.value?.open) dialog.value?.showModal()
}
function finishClose() {
  invalidate()
  dialog.value?.close()
  open.value = false
  void nextTick(() => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }) })
}
function closeDialog() {
  if (phase.value !== 'apply') finishClose()
}
function onKeydown(event: KeyboardEvent) {
  event.stopPropagation()
  // Keep the episode editor's save shortcut away from a reviewed proposal.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') event.preventDefault()
}
async function requestPreview() {
  if (!canPreview.value || !props.version) return
  invalidate()
  const token = requestToken, originalId = props.version.id, panelIds = [...selectedIds.value]
  phase.value = 'saving'
  const active = () => !disposed && open.value && token === requestToken && props.version?.id === originalId
  try {
    const saved = props.beforeAction ? await props.beforeAction() : { versionId: props.version.id, revision: props.version.revision }
    // The parent's saved version is delivered through props on its next render.
    await nextTick()
    if (!active()) return
    if (!saved) throw new Error('保存未完成，请先保存修改后重新预览。')
    if (!canEdit.value || props.version?.id !== saved.versionId || props.version.revision !== saved.revision) {
      throw new Error('当前工作版已变化或暂不可编辑，请稍后重新预览。')
    }
    phase.value = 'preview'
    const snapshot = timelineIdentity()
    const result = await previsRequest<ProductionPreview>(`/animatic-versions/${saved.versionId}/production-plan/preview`, 'POST',
      { revision: saved.revision, panelIds, maxSeconds })
    if (!active()) return
    if (props.version?.revision !== saved.revision || timelineIdentity() !== snapshot
      || result.versionId !== saved.versionId || result.revision !== saved.revision || result.maxSeconds !== maxSeconds
      || !result.inputHash || result.proposals.length !== panelIds.length || result.proposals.some(proposal => !panelIds.includes(proposal.panelId))) {
      throw new Error('预览资料已变化，请重新预览优化方案。')
    }
    reviewedTimeline = snapshot
    preview.value = result
    await nextTick()
    if (active() && preview.value?.inputHash === result.inputHash) {
      previewSummary.value?.scrollIntoView?.({ block: 'start', behavior: 'auto' })
      previewSummary.value?.focus({ preventScroll: true })
    }
  } catch (cause) {
    if (active()) error.value = cause instanceof Error ? cause.message : '预览失败，请重试。'
  } finally {
    if (token === requestToken) phase.value = 'idle'
  }
}
async function applyPreview() {
  if (!canApply.value || !preview.value) return
  const reviewed = preview.value, token = ++requestToken, snapshot = reviewedTimeline
  const panelIds = [...selectedIds.value]
  phase.value = 'apply'
  error.value = ''
  try {
    const applied = await previsRequest<AnimaticVersion>(`/animatic-versions/${reviewed.versionId}/production-plan/apply`, 'POST',
      { revision: reviewed.revision, panelIds, maxSeconds, inputHash: reviewed.inputHash })
    const originalStillCurrent = token === requestToken && props.version?.id === reviewed.versionId
      && props.version.revision === reviewed.revision && timelineIdentity() === snapshot
    // Polling can discover this exact new version before the apply response arrives.
    // Still notify the page so its storyboard list refreshes to include split panels.
    const alreadyAccepted = props.version?.id === applied.id && props.version.revision === applied.revision
      && timelineIdentity() === JSON.stringify(applied.timeline)
    if (disposed || (!originalStillCurrent && !alreadyAccepted)) return
    phase.value = 'idle'
    finishClose()
    emit('applied', applied)
  } catch (cause) {
    if (!disposed && token === requestToken) {
      error.value = cause instanceof Error ? cause.message : '应用失败，请重新预览后重试。'
      preview.value = null
    }
  } finally {
    if (token === requestToken) phase.value = 'idle'
  }
}

watch(() => props.version?.id, (id, previous) => {
  if (id !== previous && open.value) {
    phase.value = 'idle'
    finishClose()
  }
}, { flush: 'sync' })
watch(() => [props.version?.id, props.version?.revision, timelineIdentity()] as const, ([id, revision], previous) => {
  // A successful save replaces this version and advances revision atomically.
  // Same-revision changes during that save are conflicting unsaved edits.
  const savingRevision = phase.value === 'saving' && id === previous[0] && revision !== previous[1]
  if (open.value && !savingRevision) invalidate('工作版内容已更新，请重新预览。')
}, { flush: 'sync' })
onBeforeUnmount(() => {
  disposed = true
  phase.value = 'idle'
  finishClose()
})
defineExpose({ openDialog })
</script>

<template>
  <button v-if="!headless && secondary" type="button" class="btn btn-sm" :disabled="!version || !panels.length || busy" @click="openDialog">规则修复预览 · 免费</button>
  <section v-else-if="!headless" class="production-panel" aria-label="对白与时间规划检查">
    <div class="production-heading">
      <div>
        <strong>对白与时间检查</strong>
        <span v-if="selectedDiagnostic" class="production-count" :class="{ 'has-failures': failureCount }">{{ failureCount }} 项需修正</span>
      </div>
      <button type="button" class="btn btn-sm" :disabled="!version || !panels.length" @click="openDialog">整集检查与优化</button>
    </div>
    <template v-if="selectedDiagnostic">
      <p class="production-metrics">对白 {{ selectedDiagnostic.dialogueChars }} 字 <span>·</span> 当前 {{ seconds(selectedDiagnostic.panel.durationMs) }}s <span>·</span> 最低估计 {{ seconds(selectedDiagnostic.minimumMs) }}s</p>
      <ul v-if="selectedDiagnostic.issues.length" class="production-issues">
        <li v-for="(issue, index) in selectedDiagnostic.issues.slice(0, 3)" :key="`${issue.rule}-${index}`" :class="issue.severity">{{ issue.message }}</li>
      </ul>
      <p v-if="timePlanPassed || !selectedDiagnostic.issues.length" class="production-pass">{{ timePlanPassed ? '对白与时间规划已通过。' : '当前未发现文字与时间问题。' }}</p>
      <p v-if="selectedDiagnostic.panel.framePlanNeedsReview" class="production-frame-review">对白时间已调整，请重新规划宫格画面并逐格审阅，核对新描述与衔接后再生成视频。</p>
    </template>
    <p v-else class="production-metrics">全 {{ panels.length }} 个分镜，{{ problemCount }} 个存在待检查项。选择分镜可查看详情。</p>
    <p class="production-note">这是生成前的文字与时间规划检查，最终对白完整性仍需核对生成后的实际音频。</p>
  </section>

  <Teleport to="body">
    <dialog
      v-if="open" ref="dialog" class="production-dialog" :aria-labelledby="titleId" :aria-describedby="descriptionId"
      :aria-busy="localBusy" @cancel.prevent="closeDialog" @keydown="onKeydown"
    >
      <header class="production-dialog-header">
        <div>
          <h2 :id="titleId">整集检查与优化</h2>
          <p :id="descriptionId">先选分镜，再审阅完整对白、时长与拆段方案，确认后应用到新工作版。</p>
        </div>
        <button type="button" class="btn btn-icon" aria-label="关闭整集检查" :disabled="phase === 'apply'" @click="closeDialog">×</button>
      </header>
      <div class="production-dialog-body">
        <p class="production-budget">本次每段采用 <strong>15 秒规划预算</strong>；实际生成时长以所选模型的已验证能力为准。</p>
        <p class="production-note">这是生成前的文字与时间规划检查，最终对白完整性仍需核对生成后的实际音频。</p>
        <div class="production-selection">
          <strong>检查范围 <span>已选 {{ selectedIds.length }} / {{ panels.length }}</span></strong>
          <div>
            <button type="button" class="production-text-button" :disabled="phase === 'apply'" @click="selectAll(true)">只选有问题的</button>
            <button type="button" class="production-text-button" :disabled="phase === 'apply'" @click="selectAll()">全选</button>
          </div>
        </div>
        <div class="production-panel-list">
          <article v-for="item in diagnostics" :key="item.panelId" class="production-row" :class="{ selected: selectedIds.includes(item.panelId) }">
            <header>
              <label>
                <input type="checkbox" :checked="selectedIds.includes(item.panelId)" :disabled="phase === 'apply'" @change="togglePanel(item.panelId, ($event.target as HTMLInputElement).checked)">
                <strong>{{ item.title || `分镜 ${item.panelId}` }}</strong>
              </label>
              <button type="button" class="production-text-button" :disabled="phase === 'apply'" :aria-label="`定位${item.title || '分镜 ' + item.panelId}`" @click="emit('select', item.panelId)">定位</button>
            </header>
            <p class="production-metrics">对白 {{ item.dialogueChars }} 字 · 当前 {{ seconds(item.panel.durationMs) }}s · 最低估计 {{ seconds(item.minimumMs) }}s</p>
            <ul v-if="item.issues.length" class="production-issues"><li v-for="(issue, index) in item.issues" :key="`${issue.rule}-${index}`" :class="issue.severity">{{ issue.message }}</li></ul>
            <p v-else class="production-pass">文字与时间规划未发现问题</p>
            <p v-if="item.panel.framePlanNeedsReview" class="production-frame-review">请重新规划宫格画面并逐格审阅</p>
          </article>
        </div>

        <section v-if="preview" class="production-preview" :aria-labelledby="previewTitleId">
          <header class="production-preview-summary">
            <div><h3 :id="previewTitleId" ref="previewSummary" tabindex="-1">待确认的优化方案</h3><p>所选分镜 {{ seconds(preview.beforeDurationMs) }}s → <strong>{{ seconds(preview.afterDurationMs) }}s</strong></p></div>
            <span>预计新增 {{ preview.extraGenerations }} 次视频生成</span>
          </header>
          <p class="production-preserved">应用会创建新工作版，生成需另行提交。旧版及已有图片、视频、音频文件保留；应用后请重新规划宫格画面并逐格审阅，同时核对音频时间。</p>
          <article v-for="proposal in preview.proposals" :key="proposal.panelId" class="production-proposal">
            <header><strong>{{ proposal.title || `分镜 ${proposal.panelId}` }}</strong><span>{{ seconds(proposal.beforeDurationMs) }}s → {{ seconds(proposal.afterDurationMs) }}s</span></header>
            <p v-if="proposal.error" class="production-error">{{ proposal.error }}</p>
            <template v-else>
              <p class="production-segment-summary">1 → {{ proposal.segments.length }} 段 <span>·</span> {{ proposal.segments.reduce((sum, segment) => sum + segment.plan.shots.length, 0) }} 个子镜头</p>
              <p v-if="proposal.beforeVideoUrl || proposal.retainedFrames" class="production-note">{{ proposal.beforeVideoUrl ? '原有视频保留在旧版。' : '' }}{{ proposal.retainedFrames ? `${proposal.retainedFrames} 张已有画面保留，仍需逐格复核。` : '' }}</p>
              <div v-for="(line, index) in proposal.restorations" :key="index" class="production-restoration">
                <strong>恢复原文对白 · {{ line.speaker || '人物' }}</strong>
                <p><span>原：</span><del>{{ line.before }}</del></p>
                <p><span>改：</span><ins>{{ line.after }}</ins></p>
              </div>
              <details class="production-descriptions">
                <summary>查看完整分段描述与时间</summary>
                <section v-for="(segment, index) in proposal.segments" :key="index"><strong>第 {{ index + 1 }} 段 · {{ seconds(segment.durationMs) }}s · {{ segment.plan.shots.length }} 个子镜头</strong><p>{{ segment.description }}</p></section>
              </details>
            </template>
          </article>
        </section>
        <p v-if="error" class="production-error" role="alert">{{ error }}</p>
        <p class="production-status" role="status" aria-live="polite">{{ phase === 'saving' ? '正在保存当前修改…' : phase === 'preview' ? '正在检查完整对白并计算优化方案…' : phase === 'apply' ? '正在创建优化后的工作版，请稍候…' : '' }}</p>
      </div>
      <footer class="production-dialog-footer">
        <span>{{ !canEdit ? '请在可编辑的当前工作版操作。' : !selectedIds.length ? '至少选择一个分镜以预览。' : preview ? '确认方案后，将创建新的工作版。' : '预览后可逐项审阅再确认。' }}</span>
        <div>
          <button type="button" class="btn btn-sm" :disabled="phase === 'apply'" @click="closeDialog">取消</button>
          <button type="button" class="btn btn-sm" :disabled="!canPreview" @click="requestPreview">{{ preview ? '重新预览' : '预览优化方案' }}</button>
          <button type="button" class="btn btn-sm btn-primary" :disabled="!canApply" @click="applyPreview">确认并应用到新工作版</button>
        </div>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.production-panel { padding: 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-soft); color: var(--text-0); }
.production-heading, .production-heading > div, .production-selection, .production-selection > div, .production-row > header, .production-proposal > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.production-heading { flex-wrap: wrap; }
.production-heading strong { font-size: 12px; }
.production-count { color: var(--text-2); font-size: 10px; }
.production-count.has-failures, .production-issues .fail { color: var(--warning-text, #a25b30); }
.production-metrics, .production-note, .production-pass, .production-frame-review { margin: 7px 0 0; font-size: 11px; line-height: 1.6; }
.production-metrics { color: var(--text-1); }
.production-metrics > span { padding: 0 3px; color: var(--text-3); }
.production-note { color: var(--text-2); }
.production-pass { color: var(--accent-text); }
.production-frame-review { color: var(--warning-text, #a25b30); }
.production-issues { margin: 7px 0 0; padding-left: 17px; color: var(--text-1); font-size: 11px; line-height: 1.7; }
.production-issues li + li { margin-top: 3px; }
.production-dialog { width: min(820px, calc(100vw - 32px)); max-height: min(90dvh, 960px); margin: auto; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-lg, 12px); background: var(--surface-raised); color: var(--text-0); box-shadow: var(--shadow-lg, 0 20px 70px #0003); }
.production-dialog[open] { display: flex; flex-direction: column; }
.production-dialog::backdrop { background: rgb(20 18 16 / 45%); }
.production-dialog-header { display: flex; flex-shrink: 0; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 18px 20px 14px; border-bottom: 1px solid var(--border); }
.production-dialog-header h2 { margin: 0; font-size: 17px; }
.production-dialog-header p { margin: 7px 0 0; color: var(--text-2); font-size: 12px; line-height: 1.6; }
.production-dialog-header .btn-icon { min-width: 30px; font-size: 23px; font-weight: 400; }
.production-dialog-body { min-height: 0; padding: 16px 20px; overflow-y: auto; overscroll-behavior: contain; }
.production-budget { margin: 0; color: var(--text-1); font-size: 12px; line-height: 1.7; }
.production-selection { flex-wrap: wrap; margin: 20px 0 9px; font-size: 12px; }
.production-selection strong > span { margin-left: 5px; color: var(--text-2); font-size: 11px; font-weight: 400; }
.production-text-button { padding: 4px; border: 0; background: transparent; color: var(--accent-text); font: inherit; font-size: 11px; cursor: pointer; }
.production-text-button:disabled { opacity: .45; cursor: default; }
.production-panel-list { display: grid; gap: 8px; }
.production-row, .production-proposal { min-width: 0; padding: 11px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); overflow-wrap: anywhere; }
.production-row.selected { border-color: var(--accent-border, var(--border-focus)); background: var(--surface-soft); }
.production-row > header label { display: flex; min-width: 0; align-items: flex-start; gap: 8px; font-size: 12px; cursor: pointer; }
.production-row input { flex-shrink: 0; width: 14px; height: 14px; margin: 1px 0 0; accent-color: var(--accent-text); }
.production-row .production-metrics, .production-row .production-issues, .production-row .production-pass, .production-row .production-frame-review { margin-left: 22px; }
.production-preview { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--border); }
.production-preview-summary { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.production-preview-summary h3 { margin: 0; font-size: 14px; }
.production-preview-summary p { margin: 7px 0 0; font-size: 13px; }
.production-preview-summary > span { padding: 5px 8px; border-radius: var(--radius-sm); background: var(--accent-bg); color: var(--accent-text); font-size: 11px; }
.production-preserved { margin: 12px 0; color: var(--text-2); font-size: 11px; line-height: 1.7; }
.production-proposal + .production-proposal { margin-top: 10px; }
.production-proposal > header { align-items: flex-start; font-size: 12px; }
.production-proposal > header span { flex-shrink: 0; color: var(--accent-text); font-variant-numeric: tabular-nums; }
.production-segment-summary { margin: 8px 0; color: var(--text-1); font-size: 11px; }
.production-segment-summary > span { margin: 0 4px; color: var(--text-3); }
.production-restoration { margin-top: 12px; padding: 9px 10px; border-radius: var(--radius-sm); background: var(--surface-soft); font-size: 11px; line-height: 1.7; }
.production-restoration strong { font-weight: 500; }
.production-restoration p { margin: 5px 0 0; white-space: pre-wrap; }
.production-restoration span, .production-restoration del { color: var(--text-2); }
.production-restoration ins { color: var(--accent-text); text-decoration: none; }
.production-descriptions { margin-top: 12px; font-size: 11px; line-height: 1.7; }
.production-descriptions summary { width: fit-content; color: var(--accent-text); cursor: pointer; }
.production-descriptions section { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
.production-descriptions strong { font-weight: 500; }
.production-descriptions p { margin: 6px 0 0; color: var(--text-1); white-space: pre-wrap; }
.production-error { margin: 12px 0 0; color: var(--danger-text, #b74736); font-size: 12px; line-height: 1.7; }
.production-status { margin: 12px 0 0; color: var(--accent-text); font-size: 12px; }
.production-status:empty { display: none; }
.production-dialog-footer { display: flex; flex-shrink: 0; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px; border-top: 1px solid var(--border); background: var(--surface-soft); }
.production-dialog-footer > span { color: var(--text-2); font-size: 11px; }
.production-dialog-footer > div { display: flex; flex-wrap: wrap; gap: 7px; }
.production-panel button:focus-visible, .production-dialog :is(button, input, summary):focus-visible { outline: 2px solid var(--border-focus); outline-offset: 3px; }
@media (max-width: 600px) {
  .production-dialog { width: calc(100vw - 16px); max-height: 94dvh; }
  .production-dialog-header { padding: 15px 13px 12px; }
  .production-dialog-body { padding: 13px; }
  .production-dialog-footer { padding: 12px 13px; }
  .production-dialog-footer > div { width: 100%; }
  .production-dialog-footer .btn-primary { flex-grow: 1; }
  .production-proposal > header { flex-wrap: wrap; }
  .production-text-button { min-height: 30px; }
}
</style>
