import {test} from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createOnboarding} from './onboarding.mjs';
test('setup only completes a real verified login, supports failure and cancellation, and installs fixed official package',async()=>{
 const home=mkdtempSync(join(tmpdir(),'power-setup-'));let installed=false,auth=false,fail=false,hang=false;const calls=[];
 const run=(bin,args)=>{calls.push({bin,args});const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.kill=()=>p.emit('close',1);
 setImmediate(()=>{if(hang)return;let output='',code=0;if(args.includes('status')){code=auth?0:1;output=auth?'Logged in using ChatGPT':'Not logged in';}else if(args.includes('install'))installed=true;else if(args[0]==='login')auth=true;else{code=fail?1:0;output=fail?'Connection failed':JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'POWER_READY'}});}p.stdout.emit('data',Buffer.from(output));p.emit('close',code);});return p;};
 const setup=createOnboarding({home,root:home,find:n=>n==='npm'?'/npm':installed?'/codex':undefined,run});const settle=()=>new Promise(r=>setImmediate(r));
 try{
 assert.equal((await setup.status()).installed,false);await assert.rejects(setup.start('anything'));await assert.rejects(setup.start('verify'));
 await setup.start('install');await settle();assert.ok(calls.at(-1).args.includes('@openai/codex'));assert.equal((await setup.status()).installed,true);
 await setup.start('login');await settle();assert.equal((await setup.status()).authenticated,true);assert.equal(setup.verified,false);
 fail=true;await setup.start('verify');await settle();assert.equal(setup.verified,false);assert.equal((await setup.status()).job.status,'failed');
 fail=false;await setup.start('verify');await settle();assert.equal(setup.verified,true);
 hang=true;await setup.start('login');await assert.rejects(setup.start('install'));setup.cancel();assert.equal(setup.verified,false);
 }finally{rmSync(home,{recursive:true,force:true});}
});
