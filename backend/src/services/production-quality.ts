import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { and, desc, eq, max } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { resolveTextModel } from '../agents/index.js'
import { getActiveConfigId, getConfigById } from './ai.js'
import { normalizeTimeline } from './previs-domain.js'
import { episodeForPrevis, getVersion, hashContent, initialTimeline, isCurrentVersion, PrevisError, sourceMetadata, versionRow } from './previs.js'
import { applyProductionRepair, previewProductionRepair, type ProductionOverrides } from './shot-planning-repair.js'
import { evaluateProductionRules, mergeProductionReview, validateQualityEdits, type QualityEdit, type QualityInput, type QualityResult } from './production-quality-domain.js'
import { enqueueQueueJob, getQueueJobById, getQueueJob, resetQueueJob, queueJobView, registerQueueExecutor, updateQueueJob, type QueueJob, type QueueOutcome } from './task-queue.js'
import { readEvaluationSettings } from './task-queue-settings.js'
import { retryRejectedRateLimit, httpErrorStatus } from './task-queue-retry.js'

type Kind = 'rules' | 'review' | 'optimization'
interface Row { id:number; version_id:number; kind:Kind; parent_id:number|null; round:number; input_hash:string; request_key:string; config_id:number; model:string; status:string; input_json:string; result_json:string; error:string|null; applied_version_id:number|null; created_at:string; started_at:string|null; finished_at:string|null }
interface Snapshot { input:QualityInput; revision:number; inputHash:string; projectId:number; sourceCurrent:boolean }
interface ModelOptions { configId:number; model:string; queueJobId?:number }
export type QualityReviewer = (input:QualityInput, options:ModelOptions)=>Promise<unknown>
export type QualityOptimizer = (input:QualityInput & {selectedIds:number[];issues:QualityResult['issues']}, options:ModelOptions)=>Promise<unknown>
const injected = new Map<number, QualityReviewer | QualityOptimizer>()
const stamp=()=>new Date().toISOString()
function toRow(row: typeof schema.productionQualityTasks.$inferSelect): Row {
  return {
    id: row.id, version_id: row.versionId, kind: row.kind as Kind, parent_id: row.parentId,
    round: row.round, input_hash: row.inputHash, request_key: row.requestKey, config_id: row.configId,
    model: row.model, status: row.status, input_json: row.inputJson, result_json: row.resultJson,
    error: row.error, applied_version_id: row.appliedVersionId, created_at: row.createdAt,
    started_at: row.startedAt, finished_at: row.finishedAt,
  }
}
async function rowById(id:number) {
  const row = await db.select().from(schema.productionQualityTasks)
    .where(eq(schema.productionQualityTasks.id, id)).get()
  return row ? toRow(row) : undefined
}

export async function productionQualitySnapshot(versionId:number):Promise<Snapshot> {
  const version=(await versionRow(versionId)), episode=(await episodeForPrevis(version.episodeId)), timeline=normalizeTimeline(JSON.parse(version.timelineJson))
  const order=timeline.groups.flatMap(g=>g.panelIds)
  const panels=[...timeline.panels].sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id))
  const characterIds=new Set(panels.flatMap(p=>p.characterIds)), sceneIds=new Set(panels.map(p=>p.sceneId)), propIds=new Set(panels.flatMap(p=>p.propIds))
  const visualAssets={
    style:(await db.select().from(schema.dramas).where(eq(schema.dramas.id,episode.dramaId)).get())?.style||'',
    characters:(await db.select().from(schema.characters).where(eq(schema.characters.dramaId,episode.dramaId)).all()).filter(c=>!c.deletedAt&&characterIds.has(c.id)).map(c=>({id:c.id,name:c.name,appearance:c.appearance||'',styling:c.styling||'',imageUrl:c.imageUrl||''})),
    scenes:(await db.select().from(schema.scenes).where(eq(schema.scenes.dramaId,episode.dramaId)).all()).filter(s=>!s.deletedAt&&sceneIds.has(s.id)).map(s=>({id:s.id,location:s.location,time:s.time,prompt:s.prompt||'',lighting:s.lighting||'',imageUrl:s.imageUrl||''})),
    props:(await db.select().from(schema.props).where(eq(schema.props.dramaId,episode.dramaId)).all()).filter(p=>!p.deletedAt&&propIds.has(p.id)).map(p=>({id:p.id,name:p.name,description:p.description||'',imageUrl:p.imageUrl||''})),
  }
  const input:QualityInput={script:episode.scriptContent||episode.content||'',panels,visualAssets}
  const source=(await initialTimeline(version.episodeId)).panels
  const sourceCurrent=source.length===panels.length&&panels.every(p=>{
    const live=source.find(s=>s.id===p.id)
    return live&&live.sourceFingerprint===(p.sourceFingerprint||hashContent(sourceMetadata(p)))
  })
  return {input,revision:version.revision,projectId:episode.dramaId,sourceCurrent,
    inputHash:hashContent({versionId,revision:version.revision,timeline:version.timelineJson,script:input.script,visualAssets,source:source.map(sourceMetadata)})}
}
async function requireSnapshot(versionId:number,inputHash?:string,revision?:number) {
  const snapshot=(await productionQualitySnapshot(versionId))
  if (!snapshot.sourceCurrent || !(await isCurrentVersion(versionId)) || (inputHash && inputHash!==snapshot.inputHash) || (revision!==undefined && revision!==snapshot.revision)) throw new PrevisError('分镜或剧本已变化，评测已过期，请重新检查',409)
  return snapshot
}
async function taskView(row:Row, snapshot?:Snapshot) {
  let current=false
  try {const state=snapshot||(await productionQualitySnapshot(row.version_id));current=(await isCurrentVersion(row.version_id))&&state.sourceCurrent&&state.inputHash===row.input_hash} catch {}
  return {id:row.id,type:'planning' as const,versionId:row.version_id,kind:row.kind,parentId:row.parent_id,round:row.round,
    status:row.status,current,inputHash:row.input_hash,result:row.result_json?JSON.parse(row.result_json):null,error:row.error,
    configId:row.config_id,model:row.model,appliedVersionId:row.applied_version_id,
    createdAt:row.created_at,startedAt:row.started_at,finishedAt:row.finished_at,...(await queueJobView('production_quality',row.id))}
}
export async function getProductionQualityTask(taskId:number,versionId?:number) {
  const row=await rowById(taskId)
  if (!row || (versionId!==undefined&&row.version_id!==versionId)) throw new PrevisError('分镜质检任务不存在',404)
  return (await taskView(row))
}
export async function listProductionQualityTasks(versionId:number) {
  const snapshot=(await productionQualitySnapshot(versionId))
  const rows = await db.select().from(schema.productionQualityTasks)
    .where(eq(schema.productionQualityTasks.versionId, versionId))
    .orderBy(desc(schema.productionQualityTasks.id)).all()
  return Promise.all(rows.map(row=>taskView(toRow(row),snapshot)))
}
export async function productionQualityStatus(versionId:number) {
  const snapshot=(await requireSnapshot(versionId)), tasks=(await listProductionQualityTasks(versionId))
  const current=tasks.filter(t=>t.current&&t.kind!=='optimization')
  const task=current.find(t=>t.kind==='review'&&['pending','processing','completed'].includes(t.status))||current[0]||null
  return {inputHash:snapshot.inputHash,rules:evaluateProductionRules(snapshot.input),task,latest:tasks[0]||null}
}
async function insertTask(values:{versionId:number;kind:Kind;parentId?:number;round?:number;snapshot:Snapshot;requestKey:string;configId?:number;model?:string;result?:unknown;extra?:unknown}) {
  const status=values.kind==='rules'?'completed':'pending', created=stamp()
  await db.insert(schema.productionQualityTasks).values({
    versionId:values.versionId,kind:values.kind,parentId:values.parentId||null,round:values.round||0,
    inputHash:values.snapshot.inputHash,requestKey:values.requestKey,configId:values.configId||0,
    model:values.model||'',status,inputJson:JSON.stringify({...values.snapshot,extra:values.extra}),
    resultJson:values.result?JSON.stringify(values.result):'',createdAt:created,
    finishedAt:status==='completed'?created:null,
  }).onConflictDoNothing().run()
  const row = await db.select().from(schema.productionQualityTasks)
    .where(eq(schema.productionQualityTasks.requestKey, values.requestKey)).get()
  if (!row) throw new Error('质检任务创建失败')
  return toRow(row)
}
export async function checkProductionQuality(versionId:number,options:{ai?:boolean;configId?:number;model?:string;source?:'manual'|'automatic'}={}) {
  const snapshot=(await requireSnapshot(versionId)), rules=evaluateProductionRules(snapshot.input)
  const row=await insertTask({versionId,kind:'rules',snapshot,requestKey:hashContent({kind:'rules',hash:snapshot.inputHash}),result:rules})
  let aiTask:Awaited<ReturnType<typeof taskView>>|undefined, aiError:string|undefined
  if (options.ai && (options.source!=='automatic'||(await readEvaluationSettings()).enabled)) {
    try {aiTask=await enqueueQualityReview(versionId,{revision:snapshot.revision,configId:options.configId,model:options.model,source:options.source})}
    catch(error:any) {aiError=error.message}
  }
  return {rules,task:(await taskView(row,snapshot)),aiTask,aiError}
}
async function modelConfig(configId?:number,model?:string) {
  const id=configId||await getActiveConfigId('text')
  const raw=id ? await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id,id)).get() : null
  const config=raw?.isActive&&raw.serviceType==='text'?await getConfigById(id!):null
  if (!config) throw new PrevisError('请先选择可用的文本模型')
  const selected=model||config.model
  if (!selected) throw new PrevisError('文本模型未配置')
  return {configId:id!,model:selected,configHash:hashContent(config)}
}
async function enqueueRow(row:Row,snapshot:Snapshot,configHash:string,runner?:QualityReviewer|QualityOptimizer) {
  if(row.status==='cancelled') {
    await db.update(schema.productionQualityTasks).set({status:'pending',error:null,finishedAt:null,startedAt:null})
      .where(eq(schema.productionQualityTasks.id,row.id)).run()
    await resetQueueJob('production_quality',row.id,{snapshotJson:JSON.stringify({configHash})})
    row=(await rowById(row.id))!
  }
  if(row.status==='pending') await enqueueQueueJob({ownerType:'production_quality',ownerId:row.id,kind:'evaluation',projectId:snapshot.projectId,configId:row.config_id,inputHash:row.input_hash,
    snapshotJson:JSON.stringify({configHash}),source:JSON.parse(row.input_json).extra?.source||'manual'})
  if(runner&&['pending','processing'].includes(row.status)) injected.set(row.id,runner)
  return (await taskView(row,snapshot))
}
export async function enqueueQualityReview(versionId:number,options:{revision:number;configId?:number;model?:string;source?:'manual'|'automatic';parentId?:number;round?:number},reviewer?:QualityReviewer) {
  const snapshot=(await requireSnapshot(versionId,undefined,options.revision))
  if(options.source==='automatic'&&!(await readEvaluationSettings()).enabled) throw new PrevisError('自动评测已关闭',409)
  const config=await modelConfig(options.configId,options.model)
  ;await requireSnapshot(versionId,snapshot.inputHash)
  const key=hashContent({kind:'review',hash:snapshot.inputHash,configId:config.configId,model:config.model,configHash:config.configHash})
  return db.transaction(async ()=>{
    if(options.source==='automatic'&&!(await readEvaluationSettings()).enabled) throw new PrevisError('自动评测已关闭',409)
    const prior=await db.select({round:max(schema.productionQualityTasks.round)}).from(schema.productionQualityTasks)
      .where(and(eq(schema.productionQualityTasks.versionId,versionId),eq(schema.productionQualityTasks.inputHash,snapshot.inputHash))).get()
    const row=await insertTask({versionId,kind:'review',parentId:options.parentId,round:Math.max(options.round||0,prior?.round||0),snapshot,requestKey:key,...config,extra:{source:options.source||'manual'}})
    if(options.source!=='automatic') {
      const input=JSON.parse(row.input_json)
      input.extra={...input.extra,source:'manual'}
      row.input_json=JSON.stringify(input)
      await db.update(schema.productionQualityTasks).set({inputJson:row.input_json})
        .where(eq(schema.productionQualityTasks.id,row.id)).run()
      const queued=(await getQueueJob('production_quality',row.id))
      if(queued)(await updateQueueJob(queued.id,{source:'manual'}))
    }
    return (await enqueueRow(row,snapshot,config.configHash,reviewer))
  })
}
export async function enqueueQualityOptimization(versionId:number,reviewId:number,options:{inputHash:string;issueIds:string[];configId?:number;model?:string},optimizer?:QualityOptimizer) {
  const parent=await rowById(reviewId)
  if(!parent||parent.version_id!==versionId||parent.kind==='optimization'||parent.status!=='completed') throw new PrevisError('请选择已完成的有效评测')
  const snapshot=(await requireSnapshot(versionId,options.inputHash))
  if(parent.input_hash!==snapshot.inputHash) throw new PrevisError('评测已过期，请重新检查',409)
  if(parent.round>=2) throw new PrevisError('本轮已完成两次 AI 优化，请人工核对后重新规划')
  const result=JSON.parse(parent.result_json) as QualityResult
  if(!options.issueIds.length||new Set(options.issueIds).size!==options.issueIds.length||options.issueIds.some(id=>!result.issues.some(i=>i.id===id))) throw new PrevisError('选择的问题已变化，请重新选择')
  const issues=result.issues.filter(i=>options.issueIds.includes(i.id))
  const selectedIds=[...new Set(issues.flatMap(i=>i.panelIds.length?i.panelIds:snapshot.input.panels.map(p=>p.id)))]
  const config=await modelConfig(options.configId||parent.config_id,options.model||parent.model)
  ;await requireSnapshot(versionId,snapshot.inputHash)
  const key=hashContent({kind:'optimization',hash:snapshot.inputHash,parentId:reviewId,issues:[...options.issueIds].sort(),configId:config.configId,model:config.model,configHash:config.configHash})
  return db.transaction(async ()=>{
    const row=await insertTask({versionId,kind:'optimization',parentId:reviewId,round:parent.round+1,snapshot,requestKey:key,...config,extra:{issues,selectedIds,source:'manual'}})
    return (await enqueueRow(row,snapshot,config.configHash,optimizer))
  })
}
const optimizationSchema=z.object({summary:z.string().min(1).max(2000),edits:z.array(z.object({panelId:z.number().int().positive(),description:z.string().min(1).max(30000),atmosphere:z.string().max(30000).optional()}).strict()).min(1).max(200)})
const reviewDimension=z.object({score:z.number().min(0).max(100),comment:z.string()})
const reviewSchema=z.object({overallScore:z.number().min(0).max(100),confidence:z.enum(['high','medium','low']),summary:z.string().trim().min(1),
  dimensions:z.object({dialogue:reviewDimension,timing:reviewDimension,coverage:reviewDimension,continuity:reviewDimension,production:reviewDimension}),issues:z.array(z.unknown())})
function parseJson(text:string) {
  const code=text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  try {return JSON.parse(code||text.slice(text.indexOf('{'),text.lastIndexOf('}')+1))} catch {throw new Error('AI 未返回可解析的 JSON，请查看任务后重试')}
}
async function runModel(kind:Kind,input:any,options:ModelOptions) {
  const instructions=kind==='review'
    ? '你是独立影视分镜质检员。原剧本是对白唯一依据。评估完整对白及说话/旁白/内心类型、自然时间与表演余量、子镜头与画面规划覆盖、前后动作空间与场景连续性、是否过度拆段增加成本。原始图片尚未生成不算拆分错误，不评价不存在的图片或实际音频。必须返回 JSON：{overallScore:0到100,confidence:"high"或"medium"或"low",summary,dimensions:{dialogue:{score:0到100,comment},timing:{score,comment},coverage:{score,comment},continuity:{score,comment},production:{score,comment}},issues:[{rule, panelIds:[真实分镜ID], message,suggestion,evidence}]}。每条问题引用证据；未证实的问题表述为建议。不得输出工具调用或改写分镜。'
    : '你是影视分镜优化师。仅优化 selectedIds 中与 issues 对应的分镜描述，其他分镜及邻镜只是上下文。原剧本和现有台词必须逐字保留，不能删词、改说话人、旁白/内心类型或顺序。只补充必要的可视动作、表演节奏与前后衔接，避免无意义切镜。每个子镜头用【镜头N】，台词用角色：「原文」。时长、提示词和拆段由服务端统一规划，不自行返回。仅返回 JSON：{summary,edits:[{panelId:真实ID,description,atmosphere?:可选氛围}]}。不得调用工具、输出额外字段或改未选分镜。'
  const agent=new Agent({id:`production-quality-${kind}`,name:'分镜规划质检',instructions,model:await resolveTextModel(options.model,options.configId),maxRetries:0})
  const response=await retryRejectedRateLimit(async()=>{
    if(options.queueJobId&&(await getQueueJobById(options.queueJobId))?.status!=='processing') throw new PrevisError('任务已取消')
    if(options.queueJobId) (await updateQueueJob(options.queueJobId,{submitted:true,phase:'upstream'}))
    return agent.generate([{role:'user',content:JSON.stringify(input)}],{maxSteps:1})
  },async ()=>{if(options.queueJobId)(await updateQueueJob(options.queueJobId,{submitted:false,phase:'retry_wait'}))})
  if(options.queueJobId)(await updateQueueJob(options.queueJobId,{upstreamDone:true,phase:'saving'}))
  return parseJson(response.text)
}
async function executeQuality(job:QueueJob):Promise<QueueOutcome> {
  const row=await rowById(job.ownerId)
  if(!row)return{status:'failed',error:'质检任务不存在'}
  if(row.status==='completed'&&row.result_json)return{status:'completed'}
  if(job.upstreamDone) {
    const error='模型请求已结束，但结果未完成保存。请人工重试；不会自动重复调用模型'
    await db.update(schema.productionQualityTasks).set({status:'failed',error,finishedAt:stamp()})
      .where(eq(schema.productionQualityTasks.id,row.id)).run()
    return{status:'failed',error}
  }
  if(job.submitted&&!job.upstreamDone)return{status:'needs_confirmation',error:'模型请求曾提交，请核对服务商记录后再重试'}
  try {
    const snapshot=JSON.parse(row.input_json) as Snapshot&{extra:any}
    ;await requireSnapshot(row.version_id,row.input_hash)
    const config=await getConfigById(row.config_id)
    if(!config||hashContent(config)!==JSON.parse(job.snapshotJson).configHash)throw new PrevisError('模型配置已变化，请重新提交')
    if((await getQueueJobById(job.id))?.status!=='processing')return{status:'failed',error:'任务已取消'}
    await db.update(schema.productionQualityTasks).set({status:'processing',startedAt:stamp(),error:null})
      .where(eq(schema.productionQualityTasks.id,row.id)).run()
    const input=row.kind==='optimization'?{...snapshot.input,...snapshot.extra}:{...snapshot.input,rules:evaluateProductionRules(snapshot.input)}
    const runner=injected.get(row.id)
    if(runner)(await updateQueueJob(job.id,{submitted:true,phase:'upstream'}))
    const raw=await (runner?runner(input,{configId:row.config_id,model:row.model,queueJobId:job.id}):(await runModel(row.kind,input,{configId:row.config_id,model:row.model,queueJobId:job.id})));
    (await updateQueueJob(job.id,{upstreamDone:true,phase:'saving'}))
    ;await requireSnapshot(row.version_id,row.input_hash)
    let result:unknown
    if(row.kind==='optimization') {
      const candidate=optimizationSchema.parse(raw)
      validateQualityEdits(snapshot.input,snapshot.extra.selectedIds,candidate.edits)
      const overrides=Object.fromEntries(candidate.edits.map(e=>[e.panelId,{description:e.description,...(e.atmosphere!==undefined?{atmosphere:e.atmosphere}:{})}])) as ProductionOverrides
      const preview=(await previewProductionRepair(row.version_id,{revision:snapshot.revision,panelIds:candidate.edits.map(e=>e.panelId),maxSeconds:15},overrides))
      if(preview.proposals.some(p=>p.error))throw new PrevisError('优化后的对白无法安全安排时长，请核对描述')
      result={...candidate,preview}
    } else result=mergeProductionReview(snapshot.input,reviewSchema.parse(raw))
    await db.update(schema.productionQualityTasks).set({status:'completed',resultJson:JSON.stringify(result),error:null,finishedAt:stamp()})
      .where(eq(schema.productionQualityTasks.id,row.id)).run()
    injected.delete(row.id)
    return{status:'completed'}
  } catch(error:any) {
    const latest=(await getQueueJobById(job.id))!
    const status=httpErrorStatus(error)
    const rejected=Number.isInteger(status)&&status!>=400&&status!<500&&status!==408
    if(latest.submitted&&rejected) (await updateQueueJob(job.id,{upstreamDone:true}))
    const uncertain=latest.submitted&&!latest.upstreamDone&&!rejected
    const message=error.message||'分镜质检失败'
    await db.update(schema.productionQualityTasks).set({status:uncertain?'processing':'failed',error:message,finishedAt:uncertain?null:stamp()})
      .where(eq(schema.productionQualityTasks.id,row.id)).run()
    return{status:uncertain?'needs_confirmation':'failed',error:message}
  }
}
registerQueueExecutor('production_quality',{execute:executeQuality,recover:executeQuality,
  async onCancel(job){injected.delete(job.ownerId);await db.update(schema.productionQualityTasks).set({status:'cancelled',finishedAt:stamp()}).where(eq(schema.productionQualityTasks.id,job.ownerId)).run()},
  async onRetry(job){const row=(await rowById(job.ownerId))!;await requireSnapshot(row.version_id,row.input_hash);await updateQueueJob(job.id,{submitted:false,upstreamDone:false});await db.update(schema.productionQualityTasks).set({status:'pending',error:null,finishedAt:null}).where(eq(schema.productionQualityTasks.id,row.id)).run()},
  async onRequeue(job){await db.update(schema.productionQualityTasks).set({status:'pending',error:null}).where(eq(schema.productionQualityTasks.id,job.ownerId)).run()},
  async onReconcile(job){await db.update(schema.productionQualityTasks).set({status:'failed',error:'已核对上游状态，可重试',finishedAt:stamp()}).where(eq(schema.productionQualityTasks.id,job.ownerId)).run()},
})
export async function applyQualityOptimization(versionId:number,taskId:number,options:{inputHash:string}) {
  const row=await rowById(taskId)
  if(!row||row.version_id!==versionId||row.kind!=='optimization'||row.status!=='completed')throw new PrevisError('没有可采用的优化候选')
  if(options.inputHash!==row.input_hash)throw new PrevisError('候选输入不匹配，请重新预览',409)
  if(row.applied_version_id)return (await getVersion(row.applied_version_id))
  ;await requireSnapshot(versionId,row.input_hash)
  const candidate=optimizationSchema.passthrough().parse(JSON.parse(row.result_json)), snapshot=JSON.parse(row.input_json) as Snapshot&{extra:any}
  validateQualityEdits(snapshot.input,snapshot.extra.selectedIds,candidate.edits)
  const result=JSON.parse(row.result_json), overrides=Object.fromEntries(candidate.edits.map(e=>[e.panelId,{description:e.description,...(e.atmosphere!==undefined?{atmosphere:e.atmosphere}:{})}])) as ProductionOverrides
  const applied=await db.transaction(async ()=>{
    const version=(await applyProductionRepair(versionId,{revision:snapshot.revision,panelIds:candidate.edits.map(e=>e.panelId),maxSeconds:15,inputHash:result.preview.inputHash},overrides))
    await db.update(schema.productionQualityTasks).set({appliedVersionId:version.id})
      .where(eq(schema.productionQualityTasks.id,row.id)).run()
    const next=(await productionQualitySnapshot(version.id)), rules=evaluateProductionRules(next.input)
    await insertTask({versionId:version.id,kind:'rules',parentId:row.id,round:row.round,snapshot:next,requestKey:hashContent({kind:'rules',hash:next.inputHash}),result:rules})
    return version
  })
  if((await readEvaluationSettings()).enabled) {
    try {await enqueueQualityReview(applied.id,{revision:applied.revision,configId:row.config_id,model:row.model,source:'automatic',parentId:row.id,round:row.round})}
    catch(error:any){console.error('优化后的 AI 复评未提交:',error.message)}
  }
  return applied
}
