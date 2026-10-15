// Computer player. Faithful port of AI.java, CompTurn.java, CompAction.java
// and Csere.java (P. Csurgay, 2004). See docs/ARCHITECTURE.md ("ai.js —
// computer player") for the binding contract this file implements.
//
// The original is a Swing timer state machine (turnCounter 1..14) that
// clicks mouse/keyboard events on live components, spread over many timer
// ticks. This port is a *driver*: `step(game)` performs exactly ONE engine
// action per call and returns. Per-turn scratch state (which Java kept in
// CompAction fields) lives on the `ai` object, keyed by (turnNumber, current)
// and reset whenever either changes.
//
// Randomness: only `game.rng.nextInt(n)`, never Math.random.

import {
  hasHarbor, playerProduction, hasAdjacentBuilding, hasOwnRoad, setRoad,
  longestRoadOf, RESOURCES, NUMBER_VALUE,
} from './board.js';
import { MAX_PIECES } from './game.js';

// ---------------------------------------------------------------------------
// AI.getJuncValueSum: value of a junction to `player` -- production weight of
// its three tiles (boosted if the player is weak/has a harbor in that
// resource) plus a harbor bonus. Ported literally, including the original's
// unreachable else-if branches (thresholds 6/10/14 can never fire because the
// first branch, >3, already catches every case where they would).
export function junctionValue(game, player, junc) {
  const j = typeof junc === 'number' ? game.board.junctions[junc] : junc;
  return juncValueSum(game, player, j);
}

function juncValueSum(game, player, j) {
  const board = game.board;
  let sum = 0;
  for (const tile of j.tiles) {
    let szorzo = 1;
    if (playerProduction(board, player, tile.resource) < 3) szorzo += 6;
    if (hasHarbor(board, player, tile.resource)) szorzo += 4;
    sum += szorzo * NUMBER_VALUE[tile.number];
  }
  if (j.harbor === '3') {
    if (!hasHarbor(board, player, '3')) sum += 3;
  } else if (j.harbor !== ' ') {
    const p = playerProduction(board, player, j.harbor);
    // Faithful to AI.java: chained else-if with increasing thresholds means
    // only the first (>3) branch is ever reachable.
    if (p > 3) sum += 2;
    else if (p > 6) sum += 3;
    else if (p > 10) sum += 6;
    else if (p > 14) sum += 12;
  }
  return sum;
}

// AI.getAvailableHazak + AI.getBestHaz: best empty, non-adjacent junction;
// during setup (pFirstTwoRounds) no own road is required to reach it.
export function bestSettlement(game, player, setup = false) {
  const board = game.board;
  let max = 0;
  let best = null;
  for (const junc of board.junctions) {
    if (junc.building.type > 0) continue;
    if (hasAdjacentBuilding(junc)) continue;
    if (!setup && !hasOwnRoad(junc, player)) continue;
    const sum = juncValueSum(game, player, junc);
    if (sum > max) { max = sum; best = junc; }
  }
  return best ? best.no : null;
}

// AI.getBestVaros: own settlement with the highest junction value.
export function bestCity(game, player) {
  const board = game.board;
  let max = 0;
  let best = null;
  for (const junc of board.junctions) {
    if (junc.building.type === 1 && junc.building.player === player) {
      const sum = juncValueSum(game, player, junc);
      if (sum > max) { max = sum; best = junc; }
    }
  }
  return best ? best.no : null;
}

// AI.getTileForRablo: the land tile (never the player's own, never the
// current robber tile) with the highest sum of NUMBER_VALUE * building.type
// over its junctions.
export function bestRobberTile(game, player) {
  const board = game.board;
  let max = 0;
  let best = board.landTiles.length ? board.landTiles[0] : null;
  for (const tile of board.landTiles) {
    let sum = 0;
    let own = false;
    for (const junc of tile.juncs) {
      sum += NUMBER_VALUE[tile.number] * junc.building.type;
      if (junc.building.type > 0 && junc.building.player === player) own = true;
    }
    if (sum > max && !own && tile !== board.robberTile) { max = sum; best = tile; }
  }
  return best ? best.idx : null;
}

// AI.rabloHurts: true if the robber currently sits on a land tile with an
// own building (deserts never "hurt").
export function robberHurts(game, player) {
  const tile = game.board.robberTile;
  if (!tile || tile.type === 'S') return false;
  return tile.juncs.some((j) => j.building.type > 0 && j.building.player === player);
}

// ---------------------------------------------------------------------------
// Road-candidate generators. A junction is "connected" for `player` if it has
// an own road ending there or an own building on it (Junction.vanideut ||
// own haz) -- ports the repeated inline check in AI.java.
function connected(junc, player) {
  return hasOwnRoad(junc, player) || (junc.building.type > 0 && junc.building.player === player);
}

function buildingOk(junc, player) {
  return junc.building.type === 0 || junc.building.player === player;
}

// AI.getOneRoads: every single-road extension of the network (target
// unrestricted -- used only for longest-road maximisation).
function oneHopRoads(board, player) {
  const out = [];
  for (const junc of board.junctions) {
    let anchor = null;
    for (let i = 0; i < junc.juncs.length; i++) {
      const nb = junc.juncs[i];
      if (connected(nb, player) && junc.roads[i] === 0 && buildingOk(nb, player)) anchor = nb;
    }
    if (anchor) out.push({ target: junc, edge: [junc, anchor] });
  }
  return out;
}

// AI.getTwoRoads: every two-road extension (target unrestricted).
function twoHopRoads(board, player) {
  const out = [];
  for (const junc of board.junctions) {
    let mid = null;
    let anchor = null;
    for (let i = 0; i < junc.juncs.length; i++) {
      const nb1 = junc.juncs[i];
      for (let j = 0; j < nb1.juncs.length; j++) {
        const nb2 = nb1.juncs[j];
        if (junc === nb2) continue;
        if (!connected(nb2, player)) continue;
        if (junc.roads[i] !== 0 || nb1.roads[j] !== 0) continue;
        if (!buildingOk(nb1, player) || !buildingOk(nb2, player)) continue;
        mid = nb1; anchor = nb2;
      }
    }
    if (mid) out.push({ target: junc, mid, anchor });
  }
  return out;
}

// AI.getAvailableOneRoads: one-road reach to an empty, non-adjacent junction.
function oneHopSettlementRoads(board, player) {
  const out = [];
  for (const junc of board.junctions) {
    if (junc.building.type > 0) continue;
    if (hasAdjacentBuilding(junc)) continue;
    if (hasOwnRoad(junc, player)) continue;
    let anchor = null;
    for (let i = 0; i < junc.juncs.length; i++) {
      const nb = junc.juncs[i];
      if (connected(nb, player) && junc.roads[i] === 0 && buildingOk(nb, player)) anchor = nb;
    }
    if (anchor) out.push({ target: junc, edge: [junc, anchor] });
  }
  return out;
}

// AI.getAvailableTwoRoads: two-road reach; when firstTwoHaz is given (setup /
// road-building continuation) the network anchor must be that junction.
function twoHopSettlementRoads(board, player, firstTwoHaz) {
  const out = [];
  for (const junc of board.junctions) {
    if (junc.building.type > 0) continue;
    if (hasAdjacentBuilding(junc)) continue;
    if (hasOwnRoad(junc, player)) continue;
    let mid = null;
    let anchor = null;
    for (let i = 0; i < junc.juncs.length; i++) {
      const nb1 = junc.juncs[i];
      for (let j = 0; j < nb1.juncs.length; j++) {
        const nb2 = nb1.juncs[j];
        if (!connected(nb2, player)) continue;
        if (junc.roads[i] !== 0 || nb1.roads[j] !== 0) continue;
        if (hasOwnRoad(nb1, player)) continue;
        if (!buildingOk(nb1, player) || !buildingOk(nb2, player)) continue;
        mid = nb1; anchor = nb2;
      }
    }
    if (!mid) continue;
    if (firstTwoHaz && anchor !== firstTwoHaz) continue;
    out.push({ target: junc, mid, anchor, edge: [mid, anchor] });
  }
  return out;
}

// AI.getAvailableThreeRoads: three-road reach; the immediate (one-hop)
// neighbour is not stored in the result, matching the original -- only the
// edge nearest the existing network (mid-anchor) is ever placed.
function threeHopSettlementRoads(board, player, firstTwoHaz) {
  const out = [];
  for (const junc of board.junctions) {
    if (junc.building.type > 0) continue;
    if (hasAdjacentBuilding(junc)) continue;
    if (hasOwnRoad(junc, player)) continue;
    let mid = null;
    let anchor = null;
    for (let i = 0; i < junc.juncs.length; i++) {
      const nb1 = junc.juncs[i];
      for (let j = 0; j < nb1.juncs.length; j++) {
        const nb2 = nb1.juncs[j];
        for (let k = 0; k < nb2.juncs.length; k++) {
          const nb3 = nb2.juncs[k];
          if (!connected(nb3, player)) continue;
          if (junc === nb2 || nb1 === nb3) continue;
          if (junc.roads[i] !== 0 || nb1.roads[j] !== 0 || nb2.roads[k] !== 0) continue;
          if (hasOwnRoad(nb1, player)) continue;
          if (!buildingOk(nb1, player) || !buildingOk(nb2, player) || !buildingOk(nb3, player)) continue;
          mid = nb2; anchor = nb3;
        }
      }
    }
    if (!mid) continue;
    if (firstTwoHaz && anchor !== firstTwoHaz) continue;
    out.push({ target: junc, mid, anchor, edge: [mid, anchor] });
  }
  return out;
}

// AI.getBestRoad: best next edge toward a valuable settlement spot, 1/2/3
// roads away; a 2- or 3-road plan only wins if it beats the shorter plan's
// value by more than 2 (matches the original's "+2" preference for staying
// close). Returns [aNo, bNo] or null. `setupJunc` is a junction id (the
// settlement just placed in setup / by a road-building card) or null/undefined.
export function bestRoad(game, player, setupJunc) {
  const board = game.board;
  const firstTwoHaz = (setupJunc !== undefined && setupJunc !== null) ? board.junctions[setupJunc] : null;
  const pl = game.players[player];
  const placedRoads = pl.placed.roads;

  let result1 = null; let max1 = 0;
  if (!firstTwoHaz && placedRoads + 1 <= MAX_PIECES.road) {
    for (const c of oneHopSettlementRoads(board, player)) {
      const sum = juncValueSum(game, player, c.target);
      if (sum > max1) { max1 = sum; result1 = c; }
    }
  }
  let result2 = null; let max2 = 0;
  if (placedRoads + 2 <= MAX_PIECES.road) {
    for (const c of twoHopSettlementRoads(board, player, firstTwoHaz)) {
      const sum = juncValueSum(game, player, c.target);
      if (sum > max2) { max2 = sum; result2 = c; }
    }
  }
  let result3 = null; let max3 = 0;
  if (placedRoads + 3 <= MAX_PIECES.road) {
    for (const c of threeHopSettlementRoads(board, player, firstTwoHaz)) {
      const sum = juncValueSum(game, player, c.target);
      if (sum > max3) { max3 = sum; result3 = c; }
    }
  }
  let result = result1; let max = max1;
  if (!result || max2 > max + 2) { result = result2; max = max2; }
  if (!result || max3 > max + 2) { result = result3; max = max3; }
  if (!result) return null;
  return [result.edge[0].no, result.edge[1].no];
}

// AI.getLongestRoad: the single edge (added alone, or as the network-nearest
// half of a two-road extension) that maximises the resulting longest road.
// Used as the step-6 fallback when getBestRoad finds nothing useful.
export function longestRoadMove(game, player) {
  const board = game.board;
  let best = null;
  let max = 0;
  for (const c of oneHopRoads(board, player)) {
    const [a, b] = c.edge;
    setRoad(a, b, player);
    const len = longestRoadOf(board, player);
    setRoad(a, b, 0);
    if (len > max) { max = len; best = [a.no, b.no]; }
  }
  for (const c of twoHopRoads(board, player)) {
    setRoad(c.target, c.mid, player);
    setRoad(c.mid, c.anchor, player);
    const len = longestRoadOf(board, player);
    setRoad(c.target, c.mid, 0);
    setRoad(c.mid, c.anchor, 0);
    if (len > max) { max = len; best = [c.mid.no, c.anchor.no]; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Small pure helpers shared by the turn-decision table and the trade logic.

function findUnplayedDev(dev, res) {
  for (let i = 0; i < dev.length; i++) if (dev[i].res === res && !dev[i].played) return i;
  return -1;
}

function countUnplayedDev(dev, res) {
  let n = 0;
  for (const c of dev) if (c.res === res && !c.played) n++;
  return n;
}

// Player.deck.isMegvanBenne: does `hand` contain every letter of `letters`
// (as a sub-multiset)?
function hasSubset(hand, letters) {
  const copy = hand.slice();
  for (const c of letters) {
    const idx = copy.indexOf(c);
    if (idx === -1) return false;
    copy.splice(idx, 1);
  }
  return true;
}

// Csere.maradek: `hand` minus one occurrence of each letter in `reserved`
// (the cards already earmarked for the current build goal).
function maradek(hand, reserved) {
  const copy = hand.slice();
  for (const c of reserved) {
    const idx = copy.indexOf(c);
    if (idx !== -1) copy.splice(idx, 1);
  }
  return copy;
}

// Csere.getCsereCards: prefer a 2:1 harbor pair (f,t,b,j,k order, but each
// match OVERWRITES the previous -- faithfully kept, so k beats j beats b
// beats t beats f when several apply); else a flat 3:1 (with a '3' harbor) or
// 4:1 trade of the first 3/4 available cards; else null (can't afford any).
function csereCards(game, player, cards) {
  const board = game.board;
  const db = hasHarbor(board, player, '3') ? 3 : 4;
  let res = null;
  for (const r of RESOURCES) {
    let count = 0;
    for (const c of cards) if (c === r) count++;
    if (hasHarbor(board, player, r) && count >= 2) res = r + r;
  }
  if (res === null && cards.length >= db) res = cards.slice(0, db).join('');
  return res;
}

function action(describe, act) { return { describe, act }; }

// "Obtain missing cards" (lapKellAction -> felfedezesMonopolAction /
// becserelAction): play an unplayed year-of-plenty or monopoly card if held;
// otherwise bank-trade for the single most urgently missing resource
// (targets[0]), using cards outside `reserved`. A second missing resource
// (targets[1], year-of-plenty only) is granted in the same playCard call;
// for a bank trade it is deliberately left for a later pass (see report: the
// original's tick-based double-trade of the same reserve is not reproduced).
function tryObtain(game, player, reserved, targets) {
  const pl = game.players[player];
  const fIdx = findUnplayedDev(pl.dev, 'f');
  if (fIdx !== -1) {
    const resources = targets.length === 1 ? [targets[0], targets[0]] : [targets[0], targets[1]];
    return action({ type: 'playCard', card: 'f', resources }, () => game.playCard(fIdx, { resources }));
  }
  const mIdx = findUnplayedDev(pl.dev, 'm');
  if (mIdx !== -1) {
    const resource = targets[0];
    return action({ type: 'playCard', card: 'm', resource }, () => game.playCard(mIdx, { resource }));
  }
  const available = maradek(pl.hand, reserved);
  const give = csereCards(game, player, available);
  if (!give) return null;
  const want = targets[0];
  return action({ type: 'bankTrade', give, want }, () => game.bankTrade(give, want));
}

// ---------------------------------------------------------------------------
// Csere.csereDecideAction: evaluate every offer of the active trade from the
// responder's point of view. diff = sum over give letters of (36/production,
// or 100 if production is 0) minus the same for the wanted letter; accept the
// best offer if diff > 5 and the responder still holds the wanted card.
export function tradeResponse(game) {
  const trade = game.trade;
  if (!trade) return null;
  const responder = trade.responder;
  let diffMax = 0;
  let offer = -1;
  trade.offers.forEach((o, i) => {
    let diff = 0;
    for (const c of o.give) {
      const v = playerProduction(game.board, responder, c);
      diff += v === 0 ? 100 : 36 / v;
    }
    const vw = playerProduction(game.board, responder, o.want);
    diff -= vw === 0 ? 100 : 36 / vw;
    if (diff > diffMax) { diffMax = diff; offer = i; }
  });
  if (diffMax > 5 && offer !== -1) {
    const chosen = trade.offers[offer];
    if (hasSubset(game.players[responder].hand, chosen.want)) return offer;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CompTurn.turnAction, steps 3..13 (steps 1/2/14 are handled by the phase
// dispatcher below: 1=roll, 2=robber-after-seven, 14=loop-or-endTurn).
// Each entry returns null ("nothing to do here, try the next step") or an
// action() descriptor+executor built with the *current* game state -- safe
// to compute speculatively for plan() since nothing is mutated until act().

const VP_PRIORITY = ['p', 'o', 'e', 'k', 't']; // AI.searchSiegpunktCard order

const PAIR_RULES_10 = [ // CompTurn turnCounter==10 (settlement "ftbj")
  ['ftb', ['j']], ['ftj', ['b']], ['fbj', ['t']], ['tbj', ['f']],
  ['ft', ['b', 'j']], ['fb', ['t', 'j']], ['fj', ['t', 'b']],
  ['tb', ['f', 'j']], ['tj', ['f', 'b']], ['bj', ['f', 't']],
];

const PAIR_RULES_11 = [ // CompTurn turnCounter==11 (city "bbkkk")
  ['bbkk', ['k']], ['bkkk', ['b']], ['kkk', ['b', 'b']], ['bkk', ['b', 'k']], ['bbk', ['k', 'k']],
];

function makeCtx(game, player) {
  let haz; let hazSet = false;
  let cty; let ctySet = false;
  let rd; let rdSet = false;
  let lrm; let lrmSet = false;
  return {
    get bestHaz() { if (!hazSet) { haz = bestSettlement(game, player, false); hazSet = true; } return haz; },
    get bestCty() { if (!ctySet) { cty = bestCity(game, player); ctySet = true; } return cty; },
    get bestRd() { if (!rdSet) { rd = bestRoad(game, player, null); rdSet = true; } return rd; },
    get longestMove() { if (!lrmSet) { lrm = longestRoadMove(game, player); lrmSet = true; } return lrm; },
  };
}

const STEPS = {
  // 3: play a knight if one is unplayed and (the robber currently hurts us,
  // or we hold a second unplayed one to spare -- AI.rabloHurts / masikKnight).
  3(game, player, pl) {
    const idx = findUnplayedDev(pl.dev, 'l');
    if (idx === -1) return null;
    const count = countUnplayedDev(pl.dev, 'l');
    if (!(robberHurts(game, player) || count >= 2)) return null;
    return action({ type: 'playCard', card: 'l' }, () => game.playCard(idx));
  },
  // 4: play any held victory-point card immediately.
  4(game, player, pl) {
    for (const res of VP_PRIORITY) {
      const idx = findUnplayedDev(pl.dev, res);
      if (idx !== -1) return action({ type: 'playCard', card: res }, () => game.playCard(idx));
    }
    return null;
  },
  // 5: play a road-building card when there is no settlement to build (or no
  // settlements left), no road already waiting in supply, roads remain, and
  // some road placement is possible at all.
  5(game, player, pl, ctx) {
    const uIdx = findUnplayedDev(pl.dev, 'u');
    if (uIdx === -1) return null;
    const noSpot = ctx.bestHaz === null;
    const capped = pl.placed.settlements >= MAX_PIECES.settlement;
    if (!(noSpot || capped)) return null;
    if (pl.supply.roads !== 0) return null;
    if (pl.placed.roads >= MAX_PIECES.road) return null;
    if (ctx.longestMove === null) return null;
    return action({ type: 'playCard', card: 'u' }, () => game.playCard(uIdx));
  },
  // 6: place a road waiting in supply -- toward the best expansion spot, else
  // whatever maximises longest road.
  6(game, player, pl, ctx) {
    if (pl.supply.roads <= 0) return null;
    if (ctx.longestMove === null) return null;
    const road = ctx.bestRd || ctx.longestMove;
    return action({ type: 'placeRoad', edge: road }, () => game.placeRoad(road[0], road[1]));
  },
  // 7: place a settlement waiting in supply.
  7(game, player, pl, ctx) {
    if (pl.supply.settlement > 0 && ctx.bestHaz !== null) {
      const junc = ctx.bestHaz;
      return action({ type: 'placeSettlement', junc }, () => game.placeSettlement(junc));
    }
    return null;
  },
  // 8: place a city waiting in supply.
  8(game, player, pl, ctx) {
    if (pl.supply.city > 0 && ctx.bestCty !== null) {
      const junc = ctx.bestCty;
      return action({ type: 'placeCity', junc }, () => game.placeCity(junc));
    }
    return null;
  },
  // 9: buy a road (or work toward "ft") when we need one to reach a
  // settlement spot, or when city-building is not currently viable either.
  9(game, player, pl, ctx) {
    if (pl.supply.roads !== 0) return null;
    if (pl.placed.roads >= MAX_PIECES.road) return null;
    const bestHaz = ctx.bestHaz; const bestRd = ctx.bestRd; const bestCty = ctx.bestCty;
    const c1 = bestHaz === null && bestRd !== null && pl.placed.settlements < MAX_PIECES.settlement;
    const c2 = (pl.placed.settlements >= MAX_PIECES.settlement || bestRd === null) && bestCty === null;
    const c3 = pl.placed.cities >= MAX_PIECES.city;
    if (!(c1 || c2 || c3)) return null;
    if (hasSubset(pl.hand, 'ft')) return action({ type: 'buy', kind: 'road' }, () => game.buy('road'));
    const noPointSavingForCity = bestCty === null || pl.placed.cities >= MAX_PIECES.city
      || (!hasSubset(pl.hand, 'bkkk') && !hasSubset(pl.hand, 'bbkk'));
    if (!noPointSavingForCity) return null;
    let reserved; let targets;
    if (hasSubset(pl.hand, 'f')) { reserved = 'f'; targets = ['t']; }
    else if (hasSubset(pl.hand, 't')) { reserved = 't'; targets = ['f']; }
    else { reserved = ''; targets = ['f', 't']; }
    return tryObtain(game, player, reserved, targets);
  },
  // 10: buy a settlement (or work toward "ftbj") when a good spot exists.
  10(game, player, pl, ctx) {
    const bestHaz = ctx.bestHaz;
    if (bestHaz === null) return null;
    if (pl.supply.settlement !== 0) return null;
    if (pl.placed.settlements >= MAX_PIECES.settlement) return null;
    if (hasSubset(pl.hand, 'ftbj')) return action({ type: 'buy', kind: 'settlement' }, () => game.buy('settlement'));
    const bestCty = ctx.bestCty;
    const noPointSavingForCity = bestCty === null || pl.placed.cities >= MAX_PIECES.city
      || (!hasSubset(pl.hand, 'bkkk') && !hasSubset(pl.hand, 'bbkk'));
    if (!noPointSavingForCity) return null;
    for (const [subset, targets] of PAIR_RULES_10) {
      if (hasSubset(pl.hand, subset)) return tryObtain(game, player, subset, targets);
    }
    return null;
  },
  // 11: buy a city (or work toward "bbkkk") when an upgrade exists.
  11(game, player, pl, ctx) {
    const bestCty = ctx.bestCty;
    if (bestCty === null) return null;
    if (pl.supply.city !== 0) return null;
    if (pl.placed.cities >= MAX_PIECES.city) return null;
    if (hasSubset(pl.hand, 'bbkkk')) return action({ type: 'buy', kind: 'city' }, () => game.buy('city'));
    for (const [subset, targets] of PAIR_RULES_11) {
      if (hasSubset(pl.hand, subset)) return tryObtain(game, player, subset, targets);
    }
    return null;
  },
  // 12: buy a development card (or work toward "bjk") when neither a city
  // nor a settlement is imminently affordable.
  12(game, player, pl, ctx) {
    if (game.devDeck.length <= 0) return null;
    const bestHaz = ctx.bestHaz; const bestCty = ctx.bestCty;
    const noCityNeed = bestCty === null || pl.placed.cities >= MAX_PIECES.city
      || (!hasSubset(pl.hand, 'bkkk') && !hasSubset(pl.hand, 'bbkk'));
    const noSettleNeed = bestHaz === null || pl.placed.settlements >= MAX_PIECES.settlement
      || (!hasSubset(pl.hand, 'ftb') && !hasSubset(pl.hand, 'ftj') && !hasSubset(pl.hand, 'fbj') && !hasSubset(pl.hand, 'tbj'));
    if (!(noCityNeed && noSettleNeed)) return null;
    if (hasSubset(pl.hand, 'bjk')) return action({ type: 'buy', kind: 'devcard' }, () => game.buy('devcard'));
    const noCityNeed2 = bestCty === null || pl.placed.cities >= MAX_PIECES.city
      || (!hasSubset(pl.hand, 'kkk') && !hasSubset(pl.hand, 'bkk') && !hasSubset(pl.hand, 'bbk'));
    const noSettleNeed2 = bestHaz === null || pl.placed.settlements >= MAX_PIECES.settlement
      || (!hasSubset(pl.hand, 'ft') && !hasSubset(pl.hand, 'fb') && !hasSubset(pl.hand, 'fj')
        && !hasSubset(pl.hand, 'tb') && !hasSubset(pl.hand, 'tj') && !hasSubset(pl.hand, 'bj'));
    if (!(noCityNeed2 && noSettleNeed2)) return null;
    if (hasSubset(pl.hand, 'bj')) return tryObtain(game, player, 'bj', ['k']);
    if (hasSubset(pl.hand, 'bk')) return tryObtain(game, player, 'bk', ['j']);
    if (hasSubset(pl.hand, 'jk')) return tryObtain(game, player, 'jk', ['b']);
    return null;
  },
  // 13: with more than 8 cards and nothing better to do, trade surplus for
  // whichever resource is entirely missing (b, then a second k, then f/t/j).
  13(game, player, pl, ctx) {
    if (pl.hand.length <= 8) return null;
    const noDevPoint = game.devDeck.length === 0
      || (!hasSubset(pl.hand, 'bj') && !hasSubset(pl.hand, 'bk') && !hasSubset(pl.hand, 'jk'));
    if (!noDevPoint) return null;
    const bestHaz = ctx.bestHaz; const bestCty = ctx.bestCty;
    const noCityNeed = bestCty === null || pl.placed.cities >= MAX_PIECES.city
      || (!hasSubset(pl.hand, 'bkkk') && !hasSubset(pl.hand, 'bbkk'));
    const noSettleNeed = bestHaz === null || pl.placed.settlements >= MAX_PIECES.settlement
      || (!hasSubset(pl.hand, 'ftb') && !hasSubset(pl.hand, 'ftj') && !hasSubset(pl.hand, 'fbj') && !hasSubset(pl.hand, 'tbj'));
    if (!(noCityNeed && noSettleNeed)) return null;
    if (!hasSubset(pl.hand, 'b')) return tryObtain(game, player, '', ['b']);
    if (!hasSubset(pl.hand, 'kk')) {
      if (hasSubset(pl.hand, 'k')) return tryObtain(game, player, 'k', ['k']);
      return tryObtain(game, player, '', ['k']);
    }
    if (!hasSubset(pl.hand, 'f')) return tryObtain(game, player, '', ['f']);
    if (!hasSubset(pl.hand, 't')) return tryObtain(game, player, '', ['t']);
    if (!hasSubset(pl.hand, 'j')) return tryObtain(game, player, '', ['j']);
    return null;
  },
};

// Runs the turnCounter 3..13 sweep once, mutating `st` (turnCounter /
// didSomething) and performing exactly the first action found. CompTurn's
// turnCounter==14: a pass that did something loops back (here: restart at 3
// instead of Java's 2, since 2 -- "is the robber active" -- is always false
// again mid-pass); a pass that did nothing ends the turn.
function doMain(game, st) {
  const player = game.current;
  const pl = game.players[player];
  const ctx = makeCtx(game, player);
  for (;;) {
    if (st.turnCounter > 13) {
      if (st.didSomething) { st.turnCounter = 3; st.didSomething = false; continue; }
      return game.endTurn();
    }
    const found = STEPS[st.turnCounter](game, player, pl, ctx);
    st.turnCounter++;
    if (found) { st.didSomething = true; return found.act(); }
  }
}

// Read-only twin of doMain for plan(): same table, same loop, but only
// returns the winning step's descriptor -- nothing is executed or persisted.
function previewMain(game, player, st) {
  const pl = game.players[player];
  const ctx = makeCtx(game, player);
  let turnCounter = st.turnCounter;
  let didSomething = st.didSomething;
  for (let guard = 0; guard < 200; guard++) {
    if (turnCounter > 13) {
      if (didSomething) { turnCounter = 3; didSomething = false; continue; }
      return { type: 'endTurn' };
    }
    const found = STEPS[turnCounter](game, player, pl, ctx);
    turnCounter++;
    if (found) return found.describe;
  }
  return { type: 'endTurn' };
}

// CompAction.firstTwoRoundsTurnAction: place the free setup settlement, then
// a road adjacent to it toward the best expansion (AI.getBestRoad with
// firstTwoHaz set); falls back to any legal choice so a step never stalls.
function doSetup(game, st) {
  const player = game.current;
  const pl = game.players[player];
  if (pl.supply.settlement > 0) {
    let junc = bestSettlement(game, player, true);
    if (junc === null) {
      const legal = game.legalSettlements(player);
      junc = legal.length ? legal[0] : null;
    }
    const event = game.placeSettlement(junc);
    st.firstTwoHaz = junc;
    return event;
  }
  if (pl.supply.roads > 0) {
    let road = bestRoad(game, player, st.firstTwoHaz);
    if (!road) {
      const legal = game.legalRoads(player);
      const touching = legal.filter(([a, b]) => a === st.firstTwoHaz || b === st.firstTwoHaz);
      const pick = touching[0] || legal[0];
      road = pick || null;
    }
    if (road) return game.placeRoad(road[0], road[1]);
  }
  return game.endTurn();
}

// CompTurn turnCounter==1, plus the JS-only pre-roll knight allowance the
// engine grants (playCard permits a knight in phase 'roll'): play a knight
// first when the robber currently hurts us or we can spare a second one,
// else roll.
function doRoll(game) {
  const player = game.current;
  const pl = game.players[player];
  const idx = findUnplayedDev(pl.dev, 'l');
  if (idx !== -1) {
    const count = countUnplayedDev(pl.dev, 'l');
    if (robberHurts(game, player) || count >= 2) return game.playCard(idx);
  }
  return game.rollDice();
}

// Rablo.throwHalf via the comp player: discard random cards (rng-driven, so
// still deterministic per seed).
function doDiscard(game) {
  const entry = game.discardQueue[0];
  const player = entry.player;
  const hand = game.players[player].hand.slice();
  const cards = [];
  for (let i = 0; i < entry.count; i++) {
    const idx = game.rng.nextInt(hand.length);
    cards.push(hand.splice(idx, 1)[0]);
  }
  return game.discard(player, cards);
}

// CompAction.rabloReplaceAction (tile pick half): AI.getTileForRablo, with a
// random fallback among legal land tiles when it returns nothing usable
// (its own tile, the current tile, or -- on a degenerate board -- nothing).
function doMoveRobber(game) {
  const board = game.board;
  const player = game.current;
  let target = bestRobberTile(game, player);
  if (target === null || target === board.robberTile.idx) {
    const candidates = board.tiles.filter((t) => (t.type === 'N' || t.type === 'S') && t !== board.robberTile);
    target = candidates.length ? candidates[game.rng.nextInt(candidates.length)].idx : board.robberTile.idx;
  }
  return game.moveRobber(target);
}

// CompAction.rabloReplaceAction (victim pick half): a uniform random victim,
// matching Rablo.robPlayer's own uniform random card pick.
function doChooseVictim(game) {
  const idx = game.rng.nextInt(game.robberVictims.length);
  return game.chooseVictim(game.robberVictims[idx]);
}

// Csere.nextSubmit -> csereDecideAction.
function doTrade(game) {
  return game.respondTrade(tradeResponse(game));
}

function describe(game, st, actor) {
  switch (game.phase) {
    case 'discard': {
      const entry = game.discardQueue[0];
      return { actor, phase: 'discard', type: 'discard', count: entry ? entry.count : 0 };
    }
    case 'moveRobber':
      return { actor, phase: 'moveRobber', type: 'moveRobber', tile: bestRobberTile(game, actor) };
    case 'chooseVictim':
      return { actor, phase: 'chooseVictim', type: 'chooseVictim' };
    case 'trade':
      return { actor, phase: 'trade', type: 'respondTrade', offerIndex: tradeResponse(game) };
    case 'setup': {
      const pl = game.players[actor];
      if (pl.supply.settlement > 0) {
        return { actor, phase: 'setup', type: 'placeSettlement', junc: bestSettlement(game, actor, true) };
      }
      return { actor, phase: 'setup', type: 'placeRoad', junc: st.firstTwoHaz };
    }
    case 'roll': {
      const pl = game.players[actor];
      const idx = findUnplayedDev(pl.dev, 'l');
      if (idx !== -1 && (robberHurts(game, actor) || countUnplayedDev(pl.dev, 'l') >= 2)) {
        return { actor, phase: 'roll', type: 'playCard', card: 'l' };
      }
      return { actor, phase: 'roll', type: 'roll' };
    }
    case 'main':
      return { actor, phase: 'main', ...previewMain(game, actor, st) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Public driver. `step()` performs exactly one engine action per call and
// never throws on a legal game state -- any unexpected GameError (or other
// bug) is recorded in `ai.errors` and answered with the simplest safe action
// for the current phase, so self-play can never deadlock.
export function createAI(options = {}) {
  const ai = { errors: [], options };

  function ensureTurnState(game) {
    if (ai._lastTurnNumber !== game.turnNumber || ai._lastCurrent !== game.current) {
      ai._lastTurnNumber = game.turnNumber;
      ai._lastCurrent = game.current;
      ai._state = { turnCounter: 3, didSomething: false, firstTwoHaz: null };
    }
    return ai._state;
  }

  function dispatch(game, st) {
    switch (game.phase) {
      case 'discard': return doDiscard(game);
      case 'moveRobber': return doMoveRobber(game);
      case 'chooseVictim': return doChooseVictim(game);
      case 'trade': return doTrade(game);
      case 'setup': return doSetup(game, st);
      case 'roll': return doRoll(game);
      case 'main': return doMain(game, st);
      default: return null;
    }
  }

  // Simplest legal action for the phase: endTurn where allowed, else a
  // minimal, always-legal move. Used only after an unexpected error.
  function safeFallback(game) {
    try {
      switch (game.phase) {
        case 'main': return game.endTurn();
        case 'setup': {
          const player = game.current;
          const pl = game.players[player];
          if (pl.supply.settlement > 0) {
            const legal = game.legalSettlements(player);
            if (legal.length) return game.placeSettlement(legal[0]);
          }
          if (pl.supply.roads > 0) {
            const legal = game.legalRoads(player);
            if (legal.length) return game.placeRoad(legal[0][0], legal[0][1]);
          }
          return null;
        }
        case 'roll': return game.rollDice();
        case 'discard': {
          const entry = game.discardQueue[0];
          if (!entry) return null;
          const hand = game.players[entry.player].hand.slice(0, entry.count);
          return game.discard(entry.player, hand);
        }
        case 'moveRobber': {
          const board = game.board;
          const t = board.tiles.find((x) => (x.type === 'N' || x.type === 'S') && x !== board.robberTile);
          return t ? game.moveRobber(t.idx) : null;
        }
        case 'chooseVictim':
          return game.robberVictims.length ? game.chooseVictim(game.robberVictims[0]) : null;
        case 'trade': return game.respondTrade(null);
        default: return null;
      }
    } catch (err2) {
      ai.errors.push({
        turnNumber: game.turnNumber, phase: game.phase, message: String((err2 && err2.message) || err2), fallbackFailed: true,
      });
      return null;
    }
  }

  function step(game) {
    if (game.phase === 'gameOver') return null;
    const actor = game.actor();
    const actorPl = game.players[actor];
    if (!actorPl || !actorPl.comp) return null;
    const st = ensureTurnState(game);
    try {
      return dispatch(game, st);
    } catch (err) {
      ai.errors.push({
        turnNumber: game.turnNumber, phase: game.phase, actor, message: String((err && err.message) || err),
      });
      return safeFallback(game);
    }
  }

  function plan(game) {
    if (game.phase === 'gameOver') return null;
    const actor = game.actor();
    const actorPl = game.players[actor];
    if (!actorPl || !actorPl.comp) return null;
    const st = ensureTurnState(game);
    return describe(game, st, actor);
  }

  return {
    step,
    tradeResponse: (game) => tradeResponse(game),
    plan,
    errors: ai.errors,
  };
}
