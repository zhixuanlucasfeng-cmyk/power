import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentTools } from './agent-tools.mjs';
import { PARSERS, ADAPTERS } from './engines.mjs';

function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'power-tools-'));
  const uploads = join(home, 'uploads'), dir = join(home, 'project');
  mkdirSync(uploads); mkdirSync(dir);
  const events = [], browserCalls = [], released = [];
  const runtime = createAgentTools({ home, uploads, emit: (thread, e) => events.push({ thread, ...e }), notify() {},
    browser: { call: async (...a) => { browserCalls.push(a); return { content: [] }; }, release: (id) => released.push(id) },
    scheduler: { list: () => [], upsert: (x) => x }, confirm: async () => false });
  const session = runtime.start({ thread: 'test-thread', char: 'test-char', dir });
  t.after(() => { session.close(); rmSync(home, { recursive: true, force: true }); });
  return { runtime, session, events, browserCalls, released, home, uploads, dir };
}

test('login handoff waits for a human, pauses execution and blocks browser actions while waiting', async (t) => {
  const { runtime, session, events, browserCalls } = setup(t);
  const pending = runtime.call(session.token, 'request_user_input', { kind: 'login', question: 'Sign in in the visible browser' });
  await new Promise((r) => setImmediate(r));
  assert.equal(browserCalls[0][1], 'show');
  assert.equal(session.waiting(), true);
  assert.equal(events[0].t, 'input_request');
  const q = runtime.listQuestions()[0];
  assert.equal(q.session, undefined);
  await assert.rejects(runtime.call(session.token, 'browser', { action: 'browser_click', args: {} }), /等待用户/);
  await new Promise((r) => setTimeout(r, 10));
  runtime.answer(q.id, { answer: '已完成，继续' });
  const result = JSON.parse((await pending).content[0].text);
  assert.equal(result.cancelled, false);
  assert.equal(session.waiting(), false);
  assert.ok(session.waitedMs() >= 10);
  assert.equal(runtime.listQuestions().length, 0);
});

test('stopping a task cancels its question, revokes tool access and releases its browser lease', async (t) => {
  const { runtime, session, released } = setup(t);
  const pending = runtime.call(session.token, 'request_user_input', { question: 'Choose a place' });
  session.close();
  assert.equal(JSON.parse((await pending).content[0].text).cancelled, true);
  await assert.rejects(runtime.call(session.token, 'browser', { action: 'tools' }), /expired/);
  assert.ok(released.includes(session.token));
  assert.equal(runtime.listQuestions().length, 0);
});

test('artifacts are copied for download; symlinks cannot escape the working folder', async (t) => {
  const { runtime, session, dir, home, events } = setup(t);
  const file = join(dir, 'report.txt'); writeFileSync(file, 'result');
  const result = JSON.parse((await runtime.call(session.token, 'show_artifact', { path: file })).content[0].text);
  assert.match(result.url, /^\/upload\//);
  assert.equal(events[0].t, 'artifact');
  const outside = join(home, 'private.txt'); writeFileSync(outside, 'private');
  symlinkSync(outside, join(dir, 'escape.txt'));
  await assert.rejects(runtime.call(session.token, 'show_artifact', { path: join(dir, 'escape.txt') }), /文件必须位于/);
});

test('schedule creation requires an explicit prompt and schedule and inherits the active character', async (t) => {
  const { runtime, session } = setup(t);
  await assert.rejects(runtime.call(session.token, 'manage_schedule', { action: 'upsert', name: 'Empty' }), /新任务需要/);
  const result = JSON.parse((await runtime.call(session.token, 'manage_schedule', { action: 'upsert', name: 'Brief', text: 'Summarize the project', when: { type: 'daily', time: '08:00' } })).content[0].text);
  assert.equal(result.char, 'test-char');
  await assert.rejects(runtime.call(session.token, 'manage_schedule', { action: 'delete' }), /需要任务 id/);
});

test('Codex shows real MCP progress and failures instead of an empty success tick', () => {
  const events = [], state = {};
  const item = { id: 'tool-1', type: 'mcp_tool_call', tool: 'browser', arguments: { action: 'browser_navigate' } };
  PARSERS.codex({ type: 'item.started', item }, (e) => events.push(e), state);
  PARSERS.codex({ type: 'item.completed', item: { ...item, result: { isError: true, content: [{ type: 'text', text: 'Navigation failed' }] } } }, (e) => events.push(e), state);
  assert.deepEqual(events.map((e) => e.t), ['tool', 'tool_result']);
  assert.equal(events[1].error, true);
  assert.equal(events[1].out, 'Navigation failed');
  const args = ADAPTERS.codex.run({ prompt: 'go', dir: '/tmp', mcp: { memory: { command: 'node', envVars: ['POWER_TOOL_TOKEN'], toolTimeoutSec: 1200 } } }).args;
  assert.ok(args.includes('mcp_servers.memory.tool_timeout_sec=1200'));
});
