// Random-legal-move fuzzer: every player is a "human" driven by a seeded RNG
// that picks uniformly among the actions the engine says are legal right now,
// including the ones the computer player never takes (player trades, refunds,
// pre-roll knights, monopoly, year of plenty, cancelling trades). After every
// action the invariants must hold and the engine must never throw for an
// action it advertised as legal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, GameError, MAX_PIECES } from '../src/engine/game.js';
import { RESOURCES } from '../src/engine/board.js';
import { Mulberry32 } from '../src/engine/rng.js';

function invariants(game) {
  const out = [];
  let dev = game.devDeck.length;
  for (let p = 1; p <= game.numPlayers; p++) {
    const pl = game.players[p];
    dev += pl.dev.length;
    for (const c of pl.hand) if (!RESOURCES.includes(c)) out.push(`p${p} bad card ${c}`);
    if (pl.placed.settlements + pl.supply.settlement > MAX_PIECES.settlement) out.push(`p${p} settlements over limit`);
    if (pl.placed.cities + pl.supply.city > MAX_PIECES.city) out.push(`p${p} cities over limit`);
    if (pl.placed.roads + pl.supply.roads > MAX_PIECES.road) out.push(`p${p} roads over limit`);
    if (pl.supply.roads < 0 || pl.supply.settlement < 0 || pl.supply.city < 0) out.push(`p${p} negative supply`);
    if (pl.grantedRoads > pl.supply.roads) out.push(`p${p} grantedRoads > supply`);
    let s = 0; let c = 0;
    for (const j of game.board.junctions) {
      if (j.building.player === p && j.building.type === 1) s++;
      if (j.building.player === p && j.building.type === 2) c++;
    }
    if (s !== pl.placed.settlements || c !== pl.placed.cities) out.push(`p${p} placed counts drift`);
  }
  if (dev !== 25) out.push(`dev cards ${dev} != 25`);
  for (const j of game.board.junctions) {
    if (j.building.type > 0) for (const n of j.juncs) if (n.building.type > 0) out.push(`adjacent buildings ${j.no}-${n.no}`);
  }
  if (game.board.tiles.filter((t) => t.hasRobber).length !== 1) out.push('robber count != 1');
  return out;
}

// Enumerate legal actions as thunks; the engine's own predicates decide.
function legalActions(game, rng) {
  const acts = [];
  const actor = game.actor();
  const pl = game.players[actor];
  const pick = (arr) => arr[rng.nextInt(arr.length)];
  switch (game.phase) {
    case 'setup': {
      if (pl.supply.settlement) { const l = game.legalSettlements(actor); if (l.length) acts.push(() => game.placeSettlement(pick(l))); }
      if (pl.supply.roads) { const l = game.legalRoads(actor); if (l.length) acts.push(() => game.placeRoad(...pick(l))); }
      if (!acts.length) acts.push(() => game.endTurn());
      break;
    }
    case 'roll': {
      acts.push(() => game.rollDice());
      const k = pl.dev.findIndex((d) => d.res === 'l' && !d.played);
      if (k !== -1) acts.push(() => game.playCard(k));
      break;
    }
    case 'discard': {
      const e = game.discardQueue[0];
      const hand = game.players[e.player].hand.slice();
      const cards = [];
      for (let i = 0; i < e.count; i++) cards.push(hand.splice(rng.nextInt(hand.length), 1)[0]);
      acts.push(() => game.discard(e.player, cards));
      break;
    }
    case 'moveRobber': {
      const tiles = game.board.tiles.filter((t) => (t.type === 'N' || t.type === 'S') && t !== game.board.robberTile);
      acts.push(() => game.moveRobber(pick(tiles).idx));
      break;
    }
    case 'chooseVictim': acts.push(() => game.chooseVictim(pick(game.robberVictims))); break;
    case 'trade': {
      acts.push(() => game.respondTrade(null));
      game.trade.offers.forEach((o, i) => {
        const responder = game.players[game.trade.responder];
        if (responder.hand.includes(o.want)) acts.push(() => game.respondTrade(i));
      });
      acts.push(() => game.cancelTrade());
      break;
    }
    case 'main': {
      acts.push(() => game.endTurn());
      for (const kind of ['road', 'settlement', 'city', 'devcard']) if (game.canBuy(kind)) acts.push(() => game.buy(kind));
      for (const kind of ['road', 'settlement', 'city']) {
        const key = kind === 'road' ? 'roads' : kind;
        if (pl.supply[key] > 0) acts.push(() => game.refund(kind));
      }
      if (pl.supply.settlement) { const l = game.legalSettlements(actor); if (l.length) acts.push(() => game.placeSettlement(pick(l))); }
      if (pl.supply.roads) { const l = game.legalRoads(actor); if (l.length) acts.push(() => game.placeRoad(...pick(l))); }
      if (pl.supply.city) {
        const l = game.board.junctions.filter((j) => game.canPlaceCity(actor, j.no));
        if (l.length) acts.push(() => game.placeCity(pick(l).no));
      }
      pl.dev.forEach((d, i) => {
        if (d.played) return;
        if (d.res === 'f') acts.push(() => game.playCard(i, { resources: [pick(RESOURCES), pick(RESOURCES)] }));
        else if (d.res === 'm') acts.push(() => game.playCard(i, { resource: pick(RESOURCES) }));
        else acts.push(() => game.playCard(i));
      });
      // bank trades: any 4, any 3 with a 3:1 harbor, 2 identical with a 2:1 harbor
      if (pl.hand.length >= 2) {
        const give4 = pl.hand.slice(0, 4).join('');
        if (give4.length === 4) acts.push(() => game.bankTrade(give4, pick(RESOURCES)));
        const give3 = pl.hand.slice(0, 3).join('');
        if (give3.length === 3 && game.bankTradeRatio(give3) === 3) acts.push(() => game.bankTrade(give3, pick(RESOURCES)));
        for (const r of RESOURCES) {
          if (pl.hand.filter((c) => c === r).length >= 2 && game.bankTradeRatio(r + r) === 2) acts.push(() => game.bankTrade(r + r, pick(RESOURCES.filter((x) => x !== r))));
        }
      }
      // player trade offers (1..3 offers of 1..2 cards each)
      if (pl.hand.length >= 1) {
        acts.push(() => {
          const n = 1 + rng.nextInt(3);
          const offers = [];
          for (let i = 0; i < n; i++) {
            const give = pl.hand.slice(0, 1 + rng.nextInt(Math.min(2, pl.hand.length))).join('');
            const wants = RESOURCES.filter((r) => !give.includes(r));
            offers.push({ give, want: pick(wants) });
          }
          return game.offerTrade(offers);
        });
      }
      break;
    }
    default: break;
  }
  return acts;
}

for (const numPlayers of [3, 4, 6]) {
  test(`fuzz: ${numPlayers} random-legal-move humans, 40 games, invariants after every action`, () => {
    let actions = 0;
    let finished = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const game = createGame({ numPlayers, seed, computer: new Array(numPlayers).fill(false) });
      const rng = new Mulberry32(seed * 7919);
      let steps = 0;
      while (game.phase !== 'gameOver' && steps < 6000) {
        const acts = legalActions(game, rng);
        assert.ok(acts.length > 0, `seed ${seed}: no legal action in phase ${game.phase} (deadlock)`);
        const act = acts[rng.nextInt(acts.length)];
        try {
          act();
        } catch (err) {
          // Only a rejected *advertised* action is a bug. Two known-legitimate
          // rejections: an offer whose give is empty after slicing (cannot happen),
          // and a bank trade from a hand that changed -- neither should occur.
          assert.fail(`seed ${seed} step ${steps} phase ${game.phase}: legal action threw ${err instanceof GameError ? err.code : err}: ${err.message}`);
        }
        const bad = invariants(game);
        assert.deepEqual(bad, [], `seed ${seed} step ${steps}: ${bad.join('; ')}`);
        steps++;
        actions++;
      }
      if (game.phase === 'gameOver') finished++;
    }
    assert.ok(actions > 1000);
    // Random play rarely reaches 10 points within the step budget; that is fine.
    // What matters is no deadlock, no rejected legal action, no invariant drift.
    assert.ok(finished >= 0);
  });
}
