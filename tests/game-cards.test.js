import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, GameError, COST, MAX_PIECES,
} from '../src/engine/game.js';
import { autoSetup, giveCards, totalDevCards } from './helpers.js';

function toMain(seed = 50, numPlayers = 4, beginner = 1) {
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

test('knight: playing it moves to moveRobber and returns to the original phase (main)', () => {
  const g = toMain(50);
  const p = g.current;
  const pl = g.players[p];
  pl.dev.push({ res: 'l', played: false });
  const idx = pl.dev.length - 1;
  const ev = g.playCard(idx);
  assert.equal(ev.res, 'l');
  assert.equal(g.phase, 'moveRobber');
  assert.equal(g.robberReturnPhase, 'main');
  assert.equal(pl.dev[idx].played, true);
  g.moveRobber(g.board.landTiles.find((t) => !t.hasRobber).idx);
  while (g.phase === 'chooseVictim') g.chooseVictim(g.robberVictims[0]);
  assert.equal(g.phase, 'main');
});

test('knight: can also be played from the roll phase, and returns there', () => {
  const g = createGame({ numPlayers: 4, beginner: 1, seed: 51 });
  autoSetup(g);
  assert.equal(g.phase, 'roll');
  const p = g.current;
  const pl = g.players[p];
  pl.dev.push({ res: 'l', played: false });
  const idx = pl.dev.length - 1;
  g.playCard(idx);
  assert.equal(g.phase, 'moveRobber');
  assert.equal(g.robberReturnPhase, 'roll');
  g.moveRobber(g.board.landTiles.find((t) => !t.hasRobber).idx);
  while (g.phase === 'chooseVictim') g.chooseVictim(g.robberVictims[0]);
  assert.equal(g.phase, 'roll');
});

test('knight: cannot be played twice, and a played card cannot be replayed', () => {
  const g = toMain(52);
  const p = g.current;
  const pl = g.players[p];
  pl.dev.push({ res: 'l', played: false });
  const idx = pl.dev.length - 1;
  g.playCard(idx);
  g.moveRobber(g.board.landTiles.find((t) => !t.hasRobber).idx);
  while (g.phase === 'chooseVictim') g.chooseVictim(g.robberVictims[0]);
  assert.throws(() => g.playCard(idx), (e) => e instanceof GameError && e.code === 'BAD_ARGUMENT');
});

test('largest army: awarded at 3 played knights, moves only when strictly exceeded', () => {
  const g = toMain(53, 3, 1);
  assert.deepEqual(g.largestArmy, { size: 2, player: 0 });
  const p = g.current;
  const pl = g.players[p];
  for (let i = 0; i < 3; i++) {
    pl.dev.push({ res: 'l', played: false });
    const idx = pl.dev.length - 1;
    g.playCard(idx);
    g.moveRobber(g.board.landTiles.find((t) => !t.hasRobber).idx);
    while (g.phase === 'chooseVictim') g.chooseVictim(g.robberVictims[0]);
    if (i < 2) assert.equal(g.largestArmy.player, 0, `should not be awarded at ${i + 1} knights`);
  }
  assert.equal(g.knightsPlayed(p), 3);
  assert.equal(g.largestArmy.player, p);
  assert.equal(g.largestArmy.size, 3);

  // A second player reaching 3 (not exceeding) does not take it away.
  const other = (p % g.numPlayers) + 1;
  const opl = g.players[other];
  g.current = other; // force actor for this isolated check
  for (let i = 0; i < 3; i++) {
    opl.dev.push({ res: 'l', played: false });
    const idx = opl.dev.length - 1;
    g.playCard(idx);
    g.moveRobber(g.board.landTiles.find((t) => !t.hasRobber).idx);
    while (g.phase === 'chooseVictim') g.chooseVictim(g.robberVictims[0]);
  }
  assert.equal(g.knightsPlayed(other), 3);
  assert.equal(g.largestArmy.player, p, 'a tie must not transfer the army card');
});

// Buy real development cards from the deck (through the public buy() action)
// until one of the requested letter turns up; leaves any others sitting
// unplayed in the player's dev array. Keeps the deck+hands total honest.
function drawFromDeckUntil(g, player, letter) {
  const pl = g.players[player];
  let guard = 30;
  while (!pl.dev.some((c) => c.res === letter && !c.played) && g.devDeck.length > 0 && guard-- > 0) {
    giveCards(g, player, COST.devcard);
    g.buy('devcard');
  }
  return pl.dev.findIndex((c) => c.res === letter && !c.played);
}

test('road building: grants up to 2 roads, respects the 15-road limit, and recycles the card', () => {
  const g = toMain(54);
  const p = g.current;
  const pl = g.players[p];
  const idx = drawFromDeckUntil(g, p, 'u');
  assert.ok(idx !== -1, 'seed did not produce a road-building card within the deck');
  const deckSizeBefore = totalDevCards(g);
  const before = pl.supply.roads;
  g.playCard(idx);
  assert.equal(pl.supply.roads, before + 2);
  assert.equal(pl.dev.some((c) => c.res === 'u'), false, 'the u card is removed, not just marked played');
  assert.equal(totalDevCards(g), deckSizeBefore); // recycled, not destroyed

  // Now push placed.roads to 14 so only 1 more road can be granted.
  pl.placed.roads = MAX_PIECES.road - 1;
  pl.supply.roads = 0;
  const idx2 = drawFromDeckUntil(g, p, 'u');
  if (idx2 === -1) return; // the recycled 'u' may not be drawn again before the deck empties on tiny boards
  g.playCard(idx2);
  assert.equal(pl.supply.roads, 1, 'must not exceed the 15-piece total');
});

test('road building: refunding a card-granted road gives back no cards (it was never bought)', () => {
  const g = toMain(54);
  const p = g.current;
  const pl = g.players[p];
  const idx = drawFromDeckUntil(g, p, 'u');
  assert.ok(idx !== -1, 'seed did not produce a road-building card within the deck');
  const handBefore = pl.hand.slice();
  g.playCard(idx);
  assert.equal(pl.supply.roads, 2, 'road building grants 2 roads to supply');
  assert.deepEqual(pl.hand, handBefore, 'playing the card itself must not change the hand');

  g.refund('road');
  assert.equal(pl.supply.roads, 1);
  assert.deepEqual(pl.hand, handBefore, 'refunding a free granted road must not mint cards');

  g.refund('road');
  assert.equal(pl.supply.roads, 0);
  assert.deepEqual(pl.hand, handBefore, 'refunding the second free granted road must not mint cards either');

  // A road actually bought with cards must still be refunded normally.
  giveCards(g, p, COST.road);
  const handWithBoughtRoad = pl.hand.slice();
  g.buy('road');
  g.refund('road');
  assert.deepEqual(pl.hand.slice().sort(), handWithBoughtRoad.sort(), 'a bought-and-refunded road still returns its cards');
});

test('year of plenty: adds the two chosen resources and recycles the card', () => {
  const g = toMain(55);
  const p = g.current;
  const pl = g.players[p];
  pl.dev.push({ res: 'f', played: false });
  const idx = pl.dev.length - 1;
  const before = pl.hand.length;
  assert.throws(() => g.playCard(idx, { resources: ['f'] }), (e) => e instanceof GameError && e.code === 'BAD_ARGUMENT');
  assert.throws(() => g.playCard(idx, { resources: ['f', 'x'] }), (e) => e instanceof GameError && e.code === 'BAD_ARGUMENT');
  const ev = g.playCard(idx, { resources: ['b', 'k'] });
  assert.deepEqual(ev.resources, ['b', 'k']);
  assert.equal(pl.hand.length, before + 2);
  assert.ok(pl.hand.includes('b') && pl.hand.includes('k'));
});

test('monopoly: takes every matching card from every other player', () => {
  const g = toMain(56);
  const p = g.current;
  const pl = g.players[p];
  for (let i = 1; i <= g.numPlayers; i++) if (i !== p) giveCards(g, i, 'tt');
  giveCards(g, p, 'f'); // unrelated card, unaffected
  let expectedTaken = 0;
  for (let i = 1; i <= g.numPlayers; i++) {
    if (i === p) continue;
    expectedTaken += g.players[i].hand.filter((c) => c === 't').length;
  }
  pl.dev.push({ res: 'm', played: false });
  const idx = pl.dev.length - 1;
  const ev = g.playCard(idx, { resource: 't' });
  assert.equal(ev.taken, expectedTaken);
  assert.equal(pl.hand.filter((c) => c === 't').length, expectedTaken);
  for (let i = 1; i <= g.numPlayers; i++) if (i !== p) assert.equal(g.players[i].hand.includes('t'), false);
});

test('VP cards count toward victoryPoints once played', () => {
  const g = toMain(57);
  const p = g.current;
  const pl = g.players[p];
  const before = g.victoryPoints(p);
  pl.dev.push({ res: 'k', played: false });
  const idx = pl.dev.length - 1;
  assert.equal(g.victoryPoints(p), before); // not yet played
  g.playCard(idx);
  assert.equal(pl.dev[idx].played, true);
  assert.equal(g.victoryPoints(p), before + 1);
});

test('u/f/m recycle back into the deck: total dev cards (deck + all hands) stays 25', () => {
  const g = toMain(58);
  const p = g.current;
  assert.equal(totalDevCards(g), 25);

  for (const letter of ['u', 'f', 'm']) {
    const idx = drawFromDeckUntil(g, p, letter);
    if (idx === -1) continue; // deck exhausted before this letter turned up; skip
    assert.equal(totalDevCards(g), 25, `total before playing '${letter}'`);
    const opts = letter === 'f' ? { resources: ['f', 't'] } : letter === 'm' ? { resource: 't' } : undefined;
    g.playCard(idx, opts);
    assert.equal(totalDevCards(g), 25, `total after playing '${letter}'`);
  }
});

test('playCard is refused outside main (except knight, which also works from roll)', () => {
  const g = toMain(59);
  const p = g.current;
  const pl = g.players[p];
  pl.dev.push({ res: 'f', played: false });
  const idx = pl.dev.length - 1;
  g.phase = 'trade';
  assert.throws(() => g.playCard(idx, { resources: ['f', 't'] }), (e) => e instanceof GameError && e.code === 'WRONG_PHASE');
});
