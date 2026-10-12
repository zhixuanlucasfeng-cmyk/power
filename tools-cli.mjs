#!/usr/bin/env node
// Fallback for agent CLIs with shell access but no per-run MCP configuration.
import { toolCatalog, parseTool } from './power-tools.mjs';
const [name, raw] = process.argv.slice(2);
if (!name || name === 'list') console.log(JSON.stringify(toolCatalog(), null, 2));
else {
  try {
    const args = parseTool(name, JSON.parse(raw ?? '{}'));
    if (!process.env.POWER_TOOL_TOKEN) throw new Error('Run this tool inside an active Power agent turn.');
    const r = await fetch(`http://127.0.0.1:${process.env.POWER_PORT || 4545}/api/agent-tools`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.POWER_TOOL_TOKEN}` }, body: JSON.stringify({ name, args }),
    });
    const result = await r.json();
    console.log(JSON.stringify(result, null, 2));
    if (!r.ok || result.isError) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
