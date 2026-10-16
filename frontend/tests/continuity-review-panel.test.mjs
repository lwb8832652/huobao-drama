import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { parse as parseDOM } from '@vue/compiler-dom'
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
const intervals = []
function evaluate(source, deps = {}) {
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, require: n => { assert.ok(n in deps, n); return deps[n] }, setInterval: fn => { intervals.push(fn); return intervals.length }, clearInterval() {}, setTimeout, clearTimeout, Set, Number })
  return module.exports
}
const queue = evaluate(read('../app/composables/useTaskQueue.ts'))
const domain = evaluate(read('../app/composables/useContinuityReview.ts'), { './useTaskQueue': queue })
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
test('任务状态文案对用户可读：执行中的各阶段统一显示为进行中', () => {
  // submitting=提交服务商、upstream=已提交、polling=轮询，均为内部术语；
  // 评测与制作列表共用 queueStatusLabel，用户视角只应看到「进行中」。
  for (const phase of ['submitting', 'upstream', 'polling']) {
    assert.equal(queue.queueStatusLabel({ status: 'processing', phase }), '进行中', phase)
  }
  assert.equal(queue.queueStatusLabel({ status: 'processing' }), '进行中', '无 phase 的 processing')
  assert.equal(queue.queueStatusLabel({ status: 'pending' }), '排队中')
  assert.equal(queue.queueStatusLabel({ status: 'pending', phase: 'waiting_dependency' }), '等待前置任务')
  assert.equal(queue.queueStatusLabel({ status: 'completed' }), '已完成')
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
function mount({ current = snapshot('idle'), saveOK = true, unavailable = false, historyResponse, detailResponse, postResult, settingsResponse, settingsFailure, qualityResponse } = {}) {
  const calls = [], unmounts = []
  let exposed
  const request = async (path, method = 'GET', body) => {
      calls.push({ path, method, body })
      if (path === '/settings/evaluation-tasks' || path.endsWith('continuity-review-settings')) {
        if (method === 'PUT' && settingsFailure) throw settingsFailure
        return body ? { ...body, globalTotal: 6, stats: {} } : (typeof settingsResponse === 'function' ? settingsResponse() : settingsResponse) || { revision: 1, concurrency: 1, paused: false, enabled: false, threshold: 70, globalTotal: 6, stats: {} }
      }
      if (unavailable) throw Error('模拟离线')
      if (path.endsWith('/production-quality')) return qualityResponse || { inputHash: 'quality-hash', rules: { issues: [] }, task: null, latest: null }
      if (method === 'POST' && postResult) return postResult
      if (/production-quality\/tasks\/\d+$/.test(path)) return detailResponse
      if (/continuity-review-tasks\/\d+$/.test(path)) return detailResponse || { id: 12, type: 'continuity', status: 'processing', current: false, images: { from: null, to: null } }
      if (path.includes('evaluation-tasks?')) return (typeof historyResponse === 'function' ? historyResponse(path) : historyResponse) || { type: 'all', page: 1, pageSize: 20, total: 1, activeCount: 2, lowScore: 0, items: [{ id: 12, type: 'continuity', status: 'processing', current: false, images: { from: null, to: null } }] }
      return current
    }
  const vueDeps = { ...vue, onUnmounted: fn => unmounts.push(fn) }
  const quality = evaluate(read('../app/composables/useProductionQuality.ts'), { vue: vueDeps, './usePrevis': { previsRequest: request } })
  const component = evaluate(script.content, {
    vue: vueDeps,
    '~/composables/usePrevis': { previsRequest: request },
    '~/composables/useContinuityReview': domain,
    '../QueueSettingsButton.vue': { default: {} },
    './EvaluationTaskList.vue': { default: {} },
    './ContinuityReviewDetail.vue': { default: {} },
    './PlanningQualityDetail.vue': { default: {} },
    './ProductionPlanPanel.vue': { default: {} },
    '~/composables/useProductionQuality': quality,
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
  assert.ok(m.calls.some(c => c.path.includes('evaluation-tasks?page=1&pageSize=20')))
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
  const detail = parse(read('../app/components/previs/ContinuityReviewDetail.vue')).descriptor
  for (const token of ['item.images[side]', 'item.result.dimensions', 'item.result.suggestions', '!item.current', '无历史画面', '尚无评分结果']) assert.ok(detail.template.content.includes(token), token)
})
test('评测默认只显示任务列表，点击才打开详情，返回不改变分页或再请求', async () => {
  const m = mount({ historyResponse: { type: 'continuity', page: 2, pageSize: 20, total: 41, activeCount: 0, lowScore: 0, items: [{ id: 12, type: 'continuity', status: 'completed', images: { from: null, to: null } }] } }); await flush()
  assert.equal(m.s.view.value, 'tasks'); assert.equal(m.s.selectedId.value, null)
  m.s.page.value = 2; await flush()
  m.s.selectTask(m.s.history.value.items[0]); assert.equal(m.s.view.value, 'detail')
  m.s.selectTask(m.s.history.value.items[0]); assert.equal(m.s.view.value, 'detail')
  const calls = m.calls.length; m.s.backToTasks(); await flush()
  assert.equal(m.s.view.value, 'tasks'); assert.equal(m.s.page.value, 2); assert.equal(m.calls.length, calls)
  m.unmount()
})
test('服务端筛选和检索均回到第一页，重新查询保留有效选中详情', async () => {
  const m = mount(); await flush()
  m.s.selectTask(m.s.history.value.items[0]); await m.s.loadHistory()
  assert.equal(m.s.selected.value.id, 12); assert.equal(m.s.view.value, 'detail')
  m.s.page.value = 3; await flush(); m.s.changeFilter('failed'); await flush()
  assert.equal(m.s.page.value, 1); assert.equal(m.s.selectedId.value, null)
  assert.ok(m.calls.some(c => c.path.includes('status=failed')))
  m.s.keyword.value = '旧镜头'; await flush(); await m.s.loadHistory()
  assert.ok(m.calls.some(c => c.path.includes('keyword=%E6%97%A7%E9%95%9C%E5%A4%B4')))
  m.unmount()
})
test('进行中和缺图边界禁止手动POST；设置草稿不会被状态刷新覆盖', async () => {
  for (const state of ['pending', 'processing', 'missing_images']) {
    const m = mount({ current: snapshot(state) }); await flush(); m.calls.length = 0
    await m.s.score('b'); assert.equal(m.calls.length, 0, state); m.unmount()
  }
  const m = mount(); await flush(); m.s.enabled.value = true; m.s.threshold.value = 82
  await m.s.refresh(); assert.equal(m.s.enabled.value, true); assert.equal(m.s.threshold.value, 82)
  m.unmount()
})
test('缺图的已完成或失败旧记录禁止创建和详情重试，不产生模型POST', async () => {
  for (const state of ['completed', 'failed']) {
    const current = snapshot(state); current.items[0].hasImages = false
    const chosen = { id: 12, type: 'continuity', status: state, current: true, toGroupId: 'b', images: { from: null, to: null } }
    const m = mount({ current, detailResponse: chosen }); await flush(); m.s.selectTask(chosen)
    assert.match(m.s.disabledReason('b'), /两侧.*画面/)
    assert.match(m.s.retryDisabledReason.value, /两侧.*画面/)
    m.s.view.value = 'create'; await m.s.score('b'); m.s.view.value = 'detail'; await m.s.retrySelected()
    assert.equal(m.calls.filter(call => call.method === 'POST').length, 0)
    m.unmount()
  }
})
test('通用任务行适配器区分完成与需关注，并保持历史图片与低置信状态', () => {
  const base = { id: 1, type: 'continuity', fromGroupTitle: '旧镜头', toGroupTitle: '后镜头', status: 'completed', current: false, model: 'mock', createdAt: '2026-10-14T02:00:00Z', images: { from: '/old.png', to: '/next.png' } }
  const row = domain.evaluationTaskRow({ ...base, result: result(85, 'low') }, 70)
  assert.equal(row.status, 'completed'); assert.equal(row.attention, true); assert.equal(row.current, false)
  assert.equal(row.preview, '/old.png'); assert.match(row.title, /旧镜头/); assert.equal(row.typeLabel, '连续性')
  assert.equal(domain.evaluationTaskRow({ ...base, result: result(70) }, 70).attention, false)
})
test('规划与连续性同号任务使用类型加ID，规则检查不伪造评分', () => {
  const planning = domain.evaluationTaskRow({ id: 12, type: 'planning', kind: 'rules', status: 'completed', current: true, result: { overallScore: null, confidence: 'high', summary: '2 项待处理', issues: [{ id: 'a' }] } }, 70)
  const continuity = domain.evaluationTaskRow({ id: 12, type: 'continuity', images: {}, status: 'completed' }, 70)
  assert.equal(planning.key, 'planning:12'); assert.equal(continuity.key, 'continuity:12')
  assert.equal(planning.score, undefined); assert.equal(planning.attention, true)
  assert.equal(planning.typeLabel, '分镜规划质量')
})
test('统一类型筛选与规划详情路由区分同号任务，打开规划入口不触发模型', async () => {
  const planning = { id: 12, type: 'planning', versionId: 9, kind: 'review', round: 0, status: 'completed', current: true, inputHash: 'quality-hash', result: { overallScore: 80, confidence: 'high', issues: [], summary: '通过' } }
  const m = mount({ historyResponse: { type: 'all', page: 1, pageSize: 20, total: 2, activeCount: 0, lowScore: 0, items: [{ id: 12, type: 'continuity', images: {}, status: 'completed' }, planning] }, detailResponse: planning,
    qualityResponse: { inputHash: 'quality-hash', rules: planning.result, task: planning, latest: planning } }); await flush()
  m.s.selectRow('planning:12'); assert.equal(m.s.selected.value.type, 'planning')
  m.s.expanded.value = true; await flush(); m.s.selectRow('planning:12'); await flush()
  assert.ok(m.calls.some(call => call.path.endsWith('/production-quality/tasks/12')))
  m.s.changeTypeFilter('planning'); await flush()
  assert.ok(m.calls.some(call => call.path.includes('type=planning')))
  await m.exposed.openPlanning(); await flush()
  assert.equal(m.s.view.value, 'detail'); assert.equal(m.s.selected.value.type, 'planning')
  assert.ok(m.calls.every(call => !call.method || call.method === 'GET')); m.unmount()
})
test('重新发起规划评测默认回到免费规则检查', async () => {
  const m = mount(); await flush()
  m.s.planningMode.value = 'ai'
  m.s.openCreate()
  assert.equal(m.s.planningMode.value, 'rules')
  m.unmount()
})
test('规则修复控制器常驻抽屉入口，版本轮询切走详情时仍能接收应用响应', () => {
  const template = parseDOM(descriptor.template.content)
  const section = template.children.find(node => node.type === 1 && node.tag === 'section')
  const repair = section.children.find(node => node.type === 1 && node.tag === 'ProductionPlanPanel')
  assert.ok(repair, 'The rule repair controller must be a persistent direct child, outside conditional Teleport/task detail content')
  assert.equal(repair.props.some(prop => prop.type === 7 && ['if', 'else-if'].includes(prop.name)), false)
  assert.ok(repair.props.some(prop => prop.type === 6 && prop.name === 'headless'))
})
test('新任务把选中记录挤出列表页时，单独查询详情并保持原有详情视图', async () => {
  let newer = false
  const chosen = { id: 12, type: 'continuity', status: 'completed', current: false, result: result(62), images: { from: '/frozen.png', to: '/next.png' } }
  const m = mount({ historyResponse: () => ({ type: 'continuity', page: 1, pageSize: 20, total: 24, activeCount: 0, lowScore: 0, items: newer ? [{ ...chosen, id: 99 }] : [chosen] }), detailResponse: chosen })
  await flush(); m.s.selectTask(m.s.history.value.items[0]); newer = true
  await m.s.loadHistory(); await flush()
  assert.equal(m.s.view.value, 'detail'); assert.equal(m.s.selected.value.id, 12)
  assert.equal(m.s.selected.value.images.from, '/frozen.png'); assert.ok(m.calls.some(c => c.path.endsWith('continuity-review-tasks/12')))
  m.unmount()
})
test('详情重试先保存同一版本的新修订后仍保留列表上下文并使用最新修订', async () => {
  const chosen = { id: 12, type: 'continuity', status: 'completed', current: true, toGroupId: 'b', result: result(), images: { from: '/frozen.png', to: '/next.png' } }
  const m = mount({ current: snapshot(), historyResponse: { type: 'continuity', page: 2, pageSize: 20, total: 41, activeCount: 0, lowScore: 0, items: [chosen] }, detailResponse: chosen, postResult: { id: 13 } })
  await flush(); m.s.taskFilter.value = 'completed'; m.s.keyword.value = 'A'; await flush(); m.s.page.value = 2; await flush(); m.s.selectTask(chosen)
  m.props.save = async () => { m.calls.push({ path: 'save' }); m.props.version = { id: 9, revision: 2 }; return true }
  await m.s.retrySelected(); await flush()
  const posts = m.calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 1); assert.equal(posts[0].body.revision, 2)
  assert.equal(m.s.view.value, 'detail'); assert.equal(m.s.page.value, 2); assert.equal(m.s.selectedId.value, 12)
  assert.equal(m.s.taskFilter.value, 'completed'); assert.equal(m.s.keyword.value, 'A')
  m.unmount()
})
test('任务完成使筛选结果缩页时仅校正返回页码，不关闭已选详情', async () => {
  let completed = false
  const chosen = { id: 12, type: 'continuity', status: 'pending', current: true, toGroupId: 'b', images: { from: '/frozen.png', to: '/next.png' } }
  const detail = { ...chosen }
  const m = mount({ historyResponse: () => ({ type: 'continuity', pageSize: 20, total: completed ? 20 : 30, activeCount: completed ? 20 : 30, lowScore: 0, items: completed ? [] : [chosen] }), detailResponse: detail })
  await flush(); m.s.taskFilter.value = 'active'; m.s.page.value = 2; await flush(); m.s.selectTask(chosen)
  completed = true; detail.status = 'completed'; detail.result = result(); await m.s.loadHistory(); await flush()
  assert.equal(m.s.page.value, 1); assert.equal(m.s.view.value, 'detail'); assert.equal(m.s.selectedId.value, 12)
  assert.equal(m.s.selected.value.status, 'completed'); assert.equal(m.s.selected.value.result.overallScore, 90)
  m.unmount()
})
test('页面轮询替换相同版本对象不会关闭详情或重置列表分页', async () => {
  const m = mount({ historyResponse: { type: 'continuity', page: 2, pageSize: 20, total: 41, activeCount: 0, lowScore: 0, items: [{ id: 12, type: 'continuity', status: 'completed', images: { from: null, to: null } }] } }); await flush()
  m.s.page.value = 2; await flush(); m.s.selectTask(m.s.history.value.items[0])
  m.props.version = { ...m.props.version }; await flush()
  assert.equal(m.s.view.value, 'detail'); assert.equal(m.s.selectedId.value, 12); assert.equal(m.s.page.value, 2)
  m.unmount()
})
test('发起评测成功回任务列表，仍由用户点击具体记录后展示详情', async () => {
  const m = mount({ postResult: { id: 12 } }); await flush()
  m.s.view.value = 'create'; await m.s.score('b'); await flush()
  assert.equal(m.s.view.value, 'tasks'); assert.equal(m.s.selectedId.value, null)
  assert.match(m.s.taskMessage.value, /已加入队列/); m.unmount()
})
test('旧轮询等待详情后不得按旧总数回退用户已切换的新页码', async () => {
  let total = 20, release
  const chosen = { id: 12, type: 'continuity', status: 'completed', images: { from: null, to: null } }
  const m = mount({ historyResponse: () => ({ type: 'continuity', page: 1, pageSize: 20, total, activeCount: 0, lowScore: 0, items: [chosen] }), detailResponse: new Promise(resolve => { release = resolve }) })
  await flush(); m.s.selectTask(chosen)
  const old = m.s.loadHistory(); await flush()
  m.s.backToTasks(); total = 60; m.s.page.value = 3; await flush()
  assert.equal(m.s.page.value, 3); release(chosen); await old; await flush()
  assert.equal(m.s.page.value, 3); assert.equal(m.s.history.value.total, 60); m.unmount()
})
test('详情重试保留原页码、筛选、搜索和用户选中的任务', async () => {
  const chosen = { id: 12, type: 'continuity', fromGroupId: 'a', toGroupId: 'b', status: 'completed', current: true, inputHash: 'new', result: result(), images: { from: '/old.png', to: '/next.png' } }
  const m = mount({ current: snapshot(), historyResponse: { type: 'continuity', page: 2, pageSize: 20, total: 41, activeCount: 0, lowScore: 0, items: [chosen] }, detailResponse: chosen, postResult: { id: 12 } }); await flush()
  m.s.keyword.value = 'A'; m.s.taskFilter.value = 'completed'; await flush(); await new Promise(resolve => setTimeout(resolve, 270)); await flush()
  m.s.page.value = 2; await flush(); m.s.selectTask(chosen); await m.s.retrySelected(); await flush()
  assert.equal(m.s.view.value, 'detail'); assert.equal(m.s.page.value, 2); assert.equal(m.s.selectedId.value, 12)
  assert.equal(m.s.keyword.value, 'A'); assert.equal(m.s.taskFilter.value, 'completed'); m.unmount()
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

test('评测设置只保存评测字段，携带独立修订号与暂停范围', async () => {
  const m = mount(); await flush(); m.s.concurrency.value = 3; m.s.paused.value = true; m.s.enabled.value = true
  await m.s.saveSettings(); const put = m.calls.find(c => c.method === 'PUT')
  assert.equal(put.path, '/settings/evaluation-tasks')
  assert.deepEqual(Object.keys(put.body).sort(), ['concurrency', 'enabled', 'paused', 'revision', 'threshold'])
  assert.equal(put.body.revision, 1); assert.equal(put.body.concurrency, 3); assert.equal(put.body.paused, true); m.unmount()
})
test('评测保存冲突保留草稿和修订号，状态刷新不覆盖设置', async () => {
  const m = mount({ settingsFailure: Object.assign(new Error('设置已更新'), { status: 409 }) }); await flush()
  m.s.threshold.value = 88; m.s.concurrency.value = 2; await m.s.saveSettings(); await m.s.refresh()
  assert.equal(m.s.settingsConflict.value, true); assert.equal(m.s.threshold.value, 88); assert.equal(m.s.concurrency.value, 2)
  assert.equal(m.s.settings.value.revision, 1); assert.equal(m.s.settingsDirty.value, true); m.unmount()
})

test('保存期间已发出的旧设置查询不能覆盖新修订或草稿', async () => {
  let defer = false, release
  const base = { revision: 1, concurrency: 1, paused: false, enabled: false, threshold: 70, globalTotal: 6, stats: {} }
  const m = mount({ settingsResponse: () => defer ? new Promise(resolve => { release = resolve }) : base }); await flush()
  defer = true; const stale = m.s.loadSettings(false); await flush()
  m.s.concurrency.value = 3; await m.s.saveSettings(); release({ ...base, revision: 0 }); await stale
  assert.equal(m.s.settings.value.revision, 1); assert.equal(m.s.concurrency.value, 3); m.unmount()
})

test('评测设置重载移除已聚焦按钮后，Escape仍关闭抽屉并恢复入口焦点', async () => {
  const m = mount(); await flush(); m.s.expanded.value = true; await flush()
  assert.equal(typeof m.s.handleDrawerKeys, 'function')
  let prevented = false, stopped = false
  m.s.handleDrawerKeys({key:'Escape',preventDefault(){prevented=true},stopPropagation(){stopped=true}})
  assert.equal(m.s.expanded.value,false); assert.equal(prevented,true); assert.equal(stopped,true); m.unmount()
})
