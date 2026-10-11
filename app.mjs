// Power: one app for every AI agent on this machine. Drives each agent's own CLI headless
// (Claude Code with your own subscription login, Codex, opencode, Hermes, ...). Binds to 127.0.0.1 only.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openMemory, memoryDir } from './memory.mjs';
import { ADAPTERS, detect, engineChoices, findBin, strip } from './engines.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.POWER_HOME || join(homedir(), '.power');
const SKILLS = join(HOME, '.claude', 'skills');
const THREADS = join(HOME, 'threads');
const AVATARS = join(HOME, 'avatars'); // your own pictures: <char>.png|jpg|webp|gif
const PORT = Number(process.env.POWER_PORT || 4545);
mkdirSync(THREADS, { recursive: true });
mkdirSync(SKILLS, { recursive: true });
mkdirSync(AVATARS, { recursive: true });
const IMG = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const avatarFile = (k) => readdirSync(AVATARS).find((f) => f.startsWith(k + '.') && IMG[f.split('.').pop()]);
const avatarOf = (c) => { const a = packChars()[c]?.avatar; return avatarFile(c) ?? (a && avatarFile(a)); };
if (!existsSync(join(HOME, 'CLAUDE.md'))) writeFileSync(join(HOME, 'CLAUDE.md'), readFileSync(join(DIR, 'persona.md')));
// Re-resolved per call so changing the Obsidian vault in Settings takes effect at once.
const mem = { recall: (...a) => openMemory(memoryDir(HOME), SKILLS).recall(...a), search: (...a) => openMemory(memoryDir(HOME), SKILLS).search(...a), recent: (...a) => openMemory(memoryDir(HOME), SKILLS).recent(...a), forget: (...a) => openMemory(memoryDir(HOME), SKILLS).forget(...a) };

const MODELS = {
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-fable-5-1': 'Fable 5.1',
};

// Characters come from a persona pack: personas/<name>.json in this repo, or ~/.power/personas/<name>.json for your own.
// Pick one in Settings. engine = an ADAPTERS key; a character shows only if its engine is installed.
const PACK_DIRS = () => [join(HOME, 'personas'), join(DIR, 'personas')];
function listPacks() {
  const out = {};
  for (const d of PACK_DIRS().reverse()) if (existsSync(d))
    for (const f of readdirSync(d).filter((x) => x.endsWith('.json'))) { try { out[f.slice(0, -5)] = JSON.parse(readFileSync(join(d, f), 'utf8')).name ?? f; } catch {} }
  return out;
}
function loadPack() {
  const want = loadSettings().personaPack || 'default';
  for (const name of [want, 'default']) for (const d of PACK_DIRS()) {
    const f = join(d, `${name}.json`);
    if (existsSync(f)) try { return JSON.parse(readFileSync(f, 'utf8')); } catch {}
  }
  return { characters: {} };
}
const packChars = () => loadPack().characters;
const userName = () => loadSettings().userName?.trim() || '';
const userLabel = () => userName() || 'User';

// Share the main Claude Code memory with the crew: its notes folder (read-only by instruction) and the
// claude-mem plugin (searchable history of past sessions), when they exist on this machine.
const MAIN_MEMORY = join(homedir(), '.claude', 'projects', homedir().replace(/[/.]/g, '-'), 'memory');
const CLAUDE_MEM = (() => {
  try {
    const p = JSON.parse(readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins ?? {};
    const k = Object.keys(p).find((x) => x.startsWith('claude-mem@'));
    return k ? p[k][0]?.installPath : null;
  } catch { return null; }
})();
// Desktop control in the App: Claude Code's own computer-use only exists in interactive sessions,
// so the crew gets Cua Driver (background macOS automation) as an MCP server when it is installed.
const CUA = findBin('cua-driver');
// Extra MCP servers for the crew, rebuilt per turn: Cua (desktop apps) and Contract (one-key tool gateway, set in
// settings.json as contract: { url, key, mcp }). The Contract key goes in env, not argv.
const MCP_CONFIG = join(HOME, 'mcp.json');
function contractOf() { const c = loadSettings().contract; return c?.key && c?.url && c?.mcp && existsSync(c.mcp) ? c : null; }
function mcpConfig() {
  const servers = {}, k = contractOf();
  if (CUA) servers.cua = { command: CUA, args: ['mcp'] };
  if (k) servers.contract = { command: process.execPath, args: [k.mcp], env: { CONTRACT_KEY: k.key, CONTRACT_URL: k.url } };
  if (!Object.keys(servers).length) return null;
  writeFileSync(MCP_CONFIG, JSON.stringify({ mcpServers: servers }, null, 1), { mode: 0o600 });
  return MCP_CONFIG;
}
const CONTRACT_NOTE = '\n\nThe contract MCP tools (mcp__contract__*) are a one-key gateway with automatic failover: web/news search, URL scraping, social posts and trends, YouTube, crypto prices / DEX pools / wallets, stock quotes, macro data, company lookup. Call find_tools first if unsure which one fits; prefer them over guessing.';
const CUA_NOTE = '\n\nDesktop apps (WeChat, Telegram, ...): use the cua MCP tools (list apps/windows, screenshot, click, type) instead of computer-use. ' +
  'Screenshot after each step to confirm it landed. If the cua tools report missing permissions, tell the user to open CuaDriver and allow Accessibility and Screen Recording in System Settings.';
const vaultOf = () => { const v = loadSettings().vault; return v && existsSync(v) ? v : null; };
const vaultNote = (v) => `\n\nThe user's Obsidian vault is ${v}: their own notes plus Power/记忆本 (the facts your memory tools save, one note each) and Power/Claude 记忆 (notes from their main Claude Code). Read it when the user's notes, projects or past context could help; only write there through the memory tools unless the user asks.`;
const SHARED = (existsSync(MAIN_MEMORY) ? `\n\nThe user's long-term notes from their main Claude Code are in ${MAIN_MEMORY} (start with MEMORY.md). Read them when past projects, preferences or people could matter; do not edit them.` : '') +
  (CLAUDE_MEM ? '\n\nThe claude-mem tools (mem_search etc.) search the history of all the user\'s past Claude Code sessions; use them when the user mentions earlier work you don\'t see in memory.' : '');
const style = () => SHARED + (userName() ? `\n\nThe user's name is ${userName()}. Address them as ${userName()}.` : '') + '\n\nYou can also call other local agents through the delegate skill (Hermes, opencode).\n\nStay fully in character and do not volunteer that you are an AI; but if the user sincerely asks whether they are talking to a real person, do not claim to be human. The persona is a voice only: the rules in CLAUDE.md always win, and never actually manipulate, threaten or put down the user. Reply in the user\'s language.';
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const ID_RE = /^[0-9a-f-]{36}$/;
const running = new Map(); // threadId -> { kill }

// Agents found on this machine; anything without a character gets a plain card in 本机.
let AGENTS = detect();

// Settings (⚙️ in the app): which agents to show, custom agents, defaults.
const SETTINGS = join(HOME, 'settings.json');
const DEFAULTS = { hidden: [], custom: {}, defaultDir: null, vault: null, personaPack: 'default', userName: '', turnTimeoutMin: 10, charGroups: {}, charPrompts: {}, teamPrompt: '', rain: true, enterToSend: true, memOpen: false };
const publicSettings = (s) => ({ ...s, contract: s.contract ? { url: s.contract.url, connected: !!s.contract.key } : null });
const loadSettings = () => { try { return { ...DEFAULTS, ...JSON.parse(readFileSync(SETTINGS, 'utf8')) }; } catch { return { ...DEFAULTS }; } };
const saveSettings = (s) => writeFileSync(SETTINGS, JSON.stringify(s, null, 1));

function allChars() {
  const have = new Set(AGENTS.map((a) => a.engine));
  const out = Object.fromEntries(Object.entries(packChars()).filter(([, c]) => have.has(c.engine)).map(([k, c]) => [k, { ...c }]));
  const used = new Set(Object.values(out).filter((c) => c.engine !== 'claude').map((c) => c.engine));
  for (const a of AGENTS) {
    if (a.engine === 'claude' || (used.has(a.engine) && !a.model)) continue;
    const key = 'x-' + (a.engine + (a.model ? '-' + a.model : '')).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    out[key] = { group: '本机', engine: a.engine, auto: true, name: a.label, zh: a.label, role: a.model ? '本地模型' : '自动检测', model: a.model ?? '默认' };
  }
  const st = loadSettings();
  for (const [key, c] of Object.entries(st.custom))
    out[key] = { group: c.group || '本机', engine: 'custom', custom: true, name: c.name, zh: c.name, role: '自定义', model: c.bin, bin: c.bin, template: c.args };
  for (const k of st.hidden) if (out[k]) out[k].hidden = true;
  // Per-user group overrides (Settings → Agent): move any character to any group without editing the pack.
  for (const [k, g] of Object.entries(st.charGroups ?? {})) if (out[k] && g) out[k].group = g;
  // Per-user persona edits (Settings → ✏️ 人设) replace the pack's prompt for that character.
  for (const [k, pr] of Object.entries(st.charPrompts ?? {})) if (out[k] && pr) { out[k].prompt = pr; out[k].edited = true; }
  return out;
}
const binOf = (c) => c.engine === 'custom' ? findBin(c.bin) : AGENTS.find((a) => a.engine === c.engine && (!a.model || a.model === c.model))?.path;

const threadFile = (id) => join(THREADS, `${id}.json`);
const loadThread = (id) => JSON.parse(readFileSync(threadFile(id), 'utf8'));
const saveThread = (t) => writeFileSync(threadFile(t.id), JSON.stringify(t));

// A chat whose last message never got an answer was cut off by a restart: say so instead of leaving it blank.
for (const f of readdirSync(THREADS).filter((x) => x.endsWith('.json'))) {
  try {
    const t = loadThread(f.slice(0, -5)), lastUser = t.events.findLastIndex((e) => e.t === 'user');
    if (lastUser >= 0 && !t.events.slice(lastUser).some((e) => e.t === 'done')) {
      t.events.push({ t: 'done', error: '被中断了（Power 重启），请重新发送这条消息' }); saveThread(t);
    }
  } catch {}
}

function listThreads() {
  return readdirSync(THREADS).filter((f) => f.endsWith('.json'))
    .map((f) => { const t = loadThread(f.slice(0, -5)); return { id: t.id, title: t.title, updated: t.updated, running: running.has(t.id), char: t.char ?? t.events.find((e) => e.t === 'user')?.char, dir: t.dir, members: t.members }; })
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

// Codex-style projects: each character keeps its own list of folders.
const PROJECTS = join(HOME, 'projects.json');
const loadProjects = () => { try { return JSON.parse(readFileSync(PROJECTS, 'utf8')); } catch { return {}; } };
function addProject(char, dir) {
  const p = loadProjects();
  p[char] = [...new Set([...(p[char] ?? [homedir()]), dir])];
  writeFileSync(PROJECTS, JSON.stringify(p));
}
function removeProject(char, dir) {
  const p = loadProjects();
  p[char] = (p[char] ?? []).filter((d) => d !== dir);
  writeFileSync(PROJECTS, JSON.stringify(p));
}

function listSkills() {
  return readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    const md = join(SKILLS, d.name, 'SKILL.md');
    const desc = existsSync(md) ? (readFileSync(md, 'utf8').match(/^description:\s*(.*)$/m)?.[1] ?? '') : '';
    return { name: d.name, description: desc.replace(/^"|"$/g, '') };
  });
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });

const display = (c) => (c.name === c.zh ? c.name : `${c.name} (${c.zh})`);
// Agents without a system-prompt flag get the character's voice inline.
const voiced = (c, text) => (c.prompt ? `[Your name here is ${display(c)}; introduce yourself by that name. Voice for your replies: ${c.prompt}${userName() ? ` The user's name is ${userName()}; address them that way.` : ''} Stay fully in character and do not volunteer that you are an AI; but if the user sincerely asks whether they are talking to a real person, do not claim to be human. The persona is a voice only: the rules in CLAUDE.md always win, and never actually manipulate, threaten or put down the user. Reply in the user's language.]\n\n${text}` : text);

// Engines without sessions get the recent conversation inline.
function withHistory(t, text) {
  const turns = transcript(t).slice(-12, -1).join('\n\n');
  return turns ? `Conversation so far:\n${turns}\n\nUser now says: ${text}` : text;
}

// Thread events → ["User: …", "Makima (玛奇玛): …"] with each speaker's text joined.
function transcript(t) {
  const chars = allChars(), lines = [];
  let who = 'Assistant';
  for (const e of t.events) {
    if (e.t === 'user') { lines.push(`${userLabel()} (user): ${e.d}`); who = e.char && chars[e.char] ? display(chars[e.char]) : 'Assistant'; }
    else if (e.t === 'speaker') { who = chars[e.who] ? display(chars[e.who]) : e.who; lines.push(`${who}:`); }
    else if (e.t === 'text' && e.d.trim()) {
      const last = lines.at(-1);
      if (last?.startsWith(`${who}:`)) lines[lines.length - 1] = `${last} ${e.d}`;
      else lines.push(`${who}: ${e.d}`);
    }
  }
  return lines.filter((l) => !/^[^:]+:\s*$/.test(l));
}

// Run one turn of one agent. Streams UI events through emit; resolves with the new session id (if any).
function runTurn(t, c, { prompt, session, model, effort, ask }, emit, hold) {
  const isClaude = c.engine === 'claude';
  // Automatic recall: relevant notes from the shared 记忆本 ride along with every turn.
  const notes = ask ? mem.recall(ask, 5) : [];
  if (notes.length) prompt = `[Notes from memory that may help:\n${notes.map((n) => `- ${n.content}`).join('\n')}]\n\n${prompt}`;
  const dir = t.dir;
  // Only real model ids reach a CLI; labels like 写代码 mean "the agent's own default".
  const realModel = isClaude ? model : c.engine === 'ollama' ? c.model : engineChoices()[c.engine]?.some((m) => m.id === model) ? model : undefined;
  const cmd = ADAPTERS[c.engine].run({
    prompt: isClaude ? prompt : voiced(c, prompt), dir, session, model: realModel, effort: realModel ? effort : undefined, template: c.template,
    cwd: isClaude ? HOME : dir,
    system: isClaude ? `Your name here is ${display(c)}; introduce yourself by that name (Power is just the app). ` + (c.prompt ?? '') + style() + (vaultOf() ? vaultNote(vaultOf()) : '') + (CUA ? CUA_NOTE : '') + (contractOf() ? CONTRACT_NOTE : '') + `\n\nThe user's working folder is ${dir}. "This folder", "the project" and relative paths mean that folder; use absolute paths under it.` : null,
    extra: isClaude ? ['--plugin-dir', DIR, ...(CLAUDE_MEM ? ['--plugin-dir', CLAUDE_MEM] : []), '--setting-sources', 'project,local', '--permission-mode', 'auto', '--add-dir', dir,
      ...(existsSync(MAIN_MEMORY) ? ['--add-dir', MAIN_MEMORY] : []), ...(vaultOf() ? ['--add-dir', vaultOf()] : []), ...((m) => (m ? ['--mcp-config', m] : []))(mcpConfig()), '--chrome'] : [],
  });
  const bin = binOf(c);
  return new Promise((resolve) => {
    if (!bin) { emit({ t: 'done', error: `找不到 ${c.engine}，点「重新扫描」看看` }); return resolve(null); }
    const st = {}, started = Date.now();
    let buf = '', stderr = '', plain = '', done = false;
    const out = (e) => { if (e.t === 'done') done = true; emit(e); };
    const child = spawn(bin, cmd.args, { cwd: cmd.cwd ?? dir, env: { ...process.env, POWER_HOME: HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
    hold(child);
    // Agents like Hermes print nothing until they finish: send a heartbeat so the UI shows who is working and for how
    // long, and stop a turn that runs past the limit so a group chat never waits forever.
    const limitMs = (Number(loadSettings().turnTimeoutMin) || 10) * 60000;
    let lastOut = Date.now(), timedOut = false;
    const beat = setInterval(() => {
      const ms = Date.now() - started;
      if (ms > limitMs) { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000); return; }
      if (Date.now() - lastOut >= 5000) emit({ t: 'wait', s: Math.round(ms / 1000), who: display(c) });
    }, 5000);
    child.on('error', (e) => { stderr += `启动 ${bin} 失败：${e.message}`; });
    child.stdout.on('data', (chunk) => {
      lastOut = Date.now();
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!cmd.parse) { plain += line + '\n'; continue; }
        try { cmd.parse(JSON.parse(line), out, st); } catch {}
      }
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      clearInterval(beat);
      if (timedOut) { out({ t: 'done', ms: Date.now() - started, error: `${display(c)} 超过 ${limitMs / 60000} 分钟还没完成，已停止（可在 ⚙️ 设置里调整上限）` }); return resolve(null); }
      plain += buf;
      if (!cmd.parse && strip(plain).trim()) { out({ t: 'text_start' }); out({ t: 'text', d: strip(plain).trim() }); }
      if (!done) out({ t: 'done', ms: Date.now() - started, error: code ? (strip(stderr).trim().slice(-500) || `已停止 (${code})`) : null });
      resolve(st.session ?? null);
    });
  });
}

const groupNote = (chars, members, me) =>
  `You are ${display(chars[me])} in a group chat with the user (${userLabel()}) and: ${members.filter((m) => m !== me).map((m) => display(chars[m])).join(', ')}. ` +
  `Work together to solve the user's problem: add what you uniquely bring, build on or correct the others, do not repeat them. Keep it short.` +
  ((t) => (t ? `\n\nTeam rules:\n${t}` : ''))(teamRules());
// Group-chat division of labour: the pack's "team" text, or the user's own version from Settings.
const teamRules = () => loadSettings().teamPrompt?.trim() || loadPack().team || '';

async function send(req, res) {
  const body = await readBody(req);
  const chars = allChars();
  const { thread, text } = body;
  if (!text?.trim()) return json(res, 400, { error: 'bad request' });
  if (thread && !ID_RE.test(thread)) return json(res, 400, { error: 'bad thread' });
  if (thread && running.has(thread)) return json(res, 409, { error: '这个对话还在跑' });

  const t = thread ? loadThread(thread) : { id: randomUUID(), title: text.trim().slice(0, 40), events: [], sessions: {} };
  t.sessions ??= {};
  if (!thread && Array.isArray(body.members)) t.members = body.members.filter((m) => chars[m]).slice(0, 8);
  if (t.members) t.members = t.members.filter((m) => chars[m]);
  const group = t.members?.length > 1;
  const char = group ? null : (t.char ??= body.char && chars[body.char] ? body.char : Object.keys(chars)[0]);
  const c = chars[char];
  if (!group && !c) return json(res, 400, { error: '这个角色的 Agent 没装' });
  // Claude: our model list. Engines with a model menu (Codex): the user's pick, validated. Others: their own default.
  const menu = c ? engineChoices()[c.engine] : null;
  const picked = menu?.find((m) => m.id === body.model);
  // body.model === '' means "the agent's own default"; no model at all means "this character's default".
  const model = c?.engine === 'claude' ? body.model || c.model : body.model === '' ? undefined : picked ? picked.id : c?.model;
  const m = menu?.find((x) => x.id === model);
  const effort = c?.engine === 'claude' ? body.effort || c.effort || 'medium'
    : m ? (m.efforts.includes(body.effort) ? body.effort : m.efforts.includes(c.effort) ? c.effort : undefined) : undefined;
  if (c?.engine === 'claude' && (!MODELS[model] || !EFFORTS.has(effort))) return json(res, 400, { error: 'bad model' });
  if (body.dir) t.dir = body.dir;
  t.dir ??= loadSettings().defaultDir || homedir();
  if (!existsSync(t.dir)) return json(res, 400, { error: `文件夹不存在：${t.dir}` });
  if (!group) addProject(char, t.dir);
  t.updated = new Date().toISOString();
  t.events.push({ t: 'user', d: text, char, model, effort, members: t.members });
  saveThread(t);

  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
  const emit = (e) => {
    // Store merged text so a reload shows the same conversation.
    const last = t.events.at(-1);
    if (e.t === 'text' && last?.t === 'text') last.d += e.d;
    else if (e.t === 'text_start') { if (last?.t === 'text') t.events.push({ t: 'text', d: '' }); }
    else if (e.t === 'thinking') { if (last?.t === 'thinking') last.n = e.n; else t.events.push(e); }
    else if (e.t !== 'wait') t.events.push({ ...e }); // heartbeats are live-only
    if (e.t === 'done') saveThread(t); // a reload mid-group-chat shows everyone who already answered
    res.write(JSON.stringify(e) + '\n');
  };
  emit({ t: 'thread', id: t.id, title: t.title, dir: t.dir, members: t.members });

  let child = null, stopped = false;
  running.set(t.id, { kill: () => { stopped = true; child?.kill('SIGINT'); } });
  const hold = (ch) => (child = ch);
  try {
    if (!group) {
      const a = ADAPTERS[c.engine];
      const session = a.session ? t.sessions[char] : null;
      const prompt = a.session ? text : withHistory(t, text);
      const s = await runTurn(t, c, { prompt, session, model, effort, ask: text }, emit, hold);
      if (s && a.session) t.sessions[char] = s;
    } else {
      // Group chat: everyone takes a turn seeing what the others said, then the first member wraps up.
      const rounds = Math.min(Math.max(Number(body.rounds) || 1, 1), 3);
      for (let r = 0; r < rounds && !stopped; r++) {
        for (const m of t.members) {
          if (stopped) break;
          const mc = chars[m];
          emit({ t: 'speaker', who: m, model: mc.model });
          const prompt = `${groupNote(chars, t.members, m)}\n\nConversation so far:\n${transcript(t).join('\n\n')}\n\nNow it's your turn, ${display(mc)}.`;
          await runTurn(t, mc, { prompt, model: mc.model, effort: mc.effort ?? 'medium', ask: text }, emit, hold);
        }
      }
      if (!stopped) {
        const lead = t.members[0], lc = chars[lead];
        emit({ t: 'speaker', who: lead, model: lc.model, final: true });
        const prompt = `${groupNote(chars, t.members, lead)}\n\nConversation so far:\n${transcript(t).join('\n\n')}\n\n` +
          `You lead this group. Write the final answer for the user, combining the best of everyone's points and settling disagreements. Start with the answer.`;
        await runTurn(t, lc, { prompt, model: lc.model, effort: lc.effort ?? 'medium', ask: text }, emit, hold);
      }
    }
  } finally {
    running.delete(t.id);
    t.updated = new Date().toISOString();
    saveThread(t);
    res.end();
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/' ) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(join(DIR, 'ui.html'))); }
    if (p === '/api/meta') {
      if (url.searchParams.has('rescan')) AGENTS = detect();
      return json(res, 200, { home: homedir(), version: JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')).version, settings: publicSettings(loadSettings()),
        models: MODELS, packs: listPacks(), engineModels: engineChoices(), agents: AGENTS.map(({ engine, label, model, path }) => ({ engine, label, model, path })),
        chars: Object.fromEntries(Object.entries(allChars()).map(([k, { prompt, ...v }]) => [k, v])) });
    }
    if (p.startsWith('/avatar/')) {
      const c = p.slice(8);
      if (c !== 'me' && c !== 'logo' && !allChars()[c]) return json(res, 404, {});
      if (req.method === 'POST') {
        const ext = Object.keys(IMG).find((k) => IMG[k] === req.headers['content-type']);
        if (!ext) return json(res, 415, { error: '只支持 png/jpg/webp/gif' });
        const chunks = []; let n = 0;
        for await (const ch of req) { n += ch.length; if (n > 8e6) return json(res, 413, { error: '图片太大（最多 8MB）' }); chunks.push(ch); }
        const old = avatarFile(c); if (old) unlinkSync(join(AVATARS, old));
        writeFileSync(join(AVATARS, `${c}.${ext}`), Buffer.concat(chunks));
        return json(res, 200, {});
      }
      const f = avatarOf(c);
      if (!f) return json(res, 404, {});
      res.writeHead(200, { 'content-type': IMG[f.split('.').pop()], 'cache-control': 'no-cache' });
      return res.end(readFileSync(join(AVATARS, f)));
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req), st = loadSettings();
      if (Array.isArray(b.hidden)) st.hidden = b.hidden.filter((k) => typeof k === 'string');
      if ('defaultDir' in b) { if (b.defaultDir && !existsSync(b.defaultDir)) return json(res, 400, { error: `文件夹不存在：${b.defaultDir}` }); st.defaultDir = b.defaultDir || null; }
      for (const k of ['rain', 'enterToSend', 'memOpen']) if (typeof b[k] === 'boolean') st[k] = b[k];
      if (Number(b.turnTimeoutMin) > 0) st.turnTimeoutMin = Math.min(Number(b.turnTimeoutMin), 120);
      if (typeof b.userName === 'string') st.userName = b.userName.trim().slice(0, 40);
      if (b.charPrompts && typeof b.charPrompts === 'object')
        st.charPrompts = Object.fromEntries(Object.entries(b.charPrompts).map(([k, v]) => [k, String(v ?? '').trim().slice(0, 8000)]).filter(([, v]) => v));
      if (typeof b.teamPrompt === 'string') st.teamPrompt = b.teamPrompt.trim().slice(0, 8000);
      if (b.charGroups && typeof b.charGroups === 'object')
        st.charGroups = Object.fromEntries(Object.entries(b.charGroups).map(([k, g]) => [k, String(g ?? '').trim().slice(0, 20)]).filter(([, g]) => g));
      if (typeof b.personaPack === 'string') { if (!listPacks()[b.personaPack]) return json(res, 400, { error: `没有这个角色包：${b.personaPack}` }); st.personaPack = b.personaPack; }
      if ('vault' in b) { if (b.vault && !existsSync(b.vault)) return json(res, 400, { error: `文件夹不存在：${b.vault}` }); st.vault = b.vault || null; }
      saveSettings(st);
      return json(res, 200, publicSettings(st));
    }
    if (p === '/api/settings') return json(res, 200, publicSettings(loadSettings()));
    if (p.startsWith('/api/persona/')) {
      const k = decodeURIComponent(p.slice(13)), c = allChars()[k];
      if (!c) return json(res, 404, {});
      return json(res, 200, { prompt: c.prompt ?? '', pack: packChars()[k]?.prompt ?? '', edited: !!c.edited });
    }
    if (p === '/api/team') return json(res, 200, { team: teamRules(), pack: loadPack().team ?? '', edited: !!loadSettings().teamPrompt?.trim() });
    if (p === '/api/custom' && req.method === 'POST') {
      const b = await readBody(req), st = loadSettings();
      if (b.remove) { delete st.custom[b.remove]; st.hidden = st.hidden.filter((k) => k !== b.remove); saveSettings(st); return json(res, 200, {}); }
      const name = String(b.name ?? '').trim(), bin = String(b.bin ?? '').trim();
      if (!name || !bin) return json(res, 400, { error: '名字和命令都要填' });
      if (!findBin(bin)) return json(res, 400, { error: `找不到命令：${bin}` });
      const key = 'c-' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || randomUUID().slice(0, 8));
      st.custom[key] = { name, bin, args: String(b.args ?? '{prompt}').trim() || '{prompt}', group: String(b.group ?? '').trim() || '本机' };
      saveSettings(st);
      return json(res, 200, { key });
    }
    if (p === '/api/open-data' && req.method === 'POST') { spawn('open', [HOME]); return json(res, 200, {}); }
    if (p === '/api/contract') {
      // What the crew can call through the Contract gateway, and how many credits are left. The key stays here.
      const k = contractOf();
      if (!k) return json(res, 200, { connected: false });
      try {
        const h = { authorization: `Bearer ${k.key}` };
        const [tools, bal] = await Promise.all([fetch(`${k.url}/v1/tools`, { headers: h }), fetch(`${k.url}/v1/account/balance`, { headers: h })]);
        if (!tools.ok) throw new Error(`${tools.status}`);
        return json(res, 200, { connected: true, url: k.url, ...(await tools.json()), balance: bal.ok ? await bal.json() : null });
      } catch (e) { return json(res, 200, { connected: false, url: k.url, error: `网关连不上（${e.message}）。Docker 开着吗？` }); }
    }
    if (p === '/api/open-vault' && req.method === 'POST') {
      const v = vaultOf(); if (!v) return json(res, 400, { error: '还没设置 Obsidian 库' });
      spawn('open', [`obsidian://open?path=${encodeURIComponent(join(v, 'Power'))}`]); return json(res, 200, {});
    }
    if (p === '/api/clear-chats' && req.method === 'POST') {
      for (const f of readdirSync(THREADS)) if (f.endsWith('.json') && !running.has(f.slice(0, -5))) unlinkSync(join(THREADS, f));
      return json(res, 200, {});
    }
    if (p === '/api/projects' && req.method === 'POST') {
      const { char, dir, remove } = await readBody(req);
      if (!allChars()[char] || typeof dir !== 'string') return json(res, 400, {});
      if (remove) removeProject(char, dir);
      else if (existsSync(dir)) addProject(char, dir);
      else return json(res, 400, { error: `文件夹不存在：${dir}` });
      return json(res, 200, {});
    }
    if (p === '/api/projects') {
      const p = loadProjects();
      return json(res, 200, Object.fromEntries(Object.keys(allChars()).map((c) => [c, p[c] ?? [homedir()]])));
    }
    if (p === '/api/rename' && req.method === 'POST') {
      const { id, title } = await readBody(req);
      const name = String(title ?? '').trim().slice(0, 60);
      if (!ID_RE.test(id ?? '') || !existsSync(threadFile(id)) || !name) return json(res, 400, { error: '名字不能为空' });
      if (running.has(id)) return json(res, 409, { error: '还在聊，等它们说完再改名' });
      const t = loadThread(id); t.title = name; saveThread(t);
      return json(res, 200, {});
    }
    if (p === '/api/threads') return json(res, 200, listThreads());
    if (p.startsWith('/api/thread/')) {
      const id = p.slice(12);
      if (!ID_RE.test(id) || !existsSync(threadFile(id))) return json(res, 404, {});
      return json(res, 200, { ...loadThread(id), running: running.has(id) });
    }
    if (p === '/api/send' && req.method === 'POST') return await send(req, res);
    if (p === '/api/stop' && req.method === 'POST') { const { thread } = await readBody(req); running.get(thread)?.kill('SIGINT'); return json(res, 200, {}); }
    if (p === '/api/memory') {
      const q = url.searchParams.get('q');
      return json(res, 200, { memories: q ? mem.search(q, 50) : mem.recent(50), skills: listSkills() });
    }
    if (p === '/api/forget' && req.method === 'POST') { const { id } = await readBody(req); mem.forget(Number(id)); return json(res, 200, {}); }
    json(res, 404, {});
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, '127.0.0.1', () => console.log(`Power → http://127.0.0.1:${PORT}`));
