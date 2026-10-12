const {ipcRenderer}=require('electron');
for(const event of ['pointerdown','keydown','wheel'])addEventListener(event,e=>{if(e.isTrusted)ipcRenderer.send('power-browser-user-input');},{capture:true,passive:true});
