import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemory } from './memory.mjs';

const dir = mkdtempSync(join(tmpdir(), 'power-'));
const mem = openMemory(join(dir, 'mem'), join(dir, 'skills'));

test('save, search (zh + en + short term), forget', () => {
  const a = mem.save('用户喜欢喝乌龙茶', 'preference');
  mem.save('Deploy target is Render', 'project');
  assert.equal(mem.search('乌龙茶')[0].id, a);
  assert.equal(mem.search('茶')[0].id, a); // single character still matches
  assert.match(mem.search('render deploy')[0].content, /Render/);
  assert.equal(mem.search('"; drop').length, 0); // odd input is just text
  assert.ok(mem.forget(a));
  assert.equal(mem.search('乌龙茶').length, 0);
});

test('facts are Markdown notes; hand-written notes are found too', () => {
  const id = mem.save('用户喜欢吃果酱面包', 'food like');
  const note = readdirSync(join(dir, 'mem')).find((f) => f.startsWith(`${id} `));
  assert.match(readFileSync(join(dir, 'mem', note), 'utf8'), /^---\nid: \d+\ntags: \[food, like\]/);
  writeFileSync(join(dir, 'mem', '我自己写的.md'), '用户的生日在冬天\n');
  assert.equal(mem.search('生日')[0].content, '用户的生日在冬天');
  assert.equal(mem.recent(10).length, 3);
});

test('skills: write, overwrite own, refuse foreign and bad names', () => {
  const f = mem.saveSkill('deploy-render', 'Deploy: to Render\nsafely', '1. push');
  assert.match(readFileSync(f, 'utf8'), /description: "Deploy: to Render safely"/);
  mem.saveSkill('deploy-render', 'v2', '1. push\n2. check /health');
  assert.match(readFileSync(f, 'utf8'), /check \/health/);
  mkdirSync(join(dir, 'skills', 'mine'));
  writeFileSync(join(dir, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\nhand-written');
  assert.throws(() => mem.saveSkill('mine', 'x', 'y'), /refusing/);
  assert.throws(() => mem.saveSkill('../etc', 'x', 'y'), /must match/);
});

test('recall finds notes for a whole Chinese sentence', () => {
  mem.save('claude-usage 的完整代码在 worktree 里', 'project');
  assert.match(mem.recall('claude-usage 的代码在哪？')[0].content, /worktree/);
  assert.equal(mem.recall('今天天气').length, 0);
});
