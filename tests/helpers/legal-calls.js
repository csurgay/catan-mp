// Enumerates the engine calls that are legal for the current actor as wire
// call descriptors ({ method, params }), the way a multiplayer client sends
// them. Mirrors tests/fuzz.test.js's legalActions() but returns data, not
// closures, so the same generator drives sessions over a (memory) network.
import { RESOURCES } from '../../src/engine/board.js';

export function legalCalls(game, rng) {
  const acts = [];
  const actor = game.actor();
  const pl = game.players[actor];
  const pick = (arr) => arr[rng.nextInt(arr.length)];
  const call = (method, ...params) => ({ method, params });
  switch (game.phase) {
    case 'setup': {
      if (pl.supply.settlement) { const l = game.legalSettlements(actor); if (l.length) acts.push(call('placeSettlement', pick(l))); }
      if (pl.supply.roads) { const l = game.legalRoads(actor); if (l.length) acts.push(call('placeRoad', ...pick(l))); }
      if (!acts.length) acts.push(call('endTurn'));
      break;
    }
    case 'roll': {
      acts.push(call('rollDice'));
      const k = pl.dev.findIndex((d) => d.res === 'l' && !d.played);
      if (k !== -1) acts.push(call('playCard', k));
      break;
    }
    case 'discard': {
      const e = game.discardQueue[0];
      const hand = game.players[e.player].hand.slice();
      const cards = [];
      for (let i = 0; i < e.count; i++) cards.push(hand.splice(rng.nextInt(hand.length), 1)[0]);
      acts.push(call('discard', e.player, cards));
      break;
    }
    case 'moveRobber': {
      const tiles = game.board.tiles.filter((t) => (t.type === 'N' || t.type === 'S') && t !== game.board.robberTile);
      acts.push(call('moveRobber', pick(tiles).idx));
      break;
    }
    case 'chooseVictim': acts.push(call('chooseVictim', pick(game.robberVictims))); break;
    case 'trade': {
      acts.push(call('respondTrade', null));
      game.trade.offers.forEach((o, i) => {
        const responder = game.players[game.trade.responder];
        if (responder.hand.includes(o.want)) acts.push(call('respondTrade', i));
      });
      acts.push(call('cancelTrade'));
      break;
    }
    case 'main': {
      acts.push(call('endTurn'));
      for (const kind of ['road', 'settlement', 'city', 'devcard']) if (game.canBuy(kind)) acts.push(call('buy', kind));
      for (const kind of ['road', 'settlement', 'city']) {
        const key = kind === 'road' ? 'roads' : kind;
        if (pl.supply[key] > 0) acts.push(call('refund', kind));
      }
      if (pl.supply.settlement) { const l = game.legalSettlements(actor); if (l.length) acts.push(call('placeSettlement', pick(l))); }
      if (pl.supply.roads) { const l = game.legalRoads(actor); if (l.length) acts.push(call('placeRoad', ...pick(l))); }
      if (pl.supply.city) {
        const l = game.board.junctions.filter((j) => game.canPlaceCity(actor, j.no));
        if (l.length) acts.push(call('placeCity', pick(l).no));
      }
      pl.dev.forEach((d, i) => {
        if (d.played) return;
        if (d.res === 'f') acts.push(call('playCard', i, { resources: [pick(RESOURCES), pick(RESOURCES)] }));
        else if (d.res === 'm') acts.push(call('playCard', i, { resource: pick(RESOURCES) }));
        else acts.push(call('playCard', i));
      });
      if (pl.hand.length >= 2) {
        const give4 = pl.hand.slice(0, 4).join('');
        if (give4.length === 4) acts.push(call('bankTrade', give4, pick(RESOURCES)));
        const give3 = pl.hand.slice(0, 3).join('');
        if (give3.length === 3 && game.bankTradeRatio(give3) === 3) acts.push(call('bankTrade', give3, pick(RESOURCES)));
        for (const r of RESOURCES) {
          if (pl.hand.filter((c) => c === r).length >= 2 && game.bankTradeRatio(r + r) === 2) acts.push(call('bankTrade', r + r, pick(RESOURCES.filter((x) => x !== r))));
        }
      }
      if (pl.hand.length >= 1) {
        const n = 1 + rng.nextInt(3);
        const offers = [];
        for (let i = 0; i < n; i++) {
          const give = pl.hand.slice(0, 1 + rng.nextInt(Math.min(2, pl.hand.length))).join('');
          const wants = RESOURCES.filter((r) => !give.includes(r));
          offers.push({ give, want: pick(wants) });
        }
        acts.push(call('offerTrade', offers));
      }
      break;
    }
    default: break;
  }
  return acts;
}
