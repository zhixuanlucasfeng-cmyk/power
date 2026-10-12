import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { cleanJunk, findJunk, openFile, rank, snippet, systemCheck, tidyFolder } from './pc-tools.mjs';
import { isDue } from './schedules.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'power-pc-'));

test('find_files ranking: more matched terms first, then filename hits, then newest; kinds and junk paths filtered', () => {
  const times = { '/u/a.docx': 1, '/u/b.docx': 3, '/u/本草纲目.docx': 2, '/u/c.pdf': 9, '/u/node_modules/x.docx': 9 };
  const stat = (p) => ({ isFile: () => true, mtime: new Date(times[p] * 1e12), size: 1 });
  const hits = [['本草纲目', ['/u/a.docx', '/u/b.docx', '/u/本草纲目.docx', '/u/c.pdf', '/u/node_modules/x.docx']], ['脚本', ['/u/a.docx']]];
  assert.deepEqual(rank(hits, { stat }).map((r) => r.path), ['/u/a.docx', '/u/本草纲目.docx', '/u/c.pdf', '/u/b.docx']);
  assert.deepEqual(rank(hits, { kinds: ['pdf'], stat }).map((r) => r.path), ['/u/c.pdf']);
});

test('find_files snippets come from inside text and Word files', async () => {
  const d = dir();
  writeFileSync(join(d, 'note.md'), `${'开头'.repeat(100)} 这里提到了本草纲目的章节 ${'结尾'.repeat(100)}`);
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>电脑管家 稿子 第一版</w:t></w:r></w:p></w:body></w:document>');
  writeFileSync(join(d, 'draft.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  assert.match(await snippet(join(d, 'note.md'), ['本草纲目']), /本草纲目的章节/);
  assert.match(await snippet(join(d, 'draft.docx'), ['电脑管家']), /电脑管家 稿子/);
});

test('open refuses programs and scripts', () => {
  const d = dir();
  writeFileSync(join(d, 'run.sh'), 'echo hi');
  assert.throws(() => openFile(join(d, 'run.sh')), /只能直接打开/);
  assert.throws(() => openFile('relative.docx'), /不存在/);
});

test('tidy: dry run counts, real run moves by type without overwriting, skips partial downloads, logs undo', () => {
  const home = dir(), dl = join(home, 'Downloads'), logs = join(home, 'logs');
  mkdirSync(join(dl, '视频'), { recursive: true });
  for (const f of ['a.mp4', 'b.JPG', 'c.mp3', 'd.pdf', 'e.zip', 'f.crdownload', '.hidden', 'g.unknown']) writeFileSync(join(dl, f), f);
  writeFileSync(join(dl, '视频', 'a.mp4'), 'older');
  const plan = tidyFolder({ folder: dl, home });
  assert.deepEqual(plan, { dryRun: true, files: 5, counts: { 视频: 1, 图片: 1, 音频: 1, 文档: 1, 压缩包: 1 } });
  assert.ok(existsSync(join(dl, 'b.JPG')), 'dry run moves nothing');
  const done = tidyFolder({ folder: dl, home, dryRun: false, logDir: logs });
  assert.equal(done.files, 5);
  assert.deepEqual(readdirSync(join(dl, '视频')).sort(), ['a (1).mp4', 'a.mp4']);
  assert.equal(readFileSync(join(dl, '视频', 'a.mp4'), 'utf8'), 'older', 'existing file kept');
  assert.ok(existsSync(join(dl, 'f.crdownload')) && existsSync(join(dl, 'g.unknown')));
  assert.equal(JSON.parse(readFileSync(done.undoLog, 'utf8')).length, 5);
  assert.throws(() => tidyFolder({ folder: '/etc', home }), /个人目录/);
});

test('clean: only files older than keep_days; nothing moves without approval', async () => {
  const root = dir(), old = join(root, 'cache', 'old.bin'), fresh = join(root, 'fresh.log');
  mkdirSync(join(root, 'cache'));
  writeFileSync(old, 'x'.repeat(2048)); writeFileSync(fresh, 'y');
  const past = new Date(Date.now() - 40 * 864e5); utimesSync(old, past, past);
  assert.deepEqual(findJunk({ keepDays: 30, roots: [root] }).files, [old]);
  assert.equal((await cleanJunk({ keepDays: 30, roots: [root] })).files, 1, 'dry run by default');
  const r = await cleanJunk({ keepDays: 30, roots: [root], dryRun: false, confirm: async () => false });
  assert.equal(r.cancelled, true);
  assert.ok(existsSync(old));
});

test('monthly schedules run once on their day', () => {
  const s = { enabled: true, when: { type: 'monthly', day: 1, time: '03:00' } };
  assert.equal(isDue(s, new Date(2026, 10, 1, 3, 5)), true);
  assert.equal(isDue(s, new Date(2026, 10, 2, 3, 5)), false);
  assert.equal(isDue({ ...s, lastRun: new Date(2026, 10, 1, 3, 1).toISOString() }, new Date(2026, 10, 1, 9)), false);
});

test('system check reports memory and disk (read-only)', { skip: !['darwin', 'win32'].includes(process.platform), timeout: 120000 }, async () => {
  const r = await systemCheck({ topic: 'boot' });
  assert.ok(r.system.memoryGB > 0);
  assert.ok(Array.isArray(r.topMemory) && r.topMemory.length);
  assert.ok(r.disk);
});
