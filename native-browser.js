(() => {
 if(!window.powerDesktop||['extension','managed'].includes(localStorage.getItem('powerBrowserMode')))return;
 const el=id=>document.getElementById(id),native=window.powerDesktop;
 let open=false;
 const run=(action,args)=>native.invoke(action,args).catch(e=>{el('bstatus').textContent=e.message;});
 el('bmode').value='embedded';el('bnotice').hidden=true;el('bimage').hidden=true;el('binput').hidden=true;
 el('bconnect').hidden=true;el('bdisconnect').hidden=true;
 el('bmode').onchange=async()=>{try{const mode=el('bmode').value;const r=await fetch('/api/browser/panel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'configure',args:{mode}})});const data=await r.json();if(!r.ok)throw new Error(data.error||'切换浏览器失败');localStorage.setItem('powerBrowserMode',mode);sessionStorage.setItem('powerBrowserOpen','1');await native.invoke('hide');location.reload();}catch(e){el('bstatus').textContent=e.message;el('bmode').value='embedded';}};
 el('browserpanel').querySelector('a[href^="https://chromewebstore.google.com/"]').onclick=e=>{e.preventDefault();run('openChromeExtension');};
 el('bnative').textContent='新标签页';el('bnative').onclick=()=>run('new');
 el('bnew').onclick=async()=>{await run('new');el('burl').focus();};
 el('btake').onclick=()=>run(el('btake').dataset.manual==='true'?'resume':'takeover');
 el('bnav').onsubmit=e=>{e.preventDefault();let url=el('burl').value.trim();if(!/^https?:\/\//i.test(url))url='https://'+url;run('navigate',{url});};
 el('bback').onclick=()=>run('back');el('breload').onclick=()=>run('reload');
 async function layout(){const b=el('bviewport').getBoundingClientRect();await run('bounds',{x:b.x,y:b.y,width:b.width,height:b.height});}
 window.openPowerBrowser=async()=>{const r=await fetch('/api/browser/panel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'status'})});const data=await r.json();if(data.mode!=='embedded'){localStorage.setItem('powerBrowserMode',data.mode);sessionStorage.setItem('powerBrowserOpen','1');location.reload();return;}document.body.classList.remove('workspaceopen');document.body.classList.add('browseropen');open=true;await layout();await run('show');};
 el('browsert').onclick=window.openPowerBrowser;
 el('bclose').onclick=()=>{open=false;document.body.classList.remove('browseropen');run('hide');};
 const observer=new ResizeObserver(()=>{if(open)layout();});observer.observe(el('bviewport'));
 new MutationObserver(()=>{if(!document.body.classList.contains('browseropen')&&open){open=false;run('hide');}}).observe(document.body,{attributes:true,attributeFilter:['class']});
 native.onState(s=>{
  if(s.visible&&!open){open=true;document.body.classList.remove('workspaceopen');document.body.classList.add('browseropen');layout();}
  const active=s.tabs.find(t=>t.id===s.active);
  el('bempty').hidden=!!active;
  if(document.activeElement!==el('burl'))el('burl').value=active?.url==='about:blank'?'':active?.url||'';
  el('btake').dataset.manual=String(s.manual);el('btake').textContent=s.manual?'交还 Agent':'手动接管';
  el('bstatus').textContent=s.error|| (s.manual?'你正在操作 · 完成后交还 Agent':'内置浏览器 · 可以直接点击、输入、滚动和登录');
  const sig=JSON.stringify(s.tabs)+s.active;if(el('btabs').dataset.signature===sig)return;el('btabs').dataset.signature=sig;el('btabs').replaceChildren();
  for(const tab of s.tabs){const button=document.createElement('button');button.textContent=tab.title;button.className=tab.id===s.active?'active':'';button.onclick=()=>run('select',{id:tab.id});el('btabs').append(button);const close=document.createElement('button');close.textContent='×';close.setAttribute('aria-label','关闭 '+tab.title);close.onclick=()=>run('close',{id:tab.id});el('btabs').append(close);}
 });
 run('state').then(s=>{if(s?.visible)window.openPowerBrowser();});
 if(sessionStorage.getItem('powerBrowserOpen')){sessionStorage.removeItem('powerBrowserOpen');window.openPowerBrowser();}
})();
