import { Agent } from '@mastra/core/agent'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
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
const client = db.$client, stamp=()=>new Date().toISOString()
const rowById=(id:number)=>client.prepare('SELECT * FROM production_quality_tasks WHERE id=?').get(id) as Row|undefined

export function productionQualitySnapshot(versionId:number):Snapshot {
  const version=versionRow(versionId), episode=episodeForPrevis(version.episodeId), timeline=normalizeTimeline(JSON.parse(version.timelineJson))
  const order=timeline.groups.flatMap(g=>g.panelIds)
  const panels=[...timeline.panels].sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id))
  const characterIds=new Set(panels.flatMap(p=>p.characterIds)), sceneIds=new Set(panels.map(p=>p.sceneId)), propIds=new Set(panels.flatMap(p=>p.propIds))
  const visualAssets={
    style:db.select().from(schema.dramas).where(eq(schema.dramas.id,episode.dramaId)).get()?.style||'',
    characters:db.select().from(schema.characters).where(eq(schema.characters.dramaId,episode.dramaId)).all().filter(c=>!c.deletedAt&&characterIds.has(c.id)).map(c=>({id:c.id,name:c.name,appearance:c.appearance||'',styling:c.styling||'',imageUrl:c.imageUrl||''})),
    scenes:db.select().from(schema.scenes).where(eq(schema.scenes.dramaId,episode.dramaId)).all().filter(s=>!s.deletedAt&&sceneIds.has(s.id)).map(s=>({id:s.id,location:s.location,time:s.time,prompt:s.prompt||'',lighting:s.lighting||'',imageUrl:s.imageUrl||''})),
    props:db.select().from(schema.props).where(eq(schema.props.dramaId,episode.dramaId)).all().filter(p=>!p.deletedAt&&propIds.has(p.id)).map(p=>({id:p.id,name:p.name,description:p.description||'',imageUrl:p.imageUrl||''})),
  }
  const input:QualityInput={script:episode.scriptContent||episode.content||'',panels,visualAssets}
  const source=initialTimeline(version.episodeId).panels
  const sourceCurrent=source.length===panels.length&&panels.every(p=>{
    const live=source.find(s=>s.id===p.id)
    return live&&live.sourceFingerprint===(p.sourceFingerprint||hashContent(sourceMetadata(p)))
  })
  return {input,revision:version.revision,projectId:episode.dramaId,sourceCurrent,
    inputHash:hashContent({versionId,revision:version.revision,timeline:version.timelineJson,script:input.script,visualAssets,source:source.map(sourceMetadata)})}
}
function requireSnapshot(versionId:number,inputHash?:string,revision?:number) {
  const snapshot=productionQualitySnapshot(versionId)
  if (!snapshot.sourceCurrent || !isCurrentVersion(versionId) || (inputHash && inputHash!==snapshot.inputHash) || (revision!==undefined && revision!==snapshot.revision)) throw new PrevisError('分镜或剧本已变化，评测已过期，请重新检查',409)
  return snapshot
}
function taskView(row:Row, snapshot?:Snapshot) {
  let current=false
  try {const state=snapshot||productionQualitySnapshot(row.version_id);current=isCurrentVersion(row.version_id)&&state.sourceCurrent&&state.inputHash===row.input_hash} catch {}
  return {id:row.id,type:'planning' as const,versionId:row.version_id,kind:row.kind,parentId:row.parent_id,round:row.round,
    status:row.status,current,inputHash:row.input_hash,result:row.result_json?JSON.parse(row.result_json):null,error:row.error,
    configId:row.config_id,model:row.model,appliedVersionId:row.applied_version_id,
    createdAt:row.created_at,startedAt:row.started_at,finishedAt:row.finished_at,...queueJobView('production_quality',row.id)}
}
export function getProductionQualityTask(taskId:number,versionId?:number) {
  const row=rowById(taskId)
  if (!row || (versionId!==undefined&&row.version_id!==versionId)) throw new PrevisError('分镜质检任务不存在',404)
  return taskView(row)
}
export function listProductionQualityTasks(versionId:number) {
  const snapshot=productionQualitySnapshot(versionId)
  return (client.prepare("SELECT id,version_id,kind,parent_id,round,input_hash,request_key,config_id,model,status,result_json,error,applied_version_id,created_at,started_at,finished_at,'' AS input_json FROM production_quality_tasks WHERE version_id=? ORDER BY id DESC").all(versionId) as Row[]).map(row=>taskView(row,snapshot))
}
export function productionQualityStatus(versionId:number) {
  const snapshot=requireSnapshot(versionId), tasks=listProductionQualityTasks(versionId)
  const current=tasks.filter(t=>t.current&&t.kind!=='optimization')
  const task=current.find(t=>t.kind==='review'&&['pending','processing','completed'].includes(t.status))||current[0]||null
  return {inputHash:snapshot.inputHash,rules:evaluateProductionRules(snapshot.input),task,latest:tasks[0]||null}
}
function insertTask(values:{versionId:number;kind:Kind;parentId?:number;round?:number;snapshot:Snapshot;requestKey:string;configId?:number;model?:string;result?:unknown;extra?:unknown}) {
  const status=values.kind==='rules'?'completed':'pending', created=stamp()
  client.prepare(`INSERT INTO production_quality_tasks(version_id,kind,parent_id,round,input_hash,request_key,config_id,model,status,input_json,result_json,created_at,finished_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING`).run(values.versionId,values.kind,values.parentId||null,values.round||0,values.snapshot.inputHash,values.requestKey,values.configId||0,values.model||'',status,JSON.stringify({...values.snapshot,extra:values.extra}),values.result?JSON.stringify(values.result):'',created,status==='completed'?created:null)
  return client.prepare('SELECT * FROM production_quality_tasks WHERE request_key=?').get(values.requestKey) as Row
}
export async function checkProductionQuality(versionId:number,options:{ai?:boolean;configId?:number;model?:string;source?:'manual'|'automatic'}={}) {
  const snapshot=requireSnapshot(versionId), rules=evaluateProductionRules(snapshot.input)
  const row=insertTask({versionId,kind:'rules',snapshot,requestKey:hashContent({kind:'rules',hash:snapshot.inputHash}),result:rules})
  let aiTask:ReturnType<typeof taskView>|undefined, aiError:string|undefined
  if (options.ai && (options.source!=='automatic'||readEvaluationSettings().enabled)) {
    try {aiTask=await enqueueQualityReview(versionId,{revision:snapshot.revision,configId:options.configId,model:options.model,source:options.source})}
    catch(error:any) {aiError=error.message}
  }
  return {rules,task:taskView(row,snapshot),aiTask,aiError}
}
async function modelConfig(configId?:number,model?:string) {
  const id=configId||await getActiveConfigId('text')
  const raw=id&&client.prepare("SELECT service_type,is_active FROM ai_service_configs WHERE id=?").get(id) as any
  const config=raw?.is_active&&raw.service_type==='text'?await getConfigById(id!):null
  if (!config) throw new PrevisError('请先选择可用的文本模型')
  const selected=model||config.model
  if (!selected) throw new PrevisError('文本模型未配置')
  return {configId:id!,model:selected,configHash:hashContent(config)}
}
function enqueueRow(row:Row,snapshot:Snapshot,configHash:string,runner?:QualityReviewer|QualityOptimizer) {
  if(row.status==='cancelled') {
    client.prepare("UPDATE production_quality_tasks SET status='pending',error=NULL,finished_at=NULL,started_at=NULL WHERE id=?").run(row.id)
    resetQueueJob('production_quality',row.id,{snapshotJson:JSON.stringify({configHash})})
    row=rowById(row.id)!
  }
  if(row.status==='pending') enqueueQueueJob({ownerType:'production_quality',ownerId:row.id,kind:'evaluation',projectId:snapshot.projectId,configId:row.config_id,inputHash:row.input_hash,
    snapshotJson:JSON.stringify({configHash}),source:JSON.parse(row.input_json).extra?.source||'manual'})
  if(runner&&['pending','processing'].includes(row.status)) injected.set(row.id,runner)
  return taskView(row,snapshot)
}
export async function enqueueQualityReview(versionId:number,options:{revision:number;configId?:number;model?:string;source?:'manual'|'automatic';parentId?:number;round?:number},reviewer?:QualityReviewer) {
  const snapshot=requireSnapshot(versionId,undefined,options.revision)
  if(options.source==='automatic'&&!readEvaluationSettings().enabled) throw new PrevisError('自动评测已关闭',409)
  const config=await modelConfig(options.configId,options.model)
  requireSnapshot(versionId,snapshot.inputHash)
  const key=hashContent({kind:'review',hash:snapshot.inputHash,configId:config.configId,model:config.model,configHash:config.configHash})
  return client.transaction(()=>{
    if(options.source==='automatic'&&!readEvaluationSettings().enabled) throw new PrevisError('自动评测已关闭',409)
    const prior=client.prepare('SELECT MAX(round) AS round FROM production_quality_tasks WHERE version_id=? AND input_hash=?').get(versionId,snapshot.inputHash) as {round:number|null}
    const row=insertTask({versionId,kind:'review',parentId:options.parentId,round:Math.max(options.round||0,prior.round||0),snapshot,requestKey:key,...config,extra:{source:options.source||'manual'}})
    if(options.source!=='automatic') {
      const input=JSON.parse(row.input_json)
      input.extra={...input.extra,source:'manual'}
      row.input_json=JSON.stringify(input)
      client.prepare('UPDATE production_quality_tasks SET input_json=? WHERE id=?').run(row.input_json,row.id)
      const queued=getQueueJob('production_quality',row.id)
      if(queued)updateQueueJob(queued.id,{source:'manual'})
    }
    return enqueueRow(row,snapshot,config.configHash,reviewer)
  })()
}
export async function enqueueQualityOptimization(versionId:number,reviewId:number,options:{inputHash:string;issueIds:string[];configId?:number;model?:string},optimizer?:QualityOptimizer) {
  const parent=rowById(reviewId)
  if(!parent||parent.version_id!==versionId||parent.kind==='optimization'||parent.status!=='completed') throw new PrevisError('请选择已完成的有效评测')
  const snapshot=requireSnapshot(versionId,options.inputHash)
  if(parent.input_hash!==snapshot.inputHash) throw new PrevisError('评测已过期，请重新检查',409)
  if(parent.round>=2) throw new PrevisError('本轮已完成两次 AI 优化，请人工核对后重新规划')
  const result=JSON.parse(parent.result_json) as QualityResult
  if(!options.issueIds.length||new Set(options.issueIds).size!==options.issueIds.length||options.issueIds.some(id=>!result.issues.some(i=>i.id===id))) throw new PrevisError('选择的问题已变化，请重新选择')
  const issues=result.issues.filter(i=>options.issueIds.includes(i.id))
  const selectedIds=[...new Set(issues.flatMap(i=>i.panelIds.length?i.panelIds:snapshot.input.panels.map(p=>p.id)))]
  const config=await modelConfig(options.configId||parent.config_id,options.model||parent.model)
  requireSnapshot(versionId,snapshot.inputHash)
  const key=hashContent({kind:'optimization',hash:snapshot.inputHash,parentId:reviewId,issues:[...options.issueIds].sort(),configId:config.configId,model:config.model,configHash:config.configHash})
  return client.transaction(()=>{
    const row=insertTask({versionId,kind:'optimization',parentId:reviewId,round:parent.round+1,snapshot,requestKey:key,...config,extra:{issues,selectedIds,source:'manual'}})
    return enqueueRow(row,snapshot,config.configHash,optimizer)
  })()
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
    if(options.queueJobId&&getQueueJobById(options.queueJobId)?.status!=='processing') throw new PrevisError('任务已取消')
    if(options.queueJobId) updateQueueJob(options.queueJobId,{submitted:true,phase:'upstream'})
    return agent.generate([{role:'user',content:JSON.stringify(input)}],{maxSteps:1})
  },()=>{if(options.queueJobId)updateQueueJob(options.queueJobId,{submitted:false,phase:'retry_wait'})})
  if(options.queueJobId)updateQueueJob(options.queueJobId,{upstreamDone:true,phase:'saving'})
  return parseJson(response.text)
}
async function executeQuality(job:QueueJob):Promise<QueueOutcome> {
  const row=rowById(job.ownerId)
  if(!row)return{status:'failed',error:'质检任务不存在'}
  if(row.status==='completed'&&row.result_json)return{status:'completed'}
  if(job.upstreamDone) {
    const error='模型请求已结束，但结果未完成保存。请人工重试；不会自动重复调用模型'
    client.prepare("UPDATE production_quality_tasks SET status='failed',error=?,finished_at=? WHERE id=?").run(error,stamp(),row.id)
    return{status:'failed',error}
  }
  if(job.submitted&&!job.upstreamDone)return{status:'needs_confirmation',error:'模型请求曾提交，请核对服务商记录后再重试'}
  try {
    const snapshot=JSON.parse(row.input_json) as Snapshot&{extra:any}
    requireSnapshot(row.version_id,row.input_hash)
    const config=await getConfigById(row.config_id)
    if(!config||hashContent(config)!==JSON.parse(job.snapshotJson).configHash)throw new PrevisError('模型配置已变化，请重新提交')
    if(getQueueJobById(job.id)?.status!=='processing')return{status:'failed',error:'任务已取消'}
    client.prepare("UPDATE production_quality_tasks SET status='processing',started_at=?,error=NULL WHERE id=?").run(stamp(),row.id)
    const input=row.kind==='optimization'?{...snapshot.input,...snapshot.extra}:{...snapshot.input,rules:evaluateProductionRules(snapshot.input)}
    const runner=injected.get(row.id)
    if(runner)updateQueueJob(job.id,{submitted:true,phase:'upstream'})
    const raw=await (runner?runner(input,{configId:row.config_id,model:row.model,queueJobId:job.id}):runModel(row.kind,input,{configId:row.config_id,model:row.model,queueJobId:job.id}))
    updateQueueJob(job.id,{upstreamDone:true,phase:'saving'})
    requireSnapshot(row.version_id,row.input_hash)
    let result:unknown
    if(row.kind==='optimization') {
      const candidate=optimizationSchema.parse(raw)
      validateQualityEdits(snapshot.input,snapshot.extra.selectedIds,candidate.edits)
      const overrides=Object.fromEntries(candidate.edits.map(e=>[e.panelId,{description:e.description,...(e.atmosphere!==undefined?{atmosphere:e.atmosphere}:{})}])) as ProductionOverrides
      const preview=previewProductionRepair(row.version_id,{revision:snapshot.revision,panelIds:candidate.edits.map(e=>e.panelId),maxSeconds:15},overrides)
      if(preview.proposals.some(p=>p.error))throw new PrevisError('优化后的对白无法安全安排时长，请核对描述')
      result={...candidate,preview}
    } else result=mergeProductionReview(snapshot.input,reviewSchema.parse(raw))
    client.prepare("UPDATE production_quality_tasks SET status='completed',result_json=?,error=NULL,finished_at=? WHERE id=?").run(JSON.stringify(result),stamp(),row.id)
    injected.delete(row.id)
    return{status:'completed'}
  } catch(error:any) {
    const latest=getQueueJobById(job.id)!
    const status=httpErrorStatus(error)
    const rejected=Number.isInteger(status)&&status!>=400&&status!<500&&status!==408
    if(latest.submitted&&rejected) updateQueueJob(job.id,{upstreamDone:true})
    const uncertain=latest.submitted&&!latest.upstreamDone&&!rejected
    const message=error.message||'分镜质检失败'
    client.prepare('UPDATE production_quality_tasks SET status=?,error=?,finished_at=? WHERE id=?').run(uncertain?'processing':'failed',message,uncertain?null:stamp(),row.id)
    return{status:uncertain?'needs_confirmation':'failed',error:message}
  }
}
registerQueueExecutor('production_quality',{execute:executeQuality,recover:executeQuality,
  onCancel(job){injected.delete(job.ownerId);client.prepare("UPDATE production_quality_tasks SET status='cancelled',finished_at=? WHERE id=?").run(stamp(),job.ownerId)},
  onRetry(job){const row=rowById(job.ownerId)!;requireSnapshot(row.version_id,row.input_hash);updateQueueJob(job.id,{submitted:false,upstreamDone:false});client.prepare("UPDATE production_quality_tasks SET status='pending',error=NULL,finished_at=NULL WHERE id=?").run(row.id)},
  onRequeue(job){client.prepare("UPDATE production_quality_tasks SET status='pending',error=NULL WHERE id=?").run(job.ownerId)},
  onReconcile(job){client.prepare("UPDATE production_quality_tasks SET status='failed',error='已核对上游状态，可重试',finished_at=? WHERE id=?").run(stamp(),job.ownerId)},
})
export async function applyQualityOptimization(versionId:number,taskId:number,options:{inputHash:string}) {
  const row=rowById(taskId)
  if(!row||row.version_id!==versionId||row.kind!=='optimization'||row.status!=='completed')throw new PrevisError('没有可采用的优化候选')
  if(options.inputHash!==row.input_hash)throw new PrevisError('候选输入不匹配，请重新预览',409)
  if(row.applied_version_id)return getVersion(row.applied_version_id)
  requireSnapshot(versionId,row.input_hash)
  const candidate=optimizationSchema.passthrough().parse(JSON.parse(row.result_json)), snapshot=JSON.parse(row.input_json) as Snapshot&{extra:any}
  validateQualityEdits(snapshot.input,snapshot.extra.selectedIds,candidate.edits)
  const result=JSON.parse(row.result_json), overrides=Object.fromEntries(candidate.edits.map(e=>[e.panelId,{description:e.description,...(e.atmosphere!==undefined?{atmosphere:e.atmosphere}:{})}])) as ProductionOverrides
  const applied=client.transaction(()=>{
    const version=applyProductionRepair(versionId,{revision:snapshot.revision,panelIds:candidate.edits.map(e=>e.panelId),maxSeconds:15,inputHash:result.preview.inputHash},overrides)
    client.prepare('UPDATE production_quality_tasks SET applied_version_id=? WHERE id=?').run(version.id,row.id)
    const next=productionQualitySnapshot(version.id), rules=evaluateProductionRules(next.input)
    insertTask({versionId:version.id,kind:'rules',parentId:row.id,round:row.round,snapshot:next,requestKey:hashContent({kind:'rules',hash:next.inputHash}),result:rules})
    return version
  })()
  if(readEvaluationSettings().enabled) {
    try {await enqueueQualityReview(applied.id,{revision:applied.revision,configId:row.config_id,model:row.model,source:'automatic',parentId:row.id,round:row.round})}
    catch(error:any){console.error('优化后的 AI 复评未提交:',error.message)}
  }
  return applied
}
