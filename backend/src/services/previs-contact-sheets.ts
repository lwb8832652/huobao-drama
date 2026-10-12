import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { and, eq, desc } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { normalizeTimeline } from './previs-domain.js'
import { contactSheetDescriptor, type ContactSheetDescriptor, type ContactSheetView } from './previs-contact-sheet-domain.js'
import { renderContactSheet } from './previs-contact-sheet-renderer.js'
import { readReferenceMedia } from './previs-reference-media.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const now = () => new Date().toISOString()
export function contactSheetSource(versionId: number) {
  const version = db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, versionId)).get()
  if (!version) throw new Error('工作版本不存在')
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, version.episodeId)).get()
  const drama = episode && db.select().from(schema.dramas).where(eq(schema.dramas.id, episode.dramaId)).get()
  return { version, timeline: normalizeTimeline(JSON.parse(version.timelineJson)), aspectRatio: drama?.aspectRatio || '16:9' }
}
export function readContactSheets(versionId: number): ContactSheetView[] {
  const source = contactSheetSource(versionId)
  const rows = db.select().from(schema.frameContactSheets).where(eq(schema.frameContactSheets.versionId, versionId)).orderBy(desc(schema.frameContactSheets.id)).all()
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
export function scheduleContactSheets(versionId: number, panelIds?: number[], force = false) {
  const source = contactSheetSource(versionId)
  if (panelIds?.some(id => !source.timeline.panels.some(panel => panel.id === id))) throw new Error('分镜不属于当前版本')
  for (const panel of source.timeline.panels) {
    if (panelIds && !panelIds.includes(panel.id)) continue
    if (!panel.frames.length || panel.frames.length > 9) continue
    const descriptor = contactSheetDescriptor(panel, source.aspectRatio), inputHash = hash(descriptor)
    const row = db.select().from(schema.frameContactSheets).where(and(eq(schema.frameContactSheets.versionId, versionId), eq(schema.frameContactSheets.panelId, panel.id), eq(schema.frameContactSheets.inputHash, inputHash))).get()
    if (row) {
      if (force) db.update(schema.frameContactSheets).set({ status: 'pending', attempt: row.attempt + 1, error: null, renderHash: null,
        cleanUrl: null, annotatedUrl: null, thumbnailUrl: null, updatedAt: now() }).where(eq(schema.frameContactSheets.id, row.id)).run()
    } else db.insert(schema.frameContactSheets).values({ versionId, panelId: panel.id, inputHash,
      descriptorJson: JSON.stringify(descriptor), createdAt: now(), updatedAt: now() }).run()
  }
}
let working = false
export async function tickContactSheets() {
  if (working) return
  working = true
  try {
    for (let i = 0; i < 8; i++) {
      const row = db.select().from(schema.frameContactSheets).where(eq(schema.frameContactSheets.status, 'pending')).get()
      if (!row) break
      const guard = and(eq(schema.frameContactSheets.id, row.id), eq(schema.frameContactSheets.attempt, row.attempt))
      const claimed = db.update(schema.frameContactSheets).set({ status: 'processing', startedAt: now(), updatedAt: now() }).where(and(guard, eq(schema.frameContactSheets.status, 'pending'))).run()
      if (!claimed.changes) continue
      try {
        const descriptor = JSON.parse(row.descriptorJson) as ContactSheetDescriptor
        const images = await Promise.all(descriptor.cells.map(async cell => {
          if (!cell.url) return null
          try { return await readReferenceMedia(cell.url) }
          catch (error) { throw new Error(`画面 ${cell.index}（${cell.frameId}）读取失败：${(error as Error).message}`) }
        }))
        const result = await renderContactSheet(descriptor, images)
        const renderHash = hash({ descriptor, digests: result.sourceDigests })
        const name = `${randomUUID()}`, relative = `previs-contact-sheets/${name}`, dir = path.join(STORAGE_ROOT, 'previs-contact-sheets')
        await mkdir(dir, { recursive: true })
        await Promise.all([writeFile(path.join(STORAGE_ROOT, `${relative}-clean.jpg`), result.clean),
          writeFile(path.join(STORAGE_ROOT, `${relative}-annotated.jpg`), result.annotated),
          writeFile(path.join(STORAGE_ROOT, `${relative}-thumb.webp`), result.thumbnail)])
        db.update(schema.frameContactSheets).set({ status: 'completed', renderHash, sourceDigestsJson: JSON.stringify(result.sourceDigests),
          cleanUrl: `/static/${relative}-clean.jpg`, annotatedUrl: `/static/${relative}-annotated.jpg`,
          thumbnailUrl: `/static/${relative}-thumb.webp`, error: null, updatedAt: now() }).where(guard).run()
      } catch (error) {
        db.update(schema.frameContactSheets).set({ status: 'failed', error: `宫格合成失败：${(error as Error).message}`, updatedAt: now() }).where(guard).run()
      }
    }
  } finally { working = false }
}
export async function startContactSheetWorker() {
  db.update(schema.frameContactSheets).set({ status: 'pending', updatedAt: now() }).where(eq(schema.frameContactSheets.status, 'processing')).run()
  await tickContactSheets()
  const timer = setInterval(() => { void tickContactSheets() }, 1500)
  timer.unref()
  return () => clearInterval(timer)
}
