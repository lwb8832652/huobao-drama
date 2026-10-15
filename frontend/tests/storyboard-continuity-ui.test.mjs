import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as vue from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
function evaluate(source, deps = {}) {
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(source.replaceAll('import.meta.client','false'), { compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022} }).outputText,
    {module,exports:module.exports,require:n=>{assert.ok(n in deps,n);return deps[n]},setTimeout,clearTimeout,setInterval,clearInterval,URLSearchParams})
  return module.exports
}
const shotPlanning=evaluate(read('../../backend/src/services/shot-planning.ts'))
const domain=evaluate(read('../../backend/src/services/previs-domain.ts'),{'./shot-planning.js':shotPlanning})
const contract=evaluate(read('../../backend/src/services/previs-frame-contract.ts'))
const reference=evaluate(read('../../backend/src/services/previs-video-reference-domain.ts'),{'./previs-domain.js':domain})
const previs=evaluate(read('../app/composables/usePrevis.ts'),{vue,'vue-sonner':{toast:{}},'~/composables/useApi':{withNetworkRetry:fn=>fn()},'../../../backend/src/services/previs-domain':domain,'../../../backend/src/services/previs-frame-contract':contract,'../../../backend/src/services/previs-video-reference-domain':reference})
const panel={id:7,title:'动作',frames:[{id:'a',url:'/static/a.png'},{id:'b',url:'/static/b.png'}]}
test('endpoint readiness ignores missing sheet but requires complete frames and loaded model capability',()=>{
 assert.equal(previs.videoContinuityReadiness([panel],'auto',{firstLast:true,reference:true},'contact_sheet',9,[]).actual,'first_last')
 assert.equal(previs.videoContinuityReadiness([panel],'auto',undefined,'individual',9,[]).ready,false)
 assert.equal(previs.videoContinuityReadiness([{...panel,frames:[{id:'a',url:''},{id:'b',url:'/b'}]}],'auto',{firstLast:true,reference:true},'individual',9,[]).ready,false)
})
test('reference-only auto fallback and explicit endpoint rejection match chosen model and scope',()=>{
 const caps={firstLast:false,reference:true,reason:'仅支持参考图'}
 const fallback=previs.videoContinuityReadiness([panel],'auto',caps,'individual',9,[])
 assert.equal(fallback.actual,'reference');assert.equal(fallback.ready,true);assert.match(fallback.fallbackReason,/参考/)
 assert.equal(previs.videoContinuityReadiness([panel],'first_last',caps,'individual',9,[]).ready,false)
 assert.equal(previs.videoContinuityReadiness([panel],'first_last',{firstLast:true,reference:true},'individual',9,[],'group').ready,false)
 assert.equal(previs.videoContinuityReadiness([panel],'reference',{firstLast:true,reference:true},'contact_sheet',9,[]).ready,false)
})
test('count choice stays local until explicit replan and actual drafts apply; details start collapsed',()=>{
 const descriptor=parse(read('../app/components/previs/FramePlanDialog.vue')).descriptor
 const script=compileScript(descriptor,{id:'planning-continuity'})
 const component=evaluate(script.content,{vue:{...vue,useId:()=> 'plan',onMounted(){},onBeforeUnmount(){},onUnmounted(){}},'lucide-vue-next':{},'~/composables/usePrevis':contract}).default
 const events=[],plans=[{panelId:7,frames:[{title:'首',prompt:'抬手静态',offsetMs:0},{title:'尾',prompt:'手已抬起',offsetMs:1000}]}]
 const props=vue.reactive({plans,count:2,editable:true,busy:false})
 const scope=vue.effectScope();const s=scope.run(()=>component.setup(props,{expose(){},emit:(event,...args)=>events.push({event,args})}))
 s.requestedCount.value=4;assert.equal(events.length,0);assert.equal(s.totalFrames.value,2)
 s.replan();assert.equal(events[0].event,'recount');assert.equal(events[0].args[0],4)
 s.apply();assert.equal(events[1].args[0][0].frames.length,2)
 props.editable=false;s.replan();s.apply();assert.equal(events.length,2)
 assert.match(descriptor.template.content,/<details class="plan-frame-details">/)
 const compiled=compileTemplate({source:descriptor.template.content,filename:'FramePlanDialog.vue',id:'planning-continuity',compilerOptions:{bindingMetadata:script.bindings}})
 assert.deepEqual(compiled.errors,[]);scope.stop()
})
