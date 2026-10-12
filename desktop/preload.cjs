const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('powerDesktop',{
 invoke:(action,args={})=>ipcRenderer.invoke('power-desktop',action,args),
 onState:callback=>{ipcRenderer.on('power-browser-state',(_event,state)=>callback(state));},
});
