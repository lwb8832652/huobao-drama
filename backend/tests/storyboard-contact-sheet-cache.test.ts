import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { defaultStrategy, makeFrame, type Timeline } from '../src/services/previs-domain.js'

const root = mkdtempSync(path.join(tmpdir(), 'sheet-cache-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
const { db, schema } = await import('../src/db/index.js')
const { scheduleContactSheets, readContactSheets, tickContactSheets } = await import('../src/services/previs-contact-sheets.js')
mkdirSync(path.join(root, 'static'), { recursive: true })
writeFileSync(path.join(root, 'static', 'red.png'), await sharp({ create: { width: 200, height: 100, channels: 3, background: 'red' } }).png().toBuffer())
const timeline = { schemaVersion: 2, panels: [{ id: 12, frames: [{ ...makeFrame('a'), url: '/static/red.png' }, makeFrame('b', 1000)] }], groups: [], transitions: [], audio: [], strategy: defaultStrategy, acknowledgements: {} } as unknown as Timeline
const versionId = Number(db.insert(schema.animaticVersions).values({ episodeId: 1, versionNo: 1, timelineJson: JSON.stringify(timeline), createdAt: 'now', updatedAt: 'now' }).run().lastInsertRowid)

test('cache changes do not mutate revision; preview permits missing images and detects stale input', async () => {
  scheduleContactSheets(versionId)
  assert.equal(readContactSheets(versionId)[0].status, 'composing')
  await tickContactSheets()
  const ready = readContactSheets(versionId)[0]
  assert.equal(ready.status, 'ready')
  assert.equal(ready.readyFrames, 1)
  assert.ok(ready.cleanUrl && ready.annotatedUrl && ready.artifactHash)
  assert.equal(db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, versionId)).get()?.revision, 1)
  timeline.panels[0].frames.reverse()
  timeline.panels[0].frames[0].offsetMs = 0
  db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(timeline) }).where(eq(schema.animaticVersions.id, versionId)).run()
  assert.equal(readContactSheets(versionId)[0].status, 'stale')
  scheduleContactSheets(versionId)
  await tickContactSheets()
  assert.notEqual(readContactSheets(versionId)[0].cleanUrl, ready.cleanUrl)
})

test('failed source can be retried; composition is allowed for locked versions', async () => {
  timeline.panels[0].frames[0].url = '/static/missing.png'
  db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(timeline), status: 'locked', contentHash: 'locked-hash' }).where(eq(schema.animaticVersions.id, versionId)).run()
  scheduleContactSheets(versionId)
  await tickContactSheets()
  assert.equal(readContactSheets(versionId)[0].status, 'failed')
  assert.match(readContactSheets(versionId)[0].error || '', /读取|ENOENT/)
  writeFileSync(path.join(root, 'static', 'missing.png'), await sharp({ create: { width: 100, height: 100, channels: 3, background: 'blue' } }).png().toBuffer())
  scheduleContactSheets(versionId, [12], true)
  await tickContactSheets()
  assert.equal(readContactSheets(versionId)[0].status, 'ready')
  const row = db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, versionId)).get()!
  assert.equal(row.revision, 1)
  assert.equal(row.contentHash, 'locked-hash')
})
