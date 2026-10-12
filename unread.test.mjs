import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const ui = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');
const source = ui.slice(ui.indexOf('async function open(id,'), ui.indexOf('async function poll(id)'));
async function check({ hidden=false, focused=true, markRead=true }={}) {
  const writes=[];
  const ctx={cur:null,turn:null,group:null,dir:'~',THREADS:[],document:{hidden,hasFocus:()=>focused},
    $:()=>({}),setBusy(){},render(){},setDir(){},loadThreads(){},
    fetch:async (url,options)=> { if(options) writes.push(JSON.parse(options.body)); return {json:async()=>({id:'one',unread:true,updated:'version-1',events:[]})}; }};
  await runInNewContext(source+'\nopen("one", '+markRead+')',ctx);
  return writes;
}
test('only an explicit, focused chat opening acknowledges the displayed completion',async()=>{
  assert.equal((await check()).length,1);
  assert.equal((await check({hidden:true})).length,0);
  assert.equal((await check({focused:false})).length,0);
  assert.equal((await check({markRead:false})).length,0);
  assert.equal((await check())[0].seenUpdated,'version-1');
});
test('selected chats and collapsed character groups retain unread indicators',()=>{
  const render=ui.slice(ui.indexOf('function renderTree()'),ui.indexOf('// Right-click menus'));
  assert.doesNotMatch(render,/unread\s*&&\s*t\.id\s*!==\s*cur/);
  assert.match(render,/dotU\(unreadBy\[k\]\)/);
  assert.match(ui,/open\(id, false\)/);
});
