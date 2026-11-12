// Grille libre de l'accueil tablette : huit colonnes, huit rangées par page (des demi-cellules de l'ancienne grille 4 × 4).
// Chaque module garde sa place (x, y, en cellules depuis le coin haut gauche) ; un module sans place prend la première libre.
export const gridCols = 8;
export const gridRows = 8;
export const spanWidth = m => Number.isInteger(m.width) && m.width >= 1 && m.width <= gridCols ? m.width : (m.size === 'full' ? 8 : m.size === 'wide' ? 4 : 2);
export const spanHeight = m => Number.isInteger(m.height) && m.height >= 1 ? m.height : 4;
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const placed = m => Number.isInteger(m.x) && Number.isInteger(m.y) && m.x >= 0 && m.y >= 0;

// Place de chaque module (Map id → { x, y, w, h }) : les places enregistrées d'abord, puis les autres au premier trou,
// rangée par rangée, comme le placement automatique « dense » des grilles CSS.
export function placeCells(widgets, cols = gridCols) {
  const out = new Map(), taken = [];
  const box = m => ({ w: Math.min(cols, spanWidth(m)), h: spanHeight(m) });
  for (const m of widgets) if (placed(m)) { const b = box(m), c = { ...b, x: Math.min(m.x, cols - b.w), y: m.y }; out.set(m.id, c); taken.push(c); }
  for (const m of widgets) {
    if (out.has(m.id)) continue;
    const b = box(m);
    let c = null;
    for (let y = 0; !c; y++) for (let x = 0; x + b.w <= cols && !c; x++) if (!taken.some(t => overlaps(t, { ...b, x, y }))) c = { ...b, x, y };
    out.set(m.id, c); taken.push(c);
  }
  return out;
}

// Pose le module `id` à la place `at` ({ x, y } en cellules) et fige la place de tous les autres ;
// ceux qu'il recouvre descendent juste assez pour libérer la place (les trous restent où l'utilisateur les a laissés).
export function placeModule(widgets, id, at = {}, cols = gridCols) {
  const cells = placeCells(widgets, cols), me = cells.get(id);
  if (!me) return;
  if (Number.isInteger(at.x)) me.x = at.x;
  if (Number.isInteger(at.y)) me.y = at.y;
  me.x = Math.max(0, Math.min(cols - me.w, me.x)); me.y = Math.max(0, me.y);
  const settled = [me];
  for (const m of widgets.filter(m => m.id !== id).sort((a, b) => cells.get(a.id).y - cells.get(b.id).y || cells.get(a.id).x - cells.get(b.id).x)) {
    const c = cells.get(m.id);
    for (let hit = settled.filter(s => overlaps(s, c)); hit.length; hit = settled.filter(s => overlaps(s, c))) c.y = Math.max(...hit.map(s => s.y + s.h));
    settled.push(c);
  }
  for (const m of widgets) { const c = cells.get(m.id); m.x = c.x; m.y = c.y; }
}

// Passage à la grille fine : un module enregistré sur l'ancienne grille 4 × 4 garde exactement sa taille à l'écran
// (largeur et hauteur doublées) et reprend sa place dans l'ordre. Rend vrai si la liste a changé.
export function halfCells(widgets) {
  let changed = false;
  for (const m of widgets) {
    if (m.half) continue;
    const span = Number.isInteger(m.width) && m.width >= 1 && m.width <= 4 ? m.width : m.size === 'full' ? 4 : m.size === 'wide' ? 2 : 1;
    m.width = span * 2; m.height = Math.min(gridRows, (Number.isInteger(m.height) && m.height >= 1 ? m.height : 2) * 2); m.half = true;
    delete m.x; delete m.y;
    changed = true;
  }
  return changed;
}
