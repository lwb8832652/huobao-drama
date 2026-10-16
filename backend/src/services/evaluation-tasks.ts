import { z } from 'zod'
import { listContinuityReviewTasks } from './continuity-review.js'
import { listProductionQualityTasks } from './production-quality.js'

const pagination=z.object({page:z.coerce.number().int().min(1).max(1000000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20),
  status:z.enum(['all','active','completed','failed']).default('all'),type:z.enum(['all','planning','continuity']).default('all'),keyword:z.string().trim().max(200).default('')})
export function listEvaluationTasks(versionId:number,query:unknown={}) {
  const {page,pageSize,status,type,keyword}=pagination.parse(query)
  const rows=[...(type==='planning'?[]:listContinuityReviewTasks(versionId,{},true).items),...(type==='continuity'?[]:listProductionQualityTasks(versionId))]
    .sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id-a.id)
  const summary={total:rows.length,active:rows.filter(i=>['pending','processing'].includes(i.status)).length,
    pending:rows.filter(i=>i.status==='pending').length,processing:rows.filter(i=>i.status==='processing').length,
    completed:rows.filter(i=>i.status==='completed').length,failed:rows.filter(i=>i.status==='failed').length}
  const text=keyword.toLowerCase()
  const items=rows.filter(i=>(status==='all'||(status==='active'?['pending','processing'].includes(i.status):i.status===status))
    &&(!text||JSON.stringify([i.id,i.type,i.model,i.result?.summary,'fromGroupTitle' in i?i.fromGroupTitle:'分镜规划质量']).toLowerCase().includes(text)))
  return{type,page,pageSize,total:items.length,summary,activeCount:summary.active,lowScore:0,items:items.slice((page-1)*pageSize,page*pageSize)}
}
