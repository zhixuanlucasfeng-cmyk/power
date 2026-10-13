import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContentStudio } from './content-studio.mjs';
import { createAgentTools } from './agent-tools.mjs';

test('content folders, current selection, guarded edits and local sync',async t=>{
  const home=mkdtempSync(join(tmpdir(),'power-content-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const root=join(home,'library');mkdirSync(root);
  const calls=[],script=join(home,'sync-command');writeFileSync(script,'test');
  const run=(bin,args,opts)=>{calls.push({bin,args,opts});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();queueMicrotask(()=>child.emit('close',0));return child;};
  const studio=createContentStudio({home,getRoot:()=>root,getSync:()=>script,run});
  const item=studio.create('测试视频');assert.equal(studio.list()[0].title,'测试视频');
  assert.equal(studio.current().id,item.id);
  studio.write(item.id,'script','# 新脚本');assert.equal(studio.detail(item.id).script,'# 新脚本');
  const image=join(home,'image.png');writeFileSync(image,'image');studio.attach(item.id,image,'cover');assert.equal(studio.detail(item.id).assets.cover,'cover.png');
  assert.equal(studio.media(item.id,'cover.png'),realpathSync(join(root,item.id,'cover.png')));
  const stream=new PassThrough();stream.end('video-bytes');await studio.upload(item.id,'video','clip.mp4',stream);assert.equal(studio.detail(item.id).assets.video,'video.mp4');
  const tools=createAgentTools({content:studio,browser:{release(){}},home,uploads:home,emit(){},confirm:async()=>false});
  const session=tools.start({thread:'test',char:'codex',dir:home});
  const current=await tools.call(session.token,'content',{action:'current'});
  assert.equal(JSON.parse(current.content[0].text).script,'# 新脚本');
  await tools.call(session.token,'content',{action:'write',field:'article',text:'正文'});
  assert.equal(studio.detail(item.id).article,'正文');session.close();
  const task=studio.sync(item.id);await new Promise(r=>setImmediate(r));assert.equal(studio.tasks().find(x=>x.id===task.id).status,'completed');assert.deepEqual(calls[0].args,[realpathSync(join(root,item.id))]);
  await assert.rejects(async()=>studio.write('../settings.json','script','bad'),/无效内容 ID/);
  assert.throws(()=>studio.media(item.id,'../../settings.json'),/找不到媒体/);
  if(process.platform!=='win32'){
    const outside=join(home,'outside');mkdirSync(outside);symlinkSync(outside,join(root,'linked'),'dir');assert.ok(!studio.list().some(x=>x.id==='linked'));
    const secret=join(home,'secret.txt');writeFileSync(secret,'private');const linked=join(root,item.id,'article.md');unlinkSync(linked);symlinkSync(secret,linked);assert.equal(studio.detail(item.id).article,'');assert.throws(()=>studio.write(item.id,'article','replacement'),/符号链接/);assert.equal(studio.detail(item.id).article,'');
  }
});
