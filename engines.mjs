// Local agent engines: how to find each CLI on this machine and how to run one turn with it.
// To support a new agent, add an entry to ADAPTERS. Nothing else needs to change.
//
// run(o) gets { prompt, dir, session, model, effort, system, cwd, extra } and returns { args, cwd?, parse? }.
//   parse(event, emit, state) handles one JSON line of stdout; without parse, stdout is the reply text.
//   state.session = <id> lets the next turn resume (only for adapters with session: true).
import { accessSync, constants, readFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
export const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const cut = (s) => strip(s).slice(0, 4000);
export const isCodexWriterConflict = (error) => /thread-store conflict|already has an active writer/i.test(String(error ?? ''));
// Codex snapshots its MCP tool list when a thread starts. Resuming that thread can drop
// Power's dynamically injected tools, so replay Power's transcript into a fresh turn.
export const sessionForTurn = (engine, savedSession) => engine === 'codex' ? null : savedSession ?? null;
export const historyPrompt = (lines, text) => {
  const past = lines.slice(0, -1);
  if (!past.length) return text;
  const recent = past.slice(-12);
  const objective = past[0];
  const pinned = recent.includes(objective) ? '' : `Thread objective:\n${objective.slice(0, 6000)}\n\n`;
  return `${pinned}Recent conversation:\n${recent.join('\n\n')}\n\nUser now says: ${text}`;
};
export const isCodexMissingPowerTool = (message) => {
  const s = String(message ?? '');
  // "没有"/"missing" count only when they refer to the tool itself, not "我没有浏览".
  return /confirm_send/i.test(s) && /(not a function|not callable|not available|doesn['’]?t have|缺少|无法调用|不可调用|(没有|missing)[^。.\n]{0,30}confirm_send|confirm_send[^。.\n]{0,30}missing)/i.test(s);
};

// claude -p --output-format stream-json --include-partial-messages
function parseClaude(ev, emit, st) {
  if (ev.type === 'stream_event') {
    const e = ev.event;
    if (ev.parent_tool_use_id) return;
    if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') emit({ t: 'text', d: e.delta.text });
    if (e.type === 'content_block_start' && e.content_block.type === 'text') emit({ t: 'text_start' });
  } else if (ev.type === 'system' && ev.subtype === 'thinking_tokens') {
    emit({ t: 'thinking', n: ev.estimated_tokens });
  } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
    for (const b of ev.message.content) if (b.type === 'tool_use' && b.name !== 'ToolSearch') emit({ t: 'tool', id: b.id, name: b.name, input: b.input });
  } else if (ev.type === 'user') {
    for (const b of ev.message?.content ?? []) if (b.type === 'tool_result') {
      const out = Array.isArray(b.content) ? b.content.map((c) => c.text ?? `[${c.type}]`).join('\n') : String(b.content ?? '');
      emit({ t: 'tool_result', id: b.tool_use_id, out: cut(out), error: !!b.is_error });
    }
  } else if (ev.type === 'result') {
    st.session = ev.session_id;
    emit({ t: 'done', error: ev.is_error ? ev.result : null, ms: ev.duration_ms });
  }
}

// hermes chat -q (not quiet): tool steps print live ("┊ 🔎 find  *  3.2s"), the answer sits in a ╭─ ⚕ Hermes ─╮ box,
// and a "Session: <id>" line lets the next turn resume. Fed raw text lines (lines: true).
function parseHermes(raw, emit, st) {
  const line = strip(raw).replace(/\r/g, '');
  const sess = line.match(/^Session:\s+(\S+)/);
  if (sess) { st.session = sess[1]; return; }
  if (/^\s*╭─.*Hermes/.test(line)) { st.box = []; return; }
  if (st.box && /^\s*╰/.test(line)) { emit({ t: 'text_start' }); emit({ t: 'text', d: st.box.join('\n').replace(/^\n+|\n+$/g, '') }); st.box = null; return; }
  if (st.box) { st.box.push(line.replace(/^\s*│?\s{0,4}/, '').replace(/\s*│\s*$/, '')); return; }
  const step = line.match(/^\s*┊\s*(\S+)\s+(.*?)\s*$/);
  if (step && !/^preparing\b/.test(step[2])) {
    const id = `h${(st.n = (st.n ?? 0) + 1)}`;
    emit({ t: 'tool', id, name: `Hermes · ${step[2].split(/\s+/)[0]}`, input: { step: step[2] } });
    emit({ t: 'tool_result', id, out: step[2], error: false });
  }
}

// opencode run --format json
function parseOpencode(ev, emit, st) {
  if (ev.sessionID) st.session = ev.sessionID;
  const p = ev.part ?? {};
  if (ev.type === 'text' && p.text) { emit({ t: 'text_start' }); emit({ t: 'text', d: p.text }); }
  else if (ev.type === 'tool_use') {
    emit({ t: 'tool', id: p.id, name: p.tool, input: p.state?.input ?? {} });
    if (p.state?.status === 'completed' || p.state?.status === 'error')
      emit({ t: 'tool_result', id: p.id, out: cut(p.state.output ?? p.state.error ?? ''), error: p.state.status === 'error' });
  } else if (ev.type === 'error') emit({ t: 'done', error: JSON.stringify(ev.error ?? ev).slice(0, 500) });
}

// codex exec --json
function parseCodex(ev, emit, st) {
  const it = ev.item ?? {};
  if (ev.type === 'thread.started') st.session = ev.thread_id;
  else if (ev.type === 'item.started' && it.type === 'command_execution') emit({ t: 'tool', id: it.id, name: 'Bash', input: { command: it.command } });
  else if (ev.type === 'item.started' && it.type === 'mcp_tool_call') {
    (st.mcpStarted ??= new Set()).add(it.id);
    emit({ t: 'tool', id: it.id, name: it.tool || it.type, input: it.arguments ?? {} });
  }
  else if (ev.type === 'item.started' && it.type === 'reasoning') emit({ t: 'thinking' });
  else if (ev.type === 'item.completed') {
    if (it.type === 'agent_message') { st.text = `${st.text ?? ''}\n${it.text ?? ''}`; emit({ t: 'text_start' }); emit({ t: 'text', d: it.text }); }
    else if (it.type === 'command_execution') emit({ t: 'tool_result', id: it.id, out: cut(it.aggregated_output ?? ''), error: it.exit_code !== 0 });
    else if (it.type === 'file_change') {
      emit({ t: 'tool', id: it.id, name: 'Edit', input: { file_path: (it.changes ?? []).map((c) => `${c.kind} ${c.path}`).join(', ') } });
      emit({ t: 'tool_result', id: it.id, out: JSON.stringify(it.changes, null, 1), error: it.status === 'failed' });
    } else if (it.type === 'mcp_tool_call' || it.type === 'web_search') {
      if (!st.mcpStarted?.delete(it.id)) emit({ t: 'tool', id: it.id, name: it.tool || it.type, input: it.arguments ?? { query: it.query } });
      const result = it.result;
      const out = it.error?.message ?? (Array.isArray(result?.content) ? result.content.map((c) => c.text ?? `[${c.type}]`).join('\n') : JSON.stringify(result ?? it.action ?? ''));
      emit({ t: 'tool_result', id: it.id, out: cut(out), error: !!it.error || !!result?.isError || it.status === 'failed' });
    }
  } else if (ev.type === 'turn.failed' || ev.type === 'error') st.error = String(ev.error?.message ?? ev.message).slice(0, 500);
}

export const ADAPTERS = {
  claude: { label: 'Claude Code', bins: ['claude'], session: true, system: true,
    run: (o) => ({ cwd: o.cwd, parse: parseClaude, args: ['-p', o.prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      ...(o.model ? ['--model', o.model] : []), ...(o.effort ? ['--effort', o.effort] : []),
      ...(o.system ? ['--append-system-prompt', o.system] : []), ...(o.session ? ['--resume', o.session] : []), ...(o.extra ?? [])] }) },
  // Hermes bundles an older codex earlier on PATH; prefer the Homebrew one.
  codex: { label: 'Codex', bins: ['codex'], prefer: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'], session: true,
    // Models the user can pick, from Codex's own cache of its model list.
    choices: () => {
      const m = JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8')).models ?? [];
      return m.filter((x) => x.visibility === 'list').map((x) => ({ id: x.slug, label: x.display_name ?? x.slug, efforts: (x.supported_reasoning_levels ?? []).map((r) => r.effort) }));
    },
    run: (o) => {
      const imgs = (o.files ?? []).filter((f) => IMAGE.test(f)).flatMap((f) => ['-i', f]);
      const pick = [...(o.model ? ['-m', o.model] : []), ...(o.effort ? ['-c', `model_reasoning_effort="${o.effort}"`] : [])];
      // Extra tools (MCP servers) and network access for the sandbox, as -c overrides. Secrets travel as
      // whitelisted env vars (env_vars), never in argv.
      // Persona and rules as developer instructions: they outrank the user turn, so the character holds its voice.
      const cfg = [...(o.system ? ['-c', `developer_instructions=${JSON.stringify(o.system)}`, ...(o.persona ? ['-c', 'personality="none"'] : [])] : []), ...(o.network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
        ...Object.entries(o.mcp ?? {}).flatMap(([n, m]) => ['-c', `mcp_servers.${n}.command=${JSON.stringify(m.command)}`,
          '-c', `mcp_servers.${n}.args=${JSON.stringify(m.args ?? [])}`, ...(m.envVars?.length ? ['-c', `mcp_servers.${n}.env_vars=${JSON.stringify(m.envVars)}`] : []),
          // codex exec can't ask for approval, so tools we hand it are pre-approved (or they'd always be refused).
          '-c', `mcp_servers.${n}.default_tools_approval_mode="approve"`, ...(m.toolTimeoutSec ? ['-c', `mcp_servers.${n}.tool_timeout_sec=${m.toolTimeoutSec}`] : [])])];
      return { parse: parseCodex, args: o.session
        ? ['exec', ...cfg, 'resume', o.session, '--json', '--skip-git-repo-check', ...pick, ...imgs, o.prompt]
        : ['exec', ...cfg, '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-C', o.dir, ...pick, ...imgs, o.prompt] };
    } },
  opencode: { label: 'opencode', bins: ['opencode'], session: true,
    run: (o) => ({ parse: parseOpencode, args: ['run', '--format', 'json', '--dir', o.dir, ...(o.session ? ['-s', o.session] : []), ...(o.files ?? []).flatMap((f) => ['-f', f]), o.prompt] }) },
  hermes: { label: 'Hermes', bins: ['hermes'], session: true,
    run: (o) => ({ lines: true, parse: parseHermes, args: ['chat', '-q', o.prompt, ...(o.session ? ['--resume', o.session] : []), ...(o.files ?? []).filter((f) => IMAGE.test(f)).slice(0, 1).flatMap((f) => ['--image', f])] }) },
  pi: { label: 'pi', bins: ['pi'], run: (o) => ({ args: ['-p', o.prompt] }) },
  gemini: { label: 'Gemini CLI', bins: ['gemini'], run: (o) => ({ args: ['-p', o.prompt] }) },
  qwen: { label: 'Qwen Code', bins: ['qwen'], run: (o) => ({ args: ['-p', o.prompt] }) },
  cursor: { label: 'Cursor Agent', bins: ['cursor-agent'], run: (o) => ({ args: ['-p', o.prompt, '--output-format', 'text'] }) },
  copilot: { label: 'Copilot CLI', bins: ['copilot'], run: (o) => ({ args: ['-p', o.prompt] }) },
  auggie: { label: 'Auggie', bins: ['auggie'], run: (o) => ({ args: ['-p', '-q', o.prompt] }) },
  amp: { label: 'Amp', bins: ['amp'], run: (o) => ({ args: ['-x', o.prompt] }) },
  goose: { label: 'Goose', bins: ['goose'], run: (o) => ({ args: ['run', '-t', o.prompt] }) },
  crush: { label: 'Crush', bins: ['crush'], run: (o) => ({ args: ['run', o.prompt] }) },
  aider: { label: 'Aider', bins: ['aider'], run: (o) => ({ args: ['--message', o.prompt, '--no-auto-commits', '--no-pretty'] }) },
  openclaw: { label: 'OpenClaw', bins: ['openclaw'], run: (o) => ({ args: ['agent', '--agent', 'main', '-m', o.prompt] }) },
  // User-defined in Settings: any CLI that takes a prompt and prints a reply. {prompt} and {dir} are filled in.
  custom: { label: 'Custom', run: (o) => {
    const toks = (o.template || '{prompt}').trim().split(/\s+/);
    if (!toks.some((t) => t.includes('{prompt}'))) toks.push('{prompt}');
    return { args: toks.map((t) => t.replaceAll('{prompt}', o.prompt).replaceAll('{dir}', o.dir)) };
  } },

};

const EXTRA_DIRS = ['.local/bin', '.bun/bin', '.cargo/bin', '.npm-global/bin', '.deno/bin'].map((d) => join(homedir(), d))
  .concat(['/opt/homebrew/bin', '/usr/local/bin']);

function isExec(p) { try { accessSync(p, constants.X_OK); return true; } catch { return false; } }

function which(a) {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_DIRS].filter(Boolean);
  return a.prefer?.find(isExec) ?? a.bins.flatMap((b) => dirs.map((d) => join(d, b))).find(isExec);
}

// A command name on PATH, or an absolute path to an executable.
export const findBin = (name) => (name.includes('/') ? (isExec(name) ? name : undefined) : which({ bins: [name] }));

// → [{ engine, label, path, model? }] for every supported agent installed on this machine.
// Per-engine model menus for the UI: { engine: [{ id, label, efforts }] }.
export function engineChoices() {
  const out = {};
  for (const [engine, a] of Object.entries(ADAPTERS)) if (a.choices) try { out[engine] = a.choices(); } catch {}
  return out;
}

export function detect() {
  const found = [];
  for (const [engine, a] of Object.entries(ADAPTERS)) {
    if (!a.bins) continue;
    const path = which(a);
    if (!path) continue;
    if (!a.models) { found.push({ engine, label: a.label, path }); continue; }
    try { for (const model of a.models(path)) found.push({ engine, label: `${a.label} · ${model}`, path, model }); } catch {}
  }
  return found;
}

export const PARSERS = { claude: parseClaude, codex: parseCodex, opencode: parseOpencode, hermes: parseHermes };
