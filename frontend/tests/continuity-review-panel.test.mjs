import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
const intervals = []
function evaluate(source, deps = {}) {
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: n => { assert.ok(n in deps, n); return deps[n] }, setInterval: fn => { intervals.push(fn); return intervals.length }, clearInterval() {}, Set, Number })
  return module.exports
}
const domain = evaluate(read('../app/composables/useContinuityReview.ts'))
const timeline = { groups: [{ id: 'a', title: 'A', panelIds: [1, 2] }, { id: 'b', title: 'B', panelIds: [3, 4] }, { id: 'c', title: 'C', panelIds: [5] }], transitions: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }
const result = (score = 90, confidence = 'high') => ({ overallScore: score, confidence, summary: '模拟', dimensions: {}, issues: [], suggestions: [] })
const snapshot = (status = 'completed', score = 90, confidence = 'high') => ({ settings: { enabled: false, threshold: 70 }, items: [{ id: 1, fromGroupId: 'a', toGroupId: 'b', inputHash: 'new', status, result: status === 'completed' ? result(score, confidence) : null, error: status === 'failed' ? '模拟错误' : null, lowScore: score < 70 }] })
test('目标边界仅包含实际首尾画面相关连接，不扩大到整组', () => {
  assert.equal(domain.relevantContinuityEdges(timeline, [1]).length, 0)
  assert.equal(domain.relevantContinuityEdges(timeline, [2]).length, 1)
  assert.equal(domain.relevantContinuityEdges(timeline, [3]).length, 1)
  assert.equal(domain.relevantContinuityEdges(timeline, [4]).length, 1)
  assert.equal(domain.relevantContinuityEdges(timeline, [2, 3, 4]).length, 2)
})
test('六类风险和阈值边界完整，低分和低置信合并一条', () => {
  for (const state of ['idle', 'missing_images', 'pending', 'processing', 'failed']) assert.equal(domain.continuityRisks(timeline, snapshot(state), [2]).length, 1)
  assert.equal(domain.continuityRisks(timeline, snapshot('completed', 70), [2]).length, 0)
  assert.equal(domain.continuityRisks(timeline, snapshot('completed', 69, 'low'), [2])[0].reasons.length, 2)
  assert.equal(domain.continuityRisks(timeline, { settings: { threshold: 70 }, items: [] }, [2]).length, 1)
})
const descriptor = parse(read('../app/components/previs/ContinuityReviewPanel.vue')).descriptor
const script = compileScript(descriptor, { id: 'review' })
const flush = async () => { for (let i = 0; i < 6; i++) await vue.nextTick() }
function mount({ current = snapshot('idle'), saveOK = true, unavailable = false } = {}) {
  const calls = [], unmounts = []
  let exposed
  const component = evaluate(script.content, {
    vue: { ...vue, onUnmounted: fn => unmounts.push(fn) },
    '~/composables/usePrevis': { previsRequest: async (path, method = 'GET', body) => {
      calls.push({ path, method, body })
      if (path.endsWith('continuity-review-settings')) return body || { enabled: false, threshold: 70 }
      if (unavailable) throw Error('模拟离线')
      if (path.includes('continuity-review-tasks')) return { type: 'continuity', page: 1, pageSize: 20, total: 1, activeCount: 2, lowScore: 0, items: [{ id: 12, type: 'continuity', status: 'processing', current: false, images: { from: null, to: null } }] }
      return current
    } },
    '~/composables/useContinuityReview': domain,
  }).default
  const props = vue.reactive({ version: { id: 9, revision: 1 }, timeline, panelIds: [2], textModel: { configId: 1, model: 'mock' }, dirty: false,
    save: async () => { calls.push({ path: 'save' }); return saveOK } })
  const scope = vue.effectScope()
  const s = scope.run(() => component.setup(props, { expose: value => { exposed = value } }))
  s.dialog.value = { open: false, showModal() { this.open = true; calls.push({ path: 'dialog' }) }, close() { this.open = false } }
  return { s, props, calls, exposed, unmount() { unmounts.forEach(fn => fn()); scope.stop() } }
}
test('顶栏评测默认关闭、保留活跃角标，生成确认不打开抽屉', async () => {
  const m = mount(); await flush()
  assert.equal(m.s.expanded.value, false)
  const pending = m.exposed.confirmGeneration([2]); await flush(); await flush()
  assert.equal(m.s.dialog.value.open, true)
  assert.equal(m.s.expanded.value, false)
  m.s.finish(false); assert.equal(await pending, false); m.unmount()
  assert.equal(m.s.history.value.activeCount, 2)
  assert.match(descriptor.template.content, /:aria-expanded="expanded"/)
  assert.match(descriptor.template.content, /history.activeCount/)
  assert.match(descriptor.styles[0].content, /\.evaluation-overlay\s*\{[^}]*position: fixed;/)
  const episode = read('../app/views/drama/episode.vue')
  assert.ok(episode.indexOf('<ContinuityReviewPanel ref="continuityPanel"') < episode.indexOf('studio-body'))
  assert.match(episode, /\.prod-content\s*\{[^}]*min-height: 0;/)
  assert.match(episode, /\.video-task-workbench\s*\{[^}]*min-height: 0;[^}]*grid-template-rows: minmax\(0, 1fr\);[^}]*overflow: hidden;/)
})
test('抽屉关闭仍GET历史与活跃数，切页携带分页参数、版本变化清除旧详情', async () => {
  const m = mount(); await flush(); m.calls.length = 0
  assert.equal(m.s.expanded.value, false)
  await intervals.at(-1)(); await flush()
  assert.equal(m.s.history.value.activeCount, 2)
  assert.ok(m.calls.some(c => c.path.includes('continuity-review-tasks?page=1&pageSize=20')))
  assert.ok(m.calls.every(c => c.method === 'GET'))
  m.s.selectTask(m.s.history.value.items[0]); assert.equal(m.s.selected.value.id, 12)
  m.s.page.value = 2; await flush()
  assert.ok(m.calls.some(c => c.path.includes('page=2&pageSize=20')))
  assert.equal(m.s.selectedId.value, null)
  m.s.selectedId.value = 12; m.props.version = { id: 10, revision: 1 }; await flush()
  assert.equal(m.s.page.value, 1); assert.equal(m.s.selectedId.value, null)
  m.unmount()
})
test('历史明细包含图片、四维分数、建议及过期状态', () => {
  for (const token of ['item.images[side]', 'item.result.dimensions', 'item.result.suggestions', '!item.current', '无历史画面', '尚无评分结果']) assert.ok(descriptor.template.content.includes(token), token)
})
test('设置默认不付费，保存阈值及开关仅PUT；轮询/加载不POST', async () => {
  const m = mount(); await flush()
  assert.equal(m.s.settings.value.enabled, false); assert.equal(m.s.threshold.value, 70)
  assert.ok(m.calls.every(c => c.method !== 'POST'))
  m.s.enabled.value = true; m.s.threshold.value = 80; await m.s.saveSettings()
  const put = m.calls.find(c => c.method === 'PUT'); assert.equal(put.body.threshold, 80); assert.equal(put.body.enabled, true)
  m.s.threshold.value = 101; await m.s.saveSettings(); assert.equal(m.calls.filter(c => c.method === 'PUT').length, 1)
  m.unmount()
})
test('先保存再GET新风险，取消为false、明确继续为true，重入不重复确认', async () => {
  const m = mount(); await flush(); m.calls.length = 0
  const cancelled = m.exposed.confirmGeneration([2]); await flush()
  assert.equal(m.calls[0].path, 'save'); assert.match(m.calls[1].path, /continuity-review-status$/)
  assert.equal(await m.exposed.confirmGeneration([2]), false)
  m.s.finish(false); assert.equal(await cancelled, false)
  const accepted = m.exposed.confirmGeneration([2]); await flush(); m.s.finish(true); assert.equal(await accepted, true)
  assert.ok(m.calls.every(c => c.method !== 'POST')); m.unmount()
})
test('安全结果不弹窗、保存失败不查询，接口失败允许明确确认', async () => {
  const safe = mount({ current: snapshot() }); await flush()
  assert.equal(await safe.exposed.confirmGeneration([2]), true); assert.ok(!safe.calls.some(c => c.path === 'dialog')); safe.unmount()
  const failed = mount({ saveOK: false }); await flush(); failed.calls.length = 0
  assert.equal(await failed.exposed.confirmGeneration([2]), false); assert.equal(failed.calls.length, 1); failed.unmount()
  const offline = mount({ unavailable: true }); await flush(); const promise = offline.exposed.confirmGeneration([2]); await flush()
  assert.equal(offline.s.riskRows.value[0].key, 'unavailable'); offline.s.finish(true); assert.equal(await promise, true); offline.unmount()
})
test('卸载释放未完成Promise，内容/版本变化不能使用旧确认', async () => {
  const m = mount(); await flush(); const pending = m.exposed.confirmGeneration([2]); await flush(); m.unmount(); assert.equal(await pending, false)
  const changed = mount(); await flush(); const answer = changed.exposed.confirmGeneration([2]); await flush(); changed.props.dirty = true; changed.s.finish(true); assert.equal(await answer, false); changed.unmount()
})
test('延迟close事件不取消下一轮，原生关闭和卸载均释放确认', async () => {
  const m = mount(); await flush()
  const first = m.exposed.confirmGeneration([2]); await flush(); m.s.finish(true); assert.equal(await first, true)
  let settled = false
  const second = m.exposed.confirmGeneration([2]).then(ok => { settled = true; return ok }); await flush()
  m.s.onDialogClose(); await flush(); assert.equal(settled, false)
  m.s.dialog.value.open = false; m.s.onDialogClose(); assert.equal(await second, false)
  const third = m.exposed.confirmGeneration([2]); await flush(); m.unmount(); assert.equal(await third, false)
})
test('预演与视频页顶栏共用评测入口且确认常驻，Agent接入实际registry类型', () => {
  const previs = read('../app/views/drama/previs.vue')
  assert.ok(previs.indexOf('<ContinuityReviewPanel ref="continuityPanel"') < previs.indexOf('studio-body'))
  assert.match(read('../app/pages/settings.vue'), /type: 'continuity-reviewer', label: '连续性评测'/)
  assert.match(descriptor.template.content, /<Teleport to="body"><dialog/)
})
test('手动POST保持旧契约并先保存，模板可编译', async () => {
  const m = mount(); await flush(); m.calls.length = 0; await m.s.score('b')
  assert.equal(m.calls[0].path, 'save')
  const post = m.calls.find(c => c.method === 'POST'); assert.match(post.path, /continuity-reviews$/); assert.equal(post.body.toGroupId, 'b'); assert.equal(post.body.model, 'mock'); m.unmount()
  const compiled = compileTemplate({ source: descriptor.template.content, filename: 'ContinuityReviewPanel.vue', id: 'review', compilerOptions: { bindingMetadata: script.bindings } }); assert.deepEqual(compiled.errors, [])
})
test('三个真实生成函数取消不调用生成、允许后只提交一次（全模拟）', async () => {
  for (const [file, name] of [['episode.vue', 'genVid'], ['episode.vue', 'confirmBatchVideos'], ['previs.vue', 'startVideo']]) {
    const source = read(`../app/views/drama/${file}`)
    const start = source.indexOf(`async function ${name}(`), end = source.indexOf('\n}', start) + 2
    for (const allowed of [false, true]) {
      const calls = []
      const ref = value => ({ value })
      const context = {
        module: { exports: {} },
        modelChoice: () => ({ configId: 1, model: 'mock' }), toast: { error() {}, success() {} }, toastError() {}, t: x => x,
        videoGenerationOption: ref({ configId: 1, model: 'mock' }), productionVersion: ref({ id: 1 }), productionPanelById: () => ({}), videoCanGenerate: () => true,
        productionReferenceState: () => ({ ready: true }), batchVideoReferenceState: ref({ ready: true }), videoReferenceState: ref({ ready: true }),
        batchVideoConfirm: ref({ targets: [{ id: 2 }] }), incompleteVideoPanels: ref([]), videoPanelIds: ref([2]), videoSelectMode: ref(false),
        videoGenerationMode: ref('auto'), videoGenerationScope: ref('storyboard'), batchVideoGenerationScope: ref('storyboard'),
        videoReferenceInputStrategy: ref('auto'), videoContinuityMode: ref('auto'), failedVideoMessages: ref({}), modal: ref('video'), inspector: ref('frames'),
        continuityPanel: ref({ confirmGeneration: async ids => { calls.push({ type: 'confirm', ids }); return allowed } }),
        generate: async () => calls.push({ type: 'generate' }), generateProduction: async () => calls.push({ type: 'generate' }),
      }
      runInNewContext(`${source.slice(start, end)}; module.exports = ${name}`, context)
      await context.module.exports({ id: 2 })
      assert.equal(calls.filter(c => c.type === 'confirm').length, 1, name)
      assert.equal(calls.filter(c => c.type === 'generate').length, allowed ? 1 : 0, name)
    }
  }
})
test('三个视频入口均在生成前等待共享确认，两个页面模板可编译', () => {
  for (const [file, functions] of [['episode.vue', ['confirmBatchVideos', 'genVid']], ['previs.vue', ['startVideo']]]) {
    const source = read(`../app/views/drama/${file}`)
    for (const name of functions) {
      const start = source.indexOf(`async function ${name}(`), end = source.indexOf('\n}', start)
      const body = source.slice(start, end)
      assert.match(body, /if \(!await continuityPanel.value\?\.confirmGeneration\(/)
      assert.ok(body.indexOf('confirmGeneration(') < body.indexOf("('video',"))
    }
    const d = parse(source).descriptor
    assert.deepEqual(compileTemplate({ source: d.template.content, filename: file, id: file }).errors, [])
  }
})
