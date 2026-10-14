<script setup lang="ts">
import { SlidersHorizontal } from 'lucide-vue-next'
defineProps<{ label: string }>()
</script>
<template><button class="queue-settings-button" type="button" :aria-label="label" :title="label"><SlidersHorizontal :size="15" :stroke-width="1.7" /></button></template>
<style scoped>
.queue-settings-button{border:1px solid transparent;background:transparent;color:var(--text-2,#8b97a7);width:30px;height:30px;display:grid;place-items:center;border-radius:8px;cursor:pointer;flex-shrink:0}
.queue-settings-button:hover{background:var(--surface-soft,var(--bg-hover,#f3f5f8));color:var(--text-0,#354253)}
.queue-settings-button:focus-visible{outline:2px solid var(--accent,#f58b36);outline-offset:2px}
</style>
