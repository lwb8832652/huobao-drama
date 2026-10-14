import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { defaultStrategy, makeFrame } from '../src/services/previs-domain.js'
const root = mkdtempSync(path.join(tmpdir(), 'local-queue-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3'); process.env.HUOBAO_DATA_DIR = root
const { db, schema } = await import('../src/db/index.js')
const queue = await import('../src/services/task-queue.js')
const settings = await import('../src/services/task-queue-settings.js')
const sheets = await import('../src/services/previs-contact-sheets.js')
mkdirSync(path.join(root, 'static'), { recursive: true })
writeFileSync(path.join(root, 'static', 'asset.png'), await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).png().toBuffer())
const panels = [1, 2].map(id => ({ id, frames: [{ ...makeFrame(`f${id}`), url: '/static/asset.png' }] }))
const versionId = Number(db.insert(schema.animaticVersions).values({ episodeId: 1, versionNo: 1,
  timelineJson: JSON.stringify({ schemaVersion: 2, panels, groups: [], transitions: [], audio: [], strategy: defaultStrategy, acknowledgements: {} }), createdAt: 'now', updatedAt: 'now' }).run().lastInsertRowid)
test('local contact sheet processing respects production pause and shares the global queue', async () => {
  settings.saveProductionSettings({ ...settings.readProductionSettings(), paused: true })
  sheets.scheduleContactSheets(versionId)
  await sheets.tickContactSheets()
  const rows = db.select().from(schema.frameContactSheets).all()
  assert.ok(rows.every(row => row.status === 'pending'), 'paused local jobs must not start')
  assert.ok(rows.every(row => queue.getQueueJob('contact_sheet', row.id)?.kind === 'local'))
  settings.saveProductionSettings({ ...settings.readProductionSettings(), paused: false, total: 1 })
  for (let i = 0; i < 200 && sheets.readContactSheets(versionId).some(sheet => sheet.status !== 'ready'); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(sheets.readContactSheets(versionId).every(sheet => sheet.status === 'ready'))
  assert.equal(queue.queueStats().active, 0)
})
