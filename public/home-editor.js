// Move/resize gestures ported from HomeDashboard/js/app.js, with storage callbacks.
export function attachHomeEditor({ root: $app, isEditing, isHome, maxHeight = () => 4, getWidgets, getHeaderItems, persist, render, toast: showToast }) {
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
    return {
      stacked, colGap, rowGap: stacked ? 0 : rowGap,
      col: (inner - (cols - 1) * colGap) / cols,
      row: stacked ? 88 : parseFloat(cs.gridAutoRows) || 104 // stacked: min-height = h × 88 px
    };
  }
  const clampSize = (v) => Math.max(1, Math.min(4, v));
  const clampHeight = (v) => Math.max(1, Math.min(maxHeight(), v));
  function pageModule(id) { return getWidgets().find((x) => x.id === id); }

  // Apply a size to the card without re-rendering (live preview while stretching).
  function previewSize(host, w, h) {
    host.style.gridColumn = 'span ' + w;
    host.style.gridRow = 'span ' + h;
    host.style.setProperty('--h', h);
    host.className = host.className.replace(/\bw\d\b/, 'w' + w).replace(/\bh\d\b/, 'h' + h);
    const label = host.querySelector('[data-size]');
    if (label) label.textContent = w + '×' + h;
  }

  function startResize(e, handle) {
    const host = handle.closest('[data-mod]');
    const m = host && pageModule(host.dataset.mod);
    if (!m) return;
    e.preventDefault();
    const g = gridMetrics(host.parentElement);
    const ghost = document.createElement('div');
    ghost.className = 'rz-ghost';
    document.body.appendChild(ghost);
    gesture = { kind: 'resize', dir: handle.dataset.rz, host, id: m.id, w0: m.width || (m.size === 'full' ? 4 : m.size === 'wide' ? 2 : 1), h0: m.height || 2, w: m.width || (m.size === 'full' ? 4 : m.size === 'wide' ? 2 : 1), h: m.height || 2, x0: e.clientX, y0: e.clientY, g, ghost, pid: e.pointerId };
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
    const w = g.stacked ? r.w0 : clampSize(Math.round((rawW + g.colGap) / (g.col + g.colGap)));
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
      else if (pm && pm !== g.host) drop = { kind: 'page-mod', el: pm };
      else if (grid && g.fromHeader) drop = { kind: 'page-end', el: grid };
    }
    if (drop && drop.kind.startsWith('page') && g.headerOnly) drop = null; // date, clock… stay in the header
    const same = (a, b) => (a && b ? a.el === b.el && a.before === b.before : a === b);
    if (!same(drop, g.drop)) {
      if (g.drop) g.drop.el.classList.remove('is-drop-target', 'drop-before', 'drop-after');
      if (drop) drop.el.classList.add('is-drop-target', ...(drop.kind === 'head-item' ? [drop.before ? 'drop-before' : 'drop-after'] : []));
      g.drop = drop;
    }
  }

  // Apply a move: page ↔ page swaps; anything else takes the module out and puts it at the new place.
  function applyDrop(g) {
    const d = g.drop;
    const pageMods = getWidgets();
    const items = isHome() ? getHeaderItems() : [];
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
      let at;
      if (d.kind === 'head-item') { const j = moduleIndex(items, d.el.dataset.hitem); at = j < 0 ? items.length : d.before ? j : j + 1; }
      else { let last = -1; items.forEach((x, k) => { if (x.zone === d.zone) last = k; }); at = last >= 0 ? last + 1 : items.length; }
      items.splice(at, 0, m);
      if (!g.fromHeader) showToast((T[m.type] ? T[m.type].name : 'Module') + " est maintenant dans l'en-tête.");
    } else {
      delete m.zone;
      const j = d.kind === 'page-mod' ? moduleIndex(pageMods, d.el.dataset.mod) : -1;
      pageMods.splice(j >= 0 ? j : pageMods.length, 0, m);
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
      editPage((mods) => { const m = mods[moduleIndex(mods, g.id)]; if (m) { m.width = g.w; m.height = g.h; m.size = g.w >= 4 ? 'full' : g.w >= 2 ? 'wide' : 'normal'; } });
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
      if (dir !== 's' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { m.width = clampSize((m.width || (m.size === 'full' ? 4 : m.size === 'wide' ? 2 : 1)) + (e.key === 'ArrowRight' ? 1 : -1)); m.size = m.width >= 4 ? 'full' : m.width >= 2 ? 'wide' : 'normal'; }
      if (dir !== 'e' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) m.height = clampHeight((m.height || 2) + (e.key === 'ArrowDown' ? 1 : -1));
    });
  });


  return { busy: () => !!(gesture || pending) };
}
