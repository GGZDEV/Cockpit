import { esc, icon, safeUrl } from './core.js';

export function haActions({sources,showModal,toast,opened}) {
  let browser={items:[],stack:[],entity:''};
  async function media(widget,item,back=false) {
    opened(widget); const entity=browser.entity;
    showModal('Bibliothèque multimédia','Chargement…','<p>Lecture de la bibliothèque Home Assistant…</p>','media',true);
    try {
      const node=await sources.ha.browseMedia(entity,item?.media_content_id,item?.media_content_type);
      if (!back) browser.stack.push(item || null);
      browser.items=Array.isArray(node.children) ? node.children : [];
      showModal(node.title || 'Bibliothèque multimédia','',`<div class="media-lib">${browser.items.map((it,i)=>`<button class="media-item hov" data-act="${it.can_play ? 'media-play' : 'media-open'}" data-arg="${i}" ${!it.can_play && !it.can_expand ? 'disabled' : ''}><span class="media-thumb">${icon('music')}</span><span class="media-item-name">${esc(it.title)}</span></button>`).join('') || '<p>Aucun élément disponible.</p>'}</div>${browser.stack.length>1 ? '<button class="button" data-act="media-back">Retour</button>' : ''}`,'media',true);
    } catch(e) { showModal('Bibliothèque multimédia','',`<p>${esc(e.message)}</p>`,'media'); }
  }
  async function install(ids,backup) {
    if (sources.updateQueue) throw Error('Une file de mises à jour est déjà en cours.');
    const queue=sources.updateQueue={list:ids.map(id=>({id})),current:null,total:ids.length,done:0}; sources.emit();
    try {
      for (const id of ids) {
        queue.current=id; queue.list=queue.list.filter(i=>i.id!==id); sources.emit();
        const state=sources.data.states.find(s=>s.entity_id===id);
        await sources.action('update','install',id,{backup:backup && !!(Number(state?.attributes.supported_features)&8)});
        await new Promise((resolve,reject)=>{
          const check=()=>{ const st=sources.data.states.find(s=>s.entity_id===id); if (st?.state==='off' && !st.attributes.in_progress) { cleanup();resolve(); } };
          const timeout=setTimeout(()=>{cleanup();reject(Error('Installation toujours en cours : vérifiez Home Assistant avant de poursuivre la file.'));},30*60000);
          const cleanup=()=>{clearTimeout(timeout);sources.removeEventListener('change',check);};
          sources.addEventListener('change',check); check();
        });
        queue.done++; sources.emit();
      }
      toast('Mises à jour terminées.');
    } catch(e) { toast(e.message); }
    finally { sources.updateQueue=null; sources.emit(); }
  }
  return async (element,widget,pool)=>{
    const act=element.dataset.act,arg=element.dataset.arg;
    if (act==='camera-open') {
      const st=pool.find(s=>s.entity_id===arg); if (!st) return true; opened(widget);
      const url=sources.cameraUrl(st,true);
      showModal(st.attributes.friendly_name || 'Caméra','En direct',url ? `<img class="cam-full" style="max-width:100%;max-height:78vh;object-fit:contain" src="${esc(url)}" alt="Image en direct">` : '<p>Image indisponible.</p>','camera',true); return true;
    }
    if (act==='pve-press') {
      if (!sources.data.states.some(s=>s.entity_id===arg && arg.startsWith('button.'))) return true;
      if (confirm((element.dataset.label || 'Exécuter cette commande')+' ?')) await sources.action('button','press',arg); return true;
    }
    if (act==='media-browse') {
      const state=pool.find(s=>s.entity_id.startsWith('media_player.')); if (!state) return true;
      browser={items:[],stack:[],entity:state.entity_id}; await media(widget); return true;
    }
    if (['media-open','media-back','media-play'].includes(act)) {
      if (act==='media-back') { browser.stack.pop(); const it=browser.stack.pop(); await media(widget,it); }
      else { const it=browser.items[Number(arg)]; if (!it) return true;
        if (act==='media-play') { await sources.action('media_player','play_media',browser.entity,{media_content_id:it.media_content_id,media_content_type:it.media_content_type}); toast('Lecture demandée à Home Assistant.'); }
        else await media(widget,it);
      } return true;
    }
    if (act==='update-open' || act==='update-all-open') {
      opened(widget);
      const list=sources.states('update').filter(s=>s.state==='on' && !s.attributes.in_progress && (act==='update-all-open' || s.entity_id===arg));
      showModal('Mises à jour','Choisissez les installations à lancer',`<div class="picker">${list.map(s=>`<label class="pick-row"><input type="checkbox" name="install-update" value="${esc(s.entity_id)}" checked><span>${esc(s.attributes.title || s.attributes.friendly_name || s.entity_id)} · ${esc(s.attributes.installed_version)} → ${esc(s.attributes.latest_version)}</span></label>${s.attributes.release_summary ? `<p>${esc(s.attributes.release_summary)}</p>` : ''}${s.attributes.release_url ? `<a href="${esc(safeUrl(s.attributes.release_url))}" target="_blank" rel="noopener noreferrer">Notes de version</a>` : ''}<button class="button" data-act="update-notes" data-arg="${esc(s.entity_id)}">Lire les notes complètes</button>`).join('')}</div><label class="pick-row"><input type="checkbox" name="update-backup" checked>Créer une sauvegarde si l’intégration le permet</label><button class="button primary" data-act="update-install">Installer la sélection</button>`,'updates',true); return true;
    }
    if (act==='update-notes') {
      const notes=await sources.ha.releaseNotes(arg); showModal('Notes de version','',`<pre style="white-space:pre-wrap">${esc(typeof notes==='string' ? notes : notes?.release_notes || '')}</pre><button class="button" data-act="update-open" data-arg="${esc(arg)}">Retour à l’installation</button>`,'updates',true); return true;
    }
    if (act==='update-install') {
      const modal=element.closest('dialog'),ids=[...modal.querySelectorAll('[name=install-update]:checked')].map(e=>e.value);
      if (!ids.length) return true; const backup=modal.querySelector('[name=update-backup]').checked; modal.close(); install(ids,backup); return true;
    }
    return false;
  };
}
