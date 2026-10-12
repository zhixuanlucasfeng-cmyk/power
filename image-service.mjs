import { readFileSync, mkdirSync, copyFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import spawn from 'cross-spawn';
const exec = (bin,args,options) => new Promise((resolve,reject)=>{
  const child=spawn(bin,args,{...options,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.once('error',reject);child.once('close',code=>code===0?resolve({stdout,stderr}):reject(new Error(stderr||'Command failed')));
});
export function imageExtension(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('未返回支持的 PNG / JPEG / WebP 图片');
}
export function imageEnvironment() {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'POWER_TOOL_TOKEN', 'POWER_THREAD']) delete env[key];
  return env;
}
export async function imageStatus(bin) {
  if (!bin) return { ready: false, provider: 'ChatGPT subscription', message: '未安装 Codex CLI' };
  try {
    const auth = await exec(bin, ['login', 'status'], { env: imageEnvironment(), timeout: 10000 });
    const ready = /ChatGPT/i.test(auth.stdout + auth.stderr);
    return { ready, provider: 'ChatGPT subscription', message: ready ? '已通过 ChatGPT 登录 · 使用订阅额度' : '请在终端运行 codex login 并选择 ChatGPT 登录' };
  } catch { return { ready: false, provider: 'ChatGPT subscription', message: '请在终端运行 codex login 并选择 ChatGPT 登录' }; }
}
export function subscriptionImageArgs(dir, prompt, source) {
  const instruction = `Use ONLY the built-in image generation tool, through the current ChatGPT subscription, to ${source ? 'edit the attached image' : 'generate one image'}. Do not use paid API fallbacks, external image services, SVG/code substitutes, or other agents. If the built-in tool is unavailable, report that and stop. Save or copy the final generated raster image to ${dir}/result.png (preserve its original format if different). Do not copy the input as the output.\nUser image request:\n${prompt}`;
  return ['exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '-s', 'workspace-write', '-C', dir,
    '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', 'features.image_generation=true', '-c', 'model_reasoning_effort="low"',
    ...(source ? ['-i', source] : []), instruction];
}
export async function generateImage({ bin, outputDir, prompt, source, signal, onProgress = () => {}, status = imageStatus }) {
  const auth = await status(bin); if (!auth.ready) throw new Error(auth.message);
  signal?.throwIfAborted();
  const dir = join(outputDir, randomUUID()); mkdirSync(dir, { recursive: true, mode: 0o700 });
  let input;
  if (source) { const b = readFileSync(source); if (b.length > 20e6) throw new Error('输入图片超过 20MB'); input = join(dir, `input.${imageExtension(b)}`); copyFileSync(source, input); }
  await new Promise((resolve, reject) => {
    const child = spawn(bin, subscriptionImageArgs(dir, prompt, input), { cwd: dir, detached: process.platform !== 'win32', env: imageEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '', buffer = '', last = '', cancelled = false;
    const kill = (sig) => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig); } catch {} };
    const abort = () => { cancelled = true; kill('SIGTERM'); setTimeout(() => kill('SIGKILL'), 3000).unref(); };
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(abort, 600000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk; let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { const event = JSON.parse(line); if (event.item?.type === 'agent_message') last = event.item.text || ''; if (event.type === 'turn.failed') error = event.error?.message || event.message || '图片任务失败'; onProgress({type:event.type,itemType:event.item?.type,tool:event.item?.tool,text:event.item?.type==='agent_message'?event.item.text:undefined}); } catch {}
      }
      if (buffer.length > 1e6) buffer = '';
    });
    child.stderr.on('data', () => {}); // diagnostics may contain account metadata; never echo to chat
    child.on('error', () => { error = 'Codex CLI 无法启动'; });
    child.on('close', (code) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (cancelled) reject(new Error('图片任务已取消或超过 10 分钟')); else if (code || error) reject(new Error('Codex 图片任务失败；请检查登录、订阅额度和 CLI 状态')); else resolve(last); });
  });
  const file = readdirSync(dir).find((f) => /^result\.(png|jpe?g|webp)$/i.test(f));
  if (!file) throw new Error('Codex 没有保存生成图片。内置图片工具可能不可用或额度不足；未改用付费 API。');
  const path = realpathSync(join(dir, file)); if (relative(realpathSync(dir), path).startsWith('..')) throw new Error('图片输出路径无效');
  if (statSync(path).size > 25e6) throw new Error('输出图片超过 25MB');
  imageExtension(readFileSync(path));
  return { path, provider: 'ChatGPT subscription' };
}
