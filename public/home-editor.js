// Move/resize gestures ported from HomeDashboard/js/app.js, with storage callbacks.
// cells() : outils de la grille libre (home-grid.js) sur la tablette, null ailleurs (les modules s'échangent alors dans l'ordre).
export function attachHomeEditor({ root: $app, isEditing, isHome, maxHeight = () => 4, cells = () => null, getWidgets, getHeaderItems, persist, render, toast: showToast }) {
  const app = { get editing() { return isEditing(); }, dragging: false };
  const L = { save: persist };
  const T = Object.fromEntries(['h-date','h-clock','h-temps','h-lights','h-fullscreen'].map(type => [type, { headerOnly: true, name: type }]));
  const headerFind = id => getHeaderItems().find(item => item.id === id);
  const moduleIndex = (list, id) => list.findIndex(item => item.id === id);
  const editPage = fn => { fn(getWidgets()); persist(); render(true); };
  let gesture = null;   // current move / resize
  let pending = null;   // pointer down on a card, not yet a move
  let swallowClick = false;

  function gridMetrics(grid) {
    const cs = getComputedStyle(grid);
    const colGap = parseFloat(cs.columnGap) || 0;
    const rowGap = parseFloat(cs.rowGap) || 0;
    // A one-column stack (phone: flex column, narrow tablet: single grid track). A flex container still reports
    // its unused grid-template-columns, so the column count is only read from a real grid.
    const grid1 = cs.display === 'grid' || cs.display === 'inline-grid';
    const cols = grid1 ? cs.gridTemplateColumns.split(' ').filter(Boolean).length || 1 : 1;
    const inner = grid.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const stacked = cols === 1;
    const free = cells();
    return {
      stacked, cols, colGap, rowGap: stacked ? 0 : rowGap, free: free && !stacked ? free : null,
      col: (inner - (cols - 1) * colGap) / cols,
      // stacked: min-height = --h × 88 px, and --h counts two fine rows on the tablet grid
      row: stacked ? (free ? 44 : 88) : parseFloat(cs.gridAutoRows) || 104
    };
  }
  const clampHeight = (v) => Math.max(1, Math.min(maxHeight(), v));
  function pageModule(id) { return getWidgets().find((x) => x.id === id); }
  const widthOf = m => m.width || (cells() ? (m.size === 'full' ? 8 : m.size === 'wide' ? 4 : 2) : (m.size === 'full' ? 4 : m.size === 'wide' ? 2 : 1));
  const heightOf = m => m.height || (cells() ? 4 : 2);
  const sizeName = w => (cells() ? (w >= 8 ? 'full' : w >= 4 ? 'wide' : 'normal') : (w >= 4 ? 'full' : w >= 2 ? 'wide' : 'normal'));
  // First column of a card placed on the free grid (style "3 / span 2"), 0 when it flows.
  const startCol = host => { const s = /^\s*(\d+)\s*\//.exec(host.style.gridColumn || ''); return s ? Number(s[1]) - 1 : 0; };

  // Apply a size to the card without re-rendering (live preview while stretching).
  function previewSize(host, w, h) {
    const at = prop => { const s = /^\s*(\d+)\s*\//.exec(host.style[prop] || ''); return s ? s[1] + ' / ' : ''; };
    const coarse = n => (cells() ? Math.max(1, Math.floor(n / 2)) : n); // w/h classes stay in old grid cells (app.js)
    host.style.gridColumn = at('gridColumn') + 'span ' + w;
    host.style.gridRow = at('gridRow') + 'span ' + h;
    host.style.setProperty('--h', cells() ? h / 2 : h);
    host.className = host.className.replace(/\bw\d\b/, 'w' + coarse(w)).replace(/\bh\d\b/, 'h' + coarse(h));
    const label = host.querySelector('[data-size]');
    if (label) label.textContent = w + '×' + h;
  }

  function startResize(e, handle) {
    const host = handle.closest('[data-mod]');
    const m = host && pageModule(host.dataset.mod);
    if (!m) return;
    e.preventDefault();
    const g = gridMetrics(host.parentElement);
    g.maxW = Math.max(1, g.cols - startCol(host));
    const ghost = document.createElement('div');
    ghost.className = 'rz-ghost';
    document.body.appendChild(ghost);
    gesture = { kind: 'resize', dir: handle.dataset.rz, host, id: m.id, w0: widthOf(m), h0: heightOf(m), w: widthOf(m), h: heightOf(m), x0: e.clientX, y0: e.clientY, g, ghost, pid: e.pointerId };
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* old browsers */ }
    app.dragging = true;
    host.classList.add('is-resizing');
    document.body.classList.add('is-gesture', 'gesture-' + gesture.dir);
    moveResize(e);
  }

  function moveResize(e) {
    const r = gesture, g = r.g;
    const dx = e.clientX - r.x0, dy = e.clientY - r.y0;
    // Raw size under the pointer, from the module's grid size (not its box, which may grow with content).
    const baseW = r.w0 * (g.col + g.colGap) - g.colGap;
    const baseH = r.h0 * (g.row + g.rowGap) - g.rowGap;
    const rawW = r.dir !== 's' && !g.stacked ? Math.max(g.col * 0.6, baseW + dx) : baseW;
    const rawH = r.dir !== 'e' ? Math.max(g.row * 0.6, baseH + dy) : baseH;
    const w = g.stacked ? r.w0 : Math.max(1, Math.min(g.maxW, Math.round((rawW + g.colGap) / (g.col + g.colGap))));
    const h = clampHeight(Math.round((rawH + g.rowGap) / (g.row + g.rowGap)));
    if (w !== r.w || h !== r.h) { r.w = w; r.h = h; previewSize(r.host, w, h); }
    // The ghost frame follows the pointer exactly; the card itself snaps to the grid.
    const rect = r.host.getBoundingClientRect();
    Object.assign(r.ghost.style, { left: rect.left + 'px', top: rect.top + 'px', width: (g.stacked ? rect.width : rawW) + 'px', height: rawH + 'px' });
  }

  function scroller(host) {
    const s = host.closest('[data-scroll]');
    return s && s.scrollHeight > s.clientHeight + 2 ? s : null;
  }

  function startMove(p) {
    const host = p.host;
    pending = null;
    if (!host.isConnected) return; // redrawn meanwhile
    const sc = scroller(host);
    const fromHeader = !!host.dataset.hitem;
    const hm = fromHeader ? headerFind(host.dataset.hitem) : null;
    gesture = { kind: 'move', host, id: host.dataset.mod, x0: p.x0, y0: p.y0, x: p.x, y: p.y, sc, st0: sc ? sc.scrollTop : window.scrollY, drop: null, pid: p.pid,
      fromHeader, headerOnly: !!(hm && T[hm.type] && T[hm.type].headerOnly) };
    // Free grid (tablet): the card lands on the cells under its top left corner, shown by a dashed frame.
    const grid = fromHeader ? document.querySelector?.('.mods') : host.parentElement;
    const metrics = grid && cells() ? gridMetrics(grid) : null;
    if (metrics?.free) {
      const m = fromHeader ? hm : pageModule(gesture.id);
      Object.assign(gesture, { grid, g: metrics, rect0: host.getBoundingClientRect(), w: fromHeader ? 2 : Math.min(metrics.cols, widthOf(m)), h: fromHeader ? 4 : heightOf(m) });
    }
    app.dragging = true;
    host.classList.add('is-moving');
    document.body.classList.add('is-gesture');
    if (p.touch && navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { /* not allowed */ } }
    // Scroll the page / list while the card is held near its top or bottom edge.
    gesture.timer = setInterval(autoScroll, 16);
    updateMove();
  }

  function autoScroll() {
    const g = gesture;
    if (!g || g.kind !== 'move') return;
    const r = g.sc ? g.sc.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    // The grid's scroll area runs past the screen bottom (room for the cards' shadow).
    const box = { top: r.top, bottom: Math.min(r.bottom, window.innerHeight) };
    const edge = 60;
    let step = 0;
    if (g.y < box.top + edge) step = -Math.ceil((box.top + edge - g.y) / 5);
    else if (g.y > box.bottom - edge) step = Math.ceil((g.y - box.bottom + edge) / 5);
    if (!step) return;
    if (g.sc) g.sc.scrollTop += step; else window.scrollBy(0, step);
    updateMove();
  }

  function updateMove() {
    const g = gesture;
    const scrolled = (g.sc ? g.sc.scrollTop : window.scrollY) - g.st0;
    g.host.style.transform = `translate(${g.x - g.x0}px, ${g.y - g.y0 + scrolled}px)`;
    // Where it would land: a header item (before / after it), the end of a header zone,
    // a page module (swap, or insert when coming from the header) or the end of the page.
    const under = document.elementFromPoint(g.x, g.y);
    let drop = null;
    if (under) {
      const hi = under.closest('[data-hitem]');
      const hz = under.closest('[data-hzone]');
      const pm = under.closest('.mods [data-mod]');
      const grid = under.closest('.mods');
      if (hi && hi !== g.host) {
        const r = hi.getBoundingClientRect();
        drop = { kind: 'head-item', el: hi, zone: hi.closest('[data-hzone]').dataset.hzone, before: g.x < r.left + r.width / 2 };
      } else if (hz) drop = { kind: 'head-zone', el: hz, zone: hz.dataset.hzone };
      else if (g.grid && (grid || pm)) drop = { kind: 'page-cell', el: g.grid, ...cellUnder(g) };
      else if (pm && pm !== g.host) drop = { kind: 'page-mod', el: pm };
      else if (grid && g.fromHeader) drop = { kind: 'page-end', el: grid };
    }
    if (drop && drop.kind.startsWith('page') && g.headerOnly) drop = null; // date, clock… stay in the header
    const same = (a, b) => (a && b ? a.el === b.el && a.before === b.before && a.x === b.x && a.y === b.y : a === b);
    if (!same(drop, g.drop)) {
      const mark = d => d && d.kind !== 'page-cell';
      if (mark(g.drop)) g.drop.el.classList.remove('is-drop-target', 'drop-before', 'drop-after');
      if (mark(drop)) drop.el.classList.add('is-drop-target', ...(drop.kind === 'head-item' ? [drop.before ? 'drop-before' : 'drop-after'] : []));
      g.drop = drop;
    }
    if (g.grid) { if (drop && drop.kind === 'page-cell') g.drop = drop; showCell(g); } // the frame follows the scroll too
  }

  // Cells under the card's top left corner (the card follows the pointer), clamped to the grid.
  function cellUnder(g) {
    const m = g.g, cs = getComputedStyle(g.grid), r = g.grid.getBoundingClientRect();
    const left = r.left + (parseFloat(cs.paddingLeft) || 0), top = r.top + (parseFloat(cs.paddingTop) || 0) - g.grid.scrollTop;
    const x = Math.round((g.rect0.left + g.x - g.x0 - left) / (m.col + m.colGap));
    const y = Math.round((g.rect0.top + g.y - g.y0 - top) / (m.row + m.rowGap));
    return { x: Math.max(0, Math.min(m.cols - g.w, x)), y: Math.max(0, y), left, top };
  }
  // Dashed frame on the cells where the card will land.
  function showCell(g) {
    const d = g.drop;
    if (!g.ghost) { g.ghost = document.createElement('div'); g.ghost.className = 'rz-ghost'; document.body.appendChild(g.ghost); }
    if (!d || d.kind !== 'page-cell') { g.ghost.style.display = 'none'; return; }
    const m = g.g;
    Object.assign(g.ghost.style, { display: '', left: d.left + d.x * (m.col + m.colGap) + 'px', top: d.top + d.y * (m.row + m.rowGap) + 'px',
      width: g.w * (m.col + m.colGap) - m.colGap + 'px', height: g.h * (m.row + m.rowGap) - m.rowGap + 'px' });
  }

  // Apply a move: page ↔ page swaps; anything else takes the module out and puts it at the new place.
  function applyDrop(g) {
    const d = g.drop;
    const pageMods = getWidgets();
    const items = isHome() ? getHeaderItems() : [];
    const free = cells();
    if (!g.fromHeader && d.kind === 'page-cell') {
      free.placeModule(pageMods, g.id, { x: d.x, y: d.y });
      L.save(); render();
      return;
    }
    // Stacked free grid (narrow tablet window): the card takes the other card's place, which moves down.
    if (!g.fromHeader && d.kind === 'page-mod' && free) {
      const other = free.placeCells(pageMods).get(d.el.dataset.mod);
      if (other) free.placeModule(pageMods, g.id, { x: other.x, y: other.y });
      L.save(); render();
      return;
    }
    if (!g.fromHeader && d.kind === 'page-mod') {
      const i = moduleIndex(pageMods, g.id), j = moduleIndex(pageMods, d.el.dataset.mod);
      if (i >= 0 && j >= 0) [pageMods[i], pageMods[j]] = [pageMods[j], pageMods[i]];
      L.save(); render();
      return;
    }
    const from = g.fromHeader ? items : pageMods;
    const i = moduleIndex(from, g.id);
    if (i < 0) { render(); return; }
    const m = from.splice(i, 1)[0];
    if (d.kind === 'head-item' || d.kind === 'head-zone') {
      m.zone = d.zone;
      // Header items keep old grid cells: back on the page, halfCells sizes them again.
      if (m.half) { m.width = Math.max(1, Math.floor(widthOf(m) / 2)); m.height = Math.max(1, Math.floor(heightOf(m) / 2)); delete m.half; delete m.x; delete m.y; }
      let at;
      if (d.kind === 'head-item') { const j = moduleIndex(items, d.el.dataset.hitem); at = j < 0 ? items.length : d.before ? j : j + 1; }
      else { let last = -1; items.forEach((x, k) => { if (x.zone === d.zone) last = k; }); at = last >= 0 ? last + 1 : items.length; }
      items.splice(at, 0, m);
      if (!g.fromHeader) showToast((T[m.type] ? T[m.type].name : 'Module') + " est maintenant dans l'en-tête.");
    } else {
      delete m.zone;
      const j = d.kind === 'page-mod' ? moduleIndex(pageMods, d.el.dataset.mod) : -1;
      pageMods.splice(j >= 0 ? j : pageMods.length, 0, m);
      if (free) { free.halfCells([m]); if (d.kind === 'page-cell') free.placeModule(pageMods, m.id, { x: d.x, y: d.y }); }
    }
    L.save(); render();
  }

  function endGesture(commit) {
    const g = gesture;
    gesture = null;
    app.dragging = false;
    app.renderAfterDrag = false;
    document.body.classList.remove('is-gesture', 'gesture-e', 'gesture-s', 'gesture-se');
    if (!g) return;
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
    if (g.timer) clearInterval(g.timer);
    if (g.ghost) g.ghost.remove();
    if (g.kind === 'resize' && commit && (g.w !== g.w0 || g.h !== g.h0)) {
      editPage((mods) => { const m = mods[moduleIndex(mods, g.id)]; if (m) { m.width = g.w; m.height = g.h; m.size = sizeName(g.w); if (cells()) cells().placeModule(mods, m.id); } });
    } else if (g.kind === 'move' && commit && g.drop) {
      applyDrop(g);
    } else {
      render();
    }
  }

  $app.addEventListener('pointerdown', (e) => {
    if (!isHome() || !app.editing || gesture || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const handle = e.target.closest('[data-rz]');
    if (handle) { startResize(e, handle); return; }
    const host = e.target.closest('[data-mod]');
    if (!host) return;
    const grip = e.target.closest('[data-grip]');
    if (!grip && e.target.closest('button, a, input, textarea, select')) return;
    const touch = e.pointerType !== 'mouse';
    pending = { host, pid: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, touch };
    // The grip moves right away; elsewhere a finger has to hold still first (otherwise it scrolls).
    if (grip) { e.preventDefault(); startMove(pending); }
    else if (touch) pending.timer = setTimeout(() => { if (pending) startMove(pending); }, 300);
  });

  document.addEventListener('pointermove', (e) => {
    if (gesture && e.pointerId === gesture.pid) {
      if (gesture.kind === 'resize') moveResize(e);
      else { gesture.x = e.clientX; gesture.y = e.clientY; updateMove(); }
      return;
    }
    if (!pending || e.pointerId !== pending.pid) return;
    pending.x = e.clientX; pending.y = e.clientY;
    const dist = Math.hypot(e.clientX - pending.x0, e.clientY - pending.y0);
    if (pending.touch) { if (dist > 10) { clearTimeout(pending.timer); pending = null; } } // the finger scrolls
    else if (dist > 5) startMove(pending);
  });

  function pointerEnd(e, commit) {
    if (pending && e.pointerId === pending.pid) { clearTimeout(pending.timer); pending = null; }
    if (gesture && e.pointerId === gesture.pid) endGesture(commit);
  }
  document.addEventListener('pointerup', (e) => pointerEnd(e, true));
  document.addEventListener('pointercancel', (e) => pointerEnd(e, false));
  // Once a card is held, the finger drags it instead of scrolling the page.
  document.addEventListener('touchmove', (e) => { if (gesture) e.preventDefault(); }, { passive: false });
  // Long press on a card: no context menu.
  $app.addEventListener('contextmenu', (e) => { if (app.editing && e.target.closest('[data-mod]')) e.preventDefault(); });
  // A drag that ends over a button must not also click it.
  $app.addEventListener('click', (e) => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); } }, true);

  // Keyboard: arrows on the grip move the card, arrows on a handle resize it.
  $app.addEventListener('keydown', (e) => {
    if (!isHome() || !app.editing || !/^Arrow/.test(e.key)) return;
    const grip = e.target.closest('[data-grip]');
    const handle = e.target.closest('[data-rz]');
    if (!grip && !handle) return;
    const id = e.target.closest('[data-mod]').dataset.mod;
    e.preventDefault();
    if (grip && cells()) {
      // Free grid: one cell per press, in the arrow's direction.
      const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0, dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      editPage((mods) => { const at = cells().placeCells(mods).get(id); if (at) cells().placeModule(mods, id, { x: at.x + dx, y: at.y + dy }); });
      return;
    }
    if (grip) {
      const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      editPage((mods) => {
        const i = moduleIndex(mods, id), j = i + d;
        if (i >= 0 && j >= 0 && j < mods.length) [mods[i], mods[j]] = [mods[j], mods[i]];
      });
      return;
    }
    const dir = handle.dataset.rz;
    editPage((mods) => {
      const m = mods[moduleIndex(mods, id)];
      if (!m) return;
      const host = e.target.closest('[data-mod]'), maxW = cells() ? 8 - startCol(host) : 4;
      if (dir !== 's' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { m.width = Math.max(1, Math.min(maxW, widthOf(m) + (e.key === 'ArrowRight' ? 1 : -1))); m.size = sizeName(m.width); }
      if (dir !== 'e' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) m.height = clampHeight(heightOf(m) + (e.key === 'ArrowDown' ? 1 : -1));
      if (cells()) cells().placeModule(mods, id);
    });
  });


  return { busy: () => !!(gesture || pending) };
}
