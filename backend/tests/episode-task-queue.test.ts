import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
process.env.SQLITE_PATH = path.join(mkdtempSync(path.join(tmpdir(),'episode-queue-')),'db.sqlite3')
const {db,schema}=await import('../src/db/index.js')
const queue=await import('../src/services/task-queue.js')
const settings=await import('../src/services/task-queue-settings.js')
const ts=new Date().toISOString()
await db.insert(schema.dramas).values({id:1,title:'test',createdAt:ts,updatedAt:ts}).run()
await db.insert(schema.episodes).values({id:1,dramaId:1,episodeNumber:1,title:'test',createdAt:ts,updatedAt:ts}).run()
await db.insert(schema.storyboards).values({id:1,episodeId:1,storyboardNumber:1,createdAt:ts,updatedAt:ts}).run()
const taskId=Number((await db.insert(schema.sysTask).values({type:'image',dramaId:1,storyboardId:1,status:'pending',prompt:'mock',createdAt:ts,updatedAt:ts}).run()).lastInsertRowid)
const mergeId=Number((await db.insert(schema.videoMerges).values({episodeId:1,dramaId:1,provider:'ffmpeg',model:'ffmpeg',status:'pending',createdAt:ts}).run()).lastInsertRowid)
settings.saveProductionSettings({...(await settings.readProductionSettings()),paused:true})
const taskJob=await queue.enqueueQueueJob({ownerType:'sys_task',ownerId:taskId,kind:'image',projectId:1,inputHash:'mock'})
const mergeJob=await queue.enqueueQueueJob({ownerType:'video_merge',ownerId:mergeId,kind:'local',projectId:1,inputHash:'mock'})
test('episode task drawer receives queue metadata for both generation and merge records',async()=>{
 const {default:app}=await import('../src/routes/episodes.js')
 const response=await app.request('/1/generation-tasks')
 assert.equal(response.status,200)
 const {data}=await response.json() as any
 assert.equal(data.tasks[0].queueJobId,taskJob)
 assert.equal(data.tasks[0].canCancel,true)
 assert.equal(data.tasks[0].queueReason,'制作队列已暂停')
 assert.equal(data.tasks[0].storyboard_id,1)
 assert.equal(data.merges[0].queueJobId,mergeJob)
 assert.equal(data.merges[0].canCancel,true)
})
