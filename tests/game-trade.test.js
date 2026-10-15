import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, GameError } from '../src/engine/game.js';
import { autoSetup, giveCards } from './helpers.js';

function toMain(seed = 60, numPlayers = 4, beginner = 1) {
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

test('bankTrade: 4:1 always works', () => {
  const g = toMain(60);
  const p = g.current;
  g.players[p].hand = [];
  giveCards(g, p, 'ftbj');
  assert.equal(g.bankTradeRatio('ftbj'), 4);
  const ev = g.bankTrade('ftbj', 'k');
  assert.equal(ev.ratio, 4);
  assert.deepEqual(g.players[p].hand, ['k']);
});

test('bankTrade: 3:1 requires a "3" harbor', () => {
  const g = toMain(61);
  const p = g.current;
  g.players[p].hand = [];
  giveCards(g, p, 'fff');
  const has3 = require0(g, p, '3');
  assert.equal(g.bankTradeRatio('fff'), has3 ? 3 : 0);
  if (has3) {
    g.bankTrade('fff', 'k');
    assert.deepEqual(g.players[p].hand, ['k']);
  } else {
    assert.throws(() => g.bankTrade('fff', 'k'), (e) => e instanceof GameError && e.code === 'BAD_TRADE');
  }
});

test('bankTrade: 2:1 requires two identical cards and a matching harbor', () => {
  const g = toMain(62);
  const p = g.current;
  g.players[p].hand = [];
  giveCards(g, p, 'ff');
  const hasWoodHarbor = require0(g, p, 'f');
  assert.equal(g.bankTradeRatio('ff'), hasWoodHarbor ? 2 : 0);
  if (hasWoodHarbor) {
    g.bankTrade('ff', 't');
    assert.deepEqual(g.players[p].hand, ['t']);
  } else {
    assert.throws(() => g.bankTrade('ff', 't'), (e) => e instanceof GameError && e.code === 'BAD_TRADE');
  }
  // Different letters never qualify for 2:1, harbor or not:
  g.players[p].hand = [];
  giveCards(g, p, 'ft');
  assert.equal(g.bankTradeRatio('ft'), 0);
});

test('bankTrade: invalid combinations throw BAD_TRADE', () => {
  const g = toMain(63);
  const p = g.current;
  g.players[p].hand = [];
  giveCards(g, p, 'f');
  assert.equal(g.bankTradeRatio('f'), 0);
  assert.throws(() => g.bankTrade('f', 't'), (e) => e instanceof GameError && e.code === 'BAD_TRADE');
  giveCards(g, p, 'ff');
  // 3 cards without a 3-harbor and not otherwise valid -> also invalid unless the player has one
});

function require0(g, player, harborLetter) {
  return g.board.junctions.some((j) => j.building.type > 0 && j.building.player === player && j.harbor === harborLetter);
}

test('offerTrade validates give/want and starts the round-robin at the next player', () => {
  const g = toMain(64);
  const p = g.current;
  g.players[p].hand = [];
  giveCards(g, p, 'ff');
  assert.throws(() => g.offerTrade([]), (e) => e instanceof GameError && e.code === 'BAD_ARGUMENT');
  assert.throws(() => g.offerTrade([{ give: 'kk', want: 't' }]), (e) => e instanceof GameError && e.code === 'BAD_ARGUMENT'); // not in hand
  assert.throws(() => g.offerTrade([{ give: 'f', want: 'f' }]), (e) => e instanceof GameError && e.code === 'BAD_ARGUMENT'); // want in give
  const ev = g.offerTrade([{ give: 'f', want: 't' }]);
  assert.equal(g.phase, 'trade');
  const expectedResponder = (p % g.numPlayers) + 1;
  assert.equal(g.trade.responder, expectedResponder);
  assert.equal(g.actor(), expectedResponder);
  assert.deepEqual(ev.offers, [{ give: 'f', want: 't' }]);
});

test('respondTrade: pass sequence visits every other player and returns to the offerer, closing the trade', () => {
  const g = toMain(65);
  const p = g.current;
  giveCards(g, p, 'f');
  g.offerTrade([{ give: 'f', want: 't' }]);
  const seen = [];
  while (g.trade) {
    seen.push(g.trade.responder);
    g.respondTrade(null);
  }
  assert.equal(g.phase, 'main');
  // every other player visited exactly once, in order, then closed
  const expected = [];
  for (let i = 1; i < g.numPlayers; i++) expected.push(((p - 1 + i) % g.numPlayers) + 1);
  assert.deepEqual(seen, expected);
});

test('respondTrade: accept swaps exactly the offered cards', () => {
  const g = toMain(66);
  const p = g.current;
  const responder = (p % g.numPlayers) + 1;
  g.players[p].hand = [];
  giveCards(g, p, 'ff');
  g.players[responder].hand = [];
  giveCards(g, responder, 't');
  g.offerTrade([{ give: 'ff', want: 't' }]);
  assert.equal(g.trade.responder, responder);
  g.respondTrade(0);
  assert.deepEqual(g.players[p].hand, ['t']);
  assert.deepEqual(g.players[responder].hand, ['f', 'f']);
  assert.equal(g.trade, null);
  assert.equal(g.phase, 'main');
});

test('respondTrade: a responder without the wanted card cannot accept', () => {
  const g = toMain(67);
  const p = g.current;
  const responder = (p % g.numPlayers) + 1;
  giveCards(g, p, 'f');
  g.players[responder].hand = g.players[responder].hand.filter((c) => c !== 't');
  g.offerTrade([{ give: 'f', want: 't' }]);
  assert.throws(() => g.respondTrade(0), (e) => e instanceof GameError && e.code === 'BAD_TRADE');
});

test('respondTrade: the offerer no longer holding the give cards also fails the accept', () => {
  const g = toMain(68);
  const p = g.current;
  const responder = (p % g.numPlayers) + 1;
  g.players[p].hand = [];
  giveCards(g, p, 'f');
  giveCards(g, responder, 't');
  g.offerTrade([{ give: 'f', want: 't' }]);
  g.players[p].hand = []; // offerer spent/lost the card before the responder answers
  assert.throws(() => g.respondTrade(0), (e) => e instanceof GameError && e.code === 'BAD_TRADE');
});

test('cancelTrade: only the offerer, closes the trade immediately', () => {
  const g = toMain(69);
  const p = g.current;
  giveCards(g, p, 'f');
  g.offerTrade([{ give: 'f', want: 't' }]);
  assert.equal(g.phase, 'trade');
  g.cancelTrade();
  assert.equal(g.phase, 'main');
  assert.equal(g.trade, null);
  assert.throws(() => g.cancelTrade(), (e) => e instanceof GameError && e.code === 'WRONG_PHASE');
});

test('only one offer can be accepted per trade round (trade closes on accept)', () => {
  const g = toMain(70);
  const p = g.current;
  const responder = (p % g.numPlayers) + 1;
  g.players[p].hand = [];
  giveCards(g, p, 'ft');
  giveCards(g, responder, 'k');
  g.offerTrade([{ give: 'f', want: 'k' }, { give: 't', want: 'k' }]);
  g.respondTrade(0);
  assert.equal(g.trade, null);
  assert.equal(g.phase, 'main');
});
