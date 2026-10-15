// Board topology and setup. Faithful port of Board.java (P. Csurgay, 2004).
//
// The board is described by a character grid ("nodetype"):
//   U - unused              J - junction (settlement/city spot)
//   N - normal (land) tile  S - desert (robber starts here)
//   T - sea tile            K - harbor tile (sea tile with a harbor)
//
// Grid cell (i, j) maps to pixel coordinates x = i*50 + (j%2)*25, y = j*43,
// exactly like the original. Every tile's six junctions are its 8-neighbourhood
// cells marked 'J'. The renderer adds its own offset.
//
// Resource letters (from the original, Hungarian initials):
//   f = fa (wood/lumber), t = tegla (brick), b = buza (grain),
//   j = juh (wool/sheep), k = ko (ore)
// Terrain letters: e = erdo (forest), a = agyag (hills), g = gabonatabla (fields),
//   l = legelo (pasture), h = hegy (mountains)
// Harbor letters: '3' = 3:1 generic harbor, or one of f/t/b/j/k for 2:1.

export const RESOURCES = ['f', 't', 'b', 'j', 'k'];
export const TERRAIN_TO_RESOURCE = { e: 'f', a: 't', g: 'b', l: 'j', h: 'k' };
export const RESOURCE_TO_TERRAIN = { f: 'e', t: 'a', b: 'g', j: 'l', k: 'h' };
export const TERRAIN_NAMES = { s: 'sivatag', e: 'erdo', a: 'agyag', g: 'gabonatabla', l: 'legelo', h: 'hegy' };

// Probability weight of a number token: how many of the 36 dice outcomes hit it.
//                                  2  3  4  5  6  7  8  9 10 11 12
export const NUMBER_VALUE = [0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];

const LAYOUTS = {
  34: [
    'UUUUUTUUUUU',
    'UUUKJJKUUUU',
    'UUTJJNJJTUU',
    'KJJNJJNJJKU',
    'UJNJJNJJNJU',
    'TJJNJJNJJTU',
    'UJNJJSJJNJU',
    'KJJNJJNJJKU',
    'UJNJJNJJNJU',
    'TJJNJJNJJTU',
    'UUKJJNJJKUU',
    'UUUTJJTUUUU',
    'UUUUUKUUUUU',
  ],
  56: [
    'UUUUUUUKUUUUUU',
    'UUUUUTJJTUUUUU',
    'UUUUKJJNJJKUUU',
    'UUTJJNJJNJJTUU',
    'UKJJNJJNJJNJJK',
    'UJNJJSJJNJJNJU',
    'UTJJNJJNJJNJJT',
    'UJNJJNJJNJJNJU',
    'UKJJNJJNJJNJJK',
    'UJNJJNJJSJJNJU',
    'UTJJNJJNJJNJJT',
    'UUKJJNJJNJJKUU',
    'UUUUTJJNJJTUUU',
    'UUUUUKJJKUUUUU',
    'UUUUUUUTUUUUUU',
  ],
};

// Setup constants per board size (see Board.init in the original).
const SETUP = {
  34: {
    harborCounts: [4, 1, 1, 1, 1, 1], // '3', f, t, b, j, k
    terrainCounts: [4, 3, 4, 4, 3], // e, a, g, l, h
    numbers: [2, 3, 4, 5, 9, 10, 11, 12, 3, 4, 5, 9, 10, 11],
    sixEight: [6, 6, 8, 8],
  },
  56: {
    harborCounts: [5, 1, 1, 1, 2, 1],
    terrainCounts: [6, 5, 6, 6, 5],
    numbers: [2, 3, 4, 5, 9, 10, 11, 12, 3, 4, 5, 9, 10, 11, 2, 3, 4, 5, 9, 10, 11, 12],
    sixEight: [6, 6, 6, 8, 8, 8],
  },
};

const HARBOR_LETTERS = ['3', 'f', 't', 'b', 'j', 'k'];
const TERRAIN_LETTERS = ['e', 'a', 'g', 'l', 'h'];

// 8-neighbourhood offsets in the order used by the original (clockwise from top-left).
const AROUND = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

export function boardSizeForPlayers(numPlayers) {
  return numPlayers <= 4 ? 34 : 56;
}

/**
 * Build the board graph for the given size (34 = 3-4 players, 56 = 5-6 players).
 * Returns a plain object; call `setupBoard(board, rng)` to deal terrain,
 * harbors and number tokens.
 */
export function createBoard(size) {
  const layout = LAYOUTS[size];
  if (!layout) throw new Error(`unknown board size ${size}`);
  const cx = layout[0].length;
  const cy = layout.length;
  const at = (i, j) => (j >= 0 && j < cy && i >= 0 && i < cx ? layout[j][i] : 'U');

  const grid = Array.from({ length: cx }, () => new Array(cy).fill(null));
  const tiles = []; // every tile incl. sea and harbor tiles, in creation order
  const landTiles = []; // 'N' tiles only (same order)
  const junctions = [];

  // 1. Create nodes (column-major like the original: for i, for j).
  for (let i = 0; i < cx; i++) {
    for (let j = 0; j < cy; j++) {
      const type = at(i, j);
      const x = i * 50 + (j % 2) * 25;
      const y = j * 43;
      if (type === 'J') {
        const junc = {
          no: junctions.length,
          i, j, x, y,
          harbor: ' ', // '3', 'f', 't', 'b', 'j', 'k' or ' '
          tiles: [], // adjacent land tiles (1..3)
          juncs: [], // neighbouring junctions (2..3)
          roads: [], // roads[k] = owner of road towards juncs[k], 0 = none
          building: { type: 0, player: 0, order: 0 }, // type: 0 none, 1 settlement, 2 city
        };
        grid[i][j] = junc;
        junctions.push(junc);
      } else if (type !== 'U') {
        const tile = {
          idx: tiles.length,
          i, j, x, y,
          type, // 'N', 'S', 'T', 'K'
          terrain: ' ', // e/a/g/l/h for land, 's' for desert
          resource: ' ', // for land tiles: f/t/b/j/k; for harbor tiles: harbor letter
          number: 0,
          hasRobber: false,
          tiles: [], // neighbouring land tiles
          juncs: [], // 6 junctions for land tiles; the 2 harbor junctions for 'K'
          harborDirs: new Array(12).fill(false), // clock positions 1,3,5,7,9,11
        };
        grid[i][j] = tile;
        tiles.push(tile);
        if (type === 'N') landTiles.push(tile);
      }
    }
  }

  // 2. Link land tiles with their neighbours and their six junctions.
  for (let i = 0; i < cx; i++) {
    for (let j = 0; j < cy; j++) {
      if (at(i, j) !== 'N') continue;
      const tile = grid[i][j];
      for (let k = -2; k < 3; k++) {
        for (let l = -2; l < 3; l++) {
          if (j + l >= 0 && i + k >= 0 && at(i + k, j + l) === 'N' && k * k + l * l !== 0) {
            tile.tiles.push(grid[i + k][j + l]);
          }
        }
      }
      let prev = null;
      let first = null;
      for (const [di, dj] of AROUND) {
        const mi = i + di;
        const mj = j + dj;
        if (at(mi, mj) !== 'J') continue;
        const junc = grid[mi][mj];
        tile.juncs.push(junc);
        junc.tiles.push(tile);
        if (prev === null) {
          prev = junc;
          first = junc;
        } else {
          addNeighbour(prev, junc);
          addNeighbour(junc, prev);
          prev = junc;
        }
      }
      // close the ring: last <-> first (the original does first.addJunc(last), last.addJunc(first))
      addNeighbour(first, prev);
      addNeighbour(prev, first);
    }
  }
  for (const junc of junctions) junc.roads = new Array(junc.juncs.length).fill(0);

  // 3. Harbor tiles remember the two junctions that get the harbor.
  for (let i = 0; i < cx; i++) {
    for (let j = 0; j < cy; j++) {
      if (at(i, j) !== 'J') continue;
      const junc = grid[i][j];
      for (const [di, dj] of AROUND) {
        const mi = i + di;
        const mj = j + dj;
        if (at(mi, mj) !== 'K') continue;
        const tile = grid[mi][mj];
        if (tile.juncs.length < 2) tile.juncs.push(junc);
        else if (junc.tiles.length > 1) tile.juncs[1] = junc;
      }
    }
  }

  // 4. Harbor drawing directions (clock positions).
  for (const tile of tiles) {
    if (tile.type !== 'K') continue;
    for (let k = 0; k < 2; k++) {
      const junc = tile.juncs[k];
      if (!junc) continue;
      if (tile.y === junc.y) {
        if (tile.x > junc.x) tile.harborDirs[9] = true; else tile.harborDirs[3] = true;
      } else if (tile.y > junc.y) {
        if (tile.x > junc.x) tile.harborDirs[11] = true; else tile.harborDirs[1] = true;
      } else if (tile.x > junc.x) tile.harborDirs[7] = true; else tile.harborDirs[5] = true;
    }
  }

  return {
    size,
    cx, cy,
    width: (cx - 1) * 50 + 25,
    height: (cy - 1) * 43,
    tiles,
    landTiles,
    junctions,
    robberTile: null,
  };
}

function addNeighbour(junc, other) {
  if (!junc.juncs.includes(other)) junc.juncs.push(other);
}

/**
 * Deal terrain, harbors, number tokens and reset buildings/roads.
 * Uses `rng.nextInt(n)` exactly like Board.init() in the original, so with a
 * JavaRandom seeded identically the layout equals the Java applet's.
 */
export function setupBoard(board, rng) {
  const cfg = SETUP[board.size];
  const harborsLeft = cfg.harborCounts.slice();
  const terrainLeft = cfg.terrainCounts.slice();

  for (const tile of board.tiles) {
    tile.hasRobber = false;
    tile.number = 0;
    if (tile.type === 'T') {
      tile.terrain = ' ';
      tile.resource = ' ';
    } else if (tile.type === 'K') {
      const k = weightedPick(harborsLeft, rng);
      tile.resource = HARBOR_LETTERS[k];
      for (const junc of tile.juncs) junc.harbor = tile.resource;
    } else if (tile.type === 'N') {
      const k = weightedPick(terrainLeft, rng);
      tile.terrain = TERRAIN_LETTERS[k];
      tile.resource = TERRAIN_TO_RESOURCE[tile.terrain];
    } else if (tile.type === 'S') {
      tile.terrain = 's';
      tile.resource = ' ';
      board.robberTile = tile; // with two deserts (5-6 board) the robber starts on the last one
    }
  }
  for (const tile of board.tiles) tile.hasRobber = tile === board.robberTile;

  // Number tokens: first the 6s and 8s, which may not be neighbours; then the rest.
  let nNode = cfg.numbers.length + cfg.sixEight.length;
  for (const n of cfg.sixEight) {
    const tile = nthTile(board, rng.nextInt(nNode--) + 1, 0);
    tile.number = n;
    for (const nb of tile.tiles) {
      if (nb.number === 0) {
        nNode--;
        nb.number = 1; // placeholder: blocked for 6/8, still free for other numbers
      }
    }
  }
  let left = cfg.numbers.length;
  for (const n of cfg.numbers) {
    const tile = nthTile(board, rng.nextInt(left--) + 1, 1);
    tile.number = n;
  }

  for (const junc of board.junctions) {
    junc.building = { type: 0, player: 0, order: 0 };
    junc.roads.fill(0);
  }
  return board;
}

// Pick index k with probability proportional to counts[k], then decrement it.
// Mirrors the original's `r = R.nextInt(sum)+1; while(kr<r){kr+=c[k];k++}; k--`.
function weightedPick(counts, rng) {
  let sum = 0;
  for (const c of counts) sum += c;
  const r = rng.nextInt(sum) + 1;
  let k = 0;
  let kr = 0;
  while (kr < r) {
    kr += counts[k];
    k++;
  }
  k--;
  counts[k]--;
  return k;
}

// n-th (1-based) land tile whose number <= compare (Board.getPosTile).
function nthTile(board, n, compare) {
  for (const tile of board.landTiles) {
    if (tile.number <= compare) n--;
    if (n === 0) return tile;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Queries used by rules and AI (ports of Board.vanKikotoje / getPlayerSum etc.)

/** Does `player` own a building on a junction with harbor `res` ('3' or resource)? */
export function hasHarbor(board, player, res) {
  return board.junctions.some(
    (j) => j.building.player === player && j.building.type > 0 && j.harbor === res,
  );
}

/**
 * Production strength of `player` in resource `res`:
 * sum over that player's buildings of building.type * NUMBER_VALUE[tile.number]
 * for every adjacent land tile producing `res`. (Board.getPlayerSum)
 */
export function playerProduction(board, player, res) {
  let sum = 0;
  for (const tile of board.landTiles) {
    if (tile.resource !== res) continue;
    for (const junc of tile.juncs) {
      const b = junc.building;
      if (b.type > 0 && b.player === player) sum += b.type * NUMBER_VALUE[tile.number];
    }
  }
  return sum;
}

/** Index k such that junc.juncs[k] === other, or -1. */
export function neighbourIndex(junc, other) {
  return junc.juncs.indexOf(other);
}

/** Owner of the road between two neighbouring junctions (0 = none). */
export function roadOwner(a, b) {
  const k = a.juncs.indexOf(b);
  return k === -1 ? 0 : a.roads[k];
}

export function setRoad(a, b, player) {
  const ka = a.juncs.indexOf(b);
  const kb = b.juncs.indexOf(a);
  if (ka === -1 || kb === -1) throw new Error('setRoad: junctions are not neighbours');
  a.roads[ka] = player;
  b.roads[kb] = player;
}

/** True if any neighbouring junction has a building (distance rule). (Junction.vanszomszed) */
export function hasAdjacentBuilding(junc) {
  return junc.juncs.some((n) => n.building.type > 0);
}

/** True if `player` has a road ending at this junction. (Junction.vanideut) */
export function hasOwnRoad(junc, player) {
  return junc.roads.some((r) => r === player);
}

/** Every road on the board as [juncA, juncB, player] with A.no < B.no. */
export function listRoads(board) {
  const out = [];
  for (const a of board.junctions) {
    a.juncs.forEach((b, k) => {
      if (a.roads[k] && a.no < b.no) out.push([a, b, a.roads[k]]);
    });
  }
  return out;
}

export function nearestTile(board, x, y, maxDist, landOnly = false) {
  let best = null;
  let min = maxDist * maxDist;
  for (const t of board.tiles) {
    if (landOnly && t.type !== 'N' && t.type !== 'S') continue;
    const d = (t.x - x) ** 2 + (t.y - y) ** 2;
    if (d < min) {
      min = d;
      best = t;
    }
  }
  return best;
}

export function nearestJunction(board, x, y, maxDist) {
  let best = null;
  let min = maxDist * maxDist;
  for (const j of board.junctions) {
    const d = (j.x - x) ** 2 + (j.y - y) ** 2;
    if (d < min) {
      min = d;
      best = j;
    }
  }
  return best;
}

/**
 * Longest road of `player` (edge-simple path), port of Longest.getLongestRoad.
 * Like the original it does not treat opponents' buildings as breaking a road.
 */
export function longestRoadOf(board, player) {
  let best = 0;
  for (const junc of board.junctions) {
    const l = longestFrom(junc, player);
    if (l > best) best = l;
  }
  return best;
}

function longestFrom(junc, player) {
  let longer = 0;
  for (let k = 0; k < junc.juncs.length; k++) {
    if (junc.roads[k] !== player) continue;
    const other = junc.juncs[k];
    const kb = other.juncs.indexOf(junc);
    junc.roads[k] = 0;
    other.roads[kb] = 0;
    const l = 1 + longestFrom(other, player);
    junc.roads[k] = player;
    other.roads[kb] = player;
    if (l > longer) longer = l;
  }
  return longer;
}

/** Serializable snapshot of the board (for logs, tests and save games). */
export function boardToJSON(board) {
  return {
    size: board.size,
    robber: board.robberTile ? board.robberTile.idx : -1,
    tiles: board.tiles.map((t) => ({
      idx: t.idx, type: t.type, terrain: t.terrain, resource: t.resource, number: t.number,
      juncs: t.juncs.map((j) => j.no),
    })),
    junctions: board.junctions.map((j) => ({
      no: j.no, harbor: j.harbor, juncs: j.juncs.map((n) => n.no), roads: j.roads.slice(),
      building: { ...j.building },
    })),
  };
}
