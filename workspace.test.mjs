import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import JSZip from 'jszip';
import { createArtifacts } from './artifacts.mjs';
import { createReview, git } from './review.mjs';
import { createJobs } from './jobs.mjs';
import { createIntegrations, serviceURL } from './integrations.mjs';
import { generateImage, subscriptionImageArgs, imageEnvironment } from './image-service.mjs';
import { ADAPTERS } from './engines.mjs';
const temp=(t)=>{const dir=mkdtempSync(join(tmpdir(),'power-workspace-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');
async function repo(t){const home=temp(t),dir=join(home,'repo');mkdirSync(dir);await git(dir,['init']);await git(dir,['config','user.email','test@example.invalid']);await git(dir,['config','user.name','Power Test']);writeFileSync(join(dir,'a.txt'),'before\n');await git(dir,['add','.']);await git(dir,['commit','-m','initial']);return {home,dir};}

test('Ollama adapter is removed; image generation explicitly uses subscription authentication',()=>{
  assert.equal(ADAPTERS.ollama,undefined);
  const args=subscriptionImageArgs('/tmp/output','blue square');assert.ok(args.includes('forced_login_method="chatgpt"'));assert.ok(args.includes('model_provider="openai"'));
  process.env.OPENAI_API_KEY='test-private';assert.equal(imageEnvironment().OPENAI_API_KEY,undefined);delete process.env.OPENAI_API_KEY;
});

test('artifacts enforce path boundaries and preview office/text documents without executing markup',async t=>{
  const home=temp(t),uploads=join(home,'uploads');mkdirSync(uploads);const a=createArtifacts(uploads);
  writeFileSync(join(uploads,'test.txt'),'<script>bad()</script>');const txt=await a.preview('test.txt');assert.match(txt.html,/&lt;script&gt;/);
  const saved=a.saveCopy('test.txt','changed');assert.equal(readFileSync(a.fileFor(saved.id),'utf8'),'changed');assert.equal(readFileSync(a.fileFor('test.txt'),'utf8'),'<script>bad()</script>');
  writeFileSync(join(home,'private'),'secret');symlinkSync(join(home,'private'),join(uploads,'escape.txt'));assert.throws(()=>a.fileFor('escape.txt'));assert.throws(()=>a.fileFor('../private'));assert.ok(!a.list().some(f=>f.id==='escape.txt'));
  const zip=new JSZip();zip.file('word/document.xml','<w:document><w:p><w:r><w:t>&lt;hello&gt;</w:t></w:r></w:p></w:document>');writeFileSync(join(uploads,'sample.docx'),await zip.generateAsync({type:'nodebuffer'}));assert.match((await a.preview('sample.docx')).html,/&lt;hello&gt;/);
  const sheet=new JSZip();sheet.file('xl/sharedStrings.xml','<sst><si><t>Test Cell</t></si></sst>');sheet.file('xl/worksheets/sheet1.xml','<worksheet><sheetData><row r="1"><c r="B1" t="s"><v>0</v></c><c r="C1"><v>42</v></c></row></sheetData></worksheet>');writeFileSync(join(uploads,'sample.xlsx'),await sheet.generateAsync({type:'nodebuffer'}));const x=await a.preview('sample.xlsx');assert.match(x.html,/<td><\/td><td>Test Cell<\/td><td>42/);
  const slide=new JSZip();slide.file('ppt/slides/slide1.xml','<p:sld><a:p><a:r><a:t>Slide text</a:t></a:r></a:p></p:sld>');writeFileSync(join(uploads,'sample.pptx'),await slide.generateAsync({type:'nodebuffer'}));assert.match((await a.preview('sample.pptx')).html,/Slide text/);
});

test('review comments are tied to a diff version, preserve local changes, and validate PR links',async t=>{
  const {home,dir}=await repo(t);writeFileSync(join(dir,'a.txt'),'after\n');const r=createReview(home),s=await r.snapshot(dir);assert.match(s.diff,/\+after/);
  const c=await r.comment(dir,{version:s.version,file:'a.txt',line:1,text:'Check this'});assert.equal(c.resolved,false);await r.resolve(dir,c.id,true);assert.equal((await r.snapshot(dir)).comments[0].resolved,true);
  writeFileSync(join(dir,'a.txt'),'different\n');await assert.rejects(r.comment(dir,{version:s.version,file:'a.txt',line:1,text:'stale'}),/代码已变化/);
  await assert.rejects(r.attach(dir,'javascript:alert(1)'));assert.deepEqual(await r.attach(dir,'https://github.com/test/repo/pull/1'),['https://github.com/test/repo/pull/1']);
  assert.equal(readFileSync(join(dir,'a.txt'),'utf8'),'different\n');
});

test('parallel jobs execute concurrently in isolated worktrees, preserve changes and survive reload',async t=>{
  const {home,dir}=await repo(t);let active=0,peak=0;
  const j=createJobs({home,stop:()=>{},run:async(job)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,50));writeFileSync(join(job.dir,'a.txt'),job.prompt);active--;return {text:job.prompt};}});
  const made=await j.start({parent:'parent',dir,char:'test',tasks:[{prompt:'one'},{prompt:'two'}]});await j.wait('parent',undefined,10);assert.equal(peak,2);assert.ok(j.list().every(x=>x.status==='completed'));assert.equal(readFileSync(join(dir,'a.txt'),'utf8'),'before\n');
  assert.notEqual(j.list()[0].dir,j.list()[1].dir);await assert.rejects(j.removeWorktree(made[0].id));assert.equal(readFileSync(join(j.list()[0].dir,'a.txt'),'utf8'),'one');
  const again=createJobs({home,run:async()=>{},stop:()=>{}});assert.equal(again.list().length,2);assert.equal(again.list()[0].status,'completed');
});

test('queued and running jobs can be cancelled without starting queued work',async t=>{
  const home=temp(t);let finish,started=0,stopped=[];
  const j=createJobs({home,maxConcurrent:1,stop:id=>stopped.push(id),run:async(job,onThread)=>{started++;onThread('child');await new Promise(r=>finish=r);return {text:'late'};}});
  const made=await j.start({parent:'p',dir:home,char:'test',isolate:false,tasks:[{prompt:'one'},{prompt:'two'}]});j.cancel(made[1].id);j.cancel(made[0].id);finish();await new Promise(r=>setTimeout(r,10));assert.equal(started,1);assert.deepEqual(stopped,['child']);assert.ok(j.list().every(x=>x.status==='cancelled'));
});

test('MCP connection stores private credentials, lists tools and executes real stdio transport',async t=>{
  const home=temp(t),fixture=join(home,'mcp.mjs');const sdk=new URL('./node_modules/@modelcontextprotocol/sdk/dist/esm/server/',import.meta.url);
  writeFileSync(fixture,`import {McpServer} from ${JSON.stringify(new URL('mcp.js',sdk).href)};import {StdioServerTransport} from ${JSON.stringify(new URL('stdio.js',sdk).href)};const s=new McpServer({name:'fixture',version:'1'});s.registerTool('ping',{inputSchema:{},annotations:{readOnlyHint:true}},async()=>({content:[{type:'text',text:'pong'}]}));await s.connect(new StdioServerTransport());`);
  const i=createIntegrations({home});t.after(()=>i.close());await i.upsert({id:'test',name:'Local test',type:'stdio',command:process.execPath,args:[fixture],env:{FAKE_TOKEN:'private'}});
  assert.equal(statSync(join(home,'integrations.json')).mode & 0o777,0o600);assert.doesNotMatch(JSON.stringify(i.list()),/private/);assert.equal((await i.tools('test'))[0].name,'ping');assert.equal((await i.call('test','ping',{})).content[0].text,'pong');
  await i.upsert({id:'remote',name:'Remote',type:'http',url:'https://example.com/mcp',token:'secret'});assert.doesNotMatch(JSON.stringify(i.list()),/secret/);assert.throws(()=>serviceURL('http://example.com/mcp'));assert.throws(()=>serviceURL('https://a:b@example.com/'));await i.remove('remote');assert.equal(i.list().length,1);
});

test('subscription image adapter requires a real output and does not use API credentials',async t=>{
  const home=temp(t),bin=join(home,'codex');writeFileSync(bin,`#!/usr/bin/env node\nconst fs=require('fs');if(process.env.OPENAI_API_KEY)process.exit(3);fs.writeFileSync('result.png',Buffer.from('${png.toString('base64')}','base64'));console.log(JSON.stringify({type:'error',message:'Reconnecting: transient network failure'}));console.log(JSON.stringify({type:'turn.completed'}));`,{mode:0o755});
  const result=await generateImage({bin,outputDir:home,prompt:'test',status:async()=>({ready:true})});assert.ok(readFileSync(result.path).equals(png));
  writeFileSync(bin,'#!/usr/bin/env node\nconsole.log("done")\n',{mode:0o755});await assert.rejects(generateImage({bin,outputDir:home,prompt:'test',status:async()=>({ready:true})}),/没有保存/);
});

test('remote MCP OAuth uses PKCE/state, saves private tokens, and reconnects after login', async t=>{
  const home=temp(t);let base,registered,tokenRequests=0;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    const reply=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
    if(req.url==='/.well-known/oauth-protected-resource')return reply(200,{resource:base+'/mcp',authorization_servers:[base],scopes_supported:['read']});
    if(req.url==='/.well-known/oauth-authorization-server')return reply(200,{issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',registration_endpoint:base+'/register',response_types_supported:['code'],code_challenge_methods_supported:['S256'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none']});
    if(req.url==='/register'){registered=JSON.parse(raw);return reply(201,{...registered,client_id:'power-fixture'});}
    if(req.url==='/token'){tokenRequests++;const p=new URLSearchParams(raw);assert.ok(p.get('code_verifier'));return reply(200,{access_token:'oauth-private-fixture',token_type:'Bearer',expires_in:3600});}
    if(req.url==='/mcp'){
      if(req.headers.authorization!=='Bearer oauth-private-fixture'){res.writeHead(401,{'WWW-Authenticate':`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`});return res.end();}
      if(req.method!=='POST'){res.writeHead(405);return res.end();}
      const m=JSON.parse(raw);if(m.id===undefined){res.writeHead(202);return res.end();}
      return reply(200,{jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'oauth-fixture',version:'1'}}:{tools:[{name:'ping',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}});
    }
    reply(404,{});
  }).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
  const i=createIntegrations({home,callbackURL:base+'/callback'});t.after(async()=>{await i.close();server.close();});
  await i.upsert({id:'oauth',name:'OAuth fixture',type:'http',url:base+'/mcp'});
  await assert.rejects(i.tools('oauth'),/需要登录/);const u=new URL(i.list()[0].authorizationURL);assert.equal(u.origin,base);assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.ok(u.searchParams.get('state'));
  await assert.rejects(i.finishOAuth('wrong','code'),/state/);assert.equal(tokenRequests,0);
  await i.finishOAuth(u.searchParams.get('state'),'code');assert.equal(tokenRequests,1);assert.equal((await i.tools('oauth'))[0].name,'ping');assert.doesNotMatch(JSON.stringify(i.list()),/oauth-private-fixture/);
  await assert.rejects(i.finishOAuth(u.searchParams.get('state'),'code'),/state/);
});
