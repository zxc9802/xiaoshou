import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateJsonText } from '../server/model/generativeClient.ts';
import { createKnowledgeEmbedding } from '../server/model/embeddings.ts';
import { runWithMainAppBillingUser } from '../server/mainAppBilling.ts';

test('sales text and embeddings report actual URL, counts and SSO employee', async () => {
 const dir=await mkdtemp(join(tmpdir(),'sales-usage-')); const oldFetch=globalThis.fetch,oldEnv={...process.env}; const reports=[],bills=[];
 Object.assign(process.env,{USAGE_MONITOR_INTERNAL_SECRET:'test',USAGE_MONITOR_OUTBOX_DIR:dir,MAIN_APP_URL:'https://main.test',MAIN_APP_SSO_CLIENT_SECRET:'test'});
 globalThis.fetch=async (url,init)=>{
  if(String(url).endsWith('/api/sso/usage')) {reports.push(JSON.parse(init.body));return Response.json({success:true});}
  if(String(url).endsWith('/api/sso/billing')) {bills.push(JSON.parse(init.body));return Response.json({success:true});}
  if(String(url).includes('embeddings')) return Response.json({data:[{embedding:[.1,.2]}],usage:{prompt_tokens:7,total_tokens:7}});
  return Response.json({choices:[{message:{content:'{}'}}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}});
 };
 const config={modelDriver:'openai_compatible',modelBaseUrl:'https://api.openlux.ai/v1',modelApiKey:'private',modelName:'m',embeddingModelName:'embed',embeddingDimensions:2};
 try {
  await runWithMainAppBillingUser('verified-employee',async()=>{
   await generateJsonText(config,{prompt:'private',model:'m'});
   await createKnowledgeEmbedding('private',config);
  });
  const terminal=reports.filter(e=>e.status==='completed'); assert.equal(terminal.length,2);
  assert.equal(terminal[0].inputTokens,0); assert.equal(terminal[1].outputTokens,0); assert.equal(terminal[1].inputTokens,7);
  assert.ok(terminal.every(e=>e.userId==='verified-employee'&&e.provider==='api.openlux.ai'));
  assert.ok(bills.every(e=>e.usageReportedSeparately===true));
  reports.length=0;
  await runWithMainAppBillingUser('verified-employee',()=>createKnowledgeEmbedding('x',{...config,embeddingBaseUrl:'https://other.test/v1'}));
  assert.equal(reports.length,0);
 } finally {globalThis.fetch=oldFetch;process.env=oldEnv;await rm(dir,{recursive:true,force:true});}
});
