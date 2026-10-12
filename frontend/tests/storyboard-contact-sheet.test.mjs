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
  runInNewContext(ts.transpileModule(source.replaceAll('import.meta.client', 'true'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports,
    require: name => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] },
    crypto: {}, setTimeout, clearTimeout, setInterval, clearInterval, ...globals,
  })
  return module.exports
}
const domain = evaluate(read('../../backend/src/services/previs-domain.ts'))
const contract = evaluate(read('../../backend/src/services/previs-frame-contract.ts'))
const reference = evaluate(read('../../backend/src/services/previs-video-reference-domain.ts'), { './previs-domain.js': domain })
const sheets = evaluate(read('../../backend/src/services/previs-contact-sheet-domain.ts'), { './previs-domain.js': domain })
const panel = () => ({ id: 7, title: '开门', durationMs: 6000, referenceImages: [], frames: [
  { ...domain.makeFrame('one', 0), url: '/static/one.png' },
  { ...domain.makeFrame('two', 5999), url: '/static/two.png' },
] })
const sheet = target => ({ panelId: target.id, status: 'ready', sourceHash: 'source', artifactId: 2, artifactHash: 'render',
  annotatedUrl: '/static/sheet.jpg', cleanUrl: '/static/clean.jpg', thumbnailUrl: '/static/thumb.webp',
  descriptor: sheets.contactSheetDescriptor(target, '16:9'), readyFrames: 2, totalFrames: 2, error: null,
})
function api(globals = {}, notices = []) {
  return evaluate(read('../app/composables/usePrevis.ts'), {
    vue: { ...vue, onUnmounted() {} }, 'vue-sonner': { toast: { error: message => notices.push(message), success() {} } },
    '../../../backend/src/services/previs-domain': domain,
    '../../../backend/src/services/previs-frame-contract': contract,
    '../../../backend/src/services/previs-video-reference-domain': reference,
  }, { localStorage: { getItem() { return null }, setItem() {} }, ...globals })
}
const version = (target = panel(), status = 'ready') => ({ id: 4, revision: 2, status: 'draft', busy: false, isCurrent: false,
  timeline: { panels: [target], groups: [{ id: 'panel-7', panelIds: [7] }], audio: [] }, batches: [], outputs: [], contactSheets: [{ ...sheet(target), status }],
})
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

test('a locally changed URL, offset, order or deleted frame invalidates a ready sheet', () => {
  const fn = api().contactSheetForPanel
  assert.equal(typeof fn, 'function')
  for (const mutate of [p => { p.frames[0].url = '/static/new.png' }, p => { p.frames[0].offsetMs = 1 },
    p => { p.frames[0].offsetMs = 5999; p.frames[1].offsetMs = 0 }, p => { p.frames.pop() }]) {
    const target = panel(), original = sheet(target)
    mutate(target)
    const result = fn(target, original)
    assert.equal(result.status, 'stale')
    assert.equal(result.annotatedUrl, null)
    assert.equal(result.cleanUrl, null)
    assert.equal(result.thumbnailUrl, null)
  }
  const target = panel(), original = sheet(target)
  target.frames[0].prompt = '只改提示词'
  assert.equal(fn(target, original).status, 'ready')
  const empty = panel()
  empty.frames = []
  assert.equal(fn(empty, { ...sheet(panel()), descriptor: null, status: 'none', totalFrames: 0 }).status, 'none')
})

test('individual and automatic references work after composition failure, while an explicit sheet must be current', () => {
  const fn = api().videoReferenceReadiness
  assert.equal(typeof fn, 'function')
  const target = panel(), failed = { ...sheet(target), status: 'failed', cleanUrl: null }
  assert.equal(fn([target], 'individual', 9, [failed]).ready, true)
  assert.equal(fn([target], 'auto', 9, [failed]).effective, 'individual')
  assert.equal(fn([target], 'auto', 9, [failed]).ready, true)
  assert.equal(fn([target], 'contact_sheet', 9, [failed]).ready, false)
  assert.equal(fn([target], 'contact_sheet', 9, [sheet(target)]).ready, true)
  target.frames[0].url = ''
  assert.equal(fn([target], 'individual', 9, [failed]).ready, false)
})

test('reference strategy is restored and persisted across both workspaces', async () => {
  const saved = new Map([['huobao:video-reference-input-strategy', 'contact_sheet']])
  const fn = api({ localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) } }).useVideoReferenceInputStrategy
  assert.equal(typeof fn, 'function')
  const preference = fn()
  assert.equal(preference.value, 'contact_sheet')
  preference.value = 'individual'
  await vue.nextTick()
  assert.equal(saved.get('huobao:video-reference-input-strategy'), 'individual')
})

test('same-revision polling merges composed sheets without replacing the timeline', async () => {
  let tick
  const initial = version(panel(), 'composing'), ready = sheet(initial.timeline.panels[0])
  const h = api({ setInterval: fn => { tick = fn; return 1 }, fetch: async url => ({ ok: true,
    json: async () => ({ data: url.endsWith('/state') ? { revision: 2, requiresRefresh: false, contactSheets: [ready] } : initial }),
  }) }).usePrevis()
  await h.initialize(1)
  const before = h.version.value.timeline
  await tick()
  await flush()
  assert.equal(h.version.value.contactSheets[0].status, 'ready')
  assert.equal(h.version.value.timeline, before)
})

test('accepting missing sheets requests composition once and never automatically retries failed sheets', async () => {
  for (const status of ['none', 'stale', 'failed']) {
    const requests = [], initial = version(panel(), status)
    const h = api({ fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, json: async () => ({ data: options.method === 'POST' ? { items: [{ ...sheet(initial.timeline.panels[0]), status: 'composing' }] } : initial }) }
    } }).usePrevis()
    await h.open(4)
    await flush()
    const compositions = requests.filter(request => request.url.endsWith('/contact-sheets'))
    assert.equal(compositions.length, status === 'failed' ? 0 : 1)
    if (compositions.length) assert.equal(JSON.parse(compositions[0].options.body).revision, 2)
  }
})

test('saving a changed frame automatically composes the saved version and explicit retry uses its revision', async () => {
  const requests = [], initial = version(), next = version()
  next.revision = 3; next.contactSheets[0].status = 'stale'
  const h = api({ setTimeout: () => 1, fetch: async (url, options) => {
    requests.push({ url, options })
    return { ok: true, json: async () => ({ data: url.includes('/contact-sheets') ? { items: next.contactSheets } : options.method === 'PUT' ? next : initial }) }
  } }).usePrevis()
  await h.open(4)
  h.edit(timeline => { timeline.panels[0].frames[0].url = '/static/new.png' })
  await h.save(); await flush()
  const compositions = requests.filter(request => request.url.endsWith('/contact-sheets'))
  assert.equal(compositions.length, 1)
  assert.equal(JSON.parse(compositions[0].options.body).revision, 3)
  assert.equal(typeof h.retryContactSheet, 'function')
  await h.retryContactSheet(7)
  assert.equal(JSON.parse(requests.at(-1).options.body).revision, 3)
  assert.match(requests.at(-1).url, /contact-sheets\/7\/retry$/)
})

test('contact-sheet hotspots follow descriptor percentages and emit the selected frame', () => {
  const path = '../app/components/previs/StoryboardContactSheet.vue'
  assert.ok(existsSync(new URL(path, import.meta.url)), 'The contact-sheet preview component is required')
  const descriptor = parse(read(path)).descriptor
  const script = compileScript(descriptor, { id: 'sheet-hotspots' })
  const component = evaluate(script.content, { vue, 'lucide-vue-next': {}, '~/composables/usePrevis': { ...domain, ...api() } }).default
  const target = panel(), props = { panel: target, sheet: sheet(target), compact: false, activeFrameId: 'one' }, changes = []
  const setup = component.setup(props, { expose() {}, emit: (event, ...args) => changes.push({ event, args }) })
  assert.deepEqual(JSON.parse(JSON.stringify(setup.cellStyle(props.sheet.descriptor.cells[1]))), { left: '50%', top: '0%', width: '50%', height: '100%' })
  setup.select('two', {})
  assert.equal(changes[0].event, 'select')
  assert.equal(changes[0].args[0], 'two')
  const template = compileTemplate({ source: descriptor.template.content, filename: 'StoryboardContactSheet.vue', id: 'sheet-hotspots', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
})

test('workbench and standalone handlers submit the chosen strategy and block unavailable sheet inputs', async () => {
  for (const [path, names] of [['../app/views/drama/episode.vue', ['genVid', 'confirmBatchVideos']], ['../app/views/drama/previs.vue', ['startVideo']]]) {
    const ast = ts.createSourceFile(path, parse(read(path)).descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true)
    const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => `export ${node.getText(ast)}`).join('\n')
    for (const name of names) for (const ready of [true, false]) {
      const submissions = [], errors = []
      const submit = async (type, payload) => submissions.push({ type, payload })
      const model = { key: 'provider/model', configId: 9, model: 'model' }
      const state = { ready, error: '宫格尚未就绪', effective: 'contact_sheet' }
      const h = evaluate(functions, {}, {
        videoReferenceInputStrategy: vue.ref('contact_sheet'), videoUsesStoryboardFrames: vue.ref(true),
        videoGenerationMode: vue.ref('storyboard_frames'), videoModel: vue.ref(model.key),
        videoModelOptions: vue.ref([model]), productionVersion: vue.ref({ id: 4 }),
        productionPanelById: () => panel(), videoCanGenerate: () => ready, productionReferenceState: () => state,
        generateProduction: submit, generate: submit, toast: { success() {}, error: message => errors.push(message) },
        toastError: error => { throw error }, t: key => key, failedVideoMessages: vue.ref({}),
        batchVideoConfirm: vue.ref({ open: true, targets: [{ id: 7 }] }), videoSelectMode: vue.ref(false),
        modelChoice: () => model, videoReferenceState: vue.ref(state), incompleteVideoPanels: vue.ref([]),
        videoPanelIds: vue.ref([7]), modal: vue.ref('video'), inspector: vue.ref('frames'),
      })
      if (name === 'genVid') await h[name]({ id: 7 })
      else await h[name]()
      assert.equal(submissions.length, ready ? 1 : 0, `${name} must guard unavailable contact sheets`)
      if (ready) {
        assert.equal(submissions[0].type, 'video')
        assert.equal(submissions[0].payload.videoReferenceInputStrategy, 'contact_sheet')
        assert.deepEqual(Array.from(submissions[0].payload.panelIds), [7])
      } else assert.match(errors[0], /宫格尚未就绪/)
    }
  }
})

test('frame editor defaults to the sheet overview and retains every card action in edit mode', () => {
  const descriptor = parse(read('../app/components/previs/StoryboardFramesEditor.vue')).descriptor
  const script = compileScript(descriptor, { id: 'sheet-overview' })
  const sheetStub = { name: 'sheet-preview' }
  const icons = Object.fromEntries(['Film', 'History', 'ImagePlus', 'Loader2', 'MoreHorizontal', 'SlidersHorizontal', 'Sparkles', 'Star', 'Upload'].map(name => [name, 'svg']))
  const component = evaluate(script.content, {
    vue, 'vue-sonner': { toast: {} }, 'lucide-vue-next': icons, '~/components/AppMenu.vue': { default: { name: 'menu' } }, '~/components/AppMenuItem.vue': { default: { name: 'menu-item' } },
    './FrameSettingsDialog.vue': {}, './StoryboardContactSheet.vue': { default: sheetStub }, '~/composables/useApi': { uploadAPI: {} },
    '~/composables/usePrevis': { ...domain, ...api() },
  }).default
  const target = panel(), props = { panel: target, contactSheet: sheet(target), editable: true, generatable: true, tasks: [] }
  const setup = component.setup(props, { expose() {}, emit() {} })
  const template = compileTemplate({ source: descriptor.template.content, filename: 'StoryboardFramesEditor.vue', id: 'sheet-overview', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const { render } = evaluate(template.code, { vue: { ...vue, withDirectives: vnode => vnode } })
  function nodes(node) {
    return [node, ...(Array.isArray(node?.children) ? node.children.flatMap(nodes) : [])]
  }
  const overview = nodes(render({}, [], props, vue.proxyRefs(setup), {}, {}))
  assert.ok(overview.some(node => node.type === sheetStub))
  assert.equal(overview.filter(node => node.type === 'article').length, 0)
  setup.editing.value = true
  const editing = nodes(render({}, [], props, vue.proxyRefs(setup), {}, {}))
  assert.equal(editing.filter(node => node.type === 'article').length, 2)
  assert.ok(editing.some(node => node.props?.class?.includes('frame-settings-action')))
  assert.ok(editing.some(node => node.props?.onClick && node.type === 'button'))
})
