import { read, write } from './core.js';

export const pageOrder = ['overview','agents','projects','home','news','system'];
export const screenOrder = ['desktop','tablet','phone','compact'];
// Le téléphone reprend l’apparence de la tablette, en une seule colonne.
export const usesGrid = profile => profile === 'tablet' || profile === 'phone';
// Écran de téléphone : petit côté sous 600 px et écran tactile, en portrait comme en paysage.
export const isPhoneScreen = (w = globalThis.screen) => !!w && Math.min(w.width, w.height) < 600 && !!globalThis.matchMedia?.('(pointer:coarse)').matches;
export const defaultProfile = ({ phone = false, servedByHA = false } = {}) => phone ? 'phone' : servedByHA ? 'tablet' : 'desktop';
export const selectedTheme = () => read('mb.theme', /^\/local\//.test(location.pathname) ? 'home' : 'feedme') === 'home' ? 'home' : 'feedme';
export function sanitizeTabs(value) {
  const out = {};
  for (const screen of screenOrder) {
    const saved = value && value[screen];
    const valid = Array.isArray(saved) ? pageOrder.filter(id => saved.includes(id)) : null;
    out[screen] = valid?.length ? valid : screen === 'compact' ? ['overview','agents'] : [...pageOrder];
  }
  return out;
}
// Première ouverture du téléphone : on repart des modules de la tablette, ramenés à une colonne (mêmes notes).
export const phoneWidgets = list => JSON.parse(JSON.stringify(list || [])).map(w => ({ ...w, width: 1, size: 'normal' }));
export let tabPreferences = sanitizeTabs(read('mb.tabs.v1', null));
// L'onglet Projets apparaît une fois sur le bureau et la tablette, même avec des choix déjà enregistrés.
if (!read('mb.tabs.projects', false)) { for (const screen of ['desktop','tablet']) if (!tabPreferences[screen].includes('projects')) tabPreferences[screen] = pageOrder.filter(id => [...tabPreferences[screen],'projects'].includes(id)); write('mb.tabs.v1', tabPreferences); write('mb.tabs.projects', true); }
export const visibleTabs = profile => tabPreferences[profile] || tabPreferences.desktop;
export function setTabs(profile, ids) {
  if (!screenOrder.includes(profile)) return false;
  const valid = pageOrder.filter(id => ids.includes(id));
  if (!valid.length) return false;
  tabPreferences[profile] = valid;
  return write('mb.tabs.v1', tabPreferences);
}
export function importTabs(value) { tabPreferences = sanitizeTabs(value); write('mb.tabs.v1',tabPreferences); }
