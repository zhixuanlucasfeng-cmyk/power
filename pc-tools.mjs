// Computer steward: find files by content, read-only system diagnosis, tidy folders, clean junk.
// Everything runs locally. Search uses the OS index (Spotlight / Windows Search); nothing is uploaded.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import { previewFile } from './artifacts.mjs';

const WIN = process.platform === 'win32', MAC = process.platform === 'darwin';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a system command; transient failures are retried 3 times before the error is reported.
export async function run(cmd, args, { timeout = 20000, tries = 3, maxBuffer = 20e6 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await new Promise((ok, no) => execFile(cmd, args, { timeout, maxBuffer, windowsHide: true }, (e, out, err) => (e && !out ? no(Object.assign(e, { stderr: err })) : ok(String(out)))));
    } catch (e) { last = e; if (i < tries - 1) await sleep(500 * (i + 1)); }
  }
  throw new Error(`${cmd} 执行失败（已重试 ${tries} 次）：${String(last?.stderr || last?.message || last).trim().slice(0, 300)}`);
}
const ps = (script, opts) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], opts);

// ---------- find_files ----------
export const KINDS = {
  word: ['.doc', '.docx', '.rtf', '.pages', '.odt'], excel: ['.xls', '.xlsx', '.csv', '.numbers', '.ods'], ppt: ['.ppt', '.pptx', '.key', '.odp'],
  pdf: ['.pdf'], text: ['.txt', '.md', '.markdown'],
  code: ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.swift', '.kt', '.rb', '.php', '.html', '.css', '.sh', '.json', '.yaml', '.yml', '.sql'],
};
const SKIP = /[\\/](Library|AppData|node_modules|\.git|\.Trash|\$Recycle\.Bin|Windows|Program Files[^\\/]*|System|Applications)[\\/]|\.app[\\/]/i;

async function indexSearch(term) {
  if (MAC) return (await run('mdfind', [term], { tries: 2 })).split('\n');
  if (WIN) {
    const q = term.replace(/["']/g, ' ').trim();
    return (await ps(`$c=New-Object -ComObject ADODB.Connection;$r=New-Object -ComObject ADODB.Recordset;` +
      `$c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';");` +
      `$r.Open("SELECT TOP 500 System.ItemPathDisplay FROM SYSTEMINDEX WHERE CONTAINS(*,'""${q}""') OR System.FileName LIKE '%${q}%'",$c);` +
      `while(-not $r.EOF){$r.Fields.Item('System.ItemPathDisplay').Value;$r.MoveNext()}`, { tries: 2 })).split(/\r?\n/);
  }
  throw new Error('当前系统暂不支持索引搜索（支持 macOS 和 Windows）');
}

// Merge per-term hits: more matched terms first, then filename matches, then newest.
export function rank(hitsByTerm, { kinds, stat = statSync } = {}) {
  const exts = kinds?.length ? new Set(kinds.flatMap((k) => KINDS[k] ?? [])) : null;
  const score = new Map();
  for (const [term, paths] of hitsByTerm) for (const p of new Set(paths)) {
    if (!p || SKIP.test(p) || (exts && !exts.has(extname(p).toLowerCase()))) continue;
    const s = score.get(p) ?? { path: p, terms: [], nameHits: 0 };
    s.terms.push(term);
    if (basename(p).toLowerCase().includes(term.toLowerCase())) s.nameHits++;
    score.set(p, s);
  }
  return [...score.values()].flatMap((s) => {
    try { const i = stat(s.path); return i.isFile() ? [{ ...s, modified: i.mtime.toISOString(), size: i.size }] : []; } catch { return []; }
  }).sort((a, b) => b.terms.length - a.terms.length || b.nameHits - a.nameHits || b.modified.localeCompare(a.modified));
}

export async function snippet(path, terms) {
  const ext = extname(path).toLowerCase();
  let text = '';
  try {
    if (['.docx', '.pptx', '.xlsx'].includes(ext)) text = ((await previewFile(path)).html ?? '').replace(/<[^>]+>/g, ' ');
    else if ([...KINDS.text, ...KINDS.code, '.csv'].includes(ext) && statSync(path).size < 5e6) text = readFileSync(path, 'utf8');
    else if (MAC && ['.doc', '.rtf', '.pages', '.odt'].includes(ext)) text = await run('textutil', ['-convert', 'txt', '-stdout', path], { tries: 1 });
  } catch { return ''; }
  text = text.replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ');
  const lower = text.toLowerCase(), at = Math.min(...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0), Infinity);
  return at === Infinity ? text.slice(0, 160) : `…${text.slice(Math.max(0, at - 70), at + 110)}…`;
}

export async function findFiles({ terms, kinds, limit = 10 }) {
  const list = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].slice(0, 6);
  if (!list.length) throw new Error('请至少给一个关键词');
  const hits = [];
  for (const t of list) hits.push([t, (await indexSearch(t)).slice(0, 3000)]);
  const ranked = rank(hits, { kinds }).slice(0, limit);
  for (const r of ranked) r.snippet = await snippet(r.path, list);
  return ranked.length ? { results: ranked }
    : { results: [], hint: MAC ? '没找到。换同义词或更短的关键词再试；如果什么都搜不到，可能是 Spotlight 索引关闭了，在终端运行 mdutil -s / 查看。'
      : '没找到。换同义词或更短的关键词再试；如果什么都搜不到，确认 Windows Search 服务已开启，并在“索引选项”里包含了文件所在的磁盘。' };
}

// Only documents and media open directly; never launch programs or scripts.
const OPENABLE = new Set([...Object.values(KINDS).flat().filter((e) => !['.sh', '.js', '.mjs', '.py', '.rb', '.php'].includes(e)),
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.mp3', '.m4a', '.wav', '.mp4', '.mov', '.mkv', '.zip']);
export function openFile(path) {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error('文件不存在，请用搜索结果里的绝对路径');
  if (!OPENABLE.has(extname(path).toLowerCase())) throw new Error('出于安全考虑，只能直接打开文档、图片、音视频和压缩包，不能运行程序或脚本');
  spawn(WIN ? 'explorer.exe' : MAC ? 'open' : 'xdg-open', [path], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  return { opened: path };
}

// ---------- system_check (read-only) ----------
const top = (out, n = 8) => out.trim().split('\n').slice(1, n + 1).map((l) => { const [pid, cpu, mem, rss, ...cmd] = l.trim().split(/\s+/); return { pid: +pid, cpu: +cpu, mem: +mem, rssMB: Math.round(rss / 1024), name: basename(cmd.join(' ')) }; });
async function duMB(dir) { if (!existsSync(dir)) return 0; try { return Math.round(+(await run('du', ['-sk', dir], { timeout: 30000, tries: 1 })).split(/\s/)[0] / 1024); } catch { return null; } }

async function macCheck(topic) {
  const r = {}, want = (...t) => topic === 'overview' || t.includes(topic);
  const boot = +(await run('sysctl', ['-n', 'kern.boottime'])).match(/sec = (\d+)/)?.[1];
  r.system = { bootedAt: new Date(boot * 1000).toISOString(), uptimeHours: +((Date.now() / 1000 - boot) / 3600).toFixed(1),
    cpus: +(await run('sysctl', ['-n', 'hw.ncpu'])), load: (await run('sysctl', ['-n', 'vm.loadavg'])).replace(/[{}]/g, '').trim(),
    memoryGB: +(+(await run('sysctl', ['-n', 'hw.memsize'])) / 2 ** 30).toFixed(1),
    memoryFreePercent: +((await run('memory_pressure', ['-Q'], { tries: 1 }).catch(() => '')).match(/(\d+)%/)?.[1] ?? NaN) };
  if (want('slow', 'boot')) {
    r.topCPU = top(await run('ps', ['-Ao', 'pid,pcpu,pmem,rss,comm', '-r']));
    r.topMemory = top(await run('ps', ['-Ao', 'pid,pcpu,pmem,rss,comm', '-m']));
  }
  if (want('disk', 'slow', 'boot')) {
    // The data volume, not the sealed read-only system volume at /.
    const [, , used, avail, cap] = (await run('df', ['-k', homedir()])).trim().split('\n').pop().split(/\s+/);
    r.disk = { usedGB: Math.round(used / 2 ** 20), freeGB: Math.round(avail / 2 ** 20), usedPercent: parseInt(cap),
      smart: (await run('diskutil', ['info', '/'], { tries: 1 }).catch(() => '')).match(/SMART Status:\s*(.+)/)?.[1]?.trim() ?? 'unknown' };
  }
  if (want('boot')) {
    const agents = (d) => { try { return readdirSync(d).filter((f) => f.endsWith('.plist')); } catch { return []; } };
    r.startup = { userAgents: agents(join(homedir(), 'Library/LaunchAgents')), systemAgents: agents('/Library/LaunchAgents'), daemons: agents('/Library/LaunchDaemons'),
      note: '登录项（打开就启动的 App）在“系统设置 → 通用 → 登录项”里查看和关闭。' };
  }
  if (want('slow', 'disk')) {
    const h = homedir();
    const [caches, logs, trash, downloads] = await Promise.all(['Library/Caches', 'Library/Logs', '.Trash', 'Downloads'].map((d) => duMB(join(h, d))));
    r.junkMB = { caches, logs, trash, downloads, note: 'null = 没有读取权限或目录太大没算完（给终端/Power“完全磁盘访问权限”后可读废纸篓）' };
  }
  return r;
}

async function winCheck(topic) {
  // One PowerShell round trip; the agent explains the numbers.
  const out = await ps(`$o=Get-CimInstance Win32_OperatingSystem;$r=[ordered]@{};` +
    `$r.system=@{bootedAt=$o.LastBootUpTime.ToString('o');memoryGB=[math]::Round($o.TotalVisibleMemorySize/1MB,1);memoryFreePercent=[math]::Round(100*$o.FreePhysicalMemory/$o.TotalVisibleMemorySize);cpuLoad=(Get-CimInstance Win32_Processor|Measure-Object LoadPercentage -Average).Average};` +
    `$r.topMemory=Get-Process|Sort-Object WS -Descending|Select-Object -First 8 Id,ProcessName,@{n='rssMB';e={[math]::Round($_.WS/1MB)}},CPU;` +
    `$r.disk=Get-PSDrive -PSProvider FileSystem|Where-Object Used|Select-Object Name,@{n='usedGB';e={[math]::Round($_.Used/1GB)}},@{n='freeGB';e={[math]::Round($_.Free/1GB)}};` +
    `$r.health=Get-PhysicalDisk -ErrorAction SilentlyContinue|Select-Object FriendlyName,HealthStatus;` +
    `$r.startup=Get-CimInstance Win32_StartupCommand|Select-Object Name,Command,Location;` +
    `$r.junkMB=@{temp=[math]::Round(((Get-ChildItem $env:TEMP -Recurse -Force -ErrorAction SilentlyContinue|Measure-Object Length -Sum).Sum)/1MB)};` +
    `$r|ConvertTo-Json -Depth 4 -Compress`, { timeout: 60000 });
  const r = JSON.parse(out);
  if (topic === 'disk') delete r.startup;
  return r;
}

export async function systemCheck({ topic = 'overview' }) {
  if (!MAC && !WIN) throw new Error('系统诊断目前支持 macOS 和 Windows');
  const report = await (MAC ? macCheck(topic) : winCheck(topic));
  return { platform: process.platform, topic, checkedAt: new Date().toISOString(), ...report,
    rule: '这是只读诊断。任何修改（关闭启动项、清理、改设置）都要先向用户说明并取得明确同意。' };
}

// ---------- organize_files ----------
export const BUCKETS = {
  视频: ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm', '.m4v'], 图片: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.bmp', '.svg', '.tiff'],
  音频: ['.mp3', '.m4a', '.wav', '.flac', '.aac', '.ogg'], 文档: [...KINDS.word, ...KINDS.excel, ...KINDS.ppt, ...KINDS.pdf, ...KINDS.text, '.epub'],
  压缩包: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz'], 安装包: ['.dmg', '.pkg', '.exe', '.msi', '.apk'],
};
const PARTIAL = /\.(crdownload|download|part|tmp)$/i;
function insideHome(dir, home) { const rel = relative(home, dir); return isAbsolute(dir) && rel && !rel.startsWith('..') && !isAbsolute(rel); }
function freeName(dir, name) {
  if (!existsSync(join(dir, name))) return join(dir, name);
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) if (!existsSync(join(dir, `${stem} (${i})${ext}`))) return join(dir, `${stem} (${i})${ext}`);
}

// Moves top-level files into type folders. Nothing is deleted; every move is logged so it can be undone.
export function tidyFolder({ folder, dryRun = true, home = homedir(), logDir }) {
  if (!insideHome(folder, home) || !existsSync(folder)) throw new Error('只能整理你个人目录下已存在的文件夹，请给绝对路径');
  const plan = [];
  for (const f of readdirSync(folder)) {
    if (f.startsWith('.') || PARTIAL.test(f)) continue;
    const src = join(folder, f);
    if (!statSync(src).isFile()) continue;
    const bucket = Object.keys(BUCKETS).find((b) => BUCKETS[b].includes(extname(f).toLowerCase()));
    if (bucket) plan.push({ from: src, bucket });
  }
  const counts = Object.fromEntries(Object.keys(BUCKETS).map((b) => [b, plan.filter((p) => p.bucket === b).length]).filter(([, n]) => n));
  if (dryRun) return { dryRun: true, files: plan.length, counts };
  const moved = [], failed = [];
  for (const p of plan) {
    try { mkdirSync(join(folder, p.bucket), { recursive: true }); const to = freeName(join(folder, p.bucket), basename(p.from)); renameSync(p.from, to); moved.push({ from: p.from, to }); }
    catch (e) { failed.push({ file: p.from, error: e.message }); }
  }
  let undoLog;
  if (moved.length && logDir) { mkdirSync(logDir, { recursive: true }); undoLog = join(logDir, `tidy-${Date.now()}.json`); writeFileSync(undoLog, JSON.stringify(moved, null, 1)); }
  return { dryRun: false, files: moved.length, counts, failed, undoLog };
}

// Junk = files older than keepDays in user caches, logs and the temp folder. Cleaning moves them to the Trash / Recycle Bin.
export function junkRoots(home = homedir()) {
  return MAC ? [join(home, 'Library/Caches'), join(home, 'Library/Logs'), tmpdir()]
    : WIN ? [process.env.TEMP || tmpdir(), join(home, 'AppData/Local/Temp')] : [join(home, '.cache'), tmpdir()];
}
export function findJunk({ keepDays = 30, roots = junkRoots(), now = Date.now(), cap = 20000 }) {
  const cutoff = now - keepDays * 864e5, files = [];
  let bytes = 0;
  const walk = (dir, depth) => {
    if (files.length >= cap || depth > 8) return;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) { try { const i = statSync(p); if (i.mtimeMs < cutoff) { files.push(p); bytes += i.size; } } catch {} }
      if (files.length >= cap) return;
    }
  };
  for (const r of [...new Set(roots)]) if (existsSync(r)) walk(r, 0);
  return { files, bytes, roots: [...new Set(roots)].filter(existsSync), capped: files.length >= cap };
}
async function toTrash(files) {
  const failed = [];
  if (MAC) {
    // One dated folder in the Trash; the index prefix avoids name clashes between cache files.
    const bin = join(homedir(), '.Trash', `Power 清理 ${new Date().toISOString().slice(0, 16).replace(':', '.')}`);
    mkdirSync(bin, { recursive: true });
    files.forEach((f, i) => { try { renameSync(f, join(bin, `${i}-${basename(f)}`)); } catch { failed.push(f); } });
  } else if (WIN) {
    const list = join(tmpdir(), `power-junk-${Date.now()}.txt`);
    writeFileSync(list, files.join('\r\n'));
    await ps(`Add-Type -AssemblyName Microsoft.VisualBasic;Get-Content -LiteralPath '${list.replace(/'/g, "''")}'|ForEach-Object{try{[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_,'OnlyErrorDialogs','SendToRecycleBin')}catch{}}`, { timeout: 600000, tries: 1 });
    failed.push(...files.filter(existsSync));
  } else throw new Error('清理目前支持 macOS 和 Windows');
  return failed;
}
export async function cleanJunk({ keepDays = 30, dryRun = true, confirm, roots }) {
  const junk = findJunk({ keepDays, roots });
  const summary = { dryRun, keepDays, files: junk.files.length, sizeMB: Math.round(junk.bytes / 2 ** 20), folders: junk.roots, capped: junk.capped };
  if (dryRun || !junk.files.length) return summary;
  if (!(await confirm(`把 ${summary.files} 个超过 ${keepDays} 天的缓存/日志/临时文件（约 ${summary.sizeMB} MB）移到${WIN ? '回收站' : '废纸篓'}。\n范围：${junk.roots.join('、')}`))) return { ...summary, cancelled: true };
  const failed = await toTrash(junk.files);
  return { ...summary, dryRun: false, moved: junk.files.length - failed.length, failed: failed.length,
    note: `已移到${WIN ? '回收站' : '废纸篓'}，清空${WIN ? '回收站' : '废纸篓'}后才真正释放空间；想恢复可以从里面拖回来。` };
}
