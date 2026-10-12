import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { git, repoRoot } from './review.mjs';
const terminal = (j) => ['completed','failed','cancelled','interrupted'].includes(j.status);
export function createJobs({ home, run, stop, onUpdate = () => {}, maxConcurrent = 3 }) {
  const path = join(home,'jobs.json'), worktrees = join(home,'worktrees'); mkdirSync(worktrees,{recursive:true,mode:0o700});
  let jobs; try { jobs = JSON.parse(readFileSync(path,'utf8')); } catch { jobs = []; }
  for(const job of jobs) if(!terminal(job)) { job.status='interrupted'; job.error='Power 重启中断了任务；工作目录仍保留'; }
  let active = 0, pumping = false, stopping=false;
  const save = () => { const tmp=path+'.tmp';writeFileSync(tmp,JSON.stringify(jobs),{mode:0o600});renameSync(tmp,path); };
  const update = (job,patch) => { Object.assign(job,patch,{updated:new Date().toISOString()});save();onUpdate({...job}); };
  save();
  async function execute(job) {
    try {
      if(job.isolate) {
        const target=join(worktrees,job.id);
        await git(job.repo,['worktree','add','--detach',target,job.commit]); update(job,{dir:target,worktree:target});
      }
      if(terminal(job)) return;
      update(job,{status:'running'});
      const result=await run(job,(thread)=>{update(job,{childThread:thread}); if(job.status==='cancelled') stop(thread);});
      if(!terminal(job)) update(job,{status:result.error?'failed':'completed',result:result.text || '',error:result.error || null});
    } catch(e) { if(!terminal(job)) update(job,{status:'failed',error:String(e.message).slice(0,1000)}); }
    finally { active--;pump(); }
  }
  function pump() {
    if(pumping || stopping) return; pumping=true;
    while(active<maxConcurrent) { const j=jobs.find(x=>x.status==='queued');if(!j)break;active++;update(j,{status:'starting'});void execute(j); }
    pumping=false;
  }
  return {
    close() {stopping=true;for(const j of jobs.filter(x=>!terminal(x))){update(j,{status:'interrupted',error:'Power 正在关闭；工作目录保留'});if(j.childThread)stop(j.childThread);}},
    list: (parent) => jobs.filter(j=>!parent || j.parent===parent).map(j=>({...j})),
    async start({ parent, dir, char, tasks, isolate = true }) {
      if(stopping)throw new Error('Power 正在关闭');
      if(!Array.isArray(tasks)||!tasks.length||tasks.length>3||tasks.some(t=>!t.prompt?.trim()||t.prompt.length>12000)) throw new Error('每次可创建 1–3 个任务，每个任务必须有明确说明');
      if(jobs.filter(j=>!terminal(j)).length + tasks.length > 12) throw new Error('待执行任务过多，请等待现有任务完成');
      let repo,commit;
      if(isolate) { repo=await repoRoot(dir);commit=(await git(repo,['rev-parse','--verify','HEAD'])).trim(); }
      const created = tasks.map(t=>({id:randomUUID(),parent,char:t.char || char,title:String(t.title || t.prompt).slice(0,80),prompt:t.prompt,dir,isolate,repo,commit,status:'queued',created:new Date().toISOString()}));
      jobs.push(...created);save();for(const j of created)onUpdate({...j});pump();return created.map(j=>({...j}));
    },
    cancel(id,parent) { const j=jobs.find(x=>x.id===id&&(!parent||x.parent===parent));if(!j)throw new Error('找不到任务');if(terminal(j))return {...j};update(j,{status:'cancelled'});if(j.childThread)stop(j.childThread);return {...j}; },
    cancelParent(parent) { for(const j of jobs.filter(x=>x.parent===parent&&!terminal(x)))this.cancel(j.id); },
    async wait(parent,signal,seconds=45) {
      const end=Date.now()+Math.min(60,Math.max(1,seconds))*1000;
      while(Date.now()<end && this.list(parent).some(j=>!terminal(j))) {
        signal?.throwIfAborted();
        await new Promise(resolve=>setTimeout(resolve,500));
      }
      signal?.throwIfAborted(); return this.list(parent);
    },
    async removeWorktree(id) {
      const job=jobs.find(j=>j.id===id);if(!job?.worktree)throw new Error('任务没有托管工作目录');
      if(!terminal(job))throw new Error('任务仍在运行');
      const head=(await git(job.worktree,['rev-parse','HEAD'])).trim();
      if(head!==job.commit)throw new Error('工作目录包含新提交，请先保留或整合这些提交');
      // git refuses dirty/untracked files and submodules; never force-remove work.
      await git(job.repo,['worktree','remove',job.worktree]); update(job,{worktree:null});return {removed:true};
    },
  };
}
