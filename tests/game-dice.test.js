import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, GameError } from '../src/engine/game.js';
import {
  autoSetup, cloneRng, giveCards, findTileWithNumber, forceRobberTo, totalCardsInPlay,
} from './helpers.js';

function readyToRoll(seed = 5, numPlayers = 4, beginner = 1) {
  const g = createGame({ numPlayers, beginner, seed });
  autoSetup(g);
  return g;
}

test('rollDice distributes resources exactly per the board (deterministic seed)', () => {
  const g = readyToRoll(5);
  const rngPeek = cloneRng(g.rng);
  const d1 = rngPeek.nextInt(6) + 1;
  const d2 = rngPeek.nextInt(6) + 1;
  const sum = d1 + d2;

  const before = {};
  for (let i = 1; i <= g.numPlayers; i++) before[i] = g.players[i].hand.slice();

  const event = g.rollDice();
  assert.deepEqual(event.dice, [d1, d2]);
  assert.equal(event.sum, sum);
  assert.deepEqual(g.dice, [d1, d2]);

  if (sum === 7) {
    // handled by the discard test below; nothing collected
    for (let i = 1; i <= g.numPlayers; i++) assert.deepEqual(g.players[i].hand, before[i]);
    return;
  }
  // Compute expected deltas straight from the board.
  const expectedDelta = {};
  for (let i = 1; i <= g.numPlayers; i++) expectedDelta[i] = {};
  for (const tile of g.board.landTiles) {
    if (tile.hasRobber || tile.number !== sum) continue;
    for (const junc of tile.juncs) {
      const b = junc.building;
      if (b.type === 0) continue;
      expectedDelta[b.player][tile.resource] = (expectedDelta[b.player][tile.resource] || 0) + b.type;
    }
  }
  for (let i = 1; i <= g.numPlayers; i++) {
    const gotDelta = {};
    for (const c of g.players[i].hand.slice(before[i].length)) gotDelta[c] = (gotDelta[c] || 0) + 1;
    // hand is append-only during collection, so the tail is exactly the delta
    assert.deepEqual(gotDelta, expectedDelta[i], `player ${i} delta mismatch on sum ${sum}`);
  }
  assert.equal(g.phase, 'main');
});

test('the tile under the robber pays nothing, others with the same number still pay', () => {
  const g = readyToRoll(9);
  const rngPeek = cloneRng(g.rng);
  const sum = rngPeek.nextInt(6) + 1 + rngPeek.nextInt(6) + 1;
  if (sum === 7) return; // covered by the discard/7 test
  const robbed = findTileWithNumber(g.board, sum);
  if (!robbed) return; // no tile with that number on this board/seed, nothing to assert
  forceRobberTo(g, robbed);

  const before = {};
  for (let i = 1; i <= g.numPlayers; i++) before[i] = g.players[i].hand.length;

  g.rollDice();

  // No cards from the robbed tile's own junctions specifically:
  for (const junc of robbed.juncs) {
    const b = junc.building;
    if (b.type > 0) {
      // that player may still have received cards from OTHER tiles of the same number;
      // verify by recomputing total expected minus the robbed tile's contribution.
    }
  }
  // Simplest robust check: total collected this roll equals the sum over all
  // matching tiles EXCLUDING the robbed one.
  let expectedTotal = 0;
  for (const tile of g.board.landTiles) {
    if (tile.hasRobber || tile.number !== sum) continue;
    for (const junc of tile.juncs) expectedTotal += junc.building.type;
  }
  let actualTotal = 0;
  for (let i = 1; i <= g.numPlayers; i++) actualTotal += g.players[i].hand.length - before[i];
  assert.equal(actualTotal, expectedTotal);
});

test('cities pay double', () => {
  const g = readyToRoll(13);
  // Turn player `current`'s first settlement into a city.
  const p = g.current;
  const pl = g.players[p];
  const settlementsBefore = pl.placed.settlements; // 2, from setup
  const juncNo = g.board.junctions.find((j) => j.building.type === 1 && j.building.player === p).no;
  g.rollDice(); // move to 'main' (or handle a 7 first)
  while (g.phase === 'discard') {
    const e = g.discardQueue[0];
    g.discard(e.player, g.players[e.player].hand.slice(0, e.count));
  }
  if (g.phase === 'moveRobber') {
    g.moveRobber(g.board.landTiles.find((t) => !t.hasRobber).idx);
    while (g.phase === 'chooseVictim') g.chooseVictim(g.robberVictims[0]);
  }
  assert.equal(g.phase, 'main');
  giveCards(g, p, 'bbkkk');
  g.buy('city');
  g.placeCity(juncNo);
  assert.equal(pl.placed.settlements, settlementsBefore - 1);
  assert.equal(pl.placed.cities, 1);
  assert.equal(g.board.junctions[juncNo].building.type, 2);

  const cityTile = g.board.junctions[juncNo].tiles.find((t) => t.resource !== ' ');
  if (!cityTile) return;
  // Force the robber off the city's tile so it definitely pays, then collect for its number.
  if (g.board.robberTile === cityTile) forceRobberTo(g, g.board.landTiles.find((t) => t !== cityTile));
  let expected = 0;
  for (const tile of g.board.landTiles) {
    if (tile.hasRobber || tile.number !== cityTile.number) continue;
    for (const junc of tile.juncs) if (junc.building.player === p) expected += junc.building.type;
  }
  const before = pl.hand.length;
  g._collect(cityTile.number);
  const collected = pl.hand.length - before;
  assert.equal(collected, expected);
  assert.ok(expected >= 2, 'the city itself contributes 2 of the collected cards');
});

test('a roll of 7: discard queue only for hands > 7, count = floor(n/2)', () => {
  const g = readyToRoll(1);
  giveCards(g, 1, 'fffffttt'); // 8 cards -> must discard 4
  giveCards(g, 2, 'ff'); // 2 cards, untouched
  // Force a 7 by scanning ahead with a cloned rng, or just retry seeds until we get one.
  let seed = 100;
  let g2;
  for (;;) {
    g2 = createGame({ numPlayers: 4, beginner: 1, seed });
    autoSetup(g2);
    const peek = cloneRng(g2.rng);
    const sum = peek.nextInt(6) + 1 + peek.nextInt(6) + 1;
    if (sum === 7) break;
    seed++;
    if (seed > 100000) throw new Error('could not find a seed that rolls a 7');
  }
  giveCards(g2, 1, 'fffffttt'); // now 8+ cards, must discard 4
  const before = g2.players[1].hand.length;
  giveCards(g2, 2, 'f'); // ensure <=7
  const ev = g2.rollDice();
  assert.equal(ev.sum, 7);
  const expectedQueue = [];
  for (let i = 1; i <= 4; i++) {
    if (g2.players[i].hand.length > 7) expectedQueue.push({ player: i, count: Math.floor(g2.players[i].hand.length / 2) });
  }
  assert.deepEqual(g2.discardQueue, expectedQueue);
  if (expectedQueue.length > 0) assert.equal(g2.phase, 'discard');
  else assert.equal(g2.phase, 'moveRobber');
});

test('discard validates the actor, the count, and that cards are actually held', () => {
  let seed = 1;
  let g;
  for (;;) {
    g = createGame({ numPlayers: 4, beginner: 1, seed });
    autoSetup(g);
    g.players[1].hand = []; // deterministic count regardless of what setup handed out
    giveCards(g, 1, 'fffffttt'); // 8 cards -> must discard 4
    const peek = cloneRng(g.rng);
    const sum = peek.nextInt(6) + 1 + peek.nextInt(6) + 1;
    if (sum === 7) break;
    seed++;
  }
  g.rollDice();
  assert.equal(g.phase, 'discard');
  assert.equal(g.discardQueue[0].player, 1);
  assert.equal(g.discardQueue[0].count, 4);

  assert.throws(() => g.discard(2, ['f', 'f', 'f', 'f']), (e) => e instanceof GameError && e.code === 'NOT_YOUR_TURN');
  assert.throws(() => g.discard(1, ['f', 'f']), (e) => e instanceof GameError && e.code === 'BAD_ARGUMENT'); // wrong count
  assert.throws(() => g.discard(1, ['k', 'k', 'k', 'k']), (e) => e instanceof GameError && e.code === 'BAD_ARGUMENT'); // not held
  const handBefore = g.players[1].hand.slice();
  g.discard(1, ['f', 'f', 'f', 'f']);
  assert.equal(g.players[1].hand.length, handBefore.length - 4);
  assert.equal(g.phase, 'moveRobber');
});

test('moveRobber validates the target tile', () => {
  const g = readyToRoll(2);
  giveCards(g, 1, 'ffffffff');
  let seed = 2;
  let g2;
  for (;;) {
    g2 = createGame({ numPlayers: 4, beginner: 1, seed });
    autoSetup(g2);
    const peek = cloneRng(g2.rng);
    const sum = peek.nextInt(6) + 1 + peek.nextInt(6) + 1;
    if (sum === 7) break;
    seed++;
  }
  g2.rollDice();
  while (g2.phase === 'discard') {
    const e = g2.discardQueue[0];
    g2.discard(e.player, g2.players[e.player].hand.slice(0, e.count));
  }
  assert.equal(g2.phase, 'moveRobber');
  const current = g2.board.robberTile;
  assert.throws(() => g2.moveRobber(current.idx), (e) => e instanceof GameError && e.code === 'ILLEGAL_PLACEMENT');
  const sea = g2.board.tiles.find((t) => t.type === 'T');
  assert.throws(() => g2.moveRobber(sea.idx), (e) => e instanceof GameError && e.code === 'ILLEGAL_PLACEMENT');
  assert.throws(() => g2.moveRobber(9999), (e) => e instanceof GameError && e.code === 'BAD_ARGUMENT');
});

test('moveRobber: zero victims resolves immediately', () => {
  const g = readyToRoll(3);
  const empty = g.board.landTiles.find((t) => !t.hasRobber
    && t.juncs.every((j) => j.building.type === 0));
  if (!empty) return;
  // force phase moveRobber via a manual seven
  g.phase = 'moveRobber';
  g.robberReturnPhase = 'roll';
  g.moveRobber(empty.idx);
  assert.equal(g.phase, 'roll');
  assert.equal(g.robberVictims.length, 0);
});

test('moveRobber: exactly one victim steals automatically', () => {
  const g = readyToRoll(4);
  const other = (g.current % g.numPlayers) + 1;
  giveCards(g, other, 'f');
  // find a tile only touched by `other`'s building(s)
  let target = null;
  for (const t of g.board.landTiles) {
    if (t.hasRobber) continue;
    const owners = new Set(t.juncs.filter((j) => j.building.type > 0).map((j) => j.building.player));
    if (owners.size === 1 && owners.has(other)) { target = t; break; }
  }
  if (!target) return; // board didn't produce this configuration
  g.phase = 'moveRobber';
  g.robberReturnPhase = 'main';
  const before = totalCardsInPlay(g);
  g.moveRobber(target.idx);
  assert.equal(g.phase, 'main');
  assert.equal(totalCardsInPlay(g), before); // conserved, just moved
});

test('moveRobber: two or more victims -> chooseVictim, then conserves total cards', () => {
  const g = readyToRoll(6, 6); // 6 players, more buildings, more likely 2+ owners share a tile
  let target = null;
  for (const t of g.board.landTiles) {
    const owners = new Set(t.juncs.filter((j) => j.building.type > 0 && j.building.player !== g.current).map((j) => j.building.player));
    for (const p of owners) giveCards(g, p, 'f');
    if (owners.size >= 2) { target = t; break; }
  }
  if (!target) return;
  g.phase = 'moveRobber';
  g.robberReturnPhase = 'main';
  const before = totalCardsInPlay(g);
  g.moveRobber(target.idx);
  assert.equal(g.phase, 'chooseVictim');
  assert.ok(g.robberVictims.length >= 2);
  assert.throws(() => g.chooseVictim(9999), (e) => e instanceof GameError && e.code === 'BAD_ARGUMENT');
  g.chooseVictim(g.robberVictims[0]);
  assert.equal(g.phase, 'main');
  assert.equal(totalCardsInPlay(g), before);
});
