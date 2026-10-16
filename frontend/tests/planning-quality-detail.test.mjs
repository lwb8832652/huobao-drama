import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as vue from 'vue'
const file = new URL('../app/components/previs/PlanningQualityDetail.vue', import.meta.url)
function evaluate(source, deps) {
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module, exports: module.exports, require: name => { assert.ok(name in deps, name); return deps[name] } })
  return module.exports
}
function mount(item, reason = '') {
  assert.ok(existsSync(file), 'Planning reports need a reviewable detail view')
  const d = parse(readFileSync(file, 'utf8')).descriptor, script = compileScript(d, { id: 'quality-detail' }), events = []
  const props = vue.reactive({ item, busy: false, optimizeDisabledReason: reason, applyDisabledReason: reason, version: null })
  const component = evaluate(script.content, {
    vue, '../QueueJobActions.vue': {}, './ProductionPlanPanel.vue': {},
    '~/composables/useTaskQueue': { queueStatusLabel: item => item.status },
    '~/composables/useProductionQuality': { qualityReport: item => item.kind !== 'optimization' ? item.result : null, qualityCandidate: item => item.kind === 'optimization' ? item.result : null },
  }).default
  const scope = vue.effectScope(), s = scope.run(() => component.setup(props, { expose() {}, emit: (name, ...args) => events.push({ name, args }) }))
  const compiled = compileTemplate({ source: d.template.content, filename: 'PlanningQualityDetail.vue', id: 'quality-detail', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(compiled.errors, [])
  const { render } = evaluate(compiled.code, { vue: { ...vue, withDirectives: vnode => vnode, renderSlot: () => null } })
  const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.children) : ''
  return { s, props, events, text: () => text(render({}, [], props, vue.proxyRefs(s), {}, {})), stop: () => scope.stop() }
}
test('report lets reviewers select individual issues and locate affected panels without changing the timeline', () => {
  const h = mount({ id: 1, type: 'planning', kind: 'rules', current: true, round: 0, status: 'completed', result: { overallScore: null, confidence: 'high', summary: '检查对白', dimensions: { dialogue: { score: 70, comment: '保留台词' } }, issues: [{ id: 'a', panelIds: [7], message: '遗漏对白', suggestion: '恢复原文', evidence: '原台词' }] } })
  h.s.toggleIssue('a', true); h.s.requestOptimize()
  assert.deepEqual(JSON.parse(JSON.stringify(h.events)), [{ name: 'optimize', args: [['a']] }])
  assert.match(h.text(), /对白完整性/); assert.match(h.text(), /遗漏对白/); assert.match(h.text(), /原台词/)
  h.props.version = { timeline: { groups: [{ panelIds: [8, 7] }], panels: [{ id: 7 }, { id: 8 }] } }
  assert.match(h.text(), /定位分镜 2/)
  h.props.optimizeDisabledReason = '评测已过期'; h.s.requestOptimize(); assert.equal(h.events.length, 1); h.stop()
})
test('candidate shows text, time, split cost and preserved media; its explicit apply button is sufficient', () => {
  const h = mount({ id: 2, type: 'planning', kind: 'optimization', current: true, round: 1, status: 'completed', result: { summary: '补充动作', edits: [{ panelId: 7, description: '新候选描述' }], preview: { beforeDurationMs: 3000, afterDurationMs: 17000, extraGenerations: 1, proposals: [{ panelId: 7, title: '分镜7', beforeDurationMs: 3000, afterDurationMs: 17000, beforeVideoUrl: '/old.mp4', retainedFrames: 2, segments: [{ description: '第一段', durationMs: 10000 }, { description: '第二段', durationMs: 7000 }] }] } } })
  const text = h.text(); for (const pattern of [/新候选描述/, /所选分镜时长/, /3\.0.*17\.0/s, /新增 1 次视频生成/, /第一段/, /旧版.*保留/s]) assert.match(text, pattern)
  h.s.requestApply(); assert.deepEqual(h.events, [{ name: 'apply', args: [true] }])
  h.props.applyDisabledReason = '候选已过期'; h.s.requestApply(); assert.equal(h.events.length, 1); h.stop()
})
test('previsual page adopts the returned version and locates issue panels in their actual group', async () => {
  const source = parse(readFileSync(new URL('../app/views/drama/previs.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
  const ast = ts.createSourceFile('previs.ts', source, ts.ScriptTarget.Latest, true)
  const names = ['acceptQualityVersion', 'selectQualityPanel']
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => `export ${node.getText(ast)}`).join('\n')
  assert.equal(functions.match(/export /g)?.length, 2, 'Both page adapters must exist')
  const calls = [], version = vue.ref({ id: 4 })
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(functions, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, version, open: async id => { version.value.id = id; calls.push(id) }, groups: vue.ref([{ id: 'second', panelIds: [7, 8] }]), select: (...args) => calls.push(args), toast: { success() {} },
  })
  assert.equal(await module.exports.acceptQualityVersion({ id: 6 }), true)
  module.exports.selectQualityPanel(8)
  assert.deepEqual(calls, [6, ['second', 8]])
})
