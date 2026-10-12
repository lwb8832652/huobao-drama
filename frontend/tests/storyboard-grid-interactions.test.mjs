import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
function evaluate(source, dependencies = {}, globals = {}) {
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(source.replaceAll('import.meta.client', 'false'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports,
    require: name => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] },
    setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, ...globals,
  })
  return module.exports
}
const componentPath = '../app/components/previs/StoryboardGridTools.vue'
const candidate = (extra = {}) => ({ id: 20, versionId: 4, panelId: 7, mode: 'generate', status: 'ready',
  previewUrl: '/static/grid.png', rawUrl: '/static/raw.png', baseUrl: '/static/before.png',
  width: 2048, height: 1152, cellWidth: 1024, cellHeight: 576,
  grid: { columns: 2, rows: 2, cells: [{ frameId: 'one', index: 0 }, { frameId: 'two', index: 1 }] },
  adoptFrameIds: ['one', 'two'], targetFrameIds: ['one', 'two'], resolution: '2K', ...extra })
function harness({ items = [], save = async () => ({ versionId: 4, revision: 9 }), request, editable = true, aspectRatio = '16:9', onEvent, commitAdoption } = {}) {
  assert.ok(existsSync(new URL(componentPath, import.meta.url)), 'Shared grid tools must implement the candidate workflow')
  const descriptor = parse(read(componentPath)).descriptor
  const script = compileScript(descriptor, { id: 'grid-tools-test' })
  const requests = [], emitted = [], mounted = [], disposers = [], timers = new Map()
  let nextTimer = 0
  const props = vue.reactive({ versionId: 4, revision: 2, configId: 8, model: 'selected-image', editable, managementEditable: editable, beforeAction: save, aspectRatio,
    panel: { id: 7, frames: [{ id: 'one', offsetMs: 0, url: '/static/one.png' }, { id: 'two', offsetMs: 1000, url: '/static/two.png' }], referenceImages: [] } })
  const api = async (path, method = 'GET', body) => {
    requests.push({ path, method, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) })
    if (request) { const result = await request(path, method, body); if (result !== undefined) return result }
    if (path.includes('grid-capabilities')) return { enabled: true, supportsReferences: true, supportsEdit: true, resolutions: ['1K', '2K', '4K'], sizes: [
      { aspectRatio: '16:9', resolution: '1K', width: 1024, height: 576 },
      { aspectRatio: '16:9', resolution: '2K', width: 2048, height: 1152 },
      { aspectRatio: '16:9', resolution: '4K', width: 3840, height: 2160 },
    ], reason: '' }
    if (path.endsWith('/adopt')) return { id: 4, revision: 10, timeline: { panels: [] } }
    return { items: method === 'POST' ? [candidate({ status: 'pending' })] : items }
  }
  props.commitAdoption = commitAdoption || ((versionId, candidateId, revision) => api(`/animatic-versions/${versionId}/grid-candidates/${candidateId}/adopt`, 'POST', { revision }))
  const component = evaluate(script.content, {
    vue: { ...vue, onMounted: fn => mounted.push(fn), onBeforeUnmount: fn => disposers.push(fn), onUnmounted: fn => disposers.push(fn), useId: () => 'grid-dialog' },
    'lucide-vue-next': {}, '~/composables/useApi': { uploadAPI: { image: async () => ({ path: '/static/upload.png' }) } },
    '~/composables/usePrevis': { previsRequest: api, mediaUrl: url => url, orderedFrames: panel => panel.frames, frameKey: frame => frame.id, FRAME_COUNT_MAX: 9 },
  }, { setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id) }).default
  const effect = vue.effectScope()
  const setup = effect.run(() => component.setup(props, { expose() {}, emit: (event, ...args) => { emitted.push({ event, args }); onEvent?.(event, ...args) } }))
  return { setup, props, requests, emitted, timers, async start() { for (const fn of mounted) await fn() }, dispose() { disposers.forEach(fn => fn()); effect.stop() }, descriptor, script }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

test('opening the grid tools only reads capabilities and candidates', async () => {
  const h = harness({ items: [candidate()] }); await h.start()
  assert.ok(h.requests.some(r => r.path.includes('/previs/grid-capabilities?config_id=8&model=selected-image')))
  assert.ok(h.requests.some(r => r.path.endsWith('/grid-candidates?panel_id=7')))
  assert.equal(h.requests.some(r => r.method === 'POST'), false)
  const template = compileTemplate({ source: h.descriptor.template.content, filename: 'StoryboardGridTools.vue', id: 'grid-tools-test', compilerOptions: { bindingMetadata: h.script.bindings } })
  assert.deepEqual(template.errors, []); h.dispose()
})

test('one group submission uses the saved revision without changing current frame URLs', async () => {
  let saves = 0
  const h = harness({ save: async () => { saves++; return { versionId: 4, revision: 9 } } }); await h.start()
  await Promise.all([h.setup.generateGrid(), h.setup.generateGrid()])
  const paid = h.requests.filter(r => r.method === 'POST')
  assert.equal(saves, 1); assert.equal(paid.length, 1)
  assert.equal(paid[0].body.revision, 9); assert.equal(paid[0].body.mode, 'generate')
  assert.deepEqual(paid[0].body.panelIds, [7]); assert.equal(paid[0].body.configId, 8)
  assert.equal(paid[0].body.model, 'selected-image')
  assert.equal(h.props.panel.frames[0].url, '/static/one.png'); h.dispose()
})

test('whole grid editing submits selected targets, common and individual instructions', async () => {
  const h = harness({ items: [candidate()] }); await h.start()
  h.setup.openEdit('grid_edit', candidate())
  h.setup.selectedFrameIds.value = ['two']
  h.setup.instruction.value = '保持人物服装'
  h.setup.instructions.value = { two: '把右手放低' }
  await h.setup.submitEdit()
  const body = h.requests.find(r => r.method === 'POST').body
  assert.equal(body.mode, 'grid_edit'); assert.equal(body.baseCandidateId, 20)
  assert.deepEqual(body.targetFrameIds, ['two']); assert.equal(body.instruction, '保持人物服装')
  assert.equal(body.instructions.two, '把右手放低'); h.dispose()
})

test('single frame refinement requires one existing crop and submits only that frame', async () => {
  const h = harness(); await h.start()
  h.props.panel.frames[1].url = ''
  h.setup.openEdit('frame_edit')
  h.setup.selectedFrameIds.value = ['two']; h.setup.instruction.value = '改变光线'
  await h.setup.submitEdit()
  assert.equal(h.requests.some(r => r.method === 'POST'), false)
  h.setup.selectedFrameIds.value = ['one']
  await h.setup.submitEdit()
  const body = h.requests.find(r => r.method === 'POST').body
  assert.equal(body.mode, 'frame_edit'); assert.deepEqual(body.targetFrameIds, ['one']); h.dispose()
})

test('candidate adoption is explicit and returns the full version to the parent', async () => {
  const h = harness({ items: [candidate()] }); await h.start()
  h.setup.reviewCandidate(candidate())
  assert.equal(h.requests.some(r => r.method === 'POST'), false)
  h.setup.confirmedReview.value = true
  await h.setup.adoptCandidate()
  const action = h.requests.find(r => r.path.endsWith('/20/adopt'))
  assert.equal(action.body.revision, 9)
  const adopted = h.emitted.find(event => event.event === 'adopted')
  assert.equal(adopted.args[0].revision, 10); h.dispose()
})

test('locked and failed candidates cannot submit or adopt, but remain reviewable', async () => {
  const h = harness({ editable: false, items: [candidate({ status: 'failed', previewUrl: null, error: '尺寸不匹配' })] }); await h.start()
  h.setup.reviewCandidate(h.setup.candidates.value[0])
  await h.setup.generateGrid(); await h.setup.adoptCandidate()
  assert.equal(h.requests.some(r => r.method === 'POST'), false)
  assert.equal(h.setup.review.value.status, 'failed'); h.dispose()
})

test('closing review retains candidates and explicit discard removes only that candidate', async () => {
  const h = harness({ items: [candidate()] }); await h.start()
  h.setup.reviewCandidate(candidate()); h.setup.closeModal()
  assert.equal(h.setup.candidates.value.length, 1)
  await h.setup.discardCandidate(candidate())
  assert.equal(h.requests.filter(r => r.method === 'POST')[0].path.endsWith('/20/discard'), true)
  assert.equal(h.setup.candidates.value.length, 0); h.dispose()
})

test('panel change ignores stale responses and unmount cancels pending polling', async () => {
  let resolve
  const h = harness({ request: (path) => path.endsWith('?panel_id=7') ? new Promise(done => { resolve = done }) : undefined })
  const loading = h.start(); await flush()
  h.props.panel = { ...h.props.panel, id: 8 }; await vue.nextTick(); await flush()
  resolve({ items: [candidate({ status: 'processing' })] }); await loading
  assert.equal(h.setup.candidates.value.length, 0)
  h.dispose(); assert.equal(h.timers.size, 0)
})

test('save failure and network failure remain visible and release submission state', async () => {
  const blocked = harness({ save: async () => false }); await blocked.start(); await blocked.setup.generateGrid()
  assert.equal(blocked.requests.some(r => r.method === 'POST'), false); blocked.dispose()
  const h = harness({ request: (path, method) => { if (method === 'POST') throw new Error('网络不可用') } }); await h.start()
  await h.setup.generateGrid()
  assert.match(h.setup.error.value, /网络不可用/); assert.equal(h.setup.submitting.value, false); h.dispose()
})

test('single-frame review overlays only the refined cell, keeping its original number', async () => {
  const refined = candidate({ mode: 'frame_edit', targetFrameIds: ['two'], adoptFrameIds: ['two'] })
  const h = harness(); await h.start()
  h.setup.reviewCandidate(refined)
  assert.equal(h.setup.reviewCells.value.length, 1)
  assert.equal(h.setup.reviewCells.value[0].frameId, 'two')
  assert.equal(h.setup.reviewCells.value[0].number, 2)
  assert.equal(h.setup.cellStyle(refined, 0).width, '100%'); h.dispose()
})

test('ready preview pixel labels derive from actual artifact dimensions rather than requested native size', async () => {
  const h = harness(); await h.start()
  const small = candidate({ width: 720, height: 405, cellWidth: 1024, cellHeight: 576 })
  assert.equal(h.setup.perCellPixels(small).width, 360)
  assert.equal(h.setup.perCellPixels(small).height, 202)
  const single = { ...small, mode: 'frame_edit' }
  assert.equal(h.setup.perCellPixels(single).width, 720)
  assert.equal(h.setup.perCellPixels(single).height, 405); h.dispose()
})

test('uploaded local replacement is reviewed as one candidate without calling the model', async () => {
  const h = harness({ request: (path, method) => method === 'POST' && path.endsWith('/upload') ? candidate() : undefined }); await h.start()
  await h.setup.uploadGrid({ target: { files: [{}], value: 'selected' } })
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1)
  assert.equal(h.requests.at(-1).body.url, '/static/upload.png')
  assert.equal(h.setup.review.value.id, 20); h.dispose()
})

test('every selected edit target needs a common instruction or its own instruction', async () => {
  const h = harness(); await h.start()
  h.setup.openEdit('grid_edit'); h.setup.selectedFrameIds.value = ['one', 'two']
  h.setup.instructions.value = { one: '调整视线' }
  await h.setup.submitEdit()
  assert.equal(h.requests.some(r => r.method === 'POST'), false)
  h.setup.instructions.value.two = '调整右手'; await h.setup.submitEdit()
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1); h.dispose()
})

test('unsupported project ratios cannot submit and native per-cell size is shown before generation', async () => {
  const unsupported = harness({ aspectRatio: '9:16' }); await unsupported.start(); await unsupported.setup.generateGrid()
  assert.equal(unsupported.requests.some(r => r.method === 'POST'), false); unsupported.dispose()
  const h = harness(); await h.start()
  assert.equal(h.setup.predictedCell.value.width, 1024); assert.equal(h.setup.predictedCell.value.height, 576)
  h.dispose()
})

test('pending candidates may be discarded and their polling timer is cancelled', async () => {
  const waiting = candidate({ status: 'pending' })
  const h = harness({ items: [waiting] }); await h.start(); assert.equal(h.timers.size, 1)
  await h.setup.discardCandidate(waiting)
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1)
  assert.equal(h.timers.size, 0); h.dispose()
})

test('the panel own generation busy state cannot disable cancellation of its queued candidate', async () => {
  const waiting = candidate({ status: 'processing' })
  const h = harness({ items: [waiting] }); await h.start()
  h.props.editable = false; h.props.managementEditable = true
  await h.setup.discardCandidate(waiting)
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1)
  assert.equal(h.setup.candidates.value.length, 0); h.dispose()
})

test('a response already in flight cannot restore a cancelled candidate', async () => {
  let reads = 0, resolve
  const waiting = candidate({ status: 'processing' })
  const h = harness({ request: (path, method) => {
    if (method === 'GET' && path.endsWith('?panel_id=7')) {
      if (++reads === 1) return { items: [waiting] }
      return new Promise(done => { resolve = done })
    }
  } }); await h.start()
  const polling = h.setup.refreshCandidates(); await flush()
  await h.setup.discardCandidate(waiting)
  resolve({ items: [waiting] }); await polling
  assert.equal(h.setup.candidates.value.length, 0)
  assert.equal(h.timers.size, 0); h.dispose()
})

test('adoption requires manual review confirmation even for a ready candidate', async () => {
  const h = harness({ items: [candidate()] }); await h.start(); h.setup.reviewCandidate(candidate())
  await h.setup.adoptCandidate()
  assert.equal(h.requests.some(r => r.method === 'POST'), false); h.dispose()
})

test('closing, refreshing, changing context or unmounting review cannot release a workspace adoption commit', async () => {
  const domain = evaluate(read('../../backend/src/services/previs-domain.ts'))
  const contract = evaluate(read('../../backend/src/services/previs-frame-contract.ts'))
  const reference = evaluate(read('../../backend/src/services/previs-video-reference-domain.ts'), { './previs-domain.js': domain })
  const payload = { id: 4, revision: 2, status: 'draft', busy: false,
    timeline: { panels: [{ id: 7, title: '原镜头标题', frames: [], durationMs: 3000 }], groups: [], audio: [] } }
  for (const lifecycle of ['close', 'refresh', 'context', 'unmount']) {
  let finish
  const api = evaluate(read('../app/composables/usePrevis.ts'), {
    vue: { ...vue, onUnmounted() {} }, 'vue-sonner': { toast: {} },
    '../../../backend/src/services/previs-domain': domain,
    '../../../backend/src/services/previs-frame-contract': contract,
    '../../../backend/src/services/previs-video-reference-domain': reference,
  }, { fetch: async url => url.endsWith('/adopt') ? new Promise(resolve => { finish = value => resolve({ ok: true, json: async () => ({ data: value }) }) })
    : ({ ok: true, json: async () => ({ data: structuredClone(payload) }) }) })
  const workspace = api.usePrevis(); await workspace.open(4)
  const h = harness({ items: [candidate()],
    save: async () => { await workspace.save(); return { versionId: 4, revision: workspace.version.value.revision } },
    commitAdoption: workspace.adoptGridCandidate,
  }); await h.start(); h.setup.reviewCandidate(candidate()); h.setup.confirmedReview.value = true
  const adopting = h.setup.adoptCandidate(); await flush()
  h.setup.closeModal()
  if (lifecycle === 'refresh') await h.setup.loadContext()
  if (lifecycle === 'context') { h.props.panel = { ...h.props.panel, id: 8 }; await vue.nextTick(); await flush() }
  if (lifecycle === 'unmount') h.dispose()
  workspace.edit(timeline => { timeline.panels[0].title = '请求中误改的标题' })
  workspace.history()
  assert.equal(workspace.editable.value, false)
  assert.equal(workspace.version.value.timeline.panels[0].title, '原镜头标题')
  assert.equal(workspace.dirty.value, false)
  workspace.working.value = false
  assert.equal(workspace.editable.value, false, 'A different operation cannot release the adoption lease')
  finish({ ...payload, revision: 3 }); await adopting
  assert.equal(workspace.working.value, false); assert.equal(workspace.version.value.revision, 3)
  if (lifecycle !== 'unmount') h.dispose()
  }
})

test('the workspace adoption lease releases on failure and shows a persistent error', async () => {
  const domain = evaluate(read('../../backend/src/services/previs-domain.ts'))
  const contract = evaluate(read('../../backend/src/services/previs-frame-contract.ts'))
  const reference = evaluate(read('../../backend/src/services/previs-video-reference-domain.ts'), { './previs-domain.js': domain })
  const payload = { id: 4, revision: 2, status: 'draft', busy: false, timeline: { panels: [], groups: [], audio: [] } }
  const api = evaluate(read('../app/composables/usePrevis.ts'), {
    vue: { ...vue, onUnmounted() {} }, 'vue-sonner': { toast: { error() {} } },
    '../../../backend/src/services/previs-domain': domain, '../../../backend/src/services/previs-frame-contract': contract,
    '../../../backend/src/services/previs-video-reference-domain': reference,
  }, { fetch: async url => { if (url.endsWith('/adopt')) throw new Error('采用提交失败'); return { ok: true, json: async () => ({ data: payload }) } } })
  const workspace = api.usePrevis(); await workspace.open(4)
  await assert.rejects(workspace.adoptGridCandidate(4, 20, 2), /采用提交失败/)
  assert.equal(workspace.working.value, false); assert.match(workspace.saveError.value, /采用提交失败/)
})

test('locked frames block whole regeneration but allow refinement of another unlocked crop', async () => {
  const h = harness(); await h.start(); h.props.panel.frames[0].locked = true
  await h.setup.generateGrid(); assert.equal(h.requests.some(r => r.method === 'POST'), false)
  h.setup.openEdit('frame_edit'); h.setup.selectedFrameIds.value = ['one']; h.setup.instruction.value = '调整手势'
  await h.setup.submitEdit(); assert.equal(h.requests.some(r => r.method === 'POST'), false)
  h.setup.selectedFrameIds.value = ['two']; await h.setup.submitEdit()
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 1); h.dispose()
})

test('the whole-grid chooser matches paid output geometry and missing or blank slots cannot be selected', async () => {
  for (const [count, side] of [[1, 1], [3, 2], [6, 3]]) {
    const h = harness(); await h.start()
    h.props.panel.frames = Array.from({ length: count }, (_, index) => ({ id: `frame-${index}`, offsetMs: index, url: index === 1 ? '' : `/static/${index}.png` }))
    h.setup.openEdit('grid_edit')
    assert.equal(h.setup.currentGridSlots.value.length, side * side)
    assert.equal(h.setup.currentGridStyle.value.gridTemplateColumns, `repeat(${side}, minmax(0, 1fr))`)
    assert.equal(h.setup.currentGridStyle.value.aspectRatio, '16 / 9')
    if (count > 1) {
      h.setup.toggleFrame('frame-1'); assert.equal(h.setup.selectedFrameIds.value.length, 0)
    }
    if (side * side > count) assert.equal(h.setup.currentGridSlots.value.at(-1).frame, undefined)
    h.dispose()
  }
})

test('candidate choices retain frozen order and numbers after current frames are reordered', async () => {
  const h = harness(); await h.start()
  h.props.panel.frames.reverse()
  h.setup.openEdit('grid_edit', candidate())
  assert.equal(h.setup.editFrames.value[0].id, 'one')
  assert.equal(h.setup.editFrames.value[1].id, 'two')
  assert.equal(h.setup.editFrameNumber(h.setup.editFrames.value[0]), 1)
  assert.equal(h.setup.editFrameNumber(h.setup.editFrames.value[1]), 2)
  h.props.panel.frames = h.props.panel.frames.filter(frame => frame.id !== 'one')
  assert.equal(h.setup.editFrameNumber(h.setup.editFrames.value[0]), 2)
  h.dispose()
})

test('both workspaces save first and accept adopted versions through the composable', () => {
  for (const path of ['../app/views/drama/episode.vue', '../app/views/drama/previs.vue']) {
    const source = read(path)
    assert.ok(/<StoryboardGridTools\b/.test(source), `${path} must expose grid tools`)
    assert.ok(/:before-action=/.test(source), `${path} must save before grid actions`)
    assert.ok(/adoptGridCandidate/.test(source), `${path} must accept adopted versions through the stable workspace`)
    assert.ok(/:commit-adoption=/.test(source), `${path} must own the adoption commit outside the review component`)
  }
})
