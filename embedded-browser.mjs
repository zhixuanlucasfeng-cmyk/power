import {readFileSync} from 'node:fs';import {join} from 'node:path';
export async function connectEmbeddedBrowser(home) {
 let config;try{config=JSON.parse(readFileSync(join(home,'desktop-connection.json'),'utf8'));}catch{throw new Error('请先打开新版 Power.app，内置浏览器随桌面窗口运行。');}
 for(const value of [config.endpoint,config.cdp]){const u=new URL(value);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1')throw new Error('无效的桌面浏览器连接');}
 const rpc=async(action,args={})=>{const r=await fetch(config.endpoint,{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},body:JSON.stringify({action,args}),signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok)throw new Error(data.error||'桌面浏览器未连接');return data;};
 await rpc('show');
 const {chromium}=await import('playwright-core');
 const browser=await chromium.connectOverCDP(config.cdp);
 const contexts=browser.contexts();const ids=new WeakMap();
 async function targetId(page){if(!ids.has(page)){const c=await page.context().newCDPSession(page);try{ids.set(page,(await c.send('Target.getTargetInfo')).targetInfo.targetId);}finally{await c.detach();}}return ids.get(page);}
 const owned=new Set();
 async function refresh(){const s=await rpc('targets');const allowed=new Set(s.targets.map(t=>t.targetId));for(const ctx of contexts)for(const p of ctx.pages())if(allowed.has(await targetId(p)))owned.add(p);return s;}
 await refresh();
 const ctx=[...owned][0]?.context();if(!ctx){await browser.close();throw new Error('内置浏览器标签页未就绪');}
 const pages=()=>ctx.pages().filter(p=>owned.has(p)&&!p.isClosed());
 const proxy=new Proxy(ctx,{get(target,key){
  if(key==='pages')return pages;
  if(key==='newPage')return async()=>{const {id}=await rpc('new');for(let n=0;n<50;n++){const s=await refresh();const t=s.targets.find(t=>t.id===id);for(const p of pages())if(await targetId(p)===t?.targetId)return p;await new Promise(r=>setTimeout(r,100));}throw new Error('无法打开内置标签页');};
  if(key==='on')return (name,listener)=>{if(name==='page')target.on(name,p=>{void refresh().then(()=>{if(owned.has(p))listener(p);}).catch(()=>{});});else target.on(name,listener);return proxy;};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 return {context:proxy,disconnect:()=>browser.close(),automation:active=>rpc('automation',{active}),
  async active(){const s=await refresh();const t=s.targets.find(t=>t.id===s.active);for(const p of pages())if(await targetId(p)===t?.targetId)return p;},
  async select(page){const s=await refresh(),id=await targetId(page),t=s.targets.find(t=>t.targetId===id);if(t)await rpc('select',{id:t.id});await rpc('show');},
 };
}
