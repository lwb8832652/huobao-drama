import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
function evaluate(source, dependencies = {}, globals = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(source.replaceAll('import.meta.client', 'false'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(output, {
    module, exports: module.exports,
    require: name => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`)
      return dependencies[name]
    },
    crypto: {}, setTimeout, clearTimeout, setInterval, clearInterval, ...globals,
  })
  return module.exports
}
const domain = evaluate(read('../../backend/src/services/previs-domain.ts'))
const reference = evaluate(read('../../backend/src/services/previs-video-reference-domain.ts'), { './previs-domain.js': domain })
const contract = evaluate(read('../../backend/src/services/previs-frame-contract.ts'))
const panel = () => ({
  id: 7, title: '开门', description: '【镜头1】走到门前。【镜头2】推开门。',
  atmosphere: '安静', imagePrompt: '', durationMs: 6000, frames: [], referenceImages: [],
})
const draft = () => ({
  taskId: 13, panelId: 7, panelTitle: '开门', count: 2, source: 'ai', frames: [
    { title: '门前', prompt: '走到门前', offsetMs: 0, type: 'start' },
    { title: '开门', prompt: '推开门', offsetMs: 3000, type: 'end' },
  ],
})
const complete = () => ({ items: [{ id: 13, panelId: 7, status: 'completed' }], plans: [draft()] })

function frameDetails(frame, extra = {}) {
  const descriptor = parse(read('../app/components/previs/FrameSettingsDialog.vue')).descriptor
  const script = compileScript(descriptor, { id: 'frame-details-test' })
  const component = evaluate(script.content, {
    vue: { ...vue, useId: () => 'details', onMounted() {}, onBeforeUnmount() {}, onUnmounted() {} },
    'lucide-vue-next': {}, '~/composables/usePrevis': domain,
  }).default
  const changes = [], props = { panel: panel(), frame, editable: true, canRefineGrid: true, canRefineFrame: true, ...extra }
  const setup = component.setup(props, { expose() {}, emit: (event, ...args) => changes.push({ event, args }) })
  setup.form.value = { reportValidity: () => true }
  return { setup, props, changes, descriptor, script }
}

test('frame details default to group continuity and emit a direct refinement with no planning write', () => {
  for (const mode of ['grid_edit', 'frame_edit']) {
    const h = frameDetails({ ...domain.makeFrame('two'), url: '/static/two.png' })
    assert.equal(h.setup.refinementMode.value, 'grid_edit')
    assert.equal(h.setup.planningOpen.value, false)
    h.setup.refinementMode.value = mode; h.setup.refinementInstruction.value = '  右手放低  '
    h.setup.refine()
    assert.equal(h.changes.length, 1)
    assert.equal(h.changes[0].event, 'refine')
    assert.deepEqual(JSON.parse(JSON.stringify(h.changes[0].args[0])), { frameId: 'two', mode, instruction: '右手放低' })
  }
})

test('saving planning retains existing image and references and never requests generation', () => {
  const h = frameDetails({ ...domain.makeFrame('two'), url: '/static/two.png', referenceImages: ['/static/old-reference.png'] })
  h.setup.draft.value.prompt = '抬头'; h.setup.draft.value.continuity = '服装沿用上一格'
  h.setup.save(true)
  assert.equal(h.changes.length, 1)
  assert.equal(h.changes[0].event, 'frame')
  assert.equal(h.changes[0].args[0].prompt, '抬头')
  assert.equal(h.changes[0].args[0].continuity, '服装沿用上一格')
  assert.equal(h.changes[0].args[0].url, undefined)
  assert.equal(h.changes[0].args[0].referenceImages, undefined)
  assert.equal(h.changes[0].args[1], false)
  assert.doesNotMatch(h.descriptor.template.content, /保存并|toggleReference|settings-assets/)
})

test('missing images open planning and locked or unsupported details cannot refine or restore', () => {
  const missing = frameDetails(domain.makeFrame('missing'))
  assert.equal(missing.setup.planningOpen.value, true)
  missing.setup.refinementInstruction.value = '改光线'; missing.setup.refine()
  assert.equal(missing.changes.length, 0)
  for (const extra of [{ editable: false }, { canRefineGrid: false, canRefineFrame: false }, { frame: { ...domain.makeFrame('locked'), locked: true, url: '/static/locked.png' } }]) {
    const h = frameDetails({ ...domain.makeFrame('two'), url: '/static/two.png' }, extra)
    h.setup.refinementInstruction.value = '改光线'; h.setup.refine()
    assert.equal(h.changes.length, 0)
    if (h.props.frame.locked || !h.props.editable) { h.setup.save(); assert.equal(h.changes.length, 0) }
  }
})

test('using a historical version restores only the image provenance and leaves planning drafts unsaved', () => {
  const h = frameDetails({ ...domain.makeFrame('two'), url: '/static/current.png', prompt: '原规划', history: [{ url: '/static/old.png', taskId: 2, source: { candidateId: 3, mode: 'generate' } }] })
  h.setup.draft.value.prompt = '尚未确认的规划'; h.setup.draft.value.url = '/static/old.png'
  h.setup.saveHistory()
  assert.equal(h.changes[0].args[0].url, '/static/old.png')
  assert.equal(h.changes[0].args[0].taskId, 2)
  assert.equal(h.changes[0].args[0].source.candidateId, 3)
  assert.equal(h.changes[0].args[0].prompt, undefined)
  assert.match(h.descriptor.template.content, /<details\s+v-if="[^"]*" class="settings-history"/)
})

test('integrated overview stays on the sheet when details open and routes one guarded refinement', () => {
  const descriptor = parse(read('../app/components/previs/StoryboardFramesEditor.vue')).descriptor
  const component = evaluate(compileScript(descriptor, { id: 'integrated-details' }).content, {
    vue, 'vue-sonner': { toast: {} }, 'lucide-vue-next': {},
    '~/components/AppMenu.vue': {}, '~/components/AppMenuItem.vue': {}, './FrameSettingsDialog.vue': {},
    './StoryboardContactSheet.vue': {}, '~/composables/useApi': { uploadAPI: {} },
    '~/composables/usePrevis': { ...domain, ...contract },
  }).default
  const changes = [], target = panel(); target.frames = [{ ...domain.makeFrame('one'), url: '/static/current.png' }]
  const props = { panel: target, editable: true, tasks: [], integrated: true, planning: false, canRefineGrid: true, canRefineFrame: true }
  const setup = component.setup(props, { expose() {}, emit: (event, ...args) => changes.push({ event, args }) })
  setup.selectSheetFrame('one', { currentTarget: {} })
  assert.equal(setup.editing.value, false); assert.equal(setup.showPlanning.value, false)
  setup.refineFrame({ frameId: 'one', mode: 'grid_edit', instruction: '调整视线' })
  assert.equal(changes.filter(change => change.event === 'refine').length, 1)
  assert.equal(setup.settings.value, undefined)
  setup.selectSheetFrame('one', { currentTarget: {} }); target.frames[0].locked = true
  setup.refineFrame({ frameId: 'one', mode: 'frame_edit', instruction: '调整视线' })
  assert.equal(changes.filter(change => change.event === 'refine').length, 1)
})

test('single image uploads preserve the previous source and stop if the frame becomes locked', async () => {
  const descriptor = parse(read('../app/components/previs/StoryboardFramesEditor.vue')).descriptor
  let completeUpload
  const component = evaluate(compileScript(descriptor, { id: 'upload-provenance' }).content, {
    vue, 'vue-sonner': { toast: {} }, 'lucide-vue-next': {},
    '~/components/AppMenu.vue': {}, '~/components/AppMenuItem.vue': {}, './FrameSettingsDialog.vue': {},
    './StoryboardContactSheet.vue': {}, '~/composables/useApi': { uploadAPI: { image: () => new Promise(resolve => { completeUpload = resolve }) } },
    '~/composables/usePrevis': { ...domain, ...contract },
  }).default
  for (const locked of [false, true]) {
    const changes = [], target = panel(); target.frames = [{ ...domain.makeFrame('one'), url: '/static/current.png', taskId: 2, source: { candidateId: 3, mode: 'frame_edit' } }]
    const setup = component.setup({ panel: target, editable: true, tasks: [] }, { expose() {}, emit: (event, ...args) => changes.push({ event, args }) })
    setup.chooseUpload(target.frames[0]); const operation = setup.upload({ target: { files: [{}], value: 'selected' } })
    target.frames[0].locked = locked; completeUpload({ path: '/static/upload.png' }); await operation
    if (locked) assert.equal(changes.length, 0)
    else {
      const uploaded = changes[0].args[0][0]
      assert.equal(uploaded.source, undefined)
      assert.equal(uploaded.history.find(entry => entry.url === '/static/current.png').source.candidateId, 3)
    }
  }
})

function harness({ results = [complete()], saveResult = true, requestError } = {}) {
  const requests = [], notices = [], disposers = []
  const toast = Object.fromEntries(['error', 'success', 'info'].map(kind => [kind, message => notices.push({ kind, message })]))
  const api = evaluate(read('../app/composables/usePrevis.ts'), {
    vue: { ...vue, onUnmounted: fn => disposers.push(fn) },
    'vue-sonner': { toast },
    '../../../backend/src/services/previs-domain': domain,
    '../../../backend/src/services/previs-frame-contract': contract,
    '../../../backend/src/services/previs-video-reference-domain': reference,
  }, {
    fetch: async (url, options) => {
      requests.push({ url, method: options.method, body: options.body && JSON.parse(options.body) })
      if (requestError) throw requestError
      const data = options.method === 'POST' ? { queued: 1, taskIds: [13] } : results.shift()
      assert.ok(data, 'Unexpected polling request')
      return { ok: true, json: async () => ({ data }) }
    },
    setTimeout: callback => { queueMicrotask(callback); return 1 },
  })
  const workspace = {
    version: vue.ref({ id: 4, revision: 2, timeline: { panels: [panel()] } }),
    editable: vue.ref(true),
    save: async () => { workspace.version.value.revision++; return saveResult },
    edit: action => action(workspace.version.value.timeline),
  }
  assert.equal(typeof api.useFramePlanner, 'function', 'The workbench needs a connected frame planner')
  const planner = api.useFramePlanner(workspace, () => ({ configId: 9, model: 'selected-text-model' }))
  return { api, workspace, planner, requests, notices, disposers }
}

test('workbench connects the AI split event and the plan dialog', () => {
  const source = read('../app/views/drama/episode.vue')
  const editor = source.match(/<StoryboardFramesEditor\b[\s\S]*?\/>/)[0]
  assert.match(editor, /@split=/, 'AI split clicks must reach a workbench handler')
  assert.match(source, /<FramePlanDialog\b[\s\S]*?@apply=/, 'Completed plans must be reviewable and applicable')
})

test('description planning works without crypto.randomUUID on HTTP and preserves existing images', () => {
  const notices = [], changes = []
  const api = evaluate(read('../app/composables/usePrevis.ts'), {
    vue, 'vue-sonner': { toast: {} }, '../../../backend/src/services/previs-domain': domain,
    '../../../backend/src/services/previs-frame-contract': contract,
    '../../../backend/src/services/previs-video-reference-domain': reference,
  })
  const descriptor = parse(read('../app/components/previs/StoryboardFramesEditor.vue')).descriptor
  const component = evaluate(compileScript(descriptor, { id: 'frame-editor-test' }).content, {
    vue, 'vue-sonner': { toast: { success: message => notices.push(message) } },
    'lucide-vue-next': {}, '~/components/AppMenu.vue': {}, '~/components/AppMenuItem.vue': {},
    './FrameSettingsDialog.vue': {}, './StoryboardContactSheet.vue': {}, '~/composables/useApi': { uploadAPI: {} },
    '~/composables/usePrevis': { ...domain, ...api },
  }).default
  const target = panel()
  target.frames = [domain.makeFrame('existing')]
  target.frames[0].url = '/static/existing.png'
  const setup = component.setup({ panel: target, editable: true, tasks: [] }, {
    expose() {}, emit: (event, ...args) => changes.push({ event, args }),
  })
  setup.plan()
  assert.equal(changes.length, 1)
  assert.equal(changes[0].event, 'change')
  const frames = changes[0].args[0]
  assert.equal(frames.length, 2)
  assert.equal(frames[0].url, '/static/existing.png')
  assert.match(frames[1].prompt, /推开门/)
  assert.equal(new Set(frames.map(frame => frame.id)).size, 2)
})

test('frame generation stays available while another frame is generating', () => {
  const descriptor = parse(read('../app/components/previs/StoryboardFramesEditor.vue')).descriptor
  const component = evaluate(compileScript(descriptor, { id: 'frame-generate-test' }).content, {
    vue, 'vue-sonner': { toast: {} },
    'lucide-vue-next': {}, '~/components/AppMenu.vue': {}, '~/components/AppMenuItem.vue': {},
    './FrameSettingsDialog.vue': {}, './StoryboardContactSheet.vue': {}, '~/composables/useApi': { uploadAPI: {} },
    '~/composables/usePrevis': { ...domain, ...contract },
  }).default
  const target = panel()
  target.referenceImages = ['/static/role.png']
  target.frames = [
    { ...domain.makeFrame('busy-frame'), type: 'start', url: '' },
    { ...domain.makeFrame('idle-frame'), type: 'end', url: '' },
  ]
  const running = [{ id: 1, frameId: 'busy-frame', frameType: 'start', panelId: 7, status: 'processing' }]
  // 后台任务在跑时 editable=false（busy），但 generatable 仍为真：其他画面的生成入口必须保留。
  const setup = component.setup(
    { panel: target, editable: false, generatable: true, tasks: running },
    { expose() {}, emit() {} },
  )
  assert.equal(setup.canGenerate(target.frames[1]), true)
  assert.equal(setup.canGenerateMissing.value, false)
  // 本帧已有任务在跑时禁用，避免对同一画面重复提交。
  assert.equal(setup.canGenerate(target.frames[0]), false)
  const idle = component.setup(
    { panel: target, editable: false, generatable: true, tasks: [] },
    { expose() {}, emit() {} },
  )
  assert.equal(idle.canGenerateMissing.value, true)
  // 锁定版本（generatable=false）一律禁止生成。
  const locked = component.setup(
    { panel: target, editable: false, generatable: false, tasks: [] },
    { expose() {}, emit() {} },
  )
  assert.equal(locked.canGenerate(target.frames[1]), false)
  // 缺参考素材仍禁用（面板级回退也为空时）。
  const bare = panel()
  bare.frames = [{ ...domain.makeFrame('bare-frame'), type: 'end', url: '' }]
  const noRefs = component.setup(
    { panel: bare, editable: true, generatable: true, tasks: [] },
    { expose() {}, emit() {} },
  )
  assert.equal(noRefs.canGenerate(bare.frames[0]), false)
})

test('locked frames reject settings, legacy generation, removal, upload and description planning', () => {
  const descriptor = parse(read('../app/components/previs/StoryboardFramesEditor.vue')).descriptor
  const changes = []
  const component = evaluate(compileScript(descriptor, { id: 'locked-frame-test' }).content, {
    vue, 'vue-sonner': { toast: { error() {}, success() {} } }, 'lucide-vue-next': {},
    '~/components/AppMenu.vue': {}, '~/components/AppMenuItem.vue': {}, './FrameSettingsDialog.vue': {},
    './StoryboardContactSheet.vue': {}, '~/composables/useApi': { uploadAPI: {} },
    '~/composables/usePrevis': { ...domain, ...contract },
  }).default
  const target = panel(); target.referenceImages = ['/static/role.png']
  target.frames = [{ ...domain.makeFrame('locked'), locked: true, url: '/static/locked.png' }]
  const setup = component.setup({ panel: target, editable: true, generatable: true, tasks: [] }, {
    expose() {}, emit: (event, ...args) => changes.push({ event, args }),
  })
  assert.equal(setup.canEdit(target.frames[0]), false)
  assert.equal(setup.canGenerate(target.frames[0]), false)
  setup.remove(target.frames[0]); setup.chooseUpload(target.frames[0]); setup.plan()
  assert.equal(changes.length, 0); assert.equal(setup.uploadTarget.value, undefined)
})

test('generate resubmits with the refreshed revision after the service rejects a stale one', async () => {
  const notices = []
  const toast = Object.fromEntries(['error', 'success', 'info'].map(kind => [kind, message => notices.push({ kind, message })]))
  const submitted = []
  let serverRevision = 2
  const versionPayload = () => ({
    id: 4, revision: serverRevision, status: 'draft', busy: false, isCurrent: true, timeline: { panels: [panel()] },
  })
  const api = evaluate(read('../app/composables/usePrevis.ts'), {
    vue, 'vue-sonner': { toast }, '../../../backend/src/services/previs-domain': domain,
    '../../../backend/src/services/previs-frame-contract': contract,
    '../../../backend/src/services/previs-video-reference-domain': reference,
  }, {
    fetch: async (url, options) => {
      const method = options?.method || 'GET'
      if (url.endsWith('/batch-runs')) {
        const body = JSON.parse(options.body)
        submitted.push(body.revision)
        const accepted = body.revision === serverRevision
        return {
          ok: accepted, status: accepted ? 200 : 409,
          json: async () => (accepted ? { data: {} } : { message: '版本已更新，请先刷新；本地修改可复制后重新应用。' }),
        }
      }
      return { ok: true, json: async () => ({ data: versionPayload() }) }
    },
    setTimeout: callback => { queueMicrotask(callback); return 1 },
  })
  const previs = api.usePrevis()
  await previs.open(4)
  assert.equal(previs.version.value.revision, 2)
  // 后台任务完成写回把服务端 revision 推到 3，本地仍持 2。
  serverRevision = 3
  await previs.generate('image', { panelIds: [7], frameIds: ['frame-1'] })
  assert.deepEqual(submitted, [2, 3])
  assert.equal(previs.version.value.revision, 3)
  assert.ok(notices.some(notice => notice.kind === 'success' && /已同步最新版本/.test(notice.message)))
})

test('AI split opens progress immediately, uses the saved revision and selected model, then shows the plan', async () => {
  const h = harness({ results: [
    { items: [{ id: 13, panelId: 7, status: 'processing' }], plans: [] }, complete(),
  ] })
  const operation = h.planner.split(7)
  assert.equal(h.planner.open.value, true)
  assert.equal(h.planner.busy.value, true)
  await operation
  assert.equal(h.requests[0].method, 'POST')
  assert.equal(h.requests[0].body.revision, 3)
  assert.deepEqual(h.requests[0].body.panelIds, [7])
  assert.equal(h.requests[0].body.configId, 9)
  assert.equal(h.requests[0].body.model, 'selected-text-model')
  assert.equal(h.planner.plans.value[0].frames.length, 2)
  assert.equal(h.planner.busy.value, false)
  assert.equal(h.workspace.version.value.timeline.panels[0].frames.length, 0)
})

test('applying a plan writes to its original panel, retains image history, and saves', async () => {
  const h = harness()
  const target = h.workspace.version.value.timeline.panels[0]
  target.frames = [{ ...domain.makeFrame('old'), url: '/static/old.png' }]
  await h.planner.split(7, { force: true })
  h.workspace.version.value.timeline.panels.push({ ...panel(), id: 8 })
  await h.planner.apply(h.planner.plans.value)
  assert.equal(target.frames.length, 2)
  assert.equal(target.frames[0].prompt, '走到门前')
  assert.equal(target.frames[0].url, '/static/old.png')
  assert.equal(target.frames[0].id, 'old')
  assert.equal(target.frames[0].history[0].url, '/static/old.png')
  assert.equal(h.workspace.version.value.timeline.panels[1].frames.length, 0)
  assert.equal(h.planner.open.value, false)
  assert.equal(h.workspace.version.value.revision, 4)
})

test('revised plans match stable IDs before positions and carry shared and per-frame continuity', () => {
  const h = harness(), target = panel()
  target.continuityConstraints = '原约束'
  target.frames = [
    { ...domain.makeFrame('one', 0), url: '/static/one.png', referenceImages: ['/static/role.png'], source: { candidateId: 1, mode: 'generate' }, continuity: '原衔接' },
    { ...domain.makeFrame('two', 1000), url: '/static/two.png', history: [{ url: '/static/older.png' }] },
  ]
  target.coverFrameId = 'one'
  h.api.applyFramePlanToPanel(target, { ...draft(), continuityConstraints: '服装和轴线不变', frames: [
    { id: 'two', title: '先开门', prompt: '开门', offsetMs: 0, type: 'start', continuity: '右手沿用前格' },
    { id: 'one', title: '再转身', prompt: '转身', offsetMs: 3000, type: 'end' },
  ] })
  assert.equal(target.frames[0].id, 'two'); assert.equal(target.frames[0].url, '/static/two.png')
  assert.equal(target.frames[0].history[0].url, '/static/older.png')
  assert.equal(target.frames[0].continuity, '右手沿用前格')
  assert.equal(target.frames[1].id, 'one'); assert.equal(target.frames[1].url, '/static/one.png')
  assert.equal(target.frames[1].referenceImages[0], '/static/role.png')
  assert.equal(target.frames[1].source.candidateId, 1); assert.equal(target.frames[1].continuity, '原衔接')
  assert.equal(target.continuityConstraints, '服装和轴线不变'); assert.equal(target.coverFrameId, 'one')
})

test('frame plan application cannot change any metadata or image of a locked slot', () => {
  const h = harness(), target = panel()
  target.frames = [{ ...domain.makeFrame('locked'), locked: true, url: '/static/locked.png', prompt: '已确认的画面' }]
  const before = JSON.stringify(target)
  assert.equal(h.api.applyFramePlanToPanel(target, draft()), false)
  assert.equal(JSON.stringify(target), before)
})

test('adopted versions reset saved history and keep the old autosave timer cancelled', async () => {
  const timers = new Set(), writes = []
  const payload = { id: 4, revision: 2, status: 'draft', busy: false, timeline: { panels: [panel()], groups: [], audio: [] } }
  const api = evaluate(read('../app/composables/usePrevis.ts'), {
    vue: { ...vue, onUnmounted() {} }, 'vue-sonner': { toast: {} },
    '../../../backend/src/services/previs-domain': domain,
    '../../../backend/src/services/previs-frame-contract': contract,
    '../../../backend/src/services/previs-video-reference-domain': reference,
  }, {
    fetch: async (url, options) => { writes.push(options?.method); return { ok: true, json: async () => ({ data: { ...payload, revision: options?.method === 'PUT' ? 3 : 2 } }) } },
    setTimeout: callback => { timers.add(callback); return callback }, clearTimeout: callback => timers.delete(callback),
  })
  const workspace = api.usePrevis(); await workspace.open(4)
  workspace.edit(timeline => { timeline.panels[0].title = '保存后的候选' })
  assert.equal(workspace.dirty.value, true); assert.equal(timers.size, 1)
  await workspace.save()
  workspace.acceptGridVersion({ ...payload, revision: 9 })
  assert.equal(workspace.version.value.revision, 9); assert.equal(workspace.dirty.value, false)
  assert.equal(workspace.undoStack.value.length, 0); assert.equal(timers.size, 0)
  assert.equal(writes.filter(method => method === 'PUT').length, 1)
})

test('late adoption responses cannot replace dirty edits or a newer accepted revision', async () => {
  const notices = []
  const payload = { id: 4, revision: 2, status: 'draft', busy: false, timeline: { panels: [panel()], groups: [], audio: [] } }
  const api = evaluate(read('../app/composables/usePrevis.ts'), {
    vue: { ...vue, onUnmounted() {} }, 'vue-sonner': { toast: { error: message => notices.push(message) } },
    '../../../backend/src/services/previs-domain': domain,
    '../../../backend/src/services/previs-frame-contract': contract,
    '../../../backend/src/services/previs-video-reference-domain': reference,
  }, {
    fetch: async () => ({ ok: true, json: async () => ({ data: structuredClone(payload) }) }),
    setTimeout: () => 1, clearTimeout() {},
  })
  const workspace = api.usePrevis(); await workspace.open(4)
  workspace.edit(timeline => { timeline.panels[0].title = '必须保留的新标题' })
  const historyLength = workspace.undoStack.value.length
  assert.equal(workspace.acceptGridVersion({ ...payload, revision: 3 }), false)
  assert.equal(workspace.version.value.timeline.panels[0].title, '必须保留的新标题')
  assert.equal(workspace.dirty.value, true); assert.equal(workspace.undoStack.value.length, historyLength)
  workspace.dirty.value = false; workspace.version.value.revision = 5
  assert.equal(workspace.acceptGridVersion({ ...payload, revision: 3 }), false)
  assert.equal(workspace.version.value.revision, 5)
  assert.equal(workspace.version.value.timeline.panels[0].title, '必须保留的新标题')
  assert.ok(notices.length > 0)
})

test('changing the requested frame count submits a new forced plan', async () => {
  const h = harness({ results: [complete(), complete()] })
  await h.planner.split(7)
  await h.planner.recount(4)
  const submission = h.requests.filter(request => request.method === 'POST')[1]
  assert.equal(submission.body.count, 4)
  assert.equal(submission.body.force, true)
})

test('save failure prevents task submission and duplicate clicks do not submit twice', async () => {
  const failure = harness({ saveResult: false })
  await failure.planner.split(7)
  assert.equal(failure.requests.length, 0)
  assert.equal(failure.planner.open.value, false)
  const h = harness()
  await Promise.all([h.planner.split(7), h.planner.split(7)])
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1)
})

test('failed or unreachable split tasks show an error and release the busy state', async () => {
  for (const options of [
    { results: [{ items: [{ id: 13, panelId: 7, status: 'failed', error: '拆分失败' }], plans: [] }] },
    { requestError: new Error('网络不可用') },
  ]) {
    const h = harness(options)
    await h.planner.split(7)
    assert.equal(h.planner.busy.value, false)
    assert.equal(h.planner.open.value, false)
    assert.equal(h.notices.at(-1).kind, 'error')
  }
})

test('closing the dialog or leaving the page discards pending results', async () => {
  for (const dispose of [false, true]) {
    const h = harness()
    const operation = h.planner.split(7)
    if (dispose) h.disposers.forEach(fn => fn())
    else h.planner.close()
    await operation
    assert.equal(h.planner.open.value, false)
    assert.equal(h.planner.busy.value, false)
    assert.equal(h.planner.plans.value.length, 0)
    assert.equal(h.requests.length, 0)
  }
})

test('polling follows the submitted task when another description has a newer cached row', async () => {
  const stale = { ...draft(), taskId: 19, frames: [{ title: '旧方案', prompt: '另一段描述', offsetMs: 0, type: 'start' }] }
  const h = harness({ results: [
    { items: [{ id: 19, panelId: 7, status: 'completed' }, { id: 13, panelId: 7, status: 'processing' }], plans: [stale] },
    { items: [{ id: 19, panelId: 7, status: 'completed' }, { id: 13, panelId: 7, status: 'completed' }], plans: [stale, draft()] },
  ] })
  await h.planner.split(7)
  assert.equal(h.planner.plans.value[0].frames[0].prompt, '走到门前')
})

test('a retained single historical image can be selected and restored before generating another image', () => {
  const descriptor = parse(read('../app/components/previs/FrameSettingsDialog.vue')).descriptor
  const script = compileScript(descriptor, { id: 'history-test' })
  const component = evaluate(script.content, {
    vue: { ...vue, useId: () => 'history-test', onMounted() {}, onBeforeUnmount() {}, onUnmounted() {} },
    'lucide-vue-next': Object.fromEntries(['Check', 'ImagePlus', 'RotateCcw', 'SlidersHorizontal', 'Sparkles', 'X'].map(name => [name, 'svg'])),
    '~/composables/usePrevis': domain,
  }).default
  const props = { panel: panel(), frame: { ...domain.makeFrame('new'), history: [{ url: '/static/old.png' }] }, editable: true }
  const changes = []
  const setup = component.setup(props, { expose() {}, emit: (event, ...args) => changes.push({ event, args }) })
  const template = compileTemplate({ source: descriptor.template.content, filename: 'FrameSettingsDialog.vue', id: 'history-test', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const { render } = evaluate(template.code, { vue: { ...vue, withDirectives: vnode => vnode } })
  const tree = render({}, [], props, vue.proxyRefs(setup), {}, {})
  function findHistoryButton(node) {
    if (node?.props?.['aria-label'] === '使用历史图片 1') return node
    for (const child of Array.isArray(node?.children) ? node.children : []) {
      const found = findHistoryButton(child)
      if (found) return found
    }
  }
  const button = findHistoryButton(tree)
  assert.ok(button, 'Retained image history must remain accessible')
  button.props.onClick()
  setup.form.value = { reportValidity: () => true }
  setup.save()
  assert.equal(changes[0].args[0].url, '/static/old.png')
})

test('history restore carries the selected image source and clears stale refinement provenance for legacy images', () => {
  const descriptor = parse(read('../app/components/previs/FrameSettingsDialog.vue')).descriptor
  const component = evaluate(compileScript(descriptor, { id: 'history-source-test' }).content, {
    vue: { ...vue, useId: () => 'history-test', onMounted() {}, onBeforeUnmount() {}, onUnmounted() {} },
    'lucide-vue-next': {}, '~/composables/usePrevis': domain,
  }).default
  const splitSource = { candidateId: 20, mode: 'generate', gridIndex: 1 }
  for (const historical of [
    { url: '/static/split.png', taskId: 5, source: splitSource },
    { url: '/static/legacy.png', taskId: 6 },
  ]) {
    const frame = { ...domain.makeFrame('two'), url: '/static/refined.png', taskId: 9,
      source: { candidateId: 21, mode: 'frame_edit', gridIndex: 1 }, history: [historical] }
    const changes = []
    const setup = component.setup({ panel: panel(), frame, editable: true }, {
      expose() {}, emit: (event, ...args) => changes.push({ event, args }),
    })
    assert.equal(setup.historyImages.value[0].source.mode, 'frame_edit')
    assert.equal(setup.sourceLabel(setup.historyImages.value[0].source), '单格精修')
    assert.equal(setup.sourceLabel(splitSource), '原始切分')
    assert.equal(setup.sourceLabel({ mode: 'grid_edit' }), '整图微调')
    setup.draft.value.url = historical.url; setup.form.value = { reportValidity: () => true }; setup.save()
    const restored = changes[0].args[0]
    assert.equal(restored.url, historical.url); assert.equal(restored.taskId, historical.taskId)
    assert.equal(restored.source?.mode, historical.source?.mode)
    assert.ok(Object.hasOwn(restored, 'source'), 'Legacy restore must explicitly clear newer source')
  }
})

test('split submission identifies both new tasks and cached tasks, and results keep that identity', async () => {
  const source = read('../../backend/src/services/previs-frames.ts')
  const ast = ts.createSourceFile('previs-frames.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['startFramePlan', 'listFramePlans', 'clampCount', 'suggestedFrameCount']
  const functions = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text))
    .map(statement => statement.getText(ast)).join('\n')
  for (const status of [null, 'pending', 'completed']) {
    let row = status && { id: 13, panelId: 7, status, resultJson: JSON.stringify({ source: 'ai', frames: draft().frames }) }
    const builder = {
      from() { return this }, where() { return this }, orderBy() { return this },
      get: () => row, all: () => [row],
      set(values) { Object.assign(row, values); return this },
      values(values) { row = { id: 22, ...values }; return this },
      run: () => ({ lastInsertRowid: 22 }),
    }
    const db = { select: () => builder, update: () => builder, insert: () => builder }
    const target = { ...panel(), characterIds: [], propIds: [] }
    const timeline = { schemaVersion: 2, panels: [target], groups: [], transitions: [], audio: [], strategy: { ...domain.defaultStrategy } }
    const api = evaluate(functions, {}, {
      db, schema: { framePlans: {} }, ...contract,
      and() {}, eq() {}, desc() {},
      requireEditable: () => ({ timelineJson: JSON.stringify(timeline) }),
      episodeForPrevis: () => ({ id: 1, dramaId: 1 }),
      readFramePlanningContext: async () => ({}),
      versionRow: () => ({ timelineJson: JSON.stringify(timeline) }),
      normalizeTimeline: domain.normalizeTimeline,
      getConfigById: async () => ({ model: 'selected-text-model' }),
      planInputHash: () => 'current-description', tickFramePlans: async () => {},
    })
    const result = await api.startFramePlan(4, { revision: 2, panelIds: [7], configId: 9 })
    assert.equal(result.queued, status === 'completed' ? 0 : 1)
    assert.equal(result.taskIds[0], status ? 13 : 22)
    row.status = 'completed'
    row.resultJson = JSON.stringify({ source: 'ai', frames: draft().frames })
    assert.equal(api.listFramePlans(4).plans[0].taskId, result.taskIds[0])
  }
})
