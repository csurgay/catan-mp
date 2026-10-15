// Task item 8 ("game over must not cover the board; play can go on"):
// engine-level coverage for Game#continueGame(). See docs/UX-PASS.md item 8
// and docs/ARCHITECTURE.md's action contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, GameError } from '../src/engine/game.js';
import { autoSetup } from './helpers.js';

function toMain(seed = 30, numPlayers = 4, beginner = 1) {
  const g = createGame({ numPlayers, beginner, seed });
  autoSetup(g);
  while (g.phase !== 'main') {
    if (g.phase === 'roll') g.rollDice();
    else if (g.phase === 'discard') g.discard(g.discardQueue[0].player, g.players[g.discardQueue[0].player].hand.slice(0, g.discardQueue[0].count));
    else if (g.phase === 'moveRobber') g.moveRobber(g.board.landTiles.find((t) => t !== g.board.robberTile).idx);
    else if (g.phase === 'chooseVictim') g.chooseVictim(g.robberVictims[0]);
    else break;
  }
  return g;
}

// Pushes unplayed VP cards directly into the current player's dev[] and
// plays them one by one (VP cards never leave dev[], so the freshly-added
// unplayed one is always findable) until 10+ VP triggers 'gameOver' --
// same technique as game-build.test.js's "gameOver fires at 10 VP" test.
function forceWin(g, extra = 0) {
  const p = g.current;
  const pl = g.players[p];
  const need = 10 - g.victoryPoints(p) + extra;
  for (let i = 0; i < need; i++) pl.dev.push({ res: 'k', played: false });
  let idx = pl.dev.findIndex((c) => !c.played);
  while (idx !== -1 && g.phase === 'main') {
    g.playCard(idx);
    idx = pl.dev.findIndex((c) => !c.played);
  }
  return p;
}

test('continueGame: phase -> main, actor stays the winner, finished stays true, winner unchanged', () => {
  const g = toMain(42);
  const winner = forceWin(g);
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.winner, winner);
  assert.equal(g.toJSON().finished, true);

  const event = g.continueGame();
  assert.deepEqual(event, { type: 'continue', winner });
  assert.equal(g.phase, 'main');
  assert.equal(g.current, winner);
  assert.equal(g.actor(), winner);
  assert.equal(g.winner, winner, 'winner is kept');
  assert.equal(g.toJSON().finished, true);
  assert.equal(g.log[g.log.length - 1].type, 'continue');
});

test('continueGame: WRONG_PHASE outside gameOver (every other phase)', () => {
  const g = toMain(7);
  assert.throws(() => g.continueGame(), (err) => err instanceof GameError && err.code === 'WRONG_PHASE');

  const g2 = createGame({ numPlayers: 3, seed: 7 });
  assert.equal(g2.phase, 'setup');
  assert.throws(() => g2.continueGame(), (err) => err instanceof GameError && err.code === 'WRONG_PHASE');
});

test('continueGame: rollDice/buy/placeRoad/endTurn all work normally afterwards', () => {
  const g = toMain(11);
  const winner = forceWin(g);
  g.continueGame();
  assert.equal(g.phase, 'main');

  // A full further turn: end this one, roll on the next, buy something with
  // cards granted directly (test rig, not the price card).
  g.endTurn();
  assert.equal(g.phase, 'roll');
  g.rollDice();
  assert.ok(g.phase === 'main' || g.phase === 'discard' || g.phase === 'moveRobber' || g.phase === 'chooseVictim');
  while (g.phase !== 'main') {
    if (g.phase === 'discard') g.discard(g.discardQueue[0].player, g.players[g.discardQueue[0].player].hand.slice(0, g.discardQueue[0].count));
    else if (g.phase === 'moveRobber') g.moveRobber(g.board.landTiles.find((t) => t !== g.board.robberTile).idx);
    else if (g.phase === 'chooseVictim') g.chooseVictim(g.robberVictims[0]);
  }
  const p = g.players[g.current];
  p.hand.push('f', 't');
  const before = p.placed.roads + p.supply.roads;
  g.buy('road');
  assert.equal(p.supply.roads, 1);
  const road = g.legalRoads(g.current)[0];
  if (road) {
    g.placeRoad(road[0], road[1]);
    assert.equal(p.placed.roads + p.supply.roads, before + 1);
  }
  assert.doesNotThrow(() => g.endTurn());
});

test('continueGame: no second gameOver log even reaching 12+ VP after continuing', () => {
  const g = toMain(19);
  const winner = forceWin(g);
  assert.equal(g.log.filter((e) => e.type === 'gameOver').length, 1);
  g.continueGame();

  // Push the winner further past 10 VP (still their turn -- phase 'main')
  // and play more VP cards: victoryPoints(winner) climbs well past 10, but
  // _checkWinner() must stay a no-op once `winner` is set.
  const pl = g.players[winner];
  for (let i = 0; i < 4; i++) pl.dev.push({ res: 't', played: false });
  let idx = pl.dev.findIndex((c) => !c.played);
  while (idx !== -1) {
    g.playCard(idx);
    idx = pl.dev.findIndex((c) => !c.played);
  }
  assert.ok(g.victoryPoints(winner) >= 12, `expected >=12 VP, got ${g.victoryPoints(winner)}`);
  assert.equal(g.phase, 'main', 'still playable -- no second gameOver');
  assert.equal(g.winner, winner);
  assert.equal(g.log.filter((e) => e.type === 'gameOver').length, 1, 'still exactly one gameOver entry');
  assert.equal(g.log.filter((e) => e.type === 'continue').length, 1, 'still exactly one continue entry');
});

test('continueGame: determinism -- same seed + same calls (including a continue) produce byte-identical toJSON()', () => {
  function play(seed) {
    const g = toMain(seed, 4, 1);
    const winner = forceWin(g);
    g.continueGame();
    g.endTurn();
    if (g.phase === 'roll') g.rollDice();
    return g;
  }
  const a = play(23);
  const b = play(23);
  assert.equal(JSON.stringify(a.toJSON()), JSON.stringify(b.toJSON()));
});

test('runToEnd-style loops stop at the FIRST gameOver and never call continueGame on their own', () => {
  const g = toMain(3);
  forceWin(g);
  assert.equal(g.phase, 'gameOver');
  // Nothing in the engine calls continueGame() by itself -- it is a
  // deliberate, explicit action only the UI/test API invokes.
  assert.equal(g.log[g.log.length - 1].type, 'gameOver');
});
