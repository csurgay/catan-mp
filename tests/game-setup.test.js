import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, GameError } from '../src/engine/game.js';
import { autoSetup } from './helpers.js';

// Records the acting player at the start of every one of the 2*numPlayers
// setup turns (snake order: b..b-1 forward, then b-1..b reverse -- the player
// at the turnaround gets two consecutive turns, exactly like the original).
function turnOrderOf(numPlayers, beginner, seed) {
  const g = createGame({ numPlayers, beginner, seed });
  const sequence = [];
  for (let i = 0; i < 2 * numPlayers; i++) {
    sequence.push(g.current);
    const j = g.legalSettlements(g.current)[0];
    g.placeSettlement(j);
    const road = g.legalRoads(g.current).find(([a, b]) => a === j || b === j);
    g.placeRoad(road[0], road[1]);
    g.endTurn();
  }
  return { forward: sequence.slice(0, numPlayers), reverse: sequence.slice(numPlayers), game: g };
}

test('setup order for 4 players, beginner=1: round 1 forward, round 2 reverse', () => {
  const { forward, reverse, game } = turnOrderOf(4, 1, 7);
  assert.deepEqual(forward, [1, 2, 3, 4]);
  assert.deepEqual(reverse, [4, 3, 2, 1]); // player 4 (the turnaround) goes twice in a row
  assert.equal(game.phase, 'roll');
  assert.equal(game.rounds, 3);
  assert.equal(game.current, 1);
});

test('setup order for 4 players, beginner=3', () => {
  const { forward, reverse, game } = turnOrderOf(4, 3, 7);
  assert.deepEqual(forward, [3, 4, 1, 2]);
  assert.deepEqual(reverse, [2, 1, 4, 3]);
  assert.equal(game.current, 3);
  assert.equal(game.phase, 'roll');
});

test('setup order for 6 players, beginner=1', () => {
  const { forward, reverse, game } = turnOrderOf(6, 1, 11);
  assert.deepEqual(forward, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(reverse, [6, 5, 4, 3, 2, 1]);
  assert.equal(game.current, 1);
  assert.equal(game.phase, 'roll');
});

test('setup order for 6 players, beginner=4', () => {
  const { forward, reverse, game } = turnOrderOf(6, 4, 11);
  assert.deepEqual(forward, [4, 5, 6, 1, 2, 3]);
  assert.deepEqual(reverse, [3, 2, 1, 6, 5, 4]);
  assert.equal(game.current, 4);
});

test('each setup turn grants exactly one free settlement and one free road', () => {
  const g = createGame({ numPlayers: 4, beginner: 1, seed: 3 });
  assert.deepEqual(g.players[1].supply, { settlement: 1, city: 0, roads: 1 });
  const before = g.players[1].hand.slice();
  g.placeSettlement(g.legalSettlements(1)[0]);
  g.placeRoad(...g.legalRoads(1)[0]);
  // free pieces: no cards were spent
  assert.deepEqual(g.players[1].hand, before);
  assert.equal(g.players[1].placed.settlements, 1);
  assert.equal(g.players[1].placed.roads, 1);
});

test('endTurn is refused during setup until both pieces are placed', () => {
  const g = createGame({ numPlayers: 4, beginner: 1, seed: 3 });
  assert.throws(() => g.endTurn(), (e) => e instanceof GameError && e.code === 'SETUP_INCOMPLETE');
  g.placeSettlement(g.legalSettlements(1)[0]);
  assert.throws(() => g.endTurn(), (e) => e instanceof GameError && e.code === 'SETUP_INCOMPLETE');
  g.placeRoad(...g.legalRoads(1)[0]);
  assert.doesNotThrow(() => g.endTurn());
});

test('distance rule: cannot settle adjacent to an existing building', () => {
  const g = createGame({ numPlayers: 4, beginner: 1, seed: 3 });
  const junc = g.legalSettlements(1)[0];
  g.placeSettlement(junc);
  const neighbour = g.board.junctions[junc].juncs[0];
  assert.equal(g.canPlaceSettlement(1, neighbour.no), false);
  g.placeRoad(...g.legalRoads(1)[0]);
  g.endTurn();
});

test('road must connect to own building/road; a free-floating road is illegal', () => {
  const g = createGame({ numPlayers: 4, beginner: 1, seed: 3 });
  const junc = g.legalSettlements(1)[0];
  g.placeSettlement(junc);
  // find an edge nowhere near our settlement
  const far = g.board.junctions.find((j) => j.no !== junc
    && !g.board.junctions[junc].juncs.includes(j) && j.juncs.length > 0);
  const edge = [far.no, far.juncs[0].no];
  assert.equal(g.canPlaceRoad(1, edge[0], edge[1]), false);
  assert.throws(() => g.placeRoad(edge[0], edge[1]), (e) => e instanceof GameError && e.code === 'ILLEGAL_PLACEMENT');
});

test('initial resource hand-out: every settlement pays one card per adjacent producing tile', () => {
  const g = createGame({ numPlayers: 4, beginner: 2, seed: 21 });
  const placed = autoSetup(g);
  assert.equal(g.phase, 'roll');
  assert.equal(g.rounds, 3);
  assert.equal(g.current, g.beginner);

  const expected = {};
  for (let i = 1; i <= 4; i++) expected[i] = {};
  for (const { player, junc } of placed) {
    const j = g.board.junctions[junc];
    for (const tile of j.tiles) {
      if (tile.resource === ' ') continue; // desert
      expected[player][tile.resource] = (expected[player][tile.resource] || 0) + 1;
    }
  }
  for (let i = 1; i <= 4; i++) {
    const got = {};
    for (const c of g.players[i].hand) got[c] = (got[c] || 0) + 1;
    assert.deepEqual(got, expected[i], `player ${i} initial hand mismatch`);
  }
});

test('placeSettlement is refused without supply and outside setup/main', () => {
  const g = createGame({ numPlayers: 4, beginner: 1, seed: 3 });
  autoSetup(g);
  assert.equal(g.phase, 'roll');
  assert.throws(() => g.placeSettlement(0), (e) => e instanceof GameError && e.code === 'WRONG_PHASE');
});


test('setup: a fenced-in settlement forfeits the free road instead of deadlocking endTurn', () => {
  const game = createGame({ numPlayers: 3, seed: 5, computer: [false, true, true] });
  const board = game.board;
  const junc = board.junctions.find((j) => j.juncs.length === 3 && j.tiles.length === 3);
  game.placeSettlement(junc.no);
  // Opponent roads on every edge around the new settlement (test-only board surgery).
  for (const nb of junc.juncs) {
    junc.roads[junc.juncs.indexOf(nb)] = 2;
    nb.roads[nb.juncs.indexOf(junc)] = 2;
    game.players[2].placed.roads++;
  }
  assert.equal(game.legalRoads(1).length, 0);
  assert.equal(game.players[1].supply.roads, 1);
  const before = game.current;
  game.endTurn();
  assert.notEqual(game.current, before, 'turn must advance');
  assert.equal(game.players[1].supply.roads, 0, 'the unplaceable road is forfeited');
  assert.ok(game.log.some((e) => e.type === 'forfeit' && e.player === 1 && e.roads === 1));
});

test('setup: endTurn is still refused while a legal placement exists', () => {
  const game = createGame({ numPlayers: 3, seed: 5, computer: [false, true, true] });
  assert.throws(() => game.endTurn(), (e) => e.code === 'SETUP_INCOMPLETE');
  game.placeSettlement(game.legalSettlements(1)[0]);
  assert.throws(() => game.endTurn(), (e) => e.code === 'SETUP_INCOMPLETE');
});
