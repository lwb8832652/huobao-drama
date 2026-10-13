<script setup lang="ts">
import { type VideoContinuityCapabilities, type VideoContinuityMode } from '~/composables/usePrevis'
defineProps<{ modelValue: VideoContinuityMode; capability?: VideoContinuityCapabilities; disabled?: boolean; actual?: string; fallbackReason?: string; error?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: VideoContinuityMode] }>()
</script>
<template>
  <div class="video-continuity-control" data-testid="video-continuity-control">
    <label><span>视频衔接</span><select :value="modelValue" :disabled="disabled || !capability" aria-label="视频衔接方式" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value as VideoContinuityMode)">
      <option value="auto">自动选择</option><option value="reference">画面参考</option><option value="first_last" :disabled="!capability?.firstLast">首尾帧</option>
    </select></label>
    <p v-if="error" class="continuity-error">{{ error }}</p>
    <p v-else-if="!capability">正在读取模型能力…</p>
    <p v-else-if="actual === 'first_last'">首画面固定开场，末画面固定结尾；连续动作可共用前镜末画面。</p>
    <p v-else-if="fallbackReason">{{ fallbackReason }}</p>
    <p v-else>{{ capability.reason }}</p>
  </div>
</template>
<style scoped>
.video-continuity-control { padding: 8px 0; min-width: 0; font-size: 11px; color: var(--text-2); }
label { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
select { min-height: 30px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-input); color: var(--text-0); font: inherit; }
p { margin: 5px 0 0; line-height: 1.6; }
.continuity-error { color: var(--error); }
</style>
