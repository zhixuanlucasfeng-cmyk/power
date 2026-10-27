import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const ui=readFileSync(new URL('./ui.html',import.meta.url),'utf8');
const native=readFileSync(new URL('./native-browser.js',import.meta.url),'utf8');

test('failed portraits retry without removing the image, then stop for missing files',()=>{
 const timers=[];
 const retry=runInNewContext(ui.slice(ui.indexOf('function retryAvatar('),ui.indexOf('const modelName ='))+';retryAvatar',{URL,setTimeout:fn=>timers.push(fn)});
 const image={src:'http://localhost/avatar/reze?v=1',dataset:{},isConnected:true};
 retry(image);assert.equal(image.hidden,true);timers.shift()();assert.equal(new URL(image.src).searchParams.get('retry'),'1');
 retry(image);timers.shift()();assert.equal(new URL(image.src).searchParams.get('retry'),'2');
 retry(image);assert.equal(timers.length,0,'missing portraits must not retry forever');
 const detached={src:'http://localhost/avatar/reze',dataset:{},isConnected:false};
 retry(detached);timers.shift()();assert.equal(detached.src,'http://localhost/avatar/reze');
 assert.match(ui,/onload="this.hidden=false" onerror="retryAvatar\(this\)"/,'successful retries restore the portrait');
});

test('native view follows pane bounds, hides for chat/drawer, and restores',async()=>{
 let rect={x:500,y:100,width:500,height:600},drawer=false;
 const calls=[];
 const ctx={open:true,visible:false,el:()=>({getBoundingClientRect:()=>rect}),
 document:{body:{classList:{contains:()=>drawer}}},getComputedStyle:()=>({paddingBottom:'60px'}),
 run:async(action,args)=>calls.push({action,args})};
 const layout=runInNewContext(native.slice(native.indexOf('async function layout()'),native.indexOf(' window.openPowerBrowser='))+';layout',ctx);
 await layout();assert.equal(calls.at(-1).action,'show');assert.equal(calls[0].args.height,540);
 rect={...rect,x:450,width:550};await layout();assert.equal(calls.at(-1).args.x,450);
 rect={x:0,y:0,width:0,height:0};await layout();assert.equal(calls.at(-1).action,'hide');
 rect={x:0,y:100,width:1000,height:700};await layout();assert.equal(calls.at(-1).action,'show');
 drawer=true;await layout();assert.equal(calls.at(-1).action,'hide');
 drawer=false;await layout();assert.equal(calls.at(-1).action,'show');
 ctx.open=false;const count=calls.length;await layout();assert.equal(calls.length,count);
});
