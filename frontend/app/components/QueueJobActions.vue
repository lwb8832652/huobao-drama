<script setup lang="ts">
import { nextTick, onUnmounted, ref } from 'vue'
import { api } from '~/composables/useApi'
import type { QueueMetadata } from '~/composables/useTaskQueue'
const props = defineProps<{ job: QueueMetadata & { status: string } }>()
const emit = defineEmits<{ changed: [] }>()
const busy = ref(false), error = ref(''), message = ref(''), confirmedStopped = ref(false)
const confirmation = ref<HTMLDialogElement>()
let opener: HTMLElement | null = null
function closeConfirmation() { confirmation.value?.close(); opener?.focus() }
async function openConfirmation() { confirmedStopped.value = false; opener = document.activeElement as HTMLElement; await nextTick(); confirmation.value?.showModal() }
async function act(action: 'cancel' | 'retry' | 'reconcile') {
  const job = props.job
  if (busy.value || !job.queueJobId || (action === 'cancel' && !job.canCancel) || (action === 'retry' && !job.canRetry) || (action === 'reconcile' && (job.phase !== 'needs_confirmation' || !confirmedStopped.value))) return
  busy.value = true; error.value = ''; message.value = ''
  try {
    const result = await api.post(`/task-queue/jobs/${job.queueJobId}/${action}`, action === 'reconcile' ? { confirmedStopped: true } : undefined)
    if (action === 'reconcile') closeConfirmation()
    message.value = action === 'retry' ? '已加入队列' : action === 'cancel' ? (result?.status === 'processing' ? '任务仍在执行，继续追踪状态' : '取消请求已处理') : '已结束追踪'
    emit('changed')
  } catch (cause: any) { error.value = cause.message || '任务操作失败' }
  finally { busy.value = false }
}
onUnmounted(() => confirmation.value?.close())
</script>
<template>
  <div v-if="job.queueJobId" class="queue-job-actions" @click.stop>
    <button v-if="job.canCancel" type="button" :disabled="busy" @click="act('cancel')">{{ job.status === 'pending' ? '取消排队' : '请求取消' }}</button>
    <button v-if="job.canRetry" type="button" :disabled="busy" title="显式重试，可能调用模型并产生费用" @click="act('retry')">重试任务</button>
    <button v-if="job.phase === 'needs_confirmation'" type="button" :disabled="busy" @click="openConfirmation">核对后结束追踪</button>
    <span v-if="message" role="status">{{ message }}</span><span v-if="error" class="queue-action-error" role="alert">{{ error }}</span>
    <Teleport to="body"><dialog ref="confirmation" class="queue-confirmation" aria-label="核对服务商任务状态" @cancel.prevent="closeConfirmation" @keydown.esc.stop @click="($event.target === confirmation) && closeConfirmation()"><form @submit.prevent="act('reconcile')"><h3>核对后结束追踪</h3><p>请先在服务商处核对该任务。确认任务已结束后释放占用名额，记录会保留以便显式重试。</p><label><input v-model="confirmedStopped" type="checkbox">已确认服务商任务已结束</label><p v-if="error" role="alert">{{ error }}</p><footer><button type="button" :disabled="busy" @click="closeConfirmation">返回</button><button type="submit" :disabled="!confirmedStopped || busy">确认结束追踪</button></footer></form></dialog></Teleport>
  </div>
</template>
<style scoped>
.queue-job-actions{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:6px;font-size:10px;color:var(--text-2,#8290a0)}.queue-job-actions>button,.queue-confirmation button{border:1px solid var(--border,var(--surface-outline,#e5e9ef));background:var(--surface-raised,var(--panel-bg,#fff));color:var(--text-1,#536172);border-radius:6px;font:inherit;padding:5px 8px;cursor:pointer}.queue-job-actions button:focus-visible,.queue-confirmation button:focus-visible,.queue-confirmation input:focus-visible{outline:2px solid var(--accent,#f58b36);outline-offset:3px}.queue-job-actions button:disabled,.queue-confirmation button:disabled{opacity:.45;cursor:not-allowed}.queue-action-error{color:var(--error,#be6b6b)}.queue-confirmation{margin:auto;max-width:min(420px,calc(100vw - 32px));padding:24px;border:1px solid var(--border,var(--surface-outline,#e5e9ef));border-radius:12px;background:var(--surface-raised,var(--panel-bg,#fff));color:var(--text-1,#536172)}.queue-confirmation::backdrop{background:var(--scrim,#15203355)}.queue-confirmation h3{margin:0 0 14px;font-size:16px}.queue-confirmation p{font-size:12px;line-height:1.8;color:var(--text-2,#8290a0)}.queue-confirmation label{display:flex;align-items:center;gap:8px;margin:20px 0;font-size:12px}.queue-confirmation input{accent-color:var(--accent,#f58b36)}.queue-confirmation footer{display:flex;justify-content:flex-end;gap:10px}.queue-confirmation button{font-size:12px;padding:8px 12px}
</style>
