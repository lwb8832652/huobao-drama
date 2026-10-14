<script setup lang="ts">
import { computed, ref } from 'vue'
import { AlertCircle, ArrowRight, Check, FileImage, Loader2, RotateCcw } from 'lucide-vue-next'
import QueueJobActions from '../QueueJobActions.vue'
import { queueStatusLabel } from '~/composables/useTaskQueue'
import type { EvaluationTask } from '~/composables/useContinuityReview'
const props = defineProps<{ item: EvaluationTask; threshold: number; retryDisabledReason: string; busy: boolean }>()
defineEmits<{ retry: []; changed: [] }>()
const dimensionNames = { subject: '人物与道具', scene: '场景与光线', action: '动作与视线', camera: '构图与机位' }
const confidenceNames = { high: '高', medium: '中', low: '低' }
const attention = computed(() => !!props.item.result && (props.item.result.overallScore < props.threshold || props.item.result.confidence === 'low'))
const brokenImages = ref<string[]>([])
function dateLabel(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—' }
</script>

<template>
  <div class="evaluation-detail" data-testid="evaluation-task-detail">
    <div class="detail-heading"><div class="detail-heading-copy"><span class="detail-kicker">连续性评测 <span>· #{{ item.id }}</span></span><h2>{{ item.fromGroupTitle || item.fromGroupId || '前镜头' }} <ArrowRight :size="16" /> {{ item.toGroupTitle || item.toGroupId || '后镜头' }}</h2><div class="detail-badges"><span :class="['detail-status', `is-${item.status}`]">{{ queueStatusLabel(item) }}</span><span v-if="attention" class="detail-attention">需关注</span><span v-if="!item.current" class="detail-stale">历史结果</span></div></div><div class="detail-action"><QueueJobActions v-if="item.queueJobId" :job="item" @changed="$emit('changed')" /><button v-if="!item.queueJobId || item.status === 'completed'" type="button" :disabled="!!retryDisabledReason || busy" class="detail-button" @click="$emit('retry')"><RotateCcw :size="13" :class="{ spin: busy }" />{{ busy ? '正在提交…' : item.status === 'failed' ? '重试评测' : '重新评测' }}</button><p v-if="!item.queueJobId || item.status === 'completed'">{{ retryDisabledReason || '将调用模型并产生费用' }}</p></div></div>
    <div v-if="!item.current" class="detail-notice"><AlertCircle :size="15" /><p>画面或时间线已变更。这份记录仅供历史参考，不代表当前版本。</p></div>
    <div class="evaluation-images"><figure v-for="side in (['from', 'to'] as const)" :key="side"><div class="detail-image"><img v-if="item.images[side] && !brokenImages.includes(item.images[side]!)" :src="item.images[side]!" :alt="side === 'from' ? '前镜头边界历史画面' : '后镜头边界历史画面'" loading="lazy" @error="brokenImages.push(item.images[side]!)"><div v-else class="evaluation-no-image"><FileImage :size="27" /><span>{{ item.images[side] ? '历史画面无法读取' : '无历史画面' }}</span></div><span class="detail-image-label">{{ side === 'from' ? '前镜头 · 结束画面' : '后镜头 · 起始画面' }}</span></div><figcaption>{{ (side === 'from' ? item.fromGroupTitle || item.fromGroupId : item.toGroupTitle || item.toGroupId) || '未命名镜头' }}</figcaption></figure></div>
    <template v-if="item.result">
      <div class="detail-result" :class="{ attention }"><div class="detail-score"><strong>{{ item.result.overallScore }}</strong><span>/ 100</span></div><div class="detail-result-copy"><h3>{{ !item.current ? '当时的评测结果' : attention ? '建议检查画面后再生成视频' : '画面衔接良好' }}</h3><p>{{ item.result.summary }}</p></div></div>
      <div class="evaluation-dimensions"><div v-for="(dimension, key) in item.result.dimensions" :key="key"><div class="dimension-heading"><b>{{ dimensionNames[key] }}</b><span>{{ dimension.score }} <small>/ 25</small></span></div><progress :value="dimension.score" max="25" :aria-label="dimensionNames[key]" :class="{ low: dimension.score < 17.5 }" /><p>{{ dimension.comment }}</p></div></div>
      <div class="detail-findings"><section><h3><AlertCircle :size="14" />发现的问题 <span>{{ item.result.issues.length }}</span></h3><p v-if="!item.result.issues.length" class="detail-muted">未发现明显问题</p><ul v-else><li v-for="issue in item.result.issues" :key="issue">{{ issue }}</li></ul></section><section><h3><Check :size="14" />改进建议 <span>{{ item.result.suggestions.length }}</span></h3><p v-if="!item.result.suggestions.length" class="detail-muted">暂无补充建议</p><ul v-else><li v-for="suggestion in item.result.suggestions" :key="suggestion">{{ suggestion }}</li></ul></section></div>
      <p class="detail-confidence">置信度{{ confidenceNames[item.result.confidence] }} · AI 评测供审阅参考{{ item.result.confidence === 'low' ? '，建议结合画面人工检查' : '' }}</p>
    </template>
    <div v-else class="detail-no-result" :class="{ failed: item.status === 'failed' }" role="status"><Loader2 v-if="item.status === 'pending' || item.status === 'processing'" :size="25" class="spin" /><AlertCircle v-else :size="25" /><strong>{{ item.status === 'pending' ? '等待开始评测' : item.status === 'processing' ? '正在分析画面衔接' : item.status === 'failed' ? '这次评测没有完成' : '尚无评分结果' }}</strong><p>{{ item.status === 'pending' || item.status === 'processing' ? '结果会自动更新，可以返回列表继续其他操作。' : '尚无评分结果。请查看任务状态后重试。' }}</p></div>
    <p v-if="item.queueReason" class="detail-notice">{{ item.queueReason }}</p>
    <p v-if="item.error" class="detail-error" role="alert">{{ item.error }}</p>
    <dl class="detail-metadata"><div><dt>评测模型</dt><dd>{{ item.model || '等待分配模型' }}</dd></div><div><dt>创建时间</dt><dd>{{ dateLabel(item.createdAt) }}</dd></div><div><dt>开始时间</dt><dd>{{ dateLabel(item.startedAt) }}</dd></div><div><dt>完成时间</dt><dd>{{ dateLabel(item.finishedAt) }}</dd></div></dl>
  </div>
</template>

<style scoped>
.evaluation-detail{padding:26px 30px;overflow-y:auto;flex:1;min-height:0;color:var(--text-1,#556272);scrollbar-width:thin}
.detail-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}
.detail-heading-copy{min-width:0}
.detail-kicker{font-size:11px;color:var(--accent-text,#d17b36);font-weight:600}
.detail-kicker span{color:var(--text-3,#98a1af);font-weight:400}
.detail-heading h2{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:18px;line-height:1.6;color:var(--text-0,#303b4a);margin:8px 0 12px;font-weight:600}
.detail-heading h2 svg{flex-shrink:0;color:var(--text-3,#a1aab6)}
.detail-badges{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.detail-status,.detail-attention,.detail-stale{font-size:10px;padding:4px 7px;border-radius:5px;background:var(--surface-muted,#f1f3f7);color:var(--text-3,#8a96a5)}
.detail-status.is-processing,.detail-status.is-pending{color:var(--info,#7082bd);background:var(--info-bg,#eef1fc)}
.detail-status.is-completed{background:var(--success-bg,#edf7f1);color:var(--success,#3e926e)}
.detail-status.is-failed{color:var(--error,#be6b6b);background:var(--error-bg,#fff0f0)}
.detail-attention{background:var(--warning-bg,#fff3e6);color:var(--warning,#bd7a35)}
.detail-action{flex-shrink:0;max-width:195px;text-align:right}
.detail-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:0;border-radius:8px;font:inherit;font-size:12px;padding:10px 14px;background:var(--accent,#f58b36);color:var(--action-primary-text,#fff);cursor:pointer}
.detail-button:disabled{opacity:.45;cursor:not-allowed}
.detail-button:focus-visible{outline:2px solid var(--accent,#f58b36);outline-offset:3px}
.detail-action p{font-size:10px;color:var(--text-3,#99a3b0);line-height:1.7;margin:8px 0}
.detail-notice{display:flex;align-items:flex-start;gap:8px;border:1px solid var(--border,#e9ecf2);background:var(--surface-soft,#fafbfc);padding:11px 13px;border-radius:8px;margin-top:20px;color:var(--text-2,#82909f);font-size:11px;line-height:1.8}
.detail-notice svg{margin-top:2px;flex-shrink:0}
.detail-notice p{margin:0}
.evaluation-images{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:24px 0}
.evaluation-images figure{margin:0;min-width:0}
.detail-image{position:relative;background:var(--surface-muted,#eef1f5);border-radius:11px;overflow:hidden;aspect-ratio:16/9;border:1px solid var(--border,#e5e9f0)}
.detail-image img{width:100%;height:100%;object-fit:contain;display:block}
.detail-image-label{position:absolute;top:9px;left:9px;background:#19263d99;color:#fff;backdrop-filter:blur(5px);font-size:9px;padding:5px 7px;border-radius:5px}
.evaluation-no-image{display:flex;gap:10px;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-3,#9ba6b5);font-size:11px}
.evaluation-images figcaption{font-size:11px;color:var(--text-2,#7d8999);margin-top:9px;overflow-wrap:anywhere;line-height:1.7}
.detail-result{display:flex;align-items:center;gap:23px;padding:18px 20px;border:1px solid var(--border,#e3eaf0);border-radius:11px;background:var(--surface-soft,#fafbfc)}
.detail-result.attention{background:var(--warning-bg,#fffaf3);border-color:color-mix(in srgb,var(--warning,#c68748) 22%,var(--border,#e5e9ee))}
.detail-score{display:flex;align-items:baseline;gap:5px;color:var(--success,#589678);flex-shrink:0}
.detail-result.attention .detail-score{color:var(--warning,#cf873e)}
.detail-score strong{font-size:34px;font-weight:600;font-variant-numeric:tabular-nums}
.detail-score span{font-size:10px;color:var(--text-3,#99a2af)}
.detail-result-copy h3{font-size:13px;font-weight:600;margin:0 0 7px;color:var(--text-0,#394656)}
.detail-result-copy p{font-size:12px;line-height:1.8;margin:0;color:var(--text-2,#7b8797)}
.evaluation-dimensions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;margin:25px 0}
.dimension-heading{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;color:var(--text-2,#7f8d9c)}
.dimension-heading b{font-weight:500}
.dimension-heading span{font-variant-numeric:tabular-nums;font-weight:600;color:var(--text-1,#5c6b7c);white-space:nowrap}
.dimension-heading small{font-weight:400;font-size:9px;color:var(--text-3,#99a3b1)}
.evaluation-dimensions progress{display:block;width:100%;height:4px;border:0;border-radius:8px;appearance:none;margin:11px 0;overflow:hidden;background:var(--surface-muted,#edf0f5)}
.evaluation-dimensions progress::-webkit-progress-bar{background:var(--surface-muted,#edf0f5)}
.evaluation-dimensions progress::-webkit-progress-value{background:var(--success,#83ac95);border-radius:8px}
.evaluation-dimensions progress.low::-webkit-progress-value{background:var(--warning,#dbac7f)}
.evaluation-dimensions progress::-moz-progress-bar{background:var(--success,#83ac95)}
.evaluation-dimensions progress.low::-moz-progress-bar{background:var(--warning,#dbac7f)}
.evaluation-dimensions p{font-size:10px;line-height:1.8;color:var(--text-3,#98a2b0);margin:0}
.detail-findings{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.detail-findings section{border:1px solid var(--border,#e6ebf1);border-radius:10px;padding:16px}
.detail-findings h3{display:flex;align-items:center;gap:7px;margin:0 0 13px;font-size:12px;font-weight:600;color:var(--text-1,#536273)}
.detail-findings h3 svg{color:var(--text-3,#97a3b1)}
.detail-findings h3 span{margin-left:auto;font-size:10px;color:var(--text-3,#99a4b0);font-weight:400}
.detail-findings ul{padding-left:17px;margin:0}
.detail-findings li{font-size:11px;color:var(--text-2,#7e8b9c);line-height:1.9;margin:6px 0}
.detail-muted{font-size:11px;color:var(--text-3,#98a3b1);line-height:1.7;margin:0}
.detail-confidence{font-size:10px;color:var(--text-3,#98a2b0);margin:16px 0 26px}
.detail-no-result{min-height:160px;background:var(--surface-soft,#f8fafc);border:1px solid var(--border,#e7edf2);border-radius:11px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--text-3,#94a1b0);text-align:center;padding:20px}
.detail-no-result strong{font-size:13px;color:var(--text-2,#7b899a);font-weight:500}
.detail-no-result p{font-size:11px;line-height:1.8;margin:0}
.detail-error{padding:12px 15px;border-radius:8px;background:var(--error-bg,#fff0f0);color:var(--error,#b56161);font-size:12px;line-height:1.8;overflow-wrap:anywhere}
.detail-metadata{display:grid;grid-template-columns:1fr 1fr;gap:15px 24px;margin:0;border-top:1px solid var(--border,#e8ecf2);padding:20px 0 0;font-size:10px}
.detail-metadata div{display:flex;gap:10px;min-width:0}
.detail-metadata dt{color:var(--text-3,#9aa4b1);flex-shrink:0}
.detail-metadata dd{margin:0;color:var(--text-2,#8491a1);overflow-wrap:anywhere;line-height:1.6}
.spin{animation:spin 1.3s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:720px){.evaluation-detail{padding:22px}
.evaluation-dimensions{grid-template-columns:1fr 1fr;gap:18px}
.detail-findings{grid-template-columns:1fr}
.detail-heading{gap:12px}
.detail-heading h2{font-size:16px}
.detail-action{max-width:140px}}
@media(max-width:480px){.evaluation-detail{padding:18px 16px}
.detail-heading{flex-direction:column}
.detail-action{text-align:left;max-width:none}
.detail-action p{display:inline;margin-left:10px}
.evaluation-images{gap:10px}
.detail-image-label{font-size:8px;left:6px;top:6px;padding:3px 5px}
.detail-result{gap:15px;padding:15px}
.detail-score strong{font-size:28px}
.detail-metadata{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>
