import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { cancelQueueJob, retryQueueJob, reconcileQueueJob, getQueueJobById, QueueError } from '../services/task-queue.js'

const app = new Hono()
app.post('/jobs/:id/:action', async c => {
  const id = Number(c.req.param('id')), action = c.req.param('action')
  if (!Number.isSafeInteger(id) || id < 1) return badRequest(c, '任务编号无效')
  if (!getQueueJobById(id)) return c.json({ code: 404, message: '任务不存在' }, 404)
  try {
    const job = action === 'cancel' ? cancelQueueJob(id) : action === 'retry' ? retryQueueJob(id)
      : action === 'reconcile' ? reconcileQueueJob(id, (await c.req.json().catch(() => ({}))).confirmedStopped === true) : null
    if (!job) return badRequest(c, '不支持的任务操作')
    return success(c, job)
  } catch (error: any) {
    const status = error instanceof QueueError ? error.status : 400
    return c.json({ code: status, message: error.message || '任务操作失败' }, status === 404 ? 404 : status === 409 ? 409 : 400)
  }
})
export default app
