import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import quality from '../../extension/src/backend/features/generation/card-quality.js';
import provider from '../../extension/src/backend/provider/provider-transport.js';
import task from '../../extension/src/harness/skills/definitions/concept-card/task.js';
const args=process.argv.slice(2), arg=name=>args.includes(name)?args[args.indexOf(name)+1]:null;
if(!arg('--config')||!arg('--out')) throw new Error('需要本机 --config 与新的 --out');
const config=provider.normalizeModelConfig(JSON.parse(await readFile(resolve(arg('--config')),'utf8')));
const cases=JSON.parse(await readFile(arg('--cases')||'extension/tests/fixtures/semantic-audit-cases.json','utf8'));
const selected=arg('--only')?cases.filter(c=>new RegExp(arg('--only')).test(c.id)):cases;
if(!selected.length) throw new Error('没有匹配的样本');
const out=resolve(arg('--out')); await mkdir(out,{recursive:true});
const file=join(out,'results.json');
if(args.includes('--generate')&&args.includes('--repair'))throw new Error('--generate 与 --repair 不能同时使用');
const report={promptVersion:task.version,thinkingPolicy:'non-thinking-v1',model:config.model,mode:args.includes('--generate')?'generate':args.includes('--repair')?'repair':'review',
 startedAt:new Date().toISOString(),budget:{maxRequests:60,maxTokens:150000,requests:0,tokens:0,missingUsage:0},cases:[],requests:[]};
const encode=()=>JSON.stringify(report,(_key,value)=>typeof value==='string'?value.replaceAll(config.apiKey,'[REDACTED]'):value,2)+'\n';
await writeFile(file,encode(),{flag:'wx'});
const checkpoint=()=>writeFile(file,encode());
const real=provider.createProviderTransport({timeoutMs:60000}); let caseId;
const transport={complete:async(settings,request)=>{
 if(report.budget.requests>=60||report.budget.tokens>=150000)throw Object.assign(new Error('预算已用尽'),{code:'EVAL_BUDGET_REACHED',sent:false});
 const body=request.messages.at(-1).content,payload=JSON.parse(Array.isArray(body)?body.find(p=>p.type==='text').text:body);
 const trace={caseId,operation:payload.operation};report.requests.push(trace);report.budget.requests++;await checkpoint();
 try {const result=await real.complete(settings,request);trace.response=result.content;trace.usage=result.provider.usage;trace.finishReason=result.finishReason;
  if(Number.isFinite(trace.usage?.totalTokens))report.budget.tokens+=trace.usage.totalTokens;else report.budget.missingUsage++;
  return result;
 }catch(error){trace.error=error.code||'REQUEST_FAILED';throw error;}finally{await checkpoint();}
}};
const service=quality.createQualityService({task,transport,getModelConfig:()=>config});
for(const sample of selected){
 caseId=sample.id; const before=JSON.stringify(sample.candidate);
 // Exercise the existing resume path with a frozen draft; completed user data
 // and original recorded results remain untouched.
 const pending=report.mode==='repair'?{...sample.candidate,generation:{resume:{independentReview:true,repairUsed:false,reviewed:false,reviewIssues:[],imageObservation:sample.candidate.generation?.imageObservation||null}}}:null;
 const output=report.mode==='generate'?await service.run(sample.context):report.mode==='repair'?await service.run(sample.context,pending,'resume'):await service.run(sample.context,sample.candidate,'review');
 const unchanged=before===JSON.stringify(sample.candidate);
 const accepted=report.mode==='review'&&sample.expected!=='review'?(sample.expected==='ready'?output.status==='ready':output.status!=='ready'):null;
 report.cases.push({...sample,output,inputUnchanged:unchanged,statusExpectationMet:accepted});await checkpoint();
 process.stdout.write(`${caseId}: ${output.status}; ${output.quality.issues.map(i=>i.code).join(',')}; requests=${report.budget.requests}; tokens=${report.budget.tokens}\n`);
}
report.finishedAt=new Date().toISOString();await checkpoint();
