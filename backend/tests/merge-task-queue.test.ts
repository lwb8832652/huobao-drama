import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'
const root = mkdtempSync(path.join(tmpdir(), 'merge-queue-'))
process.env.SQLITE_PATH = path.join(root, 'db.sqlite3'); process.env.HUOBAO_DATA_DIR = root
const { db, schema } = await import('../src/db/index.js')
const queue = await import('../src/services/task-queue.js')
const settings = await import('../src/services/task-queue-settings.js')
const merge = await import('../src/services/ffmpeg-merge.js')
const require = createRequire(import.meta.url)
mkdirSync(path.join(root, 'static'), { recursive: true })
const clip = path.join(root, 'static', 'clip.mp4')
const created = spawnSync(process.env.FFMPEG_BIN || require('ffmpeg-static'), ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10', '-t', '0.3', '-pix_fmt', 'yuv420p', clip], { encoding: 'utf8' })
assert.equal(created.status, 0, created.stderr)
const originalClip = readFileSync(clip)
const ts = new Date().toISOString()
await db.insert(schema.dramas).values({ id: 1, title: 'test', createdAt: ts, updatedAt: ts }).run()
await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'test', createdAt: ts, updatedAt: ts }).run()
await db.insert(schema.storyboards).values({ id: 1, episodeId: 1, storyboardNumber: 1, videoUrl: 'static/clip.mp4', createdAt: ts, updatedAt: ts }).run()
const until = async (check: () => boolean | Promise<boolean>) => { for (let i = 0; i < 1000 && !(await check()); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(await check()) }
test('FFmpeg merge waits while paused, then executes and publishes its actual output', async () => {
  settings.saveProductionSettings({ ...(await (await settings.readProductionSettings())), paused: true })
  const id = await merge.mergeEpisodeVideos(1, 1)
  const job = await queue.getQueueJob('video_merge', id)!
  assert.equal(job.kind, 'local'); assert.equal(job.status, 'pending')
  assert.equal((await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, id)).get()!).status, 'pending')
  settings.saveProductionSettings({ ...(await (await settings.readProductionSettings())), paused: false })
  await until(async () => ['completed','failed'].includes((await queue.getQueueJobById(job.id))!.status))
  const row = await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, id)).get()!
  assert.equal(row.status, 'completed', row.errorMsg || '')
  assert.ok(existsSync(path.join(root, row.mergedUrl!)))
  assert.equal((await db.select().from(schema.episodes).where(eq(schema.episodes.id, 1)).get()!).videoUrl, row.mergedUrl)
})
test('changed queued clip fails explicitly before FFmpeg publication', async () => {
  settings.saveProductionSettings({ ...(await (await settings.readProductionSettings())), paused: true })
  const id = await merge.mergeEpisodeVideos(1, 1)
  writeFileSync(clip, 'changed')
  settings.saveProductionSettings({ ...(await settings.readProductionSettings()), paused: false })
  await until(async () => (await queue.getQueueJob('video_merge', id))?.status === 'failed')
  assert.match((await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, id)).get()!).errorMsg!, /素材已变化/)
})


test('legacy pending merge migration snapshots clip digests before resumed dispatch', async () => {
  settings.saveProductionSettings({ ...(await (await settings.readProductionSettings())), paused: true })
  writeFileSync(clip, originalClip)
  const id = Number((await db.insert(schema.videoMerges).values({ episodeId: 1, dramaId: 1, provider: 'ffmpeg', model: 'ffmpeg', status: 'pending', scenes: JSON.stringify(['static/clip.mp4']), createdAt: ts }).run()).lastInsertRowid)
  await merge.migrateVideoMergeQueue()
  const job = await queue.getQueueJob('video_merge', id)!
  assert.equal(JSON.parse(job.snapshotJson).digests.length, 1)
  writeFileSync(clip, 'changed-after-recovery')
  settings.saveProductionSettings({ ...(await settings.readProductionSettings()), paused: false })
  await until(async () => (await queue.getQueueJobById(job.id))?.status === 'failed')
  assert.match((await db.select().from(schema.videoMerges).where(eq(schema.videoMerges.id, id)).get()!).errorMsg!, /素材已变化/)
})
