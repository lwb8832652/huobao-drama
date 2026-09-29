import { Hono } from 'hono'
import { z } from 'zod'
import { success, created } from '../utils/response.js'
import {
  createVersion, getVersion, getVersionState, getWorkspace, getWorkspaceState,
  listVersions, saveTimeline, checkOrLock, PrevisError,
} from '../services/previs.js'
import { createBatch, updateBatch, videoCapabilities } from '../services/previs-batch.js'
import { listContinuityReviews, reviewContinuity } from '../services/continuity-review.js'

const app = new Hono()
const positiveId = z.number().int().positive()
const revision = z.number().int().positive()
app.onError((err, c) => {
  const status = err instanceof PrevisError ? err.status : 400
  const message = err instanceof z.ZodError ? `请求数据无效：${err.issues[0]?.message}` : err.message
  return c.json({ code: status, message }, status)
})
app.get('/previs/capabilities', c => success(c, { enabled: process.env.PREVIS_ENABLED !== 'false', video: videoCapabilities }))
app.get('/episodes/:id/animatic-versions', c => success(c, listVersions(Number(c.req.param('id')))))
app.get('/episodes/:id/production-workspace', c => success(c, getWorkspace(Number(c.req.param('id')))))
app.get('/episodes/:id/production-workspace-state', c => success(c,
  getWorkspaceState(Number(c.req.param('id')), Number(c.req.query('version_id')))))
app.post('/episodes/:id/animatic-versions', async c => {
  const body = z.object({ sourceId: positiveId.optional() }).parse(await c.req.json())
  return created(c, createVersion(Number(c.req.param('id')), body.sourceId))
})
app.get('/animatic-versions/:id/timeline', c => success(c, getVersion(Number(c.req.param('id')))))
app.get('/animatic-versions/:id/state', c => success(c, getVersionState(Number(c.req.param('id')))))
app.get('/animatic-versions/:id/continuity-reviews', c =>
  success(c, listContinuityReviews(Number(c.req.param('id')))))
app.put('/animatic-versions/:id/timeline', async c => {
  const body = z.object({ revision, timeline: z.unknown() }).parse(await c.req.json())
  return success(c, saveTimeline(Number(c.req.param('id')), body.revision, body.timeline))
})
app.post('/animatic-versions/:id/continuity-reviews', async c => {
  const body = z.object({
    revision,
    toGroupId: z.string().min(1).max(100),
    configId: positiveId.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    force: z.boolean().optional(),
  }).parse(await c.req.json())
  return created(c, await reviewContinuity(Number(c.req.param('id')), body))
})
for (const action of ['check', 'lock'] as const) {
  app.post(`/animatic-versions/:id/${action}`, async c => {
    const body = z.object({ revision }).parse(await c.req.json())
    return success(c, checkOrLock(Number(c.req.param('id')), body.revision, action === 'lock'))
  })
}
app.post('/animatic-versions/:id/batch-runs', async c => {
  const body = z.object({
    revision, type: z.enum(['image', 'video']), configId: positiveId.optional(), model: z.string().max(200).optional(),
    panelIds: z.array(positiveId).max(1000).optional(),
    frameTypes: z.array(z.enum(['start', 'middle', 'end', 'beat'])).min(1).max(4).optional(),
    frameIds: z.array(z.string().min(1).max(100)).min(1).max(1000).optional(), force: z.boolean().optional(),
    generationMode: z.enum(['direct', 'storyboard_frames']).optional(),
  }).parse(await c.req.json())
  if (process.env.PREVIS_ENABLED === 'false') throw new PrevisError('动态故事版功能已关闭')
  return created(c, await createBatch(Number(c.req.param('id')), body))
})
for (const action of ['retry', 'cancel'] as const) {
  app.post(`/batch-runs/:id/${action}`, async c => {
    const body = z.object({ itemIds: z.array(positiveId).optional() }).parse(await c.req.json())
    return success(c, updateBatch(Number(c.req.param('id')), action, body.itemIds))
  })
}
export default app
