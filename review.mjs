import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const exec = promisify(execFile);
export async function git(dir, args) {
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', '-C', dir, ...args], { timeout: 20000, maxBuffer: 5e6, env: { ...process.env, GIT_TERMINAL_PROMPT:'0' } }); return stdout;
}
export async function repoRoot(dir) { return realpathSync((await git(dir, ['rev-parse', '--show-toplevel'])).trim()); }
export function createReview(home) {
  const root = join(home, 'reviews'); mkdirSync(root, {recursive:true,mode:0o700});
  const file = (dir) => join(root, createHash('sha256').update(dir).digest('hex') + '.json');
  const load = (dir) => { try { return JSON.parse(readFileSync(file(dir),'utf8')); } catch { return { comments:[], prs:[] }; } };
  const save = (dir,data) => writeFileSync(file(dir),JSON.stringify(data),{mode:0o600});
  return {
    async snapshot(dir, base = 'HEAD') {
      const repo = await repoRoot(dir);
      if (!/^[\w./-]+$/.test(base) || base.startsWith('-')) throw new Error('无效比较基准');
      const hasHead = await git(repo,['rev-parse','--verify','HEAD']).then(()=>true,()=>false);
      const ref = hasHead ? (await git(repo,['rev-parse','--verify',`${base}^{commit}`])).trim() : null;
      const [status, trackedDiff, branch, untracked] = await Promise.all([
        git(repo,['status','--short']),
        git(repo,['diff','--no-ext-diff','--no-textconv',...(ref ? [ref] : ['--cached']),'--']),
        git(repo,['branch','--show-current']),
        git(repo,['ls-files','--others','--exclude-standard','-z']),
      ]);
      let diff=trackedDiff;
      const omitted=[];
      for(const name of untracked.split('\0').filter(Boolean)) {
        const path=join(repo,name), info=lstatSync(path);
        if(!info.isFile() || info.isSymbolicLink() || info.size>1e6 || diff.length>3e6){omitted.push(name);continue;}
        const bytes=readFileSync(path);if(bytes.includes(0)){omitted.push(name);continue;}
        const text=bytes.toString('utf8'), lines=text.split('\n');if(lines.at(-1)==='')lines.pop();
        diff+=`diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l=>'+'+l).join('\n')}\n`;
      }
      const version = createHash('sha256').update(diff + status).digest('hex');
      const data = load(repo);
      return { dir:repo, base, branch:branch.trim(), status, diff, version, omitted, untracked:untracked.split('\0').filter(Boolean), ...data };
    },
    async comment(dir, input) {
      const snap = await this.snapshot(dir, input.base || 'HEAD');
      if (input.version !== snap.version) throw new Error('代码已变化，请刷新差异后再添加评论');
      if (!input.file || isAbsolute(input.file) || input.file.split('/').includes('..') || !Number.isInteger(input.line) || input.line < 1 || !['old','new'].includes(input.side || 'new')) throw new Error('请提供相对文件路径、有效行号和代码侧');
      const text = String(input.text || '').trim(); if (!text || text.length > 4000) throw new Error('评论不能为空或超过 4000 字符');
      const data = load(snap.dir); const comment = { id:randomUUID(), file:input.file, line:input.line, side:input.side || 'new', text, version:snap.version, resolved:false, at:new Date().toISOString() };
      data.comments.push(comment); save(snap.dir,data); return comment;
    },
    async resolve(dir,id,resolved) { const repo = await repoRoot(dir), data = load(repo), c = data.comments.find((x)=>x.id===id); if(!c) throw new Error('找不到评论'); c.resolved=!!resolved; save(repo,data); return c; },
    async attach(dir,url) {
      const u = new URL(url); if(u.protocol!=='https:' || u.hostname!=='github.com' || !/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(u.pathname) || u.search || u.hash) throw new Error('请填写 GitHub Pull Request 链接');
      const repo=await repoRoot(dir), data=load(repo); data.prs=[...new Set([...data.prs,u.href])];save(repo,data);return data.prs;
    },
  };
}
