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
const versionId = Number((await db.insert(schema.animaticVersions).values({ episodeId: 1, versionNo: 1, timelineJson: JSON.stringify(timeline), createdAt: 'now', updatedAt: 'now' }).run()).lastInsertRowid)

async function settle() {
  for (let attempt = 0; attempt < 100; attempt++) {
    await tickContactSheets()
    const sheet = (await readContactSheets(versionId))[0]
    if (sheet.status !== 'composing') return sheet
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return (await readContactSheets(versionId))[0]
}

test('cache changes do not mutate revision; preview permits missing images and detects stale input', async () => {
  await scheduleContactSheets(versionId)
  assert.equal((await readContactSheets(versionId))[0].status, 'composing')
  const ready = await settle()
  assert.equal(ready.status, 'ready')
  assert.equal(ready.readyFrames, 1)
  assert.ok(ready.cleanUrl && ready.annotatedUrl && ready.artifactHash)
  assert.equal((await db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, versionId)).get())?.revision, 1)
  timeline.panels[0].frames.reverse()
  timeline.panels[0].frames[0].offsetMs = 0
  await db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(timeline) }).where(eq(schema.animaticVersions.id, versionId)).run()
  assert.equal((await readContactSheets(versionId))[0].status, 'stale')
  await scheduleContactSheets(versionId)
  assert.notEqual((await settle()).cleanUrl, ready.cleanUrl)
})

test('failed source can be retried; composition is allowed for locked versions', async () => {
  timeline.panels[0].frames[0].url = '/static/missing.png'
  await db.update(schema.animaticVersions).set({ timelineJson: JSON.stringify(timeline), status: 'locked', contentHash: 'locked-hash' }).where(eq(schema.animaticVersions.id, versionId)).run()
  await scheduleContactSheets(versionId)
  const failed = await settle()
  assert.equal(failed.status, 'failed')
  assert.match(failed.error || '', /读取|ENOENT/)
  writeFileSync(path.join(root, 'static', 'missing.png'), await sharp({ create: { width: 100, height: 100, channels: 3, background: 'blue' } }).png().toBuffer())
  await scheduleContactSheets(versionId, [12], true)
  assert.equal((await settle()).status, 'ready')
  const row = await db.select().from(schema.animaticVersions).where(eq(schema.animaticVersions.id, versionId)).get()!
  assert.equal(row.revision, 1)
  assert.equal(row.contentHash, 'locked-hash')
})
