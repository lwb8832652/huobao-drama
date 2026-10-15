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
// usePrevis.ts 依赖 useApi.ts 的 withNetworkRetry；useApi 自身无 import，直接跑真模块。
const useApi = evaluate(read('../app/composables/useApi.ts'))
const shotPlanning = evaluate(read('../../backend/src/services/shot-planning.ts'))
const domain = evaluate(read('../../backend/src/services/previs-domain.ts'), { './shot-planning.js': shotPlanning })
const contract = evaluate(read('../../backend/src/services/previs-frame-contract.ts'))
const reference = evaluate(read('../../backend/src/services/previs-video-reference-domain.ts'), { './previs-domain.js': domain })
const sheets = evaluate(read('../../backend/src/services/previs-contact-sheet-domain.ts'), { './previs-domain.js': domain, './previs-frame-contract.js': contract })
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
    '~/composables/useApi': useApi,
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

test('automatic group generation requires a ready sheet even for one selected panel', () => {
  const fn = api().videoReferenceReadiness
  const target = panel(), failed = { ...sheet(target), status: 'failed', cleanUrl: null }
  assert.equal(fn([target], 'auto', 9, [failed], 'storyboard').ready, true)
  const blocked = fn([target], 'auto', 9, [failed], 'group')
  assert.equal(blocked.effective, 'contact_sheet')
  assert.equal(blocked.ready, false)
  assert.match(blocked.error, /宫格尚未就绪/)
  assert.equal(fn([target], 'auto', 9, [sheet(target)], 'group').ready, true)
  assert.equal(fn([target], 'individual', 9, [failed], 'group').ready, true)
})

test('group scope checks provider support and the total integer duration as one task', () => {
  const fn = api().videoGenerationScopeError
  assert.equal(typeof fn, 'function')
  const first = panel(), second = { ...panel(), id: 8, durationMs: 7000 }
  const cap = { group: true, minSeconds: 2, maxSeconds: 12 }
  assert.equal(fn([first], 'group', cap), '')
  assert.equal(fn([first, second], 'storyboard', cap), '')
  assert.match(fn([first, second], 'group', cap), /13.*2–12/)
  assert.match(fn([first], 'group', { ...cap, group: false }), /不支持按组/)
  assert.match(fn([{ ...first, durationMs: 6500 }], 'group', cap), /整数秒/)
})

test('standalone readiness uses the selected scope instead of the legacy timeline strategy', () => {
  const path = '../app/views/drama/previs.vue'
  const ast = ts.createSourceFile(path, parse(read(path)).descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.flatMap(node => ts.isVariableStatement(node) ? Array.from(node.declarationList.declarations) : [])
    .find(node => node.name.getText(ast) === 'videoReferenceState')
  const first = panel(), second = { ...panel(), id: 8 }
  const scope = vue.ref('storyboard')
  const h = evaluate(`export const ${declaration.getText(ast)}`, {}, {
    computed: vue.computed, timeline: vue.ref({ strategy: { mode: 'group' } }), videoGenerationScope: scope,
    videoTargetPanels: vue.ref([first, second]), videoUsesStoryboardFrames: vue.ref(true),
    videoReferenceInputStrategy: vue.ref('auto'), videoCapability: vue.ref({ group: true, minSeconds: 2, maxSeconds: 12, maxImages: 1 }),
    version: vue.ref({ contactSheets: [sheet(first), sheet(second)] }),
    videoContinuityReadiness: api().videoContinuityReadiness, videoContinuityMode: vue.ref('reference'), videoContinuityCapability: vue.ref({ firstLast: false, reference: true }), videoReferenceReadiness: api().videoReferenceReadiness, videoGenerationScopeError: api().videoGenerationScopeError,
  })
  assert.equal(h.videoReferenceState.value.ready, true)
  scope.value = 'group'
  assert.equal(h.videoReferenceState.value.ready, false)
  assert.match(h.videoReferenceState.value.error, /当前输入 2 张/)
})

test('batch readiness uses the provider that default-model submission actually selects', () => {
  const path = '../app/views/drama/episode.vue'
  const ast = ts.createSourceFile(path, parse(read(path)).descriptor.scriptSetup.content, ts.ScriptTarget.Latest, true)
  const names = ['videoGenerationOption', 'selectedVideoConfig', 'batchVideoReferenceState']
  const declarations = ast.statements.flatMap(node => ts.isVariableStatement(node) ? Array.from(node.declarationList.declarations) : [])
    .filter(node => names.includes(node.name.getText(ast))).map(node => `export const ${node.getText(ast)}`).join('\n')
  const target = panel()
  for (const [defaultProvider, lockedProvider, ready] of [['aliyun', 'nuwax', true], ['minimax', 'aliyun', false]]) {
    const options = [{ key: `${defaultProvider}/default`, provider: defaultProvider, configId: 9, model: 'default' },
      { key: `${lockedProvider}/locked`, provider: lockedProvider, configId: 10, model: 'locked' }]
    const h = evaluate(declarations, {}, {
      computed: vue.computed, videoModel: vue.ref(''), videoModelOptions: vue.ref(options),
      videoConfigs: vue.ref(options.map(option => ({ ...option, id: option.configId, is_active: true, priority: option.configId === 9 ? 2 : 1 }))),
      lockedVideoConfigId: vue.ref(10), videoUsesStoryboardFrames: vue.ref(true),
      batchVideoGenerationScope: vue.ref('group'), batchVideoConfirm: vue.ref({ targets: [{ id: 7 }] }),
      productionPanelById: () => target, productionVersion: vue.ref({ contactSheets: [sheet(target)] }),
      videoReferenceInputStrategy: vue.ref('auto'),
      videoCapabilities: vue.ref({ aliyun: { group: true, minSeconds: 2, maxSeconds: 30, maxImages: 9 },
        nuwax: { group: false, minSeconds: 2, maxSeconds: 30, maxImages: 9 }, minimax: { group: true, minSeconds: 2, maxSeconds: 5, maxImages: 9 } }),
      videoContinuityReadiness: api().videoContinuityReadiness, videoContinuityMode: vue.ref('reference'), videoContinuityCapability: vue.ref({ firstLast: false, reference: true }), videoReferenceReadiness: api().videoReferenceReadiness, videoGenerationScopeError: api().videoGenerationScopeError,
    })
    assert.equal(h.selectedVideoConfig.value.provider, defaultProvider)
    assert.equal(h.batchVideoReferenceState.value.ready, ready)
    if (!ready) assert.match(h.batchVideoReferenceState.value.error, /6.*2–5/)
  }
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
  // 2 帧 16:9 → 1×2 宫格（1 列 2 行），第 2 格位于下半区整宽
  assert.deepEqual(JSON.parse(JSON.stringify(setup.cellStyle(props.sheet.descriptor.cells[1]))), { left: '0%', top: '50%', width: '100%', height: '50%' })
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
    for (const name of names) for (const ready of [true, false]) for (const scope of ['storyboard', 'group']) {
      const submissions = [], errors = []
      const submit = async (type, payload) => submissions.push({ type, payload })
      const model = { key: 'provider/model', configId: 9, model: 'model' }
      const state = { ready, error: '宫格尚未就绪', effective: 'contact_sheet' }
      const h = evaluate(functions, {}, {
        continuityPanel: vue.ref({ confirmGeneration: async () => true }),
        videoContinuityMode: vue.ref('auto'), videoReferenceInputStrategy: vue.ref('contact_sheet'), videoUsesStoryboardFrames: vue.ref(true),
        batchVideoGenerationScope: vue.ref(scope), videoGenerationScope: vue.ref(scope),
        batchVideoReferenceState: vue.ref(state),
        videoGenerationMode: vue.ref('storyboard_frames'), videoModel: vue.ref(model.key),
        videoGenerationOption: vue.ref(model),
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
        assert.equal(submissions[0].payload.videoReferenceInputStrategy, 'contact_sheet'); assert.equal(submissions[0].payload.videoContinuityMode, 'auto')
        assert.deepEqual(Array.from(submissions[0].payload.panelIds), [7])
        if (name !== 'genVid') assert.equal(submissions[0].payload.generationScope, scope)
        else assert.notEqual(submissions[0].payload.generationScope, 'group')
      } else assert.match(errors[0], /宫格尚未就绪/)
    }
  }
})

test('frame editor renders the sheet overview when integrated and keeps card actions standalone', () => {
  const descriptor = parse(read('../app/components/previs/StoryboardFramesEditor.vue')).descriptor
  const script = compileScript(descriptor, { id: 'sheet-overview' })
  const sheetStub = { name: 'sheet-preview' }
  const icons = Object.fromEntries(['Film', 'History', 'ImagePlus', 'Loader2', 'MoreHorizontal', 'SlidersHorizontal', 'Sparkles', 'Star', 'Upload'].map(name => [name, 'svg']))
  const component = evaluate(script.content, {
    vue, 'vue-sonner': { toast: {} }, 'lucide-vue-next': icons, '~/components/AppMenu.vue': { default: { name: 'menu' } }, '~/components/AppMenuItem.vue': { default: { name: 'menu-item' } },
    './FrameSettingsDialog.vue': {}, './StoryboardContactSheet.vue': { default: sheetStub }, '~/composables/useApi': { uploadAPI: {} },
    '~/composables/usePrevis': { ...domain, ...api() },
  }).default
  const target = panel(), base = { panel: target, contactSheet: sheet(target), editable: true, generatable: true, tasks: [] }
  const template = compileTemplate({ source: descriptor.template.content, filename: 'StoryboardFramesEditor.vue', id: 'sheet-overview', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const { render } = evaluate(template.code, { vue: { ...vue, withDirectives: vnode => vnode } })
  function nodes(node) {
    return [node, ...(Array.isArray(node?.children) ? node.children.flatMap(nodes) : [])]
  }
  // 集成模式：分镜画面固定以宫格（联络表）展示，不再有「编辑规划 / 返回宫格」切换
  const integratedProps = { ...base, integrated: true }
  const integrated = component.setup(integratedProps, { expose() {}, emit() {} })
  const overview = nodes(render({}, [], integratedProps, vue.proxyRefs(integrated), {}, {}))
  assert.ok(overview.some(node => node.type === sheetStub))
  assert.equal(overview.filter(node => node.type === 'article').length, 0)
  // 独立模式：保留逐格卡片与全部操作入口
  const standalone = component.setup(base, { expose() {}, emit() {} })
  const editing = nodes(render({}, [], base, vue.proxyRefs(standalone), {}, {}))
  assert.equal(editing.filter(node => node.type === 'article').length, 2)
  assert.ok(editing.some(node => node.props?.class?.includes('frame-settings-action')))
  assert.ok(editing.some(node => node.props?.onClick && node.type === 'button'))
})
