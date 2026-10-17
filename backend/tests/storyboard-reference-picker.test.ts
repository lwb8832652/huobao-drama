import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'reference-picker-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
const { db, schema } = await import('../src/db/index.js')
const { getWorkspace, getWorkspaceState, saveTimeline } = await import('../src/services/previs.js')
const { makeFrame } = await import('../src/services/previs-domain.js')
const ts = new Date().toISOString()
await db.insert(schema.dramas).values({ id: 1, title: 'Test', createdAt: ts, updatedAt: ts }).run()
await db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'Test', createdAt: ts, updatedAt: ts }).run()
for (const id of [1, 2]) await db.insert(schema.scenes).values({ id, dramaId: 1, location: `场景${id}`, time: '上午', prompt: '清晨', imageUrl: `/static/scene-${id}.png`, createdAt: ts, updatedAt: ts }).run()
await db.insert(schema.characters).values({ id: 1, dramaId: 1, name: '角色', imageUrl: '/static/hero.png', createdAt: ts, updatedAt: ts }).run()
await db.insert(schema.storyboards).values({ id: 1, episodeId: 1, storyboardNumber: 1, title: '开场', duration: 6, sceneId: 1, createdAt: ts, updatedAt: ts }).run()
await db.insert(schema.storyboardCharacters).values({ storyboardId: 1, characterId: 1 }).run()

test('saving bindings preserves custom and frame references across workspace polling and another save', async () => {
  const version = await getWorkspace(1), timeline = structuredClone(version.timeline), panel = timeline.panels[0]
  panel.sceneId = 2; panel.scene = '场景2 / 上午'
  panel.referenceImages = ['/static/scene-2.png', '/static/hero.png', '/static/custom.png']
  panel.referenceLabels = ['场景2', '角色', '自定义构图']
  panel.frames = [{ ...makeFrame('start', 0), referenceImages: ['/static/custom.png'] }]
  const saved = await saveTimeline(version.id, version.revision, timeline)
  assert.equal((await getWorkspaceState(1, version.id)).requiresRefresh, false)
  const reloaded = await getWorkspace(1)
  assert.equal(reloaded.revision, saved.revision)
  assert.deepEqual(reloaded.timeline.panels[0].referenceImages, panel.referenceImages)
  assert.deepEqual(reloaded.timeline.panels[0].frames[0].referenceImages, ['/static/custom.png'])
  assert.doesNotThrow(() => saveTimeline(reloaded.id, reloaded.revision, reloaded.timeline))
})
