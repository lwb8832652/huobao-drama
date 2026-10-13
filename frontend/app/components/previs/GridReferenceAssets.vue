<script setup lang="ts">
import { computed } from 'vue'
import { mediaUrl, type GridReferenceManifest } from '~/composables/usePrevis'
const props = defineProps<{ manifest?: GridReferenceManifest; loading?: boolean; error?: string; frozen?: boolean }>()
const items = computed(() => props.manifest?.items || [])
</script>
<template>
  <section class="grid-reference-assets" data-testid="grid-reference-assets">
    <div class="reference-heading"><strong>{{ frozen ? '本次使用素材' : '参考素材' }} <span>{{ items.length }} 张</span></strong><span v-if="loading">正在读取…</span></div>
    <div v-if="items.length" class="reference-strip">
      <figure v-for="(item, index) in items" :key="`${index}-${item.url}`" :title="item.label" :class="{ boundary: item.kind === 'continuity', missing: !item.url }">
        <img v-if="item.url" :src="mediaUrl(item.url)" :alt="item.label"><span v-else class="reference-missing">缺图</span>
        <figcaption><b>{{ index + 1 }}</b>{{ item.kind === 'continuity' ? '上镜末格' : item.label }}</figcaption>
      </figure>
    </div>
    <p v-if="error || manifest?.error" class="reference-error" role="alert">{{ error || manifest?.error }}</p>
    <p v-if="manifest?.continuity" class="reference-boundary">{{ manifest.continuity.reason }}</p>
    <p v-if="manifest?.continuityStale" class="reference-error">{{ manifest.continuityStaleReason || '衔接参考已变化，请检查当前画面' }}</p>
  </section>
</template>
<style scoped>
.grid-reference-assets { min-width: 0; padding: 9px 0; color: var(--text-2); font-size: 11px; }
.reference-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.reference-heading strong { color: var(--text-1); font-weight: 600; }
.reference-heading strong span { color: var(--text-3); font-weight: 400; }
.reference-strip { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 3px; }
.reference-strip figure { flex: 0 0 72px; margin: 0; min-width: 0; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; background: var(--surface-soft); }
.reference-strip img, .reference-missing { display: block; width: 100%; height: 45px; object-fit: contain; }
.reference-missing { display: grid; place-items: center; color: var(--error); }
.reference-strip figcaption { padding: 4px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 10px; }
.reference-strip b { margin-right: 4px; font-weight: 600; }
.reference-strip .boundary { border-color: var(--accent); }
.reference-error { color: var(--error); margin: 5px 0 0; line-height: 1.5; }
.reference-boundary { margin: 5px 0 0; line-height: 1.5; }
</style>
