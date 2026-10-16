import assert from 'node:assert/strict'
import {test} from 'node:test'
import {eq} from 'drizzle-orm'
process.env.SQLITE_PATH=':memory:'
const {db,schema}=await import('../src/db/index.js')
const {storyboardTools,getStoryboardBreakdownReceipt}=await import('../src/agents/tools/storyboard-tools.js') as any
const {buildAgentRequestContext}=await import('../src/agents/context.js')
const quality=await import('../src/services/production-quality-breakdown.js').catch(()=>null)
const settings=await import('../src/services/task-queue-settings.js')
const stamp=new Date().toISOString()
function seed(script='小明：你好。\n小红：再见。'){
 const dramaId=Number(db.insert(schema.dramas).values({title:'整集质检',createdAt:stamp,updatedAt:stamp}).run().lastInsertRowid)
 const episodeId=Number(db.insert(schema.episodes).values({dramaId,episodeNumber:1,title:'第1集',scriptContent:script,createdAt:stamp,updatedAt:stamp}).run().lastInsertRowid)
 const rc=buildAgentRequestContext({episodeId,dramaId})
 return {dramaId,episodeId,rc}
}
async function save(f:ReturnType<typeof seed>,number:number,description:string,video_prompt?:string){
 return (storyboardTools.saveStoryboards as any).execute({replace_existing:number===1,storyboards:[{shot_number:number,description,duration:8,...(video_prompt?{video_prompt}:{})}]},{requestContext:f.rc})
}
test('a text-only breakdown cannot claim successful completion without an owned write receipt',async()=>{
 assert.ok(quality)
 const f=seed()
 await assert.rejects(()=>quality.finishStoryboardBreakdown(f.episodeId,{requestContext:f.rc}),/未保存|未完成/)
})
test('completed breakdown checks the entire script and gives AI one actionable correction opportunity',async()=>{
 assert.ok(quality)
 const f=seed();await save(f,1,'【镜头1】小明挥手。小明：「你好。」','0-8秒：小明挥手。小明：「你好。」')
 assert.ok(getStoryboardBreakdownReceipt(f.rc)?.length)
 let calls=0
 const result=await quality.finishStoryboardBreakdown(f.episodeId,{requestContext:f.rc,repair:async(issues:any[])=>{
   calls++;assert.ok(issues.some(i=>i.rule==='script_dialogue_missing'))
   await save(f,2,'【镜头1】小红转身挥手。小红：「再见。」','0-8秒：小红转身挥手。小红：「再见。」')
 }})
 assert.equal(calls,1);assert.equal(result.status,'passed')
 assert.equal(result.correctionAttempts,1);assert.ok(result.taskId)
})
test('unfixed coverage is reported instead of saying the breakdown passed or retrying indefinitely',async()=>{
 assert.ok(quality)
 const f=seed();await save(f,1,'【镜头1】小明挥手。小明：「你好。」','0-8秒：小明挥手。小明：「你好。」')
 let calls=0
 const result=await quality.finishStoryboardBreakdown(f.episodeId,{requestContext:f.rc,repair:async()=>{calls++}})
 assert.equal(calls,1);assert.equal(result.status,'needs_attention');assert.ok(result.issueCount>0)
})
test('missing prompts persist a free check and defer automatic review until supplementation settles',async()=>{
 assert.ok(quality)
 const f=seed('小明：你好。');await save(f,1,'【镜头1】小明挥手。小明：「你好。」')
 settings.saveEvaluationSettings({...settings.readEvaluationSettings(),enabled:true})
 let result=await quality.finishStoryboardBreakdown(f.episodeId,{requestContext:f.rc})
 assert.equal(result.status,'awaiting_prompts');assert.equal(result.missingPrompts,1)
 assert.equal(db.$client.prepare("SELECT count(*) n FROM production_quality_tasks WHERE kind='review'").get().n,0)
 const panel=db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId,f.episodeId)).get()!
 db.update(schema.storyboards).set({videoPrompt:'0-8秒：小明挥手。小明：「你好。」'}).where(eq(schema.storyboards.id,panel.id)).run()
 result=await quality.finalizeEpisodeQuality(f.episodeId)
 assert.equal(result.missingPrompts,0);assert.equal(result.status,'passed')
 // Missing model settings cannot erase the completed free report.
 assert.ok(result.taskId);assert.match(result.aiError||'',/模型/)
 settings.saveEvaluationSettings({...settings.readEvaluationSettings(),enabled:false})
})
test('a correction cannot clear all previously saved storyboards',async()=>{
 assert.ok(quality)
 const f=seed();await save(f,1,'【镜头1】小明挥手。小明：「你好。」','0-8秒：小明挥手。小明：「你好。」')
 const before=db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId,f.episodeId)).all()
 const result=await quality.finishStoryboardBreakdown(f.episodeId,{requestContext:f.rc,repair:async()=>{await save(f,1,'【镜头1】小明站在门外。')}})
 assert.match(result.correctionError||'',/替换|清空/)
 const project=(rows:any[])=>rows.map(({id,description,duration,videoPrompt})=>({id,description,duration,videoPrompt}))
 assert.deepEqual(project(db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId,f.episodeId)).all()),project(before))
})
test('agent endpoint returns whole-episode findings, not an unconditional done toast',async t=>{
 assert.ok(quality)
 const {mastra}=await import('../src/mastra/index.js'),{default:route}=await import('../src/routes/agent.js')
 const f=seed();let calls=0
 // The tool must use the exact endpoint request context, not the fixture's.
 t.mock.method(mastra,'getAgent',()=>({generate:async(_messages:any,options:any)=>{
   calls++
   if(calls===1)await(storyboardTools.saveStoryboards as any).execute({replace_existing:true,storyboards:[{shot_number:1,description:'【镜头1】小明挥手。小明：「你好。」',video_prompt:'0-8秒：小明挥手。小明：「你好。」',duration:8}]},{requestContext:options.requestContext})
   return{text:'完成',toolCalls:[],toolResults:[]}
 }}) as any)
 const response=await route.request('/storyboard_breaker/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'拆分整集',episode_id:f.episodeId,drama_id:f.dramaId})})
 const body=await response.json() as any
 assert.equal(response.status,200);assert.equal(body.data.quality.status,'needs_attention');assert.equal(calls,2)
})
