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
import { PARSERS } from './engines.mjs';

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
  assert.equal(st.session, 'T1');
  assert.deepEqual(out.map((e) => e.t), ['tool', 'tool_result', 'text_start', 'text']);
  const oc = [], s2 = {};
  PARSERS.opencode({ type: 'text', sessionID: 'S', part: { text: 'yo' } }, (e) => oc.push(e), s2);
  assert.equal(s2.session, 'S');
  assert.equal(oc.at(-1).d, 'yo');
});

test('parsers: hermes live steps, boxed answer and resumable session', () => {
  const out = [], st = {}, emit = (e) => out.push(e);
  for (const l of ['Initializing agent...', '  ┊ 🔎 preparing search_files…', '  ┊ 🔎 find      *  3.2s', '╭─ ⚕ Hermes ────╮', '    本大爷查完了。', '    第二行', '╰──────╯', 'Session:        20261011_121238_5de87f'])
    PARSERS.hermes(l, emit, st);
  assert.deepEqual(out.map((e) => e.t), ['tool', 'tool_result', 'text_start', 'text']);
  assert.equal(out.at(-1).d, '本大爷查完了。\n第二行');
  assert.equal(st.session, '20261011_121238_5de87f');
});
