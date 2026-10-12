// One visible browser, owned by Power rather than a short-lived agent process.
import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { connectEmbeddedBrowser } from './embedded-browser.mjs';
import { connectExistingChrome, extensionInstallURL } from './chrome-connection.mjs';

export function createBrowser({ home, headless = false, channel, outputDir = join(home, 'browser-output') }) {
  const configFile = join(home, 'browser-connection.json');
  let mode = 'managed', disconnect, embedded;
  try { const saved=JSON.parse(readFileSync(configFile,'utf8')).mode;if(['extension','embedded'].includes(saved))mode=saved; } catch {}
  let connection, context, owner = null, inFlight = 0, releasePending = false;
  let queue = Promise.resolve();
  let activePage, manual = false;
  const pageIds = new WeakMap(); let nextPageId = 1;
  const pageId = (p) => { if (!pageIds.has(p)) pageIds.set(p, nextPageId++); return pageIds.get(p); };
  const profile = join(home, 'browser-profile');
  const availableTools = async (client) => (await client.listTools()).tools.filter((t) => t.name !== 'browser_run_code_unsafe');
  async function connect() {
    if (!connection) connection = (async () => {
      for (const dir of [profile, outputDir]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
      const { createConnection } = await import('@playwright/mcp');
      const { chromium } = await import('playwright-core');
      const launchOptions = { headless, channel: channel ?? (existsSync('/Applications/Google Chrome.app') ? 'chrome' : 'chromium'), viewport: null };
      const server = await createConnection({
        browser: { browserName: 'chromium', userDataDir: profile,
          launchOptions: { headless, channel: channel ?? (existsSync('/Applications/Google Chrome.app') ? 'chrome' : 'chromium') },
          contextOptions: { viewport: null } },
        capabilities: ['core', 'pdf', 'vision'], outputDir, webmcp: false, filePaths: 'absolute',
        // The service cwd is the code repository, while user attachments and selected projects
        // live elsewhere. Agent file tools already use those absolute paths.
        allowUnrestrictedFileAccess: true,
        timeouts: { action: 10000, navigation: 45000 },
      }, async () => {
        if (!context) {
          if (mode === 'embedded') { embedded=await connectEmbeddedBrowser(home);context=embedded.context;disconnect=embedded.disconnect; }
          else if (mode === 'extension') { const attached = await connectExistingChrome(outputDir); context = attached.context; disconnect = attached.disconnect; }
          else context = await chromium.launchPersistentContext(profile, launchOptions);
          context.on('page', (page) => { activePage = page; });
          activePage = context.pages().at(-1);
          context.once('close', () => { context = null; activePage = null; manual = false; });
        }
        return context;
      });
      const client = new Client({ name: 'power-browser', version: '1.0.0' }, { capabilities: {} });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      try { await client.connect(a); } catch (e) { await server.close(); throw e; }
      return { client, server };
    })().catch((e) => { connection = null; throw e; });
    return connection;
  }
  function release(id) {
    if (owner !== id) return;
    if (inFlight) releasePending = true;
    else { owner = null; releasePending = false; }
  }
  return {
    status: () => ({ available: true, started: !!context, busy: !!owner, manual, profile: mode === 'managed' ? profile : null, mode, extensionInstallURL }),
    release,
    async call(id, action, args = {}) {
      if (action === 'tools') return availableTools((await connect()).client);
      const focusOnly = id === 'ui' && action === 'show';
      if (manual && !focusOnly) throw new Error('用户正在右侧浏览器手动操作。请用 request_user_input 等待用户交还控制权。');
      if (owner && owner !== id && !focusOnly) throw new Error('浏览器正在被另一个对话使用，请等它完成后再试。');
      if (!focusOnly) owner = id;
      inFlight++;
      const task = queue.catch(() => {}).then(async () => {
        if (manual && !focusOnly) throw new Error('用户已手动接管浏览器');
        if (releasePending && !focusOnly) throw new Error('浏览器任务已取消');
        const { client } = await connect();
        if (manual && !focusOnly) throw new Error('用户已手动接管浏览器');
        if (releasePending && !focusOnly) throw new Error('浏览器任务已取消');
        await embedded?.automation(true);
        try {
        // Only this fixed host snippet is allowed; arbitrary code in the Power process is not exposed.
        if(embedded){const selected=await embedded.active();if(selected){const index=context.pages().indexOf(selected);await client.callTool({name:'browser_tabs',arguments:{action:'select',index}});activePage=selected;}}
        if (action === 'show' && embedded) {await embedded.select(activePage);return {content:[{type:'text',text:'已打开右侧内置浏览器'}]};}
        if (action === 'show') return client.callTool({ name: 'browser_run_code_unsafe', arguments: { code: 'async (page) => { await page.bringToFront(); return { url: page.url() }; }' } });
        const tools = await availableTools(client);
        if (!tools.some((t) => t.name === action)) throw new Error('未知浏览器操作。先用 action="tools" 读取操作名称和参数。');
        if (action === 'browser_close' && ['extension','embedded'].includes(mode)) throw new Error('请在 Power 浏览器面板关闭对应标签页，或断开连接。');
        if (action === 'browser_close') {
          const result = await client.callTool({ name: action, arguments: args });
          await context?.close();
          return result;
        }
        const result = await client.callTool({ name: action, arguments: args }, undefined, { timeout: 90000 });
        if (action === 'browser_tabs' && args.action === 'select' && !result.isError) activePage = context?.pages()[args.index] || activePage;
        if(embedded && action==='browser_tabs' && args.action==='new')activePage=await embedded.active();
        if(embedded && activePage && !activePage.isClosed())await embedded.select(activePage);
        return result;
        } finally { await embedded?.automation(false).catch(()=>{}); }
      });
      queue = task;
      try { return await task; }
      finally { inFlight--; if (!inFlight && releasePending) release(owner); }
    },
    async panel(action, args = {}) {
      if (action === 'status') return this.status();
      if (action === 'configure') {
        if (!['managed','extension','embedded'].includes(args.mode)) throw new Error('未知浏览器模式');
        if (owner || inFlight) throw new Error('浏览器任务正在运行，请先停止任务再切换连接');
        await this.close(); mode = args.mode;
        mkdirSync(home, {recursive:true}); writeFileSync(configFile, JSON.stringify({mode}), {mode:0o600});
        return this.status();
      }
      if (action === 'disconnect') {
        if (owner || inFlight) throw new Error('浏览器任务正在运行，请先停止任务');
        await this.close(); return this.status();
      }
      if (action === 'start') {
        if (!context?.pages().length) { const { client } = await connect(); const result = await client.callTool({ name: 'browser_snapshot', arguments: {} }); if (result.isError) throw new Error('浏览器启动失败'); }
        return { started: !!context };
      }
      if (action === 'frame') {
        const task = queue.catch(() => {}).then(async () => {
        if (!context) return { started: false, manual };
        if (embedded) activePage = await embedded.active();
        const pages = context.pages();
        if (!activePage || activePage.isClosed()) activePage = pages.at(-1);
        if (!activePage) return { started: false, manual };
        const page = activePage;
        if (mode === 'managed' && !inFlight && (!owner || manual) && Number.isInteger(args.width) && Number.isInteger(args.height)) {
          const viewport = { width: Math.max(320, Math.min(1920, args.width)), height: Math.max(240, Math.min(1200, args.height)) };
          const current = page.viewportSize();
          // Multiple Power windows can observe this browser. Keep its CSS viewport stable
          // so a different viewer cannot move targets between screenshot and click.
          if (!current) await page.setViewportSize(viewport);
        }
        const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const body = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
        const blocked = /access denied|request was blocked by|error 15/i.test(body.slice(0, 12000));
        const jpeg = (await page.screenshot({ type: 'jpeg', quality: 65, timeout: 5000 })).toString('base64');
        return { started: true, manual, pageId: pageId(page), url: page.url(), ...size, jpeg, blocked,
          tabs: await Promise.all(pages.map(async (p) => ({ id: pageId(p), title: await p.title().catch(() => '网页'), active: p === page }))) };
        }); queue = task; return task;
      }
      // Taking control waits for the current agent operation to finish. New agent
      // operations check manual before joining the queue; no concurrent typing.
      if (action === 'takeover') { manual = true; await queue.catch(() => {}); return { manual }; }
      if (action === 'resume') { manual = false; return { manual }; }
      if (!manual) throw new Error('请先点击「手动接管」');
      const task = queue.catch(() => {}).then(async () => {
        if (!manual) throw new Error('控制权已交还');
        const pages = context?.pages() || [];
        if (action === 'new') {
          const { client } = await connect();
          const result = await client.callTool({ name: 'browser_tabs', arguments: { action: 'new' } });
          if (result.isError) throw new Error('无法打开新标签页');
          activePage = embedded ? await embedded.active() : context.pages().at(-1);
          return { ok: true };
        }
        if (action === 'tab') {
          const index = pages.findIndex((p) => pageId(p) === args.id);
          if (index < 0) throw new Error('标签页已关闭');
          const { client } = await connect();
          const result = await client.callTool({ name: 'browser_tabs', arguments: { action: 'select', index } });
          if (result.isError) throw new Error('切换标签页失败');
          activePage = pages[index];
          if (embedded) await embedded.select(activePage);
          return { ok: true };
        }
        const page = activePage;
        if (!page || page.isClosed()) throw new Error('请先打开浏览器');
        if (args.pageId !== pageId(page)) throw new Error('网页已切换，请等待画面更新');
        if (action === 'navigate') {
          const url = new URL(args.url);
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 http/https 网页');
          await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } else if (action === 'back') await page.goBack({ timeout: 30000, waitUntil: 'domcontentloaded' });
        else if (action === 'reload') await page.reload({ timeout: 30000, waitUntil: 'domcontentloaded' });
        else if (action === 'click') {
          if (![args.x, args.y].every((n) => Number.isFinite(n) && n >= 0)) throw new Error('无效坐标');
          await page.mouse.click(args.x, args.y, {clickCount:args.count===2?2:1});
        } else if (action === 'drag') {
          if (![args.x,args.y,args.toX,args.toY].every(n=>Number.isFinite(n)&&n>=0)) throw new Error('无效拖动坐标');
          await page.mouse.move(args.x,args.y);await page.mouse.down();
          try {await page.mouse.move(args.toX,args.toY,{steps:12});}finally{await page.mouse.up();}
        } else if (action === 'scroll') {
          if (![args.x, args.y].every(Number.isFinite)) throw new Error('无效滚动');
          await page.mouse.wheel(Math.max(-2000, Math.min(2000, args.x)), Math.max(-2000, Math.min(2000, args.y)));
        } else if (action === 'text') {
          if (typeof args.text !== 'string' || args.text.length > 10000) throw new Error('输入过长');
          await page.keyboard.insertText(args.text);
        } else if (action === 'key') {
          if (!['Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Meta+A', 'Control+A'].includes(args.key)) throw new Error('不支持的按键');
          await page.keyboard.press(args.key);
        } else throw new Error('未知面板操作');
        return { ok: true };
      });
      queue = task;
      return task;
    },
    async close() {
      await queue.catch(() => {});
      if (connection) {
        const { client, server } = await connection;
        await client.close(); await server.close();
      }
      if (disconnect) await disconnect(); else await context?.close();
      disconnect = null; embedded = null; manual = false; activePage = null;
      connection = null; context = null; owner = null;
    },
  };
}
