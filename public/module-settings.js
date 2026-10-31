// Visual controls adapted from Cockpit's module editor.
// Choices update form fields only; persistence happens on Enregistrer.
import { esc, icon } from './core.js';
import { color, fonts, spanWidth, headerTypes, formatHeaderDate } from './home-display.js';

export const accents = ['#F5C542','#FF9F0A','#0A84FF','#30D158','#BF5AF2','#FF375F','#64D2FF','#AC8E68'];
export function choiceButtons(name, current, values, label) {
  return `<input type="hidden" name="${name}" value="${esc(current)}"><div class="segmented inline" role="group" aria-label="${esc(label)}">${values.map(([value,text]) => `<button type="button" data-setting="${name}" data-value="${esc(value)}" class="${String(current) === String(value) ? 'is-on' : ''}" aria-pressed="${String(current) === String(value)}">${esc(text)}</button>`).join('')}</div>`;
}
export function swatches(name, value, defaultColor, header = false) {
  const current = color(value), choices = header ? ['#F5F0E6',...accents] : accents;
  const option = (value, background, label, extra = '') => `<button type="button" class="tone ${extra} ${current.toLowerCase() === value.toLowerCase() ? 'is-on' : ''}" data-setting="${name}" data-value="${value}" aria-label="${label}" title="${label}" aria-pressed="${current.toLowerCase() === value.toLowerCase()}"><span style="background:${background}"></span></button>`;
  return `<input type="hidden" name="${name}" value="${current}"><div class="row wrap swatches" role="group" aria-label="Couleur">${option('',defaultColor,'Couleur par défaut','tone-default')}${choices.map(c => option(c,c,'Couleur '+c)).join('')}<label class="tone tone-custom ${current && !choices.some(c => c.toLowerCase() === current.toLowerCase()) ? 'is-on' : ''}" title="Autre couleur"><input type="color" value="${current || defaultColor}" data-setting-color="${name}" aria-label="Autre couleur"><span>+</span></label></div>`;
}
const row = (label, controls, extra = '') => `<div class="field-row ${extra}"><span class="field-label">${label}</span>${controls}</div>`;
export function settingsFooter(id, inHeader, remove = true) {
  return `<footer class="modal-foot">${remove ? `<button type="button" class="btn-glass danger" data-action="${inHeader ? 'header-remove' : 'remove'}" data-id="${esc(id)}">${icon('close')} Retirer</button>` : ''}<span class="grow"></span><button type="button" class="btn-glass" data-action="close-modal">Annuler</button><button class="btn-solid" type="submit">Enregistrer</button></footer>`;
}
export function headerSettingsHTML(item, now = new Date()) {
  if (item.type === 'h-fullscreen') return ''; 
  const o = item.options || {}, sample = item.type === 'h-date' ? formatHeaderDate(now,'short') : item.type === 'h-clock' ? now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}) : 'Aa 21°';
  const fontOptions = `<input type="hidden" name="hFont" value="${esc(o.hFont || '')}"><div class="font-grid" role="group" aria-label="Police">${fonts.map(([id,label,family,weight]) => `<button type="button" class="font-opt ${(o.hFont || '') === id ? 'is-on' : ''}" data-setting="hFont" data-value="${id}" aria-label="Police ${label}" aria-pressed="${(o.hFont || '') === id}"><span class="font-sample" style="${family ? 'font-family:'+family+';' : ''}${weight ? 'font-weight:'+weight : ''}">${esc(sample)}</span><span class="font-name">${label}</span></button>`).join('')}</div>`;
  let format = '';
  if (item.type === 'h-date') format = row('Format',choiceButtons('fmt',o.fmt || 'long',['long','full','short','day','num'].map(f => [f,formatHeaderDate(now,f)]),'Format de la date'));
  if (item.type === 'h-clock') format = row('Format',choiceButtons('fmt',o.fmt || '',[['',now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})],['s',now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})]],'Format de l’heure'));
  return `<form data-form="header" data-id="${esc(item.id)}" class="visual-settings-form"><input type="hidden" name="zone" value="${esc(item.zone)}"><div class="modal-body"><h3 class="field-h">Dans l’en-tête</h3>${row('Couleur',swatches('hColor',o.hColor,'#ffffff',true))}${row('Taille',choiceButtons('hSize',o.hSize || '',[['s','S'],['','M'],['l','L'],['xl','XL']],'Taille du texte'))}${row('Police',fontOptions,'field-top')}${format}${!headerTypes[item.type] ? `<p class="settings-help">Glissé sur la page, cet élément redevient un module complet.</p><button type="button" class="btn-glass" data-action="header-to-page" data-id="${esc(item.id)}">Replacer dans la page</button>` : ''}</div>${settingsFooter(item.id,true)}</form>`;
}
// Téléphone : une seule colonne, donc pas de largeur, mais une hauteur jusqu’à 8 rangs.
export function moduleSettingsHTML(widget, def, entities, grid, defaultAccent, room = null, rooms = [], { phone = false } = {}) {
  const heights = Array.from({ length: phone ? 8 : 4 }, (_, i) => [String(i + 1), String(i + 1)]);
  const dimensions = grid ? `${phone ? '' : row('Largeur',choiceButtons('width',String(spanWidth(widget)),[1,2,3,4].map(n => [String(n),String(n)]),'Largeur du module'))}${row('Hauteur',choiceButtons('height',String(widget.height || 2),heights,'Hauteur du module'))}` : '';
  const manual=Array.isArray(widget.entities) || !!widget.entity;
  const devices = !['server','guests'].includes(widget.type) && (entities.length || def.domains) ? `<input type="hidden" name="entityPicker" value="1"><h3 class="field-h">Appareils et capteurs</h3>${room ? row('Portée',choiceButtons('scope',widget.scope || 'room',[['room','Cette pièce'],['all','Toute la maison']],'Portée du module')) : ''}<div class="picker" role="group" aria-label="Appareils et capteurs"><label class="pick-row"><input type="checkbox" name="automatic" ${!manual ? 'checked' : ''}><span>Sélection automatique selon la portée</span></label>${entities.map(s => `<label class="pick-row"><input type="checkbox" name="entities" value="${esc(s.entity_id)}" ${(widget.entities || [widget.entity]).includes(s.entity_id) ? 'checked' : ''}><span class="grow">${esc(s.attributes.friendly_name || s.entity_id)}</span><span class="pick-val">${esc(s.state)}</span></label>`).join('')}<p class="settings-help">Cocher un appareil active la sélection manuelle. Réactivez Automatique pour suivre la portée.</p></div>` : '';
  const o=widget.options || {};
  let advanced='';
  if (widget.type === 'temperature') advanced=row('Affichage',choiceButtons('group',o.group || (room ? 'sensor' : 'room'),[['sensor','Par capteur'],['room','Moyenne par pièce']],'Regroupement'));
  if (['temperature','climate','rooms'].includes(widget.type)) advanced+=`<label class="pick-row"><input type="checkbox" name="tempColors" ${o.tempColors !== false ? 'checked' : ''}>Couleurs selon la température</label><div class="temperature-thresholds">${[['tLo','Froid en dessous de',18],['tHi','Confort jusqu’à',24],['tHot','Chaud jusqu’à',27]].map(([key,label,value])=>`<label class="field"><span>${label}</span><input type="number" step="0.5" name="${key}" value="${Number(o[key] ?? value)}"></label>`).join('')}</div>`;
  if (widget.type === 'calendar') advanced+=row('Vue',choiceButtons('view',o.view || 'jours',HD.Modules.CAL_VIEWS || [['jours','Jours'],['compact','Compact'],['list','Liste'],['detail','Détaillé'],['week','Semaine']],'Vue agenda'))+`<label class="field"><span>Nombre de jours</span><input type="number" name="days" min="1" max="31" value="${Number(o.days)||7}"></label><label class="pick-row"><input type="checkbox" name="traffic" ${o.traffic ? 'checked' : ''}>Afficher les informations trafic dans l’agenda</label>`;
  if (widget.type === 'transit') advanced+=`<label class="field"><span>Direction</span><select name="direction"><option value="">Toutes les directions</option>${(def.directions || []).map(value=>`<option value="${esc(value)}" ${o.direction===value ? 'selected' : ''}>${esc(value)}</option>`).join('')}</select></label>`;
  if (widget.type === 'server') advanced+=`<label class="field"><span>Serveur</span><select name="device"><option value="">Tous les nœuds</option>${(def.nodes || []).map(node=>`<option value="${esc(node.id)}" ${o.device===node.id ? 'selected' : ''}>${esc(node.name)}</option>`).join('')}</select></label>`;
  if (widget.type === 'guests') advanced+=row('Machines',choiceButtons('kind',o.kind || '',[['','Toutes'],['qemu','Machines virtuelles'],['lxc','Conteneurs']],'Type de machine'));
  if (widget.type === 'cameras') advanced+=row('Image',choiceButtons('mode',o.mode || 'live',[['live','En direct'],['still','Toutes les 10 secondes']],'Mode caméra'))+row('Cadrage',choiceButtons('fit',o.fit || 'cover',[['cover','Remplir'],['contain','Image entière']],'Cadrage'));
  if (widget.type === 'rooms') advanced+=`<h3 class="field-h">Pièces affichées</h3><input type="hidden" name="roomPicker" value="1"><div class="picker">${rooms.map(r=>`<label class="pick-row"><input type="checkbox" name="rooms" value="${esc(r.id)}" ${Array.isArray(o.rooms) ? o.rooms.includes(r.id) ? 'checked' : '' : r.id !== '__autres' ? 'checked' : ''}>${esc(r.name)}</label>`).join('')}</div>`;
  const metrics = widget.type === 'system' ? `<fieldset class="metric-choices"><legend>Mesures affichées</legend>${['cpu','ram','gpu','vram'].map(k => `<label><input type="checkbox" name="metric" value="${k}" ${(widget.metrics || ['cpu','ram','gpu','vram']).includes(k) ? 'checked' : ''}>${k.toUpperCase()}</label>`).join('')}</fieldset>` : '';
  return `<form data-form="configure" data-id="${esc(widget.id)}" class="visual-settings-form"><div class="modal-body"><label class="field"><span>Titre</span><input type="text" name="title" maxlength="80" value="${esc(widget.title || '')}" placeholder="${esc(def.title)}"></label>${dimensions}${row('Couleur',swatches('accent',widget.accent,defaultAccent))}${metrics}${advanced}${devices}</div>${settingsFooter(widget.id,false)}</form>`;
}
export function colorSettingsHTML(widget, defaultAccent) {
  return `<form data-form="colors" data-id="${esc(widget.id)}" class="visual-settings-form"><div class="modal-body">${row('Couleur',swatches('accent',widget.accent,defaultAccent))}<p class="settings-help">La couleur s’applique aux icônes, barres et tuiles allumées de ce module.</p></div>${settingsFooter(widget.id,false,false)}</form>`;
}
export function updateSettingControl(form, name, value) {
  const input = form.elements.namedItem(name); if (!input || input.type !== 'hidden') return;
  input.value = value;
  for (const button of form.querySelectorAll('[data-setting]')) {
    if (button.dataset.setting !== name) continue;
    const selected = button.dataset.value.toLowerCase() === String(value).toLowerCase();
    button.classList.toggle('is-on',selected); button.setAttribute('aria-pressed',String(selected));
  }
  const picker = form.querySelector('[data-setting-color="'+name+'"]');
  if (picker) {
    if (color(value)) picker.value = value;
    const preset = Array.from(form.querySelectorAll('[data-setting]')).some(button => button.dataset.setting === name && button.dataset.value.toLowerCase() === String(value).toLowerCase());
    picker.closest('.tone-custom').classList.toggle('is-on',!!value && !preset);
  }
}

export function commitEntityChoice(widget,formData) {
  if (!formData.has('entityPicker')) return;
  widget.entities=formData.has('automatic') ? null : formData.getAll('entities').filter(id=>/^[a-z_]+\.[\w-]+$/.test(id));
  delete widget.entity;
}
