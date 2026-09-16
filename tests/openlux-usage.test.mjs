import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createUsageReporter, parseUsage, providerHostname, responseStatus } from '../server/openlux-usage.ts';

test('actual hostname excludes similarly named hosts and preserves zero/missing tokens', () => {
  assert.equal(providerHostname('https://api.openlux.ai.evil.test/v1'), 'api.openlux.ai.evil.test');
  assert.equal(parseUsage({}).inputTokens, null);
  assert.deepEqual(parseUsage({usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}), {
    tokenBasis:'reported',inputTokens:0,outputTokens:0,totalTokens:0,cachedInputTokens:null,cacheWriteTokens:null,reasoningTokens:null,imageInputTokens:null,
  });
});

test('parses cache, image, reasoning and Anthropic exclusive cache buckets once', () => {
  const openai = parseUsage({usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:30,image_tokens:12},output_tokens_details:{reasoning_tokens:5}}});
  assert.equal(openai.totalTokens,120); assert.equal(openai.imageInputTokens,12); assert.equal(openai.cachedInputTokens,30);
  const anthropic = parseUsage({usage:{input_tokens:10,output_tokens:4,cache_read_input_tokens:20,cache_creation_input_tokens:30}});
  assert.equal(anthropic.inputTokens,60); assert.equal(anthropic.totalTokens,64);
  const gemini = parseUsage({usageMetadata:{promptTokenCount:100,candidatesTokenCount:10,thoughtsTokenCount:4,promptTokensDetails:[{modality:'IMAGE',tokenCount:25}]}});
  assert.equal(gemini.totalTokens,114); assert.equal(gemini.imageInputTokens,25);
  assert.equal(parseUsage({usage:{prompt_tokens:7}},true).outputTokens,0);
});

test('durable metadata-only retry retains UUID and verified user; actual attempts differ', async () => {
  const dir = await mkdtemp(join(tmpdir(),'usage-test-'));
  let online=false; const requests=[];
  const reporter=createUsageReporter({tool:'xiaoshou',getMainAppUrl:()=> 'https://main.test', secret:()=> 'test-secret',outboxDir:()=>dir,fetchImpl:async (_url,init)=>{
    const event=JSON.parse(init.body); requests.push(event);
    assert.equal(init.headers['x-usage-tool'],'xiaoshou');
    return new Response('{"success":true}',{status:online?200:503});
  }});
  try {
    assert.equal(reporter.enabled('https://yunwu.ai/v1'),false);
    assert.equal(await reporter.begin({url:'https://yunwu.ai/v1',model:'openlux-label',userId:'employee'}),null);
    assert.equal(await reporter.begin({url:'https://api.openlux.ai/v1',model:'m'}),null);
    const call=await reporter.begin({url:'https://api.openlux.ai/v1?key=private',model:'m',userId:'employee'});
    await call.finish('completed',{usage:{prompt_tokens:8,completion_tokens:2},prompt:'private',apiKey:'private'});
    assert.ok((await readdir(dir)).length);
    const disk=(await Promise.all((await readdir(dir)).map(f=>readFile(join(dir,f),'utf8')))).join('');
    assert.ok(!disk.includes('private')); assert.ok(!disk.includes('test-secret'));
    online=true; await reporter.flush(); assert.equal((await readdir(dir)).length,0);
    const final=requests.findLast(r=>r.status==='completed');
    assert.equal(final.requestId,call.requestId); assert.equal(final.userId,'employee'); assert.equal(final.totalTokens,10);
    const second=await reporter.begin({url:'https://api.openlux.ai/v1',model:'m',userId:'employee'});
    assert.notEqual(second.requestId,call.requestId);
    await second.finish('failed');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('async acceptance remains pending and terminal state cannot be overwritten', async () => {
  const dir=await mkdtemp(join(tmpdir(),'usage-pending-')); const events=[];
  const reporter=createUsageReporter({tool:'test',getMainAppUrl:()=> 'https://main.test',secret:()=> 'secret',outboxDir:()=>dir,fetchImpl:async(_url,init)=>{events.push(JSON.parse(init.body));return Response.json({success:true});}});
  try {
    const call=await reporter.begin({url:'https://api.openlux.ai/v1',model:'m',userId:'u'});
    await call.finish('pending'); assert.equal(events.filter(e=>e.status==='completed').length,0);
    await call.finish('interrupted'); await call.finish('completed',{usage:{prompt_tokens:10}});
    assert.equal(events.at(-1).status,'interrupted');
  } finally {await rm(dir,{recursive:true,force:true});}
});


test('accepted asynchronous work is pending until a terminal upstream response', () => {
 assert.equal(responseStatus(202, {task_id:'job'}), 'pending');
 assert.equal(responseStatus(200, {data:{task_id:'job',status:'processing'}}), 'pending');
 assert.equal(responseStatus(200, {data:[{url:'private'}]}), 'completed');
 assert.equal(responseStatus(200, {error:{message:'failed'}}), 'failed');
});


test('normalizes totals to known input plus output and preserves incomplete Gemini output', () => {
  assert.equal(parseUsage({usage:{prompt_tokens:5,completion_tokens:2,total_tokens:999}}).totalTokens,7);
  assert.equal(parseUsage({usageMetadata:{promptTokenCount:5,thoughtsTokenCount:2}}).outputTokens,null);
});

test('only an explicit successful JSON acknowledgement removes durable reports', async () => {
  const directory=await mkdtemp(join(tmpdir(),'usage-ack-'));
  let acknowledgement='html';
  const reporter=createUsageReporter({tool:'xiaoshou',getMainAppUrl:()=> 'https://main.test',secret:()=> 'test',outboxDir:()=>directory,fetchImpl:async()=>acknowledgement==='html'?new Response('<html>login</html>'):Response.json({success:acknowledgement==='success'})});
  try {
    const call=await reporter.begin({url:'https://api.openlux.ai/v1',model:'m',userId:'employee'});
    await call.finish('completed');
    assert.equal((await readdir(directory)).length,2);
    acknowledgement='false';await reporter.flush();assert.equal((await readdir(directory)).length,2);
    acknowledgement='success';await reporter.flush();assert.equal((await readdir(directory)).length,0);
  } finally {await rm(directory,{recursive:true,force:true});}
});
