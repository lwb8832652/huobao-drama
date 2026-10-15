<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue'
import { Check, ImageOff, Images, Loader2, Pencil, Search, X } from 'lucide-vue-next'
import { mediaUrl } from '~/composables/usePrevis'
import { toggleReferenceSelection, type ReferenceAsset } from '~/composables/useStoryboardReferences'

const props = defineProps<{
  assets: ReferenceAsset[]
  title?: string
  editable: boolean
  save: (keys: string[]) => Promise<boolean>
}>()
const emit = defineEmits<{ 'generate-asset': [] }>()
const titleId = useId(), dialog = ref<HTMLDialogElement>()
const open = ref(false), saving = ref(false), error = ref('')
const selectedKeys = ref<string[]>([]), query = ref(''), kind = ref('all'), onlySelected = ref(false)
const preview = ref<ReferenceAsset>()
const boundCount = computed(() => props.assets.filter(asset => asset.bound).length)
const selectedAssets = computed(() => props.assets.filter(asset => selectedKeys.value.includes(asset.key)))
const missingCount = computed(() => selectedAssets.value.filter(asset => !asset.ready).length)
const filteredAssets = computed(() => props.assets.filter(asset => (kind.value === 'all' || asset.kind === kind.value)
  && (!onlySelected.value || selectedKeys.value.includes(asset.key))
  && `${asset.name} ${asset.meta || ''}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
const changed = computed(() => JSON.stringify([...selectedKeys.value].sort()) !== JSON.stringify(props.assets.filter(asset => asset.bound).map(asset => asset.key).sort()))
const filters = [{ key: 'all', label: '全部' }, { key: 'character', label: '角色' }, { key: 'scene', label: '场景' }, { key: 'prop', label: '道具' }]
let disposed = false
let originalBindings = ''
function openPicker() {
  if (!props.editable || saving.value) return
  selectedKeys.value = props.assets.filter(asset => asset.bound).map(asset => asset.key)
  originalBindings = JSON.stringify([...selectedKeys.value].sort())
  query.value = ''; kind.value = 'all'; onlySelected.value = false; error.value = ''; preview.value = undefined
  open.value = true
  void nextTick(() => { if (!disposed && open.value && !dialog.value?.open) dialog.value?.showModal() })
}
function closePicker() {
  if (saving.value) return
  dialog.value?.close(); open.value = false; preview.value = undefined
}
function toggleAsset(asset: ReferenceAsset) {
  if (!props.editable || saving.value) return
  selectedKeys.value = toggleReferenceSelection(selectedKeys.value, asset, props.assets)
  error.value = ''
}
async function saveSelection() {
  if (!props.editable || saving.value) return
  if (JSON.stringify(props.assets.filter(asset => asset.bound).map(asset => asset.key).sort()) !== originalBindings) {
    error.value = '素材绑定已在其他页面变更，请关闭窗口后重新选择'
    return
  }
  if (!changed.value) { closePicker(); return }
  saving.value = true; error.value = ''
  try {
    const saved = await props.save([...selectedKeys.value])
    if (disposed) return
    if (saved) { saving.value = false; closePicker() }
    else error.value = '保存失败，当前选择已保留，请重试'
  } catch (cause: any) {
    if (!disposed) error.value = cause?.message || '保存失败，当前选择已保留，请重试'
  } finally { if (!disposed) saving.value = false }
}
function generateAsset() {
  if (saving.value) return
  closePicker(); emit('generate-asset')
}
onBeforeUnmount(() => { disposed = true; dialog.value?.close() })
</script>

<template>
  <div class="reference-picker-control">
    <span class="reference-bound-count" :title="`本集共 ${assets.length} 项可选素材`">已绑定 <b>{{ boundCount }}</b> 项</span>
    <button type="button" class="btn btn-sm reference-picker-trigger" data-testid="reference-picker-trigger"
      :disabled="!editable" :title="editable ? '选择当前分镜使用的角色、场景和道具' : '当前版本已锁定或任务进行中，暂不可修改素材'" @click="openPicker">
      <Pencil :size="12" />编辑素材
    </button>
  </div>
  <Teleport to="body">
    <dialog v-if="open" ref="dialog" class="reference-picker-dialog" :aria-labelledby="titleId" @cancel.prevent="closePicker" @click.self="closePicker" @keydown.stop>
      <header class="reference-picker-head">
        <div class="reference-picker-title"><span class="reference-picker-icon"><Images :size="20" /></span><div><h2 :id="titleId">选择参考素材</h2><p>{{ title || '当前分镜' }} · 共 {{ assets.length }} 项可选</p></div></div>
        <button type="button" class="btn btn-icon" aria-label="关闭素材选择" :disabled="saving" @click="closePicker"><X :size="18" /></button>
      </header>
      <template v-if="!preview">
        <div class="reference-picker-filters">
          <label class="reference-search"><Search :size="15" /><input v-model="query" type="search" placeholder="搜索角色、场景、道具" aria-label="搜索参考素材" :disabled="saving"></label>
          <div class="reference-filter-row">
            <div class="reference-kind-tabs" role="group" aria-label="素材类型"><button v-for="filter in filters" :key="filter.key" type="button" :class="{ active: kind === filter.key }" :aria-pressed="kind === filter.key" :disabled="saving" @click="kind = filter.key">{{ filter.label }}</button></div>
            <label class="reference-selected-filter"><input v-model="onlySelected" type="checkbox" :disabled="saving">仅看已选 {{ selectedKeys.length }}</label>
          </div>
        </div>
        <div class="reference-picker-body">
          <p class="reference-picker-rule">场景单选，角色和道具可多选；单格参考单独管理</p>
          <div v-if="filteredAssets.length" class="reference-asset-grid">
            <article v-for="asset in filteredAssets" :key="asset.key" class="reference-asset-card" :class="{ selected: selectedKeys.includes(asset.key) }" :data-asset-key="asset.key">
              <button type="button" class="reference-asset-preview" :disabled="!asset.ready || saving" :aria-label="`预览${asset.name}`" @click="preview = asset">
                <img v-if="asset.ready" :src="mediaUrl(asset.imageUrl)" :alt="asset.name" loading="lazy"><span v-else><ImageOff :size="19" />暂无参考图</span>
              </button>
              <button type="button" class="reference-asset-choice" :aria-label="`选择${asset.name}`" :aria-pressed="selectedKeys.includes(asset.key)" :disabled="saving || !editable" @click="toggleAsset(asset)">
                <span class="reference-asset-copy"><strong>{{ asset.name }}</strong><small>{{ asset.typeLabel || filters.find(filter => filter.key === asset.kind)?.label }}<template v-if="asset.meta"> · {{ asset.meta }}</template></small><small v-if="!asset.ready" class="reference-asset-missing">缺少参考图</small></span>
                <span class="reference-choice-mark" :class="{ radio: asset.kind === 'scene' }"><Check v-if="selectedKeys.includes(asset.key)" :size="12" /></span>
              </button>
            </article>
          </div>
          <div v-else class="reference-picker-empty"><Search :size="24" /><strong>{{ assets.length ? '没有匹配的素材' : '本集暂无可选素材' }}</strong><span>{{ assets.length ? '试试其他关键词或筛选条件' : '先在资产制作中添加角色、场景或道具' }}</span><button v-if="!assets.length" type="button" class="btn btn-sm" @click="generateAsset">前往资产制作</button></div>
        </div>
      </template>
      <div v-else class="reference-large-preview"><button type="button" class="btn btn-sm" @click="preview = undefined">返回素材列表</button><img :src="mediaUrl(preview.imageUrl)" :alt="preview.name"><strong>{{ preview.name }}</strong></div>
      <footer class="reference-picker-foot">
        <div class="reference-save-summary"><strong>已选 {{ selectedKeys.length }} 项</strong><span v-if="missingCount" class="reference-missing-notice">{{ missingCount }} 项缺图，<button type="button" :disabled="saving" @click="generateAsset">前往补图</button></span><span v-else>保存后用于下次生成</span><p v-if="error" role="alert">{{ error }}</p></div>
        <div class="reference-picker-buttons"><button type="button" class="btn" :disabled="saving" @click="closePicker">取消</button><button type="button" class="btn btn-primary" :disabled="saving || !editable" @click="saveSelection"><Loader2 v-if="saving" :size="14" class="reference-saving" />{{ saving ? '保存中…' : '保存选择' }}</button></div>
      </footer>
    </dialog>
  </Teleport>
</template>

<style scoped>
.reference-picker-control { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
.reference-bound-count { color: var(--text-3); font-size: 11px; white-space: nowrap; }
.reference-bound-count b { color: var(--text-2); font-weight: 600; }
.reference-picker-trigger { gap: 5px; }
.reference-picker-dialog { width: min(740px, calc(100vw - 32px)); max-height: min(780px, calc(100dvh - 48px)); margin: auto; padding: 0; border: 1px solid var(--border); border-radius: 18px; background: var(--surface-raised); color: var(--text-1); box-shadow: 0 24px 80px #17203330; }
.reference-picker-dialog[open] { display: flex; flex-direction: column; }
.reference-picker-dialog::backdrop { background: #10182866; backdrop-filter: blur(4px); }
.reference-picker-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px 24px; border-bottom: 1px solid var(--border); }
.reference-picker-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.reference-picker-icon { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 12px; background: var(--accent-bg); color: var(--accent); flex-shrink: 0; }
.reference-picker-title h2 { margin: 0; font-size: 17px; font-weight: 650; }
.reference-picker-title p { margin: 5px 0 0; font-size: 12px; color: var(--text-3); }
.reference-picker-filters { padding: 18px 24px 0; }
.reference-search { display: flex; align-items: center; gap: 9px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; color: var(--text-3); background: var(--surface-soft); }
.reference-search:focus-within { border-color: var(--accent); }
.reference-search input { width: 100%; min-width: 0; border: 0; outline: 0; padding: 0; font: inherit; font-size: 12px; color: var(--text-1); background: transparent; }
.reference-filter-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 14px; flex-wrap: wrap; }
.reference-kind-tabs { display: flex; gap: 4px; background: var(--surface-soft); padding: 4px; border-radius: 9px; }
.reference-kind-tabs button { border: 0; padding: 6px 15px; border-radius: 6px; background: transparent; color: var(--text-2); font-size: 12px; cursor: pointer; }
.reference-kind-tabs button.active { color: var(--accent); background: var(--surface-raised); box-shadow: 0 1px 3px #1720330d; font-weight: 600; }
.reference-selected-filter { display: flex; align-items: center; gap: 6px; color: var(--text-2); font-size: 12px; cursor: pointer; }
.reference-selected-filter input { accent-color: var(--accent); }
.reference-picker-body { padding: 14px 24px 22px; overflow-y: auto; min-height: 160px; flex: 1; }
.reference-picker-rule { color: var(--text-3); margin: 0 0 12px; font-size: 11px; }
.reference-asset-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.reference-asset-card { display: flex; min-width: 0; padding: 8px; gap: 10px; border: 1px solid var(--border); border-radius: 11px; background: var(--surface-raised); transition: border-color .15s, background .15s; }
.reference-asset-card.selected { border-color: var(--accent); background: var(--accent-bg); }
.reference-asset-preview { display: grid; place-items: center; flex: 0 0 68px; width: 68px; height: 68px; border-radius: 7px; border: 1px solid var(--border); background: var(--surface-soft); overflow: hidden; padding: 0; cursor: zoom-in; }
.reference-asset-preview img { width: 100%; height: 100%; object-fit: contain; }
.reference-asset-preview > span { display: grid; justify-items: center; gap: 5px; color: var(--text-3); font-size: 9px; }
.reference-asset-choice { display: flex; align-items: center; justify-content: space-between; min-width: 0; flex: 1; gap: 8px; background: none; border: 0; padding: 0 3px 0 0; color: inherit; text-align: left; cursor: pointer; }
.reference-asset-copy { min-width: 0; display: grid; gap: 5px; }
.reference-asset-copy strong { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reference-asset-copy small { color: var(--text-3); font-size: 10px; }
.reference-asset-copy .reference-asset-missing { color: var(--warning, #b7791f); }
.reference-choice-mark { flex-shrink: 0; display: grid; place-items: center; width: 17px; height: 17px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface-raised); }
.reference-choice-mark.radio { border-radius: 50%; }
.selected .reference-choice-mark { border-color: var(--accent); background: var(--accent); color: white; }
.reference-picker-empty { display: grid; justify-items: center; gap: 10px; padding: 40px 0; color: var(--text-3); font-size: 12px; }
.reference-picker-empty strong { color: var(--text-2); font-weight: 500; }
.reference-picker-foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px; border-top: 1px solid var(--border); }
.reference-save-summary { display: flex; gap: 6px 12px; flex-wrap: wrap; align-items: center; font-size: 11px; min-width: 0; }
.reference-save-summary strong { font-weight: 600; font-size: 12px; }
.reference-save-summary > span { color: var(--text-3); }
.reference-save-summary p { flex-basis: 100%; margin: 0; color: var(--error); line-height: 1.5; }
.reference-save-summary .reference-missing-notice { color: var(--warning, #b7791f); }
.reference-missing-notice button { padding: 0; border: 0; background: none; color: var(--accent); font: inherit; cursor: pointer; }
.reference-picker-buttons { display: flex; gap: 8px; flex-shrink: 0; }
.reference-large-preview { padding: 20px 24px; min-height: 0; overflow: auto; display: flex; flex-direction: column; align-items: flex-start; gap: 14px; }
.reference-large-preview img { width: 100%; max-height: 440px; object-fit: contain; border-radius: 10px; background: var(--surface-soft); }
.reference-large-preview strong { font-size: 13px; }
.reference-picker-dialog button:disabled { cursor: default; opacity: .55; }
.reference-picker-dialog button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.reference-saving { animation: reference-spin 1s linear infinite; }
@keyframes reference-spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) {
  .reference-asset-grid { grid-template-columns: 1fr; }
  .reference-picker-head, .reference-picker-foot { padding: 16px; }
  .reference-picker-filters { padding: 14px 16px 0; }
  .reference-picker-body { padding: 14px 16px; }
  .reference-kind-tabs button { padding: 6px 10px; }
  .reference-picker-foot { align-items: flex-start; }
}
</style>
