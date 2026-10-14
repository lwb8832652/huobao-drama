import { computed, ref } from 'vue'
import { api } from './useApi'
import type { QueueStats } from './useTaskQueue'
export interface TaskQuotaGroup { id: string; name: string; limit: number; configIds: number[] }
export interface ProductionQueueDraft { total: number; image: number; video: number; planning: number; local: number; paused: boolean; quotaGroups: TaskQuotaGroup[] }
export interface ProductionQueueSettings extends ProductionQueueDraft { revision: number; stats: QueueStats }
const defaults = (): ProductionQueueDraft => ({ total: 6, image: 2, video: 2, planning: 1, local: 1, paused: false, quotaGroups: [] })
function editable(settings: ProductionQueueDraft): ProductionQueueDraft {
  return { total: settings.total, image: settings.image, video: settings.video, planning: settings.planning, local: settings.local, paused: settings.paused,
    quotaGroups: settings.quotaGroups.map(group => ({ id: group.id, name: group.name, limit: group.limit, configIds: [...group.configIds] })) }
}
export function useTaskQueueSettings(client = api) {
  const draft = ref(defaults()), saved = ref<ProductionQueueSettings | null>(null), stats = ref<QueueStats>({ active: 0, pending: 0 })
  const loading = ref(false), saving = ref(false), error = ref(''), conflict = ref(false), message = ref('')
  const dirty = computed(() => !!saved.value && JSON.stringify(draft.value) !== JSON.stringify(editable(saved.value)))
  let requestToken = 0
  function accept(result: ProductionQueueSettings) { saved.value = result; draft.value = editable(result); stats.value = result.stats; conflict.value = false }
  async function load() {
    if (saving.value) return
    const token = ++requestToken; loading.value = true; error.value = ''; message.value = ''
    try { const result = await client.get<ProductionQueueSettings>('/settings/task-queue'); if (token === requestToken) accept(result) }
    catch (cause: any) { if (token === requestToken) error.value = cause.message || '读取任务设置失败' }
    finally { if (token === requestToken) loading.value = false }
  }
  async function refresh() {
    if (loading.value || saving.value) return
    const token = ++requestToken
    try {
      const result = await client.get<ProductionQueueSettings>('/settings/task-queue')
      if (token !== requestToken) return
      stats.value = result.stats
      if (!dirty.value && !conflict.value) accept(result)
    } catch (cause: any) { if (token === requestToken) error.value = cause.message || '读取全局队列状态失败' }
  }
  async function save() {
    if (saving.value || loading.value || !saved.value || conflict.value) return
    const fields = ['total', 'image', 'video', 'planning', 'local'] as const
    if (fields.some(key => !Number.isInteger(draft.value[key]) || draft.value[key] < 1 || draft.value[key] > 32)) { error.value = '并发须为 1–32 的整数'; return }
    const memberships = new Set<number>(), groupIds = new Set<string>()
    for (const group of draft.value.quotaGroups) {
      if (!group.id || groupIds.has(group.id) || !group.name.trim() || !Number.isInteger(group.limit) || group.limit < 1 || group.limit > 32 || !group.configIds.length) { error.value = '配额组须填写名称、1–32 的并发和至少一个模型配置'; return }
      groupIds.add(group.id)
      for (const id of group.configIds) {
        if (!Number.isInteger(id) || id < 1) { error.value = '模型配置编号须为正整数'; return }
        if (memberships.has(id)) { error.value = '同一模型配置不能重复关联到多个配额组'; return }
        memberships.add(id)
      }
    }
    ++requestToken; saving.value = true; error.value = ''; message.value = ''
    try { const result = await client.put<ProductionQueueSettings>('/settings/task-queue', { revision: saved.value.revision, ...editable(draft.value) }); accept(result); message.value = '任务设置已保存' }
    catch (cause: any) { conflict.value = cause.status === 409; error.value = conflict.value ? '任务设置已被其他页面修改。草稿已保留，请重新载入后再保存。' : cause.message || '保存任务设置失败' }
    finally { saving.value = false }
  }
  return { draft, saved, stats, dirty, loading, saving, error, conflict, message, load, refresh, save }
}
