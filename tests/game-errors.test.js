import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, GameError } from '../src/engine/game.js';
import { autoSetup, giveCards, cloneRng } from './helpers.js';

test('determinism: same seed + same scripted actions -> identical toJSON and log', () => {
  const script = (seed) => {
    const g = createGame({ numPlayers: 4, beginner: 2, seed });
    autoSetup(g);
    for (let i = 0; i < 6; i++) {
      if (g.phase === 'roll') g.rollDice();
      if (g.phase === 'discard') {
        const e = g.discardQueue[0];
        g.discard(e.player, g.players[e.player].hand.slice(0, e.count));
      }
      if (g.phase === 'moveRobber') g.moveRobber(g.board.landTiles.find((t) => !t.hasRobber).idx);
      if (g.phase === 'chooseVictim') g.chooseVictim(g.robberVictims[0]);
      if (g.phase === 'main') {
        if (g.players[g.current].supply.settlement === 0) {
          giveCards(g, g.current, 'ftbj');
          g.buy('settlement');
        }
        const j = g.legalSettlements(g.current).find((no) => g.canPlaceSettlement(g.current, no));
        if (j !== undefined && g.players[g.current].supply.settlement > 0) {
          try { g.placeSettlement(j); } catch { /* geometry may not allow it this turn */ }
        }
        g.endTurn();
      }
    }
    return g;
  };
  const a = script(777);
  const b = script(777);
  assert.deepEqual(a.toJSON(), b.toJSON());
  assert.deepEqual(a.log, b.log);

  const c = script(778);
  assert.notDeepEqual(a.toJSON(), c.toJSON());
});

function toMain(seed = 90, numPlayers = 4, beginner = 1) {
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

function isGameError(code) {
  return (e) => e instanceof GameError && e.code === code;
}

test('createGame validates numPlayers and beginner', () => {
  assert.throws(() => createGame({ numPlayers: 2 }), isGameError('BAD_ARGUMENT'));
  assert.throws(() => createGame({ numPlayers: 7 }), isGameError('BAD_ARGUMENT'));
  assert.throws(() => createGame({ numPlayers: 4, beginner: 0 }), isGameError('BAD_ARGUMENT'));
  assert.throws(() => createGame({ numPlayers: 4, beginner: 5 }), isGameError('BAD_ARGUMENT'));
});

test('every action rejects the wrong phase with the right code', () => {
  const setupGame = createGame({ numPlayers: 4, beginner: 1, seed: 91 });
  assert.throws(() => setupGame.rollDice(), isGameError('WRONG_PHASE'));
  assert.throws(() => setupGame.placeCity(0), isGameError('WRONG_PHASE'));
  assert.throws(() => setupGame.discard(1, []), isGameError('WRONG_PHASE'));
  assert.throws(() => setupGame.moveRobber(0), isGameError('WRONG_PHASE'));
  assert.throws(() => setupGame.chooseVictim(1), isGameError('WRONG_PHASE'));
  assert.throws(() => setupGame.bankTrade('ftbj', 'k'), isGameError('WRONG_PHASE'));
  assert.throws(() => setupGame.offerTrade([{ give: 'f', want: 't' }]), isGameError('WRONG_PHASE'));
  assert.throws(() => setupGame.respondTrade(null), isGameError('WRONG_PHASE'));
  assert.throws(() => setupGame.cancelTrade(), isGameError('WRONG_PHASE'));
  assert.throws(() => setupGame.buy('road'), isGameError('WRONG_PHASE'));

  const g = toMain(92);
  assert.throws(() => g.rollDice(), isGameError('WRONG_PHASE'));
  assert.throws(() => g.discard(g.current, []), isGameError('WRONG_PHASE'));
  assert.throws(() => g.moveRobber(0), isGameError('WRONG_PHASE'));
  assert.throws(() => g.chooseVictim(g.current), isGameError('WRONG_PHASE'));
  assert.throws(() => g.respondTrade(null), isGameError('WRONG_PHASE'));
  assert.throws(() => g.cancelTrade(), isGameError('WRONG_PHASE'));
});

test('discard: NOT_YOUR_TURN for the wrong player', () => {
  let seed = 200;
  let g;
  for (;;) {
    g = createGame({ numPlayers: 4, beginner: 1, seed });
    autoSetup(g);
    g.players[1].hand = [];
    giveCards(g, 1, 'fffffttt');
    const peek = cloneRng(g.rng);
    if (peek.nextInt(6) + 1 + peek.nextInt(6) + 1 === 7) break;
    seed++;
  }
  g.rollDice();
  assert.equal(g.phase, 'discard');
  assert.throws(() => g.discard(2, []), isGameError('NOT_YOUR_TURN'));
});

test('placeSettlement/placeCity/placeRoad/buy/refund: NO_SUPPLY without a bought/granted piece', () => {
  const g = toMain(93);
  const p = g.current;
  g.players[p].supply = { settlement: 0, city: 0, roads: 0 };
  assert.throws(() => g.placeSettlement(g.legalSettlements(p)[0]), isGameError('NO_SUPPLY'));
  assert.throws(() => g.placeCity(g.board.junctions.find((j) => j.building.player === p).no), isGameError('NO_SUPPLY'));
  assert.throws(() => g.placeRoad(...g.legalRoads(p)[0]), isGameError('NO_SUPPLY'));
  assert.throws(() => g.refund('road'), isGameError('NO_SUPPLY'));
  assert.throws(() => g.refund('settlement'), isGameError('NO_SUPPLY'));
  assert.throws(() => g.refund('city'), isGameError('NO_SUPPLY'));
});

test('placeSettlement: ILLEGAL_PLACEMENT for an occupied junction or a broken distance rule', () => {
  const g = toMain(94);
  const p = g.current;
  const occupied = g.board.junctions.find((j) => j.building.type > 0);
  giveCards(g, p, 'ftbj');
  g.buy('settlement');
  assert.throws(() => g.placeSettlement(occupied.no), isGameError('ILLEGAL_PLACEMENT'));
  const neighbour = occupied.juncs[0];
  assert.throws(() => g.placeSettlement(neighbour.no), isGameError('ILLEGAL_PLACEMENT'));
});

test('placeCity: ILLEGAL_PLACEMENT on an empty or opponent junction', () => {
  const g = toMain(95);
  const p = g.current;
  const other = (p % g.numPlayers) + 1;
  giveCards(g, p, 'bbkkk');
  g.buy('city');
  const empty = g.board.junctions.find((j) => j.building.type === 0);
  assert.throws(() => g.placeCity(empty.no), isGameError('ILLEGAL_PLACEMENT'));
  const otherJunc = g.board.junctions.find((j) => j.building.type === 1 && j.building.player === other);
  if (otherJunc) assert.throws(() => g.placeCity(otherJunc.no), isGameError('ILLEGAL_PLACEMENT'));
});

test('buy: BAD_ARGUMENT for an unknown kind', () => {
  const g = toMain(96);
  assert.throws(() => g.buy('castle'), isGameError('BAD_ARGUMENT'));
});

test('playCard: BAD_ARGUMENT for a missing/invalid index or a card already played', () => {
  const g = toMain(97);
  const p = g.current;
  assert.throws(() => g.playCard(0), isGameError('BAD_ARGUMENT'));
  g.players[p].dev.push({ res: 'k', played: false });
  const idx = g.players[p].dev.length - 1;
  g.playCard(idx);
  assert.throws(() => g.playCard(idx), isGameError('BAD_ARGUMENT'));
});

test('offerTrade: BAD_ARGUMENT for a bad shape, respondTrade: BAD_ARGUMENT for a bad offer index', () => {
  const g = toMain(98);
  const p = g.current;
  giveCards(g, p, 'f');
  assert.throws(() => g.offerTrade('nope'), isGameError('BAD_ARGUMENT'));
  assert.throws(() => g.offerTrade([{ give: 'f', want: 'z' }]), isGameError('BAD_ARGUMENT'));
  g.offerTrade([{ give: 'f', want: 't' }]);
  assert.throws(() => g.respondTrade(5), isGameError('BAD_ARGUMENT'));
});

test('endTurn: SETUP_INCOMPLETE while pieces remain, WRONG_PHASE outside setup/main', () => {
  const g = createGame({ numPlayers: 4, beginner: 1, seed: 99 });
  assert.throws(() => g.endTurn(), isGameError('SETUP_INCOMPLETE'));
  const gm = toMain(100);
  gm.phase = 'trade';
  assert.throws(() => gm.endTurn(), isGameError('WRONG_PHASE'));
});


test('seed sanitising: fractions truncate, non-finite values do not throw', () => {
  assert.equal(createGame({ numPlayers: 3, seed: 1.5 }).seed, 1);
  assert.equal(createGame({ numPlayers: 3, seed: '42' }).seed, 42);
  for (const bad of [NaN, Infinity, -Infinity, 'abc']) {
    const g = createGame({ numPlayers: 3, seed: bad });
    assert.ok(Number.isFinite(g.seed), `seed ${bad} should fall back to a finite seed`);
  }
  // identical integer seeds still replay identically
  assert.deepEqual(createGame({ numPlayers: 3, seed: 7.9 }).toJSON().board, createGame({ numPlayers: 3, seed: 7 }).toJSON().board);
});
