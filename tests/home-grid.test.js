const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');

const grid = () => { const c = {}; vm.createContext(c); vm.runInContext(fs.readFileSync('public/home-grid.js', 'utf8').replace(/\bexport /g, '') + ';this.g={gridCols,spanWidth,placeCells,placeModule,halfCells};', c); return c.g; };
const plain = v => JSON.parse(JSON.stringify(v));

test('old 4 × 4 layouts keep their on-screen size on the fine grid, once only', () => {
  const g = grid();
  const list = [{ id: 'a', size: 'normal', height: 2 }, { id: 'b', size: 'wide' }, { id: 'c', width: 3, height: 4, x: 1, y: 0 }];
  assert.equal(g.halfCells(list), true);
  assert.deepEqual(plain(list.map(m => [m.width, m.height, m.half, m.x ?? null])), [[2, 4, true, null], [4, 4, true, null], [6, 8, true, null]]);
  assert.equal(g.halfCells(list), false, 'déjà sur la grille fine');
  assert.equal(list[0].width, 2);
});

test('a module can be put anywhere, leaving holes, and the modules it covers move down', () => {
  const g = grid();
  const list = [{ id: 'a', width: 4, height: 4, half: true }, { id: 'b', width: 4, height: 4, half: true }, { id: 'c', width: 2, height: 2, half: true }];
  const auto = g.placeCells(list);
  assert.deepEqual(plain([...auto.values()].map(c => [c.x, c.y])), [[0, 0], [4, 0], [0, 4]], 'sans place, premier trou libre');
  g.placeModule(list, 'c', { x: 6, y: 12 });
  assert.deepEqual(plain(list.map(m => [m.id, m.x, m.y])), [['a', 0, 0], ['b', 4, 0], ['c', 6, 12]], 'en bas à droite, même si rien n’est rempli avant');
  g.placeModule(list, 'c', { x: 3, y: 2 });
  assert.deepEqual(plain(list.map(m => [m.id, m.x, m.y])), [['a', 0, 4], ['b', 4, 4], ['c', 3, 2]], 'les modules recouverts descendent');
  g.placeModule(list, 'c', { x: 7, y: -3 });
  assert.deepEqual([list[2].x, list[2].y], [6, 0], 'reste dans la grille');
});
