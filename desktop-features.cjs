'use strict';
const path=require('node:path'),fs=require('node:fs');
module.exports=function desktopFeatures({app,win,origin}) {
  const {screen,ipcMain,Tray,Menu,nativeImage,Notification}=require('electron');
  const file=path.join(app.getPath('userData'),'desktop-settings.json');
  let preferences={notifications:false}; try {preferences={...preferences,...JSON.parse(fs.readFileSync(file,'utf8'))};} catch {}
  const save=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(preferences));};
  let appbar,registered=false,hwnd,side='right',reserved=false,autoHide=false,hidden=false,base,quitting=false,signature;
  try { if (process.platform==='win32') appbar=require(path.join(__dirname,'..','FeedMe','appbar.js')); } catch {}
  const state=()=>({reserved,autoHide,alwaysOnTop:win.isAlwaysOnTop(),notifications:!!preferences.notifications,canReserve:!!appbar});
  function release() { if (registered) {appbar.remove(hwnd);registered=false;} reserved=false; }
  function reveal() { if (hidden && base) win.setBounds(base);hidden=false; }
  function dock(edge) {
    release(); reveal();side=edge;win.unmaximize();
    const area=screen.getDisplayMatching(win.getBounds()).workArea,width=Math.min(480,Math.round(area.width*.32));
    win.setBounds({x:edge==='left'?area.x:area.x+area.width-width,y:area.y,width,height:area.height});
    win.webContents.send('meta:surface','compact');
  }
  function reserve() {
    if (!appbar) throw Error('L’ancrage Windows nécessite le module AppBar de Cockpit installé sur ce PC.');
    if (reserved) {release();return;}
    autoHide=false;dock(side); const bounds=win.getBounds(),display=screen.getDisplayMatching(bounds);
    hwnd=appbar.hwndFromWindow(win);appbar.register(hwnd);registered=true;
    const rect=screen.dipToScreenRect(win,bounds);
    appbar.setPos(hwnd,side==='left'?appbar.ABE_LEFT:appbar.ABE_RIGHT,{left:rect.x,top:rect.y,right:rect.x+rect.width,bottom:rect.y+rect.height});
    signature=display.id+':'+display.scaleFactor+':'+display.bounds.width+':'+display.bounds.height;
    reserved=true;win.setAlwaysOnTop(true);
  }
  async function command(name) {
    if (name==='dock-left' || name==='dock-right') dock(name.slice(5));
    else if (name==='window') {release();autoHide=false;reveal();win.setBounds({width:1510,height:1000});win.center();win.webContents.send('meta:surface','desktop');}
    else if (name==='reserve') reserve();
    else if (name==='pin') win.setAlwaysOnTop(!win.isAlwaysOnTop());
    else if (name==='autohide') {release();reveal();autoHide=!autoHide;if (autoHide) {dock(side);win.setAlwaysOnTop(true);}}
    else if (name==='notifications') {preferences.notifications=!preferences.notifications;save();}
    else if (name==='minimize') win.minimize();
    else if (name==='quit') {quitting=true;app.quit();}
    return state();
  }
  ipcMain.handle('meta:desktop',(event,name)=>{
    if (event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame) throw Error('Fenêtre non autorisée.');
    if (!['state','dock-left','dock-right','window','reserve','pin','autohide','notifications','minimize','quit'].includes(name)) throw Error('Commande inconnue.');
    return command(name);
  });
  const mouse=setInterval(()=>{
    if (!autoHide || win.isDestroyed()) return;
    const cursor=screen.getCursorScreenPoint(),bounds=win.getBounds();
    if (hidden) {
      const area=screen.getDisplayMatching(base).workArea;
      if ((side==='right'?cursor.x>=area.x+area.width-8:cursor.x<=area.x+8) && cursor.y>=area.y && cursor.y<=area.y+area.height) reveal();
    } else if (!win.isFocused() && (cursor.x<bounds.x-20 || cursor.x>bounds.x+bounds.width+20 || cursor.y<bounds.y-20 || cursor.y>bounds.y+bounds.height+20)) {
      base=bounds;hidden=true;win.setBounds({...bounds,x:side==='right'?bounds.x+bounds.width-6:bounds.x-bounds.width+6});
    }
  },150);
  win.on('focus',reveal);
  const reflow=()=>{if (!reserved) return;const d=screen.getDisplayMatching(win.getBounds());if (signature!==d.id+':'+d.scaleFactor+':'+d.bounds.width+':'+d.bounds.height) release();};
  screen.on('display-metrics-changed',reflow);screen.on('display-removed',reflow);
  const image=nativeImage.createFromPath(path.join(__dirname,'public','brand','icon.png')).resize({width:16,height:16});
  const tray=new Tray(image);tray.setToolTip('Cockpit');tray.on('click',()=>{reveal();win.show();win.focus();});
  tray.setContextMenu(Menu.buildFromTemplate([{label:'Ouvrir Cockpit',click:()=>{reveal();win.show();win.focus();}},{label:'Panneau à gauche',click:()=>command('dock-left')},{label:'Panneau à droite',click:()=>command('dock-right')},{label:'Quitter Cockpit',click:()=>command('quit')}]));
  win.on('close',event=>{if (!quitting) {event.preventDefault();win.hide();}});
  let seen=null;
  const inbox=setInterval(async()=>{
    if (!preferences.notifications) return;
    try {
      const response=await fetch(origin+'/api/feedme/agents/inbox',{signal:AbortSignal.timeout(3000)});if (!response.ok) return;const data=await response.json(),next=new Set(data.items.map(it=>it.id));
      if (seen && Notification.isSupported() && !(win.isVisible() && win.isFocused())) for (const item of data.items) if (!item.read && !seen.has(item.id)) {
        const notice=new Notification({title:'Cockpit · '+(item.displayName || item.agentId || 'Agent'),body:String(item.content || '').slice(0,200)});
        notice.on('click',()=>{reveal();win.show();win.focus();win.webContents.send('meta:surface','agents');});notice.show();
      }
      seen=next;
    } catch {}
  },15000);
  app.on('before-quit',()=>{quitting=true;release();clearInterval(mouse);clearInterval(inbox);tray.destroy();});
};
