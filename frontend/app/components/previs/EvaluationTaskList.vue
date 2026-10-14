<script setup lang="ts">
import { ChevronLeft, ChevronRight, Clock3, FileSearch, Loader2, Search, X } from 'lucide-vue-next'
import type { EvaluationListItem, EvaluationTaskFilter } from '~/composables/useContinuityReview'
defineProps<{
  items: EvaluationListItem[]
  total: number
  summary?: { total: number; active: number; completed: number; failed: number }
  activeCount: number
  page: number
  pageSize: number
  filter: EvaluationTaskFilter
  keyword: string
  loading: boolean
  error: string
  canCreate: boolean
}>()
const emit = defineEmits<{
  select: [key: string]
  filter: [filter: EvaluationTaskFilter]
  search: [keyword: string]
  page: [page: number]
  refresh: []
  create: []
}>()
const filters: { key: EvaluationTaskFilter; label: string }[] = [
  { key: 'all', label: '全部' }, { key: 'active', label: '进行中' }, { key: 'completed', label: '已完成' }, { key: 'failed', label: '失败' },
]
const stateNames = { pending: '排队中', processing: '评测中', completed: '已完成', failed: '失败' }
function taskAriaLabel(item: EvaluationListItem) {
  return [`查看${item.typeLabel}评测：${item.title}`, stateNames[item.status], item.score !== undefined ? `${item.score} 分` : '', !item.current ? '历史结果' : '', item.attention ? '需关注' : ''].filter(Boolean).join('，')
}
</script>

<template>
  <div class="evaluation-list-view">
    <div class="evaluation-metrics" aria-label="全部评测任务统计">
      <span class="metric metric-active"><i />进行中 <b>{{ summary?.active ?? activeCount }}</b></span>
      <span v-if="summary" class="metric metric-done"><i />已完成 <b>{{ summary.completed }}</b></span>
      <span v-if="summary" class="metric metric-failed"><i />失败 <b>{{ summary.failed }}</b></span>
      <span v-if="summary" class="metric-total">共 {{ summary.total }} 项</span>
    </div>
    <div class="evaluation-tools">
      <div class="evaluation-filters" role="group" aria-label="筛选评测任务状态">
        <button v-for="option in filters" :key="option.key" type="button" :aria-pressed="filter === option.key" :class="{ on: filter === option.key }" @click="emit('filter', option.key)">{{ option.label }}</button>
      </div>
      <label class="evaluation-search"><Search :size="14" /><input :value="keyword" aria-label="搜索评测任务" placeholder="搜索镜头、模型或任务编号" maxlength="200" @input="emit('search', ($event.target as HTMLInputElement).value)"><button v-if="keyword" type="button" aria-label="清空搜索" @click="emit('search', '')"><X :size="12" /></button></label>
    </div>
    <p v-if="error" class="evaluation-notice" role="alert">{{ error }}<span v-if="items.length"> · 暂时显示上次查询结果</span><button type="button" @click="emit('refresh')">重新加载</button></p>
    <div class="evaluation-records" :aria-busy="loading" data-testid="evaluation-task-list">
      <div v-if="loading && !items.length" class="evaluation-empty" role="status"><Loader2 :size="28" class="spin" /><strong>正在读取评测任务</strong><p>稍后即可查看状态和结果</p></div>
      <div v-else-if="!items.length" class="evaluation-empty"><FileSearch :size="32" /><strong>{{ error ? '暂时无法读取任务' : keyword || filter !== 'all' ? '没有符合条件的任务' : '还没有评测任务' }}</strong><p>{{ error ? '请重新加载后再试' : keyword || filter !== 'all' ? '试试其他关键词或切换状态' : '发起一次评测，检查镜头之间的画面衔接' }}</p><button v-if="!error && !keyword && filter === 'all'" class="evaluation-button primary" type="button" :disabled="!canCreate" @click="emit('create')">发起评测</button><button v-else-if="!error" class="evaluation-button" type="button" @click="emit('search', ''); emit('filter', 'all')">清除筛选</button></div>
      <button v-for="item in items" :key="item.key" class="evaluation-task-row" type="button" :class="`is-${item.status}`" :aria-label="taskAriaLabel(item)" @click="emit('select', item.key)">
        <span class="evaluation-preview"><img v-if="item.preview" :src="item.preview" alt="" loading="lazy" @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"><Loader2 v-else-if="item.status === 'processing' || item.status === 'pending'" :size="21" :class="{ spin: item.status === 'processing' }" /><FileSearch v-else :size="23" /><span class="evaluation-type">{{ item.typeLabel }}</span></span>
        <span class="evaluation-task-copy"><strong :title="item.title">{{ item.title }}</strong><span class="evaluation-task-meta">{{ item.meta }}</span><span class="evaluation-task-summary" :class="{ 'is-error': item.status === 'failed' }" :title="item.summary">{{ item.summary }}</span><span class="evaluation-task-flags"><span v-if="!item.current" class="evaluation-label">历史结果</span><span v-if="item.attention" class="evaluation-label attention">需关注</span></span></span>
        <span class="evaluation-task-outcome"><span class="evaluation-status" :class="`is-${item.status}`"><i />{{ stateNames[item.status] }}</span><span v-if="item.score !== undefined" class="evaluation-score" :class="{ attention: item.attention }">{{ item.score }}<small> / 100</small></span><ChevronRight :size="15" class="evaluation-row-arrow" /></span>
      </button>
    </div>
    <footer class="evaluation-pagination"><span>{{ keyword || filter !== 'all' ? '符合条件 ' : '共 ' }}{{ total }} 项{{ loading && items.length ? ' · 更新中' : '' }}</span><nav v-if="total > pageSize" aria-label="评测历史分页"><button type="button" aria-label="上一页" :disabled="page <= 1 || loading" @click="emit('page', page - 1)"><ChevronLeft :size="15" /></button><span>{{ page }} / {{ Math.max(1, Math.ceil(total / pageSize)) }}</span><button type="button" aria-label="下一页" :disabled="page * pageSize >= total || loading" @click="emit('page', page + 1)"><ChevronRight :size="15" /></button></nav><span v-else class="evaluation-live"><Clock3 :size="11" />状态自动更新</span></footer>
  </div>
</template>

<style scoped>
.evaluation-list-view{display:flex;flex-direction:column;min-height:0;flex:1}
.evaluation-metrics{display:flex;align-items:center;gap:20px;padding:15px 24px;border-bottom:1px solid var(--border,#e7ebf1);background:var(--surface-soft,#fafbfc)}
.metric{display:inline-flex;align-items:center;gap:6px;color:var(--text-2,#7a8796);font-size:11px;white-space:nowrap}
.metric i,.evaluation-status i{width:5px;height:5px;border-radius:50%;background:currentColor}
.metric b{font-variant-numeric:tabular-nums;font-weight:600}
.metric-active{color:var(--info,#6d80bc)}
.metric-done{color:var(--success,#35896b)}
.metric-failed{color:var(--error,#c66161)}
.metric-total{margin-left:auto;font-size:11px;color:var(--text-3,#98a0ac)}
.evaluation-tools{padding:17px 24px 15px;display:flex;flex-direction:column;gap:13px}
.evaluation-filters{display:flex;gap:5px}
.evaluation-filters button{padding:6px 12px;border-radius:7px;border:0;background:transparent;font:inherit;font-size:12px;color:var(--text-2,#798594);cursor:pointer}
.evaluation-filters button:hover{background:var(--surface-soft,#f4f6f9)}
.evaluation-filters button.on{background:var(--accent-bg,#fff0e4);color:var(--accent-text,#d77b2f);font-weight:600}
.evaluation-search{display:flex;align-items:center;gap:9px;padding:9px 12px;background:var(--surface-input,#fafbfc);border:1px solid var(--border,#e5e9ef);border-radius:9px;color:var(--text-3,#939daa)}
.evaluation-search:focus-within{border-color:var(--accent,#f58b36)}
.evaluation-search input{border:0;outline:0;width:100%;min-width:0;font:inherit;font-size:12px;color:var(--text-0,#263241);background:transparent}
.evaluation-search button{display:grid;place-items:center;border:0;background:transparent;color:inherit;padding:2px;cursor:pointer}
.evaluation-records{overflow-y:auto;flex:1;min-height:0;padding:0 12px 12px;scrollbar-width:thin;scrollbar-color:var(--border-strong,#d6dce5) transparent}
.evaluation-task-row{display:flex;align-items:center;gap:14px;width:100%;padding:16px 12px;text-align:left;color:inherit;cursor:pointer;background:transparent;border:0;border-bottom:1px solid var(--border,#e8ecf1);font:inherit;transition:background .15s}
.evaluation-task-row:hover{background:var(--surface-soft,#f7f9fb);border-radius:10px}
.evaluation-preview{width:92px;height:58px;position:relative;display:grid;place-items:center;flex-shrink:0;background:var(--surface-muted,#edf0f5);color:var(--text-3,#9aa6b5);border:1px solid var(--border,#e5e9ef);border-radius:8px;overflow:hidden}
.evaluation-preview img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.evaluation-type{position:absolute;left:5px;bottom:5px;font-size:9px;line-height:1.5;border-radius:4px;padding:2px 5px;color:#fff;background:#202d46b3;backdrop-filter:blur(5px)}
.evaluation-task-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:5px}
.evaluation-task-copy strong{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-0,#2c3645)}
.evaluation-task-meta,.evaluation-task-summary{font-size:10.5px;color:var(--text-3,#8d98a7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.6}
.evaluation-task-summary{color:var(--text-2,#7a8594)}
.evaluation-task-summary.is-error{color:var(--error,#bf6464)}
.evaluation-task-flags{display:flex;gap:5px}
.evaluation-task-flags:empty{display:none}
.evaluation-label{font-size:9px;background:var(--surface-muted,#f0f2f6);color:var(--text-3,#8e98a6);padding:2px 5px;border-radius:4px}
.attention{color:var(--warning,#bb7c37)}
.evaluation-label.attention{background:var(--warning-bg,#fff3e5)}
.evaluation-task-outcome{display:flex;align-items:flex-end;flex-direction:column;gap:8px;flex-shrink:0;min-width:62px;position:relative;padding-right:14px}
.evaluation-status{display:flex;gap:5px;align-items:center;font-size:10px;color:var(--text-2,#7b8899);white-space:nowrap}
.evaluation-status.is-pending,.evaluation-status.is-processing{color:var(--info,#6c80bc)}
.evaluation-status.is-completed{color:var(--success,#368969)}
.evaluation-status.is-failed{color:var(--error,#c56868)}
.evaluation-score{font-size:17px;color:var(--text-1,#536170);font-weight:600;font-variant-numeric:tabular-nums}
.evaluation-score.attention{color:var(--warning,#bf7d38)}
.evaluation-score small{font-size:9px;font-weight:400;color:var(--text-3,#98a2af)}
.evaluation-row-arrow{position:absolute;right:-4px;top:50%;transform:translateY(-50%);color:var(--text-3,#a3acb8)}
.evaluation-pagination{padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--border,#e6eaf0);font-size:10px;color:var(--text-3,#909dac);flex-shrink:0}
.evaluation-pagination nav{display:flex;align-items:center;gap:12px}
.evaluation-pagination nav button{width:26px;height:26px;display:grid;place-items:center;border:1px solid var(--border,#e4e9ef);border-radius:7px;background:var(--surface-raised,#fff);color:var(--text-2,#7b8797);cursor:pointer}
.evaluation-pagination nav button:disabled{opacity:.35;cursor:not-allowed}
.evaluation-live{display:flex;align-items:center;gap:5px}
.evaluation-empty{display:flex;align-items:center;justify-content:center;flex-direction:column;min-height:280px;gap:12px;color:var(--text-3,#96a1af);text-align:center;padding:24px}
.evaluation-empty strong{font-size:14px;font-weight:500;color:var(--text-1,#596676)}
.evaluation-empty p{font-size:12px;line-height:1.6;margin:0}
.evaluation-button{border:1px solid var(--border,#e5e9ef);border-radius:8px;background:var(--surface-raised,#fff);color:var(--text-1,#5b6777);font:inherit;font-size:12px;padding:9px 14px;cursor:pointer}
.evaluation-button.primary{border-color:transparent;background:var(--accent,#f58b36);color:var(--action-primary-text,#fff)}
.evaluation-button:disabled{opacity:.5;cursor:not-allowed}
.evaluation-notice{background:var(--warning-bg,#fff7ee);margin:0 24px 12px;padding:10px 12px;border-radius:8px;font-size:11px;color:var(--warning,#9e702f);line-height:1.7}
.evaluation-notice button{font:inherit;border:0;background:transparent;color:inherit;text-decoration:underline;margin-left:8px;cursor:pointer}
button:focus-visible{outline:2px solid var(--accent,#f58b36);outline-offset:2px}
.spin{animation:spin 1.3s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:480px){.evaluation-metrics{gap:12px;padding:14px 16px}
.evaluation-tools{padding:15px 16px}
.evaluation-task-row{gap:10px;padding:14px 6px}
.evaluation-preview{width:65px;height:51px}
.evaluation-task-copy strong{font-size:12px}
.evaluation-task-outcome{min-width:53px}
.evaluation-pagination{padding:14px 16px}}
@media(prefers-reduced-motion:reduce){.spin{animation:none}
.evaluation-task-row{transition:none}}
</style>
