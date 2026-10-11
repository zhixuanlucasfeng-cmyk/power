#!/usr/bin/env node
// MCP stdio server exposing Power's memory to Claude Code (or any MCP client).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openMemory, memoryDir } from './memory.mjs';

// Power runs Claude Code with cwd = POWER_HOME, so <POWER_HOME>/.claude/skills are its project skills.
const home = process.env.POWER_HOME || join(homedir(), '.power');
const skillsDir = process.env.POWER_SKILLS_DIR || join(home, '.claude', 'skills');
const mem = openMemory(memoryDir(home), skillsDir);

const instructions = `Long-term memory and self-written skills.
- Before a task where past context may matter, call memory_search.
- When the user asks you to remember something, or you learn a durable preference/fact, call memory_save. One fact per call.
- After finishing a multi-step task that is likely to recur, call skill_save to record the working procedure as a reusable skill. To improve a skill you wrote earlier, save it again under the same name.`;

const server = new McpServer({ name: 'power-memory', version: '0.1.0' }, { instructions });
const text = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

// Send confirmation card: blocks until the user taps 发送 / 取消 in the Power app (or 10 minutes pass).
server.registerTool('confirm_send', {
  description: 'Ask the user to approve a message/post before you send it on their behalf. Returns APPROVED or DENIED. Call it with the exact final text; send only if APPROVED.',
  inputSchema: { platform: z.string().describe('e.g. WeChat, Reddit, email'), recipient: z.string().describe('person, group or place it goes to'), text: z.string().describe('exact text to send') },
}, async ({ platform, recipient, text: body }) => {
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.POWER_PORT || 4545}/api/approvals`, { method: 'POST', body: JSON.stringify({ thread: process.env.POWER_THREAD, platform, recipient, text: body }) });
    return text((await r.json()).approved ? 'APPROVED' : 'DENIED');
  } catch (e) { return { isError: true, ...text(`Power app not reachable (${e.message}); do not send.`) }; }
});

server.registerTool('memory_save', {
  description: 'Save one durable fact or user preference to long-term memory. Returns its id.',
  inputSchema: { content: z.string().min(1), tags: z.string().optional().describe('space-separated tags') },
}, ({ content, tags }) => text(`saved #${mem.save(content, tags)}`));

server.registerTool('memory_search', {
  description: 'Search long-term memory (full-text, Chinese and English). Empty query returns most recent.',
  inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional() },
}, ({ query, limit }) => text(mem.search(query, limit)));

server.registerTool('memory_forget', {
  description: 'Delete a memory by id when it is wrong or outdated.',
  inputSchema: { id: z.number().int() },
}, ({ id }) => text(mem.forget(id) ? `forgot #${id}` : `no memory #${id}`));

server.registerTool('skill_save', {
  description: 'Write a reusable skill (Markdown procedure) the agent will auto-load in future sessions. Name: lowercase-kebab.',
  inputSchema: {
    name: z.string(),
    description: z.string().min(1).describe('one line: what it does and when to use it'),
    body: z.string().min(1).describe('Markdown steps, commands, pitfalls'),
  },
}, ({ name, description, body }) => {
  try { return text(`skill written: ${mem.saveSkill(name, description, body)}`); }
  catch (e) { return { ...text(e.message), isError: true }; }
});

await server.connect(new StdioServerTransport());
