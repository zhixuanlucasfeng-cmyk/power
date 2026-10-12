const {app,BrowserWindow,WebContentsView,ipcMain,dialog,Menu,session,webContents,shell}=require('electron');
const {join}=require('node:path');const {homedir}=require('node:os');const fs=require('node:fs');const {randomUUID}=require('node:crypto');const {createServer}=require('node:http');
const {webURL,bounds}=require('./policy.cjs');
const home=process.env.POWER_HOME||join(homedir(),'.power');
const base=`http://127.0.0.1:${process.env.POWER_PORT||4545}`;
const profile=join(home,'desktop');fs.mkdirSync(profile,{recursive:true,mode:0o700});
app.setPath('userData',profile);app.commandLine.appendSwitch('remote-debugging-port','0');
app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1');
const endpointFile=join(home,'desktop-connection.json'),token=randomUUID();
let win,shown=false,active,rect={x:700,y:220,width:700,height:650},server,cdp,manual=false,automating=false;
const tabs=new Map();
if(!app.requestSingleInstanceLock())app.quit();
app.on('second-instance',()=>{win?.show();win?.focus();});
function state(){return {visible:shown,manual,active,tabs:[...tabs.values()].map(v=>({id:v.webContents.id,url:v.webContents.getURL(),title:v.webContents.getTitle()||'New tab'}))};}
function emit(){if(win&&!win.isDestroyed())win.webContents.send('power-browser-state',state());}
function layout(){if(!win)return;for(const [id,v] of tabs){v.setVisible(shown&&id===active);if(id===active)v.setBounds(bounds(rect,win.getContentSize()));}}
function activate(id){if(!tabs.has(id))throw new Error('Tab has closed');active=id;layout();emit();}
async function controlUser(force=false){if(manual||(automating&&!force))return;manual=true;emit();await fetch(base+'/api/browser/panel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'takeover'})}).catch(()=>{});}
function addTab(url='about:blank'){
 if(url!=='about:blank')url=webURL(url);
 const view=new WebContentsView({webPreferences:{partition:'persist:power-web',preload:join(__dirname,'page-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 const wc=view.webContents;tabs.set(wc.id,view);win.contentView.addChildView(view);activate(wc.id);
 wc.setWindowOpenHandler(({url})=>{try{addTab(url);}catch{}return {action:'deny'};});
 wc.on('will-navigate',(e,url)=>{try{webURL(url);}catch{e.preventDefault();}});
 for(const event of ['did-navigate','did-navigate-in-page','page-title-updated','did-stop-loading'])wc.on(event,emit);
 wc.on('did-fail-load',(_e,code,message,_url,main)=>{if(main&&code!==-3)win.webContents.send('power-browser-state',{...state(),error:message});});
 wc.on('destroyed',()=>{tabs.delete(wc.id);if(active===wc.id)active=[...tabs.keys()].at(-1);layout();emit();});
 wc.loadURL(url).catch(()=>{});return wc.id;
}
async function action(name,args={}){
 const wc=tabs.get(active)?.webContents;
 switch(name){
 case 'openLogin':{const u=new URL(args.url);if(u.protocol!=='https:'||!['auth.openai.com','auth0.openai.com','chatgpt.com','openai.com'].includes(u.hostname)||u.username||u.password)throw new Error('Invalid login URL');await shell.openExternal(u.href);return {};}
 case 'state':return state();
 case 'automation':automating=!!args.active;return {};
 case 'show':shown=true;if(!tabs.size)addTab();layout();emit();return state();
 case 'hide':shown=false;layout();emit();return state();
 case 'bounds':rect=bounds(args,win.getContentSize());layout();return {};
 case 'new':shown=true;return {id:addTab(args.url||'about:blank')};
 case 'select':activate(args.id);return state();
 case 'close':tabs.get(args.id)?.webContents.close();return state();
 case 'navigate':if(!wc)addTab(webURL(args.url));else await wc.loadURL(webURL(args.url));return state();
 case 'back':if(wc?.navigationHistory.canGoBack())wc.navigationHistory.goBack();return state();
 case 'forward':if(wc?.navigationHistory.canGoForward())wc.navigationHistory.goForward();return state();
 case 'reload':wc?.reload();return state();
 case 'resume':manual=false;await fetch(base+'/api/browser/panel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'resume'})});emit();return state();
 case 'takeover':await controlUser(true);return state();
 case 'pickFolder':return (await dialog.showOpenDialog(win,{properties:['openDirectory']})).filePaths[0]||null;
 default:throw new Error('Unknown desktop operation');
 }
}
async function targetState(){
 const targets=await fetch(cdp+'/json/list').then(r=>r.json());
 return {targets:targets.flatMap(t=>{const wc=webContents.fromDevToolsTargetId(t.id);return wc&&tabs.has(wc.id)?[{targetId:t.id,id:wc.id}]:[]}),...state()};
}
app.whenReady().then(async()=>{
 session.fromPartition('persist:power-web').setPermissionRequestHandler(async(wc,permission,callback,details)=>{
   if(!tabs.has(wc.id)){callback(false);return;}
   const r=await dialog.showMessageBox(win,{type:'question',message:`Allow ${permission}?`,detail:details.requestingUrl||wc.getURL(),buttons:['Deny','Allow'],defaultId:0,cancelId:0});callback(r.response===1);
 });
 session.fromPartition('persist:power-web').setPermissionCheckHandler(()=>false);
 win=new BrowserWindow({title:'Power',width:1440,height:900,minWidth:900,minHeight:600,backgroundColor:'#0a0c18',webPreferences:{preload:join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 win.on('resize',layout);
 win.webContents.on('will-navigate',(e,url)=>{if(new URL(url).origin!==base)e.preventDefault();});
 win.webContents.setWindowOpenHandler(({url})=>{try{shown=true;addTab(webURL(url));emit();}catch{}return {action:'deny'};});
 ipcMain.handle('power-desktop',(event,name,args)=>{
  if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||new URL(event.senderFrame.url).origin!==base)throw new Error('Untrusted desktop request');
  if(name==='automation')throw new Error('Reserved desktop operation');
  return action(name,args);
 });
 ipcMain.on('power-browser-user-input',event=>{if(tabs.has(event.sender.id))void controlUser();});
 Menu.setApplicationMenu(Menu.buildFromTemplate([{role:'appMenu'},{role:'editMenu'},{label:'View',submenu:[{label:'Reload Power',accelerator:'CmdOrCtrl+R',click:()=>win.webContents.reload()},{role:'togglefullscreen'}]}]));
 void win.loadURL(base).catch(e=>console.error("Power UI load failed:",e.message));
 // Chromium writes its randomly assigned loopback debugging endpoint here.
 for(let n=0;n<100;n++){try{const [port]=fs.readFileSync(join(profile,'DevToolsActivePort'),'utf8').trim().split('\n');cdp=`http://127.0.0.1:${Number(port)}`;await fetch(cdp+'/json/version');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 if(!cdp)throw new Error('Embedded browser control endpoint unavailable');
 server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end('{}');return;}
  try{let body='';for await(const part of req){body+=part;if(body.length>100000)throw new Error('Request too large');}
   const {action:name,args}=JSON.parse(body||'{}');
   const result=name==='targets'?await targetState():await action(name,args);res.end(JSON.stringify(result));
  }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}
 }).listen(0,'127.0.0.1',()=>{fs.writeFileSync(endpointFile+'.tmp',JSON.stringify({pid:process.pid,cdp,endpoint:`http://127.0.0.1:${server.address().port}`,token}),{mode:0o600});fs.renameSync(endpointFile+'.tmp',endpointFile);void fetch(base+'/api/browser/panel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'configure',args:{mode:'embedded'}})}).catch(console.error);});
});
app.on('before-quit',()=>{try{if(JSON.parse(fs.readFileSync(endpointFile,'utf8')).pid===process.pid)fs.unlinkSync(endpointFile);}catch{}for(const v of tabs.values())if(!v.webContents.isDestroyed())v.webContents.close({waitForBeforeUnload:false});server?.closeAllConnections();server?.close();});
app.on('window-all-closed',()=>app.quit());
process.on('SIGTERM',()=>app.quit());
