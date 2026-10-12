import { readFileSync, writeFileSync, readdirSync, realpathSync, statSync, copyFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
export const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function scopedFile(path, roots, max = 25e6) {
  if (!isAbsolute(path)) throw new Error('请提供文件绝对路径');
  const file = realpathSync(path);
  const allowed = roots.some((root) => { try { const rel = relative(realpathSync(root), file); return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); } catch { return false; } });
  if (!allowed) throw new Error('文件不在允许的工作目录中');
  const stat = statSync(file); if (!stat.isFile() || stat.size > max) throw new Error('文件类型或大小不支持');
  return file;
}
export function createArtifacts(uploads) {
  const fileFor = (id) => {
    if (typeof id !== 'string' || id !== basename(id) || !/^[\w.\-\u4e00-\u9fff]+$/.test(id)) throw new Error('无效文件 ID');
    return scopedFile(join(uploads, id), [uploads]);
  };
  const describe = (file) => { const id = basename(file), info = statSync(file); return { id, title: id.replace(/^[0-9a-f-]{36}-/, ''), size: info.size, modified: info.mtime.toISOString(), url: `/upload/${encodeURIComponent(id)}`, image: /\.(png|jpe?g|gif|webp)$/i.test(id) }; };
  return {
    fileFor,
    list: () => readdirSync(uploads).filter((f) => { try { fileFor(f); return true; } catch { return false; } }).map((f) => describe(join(uploads, f))).sort((a,b) => b.modified.localeCompare(a.modified)).slice(0, 200),
    add(path, title) { const name = basename(path).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(-100); const file = join(uploads, `${randomUUID()}-${name}`); copyFileSync(path, file); return { ...describe(file), title: title || basename(path) }; },
    async preview(id) { return previewFile(fileFor(id)); },
    saveCopy(id, text) {
      const source = fileFor(id);
      if (!/\.(txt|md|html?|csv|json|css|js|svg)$/i.test(source) || typeof text !== 'string' || Buffer.byteLength(text) > 2e6) throw new Error('只能编辑不超过 2MB 的文本文件');
      const file = join(uploads, `${randomUUID()}-${basename(source).replace(/^[0-9a-f-]{36}-/, '')}`);
      writeFileSync(file, text, { mode: 0o600 }); return describe(file);
    },
  };
}
const shell = (body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font:16px/1.6 system-ui;margin:24px;color:#182133;background:white}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #ddd;padding:5px 10px;white-space:pre-wrap}pre{white-space:pre-wrap;overflow-wrap:anywhere}section{margin:24px 0;padding:24px;border:1px solid #ddd}img{max-width:100%}</style>${body}`;
const list = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: true });
function texts(node, key) { if (!node || typeof node !== 'object') return []; return Object.entries(node).flatMap(([k,v]) => k === key ? list(v).map((x) => typeof x === 'object' ? x['#text'] || '' : x) : list(v).flatMap((x) => texts(x,key))); }
async function checkedZip(buffer) {
  const zip = await JSZip.loadAsync(buffer); let total = 0;
  for (const f of Object.values(zip.files)) { total += f._data?.uncompressedSize || 0; if (total > 80e6 || (f._data?.uncompressedSize || 0) > 20e6) throw new Error('文档解压后过大'); }
  return zip;
}
export async function previewFile(file) {
  const ext = extname(file).toLowerCase(), buffer = readFileSync(file);
  if (ext === '.pdf') return { kind: 'pdf' };
  if (/^\.(png|jpg|jpeg|gif|webp)$/.test(ext)) return { kind: 'image' };
  if (/^\.(mp3|wav|m4a|ogg|mp4|webm)$/.test(ext)) return { kind: ext === '.mp4' || ext === '.webm' ? 'video' : 'audio' };
  if (/^\.(docx|xlsx|pptx)$/.test(ext)) {
    const zip = await checkedZip(buffer);
    if (ext === '.docx') {
      const xml = await zip.file('word/document.xml')?.async('string'); if (!xml) throw new Error('无效 Word 文档');
      const blocks = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
      return { kind: 'html', note: 'Word 内容预览，复杂排版请下载原文件查看。', html: shell(blocks.slice(0,5000).map((p) => `<p>${escapeHTML(texts(parser.parse(p), 'w:t').join(''))}</p>`).join('')) };
    }
    if (ext === '.pptx') {
      const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a,b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
      let html = '';
      for (const [i,n] of slides.slice(0,200).entries()) html += `<section><h2>Slide ${i+1}</h2>${texts(parser.parse(await zip.file(n).async('string')), 'a:t').map((t) => `<p>${escapeHTML(t)}</p>`).join('')}</section>`;
      return { kind: 'html', note: '幻灯片文字预览，原始布局和动画请下载查看。', html: shell(html) };
    }
    const stringsXML = await zip.file('xl/sharedStrings.xml')?.async('string');
    const strings = stringsXML ? list(parser.parse(stringsXML).sst?.si).map((x) => texts(x,'t').join('')) : [];
    const namesXML = await zip.file('xl/workbook.xml')?.async('string');
    const names = namesXML ? list(parser.parse(namesXML).workbook?.sheets?.sheet).map((x) => x['@_name']) : [];
    const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a,b) => Number(a.match(/sheet(\d+)/)[1]) - Number(b.match(/sheet(\d+)/)[1]));
    let html = '';
    for (const [i,n] of sheets.slice(0,30).entries()) {
      html += `<h2>${escapeHTML(names[i] || `Sheet ${i+1}`)}</h2><table>`;
      for (const row of list(parser.parse(await zip.file(n).async('string')).worksheet?.sheetData?.row).slice(0,500)) {
        html += `<tr><th>${escapeHTML(row['@_r'])}</th>`;
        let nextCol = 1;
        for (const c of list(row.c).slice(0,100)) {
          const col = (String(c['@_r']).match(/^[A-Z]+/)?.[0] || 'A').split('').reduce((n,ch) => n*26+ch.charCodeAt(0)-64,0);
          if (col > 100) break;
          while (nextCol < col) { html += '<td></td>'; nextCol++; }
          const value = c['@_t'] === 's' ? strings[Number(c.v)] : c['@_t'] === 'inlineStr' ? texts(c.is,'t').join('') : c.v ?? (c.f ? `=${typeof c.f === 'object' ? c.f['#text'] : c.f}` : '');
          html += `<td>${escapeHTML(value)}</td>`; nextCol++;
        }
        html += '</tr>';
      }
      html += '</table>';
    }
    return { kind: 'html', note: '每表预览前 500 行、100 列；公式显示缓存值，图表请下载查看。', html: shell(html) };
  }
  if (buffer.length > 2e6) return { kind: 'download', note: '文件较大，请下载查看。' };
  if (/^\.(txt|md|html?|csv|json|css|js|svg)$/.test(ext)) {
    const text = buffer.toString('utf8');
    return { kind: 'html', editable: true, text, html: /^\.(html?|svg)$/.test(ext) ? text : shell(`<pre>${escapeHTML(text)}</pre>`) };
  }
  return { kind: 'download', note: '此格式可下载后用本机应用打开。' };
}
