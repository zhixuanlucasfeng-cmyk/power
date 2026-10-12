import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const home=mkdtempSync(join(tmpdir(),'power-package-test-'));
const root=resolve('dist/Power-Windows-x64');
const child=spawn(join(root,'node.exe'),[join(root,'resources/power/desktop/launch.mjs')],{env:{...process.env,POWER_HOME:home,POWER_PORT:'14545',POWER_ELECTRON:join(root,'runtime/electron.exe')},stdio:'inherit'});
child.on('error',e=>console.error(e));
try{
 for(let i=0;i<150&&!existsSync(join(home,'desktop-connection.json'));i++){
  if(child.exitCode!==null)throw new Error('Packaged app exited before startup');
  await new Promise(r=>setTimeout(r,200));
 }
 assert.ok(existsSync(join(home,'desktop-connection.json')),'Packaged desktop bridge started');
 assert.ok((await fetch('http://127.0.0.1:14545/api/meta')).ok,'Bundled Node serves Power');
 const c=JSON.parse(readFileSync(join(home,'desktop-connection.json'),'utf8'));
 const r=await fetch(c.endpoint,{method:'POST',headers:{Authorization:'Bearer '+c.token},body:JSON.stringify({action:'new',args:{url:'about:blank'}})});
 assert.ok(r.ok);assert.ok((await r.json()).id,'Packaged browser creates a tab');
 console.log('Packaged Windows app startup and browser smoke test passed');
}finally{
 if(child.pid)spawnSync('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});
 rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:300});
}
