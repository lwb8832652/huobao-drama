import assert from 'node:assert/strict'
import { test } from 'node:test'
import {eq, sql} from 'drizzle-orm'
process.env.SQLITE_PATH = ':memory:'
const { db, schema } = await import('../src/db/index.js')

// 还原后的 db 是 drizzle sqlite-proxy 异步封装，不再暴露 better-sqlite3 的 $client；
// 测试里的裸 SQL 改为统一的 raw 执行入口（? 占位按字面量内联，仅测试使用）。
const lit = (v: any) => (typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
const build = (text: string, args: any[]) => { let out = text; for (const a of args) out = out.replace('?', lit(a)); return sql.raw(out) }
const rawRun = async (text: string, ...args: any[]) => {
  // 多语句按分号拆分执行（CREATE TRIGGER 这类含 BEGIN...END 的整段执行）
  if (/\bbegin\b/i.test(text) && /\bend\b/i.test(text)) { await db.run(build(text, args)); return }
  let taken = 0
  for (const part of text.split(';')) {
    if (!part.trim()) continue
    const used = (part.match(/\?/g) ?? []).length
    await db.run(build(part.trim(), args.slice(taken, taken + used)))
    taken += used
  }
}
// rawAll/rawGet 走 sqlite-proxy 的 raw 模式，行是按列顺序排列的位置数组。
const rawAll = async (text: string, ...args: any[]) => (await db.all(build(text, args))) as any[]
const rawGet = async (text: string, ...args: any[]) => (await db.get(build(text, args))) as any

const previs = await import('../src/services/previs.js')
const queue = await import('../src/services/task-queue.js')
const settings = await import('../src/services/task-queue-settings.js')
const quality = await import('../src/services/production-quality.js').catch(() => null)
const stamp = new Date().toISOString()
await db.insert(schema.dramas).values({ id: 1, title: '质检', createdAt: stamp, updatedAt: stamp }).run()
await db.insert(schema.aiServiceConfigs).values({ id: 1, name: '离线注入', serviceType: 'text', provider: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'test', model: '["mock"]', isActive: true, createdAt: stamp, updatedAt: stamp }).run()
async function seed() {
  const episodeId = Number((await db.insert(schema.episodes).values({ dramaId: 1, episodeNumber: 1, title: '集', scriptContent: '小明：你好。', createdAt: stamp, updatedAt: stamp }).run()).lastInsertRowid)
  const panelId = Number((await db.insert(schema.storyboards).values({ episodeId, storyboardNumber: 1, title: '问候', description: '【镜头1】小明站在门口。小明：「你好。」', videoPrompt: '0-8秒：小明站在门口。小明：「你好。」', duration: 8, composedImage: '/static/old.png', videoUrl: '/static/old.mp4', createdAt: stamp, updatedAt: stamp }).run()).lastInsertRowid)
  return { episodeId, panelId, version: await previs.createVersion(episodeId) }
}
const ai = { overallScore: 90, confidence: 'high', summary: '节奏可优化', dimensions: Object.fromEntries(['dialogue','timing','coverage','continuity','production'].map(k => [k,{score:18,comment:'合理'}])), issues: [] }
async function done(id: number) {
  await queue.tickTaskQueue()
  for (let i=0;i<150;i++) {
    const row=await quality!.getProductionQualityTask(id)
    if (['completed','failed'].includes(row.status) && (!row.queueJobId || ['completed','failed'].includes((await queue.getQueueJobById(row.queueJobId))!.status))) return row
    await new Promise(r=>setTimeout(r,5))
  }
  assert.fail('quality task did not finish')
}
test('free whole-episode check persists a deduplicated result without model calls', async () => {
  assert.ok(quality, 'production quality service must exist')
  const {version}=(await seed()), before=(await db.select().from(schema.sysTask).all()).length
  const a=await quality.checkProductionQuality(version.id), b=await quality.checkProductionQuality(version.id)
  assert.equal(a.task.id,b.task.id); assert.equal(a.task.status,'completed'); assert.equal(a.task.kind,'rules')
  assert.equal((await db.select().from(schema.sysTask).all()).length,before)
})
test('AI review uses evaluation queue, deduplicates active input and keeps hard rule failures', async () => {
  assert.ok(quality)
  await settings.saveEvaluationSettings({...(await settings.readEvaluationSettings()),paused:true})
  const {version}=(await seed()); let calls=0
  const reviewer=async()=>{calls++;return ai}
  const a=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},reviewer)
  const b=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},reviewer)
  assert.equal(a.id,b.id); assert.equal(calls,0); assert.equal((await queue.getQueueJob('production_quality',a.id))?.kind,'evaluation')
  await settings.saveEvaluationSettings({...(await settings.readEvaluationSettings()),paused:false})
  const finished=await done(a.id); assert.equal(finished.status,'completed'); assert.equal(calls,1)
  assert.equal((await quality.productionQualityStatus(version.id)).task?.id,a.id)
})
test('targeted optimization stays a candidate until adoption and preserves old media with recheck', async () => {
  assert.ok(quality)
  const {version,panelId}=(await seed())
  const review=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},async()=>({...ai,issues:[{rule:'acting',panelIds:[panelId],message:'缺少回应动作',suggestion:'补充抬头回应'}]}))
  const report=await done(review.id), issue=report.result!.issues.find((i:any)=>i.rule==='acting')!
  assert.ok(issue)
  const before=(await db.select().from(schema.animaticVersions).all()).length
  const optimization=await quality.enqueueQualityOptimization(version.id,review.id,{inputHash:report.inputHash,issueIds:[issue.id],configId:1},async()=>({summary:'补充回应动作',edits:[{panelId,description:'【镜头1】小明站在门口，抬头微笑回应。小明：「你好。」'}]}))
  const candidate=await done(optimization.id); assert.equal(candidate.status,'completed',candidate.error||'')
  assert.equal((await db.select().from(schema.animaticVersions).all()).length,before)
  assert.equal((await previs.getVersion(version.id)).timeline.panels[0].description,version.timeline.panels[0].description)
  const applied=await quality.applyQualityOptimization(version.id,optimization.id,{inputHash:candidate.inputHash})
  assert.notEqual(applied.id,version.id); assert.match(applied.timeline.panels[0].description,/抬头微笑/)
  assert.equal((await previs.getVersion(version.id)).timeline.panels[0].videoUrl,'/static/old.mp4')
  assert.equal(applied.timeline.panels[0].frames[0].url,'/static/old.png')
  assert.equal(applied.timeline.panels[0].framePlanNeedsReview,true)
  assert.ok((await quality.productionQualityStatus(applied.id)).task)
})
test('changed script makes a report historical and rejects optimization without queue work', async () => {
  assert.ok(quality)
  const {version,episodeId}=(await seed()), report=(await quality.checkProductionQuality(version.id)).task
  await db.update(schema.episodes).set({scriptContent:'小明：再见。'}).where(eq(schema.episodes.id,episodeId)).run()
  assert.equal((await quality.getProductionQualityTask(report.id)).current,false)
  const before=await rawGet('select count(*) n from task_queue_jobs') as any
  await assert.rejects(async()=>quality.enqueueQualityOptimization(version.id,report.id,{inputHash:report.inputHash,issueIds:['fake'],configId:1}),/过期|变化/)
  assert.deepEqual(await rawGet('select count(*) n from task_queue_jobs'),before)
})
test('confirmed model rejection can retry and a new attempt clears prior submission flags', async () => {
  assert.ok(quality)
  const {version}=(await seed());let calls=0
  const review=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},async()=>{
    calls++;if(calls===1)throw Object.assign(new Error('invalid input'),{statusCode:400})
    return ai
  })
  const failed=await done(review.id);assert.equal(failed.status,'failed')
  assert.equal(failed.canRetry,true)
  const job=await queue.retryQueueJob(failed.queueJobId!)
  assert.equal(job.submitted,false);assert.equal(job.upstreamDone,false)
  assert.equal((await done(review.id)).status,'completed');assert.equal(calls,2)
})
test('unknown transport outcome needs reconciliation instead of automatic duplicate calls', async () => {
  assert.ok(quality)
  const {version}=(await seed());let calls=0
  const review=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},async()=>{calls++;throw new Error('connection reset')})
  await queue.tickTaskQueue()
  for(let i=0;i<50&&(await quality.getProductionQualityTask(review.id)).phase!=='needs_confirmation';i++)await new Promise(r=>setTimeout(r,5))
  const task=await quality.getProductionQualityTask(review.id)
  assert.equal(task.phase,'needs_confirmation');assert.equal(task.canRetry,false)
  await queue.tickTaskQueue();assert.equal(calls,1)
  await queue.reconcileQueueJob(task.queueJobId!,true)
})
test('malformed AI review is a failed task rather than a passing rule report', async () => {
  assert.ok(quality)
  const {version}=(await seed())
  const review=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},async()=>({unexpected:'not a review'}))
  const failed=await done(review.id);assert.equal(failed.status,'failed');assert.equal(failed.canRetry,true)
})
test('optimization obeys evaluation pause and the two-round chain survives manual rechecks', async()=>{
  assert.ok(quality)
  let {version,panelId}=(await seed())
  for(let round=1;round<=2;round++){
    const review=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},async()=>({...ai,issues:[{rule:'acting',panelIds:[panelId],message:'表演可增强',suggestion:'补充回应动作'}]}))
    const report=await done(review.id),issue=report.result.issues.find((i:any)=>i.rule==='acting')!
    await settings.saveEvaluationSettings({...(await settings.readEvaluationSettings()),paused:true});let calls=0
    const candidate=await quality.enqueueQualityOptimization(version.id,review.id,{inputHash:report.inputHash,issueIds:[issue.id],configId:1},async()=>{calls++;return{summary:'优化表演',edits:[{panelId,description:`【镜头1】小明在门口挥手${'微笑'.repeat(round)}。小明：「你好。」`}]}})
    assert.equal((await queue.getQueueJob('production_quality',candidate.id))?.kind,'evaluation')
    await queue.tickTaskQueue();assert.equal(calls,0)
    await settings.saveEvaluationSettings({...(await settings.readEvaluationSettings()),paused:false})
    assert.equal((await done(candidate.id)).status,'completed')
    version=await quality.applyQualityOptimization(version.id,candidate.id,{inputHash:candidate.inputHash})
    await quality.checkProductionQuality(version.id)
  }
  const report=(await quality.checkProductionQuality(version.id)).task
  assert.equal(report.round,2)
  const manual=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},async()=>({...ai,issues:[{rule:'acting',panelIds:[panelId],message:'还可调整',suggestion:'人工核对'}]}))
  const reviewed=await done(manual.id);assert.equal(reviewed.round,2)
  await assert.rejects(async()=>quality.enqueueQualityOptimization(version.id,manual.id,{inputHash:manual.inputHash,issueIds:reviewed.result.issues.map((i:any)=>i.id),configId:1}),/两次/)
})
test('restart after model completion never automatically repeats the paid request',async()=>{
  assert.ok(quality)
  const {version}=(await seed());let calls=0
  const task=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},async()=>{calls++;return ai})
  await rawRun("UPDATE task_queue_jobs SET status='processing',submitted=1,upstream_done=1,phase='saving' WHERE id=?", task.queueJobId!)
  await rawRun("UPDATE production_quality_tasks SET status='processing' WHERE id=?", task.id)
  await queue.recoverTaskQueue()
  for(let i=0;i<50&&(await queue.getQueueJobById(task.queueJobId!))?.status==='processing';i++)await new Promise(r=>setTimeout(r,5))
  const recovered=await quality.getProductionQualityTask(task.id)
  assert.equal(calls,0);assert.equal(recovered.status,'failed');assert.equal(recovered.canRetry,true)
})
test('manual requests promote paused automatic jobs and can restart confirmed cancelled work',async()=>{
 assert.ok(quality)
 const {version}=(await seed())
 await settings.saveEvaluationSettings({...(await settings.readEvaluationSettings()),enabled:true,paused:true})
 const automatic=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1,source:'automatic'},async()=>ai)
 const manual=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1,source:'manual'},async()=>ai)
 assert.equal(manual.id,automatic.id);assert.equal((await queue.getQueueJobById(manual.queueJobId!))?.source,'manual')
 await settings.saveEvaluationSettings({...(await settings.readEvaluationSettings()),enabled:false})
 assert.equal((await quality.getProductionQualityTask(manual.id)).status,'pending')
 await queue.cancelQueueJob(manual.queueJobId!)
 const restart=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},async()=>ai)
 assert.equal(restart.status,'pending')
 await settings.saveEvaluationSettings({...(await settings.readEvaluationSettings()),paused:false})
 assert.equal((await done(restart.id)).status,'completed')
})
test('owner and queue job insert atomically, and changed provider config uses a fresh request',async()=>{
 assert.ok(quality)
 const {version}=(await seed()),before=await rawGet('SELECT count(*) n FROM production_quality_tasks')
 await rawRun("CREATE TEMP TRIGGER fail_quality_queue BEFORE INSERT ON task_queue_jobs WHEN NEW.owner_type='production_quality' BEGIN SELECT RAISE(ABORT,'test enqueue failure'); END")
 try{await assert.rejects(async()=>quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1}),(error:any)=>/enqueue failure/.test(String(error?.cause?.message||'')+'|'+String(error?.message||'')))}finally{await rawRun('DROP TRIGGER fail_quality_queue')}
 assert.deepEqual(await rawGet('SELECT count(*) n FROM production_quality_tasks'),before)
 const first=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},async()=>ai)
 await done(first.id)
 await db.update(schema.aiServiceConfigs).set({baseUrl:'http://127.0.0.1:2'}).where(eq(schema.aiServiceConfigs.id,1)).run()
 const changed=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},async()=>ai)
 assert.notEqual(changed.id,first.id);await done(changed.id)
})
test('server timeouts are uncertain, and automatic/manual reviews share the same paid work',async()=>{
 assert.ok(quality)
 const {version}=(await seed())
 await settings.saveEvaluationSettings({...(await settings.readEvaluationSettings()),enabled:true,paused:true})
 const auto=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1,source:'automatic',parentId:123,round:1},async()=>ai)
 const manual=await quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1},async()=>{throw Object.assign(new Error('gateway timeout'),{statusCode:504})})
 assert.equal(auto.id,manual.id)
 assert.equal((await queue.getQueueJobById(manual.queueJobId!))?.source,'manual')
 await settings.saveEvaluationSettings({...(await settings.readEvaluationSettings()),paused:false,enabled:false})
 await queue.tickTaskQueue()
 for(let i=0;i<50&&(await quality.getProductionQualityTask(manual.id)).phase!=='needs_confirmation';i++)await new Promise(r=>setTimeout(r,5))
 const result=await quality.getProductionQualityTask(manual.id)
 assert.equal(result.phase,'needs_confirmation');assert.equal(result.canRetry,false)
 await queue.reconcileQueueJob(manual.queueJobId!,true)
})
test('a workspace already behind source edits cannot create a current passing report or paid job',async()=>{
 assert.ok(quality)
 const {version,panelId}=(await seed())
 await db.update(schema.storyboards).set({description:'【镜头1】小明抬头转身。'}).where(eq(schema.storyboards.id,panelId)).run()
 const before=await rawGet('SELECT count(*) n FROM production_quality_tasks')
 await assert.rejects(async()=>quality.checkProductionQuality(version.id),/变化|刷新|过期/)
 await assert.rejects(async()=>quality.enqueueQualityReview(version.id,{revision:version.revision,configId:1}),/变化|刷新|过期/)
 await assert.rejects(async () => quality.productionQualityStatus(version.id),/变化|刷新|过期/)
 assert.deepEqual(await rawGet('SELECT count(*) n FROM production_quality_tasks'),before)
})
