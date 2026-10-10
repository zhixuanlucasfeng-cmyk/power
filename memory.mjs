// Hermes-style memory: one Markdown note per fact (an Obsidian folder works as-is) + self-written skills.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

const MARK = 'power-memory'; // only skills carrying this author may be overwritten
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STOP = new Set(['the', 'is', 'and', 'you', 'me', 'my', 'to', 'of', '一下', '什么', '怎么', '你们', '我们', '这个', '那个', '一个', '是不', '不是', '可以', '告诉', '知道']);

// Where facts live: <vault>/Power/记忆本 when an Obsidian vault is set in settings.json, else <home>/memory.
export function memoryDir(home) {
  try {
    const { vault } = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    if (vault && existsSync(vault)) return join(vault, 'Power', '记忆本');
  } catch {}
  return join(home, 'memory');
}

// Facts are plain notes, so people can also add or edit them by hand in Obsidian.
function parse(dir, file) {
  const raw = readFileSync(join(dir, file), 'utf8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = fm ? fm[1] : '';
  const get = (k) => meta.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1].trim() ?? '';
  const id = Number(get('id') || file.match(/^(\d+)\s/)?.[1]) || null;
  const tags = get('tags').replace(/^\[|\]$/g, '').split(/[,\s]+/).filter(Boolean).join(' ');
  return { id, content: (fm ? raw.slice(fm[0].length) : raw).trim(), tags, created: get('created'), file };
}

export function openMemory(dir, skillsDir) {
  mkdirSync(dir, { recursive: true });
  // ponytail: reads every note per call; fine for thousands of facts, add an index if it ever isn't.
  const all = () => readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parse(dir, f));
  const pub = ({ file, ...m }) => m;

  function save(content, tags = '') {
    const id = Math.max(0, ...all().map((m) => m.id ?? 0)) + 1;
    const title = content.trim().split('\n')[0].replace(/[\\/:*?"<>|#^[\]]/g, ' ').slice(0, 40).trim();
    const tagList = tags.split(/\s+/).filter(Boolean);
    writeFileSync(join(dir, `${id} ${title}.md`),
      `---\nid: ${id}\ntags: [${tagList.join(', ')}]\ncreated: ${new Date().toISOString()}\n---\n\n${content.trim()}\n`);
    return id;
  }

  // Substring match (works for Chinese without a segmenter); more matched terms rank first, then newest.
  function search(query, limit = 5) {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return recent(limit);
    return all()
      .map((m) => ({ m, score: terms.filter((t) => `${m.content} ${m.tags}`.toLowerCase().includes(t)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.m.id ?? 0) - (a.m.id ?? 0))
      .slice(0, limit).map((x) => pub(x.m));
  }

  // For a whole sentence (no spaces in Chinese): score notes by shared words and Chinese character pairs.
  function recall(text, limit = 5) {
    const t = text.toLowerCase();
    const words = t.match(/[a-z0-9][a-z0-9_-]+/g) ?? [];
    const pairs = (t.match(/[\u4e00-\u9fff]+/g) ?? []).flatMap((run) => [...run].slice(0, -1).map((c, i) => c + run[i + 1]));
    const keys = [...new Set([...words, ...pairs])].filter((k) => !STOP.has(k));
    if (!keys.length) return [];
    return all()
      .map((m) => { const hay = `${m.content} ${m.tags}`.toLowerCase(); return { m, score: keys.filter((k) => hay.includes(k)).length }; })
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score || (b.m.id ?? 0) - (a.m.id ?? 0))
      .slice(0, limit).map((x) => pub(x.m));
  }

  function recent(limit = 5) {
    return all().sort((a, b) => (b.id ?? 0) - (a.id ?? 0) || b.created.localeCompare(a.created)).slice(0, limit).map(pub);
  }

  function forget(id) {
    const m = all().find((x) => x.id === id);
    if (!m) return false;
    unlinkSync(join(dir, m.file));
    return true;
  }

  function saveSkill(name, description, body) {
    if (!NAME_RE.test(name)) throw new Error(`skill name must match ${NAME_RE}`);
    const file = join(skillsDir, name, 'SKILL.md');
    if (existsSync(file) && !readFileSync(file, 'utf8').includes(`author: ${MARK}`)) {
      throw new Error(`skill "${name}" was not written by ${MARK}; refusing to overwrite`);
    }
    const desc = JSON.stringify(description.replace(/\s+/g, ' ').trim()); // JSON string is valid YAML
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `---\nname: ${name}\ndescription: ${desc}\nmetadata:\n  author: ${MARK}\n  updated: ${new Date().toISOString()}\n---\n\n${body.trim()}\n`);
    return file;
  }

  return { save, search, recall, recent, forget, saveSkill, close: () => {} };
}
