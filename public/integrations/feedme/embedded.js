(function () {
  const p=new URLSearchParams(location.search), id=p.get('id');
  document.body.dataset.widget=p.get('widget');
  document.body.dataset.theme=p.get('theme') === 'home' ? 'home' : 'feedme';
  document.documentElement.dataset.theme=document.body.dataset.theme;
  window.addEventListener('storage',event=>{ try { if (event.key==='fm-read') {readArticleIds=new Set(JSON.parse(event.newValue || '[]'));Bus.emit('read');} if (event.key==='fm-favorites') {favoriteIds=new Set(JSON.parse(event.newValue || '[]'));Bus.emit('favorites');} if (event.key==='fm-hidden-sources') {hiddenSources=new Set(JSON.parse(event.newValue || '[]'));Bus.emit('sources:hidden');} } catch {} });
  window.addEventListener('DOMContentLoaded',()=>{
    if (p.get('widget') === 'agents') { const script=document.createElement('script'); script.src='agents.js'+(window.MB_ASSET_VERSION ? '?v='+window.MB_ASSET_VERSION : ''); script.onload=()=>document.querySelector('[data-workspace="agents"]')?.click(); document.body.append(script); }
    if (p.get('widget') === 'settings') togglePanel('settings');
    const title=document.querySelector('.widget-name'); if (title && p.get('title')) title.textContent=p.get('title');
    let previous='';
    const send=()=>{
      const overlay=p.get('widget') !== 'settings' && !!document.querySelector('.sheet-overlay.open,.modal-overlay.open');
      document.body.classList.toggle('embedded-dialog-open',overlay);
      const message={type:'metaboard:widget-size',id,height:Math.ceil(document.body.getBoundingClientRect().height),overlay};
      const signature=JSON.stringify(message);
      if(signature !== previous) { previous=signature;parent.postMessage(message,location.origin); }
    };
    new ResizeObserver(send).observe(document.body); send();
    new MutationObserver(send).observe(document.body,{subtree:true,attributes:true,attributeFilter:['class','hidden'],childList:true});
    window.addEventListener('resize',send);
    document.addEventListener('keydown',event=>{if(event.key==='Escape') document.querySelector('.sheet-overlay.open .sheet-close,.sheet-overlay.open .sheet-head button,.modal-overlay.open .modal-close')?.click();});
    document.addEventListener('click',send);
  });
})();
