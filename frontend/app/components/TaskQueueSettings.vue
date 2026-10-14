<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { aiConfigAPI } from '~/composables/useApi'
import { useTaskQueueSettings } from '~/composables/useTaskQueueSettings'
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const { draft, saved, stats, dirty, loading, saving, error, conflict, message, load, refresh, save } = useTaskQueueSettings()
const dialog = ref<HTMLDialogElement>(), configs = ref<{ id: number; name: string; provider?: string }[]>([]), configError = ref('')
const advanced = ref(false)
const fields = [{ key: 'total', label: '后台任务总并发', hint: '全服务上限，包含制作任务与评测任务。' }, { key: 'image', label: '图片并发', hint: '普通生图、宫格生成与画面精修。' }, { key: 'video', label: '视频并发', hint: '包含等待服务商处理的生成任务。' }] as const
const extraFields = [{ key: 'planning', label: 'AI 画面规划并发' }, { key: 'local', label: '本地处理并发' }] as const
const exceeded = computed(() => !!saved.value && (stats.value.active > saved.value.total || [...fields.slice(1), ...extraFields].some(field => (stats.value.byKind?.[field.key as 'image' | 'video' | 'planning' | 'local']?.active || 0) > saved.value![field.key])))
let timer: ReturnType<typeof setInterval> | undefined, opener: HTMLElement | null = null, disposed = false
async function loadConfigs() {
  try { const result = await aiConfigAPI.list(); if (!disposed) { configs.value = Array.isArray(result) ? result : result.items || []; configError.value = '' } }
  catch { if (!disposed) configError.value = '模型配置暂时无法载入，现有关联已保留。' }
}
function addGroup() { draft.value.quotaGroups.push({ id: `quota-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: '', limit: 1, configIds: [] }); advanced.value = true }
watch(() => props.open, async open => {
  clearInterval(timer)
  if (open) {
    opener = typeof document === 'undefined' ? null : document.activeElement as HTMLElement
    if (saved.value) void refresh(); else void load()
    void loadConfigs(); await nextTick(); if (props.open && !dialog.value?.open) dialog.value?.showModal()
    timer = setInterval(refresh, 4000)
  } else { dialog.value?.close(); opener?.focus() }
}, { immediate: true })
onUnmounted(() => { disposed = true; clearInterval(timer); dialog.value?.close() })
function close() { emit('close') }
</script>
<template>
  <Teleport to="body">
    <dialog ref="dialog" class="task-queue-dialog" aria-labelledby="task-queue-title" @cancel.prevent="close" @close="!dialog?.open && props.open && close()" @click="($event.target === dialog) && close()" @keydown.esc.stop>
      <form class="task-queue-form" @submit.prevent="save">
        <header><div><h2 id="task-queue-title">任务设置</h2><p>全局设置 · 对所有项目生效</p></div><button type="button" class="queue-close" aria-label="关闭任务设置" @click="close"><X :size="18" /></button></header>
        <section class="task-queue-body" :aria-busy="loading">
          <p v-if="error" class="queue-notice" role="alert">{{ error }}<button v-if="conflict || !saved" type="button" :disabled="loading || saving" @click="load">{{ conflict ? '舍弃草稿并重新载入' : '重新加载' }}</button></p>
          <p v-if="!saved && loading" role="status">正在读取全局任务设置…</p>
          <div v-if="saved" class="queue-statistics" aria-label="全服务队列状态"><strong>全服务</strong><span>执行 {{ stats.active }} / {{ saved.total }}</span><span>排队 {{ stats.pending }}</span><span v-if="exceeded" class="queue-wait">等待已有任务完成</span></div>
          <fieldset :disabled="!saved || loading || saving">
            <div v-for="field in fields" :key="field.key" class="queue-field"><div><label :for="`queue-${field.key}`">{{ field.label }}</label><p>{{ field.hint }}</p><small v-if="field.key !== 'total'">全局执行 {{ stats.byKind?.[field.key]?.active || 0 }} / {{ saved?.[field.key] || '—' }} · 排队 {{ stats.byKind?.[field.key]?.pending || 0 }}</small></div><input :id="`queue-${field.key}`" v-model.number="draft[field.key]" type="number" min="1" max="32" step="1" required></div>
            <div class="queue-field"><div><label for="queue-paused">暂停制作队列</label><p>暂停所有项目的图片、视频、画面规划与本地处理排队任务；执行中任务继续。</p></div><input id="queue-paused" v-model="draft.paused" type="checkbox" role="switch"></div>
            <details :open="advanced" @toggle="advanced = ($event.target as HTMLDetailsElement).open"><summary>高级设置</summary>
              <div v-for="field in extraFields" :key="field.key" class="queue-field"><div><label :for="`queue-${field.key}`">{{ field.label }}</label><p>全局执行 {{ stats.byKind?.[field.key]?.active || 0 }} / {{ saved?.[field.key] || '—' }} · 排队 {{ stats.byKind?.[field.key]?.pending || 0 }}</p></div><input :id="`queue-${field.key}`" v-model.number="draft[field.key]" type="number" min="1" max="32" step="1" required></div>
              <div class="queue-groups-title"><div><h3>服务商配额组</h3><p>同一账号的多个模型配置可共享并发上限，也约束组内的评测模型。</p></div><button type="button" class="btn btn-sm" @click="addGroup">添加配额组</button></div>
              <p v-if="configError" class="queue-notice" role="alert">{{ configError }}<button type="button" @click="loadConfigs">重新加载</button></p>
              <section v-for="(group, index) in draft.quotaGroups" :key="group.id" class="queue-group"><div class="queue-group-head"><label>名称<input v-model="group.name" :aria-label="`配额组 ${index + 1} 名称`" maxlength="80" required placeholder="如：主账号"></label><label>并发<input v-model.number="group.limit" :aria-label="`配额组 ${index + 1} 并发`" type="number" min="1" max="32" step="1" required></label><button type="button" class="queue-close" :aria-label="`移除配额组 ${group.name || index + 1}`" @click="draft.quotaGroups.splice(index, 1)"><X :size="15" /></button></div><fieldset class="queue-configs"><legend>关联模型配置</legend><label v-for="config in configs" :key="config.id"><input v-model="group.configIds" type="checkbox" :value="config.id">{{ config.name || config.provider || '模型配置' }} #{{ config.id }}</label><span v-for="id in group.configIds.filter(id => !configs.some(config => config.id === id))" :key="id">已关联配置 #{{ id }}（暂不可用）<button type="button" @click="group.configIds = group.configIds.filter(value => value !== id)">移除</button></span><p v-if="!configs.length && !group.configIds.length">暂无可关联的模型配置</p></fieldset></section>
            </details>
          </fieldset>
          <p class="queue-footnote">各类别上限与总上限同时生效。下调只限制后续任务，已执行任务继续。浏览与刷新不会调用模型。</p>
        </section>
        <footer><span role="status">{{ saving ? '保存中…' : dirty ? '设置尚未保存' : message || (saved ? '当前设置已生效' : '设置未载入') }}</span><button class="btn btn-primary" type="submit" :disabled="!saved || loading || saving || !dirty || conflict">保存任务设置</button></footer>
      </form>
    </dialog>
  </Teleport>
</template>
<style scoped>
.task-queue-dialog{position:fixed;inset:0;margin:auto;max-width:calc(100vw - 24px);width:min(620px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--border,var(--panel-border,#e5e9f0));border-radius:16px;background:var(--surface-raised,var(--panel-bg,#fff));color:var(--text-1,#536172);box-shadow:var(--shadow-xl,0 20px 80px #15203333);font-size:13px;overflow:hidden}
.task-queue-dialog::backdrop{background:var(--scrim,#15203355);backdrop-filter:blur(5px)}
.task-queue-form{display:flex;flex-direction:column;max-height:calc(100dvh - 34px)}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px;flex-shrink:0}header{border-bottom:1px solid var(--border,var(--surface-outline,#e7ebf1))}h2{margin:0;font-size:17px;color:var(--text-0,#354253)}p{font-size:11px;color:var(--text-2,#8290a0);line-height:1.8;margin:5px 0}header p{margin-bottom:0}footer{border-top:1px solid var(--border,var(--surface-outline,#e7ebf1));font-size:11px;color:var(--text-2,#8290a0)}
.task-queue-body{padding:0 24px 18px;overflow-y:auto;min-height:0}fieldset{border:0;margin:0;padding:0;min-width:0}.queue-field{display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid var(--border,var(--surface-outline,#e7ebf1));padding:18px 0}.queue-field>div{min-width:0;max-width:420px}.queue-field label{font-weight:500}.queue-field small{color:var(--text-3,#94a0af);font-size:10px}.queue-field input[type=number],.queue-group input{box-sizing:border-box;border:1px solid var(--border,var(--surface-outline,#dfe5ed));background:var(--surface-input,var(--bg-hover,#fafbfc));color:var(--text-1,#536172);border-radius:8px;padding:9px;font:inherit}.queue-field input[type=number]{width:68px;flex-shrink:0}input[type=checkbox]{accent-color:var(--accent,#f58b36);width:17px;height:17px;flex-shrink:0}button,input,summary{outline-offset:3px}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--accent,#f58b36)}:disabled{opacity:.5;cursor:not-allowed}.queue-close{display:grid;place-items:center;width:30px;height:30px;background:transparent;border:0;border-radius:8px;color:var(--text-2,#8290a0);cursor:pointer}.queue-close:hover{background:var(--surface-soft,var(--bg-hover,#f3f5f8))}
.queue-statistics{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;padding:12px;background:var(--surface-soft,var(--bg-hover,#f3f5f8));border-radius:9px;font-size:11px}.queue-statistics strong{font-weight:500}.queue-wait{color:var(--warning,#ad7839)}.queue-notice{border-radius:8px;background:var(--warning-bg,#fff7ee);color:var(--warning,#ad7839);padding:10px 12px}.queue-notice button,.queue-configs span button{color:inherit;background:transparent;border:0;text-decoration:underline;cursor:pointer;font:inherit;margin-left:6px}.queue-footnote{margin-top:20px}details{padding-top:18px}summary{cursor:pointer;color:var(--text-1,#536172)}.queue-groups-title{display:flex;align-items:center;gap:14px;justify-content:space-between;margin-top:22px}h3{font-size:13px;margin:0}.queue-group{padding:14px;margin-top:12px;border:1px solid var(--border,var(--surface-outline,#e5e9f0));border-radius:10px}.queue-group-head{display:flex;align-items:flex-end;gap:12px}.queue-group-head label{display:flex;flex-direction:column;gap:8px;min-width:0;font-size:11px}.queue-group-head label:first-child{flex:1}.queue-group-head input{width:100%}.queue-group-head input[type=number]{width:65px}.queue-configs{display:flex;flex-direction:column;gap:8px;margin-top:14px;font-size:11px;color:var(--text-2,#8290a0)}.queue-configs legend{padding:0 0 8px}.queue-configs label{display:flex;gap:7px;align-items:center}.queue-configs span{overflow-wrap:anywhere}
@media(max-width:600px){header,footer{padding:17px}.task-queue-body{padding:0 17px 16px}.queue-field{gap:12px}.queue-group{padding:10px}.queue-group-head{gap:8px}.queue-groups-title{align-items:flex-start}.task-queue-dialog{border-radius:12px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style>
