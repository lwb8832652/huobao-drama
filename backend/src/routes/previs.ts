import { Hono } from 'hono'
import { z } from 'zod'
import { success, created } from '../utils/response.js'
import {
  createVersion, getVersion, getVersionState, getWorkspace, getWorkspaceState,
  listVersions, saveTimeline, checkOrLock, PrevisError,
} from '../services/previs.js'
import { videoContinuityCapabilities } from '../services/previs-video-continuity.js'
import { createBatch, updateBatch, videoCapabilities } from '../services/previs-batch.js'
import { listContinuityReviews, listContinuityReviewTasks, getContinuityReviewTask, enqueueContinuityReview, getContinuityReviewSettings, updateContinuityReviewSettings, readContinuityReviewStatus } from '../services/continuity-review.js'
import { scheduleContactSheets, readContactSheets, tickContactSheets } from '../services/previs-contact-sheets.js'
import { startFramePlan, listFramePlans, retryFramePlans } from '../services/previs-frames.js'
import { FRAME_COUNT_MIN, FRAME_COUNT_MAX } from '../services/previs-frame-contract.js'
import { readGridReferences } from '../services/previs-grid-references.js'
import { previewProductionRepair, applyProductionRepair } from '../services/shot-planning-repair.js'
import { checkProductionQuality, enqueueQualityReview, enqueueQualityOptimization, getProductionQualityTask, productionQualityStatus, applyQualityOptimization } from '../services/production-quality.js'
import { listEvaluationTasks } from '../services/evaluation-tasks.js'

import { gridCapabilities, listGridCandidates, startGridCandidates, adoptGridCandidate, discardGridCandidate, uploadGridCandidate, retryGridProcessing } from '../services/previs-grid.js'

const app = new Hono()
const positiveId = z.number().int().positive()
const revision = z.number().int().positive()
const frameCount = z.number().int().min(FRAME_COUNT_MIN).max(FRAME_COUNT_MAX)
app.onError((err, c) => {
  const status = err instanceof PrevisError ? err.status : 400
  const message = err instanceof z.ZodError ? `请求数据无效：${err.issues[0]?.message}` : err.message
  return c.json({ code: status, message }, status)
})
app.get('/previs/capabilities', c => success(c, { enabled: process.env.PREVIS_ENABLED !== 'false', video: videoCapabilities }))
app.get('/previs/video-continuity-capabilities', async c => success(c, await videoContinuityCapabilities(c.req.query('config_id') ? positiveId.parse(Number(c.req.query('config_id'))) : undefined, c.req.query('model'))))
app.get('/previs/grid-capabilities', async c => success(c, await gridCapabilities(c.req.query('config_id') ? Number(c.req.query('config_id')) : undefined, c.req.query('model'))))
app.get('/animatic-versions/:id/grid-references', c => success(c, readGridReferences(
  positiveId.parse(Number(c.req.param('id'))), positiveId.parse(Number(c.req.query('panel_id'))),
)))
app.get('/animatic-versions/:id/grid-candidates', c => success(c, { items: listGridCandidates(Number(c.req.param('id')), c.req.query('panel_id') ? Number(c.req.query('panel_id')) : undefined) }))
app.post('/animatic-versions/:id/grid-candidates', async c => {
  const body = z.object({ revision, panelIds: z.array(positiveId).min(1).max(200), mode: z.enum(['generate','grid_edit','frame_edit']),
    configId: positiveId.optional(), model: z.string().min(1).max(200).optional(), resolution: z.enum(['1K','2K','4K']).optional(),
    targetFrameIds: z.array(z.string().min(1).max(100)).min(1).max(9).optional(), instructions: z.record(z.string().max(100), z.string().max(5000)).optional(),
    instruction: z.string().max(5000).optional(), baseCandidateId: positiveId.optional(),
  }).parse(await c.req.json())
  if (process.env.PREVIS_ENABLED === 'false') throw new PrevisError('动态故事版功能已关闭')
  return created(c, await startGridCandidates(Number(c.req.param('id')), body))
})
app.post('/animatic-versions/:id/grid-candidates/upload', async c => {
  const body = z.object({ revision, panelId: positiveId, url: z.string().max(4000).regex(/^\/?static\//) }).parse(await c.req.json())
  return created(c, await uploadGridCandidate(Number(c.req.param('id')), body.revision, body.panelId, body.url))
})
app.post('/animatic-versions/:id/grid-candidates/:candidateId/adopt', async c => {
  const body = z.object({ revision }).parse(await c.req.json())
  return success(c, await adoptGridCandidate(Number(c.req.param('id')), Number(c.req.param('candidateId')), body.revision))
})
app.post('/animatic-versions/:id/grid-candidates/:candidateId/discard', c => success(c, discardGridCandidate(Number(c.req.param('id')), Number(c.req.param('candidateId')))))
app.post('/animatic-versions/:id/grid-candidates/:candidateId/process', async c => success(c, await retryGridProcessing(Number(c.req.param('id')), Number(c.req.param('candidateId')))))
app.get('/episodes/:id/animatic-versions', c => success(c, listVersions(Number(c.req.param('id')))))
app.get('/episodes/:id/production-workspace', c => success(c, getWorkspace(Number(c.req.param('id')))))
app.get('/episodes/:id/production-workspace-state', c => success(c,
  getWorkspaceState(Number(c.req.param('id')), Number(c.req.query('version_id')))))
app.post('/episodes/:id/animatic-versions', async c => {
  const body = z.object({ sourceId: positiveId.optional() }).parse(await c.req.json())
  return created(c, createVersion(Number(c.req.param('id')), body.sourceId))
})
app.get('/animatic-versions/:id/timeline', c => success(c, getVersion(Number(c.req.param('id')))))
app.get('/animatic-versions/:id/production-quality', c => success(c, productionQualityStatus(positiveId.parse(Number(c.req.param('id'))))))
app.post('/animatic-versions/:id/production-quality/check', async c => {
  const body=z.object({revision,ai:z.boolean().default(false),configId:positiveId.optional(),model:z.string().max(200).optional()}).parse(await c.req.json())
  const id=positiveId.parse(Number(c.req.param('id')))
  if(getVersion(id).revision!==body.revision)throw new PrevisError('版本已更新，请重新检查',409)
  return success(c,await checkProductionQuality(id,body))
})
app.post('/animatic-versions/:id/production-quality/reviews', async c => success(c, await enqueueQualityReview(
  positiveId.parse(Number(c.req.param('id'))),z.object({revision,configId:positiveId.optional(),model:z.string().max(200).optional()}).parse(await c.req.json()),
)))
app.get('/animatic-versions/:id/production-quality/tasks/:taskId', c => success(c,getProductionQualityTask(positiveId.parse(Number(c.req.param('taskId'))),positiveId.parse(Number(c.req.param('id'))))))
app.post('/animatic-versions/:id/production-quality/tasks/:taskId/optimize', async c => success(c, await enqueueQualityOptimization(
  positiveId.parse(Number(c.req.param('id'))),positiveId.parse(Number(c.req.param('taskId'))),
  z.object({inputHash:z.string().length(64),issueIds:z.array(z.string().min(1).max(200)).min(1).max(300),configId:positiveId.optional(),model:z.string().max(200).optional()}).parse(await c.req.json()),
)))
app.post('/animatic-versions/:id/production-quality/tasks/:taskId/apply', async c => success(c, await applyQualityOptimization(
  positiveId.parse(Number(c.req.param('id'))),positiveId.parse(Number(c.req.param('taskId'))),z.object({inputHash:z.string().length(64)}).parse(await c.req.json()),
)))
app.get('/animatic-versions/:id/evaluation-tasks',c=>success(c,listEvaluationTasks(positiveId.parse(Number(c.req.param('id'))),{
  page:c.req.query('page'),pageSize:c.req.query('pageSize'),status:c.req.query('status'),keyword:c.req.query('keyword'),type:c.req.query('type'),
})))
app.get('/animatic-versions/:id/state', c => success(c, getVersionState(Number(c.req.param('id')))))
const productionRepairOptions = z.object({ revision, panelIds: z.array(positiveId).min(1).max(200), maxSeconds: z.number().int().min(5).max(15).default(15) })
app.post('/animatic-versions/:id/production-plan/preview', async c => success(c, previewProductionRepair(
  positiveId.parse(Number(c.req.param('id'))), productionRepairOptions.parse(await c.req.json()),
)))
app.post('/animatic-versions/:id/production-plan/apply', async c => success(c, applyProductionRepair(
  positiveId.parse(Number(c.req.param('id'))), productionRepairOptions.extend({ inputHash: z.string().length(64) }).parse(await c.req.json()),
)))
app.get('/animatic-versions/:id/contact-sheets', c => success(c, { items: readContactSheets(Number(c.req.param('id'))) }))
app.post('/animatic-versions/:id/contact-sheets', async c => {
  const body = z.object({ revision, panelIds: z.array(positiveId).max(200).optional(), force: z.boolean().optional() }).parse(await c.req.json())
  const id = Number(c.req.param('id')), version = getVersion(id)
  if (version.revision !== body.revision) throw new PrevisError('版本已更新，请先刷新', 409)
  scheduleContactSheets(id, body.panelIds, body.force)
  void tickContactSheets()
  return success(c, { items: readContactSheets(id) })
})
app.post('/animatic-versions/:id/contact-sheets/:panelId/retry', async c => {
  const body = z.object({ revision }).parse(await c.req.json())
  const id = Number(c.req.param('id')), version = getVersion(id)
  if (version.revision !== body.revision) throw new PrevisError('版本已更新，请先刷新', 409)
  scheduleContactSheets(id, [Number(c.req.param('panelId'))], true)
  void tickContactSheets()
  return success(c, { items: readContactSheets(id) })
})
app.get('/previs/continuity-review-settings', c => success(c, getContinuityReviewSettings()))
app.put('/previs/continuity-review-settings', async c => success(c, updateContinuityReviewSettings(await c.req.json())))
app.get('/animatic-versions/:id/continuity-review-status', c => success(c, readContinuityReviewStatus(Number(c.req.param('id')))))
app.get('/animatic-versions/:id/continuity-review-tasks', c => success(c, listContinuityReviewTasks(
  positiveId.parse(Number(c.req.param('id'))), {
    page: c.req.query('page'), pageSize: c.req.query('pageSize'),
    status: c.req.query('status'), keyword: c.req.query('keyword'),
  },
)))
app.get('/animatic-versions/:id/continuity-review-tasks/:taskId', c => success(c, getContinuityReviewTask(
  positiveId.parse(Number(c.req.param('id'))), positiveId.parse(Number(c.req.param('taskId'))),
)))
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
  return created(c, await enqueueContinuityReview(Number(c.req.param('id')), body))
})
app.post('/animatic-versions/:id/frames/plan', async c => {
  const body = z.object({
    revision,
    panelIds: z.array(positiveId).min(1).max(200),
    count: frameCount.optional(),
    configId: positiveId.optional(),
    model: z.string().trim().min(1).max(200).optional(),
    force: z.boolean().optional(),
  }).parse(await c.req.json())
  return success(c, await startFramePlan(Number(c.req.param('id')), body))
})
app.get('/animatic-versions/:id/frames/plan', c =>
  success(c, listFramePlans(Number(c.req.param('id')))))
app.post('/animatic-versions/:id/frames/plan/retry', async c => {
  const body = z.object({ panelIds: z.array(positiveId).max(200).optional() }).parse(await c.req.json())
  return success(c, await retryFramePlans(Number(c.req.param('id')), body.panelIds))
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
    videoContinuityMode: z.enum(['auto', 'reference', 'first_last']).optional(),
    videoReferenceInputStrategy: z.enum(['auto', 'individual', 'contact_sheet']).optional(),
    generationScope: z.enum(['storyboard', 'group']).optional(),
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
