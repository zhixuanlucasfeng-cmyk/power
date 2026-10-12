// End-to-end: a real Power server on a scratch POWER_HOME, driven by tiny fake agents (shell scripts),
// so these run in seconds and cost nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDue } from './schedules.mjs';
import { PARSERS, historyPrompt, isCodexMissingPowerTool, isCodexWriterConflict, sessionForTurn } from './engines.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'power-e2e-'));
const port = 4600 + Math.floor(Math.random() * 300);
const url = `http://127.0.0.1:${port}`;
let server;

const script = (name, body) => { const f = join(home, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
const api = async (path, body) => (await fetch(url + path, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
async function chat(body) {
  const r = await fetch(url + '/api/send', { method: 'POST', body: JSON.stringify(body) });
  return (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
}
const texts = (events) => events.filter((e) => e.t === 'text').map((e) => e.d).join('');

before(async () => {
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ personaPack: 'default', notify: false, turnTimeoutMin: 0.05 }));
  server = spawn(process.execPath, [join(DIR, 'app.mjs')], { env: { ...process.env, POWER_HOME: home, POWER_PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(url + '/api/meta'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  // Fake agents: echo the last line of the prompt; one that says hi; one that never finishes in time.
  for (const [name, body] of [['echo', 'printf "echo:%s" "$(printf "%s" "$1" | tail -n 1)"'], ['hi', 'echo "hi from $0"'], ['slow', 'sleep 30; echo late']])
    await api('/api/custom', { name, bin: script(`${name}.sh`, body), args: '{prompt}' });
});
after(() => server?.kill());

test('single chat: reply streams back and the thread is saved', async () => {
  const ev = await chat({ text: 'ping', char: 'c-echo' });
  assert.match(texts(ev), /ping/);
  const id = ev.find((e) => e.t === 'thread').id;
  const t = await api(`/api/thread/${id}`);
  assert.equal(t.events.find((e) => e.t === 'user').d, 'ping');
  assert.equal(t.running, false);
});

test('MCP bridge: browser discovery, human handoff past turn limit, plan and artifact reach the chat', async (t) => {
  // Allow cold CLI/MCP startup on a busy desktop; still wait beyond the execution budget.
  await api('/api/settings', {turnTimeoutMin:0.15});
  t.after(()=>api('/api/settings', {turnTimeoutMin:0.05}));
  const file = join(home, 'mcp-agent.mjs');
  const moduleURL = (path) => new URL(path, import.meta.url).href;
  writeFileSync(file, `#!${process.execPath}\n
import { Client } from ${JSON.stringify(moduleURL('./node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'))};
import { StdioClientTransport } from ${JSON.stringify(moduleURL('./node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'))};
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const client = new Client({name:'power-test-agent',version:'1'}, {capabilities:{}});
await client.connect(new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(join(DIR, 'server.mjs'))}],env:process.env,stderr:'pipe'}));
try {
  const tools = await client.listTools();
  if (!tools.tools.some(t => t.name === 'browser')) throw new Error('Browser tool missing');
  const catalog = await client.callTool({name:'browser',arguments:{action:'tools'}});
  if (catalog.isError || !JSON.stringify(catalog).includes('browser_navigate')) throw new Error('Browser catalog missing');
  const answer = await client.callTool({name:'request_user_input',arguments:{question:'Fixture: choose a location',options:['Dubai','Abu Dhabi']}},undefined,{timeout:15000});
  if (!JSON.stringify(answer).includes('Dubai')) throw new Error('Answer did not arrive');
  await client.callTool({name:'update_plan',arguments:{steps:[{step:'Read user answer',status:'completed'}]}});
  const path = join(process.cwd(),'fixture-result.txt'); writeFileSync(path,'Power handoff works');
  const shown = await client.callTool({name:'show_artifact',arguments:{path,title:'Fixture result'}});
  if (shown.isError) throw new Error(JSON.stringify(shown));
  console.log('MCP handoff finished');
} finally {await client.close();}
`);
  chmodSync(file, 0o755);
  await api('/api/custom', { name: 'mcp-fixture', bin: file, args: '{prompt}' });
  const pending = chat({ char: 'c-mcp-fixture', dir: home, text: 'Exercise Power MCP tools' });
  let questions = [];
  for (let i = 0; i < 80 && !questions.length; i++) { questions = await api('/api/questions'); await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(questions[0]?.question, 'Fixture: choose a location');
  await new Promise((r) => setTimeout(r, 10000)); // longer than this fixture's 9-second turn limit
  await api(`/api/questions/${questions[0].id}`, { answer: 'Dubai' });
  const events = await pending;
  assert.match(texts(events), /MCP handoff finished/);
  assert.ok(events.some((e) => e.t === 'plan'));
  const artifact = events.find((e) => e.t === 'artifact');
  assert.equal(await (await fetch(url + artifact.url)).text(), 'Power handoff works');
  const stored = await api('/api/thread/' + events.find((e) => e.t === 'thread').id);
  assert.ok(stored.events.some((e) => e.t === 'input_done' && e.answer === 'Dubai'));
  assert.ok(!JSON.stringify(stored).includes('POWER_TOOL_TOKEN'));
});

test('local tool endpoints reject missing credentials and foreign website origins', async () => {
  const missing = await fetch(url + '/api/agent-tools', { method: 'POST', body: JSON.stringify({ name: 'browser', args: { action: 'tools' } }) });
  assert.equal(missing.status, 401);
  const foreign = await fetch(url + '/api/browser/show', { method: 'POST', headers: { origin: 'https://example.com' } });
  assert.equal(foreign.status, 403);
});

test('group chat, everyone mode: each member speaks, first member wraps up', async () => {
  const ev = await chat({ text: 'plan?', members: ['c-echo', 'c-hi'], mode: 'all' });
  const speakers = ev.filter((e) => e.t === 'speaker').map((e) => [e.who, !!e.final]);
  assert.deepEqual(speakers, [['c-echo', false], ['c-hi', false], ['c-echo', true]]);
});

test('@mention: only the named member answers', async () => {
  const ev = await chat({ text: '@hi just you', members: ['c-echo', 'c-hi'], mode: 'all' });
  assert.deepEqual(ev.filter((e) => e.t === 'speaker').map((e) => e.who), ['c-hi']);
});

test('time limit: a stuck agent is stopped with a reason and the group moves on', async () => {
  const ev = await chat({ text: 'go', members: ['c-slow', 'c-hi'], mode: 'all' });
  const errs = ev.filter((e) => e.t === 'done' && e.error);
  assert.ok(errs.length >= 1 && /超过/.test(errs[0].error));
  assert.match(texts(ev), /hi from/);
});

test('attachments: uploaded file paths reach the agent', async () => {
  const up = await (await fetch(url + '/api/upload', { method: 'POST', headers: { 'x-filename': 'note.txt' }, body: 'hello file' })).json();
  assert.equal(readFileSync(up.path, 'utf8'), 'hello file');
  const ev = await chat({ text: 'see file', char: 'c-echo', files: [up.path] });
  assert.match(texts(ev), /note\.txt/);
});

test('send confirmation: a pending card resolves when the user taps send', async () => {
  const waiting = api('/api/approvals', { platform: 'WeChat', recipient: 'Aki', text: 'hi' });
  let list = [];
  for (let i = 0; i < 20 && !list.length; i++) { list = await api('/api/approvals'); await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(list[0].recipient, 'Aki');
  await api(`/api/approvals/${list[0].id}`, { approved: true });
  assert.equal((await waiting).approved, true);
});

test('settings: group and persona overrides apply per user', async () => {
  await api('/api/settings', { charGroups: { 'c-echo': 'Bots' }, charPrompts: { 'c-echo': 'terse' } });
  const meta = await api('/api/meta');
  assert.equal(meta.chars['c-echo'].group, 'Bots');
  assert.equal((await api('/api/persona/c-echo')).prompt, 'terse');
  assert.equal(meta.chars['c-echo'].prompt, undefined); // prompts never go to the page
});

test('schedules: daily and every-N-minutes due logic', () => {
  const at = (h, m) => { const d = new Date(2026, 9, 12, h, m); return d; };
  const daily = { enabled: true, when: { type: 'daily', time: '08:00' } };
  assert.equal(isDue(daily, at(7, 59)), false);
  assert.equal(isDue(daily, at(8, 1)), true);
  assert.equal(isDue({ ...daily, lastRun: at(8, 1).toISOString() }, at(9, 0)), false);
  assert.equal(isDue({ enabled: true, when: { type: 'every', minutes: 30 }, lastRun: at(8, 0).toISOString() }, at(8, 20)), false);
  assert.equal(isDue({ enabled: true, when: { type: 'every', minutes: 30 }, lastRun: at(8, 0).toISOString() }, at(8, 31)), true);
  assert.equal(isDue({ ...daily, enabled: false }, at(9, 0)), false);
});

test('parsers: codex and opencode JSON events become UI events', () => {
  const out = [], st = {}, emit = (e) => out.push(e);
  PARSERS.codex({ type: 'thread.started', thread_id: 'T1' }, emit, st);
  PARSERS.codex({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } }, emit, st);
  PARSERS.codex({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', aggregated_output: 'a\n', exit_code: 0 } }, emit, st);
  PARSERS.codex({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }, emit, st);
  PARSERS.codex({ type: 'error', message: 'network request failed' }, emit, st);
  assert.equal(st.session, 'T1');
  assert.equal(st.error, 'network request failed');
  assert.deepEqual(out.map((e) => e.t), ['tool', 'tool_result', 'text_start', 'text']);
  const oc = [], s2 = {};
  PARSERS.opencode({ type: 'text', sessionID: 'S', part: { text: 'yo' } }, (e) => oc.push(e), s2);
  assert.equal(s2.session, 'S');
  assert.equal(oc.at(-1).d, 'yo');
});

test('codex: only active-writer conflicts trigger a fresh-session retry', () => {
  assert.equal(isCodexWriterConflict('thread-store conflict: thread T already has an active writer'), true);
  assert.equal(isCodexWriterConflict('network request failed'), false);
  assert.equal(isCodexWriterConflict(null), false);
});

test('codex: missing Power MCP tools trigger a fresh-session retry', () => {
  assert.equal(isCodexMissingPowerTool('tools.mcp__memory__confirm_send is not a function'), true);
  assert.equal(isCodexMissingPowerTool('当前工具列表里没有 mcp__memory__confirm_send'), true);
  assert.equal(isCodexMissingPowerTool('审批卡已生成'), false);
  assert.equal(isCodexMissingPowerTool('已调用 `mcp__memory__confirm_send`，但超时未返回 APPROVED。\n\n我没有浏览，也没有发布评论。'), false);
  assert.equal(isCodexMissingPowerTool('本轮没有可调用的 memory MCP `confirm_send`'), true);
  assert.equal(isCodexMissingPowerTool(null), false);
});

test('codex: every Power turn starts fresh so dynamic MCP tools stay available', () => {
  assert.equal(sessionForTurn('codex', 'stale-codex-session'), null);
  assert.equal(sessionForTurn('claude', 'saved-claude-session'), 'saved-claude-session');
});

test('fresh turns retain the original thread objective alongside recent context', () => {
  const lines = [
    'Denji (user): Promote https://dryruncs.com for Cambridge pseudocode students.',
    ...Array.from({ length: 14 }, (_, i) => `Himeno: later message ${i}`),
    'Denji (user): write the Reddit post',
  ];
  const prompt = historyPrompt(lines, 'write the Reddit post');
  assert.match(prompt, /https:\/\/dryruncs\.com/);
  assert.match(prompt, /later message 13/);
  assert.equal(prompt.match(/write the Reddit post/g)?.length, 1);
});

test('parsers: hermes live steps, boxed answer and resumable session', () => {
  const out = [], st = {}, emit = (e) => out.push(e);
  for (const l of ['Initializing agent...', '  ┊ 🔎 preparing search_files…', '  ┊ 🔎 find      *  3.2s', '╭─ ⚕ Hermes ────╮', '    本大爷查完了。', '    第二行', '╰──────╯', 'Session:        20261011_121238_5de87f'])
    PARSERS.hermes(l, emit, st);
  assert.deepEqual(out.map((e) => e.t), ['tool', 'tool_result', 'text_start', 'text']);
  assert.equal(out.at(-1).d, '本大爷查完了。\n第二行');
  assert.equal(st.session, '20261011_121238_5de87f');
});

test('right-click actions: pin, unread, archive, fork, delete', async () => {
  const ev = await chat({ text: 'menu me', char: 'c-echo' });
  const id = ev.find((e) => e.t === 'thread').id;
  const row = async (x) => (await api('/api/threads')).find((t) => t.id === x);
  assert.equal((await row(id)).unread, true); // a finished reply counts as unread until opened
  await api('/api/thread-meta', { id, unread: false, seenUpdated: 'older-completion' });
  assert.equal((await row(id)).unread, true); // stale views cannot clear a newer result
  await api('/api/thread-meta', { id, pinned: true, unread: false, seenUpdated: (await row(id)).updated });
  assert.deepEqual([(await row(id)).pinned, (await row(id)).unread], [true, false]);
  const { id: forked } = await api('/api/fork', { id });
  const f = await api(`/api/thread/${forked}`);
  assert.match(f.title, /分叉/); assert.deepEqual(f.sessions, {}); assert.equal(f.events.length, (await api(`/api/thread/${id}`)).events.length);
  await api('/api/thread-meta', { id: forked, archived: true });
  assert.equal((await row(forked)).archived, true);
  await api('/api/delete-thread', { id: forked });
  assert.equal(await row(forked), undefined);
  assert.match(await (await fetch(`${url}/api/markdown/${id}`)).text(), /menu me/);
});

test('workbench: preview/save copy, connectors, malformed JSON and background jobs work through HTTP', async () => {
  const upload = await fetch(url+'/api/upload',{method:'POST',headers:{'x-filename':'interactive.html'},body:'<button onclick="this.textContent=1">0</button>'});
  const added=await upload.json(),id=decodeURIComponent(added.url.split('/').pop());
  const preview=await api('/api/artifacts/preview',{id});assert.equal(preview.editable,true);assert.match(preview.html,/<button/);
  const copy=await api('/api/artifacts/save',{id,text:'<h1>copy</h1>'});assert.notEqual(copy.id,id);assert.match(await (await fetch(url+added.url)).text(),/<button/);
  const missing=await fetch(url+'/api/artifacts/preview',{method:'POST',body:JSON.stringify({id:'../settings.json'})});assert.notEqual(missing.status,200);
  const malformed=await fetch(url+'/api/jobs',{method:'POST',body:'{'});assert.equal(malformed.status,400);assert.ok((await api('/api/meta')).version);
  await api('/api/integrations',{id:'fixture',name:'Test',type:'http',url:'https://example.com/mcp',token:'not-for-models'});
  const connections=await api('/api/integrations');assert.equal(connections.connectors[0].hasToken,true);assert.ok(!JSON.stringify(connections).includes('not-for-models'));
  const created=await api('/api/jobs',{dir:home,char:'c-hi',isolate:false,tasks:[{prompt:'Return a greeting'}]});assert.equal(created.length,1);
  let jobs=[];for(let i=0;i<60;i++){jobs=(await api('/api/jobs')).jobs;if(jobs[0]?.status==='completed')break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(jobs[0].status,'completed');assert.match(jobs[0].result,/hi from/);assert.ok(jobs[0].childThread);
  const scriptText=await (await fetch(url+'/workbench.js')).text();assert.match(scriptText,/sandbox='allow-scripts'/);assert.match(scriptText,/connect-src 'none'/);
  assert.ok(!(await api('/api/meta')).agents.some(a=>a.engine==='ollama'));
});
