/** Read-only queue presentation shared by production and evaluation lists. */
export type QueueKind = 'image' | 'video' | 'evaluation' | 'planning' | 'local'
export interface QueueCounts { active: number; pending: number }
export interface QueueStats extends QueueCounts { byKind?: Partial<Record<QueueKind, QueueCounts>> }
export interface QueueMetadata { queueJobId?: number; phase?: string; queueReason?: string | null; canCancel?: boolean; canRetry?: boolean }
export type QueueFilter = 'all' | 'active' | 'completed' | 'failed'
export function queueStatusLabel(row: QueueMetadata & { status: string }) {
  if (row.status === 'completed') return '已完成'
  if (row.status === 'failed') return '失败'
  if (row.status === 'cancelled') return '已取消'
  const phases: Record<string, string> = {
    waiting_dependency: '等待前置任务', retry_wait: '限流后等待重试', submitting: '进行中', upstream: '进行中', polling: '进行中',
    saving: '保存结果中', saving_result: '保存结果中', needs_confirmation: '需核对提交状态',
  }
  return phases[row.phase || ''] || (row.status === 'pending' ? '排队中' : '进行中')
}
export function filterQueueRows<T extends { status: string }>(rows: T[], filter: QueueFilter): T[] {
  return filter === 'all' ? rows : rows.filter(row => filter === 'active' ? ['pending', 'processing'].includes(row.status) : row.status === filter)
}
export function canDeleteQueueRecord(row: { status: string }) { return ['completed', 'failed', 'cancelled'].includes(row.status) }
