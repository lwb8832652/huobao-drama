import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'

const file = new URL('../app/components/previs/ProductionPlanPanel.vue', import.meta.url)
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
function evaluate(source, dependencies = {}, globals = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(output, {
    module, exports: module.exports, Error, ...globals,
    require: name => { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name] },
  })
  return module.exports
}
const planning = evaluate(read('../../backend/src/services/shot-planning.ts'))
const panel = (id = 7) => ({
  id, title: `分镜 ${id}`, description: '甲：「门外的人已经离开了，我们现在可以走出去看看。」',
  videoPrompt: '', durationMs: 3000, frames: [],
})
const version = () => ({ id: 4, revision: 2, status: 'draft', isCurrent: true, busy: false, timeline: { panels: [panel(), { ...panel(8), description: '人物走向门口。', durationMs: 6000 }] } })
const result = (revision = 2) => ({
  versionId: 4, revision, inputHash: 'reviewed-input', maxSeconds: 15,
  proposals: [{ panelId: 7, title: '分镜 7', beforeDurationMs: 3000, afterDurationMs: 17000, beforeVideoUrl: '/static/old.mp4',
    issues: [], restorations: [{ speaker: '甲', before: '旧台词', after: '完整的原始台词' }], retainedFrames: 2,
    segments: [{ description: '第一段完整描述', durationMs: 10000, plan: { shots: [{}, {}] } }, { description: '第二段完整描述', durationMs: 7000, plan: { shots: [{}] } }], error: null }],
  beforeDurationMs: 3000, afterDurationMs: 17000, extraGenerations: 1,
})
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function harness(extra = {}) {
  assert.ok(existsSync(file), 'The production planning review component must exist')
  const { descriptor, errors } = parse(readFileSync(file, 'utf8'))
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'production-test' })
  const requests = [], events = [], disposers = []
  const props = vue.reactive({ version: version(), panelId: 7, editable: true, busy: false, ...extra.props })
  const component = evaluate(script.content, {
    vue: { ...vue, useId: () => 'production-test', onBeforeUnmount: fn => disposers.push(fn), onUnmounted: fn => disposers.push(fn) },
    'lucide-vue-next': {},
    '../../../../backend/src/services/shot-planning': planning,
    '~/composables/usePrevis': { previsRequest: async (path, method, body) => {
      requests.push({ path, method, body: plain(body) })
      return extra.request ? extra.request(path, method, body) : result(props.version.revision)
    } },
  }, extra.globals).default
  const setup = component.setup(props, { expose() {}, emit: (event, ...args) => events.push({ event, args }) })
  const compiled = compileTemplate({ source: descriptor.template.content, filename: 'ProductionPlanPanel.vue', id: 'production-test', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(compiled.errors, [])
  const { render } = evaluate(compiled.code, { vue: { ...vue, withDirectives: vnode => vnode } })
  const tree = () => render({}, [], props, vue.proxyRefs(setup), {}, {})
  let shows = 0, closes = 0
  setup.dialog.value = { open: false, showModal() { this.open = true; shows++ }, close() { this.open = false; closes++ } }
  return { setup, props, requests, events, disposers, tree, get shows() { return shows }, get closes() { return closes } }
}
function nodes(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, predicate))
  if (!node || typeof node !== 'object') return []
  return [...(predicate(node) ? [node] : []), ...nodes(node.children, predicate)]
}
function textOf(node) {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return node && typeof node === 'object' ? textOf(node.children) : ''
}

test('opens a native review dialog with problem panels selected and meaningful diagnostics', async () => {
  const h = harness()
  assert.ok(h.setup.selectedDiagnostic.value.issues.some(issue => issue.severity === 'fail'))
  assert.ok(h.setup.selectedDiagnostic.value.dialogueChars > 0)
  await h.setup.openDialog()
  assert.equal(h.shows, 1)
  assert.deepEqual(plain(h.setup.selectedIds.value), [7])
  const dialog = nodes(h.tree(), node => node.type === 'dialog')[0]
  assert.ok(dialog.props['aria-labelledby'])
  assert.ok(dialog.props['aria-describedby'])
  assert.match(textOf(h.tree()), /实际音频/)
  assert.match(textOf(h.tree()), /15 秒规划预算/)
})

test('preview waits for pending edits and submits only their returned saved revision', async () => {
  const gate = deferred()
  const h = harness({ props: { beforeAction: async () => { await gate.promise; h.props.version.revision = 3; return { versionId: 4, revision: 3 } } } })
  await h.setup.openDialog()
  const operation = h.setup.requestPreview()
  assert.equal(h.requests.length, 0)
  gate.resolve(); await operation
  assert.deepEqual(h.requests, [{ path: '/animatic-versions/4/production-plan/preview', method: 'POST', body: { revision: 3, panelIds: [7], maxSeconds: 15 } }])
  assert.equal(h.setup.preview.value.revision, 3)
  assert.equal(h.events.length, 0)
  assert.equal(h.props.version.timeline.panels[0].durationMs, 3000)
  assert.match(textOf(h.tree()), /3\.0.*17\.0/s)
  assert.match(textOf(h.tree()), /完整的原始台词/)
  assert.match(textOf(h.tree()), /新增 1 次视频生成/)
  assert.match(textOf(h.tree()), /旧版/)
})

test('selection changes invalidate an existing preview and ignore an older in-flight result', async () => {
  const gate = deferred(), h = harness({ request: () => gate.promise })
  await h.setup.openDialog()
  const operation = h.setup.requestPreview()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.requests.length, 1, 'Wait for the preview request before changing selection')
  h.setup.togglePanel(8, true)
  gate.resolve(result()); await operation
  assert.equal(h.setup.preview.value, null)
  assert.equal(h.setup.canApply.value, false)
  assert.equal(h.events.length, 0)
  h.setup.togglePanel(7, false); h.setup.togglePanel(8, false)
  assert.equal(h.setup.canPreview.value, false)
  await h.setup.requestPreview()
  assert.equal(h.requests.length, 1)
})

test('closing and Escape cancel a preview without changing the workspace or using a late result', async () => {
  const gate = deferred(), h = harness({ request: () => gate.promise }), before = plain(h.props.version)
  await h.setup.openDialog()
  const operation = h.setup.requestPreview()
  await vue.nextTick()
  const dialog = nodes(h.tree(), node => node.type === 'dialog')[0]
  dialog.props.onCancel({ preventDefault() {} })
  gate.resolve(result()); await operation
  assert.equal(h.setup.open.value, false)
  assert.equal(h.setup.preview.value, null)
  assert.deepEqual(plain(h.props.version), before)
  assert.equal(h.events.length, 0)
})

test('apply is a separate explicit request bound to the reviewed hash and emits its new version', async () => {
  const adopted = { ...version(), id: 5, revision: 1 }
  const h = harness({ request: path => path.endsWith('/apply') ? adopted : result() })
  await h.setup.openDialog(); await h.setup.requestPreview()
  assert.equal(h.requests.length, 1)
  assert.equal(h.setup.canApply.value, true)
  await h.setup.applyPreview()
  assert.deepEqual(h.requests[1], { path: '/animatic-versions/4/production-plan/apply', method: 'POST', body: { revision: 2, panelIds: [7], maxSeconds: 15, inputHash: 'reviewed-input' } })
  assert.equal(h.events[0].event, 'applied')
  assert.deepEqual(plain(h.events[0].args[0]), adopted)
  assert.equal(h.setup.open.value, false)
})

test('version, revision, unsaved timeline edits, and external busy state each prevent stale apply', async () => {
  for (const change of [
    h => { h.props.version.id = 9 }, h => { h.props.version.revision++ },
    h => { h.props.version.timeline.panels[0].description += '新修改' }, h => { h.props.busy = true },
    h => { h.props.version.busy = true }, h => { h.props.editable = false },
  ]) {
    const h = harness(); await h.setup.openDialog(); await h.setup.requestPreview()
    change(h); await vue.nextTick(); await h.setup.applyPreview()
    assert.equal(h.requests.length, 1)
    assert.equal(h.events.length, 0)
  }
})

test('failed saves and duplicate clicks cannot submit extra previews', async () => {
  const failed = harness({ props: { beforeAction: async () => false } })
  await failed.setup.openDialog(); await failed.setup.requestPreview()
  assert.equal(failed.requests.length, 0)
  assert.match(failed.setup.error.value, /保存/)
  const h = harness(); await h.setup.openDialog()
  await Promise.all([h.setup.requestPreview(), h.setup.requestPreview()])
  assert.equal(h.requests.length, 1)
})

test('proposal failures remain reviewable and disable apply; request errors release the busy state', async () => {
  const bad = result(); bad.proposals[0].error = '请先在语义边界拆句'
  const h = harness({ request: () => bad }); await h.setup.openDialog(); await h.setup.requestPreview()
  assert.equal(h.setup.canApply.value, false)
  assert.match(textOf(h.tree()), /请先在语义边界拆句/)
  const failure = harness({ request: () => { throw new Error('网络不可用') } })
  await failure.setup.openDialog(); await failure.setup.requestPreview()
  assert.equal(failure.setup.localBusy.value, false)
  assert.match(failure.setup.error.value, /网络不可用/)
})

test('a version switch or unmount drops a late response and apply cannot be cancelled midway', async () => {
  for (const dispose of [false, true]) {
    const gate = deferred(), h = harness({ request: () => gate.promise })
    await h.setup.openDialog(); const operation = h.setup.requestPreview(); await vue.nextTick()
    if (dispose) h.disposers.forEach(fn => fn())
    else h.props.version = { ...version(), id: 9 }
    gate.resolve(result()); await operation
    assert.equal(h.setup.preview.value, null); assert.equal(h.events.length, 0)
  }
  const gate = deferred(), h = harness({ request: path => path.endsWith('/apply') ? gate.promise : result() })
  await h.setup.openDialog(); await h.setup.requestPreview()
  const applying = h.setup.applyPreview(); h.setup.closeDialog()
  assert.equal(h.setup.open.value, true)
  gate.resolve({ ...version(), id: 5 }); await applying
  assert.equal(h.events.length, 1)
})

test('an accepted time plan still shows the retained-frame review requirement', () => {
  const current = version(), target = current.timeline.panels[0]
  target.description = '人物走向门口。'; target.videoPrompt = ''; target.durationMs = 6000; target.framePlanNeedsReview = true
  target.productionPlan = planning.buildProductionPlan(target, { maxSeconds: 15 }).segments[0].plan
  target.description = target.productionPlan.description
  target.videoPrompt = planning.renderProductionPrompt(target.productionPlan)
  const h = harness({ props: { version: current } })
  assert.equal(h.setup.selectedDiagnostic.value.issues.filter(issue => issue.rule !== 'frame_plan_review').length, 0)
  assert.match(textOf(h.tree()), /规划已通过/)
  assert.match(textOf(h.tree()), /画面.*审阅/)
})

test('close returns focus to the initiating control and shortcuts do not reach the episode editor', async () => {
  const focusCalls = []
  const activeElement = { isConnected: true, focus: options => focusCalls.push(options) }
  const h = harness({ globals: { document: { activeElement } } })
  await h.setup.openDialog()
  const key = { key: 's', metaKey: true, stopPropagation() { this.stopped = true }, preventDefault() { this.prevented = true } }
  const dialog = nodes(h.tree(), node => node.type === 'dialog')[0]
  dialog.props.onKeydown(key)
  assert.equal(key.stopped, true); assert.equal(key.prevented, true)
  h.setup.closeDialog(); await vue.nextTick()
  assert.equal(focusCalls.length, 1)
  assert.equal(focusCalls[0].preventScroll, true)
})

test('new local edits during an apply suppress its old response and release the write guard', async () => {
  const gate = deferred(), h = harness({ request: path => path.endsWith('/apply') ? gate.promise : result() })
  await h.setup.openDialog(); await h.setup.requestPreview()
  const operation = h.setup.applyPreview()
  h.props.version.timeline.panels[0].description += '新的本地修改'
  assert.equal(h.setup.localBusy.value, true)
  gate.resolve({ ...version(), id: 5 }); await operation
  assert.equal(h.events.length, 0)
  assert.equal(h.setup.localBusy.value, false)
  assert.equal(h.setup.preview.value, null)
  assert.equal(h.setup.canPreview.value, true)
})

test('successful preview scrolls its review heading into view and moves keyboard focus there', async () => {
  for (const withScroll of [true, false]) {
    const calls = [], h = harness()
    await h.setup.openDialog()
    assert.ok(h.setup.previewSummary, 'The review summary needs a native focus target')
    h.setup.previewSummary.value = {
      focus: options => calls.push({ action: 'focus', options }),
      ...(withScroll ? { scrollIntoView: options => calls.push({ action: 'scroll', options }) } : {}),
    }
    await h.setup.requestPreview()
    const heading = nodes(h.tree(), node => node.type === 'h3')[0]
    assert.equal(heading.props.tabindex, '-1')
    assert.equal(calls.filter(call => call.action === 'scroll').length, withScroll ? 1 : 0)
    assert.equal(calls.at(-1).action, 'focus')
    assert.equal(calls.at(-1).options.preventScroll, true)
    assert.equal(h.setup.error.value, '')
  }
})

test('polling the exact applied version before its response still refreshes the episode, while unrelated switches stay ignored', async () => {
  for (const sameAppliedVersion of [true, false]) {
    const adopted = { ...version(), id: 5, revision: 1 }
    const gate = deferred(), h = harness({ request: path => path.endsWith('/apply') ? gate.promise : result() })
    await h.setup.openDialog(); await h.setup.requestPreview()
    const operation = h.setup.applyPreview()
    h.props.version = sameAppliedVersion ? structuredClone(adopted) : { ...version(), id: 9 }
    gate.resolve(adopted); await operation
    assert.equal(h.events.length, sameAppliedVersion ? 1 : 0)
    if (sameAppliedVersion) assert.equal(h.events[0].event, 'applied')
  }
})

function episodeAdapter(globals) {
  const source = parse(read('../app/views/drama/episode.vue')).descriptor.scriptSetup.content
  const ast = ts.createSourceFile('episode-adapter.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['productionPanelById', 'productionReferenceState', 'videoCanGenerate', 'beforeProductionGridAction', 'acceptProductionPlan', 'selectProductionPanel']
  const functions = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text))
    .map(statement => `export ${statement.getText(ast)}`).join('\n')
  assert.equal(functions.match(/export /g)?.length, names.length, 'Exercise the actual episode adapter functions')
  return evaluate(functions, {}, { productionBlockingMessage: planning.productionBlockingMessage, ...globals })
}

test('episode readiness combines real production diagnostics with reference readiness without hiding input errors', () => {
  const target = { ...panel(), description: '人物走向门口。', durationMs: 6000, videoPrompt: '', frames: [] }
  const timeline = vue.ref({ panels: [target] })
  const referenceInputs = []
  let state = { ready: true, actual: 'reference', effective: 'individual', error: '' }
  const api = episodeAdapter({
    productionTimeline: timeline, productionVersion: vue.ref({ contactSheets: [] }),
    videoContinuityMode: vue.ref('auto'), videoContinuityCapability: vue.ref({ reference: true }),
    videoReferenceInputStrategy: vue.ref('individual'), videoCapabilities: vue.ref({}), selectedVideoConfig: vue.ref({ provider: 'test' }),
    videoContinuityReadiness: (...args) => { referenceInputs.push(args); return state },
  })
  assert.equal(api.videoCanGenerate(target.id), true)
  assert.equal(referenceInputs[0][0][0].id, target.id)
  state = { ...state, ready: false, error: '参考图片尚未生成' }
  assert.equal(api.productionReferenceState(target.id).error, '参考图片尚未生成')
  state = { ...state, ready: true, error: '' }
  timeline.value.panels[0].description = panel().description
  assert.equal(api.videoCanGenerate(target.id), false)
  assert.match(api.productionReferenceState(target.id).error, /完整对白|保留.*对白/)
  timeline.value.panels[0].description = '人物走向门口。'
  timeline.value.panels[0].framePlanNeedsReview = true
  assert.equal(api.videoCanGenerate(target.id), false)
  assert.match(api.productionReferenceState(target.id).error, /重新规划.*审阅画面/)
})

test('episode adapter returns the saved identity, opens the applied version before refresh, and selects newly split panels', async () => {
  const saved = vue.ref(version()), sbs = vue.ref([{ id: 7 }]), selectedSb = vue.ref(sbs.value[0]), calls = []
  const gate = deferred()
  let saves = true
  const api = episodeAdapter({
    productionVersion: saved, sbs, selectedSb,
    saveProduction: async () => { if (saves) saved.value.revision = 3; return saves },
    openProduction: async id => { calls.push(`open:${id}`); await gate.promise; saved.value = { ...version(), id, revision: 1 } },
    refresh: async () => { calls.push('refresh'); sbs.value = [{ id: 7 }, { id: 12 }] },
    toast: { success: message => calls.push(message) }, toastError: error => calls.push(error.message),
  })
  assert.deepEqual(plain(await api.beforeProductionGridAction()), { versionId: 4, revision: 3 })
  saves = false; assert.equal(await api.beforeProductionGridAction(), false)
  const accepting = api.acceptProductionPlan({ ...version(), id: 5, revision: 1 })
  assert.deepEqual(calls, ['open:5'])
  gate.resolve(); await accepting
  assert.equal(saved.value.id, 5)
  assert.equal(calls[1], 'refresh')
  assert.match(calls[2], /新工作版.*画面/)
  api.selectProductionPanel(12); assert.equal(selectedSb.value.id, 12)
  api.selectProductionPanel(999); assert.equal(selectedSb.value.id, 12)
})

test('episode adapter preserves workspace on open failure and reports the failure', async () => {
  const calls = [], api = episodeAdapter({
    openProduction: async () => { throw new Error('新版本加载失败') },
    refresh: async () => calls.push('refresh'), toast: { success: message => calls.push(message) },
    toastError: error => calls.push(error.message),
  })
  await api.acceptProductionPlan({ id: 5 })
  assert.deepEqual(calls, ['新版本加载失败'])
})

test('episode adapter reports an aborted version open instead of refreshing and showing success', async () => {
  const calls = [], api = episodeAdapter({
    productionVersion: vue.ref(version()),
    openProduction: async () => false,
    refresh: async () => calls.push('refresh'), toast: { success: message => calls.push(message) },
    toastError: error => calls.push(error.message),
  })
  await api.acceptProductionPlan({ id: 5 })
  assert.equal(calls.length, 1)
  assert.match(calls[0], /保存|切换|加载/)
})

test('conflicting local edits during beforeAction invalidate preview before any request is submitted', async () => {
  const gate = deferred(), h = harness({ props: { beforeAction: async () => { await gate.promise; return { versionId: 4, revision: 2 } } } })
  await h.setup.openDialog()
  const operation = h.setup.requestPreview()
  h.props.version.timeline.panels[0].description += '保存期间的新修改'
  gate.resolve(); await operation
  assert.equal(h.requests.length, 0)
  assert.equal(h.setup.preview.value, null)
  assert.equal(h.setup.localBusy.value, false)
})
