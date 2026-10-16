import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
process.env.SQLITE_PATH = ':memory:'
const { db, schema } = await import('../src/db/index.js')
const previs = await import('../src/services/previs.js')
const repair = await import('../src/services/shot-planning-repair.js')
const requirePlanning = await import('../src/services/shot-planning.js')
const ts = new Date().toISOString()
const dramaId = Number(db.insert(schema.dramas).values({ title: '修复测试', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
const line = '要不是族长是他爹，这种废物早被赶出家族了，哪还能在这儿白吃白喝。'
function seed() {
  const episodeId = Number(db.insert(schema.episodes).values({ dramaId, episodeNumber: 1, title: '测试集', scriptContent: `族女丙：（不屑）${line}`, createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  const id = Number(db.insert(schema.storyboards).values({ episodeId, storyboardNumber: 1, title: '长对白', description: `【镜头1】族女丙抱臂冷笑。族女丙：（不屑）「${line}${line}」\n【镜头2】萧炎收回手，握紧拳头。`, videoPrompt: '0-3秒：族女丙：「要不是族长是他爹。」', duration: 15, composedImage: 'static/test/grid.png', videoUrl: 'static/test/video.mp4', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
  return { episodeId, id, version: previs.createVersion(episodeId) }
}
test('preview is read-only and shows long dialogue splitting, output retention and ordered durations', () => {
  const { version, id } = seed()
  const count = db.select().from(schema.animaticVersions).all().length
  const preview = repair.previewProductionRepair(version.id, { revision: version.revision, panelIds: [id], maxSeconds: 15 })
  assert.equal(db.select().from(schema.animaticVersions).all().length, count)
  assert.ok(preview.proposals[0].segments.length > 1)
  assert.ok(preview.proposals[0].segments.every(s => s.durationMs <= 15000))
  assert.equal(preview.proposals[0].beforeVideoUrl, 'static/test/video.mp4')
  assert.equal(db.select().from(schema.sysTask).all().length, 0)
})
test('reviewed server-side description overrides are previewed and atomically adopted', () => {
  const { version, id } = seed()
  const options = { revision: version.revision, panelIds: [id], maxSeconds: 15 }
  const overrides = { [id]: { description: '【镜头1】族女丙转身抱臂。族女丙：「你好。」', atmosphere: '夕照' } }
  const preview = repair.previewProductionRepair(version.id, options, overrides)
  assert.match(preview.proposals[0].segments[0].description, /转身抱臂/)
  const result = repair.applyProductionRepair(version.id, { ...options, inputHash: preview.inputHash }, overrides)
  assert.equal(result.timeline.panels[0].atmosphere, '夕照')
  assert.equal(result.timeline.panels[0].productionPlan?.atmosphere, '夕照')
  assert.match(result.timeline.panels[0].videoPrompt, /夕照/)
})
test('apply creates a fresh version, preserves historical video and grid, mirrors ordered splits without generating media', () => {
  const { version, id, episodeId } = seed()
  const preview = repair.previewProductionRepair(version.id, { revision: version.revision, panelIds: [id], maxSeconds: 15 })
  const result = repair.applyProductionRepair(version.id, { revision: version.revision, panelIds: [id], maxSeconds: 15, inputHash: preview.inputHash })
  assert.notEqual(result.id, version.id)
  const old = previs.getVersion(version.id)
  assert.equal(old.timeline.panels[0].videoUrl, 'static/test/video.mp4')
  assert.equal(old.timeline.panels[0].frames[0].url, 'static/test/grid.png')
  assert.ok(result.timeline.panels.length > 1)
  assert.ok(result.timeline.panels[0].frames.some(f => f.url === 'static/test/grid.png'))
  assert.ok(result.outputs.some(o => o.url === 'static/test/video.mp4' && o.stale))
  assert.ok(result.timeline.panels.every(p => !!p.productionPlan))
  assert.ok(result.timeline.panels.slice(1).every(p => !p.videoUrl))
  const rows = db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all().sort((a, b) => a.storyboardNumber - b.storyboardNumber)
  assert.deepEqual(rows.map(r => r.storyboardNumber), rows.map((_, i) => i + 1))
  assert.equal(rows.length, result.timeline.panels.length)
  assert.equal(previs.getWorkspace(episodeId).id, result.id)
  assert.equal(previs.getWorkspace(episodeId).revision, result.revision)
  assert.equal(db.select().from(schema.sysTask).all().length, 0)
})
test('rejects stale revisions and changed script preview hashes before creating or modifying anything', () => {
  const { version, id, episodeId } = seed()
  const options = { revision: version.revision, panelIds: [id], maxSeconds: 15 }
  const preview = repair.previewProductionRepair(version.id, options)
  assert.throws(() => repair.applyProductionRepair(version.id, { ...options, revision: 99, inputHash: preview.inputHash }), /更新|版本/)
  db.update(schema.episodes).set({ scriptContent: '剧本变了' }).where(eq(schema.episodes.id, episodeId)).run()
  const count = db.select().from(schema.animaticVersions).all().length
  assert.throws(() => repair.applyProductionRepair(version.id, { ...options, inputHash: preview.inputHash }), /变化|预览/)
  assert.equal(db.select().from(schema.animaticVersions).all().length, count)
})
test('an invalid selected ID fails atomically instead of skipping it or applying a partial repair', () => {
  const { version, id } = seed()
  assert.throws(() => repair.previewProductionRepair(version.id, { revision: version.revision, panelIds: [id, 999999], maxSeconds: 15 }), /属于|分镜/)
  assert.equal(previs.getVersion(version.id).revision, version.revision)
})

test('custom reference choices and frame bindings survive repair and repeated workspace refreshes', () => {
  const { version, id, episodeId } = seed(), timeline = structuredClone(version.timeline)
  const panel = timeline.panels[0]
  panel.referenceImages = ['/static/custom.png']; panel.referenceLabels = ['用户选择的构图']
  panel.frames[0].referenceImages = ['/static/custom.png']
  const saved = previs.saveTimeline(version.id, version.revision, timeline)
  const options = { revision: saved.revision, panelIds: [id], maxSeconds: 15 }
  const preview = repair.previewProductionRepair(saved.id, options)
  const result = repair.applyProductionRepair(saved.id, { ...options, inputHash: preview.inputHash })
  for (let i = 0; i < 2; i++) {
    const refreshed = previs.getWorkspace(episodeId)
    assert.equal(refreshed.id, result.id); assert.equal(refreshed.revision, result.revision)
    assert.deepEqual(refreshed.timeline.panels[0].referenceImages, ['/static/custom.png'])
    assert.deepEqual(refreshed.timeline.panels[0].referenceLabels, ['用户选择的构图'])
    assert.deepEqual(refreshed.timeline.panels[0].frames[0].referenceImages, ['/static/custom.png'])
  }
})

test('outside source metadata or reference bindings invalidate repair atomically', () => {
  for (const change of ['imagePrompt', 'title', 'atmosphere', 'shotType', 'character-binding']) {
    const { version, id } = seed(), options = { revision: version.revision, panelIds: [id], maxSeconds: 15 }
    const preview = repair.previewProductionRepair(version.id, options)
    if (change === 'character-binding') {
      const characterId = Number(db.insert(schema.characters).values({ dramaId, name: '新角色', imageUrl: '/static/new-role.png', createdAt: ts, updatedAt: ts }).run().lastInsertRowid)
      db.insert(schema.storyboardCharacters).values({ storyboardId: id, characterId }).run()
    } else db.update(schema.storyboards).set({ [change]: '外部的新资料' }).where(eq(schema.storyboards.id, id)).run()
    const versions = db.select().from(schema.animaticVersions).all().length
    const source = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()
    assert.throws(() => repair.applyProductionRepair(version.id, { ...options, inputHash: preview.inputHash }), /变化|更新|预览/, change)
    assert.equal(db.select().from(schema.animaticVersions).all().length, versions)
    assert.deepEqual(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get(), source)
  }
})

test('repair preserves timeline order, group state and boundary transitions through a split', async () => {
  const { id, episodeId } = seed()
  const extraIds = [2, 3].map(n => Number(db.insert(schema.storyboards).values({ episodeId, storyboardNumber: n, title: `短镜头${n}`, description: '人物站在窗前。', duration: 6, createdAt: ts, updatedAt: ts }).run().lastInsertRowid))
  const version = previs.createVersion(episodeId), timeline = structuredClone(version.timeline)
  const byId = new Map(timeline.groups.map(g => [g.panelIds[0], g]))
  timeline.groups = [byId.get(extraIds[1])!, byId.get(id)!, byId.get(extraIds[0])!]
  timeline.groups.forEach((g, i) => { g.note = `说明${i}`; g.entry = { holding: `开始${i}` }; g.exit = { holding: `结束${i}` } })
  const { rebuildTransitions } = await import('../src/services/previs-domain.js')
  rebuildTransitions(timeline)
  timeline.transitions[0].type = 'match_cut'; timeline.transitions[0].continuity = 'strong'
  timeline.transitions[1].type = 'audio_bridge'; timeline.transitions[1].allowedChanges = ['scene']
  const saved = previs.saveTimeline(version.id, version.revision, timeline)
  const options = { revision: saved.revision, panelIds: [id], maxSeconds: 15 }
  const preview = repair.previewProductionRepair(saved.id, options)
  const result = repair.applyProductionRepair(saved.id, { ...options, inputHash: preview.inputHash })
  const groups = result.timeline.groups, split = groups.slice(1, -1)
  assert.equal(groups[0].panelIds[0], extraIds[1]); assert.equal(groups.at(-1)!.panelIds[0], extraIds[0])
  assert.equal(split[0].panelIds[0], id); assert.ok(split.length > 1)
  assert.equal(groups[0].note, '说明0'); assert.deepEqual(groups[0].entry, { holding: '开始0' }); assert.deepEqual(groups[0].exit, { holding: '结束0' })
  assert.equal(split[0].note, '说明1'); assert.deepEqual(split[0].entry, { holding: '开始1' }); assert.deepEqual(split.at(-1)!.exit, { holding: '结束1' })
  assert.equal(groups.at(-1)!.note, '说明2')
  assert.equal(result.timeline.transitions[0].type, 'match_cut'); assert.equal(result.timeline.transitions[0].continuity, 'strong')
  assert.equal(result.timeline.transitions.at(-1)!.type, 'audio_bridge'); assert.deepEqual(result.timeline.transitions.at(-1)!.allowedChanges, ['scene'])
})

test('pending and processing video jobs block repair without changing versions or source rows', () => {
  for (const status of ['pending', 'processing']) {
    const { version, id } = seed(), options = { revision: version.revision, panelIds: [id], maxSeconds: 15 }
    const preview = repair.previewProductionRepair(version.id, options)
    const batchId = Number(db.insert(schema.batchRuns).values({ versionId: version.id, type: 'video', status, requestHash: `pending-video-${version.id}`, configId: 1, model: 'unused', createdAt: ts }).run().lastInsertRowid)
    db.insert(schema.batchRunItems).values({ batchId, groupId: version.timeline.groups[0].id, panelId: id, status, requestJson: '{}' }).run()
    const count = db.select().from(schema.animaticVersions).all().length
    assert.throws(() => repair.applyProductionRepair(version.id, { ...options, inputHash: preview.inputHash }), /任务.*运行|完成.*取消/)
    assert.equal(db.select().from(schema.animaticVersions).all().length, count)
    assert.equal(previs.getVersion(version.id).revision, version.revision)
  }
})
test('trusted quality candidates do not undergo a second implicit speech restoration',()=>{
  const {episodeId,id}=seed()
  const short=line.replace('早被赶出家族了，','')
  const description=`【镜头1】族女丙抱臂转身。族女丙：「${short}」`
  db.update(schema.storyboards).set({description,duration:15}).where(eq(schema.storyboards.id,id)).run()
  const version=previs.getWorkspace(episodeId)
  const preview=repair.previewProductionRepair(version.id,{revision:version.revision,panelIds:[id],maxSeconds:15},{[id]:{description}})
  assert.equal(preview.proposals[0].restorations.length,0)
  const {extractDialogue,spokenText}=requirePlanning
  assert.equal(spokenText(preview.proposals[0].segments.flatMap(s=>extractDialogue(s.description)).map(u=>u.text).join('')),spokenText(short))
})
