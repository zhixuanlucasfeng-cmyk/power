import spawn from 'cross-spawn';
import {existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {findBin,strip} from './engines.mjs';

// Fixed commands only: the setup endpoint is not a general-purpose shell.
export function createOnboarding({home,root,find=findBin,run=spawn}) {
 let job=null,child,verified=false;
 const env=()=>{const e={...process.env};for(const k of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','CODEX_ACCESS_TOKEN'])delete e[k];return e;};
 const status=async()=>{
  const bin=find('codex');if(!bin)return {installed:false,authenticated:false,verified:false,job};
  const result=await execute(bin,['login','status'],10000);
  return {installed:true,authenticated:result.code===0&&/Logged in using ChatGPT/i.test(result.output),verified,job};
 };
 function execute(bin,args,timeout,onOutput) {
  return new Promise(resolve=>{
   let output='',settled=false;
   const p=run(bin,args,{cwd:home,env:env(),windowsHide:true,stdio:['ignore','pipe','pipe'],timeout});
   const finish=(code,error)=>{if(settled)return;settled=true;resolve({code,output:error||output});};
   const append=b=>{output=(output+strip(b.toString())).slice(-12000);onOutput?.(output);};
   p.stdout?.on('data',append);p.stderr?.on('data',append);p.once('error',e=>finish(-1,e.message));p.once('close',code=>finish(code));
   if(onOutput)child=p;
  });
 }
 return {status,
  async start(action){
   if(!['install','login','verify'].includes(action))throw new Error('未知配置操作');
   if(job?.status==='running')throw new Error('请等待当前步骤完成，或先取消');
   let bin=find('codex'),args,timeout=180000;
   if(action==='install'){
    const bundled=resolve(root,'../../npm/bin/npm-cli.js');
    const install=['install','--prefix',join(home,'agents'),'--no-audit','--no-fund','--registry=https://registry.npmjs.org','@openai/codex'];
    if(existsSync(bundled)){bin=process.execPath;args=[bundled,...install];}
    else{bin=find('npm');args=install;}
    if(!bin)throw new Error('找不到安装组件，请重新安装最新版 Power。源码版需要 Node.js 和 npm。');
    timeout=600000;
   }else{
    if(!bin)throw new Error('请先安装 Codex');
    if(action==='login'){args=['login','--device-auth'];timeout=900000;}
    else {if(!(await status()).authenticated)throw new Error('请先完成 ChatGPT 登录');args=['exec','--ephemeral','--skip-git-repo-check','-s','read-only','-C',home,'-c','forced_login_method="chatgpt"','Reply with exactly POWER_READY. Do not use tools or read files.'];}
   }
   mkdirSync(home,{recursive:true});verified=false;
   job={action,status:'running',output:''};const current=job;
   void execute(bin,args,timeout,output=>{current.output=output;}).then(r=>{
    if(current.status==='cancelled')return;
    current.status=r.code===0?'completed':'failed';
    if(action==='verify'&&r.code===0&&!/POWER_READY/.test(r.output))current.status='failed';
    verified=action==='verify'&&current.status==='completed';
    current.output=current.status==='completed'?'步骤完成 / Completed':r.output||'操作失败或超时，请重试 / Failed or timed out';child=null;
   });
   return job;
  },
  cancel(){if(child){child.kill();child=null;}if(job?.status==='running'){job.status='cancelled';job.output='已取消 / Cancelled';}return job;},
  get verified(){return verified;}
 };
}
