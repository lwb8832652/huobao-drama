import { activateQueueJob, enqueueQueueJob, finishQueueJob, getQueueJob, resetQueueJob, registerQueueExecutor, tickTaskQueue, updateQueueJob, type QueueJob } from './task-queue.js'
import { readProductionSettings } from './task-queue-settings.js'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq, desc } from 'drizzle-orm'
import { db, getAffectedRows, schema } from '../db/index.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { normalizeTimeline } from './previs-domain.js'
import { contactSheetDescriptor, type ContactSheetDescriptor, type ContactSheetView } from './previs-contact-sheet-domain.js'
import { renderContactSheet } from './previs-contact-sheet-renderer.js'
import { freezeReferenceMedia, mediaDigest, readReferenceMedia } from './previs-reference-media.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()
export async function contactSheetSource(versionId: number) {
  const version = (await db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, versionId)).get())
  if (!version) throw new Error('工作版本不存在')
  const episode = (await db.select().from(schema.episodes).where(eq(schema.episodes.id, version.episodeId)).get())
  const drama = episode && (await db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).get())
  return { version, timeline: normalizeTimeline(JSON.parse(version.timelineJson)), aspectRatio: drama?.aspectRatio || '16:9' }
}
export async function readContactSheets(versionId: number): Promise<ContactSheetView[]> {
  const source = (await contactSheetSource(versionId))
  const rows = (await db.select().from(schema.frameContactSheets).where(eq(schema.frameContactSheets.versionId, versionId)).orderBy(desc(schema.frameContactSheets.id)).all())
  return source.timeline.panels.map(panel => {
    const readyFrames = panel.frames.filter(f => f.url).length
    let descriptor: ContactSheetDescriptor | null = null
    try { descriptor = contactSheetDescriptor(panel, source.aspectRatio) } catch {}
    const sourceHash = descriptor ? hash(descriptor) : ''
    const current = rows.find(row => row.panelId === panel.id && row.inputHash === sourceHash)
    const previous = rows.find(row => row.panelId === panel.id && row.status === 'completed')
    const status = !descriptor ? 'none' : !current ? previous ? 'stale' : 'none'
      : current.status === 'completed' ? 'ready' : current.status === 'failed' ? 'failed' : 'composing'
    return { panelId: panel.id, sourceHash, descriptor, status, readyFrames, totalFrames: panel.frames.length,
      artifactId: current?.id || null, artifactHash: current?.renderHash || null,
      // A stale image is never presented as a current reference.
      annotatedUrl: status === 'ready' ? current!.annotatedUrl : null,
      cleanUrl: status === 'ready' ? current!.cleanUrl : null,
      thumbnailUrl: status === 'ready' ? current!.thumbnailUrl : null,
      error: !descriptor && panel.frames.length > 9 ? '历史画面超过 9 张，请先整理' : current?.error || null }
  })
}
export async function scheduleContactSheets(versionId: number, panelIds?: number[], force = false) {
  const source = (await contactSheetSource(versionId))
  if (panelIds?.some(id => !source.timeline.panels.some(panel => panel.id === id))) throw new Error('分镜不属于当前版本')
  await db.transaction(async () => {
  for (const panel of source.timeline.panels) {
    if (panelIds && !panelIds.includes(panel.id)) continue
    if (!panel.frames.length || panel.frames.length > 9) continue
    const descriptor = contactSheetDescriptor(panel, source.aspectRatio), inputHash = hash(descriptor)
    const row = (await db.select().from(schema.frameContactSheets).where(and(eq(schema.frameContactSheets.versionId, versionId), eq(schema.frameContactSheets.panelId, panel.id), eq(schema.frameContactSheets.inputHash, inputHash))).get())
    if (row) {
      if (force && !['pending', 'processing'].includes(row.status)) await db.update(schema.frameContactSheets).set({ status: 'pending', attempt: row.attempt + 1, error: null, renderHash: null,
        cleanUrl: null, annotatedUrl: null, thumbnailUrl: null, updatedAt: now() }).where(eq(schema.frameContactSheets.id, row.id)).run()
    } else await db.insert(schema.frameContactSheets).values({ versionId, panelId: panel.id, inputHash,
      descriptorJson: JSON.stringify(descriptor), createdAt: now(), updatedAt: now() }).run()
    const scheduled = (await db.select().from(schema.frameContactSheets).where(and(eq(schema.frameContactSheets.versionId, versionId), eq(schema.frameContactSheets.panelId, panel.id), eq(schema.frameContactSheets.inputHash, inputHash))).get())!
    if (scheduled.status === 'pending') await enqueueSheet(scheduled)
  }
  })
}
type SheetRow = typeof schema.frameContactSheets.$inferSelect
type FrozenSheetSnapshot = { descriptor: ContactSheetDescriptor; references: ({ url: string; digest: string } | null)[] }
const activeSheets = new Set<Promise<void>>()
const preparingSheets = new Map<string, Promise<void>>()
async function enqueueSheet(row: SheetRow) {
  const version = (await db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, row.versionId)).get())
  const episode = version && (await db.select().from(schema.episodes).where(eq(schema.episodes.id, version.episodeId)).get())
  const input = { ownerType: 'contact_sheet' as const, ownerId: row.id, kind: 'local' as const,
    projectId: episode?.dramaId, inputHash: row.inputHash, snapshotJson: JSON.stringify({ descriptor: JSON.parse(row.descriptorJson) }), ready: false }
  const existing = (await getQueueJob('contact_sheet', row.id))
  if (!existing) (await enqueueQueueJob({ ...input, initialStatus: row.status === 'processing' ? 'processing' : 'pending' }))
  else if (row.status === 'pending' && ['failed', 'completed', 'cancelled'].includes(existing.status)) (await resetQueueJob('contact_sheet', row.id, input))
  const job = (await getQueueJob('contact_sheet', row.id))!
  if (job.status === 'pending' && !job.ready) prepareSheet(row)
}

async function freezeSheetSnapshot(row: SheetRow): Promise<FrozenSheetSnapshot> {
  const descriptor = JSON.parse(row.descriptorJson) as ContactSheetDescriptor
  const sources = new Map<string, ReturnType<typeof freezeReferenceMedia>>()
  const references = await Promise.all(descriptor.cells.map(async cell => {
    if (!cell.url) return null
    if (!sources.has(cell.url)) sources.set(cell.url, freezeReferenceMedia(cell.url))
    try { return await sources.get(cell.url)! }
    catch (error) { throw new Error(`画面 ${cell.index}（${cell.frameId}）读取失败：${(error as Error).message}`) }
  }))
  return { descriptor, references }
}

function prepareSheet(row: SheetRow) {
  const key = `${row.id}:${row.attempt}`
  if (preparingSheets.has(key)) return
  const preparation = Promise.resolve().then(async () => {
    try {
      const snapshot = await freezeSheetSnapshot(row)
      await db.transaction(async () => {
        const current = (await db.select().from(schema.frameContactSheets).where(eq(schema.frameContactSheets.id, row.id)).get())
        const job = (await getQueueJob('contact_sheet', row.id))
        if (!current || current.attempt !== row.attempt || current.status !== 'pending' || job?.status !== 'pending' || job.ready) return
        await updateQueueJob(job.id, { snapshotJson: JSON.stringify(snapshot) })
        await activateQueueJob('contact_sheet', row.id)
      })
    } catch (error) {
      ;await db.transaction(async () => {
        const job = (await getQueueJob('contact_sheet', row.id))
        const current = (await db.select().from(schema.frameContactSheets).where(eq(schema.frameContactSheets.id, row.id)).get())
        if (job?.status !== 'pending' || current?.status !== 'pending' || current.attempt !== row.attempt) return
        const message = `宫格合成失败：${(error as Error).message}`
        await db.update(schema.frameContactSheets).set({ status: 'failed', error: message, updatedAt: now() }).where(eq(schema.frameContactSheets.id, row.id)).run()
        await finishQueueJob(job.id, { status: 'failed', error: message })
      })
    }
  }).finally(() => preparingSheets.delete(key))
  preparingSheets.set(key, preparation)
}

async function executeSheet(row: SheetRow, job: QueueJob) {
  const guard = and(eq(schema.frameContactSheets.id, row.id), eq(schema.frameContactSheets.attempt, row.attempt))
  const claimed = (await db.update(schema.frameContactSheets).set({ status: 'processing', startedAt: now(), updatedAt: now() })
    .where(and(guard, eq(schema.frameContactSheets.status, 'pending'))).run())
  if (!getAffectedRows(claimed)) return
  try {
        let snapshot = JSON.parse(job.snapshotJson) as FrozenSheetSnapshot
        // Legacy records and explicit retries of failed preparation freeze under the claimed local slot.
        if (!Array.isArray(snapshot.references)) {
          snapshot = await freezeSheetSnapshot(row)
          await updateQueueJob(job.id, { snapshotJson: JSON.stringify(snapshot) })
        }
        const descriptor = snapshot.descriptor
        if (hash(descriptor) !== row.inputHash || snapshot.references.length !== descriptor.cells.length) throw new Error('宫格合成输入快照无效')
        const images = await Promise.all(descriptor.cells.map(async (cell, index) => {
          const reference = snapshot.references[index]
          if (!cell.url && !reference) return null
          try {
            if (!reference) throw new Error('冻结参考画面缺失')
            const buffer = await readReferenceMedia(reference.url)
            if (mediaDigest(buffer) !== reference.digest) throw new Error('冻结画面文件已变化')
            return buffer
          }
          catch (error) { throw new Error(`画面 ${cell.index}（${cell.frameId}）读取失败：${(error as Error).message}`) }
        }))
        const result = await renderContactSheet(descriptor, images)
        const renderHash = hash({ descriptor, digests: result.sourceDigests })
        const name = `${randomUUID()}`, relative = `previs-contact-sheets/${name}`, dir = path.join(STORAGE_ROOT, 'previs-contact-sheets')
        await mkdir(dir, { recursive: true })
        await Promise.all([writeFile(path.join(STORAGE_ROOT, `${relative}-clean.jpg`), result.clean),
          writeFile(path.join(STORAGE_ROOT, `${relative}-annotated.jpg`), result.annotated),
          writeFile(path.join(STORAGE_ROOT, `${relative}-thumb.webp`), result.thumbnail)])
        const currentSource = (await contactSheetSource(row.versionId)), panel = currentSource.timeline.panels.find(panel => panel.id === row.panelId)
        if (!panel || hash(contactSheetDescriptor(panel, currentSource.aspectRatio)) !== row.inputHash) throw new Error('宫格合成输入已过期，请重新合成')
        await db.update(schema.frameContactSheets).set({ status: 'completed', renderHash, sourceDigestsJson: JSON.stringify(result.sourceDigests),
          cleanUrl: `/static/${relative}-clean.jpg`, annotatedUrl: `/static/${relative}-annotated.jpg`,
          thumbnailUrl: `/static/${relative}-thumb.webp`, error: null, updatedAt: now() }).where(guard).run()
  } catch (error) {
        await db.update(schema.frameContactSheets).set({ status: 'failed', error: `宫格合成失败：${(error as Error).message}`, updatedAt: now() }).where(guard).run()
      }
}
registerQueueExecutor('contact_sheet', {
  execute: async job => {
    const row = (await db.select().from(schema.frameContactSheets).where(eq(schema.frameContactSheets.id, job.ownerId)).get())
    if (!row) return { status: 'failed', error: '宫格合成记录不存在' }
    const execution = executeSheet(row, job)
    activeSheets.add(execution)
    try { await execution } finally { activeSheets.delete(execution) }
    const saved = (await db.select().from(schema.frameContactSheets).where(eq(schema.frameContactSheets.id, row.id)).get())!
    return { status: saved.status === 'completed' ? 'completed' : 'failed', error: saved.error || undefined }
  },
  onCancel: async job => { await db.update(schema.frameContactSheets).set({ status: 'cancelled', error: '已取消排队', updatedAt: now() }).where(eq(schema.frameContactSheets.id, job.ownerId)).run() },
  onRetry: async job => { await db.update(schema.frameContactSheets).set({ status: 'pending', error: null, updatedAt: now() }).where(eq(schema.frameContactSheets.id, job.ownerId)).run() },
  onRequeue: async job => { await db.update(schema.frameContactSheets).set({ status: 'pending', error: null, updatedAt: now() }).where(eq(schema.frameContactSheets.id, job.ownerId)).run() },
})
export async function migrateContactSheetQueue() {
  const rows = await db.select().from(schema.frameContactSheets).all()
  for (const row of rows.filter(row => ['pending','processing'].includes(row.status))) {
    const existing = (await getQueueJob('contact_sheet', row.id))
    if (existing) { if (existing.status === 'pending' && !existing.ready) await prepareSheet(row); continue }
    if (row.status === 'processing') await db.update(schema.frameContactSheets).set({ status: 'pending', updatedAt: now() }).where(eq(schema.frameContactSheets.id,row.id)).run()
    await enqueueSheet({ ...row, status: 'pending' })
  }
}
export async function tickContactSheets() {
  for (const row of (await db.select().from(schema.frameContactSheets).where(eq(schema.frameContactSheets.status, 'pending')).all())) await enqueueSheet(row)
  await Promise.all([...preparingSheets.values()])
  for (;;) {
    await tickTaskQueue()
    await Promise.resolve()
    if (!activeSheets.size || (await readProductionSettings()).paused) break
    await Promise.all([...activeSheets])
  }
}
export async function startContactSheetWorker() {
  void tickContactSheets().catch(error => console.error('Contact sheet worker:', error.message))
  const timer = setInterval(() => { void tickContactSheets().catch(error => console.error('Contact sheet worker:', error.message)) }, 1500)
  timer.unref()
  return () => clearInterval(timer)
}
