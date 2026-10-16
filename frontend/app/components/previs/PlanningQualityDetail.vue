<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { qualityReport, qualityCandidate, type QualityTask } from '~/composables/useProductionQuality'
import type { AnimaticVersion } from '~/composables/usePrevis'
import { queueStatusLabel } from '~/composables/useTaskQueue'
import QueueJobActions from '../QueueJobActions.vue'

const props = defineProps<{
  item: QualityTask
  version?: AnimaticVersion | null
  panelId?: number
  editable?: boolean
  busy: boolean
  optimizeDisabledReason: string
  applyDisabledReason: string
}>()
const emit = defineEmits<{ optimize: [issueIds: string[]]; apply: [confirmed: boolean]; check: []; review: []; select: [panelId: number]; changed: [] }>()
const report = computed(() => qualityReport(props.item)), candidate = computed(() => qualityCandidate(props.item))
const selectedIssues = ref<string[]>([])
const dimensionNames = { dialogue: '对白完整性', timing: '时间与表演', coverage: '画面覆盖', continuity: '动作与空间衔接', production: '制作成本' }
const confidenceNames = { high: '高', medium: '中', low: '低' }
const seconds = (value: number) => (value / 1000).toFixed(1)
function toggleIssue(id: string, checked: boolean) {
  if (!report.value?.issues.some(issue => issue.id === id)) return
  selectedIssues.value = checked ? [...new Set([...selectedIssues.value, id])] : selectedIssues.value.filter(item => item !== id)
}
function requestOptimize() { if (!props.busy && !props.optimizeDisabledReason && selectedIssues.value.length) emit('optimize', [...selectedIssues.value]) }
function requestApply() { if (!props.busy && !props.applyDisabledReason) emit('apply', true) }
function panelLabel(panelId: number) {
  const order = props.version?.timeline.groups?.flatMap(group => group.panelIds) || props.version?.timeline.panels.map(panel => panel.id) || []
  const index = order.indexOf(panelId)
  return index >= 0 ? `分镜 ${index + 1}` : `分镜 #${panelId}`
}
function originalDescription(panelId: number) { return props.version?.timeline.panels.find(panel => panel.id === panelId)?.description || '请在旧版分镜中查看原始描述' }
watch(() => `${props.item.id}:${props.item.inputHash}:${props.item.current}`, () => { selectedIssues.value = [] })
</script>

<template>
  <div class="planning-detail" data-testid="planning-quality-detail">
    <header class="planning-heading"><div><span class="planning-kicker">分镜规划质量 · #{{ item.id }}</span><h3>{{ item.kind === 'optimization' ? `AI 优化候选 · 第 ${item.round} 轮` : item.kind === 'rules' ? '规则检查结果' : 'AI 评测结果' }}</h3><div class="planning-badges"><span>{{ queueStatusLabel(item) }}</span><span v-if="!item.current">历史结果</span><span v-if="item.kind === 'rules'">免费</span><span v-if="item.appliedVersionId">已应用到工作版 #{{ item.appliedVersionId }}</span></div></div><QueueJobActions v-if="item.queueJobId" :job="item" @changed="emit('changed')" /></header>
    <p v-if="!item.current" class="planning-notice">分镜或剧本已变化，这份结果仅供参考。请重新检查当前分镜。</p>
    <p v-if="item.error" role="alert" class="planning-error">{{ item.error }}</p>
    <p v-if="item.queueReason" class="planning-notice">{{ item.queueReason }}</p>
    <div v-if="report" class="planning-report">
      <div class="planning-result"><strong v-if="report.overallScore !== null">{{ report.overallScore }}<small> / 100</small></strong><div><h4>{{ report.issues.length ? `${report.issues.length} 项待处理` : '检查已通过' }}</h4><p>{{ report.summary }}</p></div></div>
      <div class="planning-dimensions"><section v-for="(dimension, key) in report.dimensions" :key="key"><div><b>{{ dimensionNames[key] }}</b><span>{{ dimension.score }} / 100</span></div><progress :value="dimension.score" max="100" :aria-label="dimensionNames[key]" /><p>{{ dimension.comment }}</p></section></div>
      <h4 class="planning-issues-heading">选择需要优化的问题 <small>{{ selectedIssues.length }} 项已选</small></h4>
      <p v-if="!report.issues.length" class="planning-muted">未发现需要修正的规划问题。</p>
      <article v-for="issue in report.issues" :key="issue.id" class="planning-issue"><div class="planning-issue-top"><label><input type="checkbox" :checked="selectedIssues.includes(issue.id)" :disabled="busy || !!optimizeDisabledReason" @change="toggleIssue(issue.id, ($event.target as HTMLInputElement).checked)"><strong>{{ issue.message }}</strong></label><span :class="issue.severity">{{ issue.severity === 'fail' ? '需修正' : '建议检查' }}</span></div><p v-if="issue.evidence" class="planning-evidence">依据：{{ issue.evidence }}</p><p>{{ issue.suggestion }}</p><div class="planning-locations"><button v-for="panelId in issue.panelIds" :key="panelId" type="button" @click="emit('select', panelId)">定位{{ panelLabel(panelId) }}</button><span v-if="!issue.panelIds.length">涉及整集规划</span></div></article>
      <div class="planning-action"><div><p>{{ optimizeDisabledReason || (selectedIssues.length ? `将只针对所选 ${selectedIssues.length} 项问题生成候选` : '先选择需要优化的问题') }}</p><small>AI 优化会调用模型并产生费用，每次检查最多两轮。</small></div><button type="button" class="btn btn-primary" :disabled="busy || !!optimizeDisabledReason || !selectedIssues.length" @click="requestOptimize">{{ busy ? '正在提交…' : 'AI 定向优化' }}</button></div>
      <p class="planning-muted">{{ item.kind === 'rules' ? '规则检查' : 'AI 评测' }} · 置信度{{ confidenceNames[report.confidence] }}。最终对白仍需核对生成后的实际音频。</p>
    </div>
    <div v-else-if="candidate" class="planning-candidate">
      <p>{{ candidate.summary }}</p>
      <div class="planning-result"><div><h4>候选预览</h4><p>所选分镜时长 {{ seconds(candidate.preview.beforeDurationMs) }}s → {{ seconds(candidate.preview.afterDurationMs) }}s · 新增 {{ candidate.preview.extraGenerations }} 次视频生成</p></div></div>
      <article v-for="edit in candidate.edits" :key="edit.panelId" class="planning-edit"><h4>{{ panelLabel(edit.panelId) }} 描述</h4><div class="planning-comparison"><section><small>当前描述</small><p>{{ originalDescription(edit.panelId) }}</p></section><section><small>候选描述</small><p>{{ edit.description }}</p><p v-if="edit.atmosphere">氛围：{{ edit.atmosphere }}</p></section></div></article>
      <article v-for="proposal in candidate.preview.proposals" :key="proposal.panelId" class="planning-proposal"><header><h4>{{ panelLabel(proposal.panelId) }}</h4><span>{{ seconds(proposal.beforeDurationMs) }}s → {{ seconds(proposal.afterDurationMs) }}s · {{ proposal.segments.length }} 段</span></header><p v-if="proposal.error" role="alert" class="planning-error">{{ proposal.error }}</p><section v-for="(segment, index) in proposal.segments" :key="index" class="planning-segment"><strong>第 {{ index + 1 }} 段 · {{ seconds(segment.durationMs) }}s</strong><p>{{ segment.description }}</p></section><p class="planning-muted">保留 {{ proposal.retainedFrames }} 张画面供审阅<span v-if="proposal.beforeVideoUrl"> · <a :href="proposal.beforeVideoUrl" target="_blank" rel="noopener">查看旧版视频</a></span></p></article>
      <p class="planning-notice">应用后创建新工作版，旧版分镜和媒体会保留。新描述的画面需要重新审阅；新分段按需生成视频。</p>
      <div class="planning-action"><p>{{ applyDisabledReason || '点击应用后创建新工作版' }}</p><button type="button" class="btn btn-primary" :disabled="busy || !!applyDisabledReason" @click="requestApply">{{ busy ? '正在应用…' : '应用候选到新工作版' }}</button></div>
    </div>
    <div v-else class="planning-empty" role="status"><strong>{{ item.status === 'failed' ? '任务未完成' : item.status === 'cancelled' ? '任务已取消' : '任务排队或执行中' }}</strong><p>结果会自动更新，可以返回列表继续其他操作。</p></div>
    <footer class="planning-footer"><button type="button" class="btn btn-sm" :disabled="busy" @click="emit('check')">重新规则检查 · 免费</button><div class="planning-ai-review"><button type="button" class="btn btn-sm" :disabled="busy" @click="emit('review')">发起 AI 评测</button><small>使用当前文本模型 · 产生调用费用</small></div><slot name="rule-repair" /></footer>
  </div>
</template>

<style scoped>
.planning-detail{padding:26px 30px;overflow-y:auto;flex:1;min-height:0;font-size:12px;color:var(--text-1)}.planning-heading,.planning-proposal header,.planning-action{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.planning-kicker{font-size:11px;color:var(--accent-text)}h3{font-size:19px;color:var(--text-0);margin:10px 0 12px}h4{font-size:13px;color:var(--text-0);margin:0 0 8px}.planning-badges{display:flex;gap:6px;flex-wrap:wrap}.planning-badges span{padding:4px 7px;background:var(--surface-soft);color:var(--text-2);border-radius:5px;font-size:10px}.planning-result{display:flex;gap:20px;align-items:center;padding:18px 20px;border:1px solid var(--border);border-radius:10px;background:var(--surface-soft);margin:22px 0}.planning-result>strong{font-size:32px;color:var(--accent-text)}.planning-result small{font-size:10px;color:var(--text-3)}p{line-height:1.8;margin:6px 0;overflow-wrap:anywhere}.planning-muted,.planning-action small{font-size:11px;color:var(--text-3)}.planning-dimensions{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:18px;margin:24px 0}.planning-dimensions section>div{display:flex;justify-content:space-between;gap:8px;font-size:11px}.planning-dimensions b{font-weight:500}.planning-dimensions span{white-space:nowrap;color:var(--text-2)}.planning-dimensions progress{width:100%;height:5px;accent-color:var(--accent);margin:10px 0}.planning-dimensions p{font-size:11px;color:var(--text-2)}.planning-issues-heading{display:flex;justify-content:space-between}.planning-issues-heading small{font-weight:400;color:var(--text-3)}.planning-issue,.planning-proposal,.planning-edit{padding:16px;border:1px solid var(--border);border-radius:10px;margin:12px 0}.planning-issue-top{display:flex;gap:10px;justify-content:space-between;align-items:flex-start}.planning-issue-top label{display:flex;align-items:flex-start;gap:9px}.planning-issue-top input{margin-top:3px;flex-shrink:0}.planning-issue-top>span{font-size:10px;white-space:nowrap;color:var(--warning)}.planning-issue-top .fail{color:var(--error)}.planning-evidence{background:var(--surface-soft);padding:10px;border-radius:7px;color:var(--text-2);font-size:11px}.planning-locations{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.planning-locations button{border:0;padding:0;background:none;color:var(--accent-text);font:inherit;font-size:11px;cursor:pointer}.planning-locations span{color:var(--text-3);font-size:11px}.planning-action{margin:20px 0;align-items:center}.planning-action p{font-size:11px;color:var(--text-2)}.planning-comparison{display:grid;grid-template-columns:1fr 1fr;gap:14px}.planning-comparison section{min-width:0;padding:12px;background:var(--surface-soft);border-radius:7px}.planning-comparison small{color:var(--text-3)}.planning-comparison p,.planning-segment p{white-space:pre-wrap}.planning-proposal header>span{font-size:11px;color:var(--text-2)}.planning-segment{margin-top:12px;padding:12px;background:var(--surface-soft);border-radius:7px}.planning-segment strong{font-size:11px}.planning-notice,.planning-error{padding:12px;border-radius:8px;background:var(--warning-bg);color:var(--warning);margin:16px 0}.planning-error{background:var(--error-bg);color:var(--error)}.planning-footer{border-top:1px solid var(--border);padding-top:20px;margin-top:26px;display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.planning-ai-review{display:flex;align-items:center;gap:10px}.planning-ai-review small{font-size:10px;color:var(--text-3)}.planning-empty{padding:40px 20px;text-align:center;margin:20px 0;background:var(--surface-soft);border-radius:10px;color:var(--text-2)}button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}input{accent-color:var(--accent)}@media(max-width:620px){.planning-detail{padding:20px 16px}.planning-comparison{grid-template-columns:1fr}.planning-action{align-items:flex-start;flex-direction:column}.planning-proposal header{flex-direction:column;gap:0}}
</style>
