// Tests for src/engine/ai.js. Deterministic (seeded), no dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, MAX_PIECES } from '../src/engine/game.js';
import { listRoads, NUMBER_VALUE } from '../src/engine/board.js';
import {
  createAI, junctionValue, bestSettlement, bestRobberTile, tradeResponse,
} from '../src/engine/ai.js';

// ---------------------------------------------------------------------------
// Unit tests: junctionValue / bestSettlement

// A minimal board fragment sufficient for junctionValue/bestSettlement:
// no buildings anywhere (so playerProduction is 0 everywhere, hasHarbor is
// always false), isolating the comparison to the raw NUMBER_VALUE weights.
function twoJunctionBoard() {
  const t6 = { resource: 'f', number: 6, juncs: [] };
  const t8 = { resource: 't', number: 8, juncs: [] };
  const t5 = { resource: 'b', number: 5, juncs: [] };
  const t2 = { resource: 'j', number: 2, juncs: [] };
  const t12 = { resource: 'k', number: 12, juncs: [] };
  const landTiles = [t6, t8, t5, t2, t12];
  const good = {
    no: 0, tiles: [t6, t8, t5], harbor: ' ', juncs: [], roads: [], building: { type: 0, player: 0 },
  };
  const bad = {
    no: 1, tiles: [t2, t12], harbor: ' ', juncs: [], roads: [], building: { type: 0, player: 0 },
  };
  for (const t of [t6, t8, t5]) t.juncs.push(good);
  for (const t of [t2, t12]) t.juncs.push(bad);
  good.juncs = [bad];
  bad.juncs = [good];
  const junctions = [good, bad];
  return { landTiles, tiles: landTiles, junctions, good, bad };
}

test('junctionValue: a junction on 6+8+5 beats one on 2+12', () => {
  const { good, bad } = twoJunctionBoard();
  const fakeGame = { board: { landTiles: [], junctions: [good, bad] } };
  const vGood = junctionValue(fakeGame, 1, good);
  const vBad = junctionValue(fakeGame, 1, bad);
  assert.ok(vGood > vBad, `expected ${vGood} > ${vBad}`);
  // sanity: matches the raw formula for an unbuilt board (szorzo=7 throughout).
  const sumGood = 7 * (NUMBER_VALUE[6] + NUMBER_VALUE[8] + NUMBER_VALUE[5]);
  const sumBad = 7 * (NUMBER_VALUE[2] + NUMBER_VALUE[12]);
  assert.equal(vGood, sumGood);
  assert.equal(vBad, sumBad);
});

test('bestSettlement: prefers the junction on 6+8+5 over 2+12', () => {
  const board = twoJunctionBoard();
  const fakeGame = { board };
  const pick = bestSettlement(fakeGame, 1, true);
  assert.equal(pick, board.good.no);
});

// ---------------------------------------------------------------------------
// Unit test: bestRobberTile

function robberBoard() {
  function tile(idx, number) { return { idx, type: 'N', number, juncs: [] }; }
  function junc(t, type, player) {
    const j = { tiles: [t], building: { type, player } };
    t.juncs.push(j);
    return j;
  }
  const own = tile(0, 6); // has an own building -- must never be picked
  const rich = tile(1, 8); // opponent city -- most productive
  const poor = tile(2, 2); // opponent settlement -- less productive
  const current = tile(3, 8); // current robber tile, would out-score `rich` if eligible
  junc(own, 2, 1);
  junc(rich, 2, 2);
  junc(poor, 1, 2);
  junc(current, 2, 2);
  junc(current, 2, 2); // two cities: raw sum would be highest of all
  const landTiles = [own, rich, poor, current];
  return { board: { landTiles, tiles: landTiles, robberTile: current }, own, rich, poor, current };
}

test('bestRobberTile: never own tile, never current tile, prefers the most productive opponent', () => {
  const { board, rich, current, own } = robberBoard();
  const target = bestRobberTile({ board }, 1);
  assert.equal(target, rich.idx);
  assert.notEqual(target, current.idx);
  assert.notEqual(target, own.idx);
});

// ---------------------------------------------------------------------------
// Unit tests: tradeResponse

function prodTile(idx, resource, number, buildingType, player) {
  const j = { tiles: [], building: { type: buildingType, player } };
  const t = { idx, type: 'N', resource, number, juncs: [j] };
  j.tiles = [t];
  return t;
}

test('tradeResponse: accepts a card the responder does not produce, for a surplus one', () => {
  // responder (player 2) produces 0 ore ('k') and 10 wood ('f').
  const tiles = [prodTile(0, 'f', 6, 2, 2)]; // city on a 6 -> 2*NUMBER_VALUE[6]=10
  const board = { landTiles: tiles, tiles };
  const game = {
    board,
    trade: { from: 1, responder: 2, offers: [{ give: 'k', want: 'f' }] },
    players: { 2: { hand: ['f', 'f', 'x'] } },
  };
  assert.equal(tradeResponse(game), 0);
});

test('tradeResponse: rejects when diff <= 5', () => {
  const tiles = [prodTile(0, 'f', 6, 1, 2), prodTile(1, 't', 6, 1, 2)]; // equal production, diff = 0
  const board = { landTiles: tiles, tiles };
  const game = {
    board,
    trade: { from: 1, responder: 2, offers: [{ give: 'f', want: 't' }] },
    players: { 2: { hand: ['t'] } },
  };
  assert.equal(tradeResponse(game), null);
});

test('tradeResponse: rejects a good-diff offer when the responder lacks the wanted card', () => {
  const tiles = [prodTile(0, 'f', 6, 2, 2)]; // same "good diff" setup as the accept test
  const board = { landTiles: tiles, tiles };
  const game = {
    board,
    trade: { from: 1, responder: 2, offers: [{ give: 'k', want: 'f' }] },
    players: { 2: { hand: ['k'] } }, // no 'f' to give up
  };
  assert.equal(tradeResponse(game), null);
});

// ---------------------------------------------------------------------------
// Self-play: full games, computer-only, invariants checked after every step.

function checkInvariants(game) {
  for (let p = 1; p <= game.numPlayers; p++) {
    const pl = game.players[p];
    for (const c of pl.hand) assert.ok('ftbjk'.includes(c), `bad hand letter '${c}' for player ${p}`);
    assert.ok(pl.supply.settlement >= 0 && pl.supply.city >= 0 && pl.supply.roads >= 0);
    assert.ok(pl.placed.settlements + pl.supply.settlement <= MAX_PIECES.settlement, `player ${p} settlement overflow`);
    assert.ok(pl.placed.cities + pl.supply.city <= MAX_PIECES.city, `player ${p} city overflow`);
    assert.ok(pl.placed.roads + pl.supply.roads <= MAX_PIECES.road, `player ${p} road overflow`);
  }

  // dev cards conserved: deck + everyone's dev arrays == 25
  let devTotal = game.devDeck.length;
  for (let p = 1; p <= game.numPlayers; p++) devTotal += game.players[p].dev.length;
  assert.equal(devTotal, 25, 'development card count drifted');

  // roads on the board == sum of placed.roads
  const roads = listRoads(game.board);
  let sumRoads = 0;
  for (let p = 1; p <= game.numPlayers; p++) sumRoads += game.players[p].placed.roads;
  assert.equal(roads.length, sumRoads, 'board road count vs placed.roads mismatch');

  // no two adjacent buildings (distance rule)
  for (const j of game.board.junctions) {
    if (j.building.type > 0) {
      for (const n of j.juncs) assert.equal(n.building.type, 0, `adjacent buildings at junction ${j.no}`);
    }
  }

  // every road is reachable from an own building via own roads
  for (let p = 1; p <= game.numPlayers; p++) checkRoadConnectivity(game.board, p);

  // victory points consistent with the board / longest road / largest army / VP cards
  for (let p = 1; p <= game.numPlayers; p++) {
    const pl = game.players[p];
    let expected = pl.placed.settlements + 2 * pl.placed.cities;
    if (game.longestRoad.player === p) expected += 2;
    if (game.largestArmy.player === p) expected += 2;
    for (const c of pl.dev) if (c.played && 'ktepo'.includes(c.res)) expected++;
    assert.equal(game.victoryPoints(p), expected, `victory points mismatch for player ${p}`);
  }
}

function checkRoadConnectivity(board, player) {
  const edges = [];
  for (const a of board.junctions) {
    a.juncs.forEach((b, k) => {
      if (a.roads[k] === player && a.no < b.no) edges.push([a, b]);
    });
  }
  if (edges.length === 0) return;
  const adj = new Map();
  const link = (x, y) => { if (!adj.has(x)) adj.set(x, []); adj.get(x).push(y); };
  for (const [a, b] of edges) { link(a, b); link(b, a); }
  const visited = new Set();
  const queue = [];
  for (const j of board.junctions) {
    if (j.building.type > 0 && j.building.player === player) { visited.add(j); queue.push(j); }
  }
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of (adj.get(cur) || [])) if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
  }
  for (const [a, b] of edges) {
    assert.ok(visited.has(a) && visited.has(b), `player ${player} road ${a.no}-${b.no} disconnected from own network`);
  }
}

function playSelfPlayGame(numPlayers, seed) {
  const game = createGame({
    numPlayers, beginner: 1, computer: new Array(numPlayers).fill(true), seed,
  });
  const ai = createAI();
  let steps = 0;
  while (game.phase !== 'gameOver' && steps < 20000) {
    const before = game.actor();
    const ev = ai.step(game);
    steps++;
    assert.notEqual(ev, null, `ai.step returned null for computer actor ${before} at step ${steps}`);
    checkInvariants(game);
  }
  return { game, ai, steps };
}

for (const seed of range(1, 30)) {
  test(`self-play 4 players, seed ${seed}: finishes cleanly`, () => {
    const { game, ai } = playSelfPlayGame(4, seed);
    assert.equal(game.phase, 'gameOver');
    assert.ok(game.winner >= 1 && game.winner <= 4);
    assert.ok(game.victoryPoints(game.winner) >= 10);
    assert.equal(ai.errors.length, 0, JSON.stringify(ai.errors));
  });
}

for (const numPlayers of [3, 5, 6]) {
  for (const seed of range(1, 10)) {
    test(`self-play ${numPlayers} players, seed ${seed}: finishes cleanly`, () => {
      const { game, ai } = playSelfPlayGame(numPlayers, seed);
      assert.equal(game.phase, 'gameOver');
      assert.ok(game.winner >= 1 && game.winner <= numPlayers);
      assert.ok(game.victoryPoints(game.winner) >= 10);
      assert.equal(ai.errors.length, 0, JSON.stringify(ai.errors));
    });
  }
}

function range(a, b) {
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------
// Determinism + timing/statistics summary.

test('determinism: same seed replays identically; timing/winner summary', () => {
  const seed = 4242;
  const a = playSelfPlayGame(4, seed);
  const b = playSelfPlayGame(4, seed);
  assert.deepEqual(a.game.log, b.game.log);
  assert.deepEqual(a.game.toJSON(), b.game.toJSON());

  const N = 40;
  const t0 = Date.now();
  let totalSteps = 0;
  const winners = {};
  for (let s = 1; s <= N; s++) {
    const { game, steps } = playSelfPlayGame(4, s + 10000);
    totalSteps += steps;
    winners[game.winner] = (winners[game.winner] || 0) + 1;
  }
  const totalMs = Date.now() - t0;
  const avgSteps = totalSteps / N;
  const avgMs = totalMs / N;
  console.log(`[ai self-play] ${N} games, avg ${avgSteps.toFixed(1)} ai.step() calls/game, avg ${avgMs.toFixed(2)} ms/game, winners=${JSON.stringify(winners)}`);
  assert.ok(avgMs < 1000, `expected well under 1000ms/game, got ${avgMs}ms`);
});

// ---------------------------------------------------------------------------
// Mixed: player 1 is human and never acts through the AI.

function humanAct(game) {
  const phase = game.phase;
  const p = game.current;
  if (phase === 'setup') {
    if (game.players[p].supply.settlement > 0) {
      game.placeSettlement(game.legalSettlements(p)[0]);
    } else if (game.players[p].supply.roads > 0) {
      const roads = game.legalRoads(p);
      game.placeRoad(roads[0][0], roads[0][1]);
    } else {
      game.endTurn();
    }
  } else if (phase === 'roll') {
    game.rollDice();
  } else if (phase === 'discard') {
    const e = game.discardQueue[0];
    game.discard(e.player, game.players[e.player].hand.slice(0, e.count));
  } else if (phase === 'moveRobber') {
    const board = game.board;
    const t = board.tiles.find((x) => (x.type === 'N' || x.type === 'S') && x !== board.robberTile);
    game.moveRobber(t.idx);
  } else if (phase === 'chooseVictim') {
    game.chooseVictim(game.robberVictims[0]);
  } else if (phase === 'trade') {
    game.respondTrade(null);
  } else if (phase === 'main') {
    game.endTurn();
  }
}

test('mixed: ai.step is a no-op while the human must act, and the game still completes', () => {
  const numPlayers = 4;
  const game = createGame({
    numPlayers, beginner: 1, computer: [false, true, true, true], seed: 555,
  });
  const ai = createAI();
  let steps = 0;
  let humanNoOps = 0;
  while (game.phase !== 'gameOver' && steps < 20000) {
    steps++;
    const actor = game.actor();
    if (actor === 1) {
      const before = JSON.stringify(game.toJSON());
      const ev = ai.step(game);
      assert.equal(ev, null, `ai.step should no-op for the human, got ${JSON.stringify(ev)}`);
      assert.equal(JSON.stringify(game.toJSON()), before, 'ai.step mutated the game on the human\'s turn');
      humanNoOps++;
      humanAct(game);
    } else {
      const ev = ai.step(game);
      assert.notEqual(ev, null, `ai.step returned null for computer actor ${actor}`);
    }
  }
  assert.equal(game.phase, 'gameOver');
  assert.ok(humanNoOps > 0, 'expected at least one human turn to be probed');
  assert.equal(ai.errors.length, 0, JSON.stringify(ai.errors));
});
