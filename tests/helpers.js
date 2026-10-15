// Shared test utilities (not a *.test.js file, so node --test ignores it).
import { JavaRandom } from '../src/engine/rng.js';

// Clone a JavaRandom's internal LCG state so we can *predict* upcoming draws
// (e.g. the next dice roll) without disturbing the real game's rng.
export function cloneRng(rng) {
  const clone = Object.create(JavaRandom.prototype);
  clone.seed = rng.seed;
  return clone;
}

// Directly hand a player some resource cards for test setup ("give cards by
// driving the game or, where needed, by directly pushing into player.hand").
export function giveCards(game, player, letters) {
  for (const c of letters) game.players[player].hand.push(c);
}

// Complete the whole setup phase (both rounds, for every player) using the
// first legal settlement/road choice each turn, through the public API only.
// Returns the list of { player, junc } settlements placed, in order.
export function autoSetup(game) {
  const placed = [];
  while (game.phase === 'setup') {
    const p = game.current;
    const junc = game.legalSettlements(p)[0];
    if (junc === undefined) throw new Error(`no legal settlement for player ${p}`);
    game.placeSettlement(junc);
    placed.push({ player: p, junc });
    const roads = game.legalRoads(p);
    const road = roads.find(([a, b]) => a === junc || b === junc) || roads[0];
    if (!road) throw new Error(`no legal road for player ${p}`);
    game.placeRoad(road[0], road[1]);
    game.endTurn();
  }
  return placed;
}

// First land tile with the given number (and, unless allowRobber, without
// the robber on it).
export function findTileWithNumber(board, number, { allowRobber = false } = {}) {
  return board.landTiles.find((t) => t.number === number && (allowRobber || !t.hasRobber));
}

// Move the robber to a tile directly (test rig only -- not a game action;
// used to set up "robber tile pays nothing" / victim scenarios).
export function forceRobberTo(game, tile) {
  game.board.robberTile.hasRobber = false;
  tile.hasRobber = true;
  game.board.robberTile = tile;
}

export function sumHand(hand) {
  return hand.length;
}

export function totalCardsInPlay(game) {
  let n = 0;
  for (let i = 1; i <= game.numPlayers; i++) n += game.players[i].hand.length;
  return n;
}

export function totalDevCards(game) {
  let n = game.devDeck.length;
  for (let i = 1; i <= game.numPlayers; i++) n += game.players[i].dev.length;
  return n;
}
