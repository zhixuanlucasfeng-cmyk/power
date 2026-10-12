import { randomUUID } from 'node:crypto';
import { copyFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { parseTool } from './power-tools.mjs';
import { scopedFile } from './artifacts.mjs';
import { cleanJunk, findFiles, openFile, systemCheck, tidyFolder } from './pc-tools.mjs';

export function createAgentTools({ browser, home, uploads, scheduler, emit, notify, confirm, integrations, artifacts, image, review, jobs, characters }) {
  const sessions = new Map(), questions = new Map();
  const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const publicQuestion = ({ resolve, timer, session, ...q }) => q;
  function finish(q, answer) {
    if (!questions.delete(q.id)) return false;
    clearTimeout(q.timer);
    q.session.waited += Date.now() - q.session.waitSince;
    q.session.waitSince = 0;
    emit(q.thread, { t: 'input_done', id: q.id, ...answer });
    q.resolve(answer);
    return true;
  }
  return {
    start({ thread, char, dir, parent }) {
      const token = randomUUID();
      const s = { token, thread, char, dir, parent, waited: 0, waitSince: 0, controller: new AbortController() };
      sessions.set(token, s);
      return { token, waiting: () => !!s.waitSince,
        waitedMs: () => s.waited + (s.waitSince ? Date.now() - s.waitSince : 0),
        close: () => {
          sessions.delete(token);
          s.controller.abort();
          for (const q of questions.values()) if (q.session === s) finish(q, { cancelled: true, reason: 'Task stopped or finished' });
          browser.release(token);
        },
      };
    },
    listQuestions: () => [...questions.values()].map(publicQuestion),
    answer(id, body) {
      const q = questions.get(id);
      if (!q) throw new Error('问题已处理或已超时');
      const answer = String(body.answer ?? '').trim().slice(0, 4000);
      if (!body.cancelled && !answer) throw new Error('请填写回答或选择一个选项');
      return finish(q, body.cancelled ? { cancelled: true } : { cancelled: false, answer });
    },
    async call(token, name, input) {
      const s = sessions.get(token);
      if (!s) throw Object.assign(new Error('Power tool session expired or missing'), { status: 401 });
      const args = parseTool(name, input);
      if (name === 'connector') {
        if (args.action === 'list') return text(integrations.list().map(({id,name,type,status,enabled})=>({id,name,type,status,enabled})));
        if (!args.id) throw new Error('请指定连接器 id');
        const catalog = await integrations.tools(args.id);
        if (args.action === 'tools') return text(catalog);
        const tool = catalog.find((t) => t.name === args.tool);
        if (!tool) throw new Error('未知连接器工具，请先读取 tools');
        if (tool.annotations?.readOnlyHint !== true) {
          if (s.waitSince) throw new Error('当前已有问题等待回答');
          s.waitSince = Date.now();
          try {
            const approved = await confirm({ thread:s.thread, platform:integrations.list().find(c=>c.id===args.id)?.name || args.id, recipient:args.tool, text:JSON.stringify(args.args || {},null,2) },s.controller.signal);
            if (!approved) return text({cancelled:true});
          } finally { s.waited += Date.now()-s.waitSince;s.waitSince=0; }
        }
        return integrations.call(args.id,args.tool,args.args,s.controller.signal);
      }
      if (name === 'generate_image') {
        const source = args.source ? scopedFile(args.source,[s.dir,uploads,join(home,'generated-images')],20e6) : undefined;
        const result = await image({prompt:args.prompt,source,signal:s.controller.signal});
        s.controller.signal.throwIfAborted();
        const artifact = artifacts.add(result.path,args.title || '生成图片');
        emit(s.thread,{t:'artifact',...artifact}); return text(artifact);
      }
      if (name === 'review_workspace') {
        if (args.action === 'snapshot') return text(await review.snapshot(s.dir,args.base));
        if (args.action === 'comment') return text(await review.comment(s.dir,args));
        if (args.action === 'resolve') return text(await review.resolve(s.dir,args.id,args.resolved));
        return text(await review.attach(s.dir,args.url));
      }
      if (name === 'parallel_tasks') {
        if (args.action === 'agents') return text(characters());
        if (args.action === 'start') {
          if (s.parent) throw new Error('子任务不能继续创建子任务');
          const allowed = new Set(characters().map(c=>c.id));
          if (!args.tasks?.length || args.tasks.some(t=>!allowed.has(t.char || s.char))) throw new Error('请选择已安装的 Agent 角色');
          return text(await jobs.start({parent:s.thread,dir:s.dir,char:s.char,tasks:args.tasks,isolate:args.isolate}));
        }
        if (args.action === 'wait') {
          if(s.waitSince) throw new Error('当前已有等待中的操作');
          s.waitSince=Date.now();
          try { return text(await jobs.wait(s.thread,s.controller.signal,args.seconds)); }
          finally {s.waited+=Date.now()-s.waitSince;s.waitSince=0;}
        }
        if (args.action === 'cancel') return text(jobs.cancel(args.id,s.thread));
        return text(jobs.list(s.thread));
      }
      if (name === 'confirm_send') {
        if (s.waitSince) throw new Error('已有一个问题等待用户回答');
        s.waitSince = Date.now();
        try { return text(await confirm({ ...args, thread: s.thread }, s.controller.signal) ? 'APPROVED' : 'DENIED'); }
        finally { s.waited += Date.now() - s.waitSince; s.waitSince = 0; }
      }
      if (name === 'browser') {
        if (s.waitSince) throw new Error('等待用户操作时，浏览器已交给用户。请等用户回答后再操作。');
        const result = await browser.call(token, args.action, args.args);
        return args.action === 'tools' ? text(result) : result;
      }
      if (name === 'request_user_input') {
        if (s.waitSince) throw new Error('当前对话已有一个问题等待回答');
        s.waitSince = Date.now();
        try {
          if (args.kind === 'login') {
            const shown = await browser.call(token, 'show');
            if (shown.isError) { s.waited += Date.now() - s.waitSince; s.waitSince = 0; return shown; }
          }
          if (s.controller.signal.aborted) throw new Error('Task stopped');
        } catch (e) { s.waited += Date.now() - s.waitSince; s.waitSince = 0; throw e; }
        return text(await new Promise((resolve) => {
          const q = { id: randomUUID(), thread: s.thread, question: args.question, kind: args.kind,
            options: args.options ?? (args.kind === 'login' ? ['已完成，继续'] : []), at: new Date().toISOString(), session: s, resolve };
          q.timer = setTimeout(() => finish(q, { cancelled: true, reason: '15 minute timeout' }), 15 * 60000);
          questions.set(q.id, q);
          emit(s.thread, { t: 'input_request', ...publicQuestion(q) });
          notify('Power 等你操作', args.question);
        }));
      }
      if (name === 'update_plan') {
        if (args.steps.filter((x) => x.status === 'in_progress').length > 1) throw new Error('一次只能有一个进行中的步骤');
        emit(s.thread, { t: 'plan', steps: args.steps });
        return text({ saved: true });
      }
      if (name === 'show_artifact') {
        if (!isAbsolute(args.path)) throw new Error('请提供文件的绝对路径');
        const file = realpathSync(args.path);
        const allowed = [s.dir, uploads, join(home, 'browser-output'), join(home,'generated-images')].some((root) => {
          try { const rel = relative(realpathSync(root), file); return rel && !rel.startsWith('..' + '/') && rel !== '..' && !isAbsolute(rel); } catch { return false; }
        });
        if (!allowed) throw new Error('文件必须位于当前项目、上传目录或浏览器输出目录');
        const info = statSync(file);
        if (!info.isFile() || info.size > 25e6) throw new Error('只能展示不超过 25MB 的文件');
        if (artifacts) { const artifact=artifacts.add(file,args.title);emit(s.thread,{t:'artifact',...artifact});return text(artifact); }
        const filename = basename(file).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(-100);
        const saved = `${randomUUID()}-${filename}`;
        copyFileSync(file, join(uploads, saved));
        const artifact = { title: args.title || basename(file), url: `/upload/${encodeURIComponent(saved)}`, image: /\.(png|jpe?g|gif|webp)$/i.test(file), size: info.size };
        emit(s.thread, { t: 'artifact', ...artifact });
        return text(artifact);
      }
      if (name === 'manage_schedule') {
        if (args.action === 'list') return text({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, schedules: scheduler.list() });
        const existing = args.id ? scheduler.list().find((x) => x.id === args.id) : null;
        if (args.id && !existing) throw new Error('找不到这个定时任务，请先 list');
        if (args.action === 'run') {
          if (!args.id) throw new Error('立即执行需要任务 id');
          scheduler.runNow(args.id); return text({ started: args.id, note: '已开始执行，结果会出现在该任务的对话里并发送通知' });
        }
        if (args.action === 'delete') {
          if (!args.id) throw new Error('删除需要任务 id');
          scheduler.remove(args.id); return text({ deleted: args.id });
        }
        if (!existing && (!args.name || !args.text || !args.when)) throw new Error('新任务需要 name、text 和 when');
        return text(scheduler.upsert({ ...existing, ...args, char: existing?.char ?? s.char }));
      }
      if (name === 'find_files') {
        if (args.action === 'open') return text(openFile(args.path ?? ''));
        return text(await findFiles({ terms: args.terms ?? [], kinds: args.kinds, limit: args.limit }));
      }
      if (name === 'system_check') return text(await systemCheck(args));
      if (name === 'organize_files') {
        if (args.action === 'tidy') return text(tidyFolder({ folder: args.folder ?? '', dryRun: args.dry_run, logDir: join(home, 'tidy-log') }));
        return text(await cleanJunk({ keepDays: args.keep_days, dryRun: args.dry_run, confirm: async (summary) => {
          if (s.waitSince) throw new Error('已有一个问题等待用户回答');
          s.waitSince = Date.now();
          try { return await confirm({ thread: s.thread, platform: '电脑管家', recipient: '清理垃圾文件', text: summary }, s.controller.signal); }
          finally { s.waited += Date.now() - s.waitSince; s.waitSince = 0; }
        } }));
      }
      throw new Error('Unknown tool');
    },
  };
}
