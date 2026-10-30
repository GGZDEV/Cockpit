const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('metaDesktop',{
  state:()=>ipcRenderer.invoke('meta:desktop','state'),
  command:name=>ipcRenderer.invoke('meta:desktop',name),
  onSurface:callback=>ipcRenderer.on('meta:surface',(_event,surface)=>callback(surface))
});
