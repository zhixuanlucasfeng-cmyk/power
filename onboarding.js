(() => {
 const dialog=document.createElement('dialog');dialog.id='setup';
 dialog.style.cssText='width:min(620px,90vw);max-height:90vh;overflow:auto;background:#151827;color:#eef0ff;border:1px solid #596080;border-radius:18px;padding:28px;font:15px system-ui';
 dialog.innerHTML=`<h2>欢迎使用 Power / Welcome to Power</h2><p>连接自己的 ChatGPT 账号，开始使用 Codex。<br>Connect your ChatGPT account to use Codex.</p><p>选择 Agent / Agent: <b>Codex · ChatGPT</b></p><p style="opacity:.75">其他 Agent 可稍后在设置中添加 / Other agents are available in Settings.</p><ol style="line-height:2"><li id="setup-installed">正在检测 / Checking…</li><li id="setup-auth"></li><li id="setup-verified"></li></ol><div style="display:flex;gap:8px;flex-wrap:wrap"><button disabled data-setup="install">1. 安装 / Install</button><button disabled data-setup="login">2. 登录 / Sign in</button><button disabled data-setup="verify">3. 测试连接 / Test</button><button disabled data-setup="cancel">取消操作 / Cancel</button></div><p style="opacity:.75">安装需要网络；测试会发送一条简短消息，使用少量账号额度。密码只在官方页面输入。<br>Internet required. The test sends one short request using your account allowance. Enter passwords only on the official website.</p><div id="setup-links"></div><pre id="setup-output" role="status" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto"></pre><label>你的称呼 / Your name <input id="setup-name" maxlength="40" autocomplete="given-name"></label><p id="setup-error" role="alert"></p><div style="display:flex;justify-content:space-between;margin-top:20px"><button id="setup-later">稍后配置 / Later</button><button id="setup-done" disabled>开始聊天 / Start chatting</button></div>`;
 document.body.append(dialog);
 const el=id=>document.getElementById(id);let polling=false;
 const api=async body=>{const r=await fetch('/api/onboarding',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d;};
 async function refresh(){if(polling)return;polling=true;try{
  const s=await api();const busy=s.job?.status==='running';
  el('setup-installed').textContent=s.installed?'✓ Codex 已安装 / Installed':'Codex 尚未安装 / Not installed';
  el('setup-auth').textContent=s.authenticated?'✓ ChatGPT 已登录 / Signed in':'需要 ChatGPT 登录 / Sign-in required';
  el('setup-verified').textContent=s.verified?'✓ 测试通过，可以聊天 / Ready to chat':'发送测试消息验证连接 / Test connection';
  dialog.querySelector('[data-setup="install"]').disabled=busy||s.installed;
  dialog.querySelector('[data-setup="login"]').disabled=busy||!s.installed;
  dialog.querySelector('[data-setup="verify"]').disabled=busy||!s.authenticated;
  dialog.querySelector('[data-setup="cancel"]').disabled=!busy;
  el('setup-done').disabled=busy||!s.verified||!s.authenticated;
  el('setup-output').textContent=s.job?(s.job.status==='running'?'正在处理 / Working…\n':'')+s.job.output:'';
  el('setup-links').replaceChildren();
  for(const raw of new Set((s.job?.output||'').match(/https:\/\/[^\s<>"\x1b]+/g)||[])){
   let u;try{u=new URL(raw);}catch{continue;}
   if(!['auth.openai.com','auth0.openai.com','chatgpt.com','openai.com'].includes(u.hostname))continue;
   const a=document.createElement('a');a.textContent='打开官方登录页面 / Open official sign-in';a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';a.style.color='#aaaaff';
   if(window.powerDesktop)a.onclick=async e=>{e.preventDefault();try{await window.powerDesktop.invoke('openLogin',{url:u.href});}catch(err){el('setup-error').textContent=err.message;}};
   el('setup-links').append(a,document.createElement('br'));
  }
  return s;
 }finally{polling=false;}}
 dialog.addEventListener('click',async e=>{const action=e.target.dataset.setup;if(!action)return;el('setup-error').textContent='';e.target.disabled=true;try{await api({action});await refresh();}catch(err){el('setup-error').textContent=err.message;await refresh().catch(()=>{});}});
 el('setup-later').onclick=()=>dialog.close();
 el('setup-done').onclick=async()=>{try{
  const result=await api({action:'complete'});
  const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(el('setup-name').value.trim()?{userName:el('setup-name').value}:{})});if(!r.ok)throw new Error('保存配置失败 / Could not save settings');
  if(result.char)localStorage.setItem('char',result.char);location.reload();
 }catch(e){el('setup-error').textContent=e.message;}};
 window.openPowerSetup=async()=>{document.body.classList.remove('browseropen');dialog.showModal();await refresh().catch(e=>{el('setup-error').textContent=e.message;});};
 const button=document.createElement('button');button.textContent='配置 Agent / Setup';button.onclick=window.openPowerSetup;document.querySelector('.ctl').append(button);
 api().then(s=>{if(s.needed)window.openPowerSetup();}).catch(()=>{});
 setInterval(()=>{if(dialog.open)refresh().catch(e=>{el('setup-error').textContent=e.message;});},2000);
})();
