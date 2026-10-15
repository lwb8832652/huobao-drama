<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue'
import { X } from 'lucide-vue-next'
import { mediaUrl, type GridReferenceManifest } from '~/composables/usePrevis'
const props = defineProps<{ manifest?: GridReferenceManifest; loading?: boolean; error?: string; frozen?: boolean }>()
const items = computed(() => props.manifest?.items || [])
const preview = ref<{ url: string; label: string }>(), dialog = ref<HTMLDialogElement>(), titleId = useId()
let disposed = false
function previewReference(item: { url: string | null; label: string }) {
  if (!item.url) return
  preview.value = { url: item.url, label: item.label }
  void nextTick(() => { if (!disposed && preview.value && !dialog.value?.open) dialog.value?.showModal() })
}
function closePreview() { dialog.value?.close(); preview.value = undefined }
onBeforeUnmount(() => { disposed = true; dialog.value?.close() })
</script>
<template>
  <section class="grid-reference-assets" data-testid="grid-reference-assets">
    <div class="reference-heading">
      <strong>{{ frozen ? '本次使用素材' : '参考素材' }} <span :title="frozen ? '生成本次候选实际使用的参考图' : '实际生图参考，包含自动衔接图并合并重复图片'">{{ items.filter(item => item.url).length }} 张</span></strong>
      <div class="reference-heading-actions"><span v-if="loading">正在读取…</span><slot v-if="!frozen" name="actions" /></div>
    </div>
    <div v-if="items.length" class="reference-strip">
      <figure v-for="(item, index) in items" :key="`${index}-${item.url}`" :title="item.label" :class="{ boundary: item.kind === 'continuity', missing: !item.url }">
        <button v-if="item.url" type="button" class="reference-preview" :aria-label="`预览参考图 ${index + 1}：${item.label}`" @click="previewReference(item)"><img :src="mediaUrl(item.url)" :alt="item.label" loading="lazy"></button><span v-else class="reference-missing">缺图</span>
        <figcaption><b>{{ index + 1 }}</b>{{ item.kind === 'continuity' ? '上镜末格' : item.label }}<span v-if="item.kind === 'continuity'" class="reference-auto">自动</span></figcaption>
      </figure>
    </div>
    <p v-else-if="!loading && !frozen" class="reference-empty">选择角色、场景或道具，为分镜画面提供统一参考。</p>
    <p v-if="error || manifest?.error" class="reference-error" role="alert">{{ error || manifest?.error }}</p>
    <p v-if="manifest?.continuity" class="reference-boundary">{{ manifest.continuity.reason }}</p>
    <p v-if="manifest?.continuityStale" class="reference-error">{{ manifest.continuityStaleReason || '衔接参考已变化，请检查当前画面' }}</p>
  </section>
  <Teleport to="body"><dialog v-if="preview" ref="dialog" class="reference-preview-dialog" :aria-labelledby="titleId" @cancel.prevent="closePreview" @click.self="closePreview" @keydown.stop>
    <header><strong :id="titleId">{{ preview.label }}</strong><button type="button" class="btn btn-icon" aria-label="关闭参考图预览" @click="closePreview"><X :size="18" /></button></header>
    <img :src="mediaUrl(preview.url)" :alt="preview.label">
  </dialog></Teleport>
</template>
<style scoped>
.grid-reference-assets { min-width: 0; padding: 9px 0; color: var(--text-2); font-size: 11px; }
.reference-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 9px; }
.reference-heading-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.reference-heading strong { color: var(--text-1); font-weight: 600; }
.reference-heading strong span { color: var(--text-3); font-weight: 400; }
.reference-strip { display: flex; gap: 7px; overflow-x: auto; padding-bottom: 3px; }
.reference-strip figure { flex: 0 0 72px; margin: 0; min-width: 0; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; background: var(--surface-soft); }
.reference-strip img, .reference-missing { display: block; width: 100%; height: 45px; object-fit: contain; }
.reference-preview { display: block; width: 100%; border: 0; padding: 0; background: transparent; cursor: zoom-in; }
.reference-preview:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.reference-auto { margin-left: 3px; color: var(--accent); font-size: 9px; }
.reference-empty { margin: 8px 0; color: var(--text-3); line-height: 1.5; }
.reference-missing { display: grid; place-items: center; color: var(--error); }
.reference-strip figcaption { padding: 4px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 10px; }
.reference-strip b { margin-right: 4px; font-weight: 600; }
.reference-strip .boundary { border-color: var(--accent); }
.reference-error { color: var(--error); margin: 5px 0 0; line-height: 1.5; }
.reference-boundary { margin: 5px 0 0; line-height: 1.5; }
.reference-preview-dialog { width: min(960px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); margin: auto; padding: 0; border: 1px solid var(--border); border-radius: 14px; background: var(--surface-raised); color: var(--text-0); }
.reference-preview-dialog::backdrop { background: #10182866; backdrop-filter: blur(4px); }
.reference-preview-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 18px; font-size: 13px; }
.reference-preview-dialog > img { display: block; width: 100%; max-height: calc(100dvh - 130px); object-fit: contain; background: var(--surface-soft); }
</style>
