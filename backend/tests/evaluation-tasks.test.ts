import assert from 'node:assert/strict'
import {test} from 'node:test'
process.env.SQLITE_PATH=':memory:'
const {db,schema}=await import('../src/db/index.js')
const {createVersion}=await import('../src/services/previs.js')
const {checkProductionQuality}=await import('../src/services/production-quality.js')
const {listEvaluationTasks}=await import('../src/services/evaluation-tasks.js')
const stamp=new Date().toISOString()
db.insert(schema.dramas).values({id:1,title:'测试',createdAt:stamp,updatedAt:stamp}).run()
db.insert(schema.episodes).values({id:1,dramaId:1,episodeNumber:1,title:'测试',scriptContent:'小明：你好。',createdAt:stamp,updatedAt:stamp}).run()
db.insert(schema.storyboards).values({id:1,episodeId:1,storyboardNumber:1,title:'挥手',description:'【镜头1】小明挥手。小明：「你好。」',videoPrompt:'0-8秒：小明挥手。小明：「你好。」',duration:8,createdAt:stamp,updatedAt:stamp}).run()
const version=createVersion(1)
const rule=(await checkProductionQuality(version.id)).task
for(const [id,status]of [[1,'completed'],[2,'pending'],[3,'failed']] as const){db.insert(schema.continuityReviews).values({id,versionId:version.id,fromGroupId:`from${id}`,toGroupId:`to${id}`,inputHash:`hash${id}`,configId:1,model:'mock',status,createdAt:stamp}).run()}
test('mixed evaluation list keeps colliding numeric IDs and filters types/status with stable totals',()=>{
 const all=listEvaluationTasks(version.id,{pageSize:2})
 assert.equal(all.total,4);assert.equal(all.items.length,2);assert.equal(all.summary.active,1);assert.equal(all.summary.completed,2)
 const planning=listEvaluationTasks(version.id,{type:'planning'}),continuity=listEvaluationTasks(version.id,{type:'continuity'})
 assert.equal(planning.total,1);assert.equal(planning.items[0].id,rule.id);assert.equal(continuity.total,3)
 assert.equal(listEvaluationTasks(version.id,{status:'active'}).total,1)
 assert.equal(listEvaluationTasks(version.id,{status:'failed'}).items[0].type,'continuity')
 assert.equal(listEvaluationTasks(version.id,{keyword:'分镜规划质量'}).items[0].type,'planning')
 assert.equal(listEvaluationTasks(version.id,{page:2,pageSize:2}).items.length,2)
})
test('evaluation API validates pagination and task ownership',async()=>{
 const {default:route}=await import('../src/routes/previs.js')
 assert.equal((await route.request(`/animatic-versions/${version.id}/evaluation-tasks?type=planning`)).status,200)
 assert.equal((await route.request(`/animatic-versions/${version.id}/evaluation-tasks?type=unknown`)).status,400)
 assert.equal((await route.request(`/animatic-versions/${version.id}/production-quality/tasks/999999`)).status,404)
 assert.equal((await route.request(`/animatic-versions/999999/production-quality/tasks/${rule.id}`)).status,404)
})
