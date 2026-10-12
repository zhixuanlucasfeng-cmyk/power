// Starts the local server and desktop together, without a platform-specific service.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=`http://127.0.0.1:${process.env.POWER_PORT||4545}`;
const available=async()=>{try{const r=await fetch(base+'/api/meta',{signal:AbortSignal.timeout(1000)});return r.ok;}catch{return false;}};
let server;
try {
 if(!await available()){
  server=spawn(process.execPath,['app.mjs'],{cwd:root,stdio:'inherit',env:process.env});
  server.on('error',e=>console.error(e.message));
  for(let i=0;i<100&&!await available();i++){
   if(server.exitCode!==null)throw new Error('Power server exited during startup');
   await new Promise(r=>setTimeout(r,200));
  }
  if(!await available())throw new Error('Power server did not start');
 }
 const electron=process.env.POWER_ELECTRON||createRequire(import.meta.url)('electron');
 const app=spawn(electron,[resolve(root,'desktop/main.cjs')],{cwd:root,stdio:'inherit',env:process.env});
 await new Promise((resolve,reject)=>{app.once('error',reject);app.once('exit',code=>code?reject(new Error(`Power exited (${code})`)):resolve());});
} catch(e){console.error(e.message);process.exitCode=1;}
finally{server?.kill();}
