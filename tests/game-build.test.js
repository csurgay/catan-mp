import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, GameError, COST, MAX_PIECES,
} from '../src/engine/game.js';
import { longestRoadOf, setRoad } from '../src/engine/board.js';
import { autoSetup, giveCards } from './helpers.js';

// Find a simple path of `len` edges in the raw board graph, starting from
// `startNo`, using only junctions with no road on the edge yet (BFS/DFS).
// This tests the longest-road *award* logic in isolation from the placement
// rules (those are covered separately by the "road must connect" test).
function findPath(board, startNo, len) {
  const start = board.junctions[startNo];
  const path = [start];
  const visited = new Set([start.no]);
  function extend() {
    if (path.length - 1 === len) return true;
    const tip = path[path.length - 1];
    for (const next of tip.juncs) {
      if (visited.has(next.no)) continue;
      const k = tip.juncs.indexOf(next);
      if (tip.roads[k] !== 0) continue;
      visited.add(next.no);
      path.push(next);
      if (extend()) return true;
      path.pop();
      visited.delete(next.no);
    }
    return false;
  }
  return extend() ? path.map((j) => j.no) : null;
}


function toMain(seed = 30, numPlayers = 4, beginner = 1) {
  const g = createGame({ numPlayers, beginner, seed });
  autoSetup(g);
  while (g.phase !== 'main') {
    if (g.phase === 'roll') g.rollDice();
    else if (g.phase === 'discard') {
      const e = g.discardQueue[0];
      g.discard(e.player, g.players[e.player].hand.slice(0, e.count));
    } else if (g.phase === 'moveRobber') {
      g.moveRobber(g.board.landTiles.find((t) => !t.hasRobber).idx);
    } else if (g.phase === 'chooseVictim') {
      g.chooseVictim(g.robberVictims[0]);
    }
  }
  return g;
}

test('buy road: removes cost, increments supply; refund gives cards back', () => {
  const g = toMain(30);
  const p = g.current;
  const pl = g.players[p];
  giveCards(g, p, COST.road);
  const before = pl.hand.length;
  g.buy('road');
  assert.equal(pl.hand.length, before - COST.road.length);
  assert.equal(pl.supply.roads, 1);
  g.refund('road');
  assert.equal(pl.supply.roads, 0);
  assert.equal(pl.hand.length, before);
});

test('buy settlement/city/devcard remove the right cost', () => {
  const g = toMain(31);
  const p = g.current;
  const pl = g.players[p];
  giveCards(g, p, COST.settlement);
  g.buy('settlement');
  assert.equal(pl.supply.settlement, 1);
  giveCards(g, p, COST.city);
  g.buy('city');
  assert.equal(pl.supply.city, 1);
  giveCards(g, p, COST.devcard);
  const deckBefore = g.devDeck.length;
  const ev = g.buy('devcard');
  assert.equal(ev.kind, 'devcard');
  assert.equal(g.devDeck.length, deckBefore - 1);
  assert.equal(pl.dev.length, 1);
  assert.equal(pl.dev[0].played, false);
});

test('buy throws NO_CARDS without enough resources, LIMIT at supply/piece caps, WRONG_PHASE outside main', () => {
  const g = toMain(32);
  const p = g.current;
  const pl = g.players[p];
  pl.hand = [];
  assert.throws(() => g.buy('road'), (e) => e instanceof GameError && e.code === 'NO_CARDS');

  // supply.roads capped at 2
  giveCards(g, p, COST.road + COST.road + COST.road);
  g.buy('road');
  g.buy('road');
  assert.throws(() => g.buy('road'), (e) => e instanceof GameError && e.code === 'LIMIT');

  // settlement/city supply capped at 1
  giveCards(g, p, COST.settlement + COST.settlement);
  g.buy('settlement');
  assert.throws(() => g.buy('settlement'), (e) => e instanceof GameError && e.code === 'LIMIT');

  g.phase = 'roll';
  assert.throws(() => g.buy('road'), (e) => e instanceof GameError && e.code === 'WRONG_PHASE');
});

test('piece limits: 5 settlements, 4 cities, 15 roads total (placed+supply)', () => {
  const g = toMain(33, 3, 1); // small board, fewer players -> more room
  const p = g.current;
  const pl = g.players[p];
  assert.equal(MAX_PIECES.settlement, 5);
  assert.equal(MAX_PIECES.city, 4);
  assert.equal(MAX_PIECES.road, 15);

  // Roads: place up to the limit using buy+placeRoad, respecting the 2-in-supply throttle.
  let guard = 0;
  while (pl.placed.roads < MAX_PIECES.road && guard++ < 200) {
    if (pl.supply.roads < 2) {
      giveCards(g, p, COST.road);
      g.buy('road');
    }
    const legal = g.legalRoads(p);
    if (legal.length === 0) break; // ran out of board space; still a valid outcome
    g.placeRoad(...legal[0]);
  }
  if (pl.placed.roads === MAX_PIECES.road) {
    giveCards(g, p, COST.road);
    assert.throws(() => g.buy('road'), (e) => e instanceof GameError && e.code === 'LIMIT');
  }
});

test('city limit: with 4 cities placed (or 3 placed + 1 bought) a 5th city cannot be bought', () => {
  // Regression: pieceKeys('city') used to look up placed['citys'] (undefined),
  // so NaN >= 4 was false and the 4-city limit never applied.
  const g = toMain(35);
  const p = g.current;
  const pl = g.players[p];
  pl.placed.cities = 4;
  giveCards(g, p, COST.city);
  assert.equal(g.canBuy('city'), false);
  assert.throws(() => g.buy('city'), (e) => e instanceof GameError && e.code === 'LIMIT');
  pl.placed.cities = 3;
  assert.equal(g.canBuy('city'), true);
  g.buy('city');
  giveCards(g, p, COST.city);
  assert.throws(() => g.buy('city'), (e) => e instanceof GameError && e.code === 'LIMIT');
  // Settlements go through the same lookup.
  pl.placed.settlements = 5;
  giveCards(g, p, COST.settlement);
  assert.equal(g.canBuy('settlement'), false);
  assert.throws(() => g.buy('settlement'), (e) => e instanceof GameError && e.code === 'LIMIT');
});

test('devcard: DECK_EMPTY thrown once the 25-card deck is exhausted', () => {
  const g = toMain(34);
  const p = g.current;
  const pl = g.players[p];
  const totalLeft = g.devDeck.length;
  for (let i = 0; i < totalLeft; i++) {
    giveCards(g, p, COST.devcard);
    g.buy('devcard');
  }
  assert.equal(g.devDeck.length, 0);
  giveCards(g, p, COST.devcard);
  assert.throws(() => g.buy('devcard'), (e) => e instanceof GameError && e.code === 'DECK_EMPTY');
});

test('placeCity only on the player\'s own settlement; settlements decrement, cities increment', () => {
  const g = toMain(35);
  const p = g.current;
  const other = (p % g.numPlayers) + 1;
  const pl = g.players[p];
  const own = g.board.junctions.find((j) => j.building.type === 1 && j.building.player === p).no;
  const otherJunc = g.board.junctions.find((j) => j.building.type === 1 && j.building.player === other);

  giveCards(g, p, COST.city);
  g.buy('city');
  if (otherJunc) {
    assert.throws(() => g.placeCity(otherJunc.no), (e) => e instanceof GameError && e.code === 'ILLEGAL_PLACEMENT');
  }
  const s0 = pl.placed.settlements;
  const c0 = pl.placed.cities;
  g.placeCity(own);
  assert.equal(pl.placed.settlements, s0 - 1);
  assert.equal(pl.placed.cities, c0 + 1);
  assert.equal(g.board.junctions[own].building.type, 2);
});

// Remove every road belonging to `player` from the board (used to get a clean
// baseline before laying down a controlled chain for the award-logic test).
function clearRoads(board, player) {
  for (const j of board.junctions) {
    j.juncs.forEach((n, k) => { if (j.roads[k] === player) j.roads[k] = 0; });
  }
}

test('longest road: awarded only strictly above 4, at 5+; does not transfer on a tie', () => {
  const g = toMain(1, 3, 1);
  assert.deepEqual(g.longestRoad, { length: 4, player: 0 });
  const p = g.current;
  clearRoads(g.board, p); // remove the free setup road so we control the exact length
  assert.equal(longestRoadOf(g.board, p), 0);

  const starts = g.board.junctions.filter((j) => j.building.type > 0 && j.building.player === p);
  let path5 = null;
  for (const s of starts) { path5 = findPath(g.board, s.no, 5); if (path5) break; }
  assert.ok(path5, 'test board/seed did not allow a 5-chain from either settlement');

  for (let i = 0; i < 4; i++) setRoad(g.board.junctions[path5[i]], g.board.junctions[path5[i + 1]], p);
  g.players[p].placed.roads += 4;
  g._updateLongestRoad();
  assert.equal(longestRoadOf(g.board, p), 4);
  assert.equal(g.longestRoad.player, 0, 'a length-4 chain must not yet earn the card (needs > 4)');

  setRoad(g.board.junctions[path5[4]], g.board.junctions[path5[5]], p);
  g.players[p].placed.roads += 1;
  g._updateLongestRoad();
  assert.equal(longestRoadOf(g.board, p), 5);
  assert.equal(g.longestRoad.player, p);
  assert.equal(g.longestRoad.length, 5);
  assert.equal(g.victoryPoints(p), g.players[p].placed.settlements + 2 * g.players[p].placed.cities + 2);

  // A second player matching (not exceeding) 5 must NOT take the card away.
  const other = (p % g.numPlayers) + 1;
  clearRoads(g.board, other);
  const otherStarts = g.board.junctions.filter((j) => j.building.type > 0 && j.building.player === other);
  let otherPath = null;
  for (const s of otherStarts) { otherPath = findPath(g.board, s.no, 5); if (otherPath) break; }
  if (otherPath) {
    for (let i = 0; i < 5; i++) setRoad(g.board.junctions[otherPath[i]], g.board.junctions[otherPath[i + 1]], other);
    g.players[other].placed.roads += 5;
    g._updateLongestRoad();
    assert.equal(longestRoadOf(g.board, other), 5);
    assert.equal(g.longestRoad.player, p, 'tie must keep the original holder');
  }
});

test('victory points arithmetic', () => {
  const g = toMain(41);
  const p = g.current;
  const pl = g.players[p];
  const base = pl.placed.settlements + 2 * pl.placed.cities;
  assert.equal(g.victoryPoints(p), base);
  g.longestRoad = { length: 5, player: p };
  assert.equal(g.victoryPoints(p), base + 2);
  g.largestArmy = { size: 3, player: p };
  assert.equal(g.victoryPoints(p), base + 4);
  pl.dev.push({ res: 'k', played: true });
  assert.equal(g.victoryPoints(p), base + 5);
  pl.dev.push({ res: 't', played: false }); // unplayed VP card does not count
  assert.equal(g.victoryPoints(p), base + 5);
});

test('gameOver fires at 10 VP for the current player', () => {
  const g = toMain(42);
  const p = g.current;
  const pl = g.players[p];
  // settlements(2) + cities(0) so far; push VP cards to reach 10.
  const need = 10 - g.victoryPoints(p);
  for (let i = 0; i < need; i++) pl.dev.push({ res: 'k', played: false });
  // VP cards stay in place when played (only u/f/m are spliced out), so the
  // index of each freshly-added card is stable until we play it.
  let idx = pl.dev.findIndex((c) => !c.played);
  while (idx !== -1 && g.phase === 'main') {
    g.playCard(idx);
    idx = pl.dev.findIndex((c) => !c.played);
  }
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.winner, p);
  assert.ok(g.victoryPoints(p) >= 10);
  assert.equal(g.log[g.log.length - 1].type, 'gameOver');
});
