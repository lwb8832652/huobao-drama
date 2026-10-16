import { toast } from 'vue-sonner'
import { api } from './useApi'
import { toastError } from './useToast'
import { i18n } from './i18n'

export function useAgent() {
  const running = ref(false)
  const runningType = ref<string | null>(null)

  async function run(type: string, msg: string, dramaId: number, episodeId: number, onDone?: (data?: any) => void | Promise<void>, model?: string, configId?: number) {
    if (running.value) { toast.warning(i18n.global.t('composables.agent.busy')); return }
    running.value = true
    runningType.value = type
    try {
      const data = await api.post<any>(`/agent/${type}/chat`, {
        message: msg,
        drama_id: dramaId,
        episode_id: episodeId,
        model: model || undefined,
        config_id: configId || undefined,
      })
      await onDone?.(data)
      if (data?.quality?.status === 'needs_attention') toast.warning(`分镜已拆分，${data.quality.issueCount || 0} 项规划问题待处理，请查看评测`)
      else if (data?.quality?.status === 'awaiting_prompts') toast.warning('分镜已拆分，提示词补齐后会完成质检，请查看评测')
      else toast.success(i18n.global.t('composables.agent.done'))
    } catch (err: any) {
      toastError(err)
    } finally {
      running.value = false
      runningType.value = null
    }
  }

  return { running, runningType, run }
}
