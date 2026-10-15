import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBoard, setupBoard, hasHarbor, playerProduction, longestRoadOf, setRoad,
  boardToJSON, NUMBER_VALUE,
} from '../src/engine/board.js';
import { JavaRandom } from '../src/engine/rng.js';

const EXPECTED = {
  34: { land: 18, junctions: 54, harbors: 9, sea: 9, desert: 1 }, // 'N' tiles; desert is separate
  56: { land: 28, junctions: 80, harbors: 11, sea: 11, desert: 2 },
};

for (const size of [34, 56]) {
  test(`board ${size}: node counts match the physical game`, () => {
    const b = createBoard(size);
    const e = EXPECTED[size];
    assert.equal(b.landTiles.length, e.land, 'producing land tiles');
    assert.equal(b.tiles.filter((t) => t.type === 'S').length, e.desert);
    assert.equal(b.junctions.length, e.junctions);
    assert.equal(b.tiles.filter((t) => t.type === 'K').length, e.harbors);
    assert.equal(b.tiles.filter((t) => t.type === 'T').length, e.sea);
  });

  test(`board ${size}: every land tile has 6 junctions, every junction 2-3 neighbours and 1-3 tiles`, () => {
    const b = createBoard(size);
    for (const t of b.landTiles) assert.equal(t.juncs.length, 6, `tile ${t.idx}`);
    for (const j of b.junctions) {
      assert.ok(j.juncs.length >= 2 && j.juncs.length <= 3, `junction ${j.no} has ${j.juncs.length} neighbours`);
      assert.ok(j.tiles.length >= 1 && j.tiles.length <= 3, `junction ${j.no} has ${j.tiles.length} tiles`);
      assert.equal(j.roads.length, j.juncs.length);
      // neighbour relation is symmetric
      for (const n of j.juncs) assert.ok(n.juncs.includes(j), `asymmetric neighbour ${j.no}-${n.no}`);
      // neighbouring junctions are 50px apart (hex edge length in this grid)
      for (const n of j.juncs) {
        const d = Math.hypot(n.x - j.x, n.y - j.y);
        assert.ok(d > 45 && d < 55, `junction ${j.no}-${n.no} distance ${d}`);
      }
    }
    // Euler-ish sanity: number of edges = (sum of degrees)/2
    const edges = b.junctions.reduce((s, j) => s + j.juncs.length, 0) / 2;
    // Euler: V - E + F = 2 with F = hexes + 1  ->  54-72+20 = 2 and 80-109+31 = 2
    assert.equal(edges, size === 34 ? 72 : 109);
  });

  test(`board ${size}: harbors touch exactly two junctions each, both marked`, () => {
    const b = createBoard(size);
    const rng = new JavaRandom(1);
    setupBoard(b, rng);
    for (const t of b.tiles.filter((x) => x.type === 'K')) {
      assert.equal(t.juncs.length, 2, `harbor ${t.idx}`);
      assert.notEqual(t.juncs[0], t.juncs[1]);
      for (const j of t.juncs) assert.equal(j.harbor, t.resource);
      assert.equal(t.harborDirs.filter(Boolean).length, 2);
    }
    const marked = b.junctions.filter((j) => j.harbor !== ' ').length;
    assert.equal(marked, EXPECTED[size].harbors * 2);
  });

  test(`board ${size}: setup deals the right terrain, harbor and number multiset; 6/8 never adjacent`, () => {
    for (let seed = 0; seed < 25; seed++) {
      const b = createBoard(size);
      setupBoard(b, new JavaRandom(seed));
      const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
      const terrain = count(b.landTiles, (t) => t.terrain);
      const harbors = count(b.tiles.filter((t) => t.type === 'K'), (t) => t.resource);
      const numbers = count(b.landTiles, (t) => t.number);
      if (size === 34) {
        assert.deepEqual(terrain, { e: 4, a: 3, g: 4, l: 4, h: 3 });
        assert.deepEqual(harbors, { 3: 4, f: 1, t: 1, b: 1, j: 1, k: 1 });
        assert.deepEqual(numbers, { 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 1 });
      } else {
        assert.deepEqual(terrain, { e: 6, a: 5, g: 6, l: 6, h: 5 });
        assert.deepEqual(harbors, { 3: 5, f: 1, t: 1, b: 1, j: 2, k: 1 });
        assert.deepEqual(numbers, { 2: 2, 3: 3, 4: 3, 5: 3, 6: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 2 });
      }
      for (const t of b.landTiles) {
        if (t.number === 6 || t.number === 8) {
          for (const n of t.tiles) assert.ok(n.number !== 6 && n.number !== 8, `seed ${seed}: 6/8 adjacent`);
        }
      }
      const deserts = b.tiles.filter((t) => t.type === 'S');
      assert.ok(deserts.includes(b.robberTile));
      assert.ok(b.robberTile.hasRobber);
      assert.equal(b.tiles.filter((t) => t.hasRobber).length, 1);
    }
  });

  test(`board ${size}: setup is deterministic for a seed`, () => {
    const a = boardToJSON(setupBoard(createBoard(size), new JavaRandom(4242)));
    const b = boardToJSON(setupBoard(createBoard(size), new JavaRandom(4242)));
    const c = boardToJSON(setupBoard(createBoard(size), new JavaRandom(4243)));
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });
}

test('harbor and production queries', () => {
  const b = setupBoard(createBoard(34), new JavaRandom(7));
  const harborJunc = b.junctions.find((j) => j.harbor === '3');
  assert.equal(hasHarbor(b, 1, '3'), false);
  harborJunc.building = { type: 1, player: 1, order: 1 };
  assert.equal(hasHarbor(b, 1, '3'), true);
  assert.equal(hasHarbor(b, 2, '3'), false);

  const tile = b.landTiles.find((t) => t.number === 8);
  const j = tile.juncs[0];
  j.building = { type: 2, player: 3, order: 1 };
  let expected = 0;
  for (const t of j.tiles) if (t.resource === tile.resource) expected += 2 * NUMBER_VALUE[t.number];
  assert.equal(playerProduction(b, 3, tile.resource), expected);
});

test('longest road: straight line, branch and loop', () => {
  const b = createBoard(34);
  // follow a chain of neighbours to build a 5-long path for player 1
  // start from an interior junction (3 neighbours) so the walk cannot dead-end
  let cur = b.junctions.find((j) => j.juncs.length === 3 && j.tiles.length === 3);
  const path = [cur];
  while (path.length < 6) {
    const next = cur.juncs.find((n) => !path.includes(n) && n.juncs.length === 3) || cur.juncs.find((n) => !path.includes(n));
    path.push(next);
    cur = next;
  }
  for (let i = 0; i < 5; i++) setRoad(path[i], path[i + 1], 1);
  assert.equal(longestRoadOf(b, 1), 5);
  assert.equal(longestRoadOf(b, 2), 0);
  // a branch from the middle adds nothing to the longest single path
  const mid = path[2];
  const side = mid.juncs.find((n) => !path.includes(n));
  if (side) {
    setRoad(mid, side, 1);
    assert.equal(longestRoadOf(b, 1), 5);
  }
  // an opponent road does not count
  const tail = path[5].juncs.find((n) => !path.includes(n));
  if (tail) {
    setRoad(path[5], tail, 2);
    assert.equal(longestRoadOf(b, 1), 5);
    assert.equal(longestRoadOf(b, 2), 1);
  }

  // a full hexagon ring (6 edges) for player 4 counts 6
  const b2 = createBoard(34);
  const ring = b2.landTiles[0].juncs;
  for (let i = 0; i < 6; i++) setRoad(ring[i], ring[(i + 1) % 6], 4);
  assert.equal(longestRoadOf(b2, 4), 6);
});
