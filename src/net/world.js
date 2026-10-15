// The "world" a multiplayer session replicates: one Game plus one AI driver,
// advanced only by *entries* that every participant applies in the same
// order (lockstep). Two entry kinds exist:
//
//   { kind: 'call', player, call: { method, params } }  -- one engine action
//   { kind: 'ai' }                                       -- one ai.step(game)
//
// Because the engine is deterministic (all randomness through game.rng, the
// AI included -- see docs/ARCHITECTURE.md), a game rebuilt from
// (config, entries) on any machine is byte-identical to the host's. The
// rng's own position is part of that state, which is why 'ai' entries are
// replayed by *running the AI locally* on every peer rather than by sending
// the action the host's AI chose: a random discard/robber/victim choice on
// the host consumes rng numbers, and a peer that skipped the choice would
// roll different dice on the next turn. stateHash() folds the rng position
// in for exactly that reason, so a divergence surfaces on the very entry
// that caused it, not two turns later.

import { createGame, GameError } from '../engine/game.js';
import { createAI } from '../engine/ai.js';

// Engine methods a peer may invoke through the wire. Anything else (the
// tutorial affordances, toJSON, internal helpers) is refused before the
// engine sees it. setComputer is the one affordance allowed, and only from
// the host (see session.js) -- it hands a dropped player's seat to the AI.
export const CALL_METHODS = new Set([
  'rollDice', 'discard', 'moveRobber', 'chooseVictim', 'buy', 'refund',
  'placeSettlement', 'placeCity', 'placeRoad', 'playCard', 'bankTrade',
  'offerTrade', 'respondTrade', 'cancelTrade', 'endTurn', 'continueGame',
]);
export const HOST_ONLY_METHODS = new Set(['setComputer']);

const MAX_PARAMS = 8;
const MAX_DEPTH = 3;
const MAX_STRING = 64;

// Structural check of a single parameter value: JSON scalars, short strings,
// small arrays/plain objects of the same. Returns an error string or null.
function checkValue(v, depth) {
  if (v === null) return null;
  const type = typeof v;
  if (type === 'number') return Number.isFinite(v) ? null : 'non-finite number';
  if (type === 'boolean') return null;
  if (type === 'string') return v.length <= MAX_STRING ? null : 'string too long';
  if (depth >= MAX_DEPTH) return 'nesting too deep';
  if (Array.isArray(v)) {
    if (v.length > 32) return 'array too long';
    for (const x of v) { const e = checkValue(x, depth + 1); if (e) return e; }
    return null;
  }
  if (type === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return 'non-plain object';
    const keys = Object.keys(v);
    if (keys.length > 8) return 'too many keys';
    for (const k of keys) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return 'forbidden key';
      const e = checkValue(v[k], depth + 1);
      if (e) return e;
    }
    return null;
  }
  return `unsupported type ${type}`;
}

// Validates a wire-shaped call. Returns null when acceptable, else a reason.
export function validateCall(call, { hostOnly = false } = {}) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return 'call is not an object';
  const { method, params } = call;
  if (typeof method !== 'string') return 'method is not a string';
  if (!CALL_METHODS.has(method) && !(hostOnly && HOST_ONLY_METHODS.has(method))) {
    return `method ${method} not allowed`;
  }
  if (!Array.isArray(params)) return 'params is not an array';
  if (params.length > MAX_PARAMS) return 'too many params';
  for (const p of params) { const e = checkValue(p, 1); if (e) return e; }
  return null;
}

// Validates an entry as it arrives from the wire (shape only; legality is
// decided by the engine when it is applied).
export function validateEntry(entry, opts) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'entry is not an object';
  if (entry.kind === 'ai') return null;
  if (entry.kind === 'call') {
    if (!Number.isInteger(entry.player) || entry.player < 0 || entry.player > 6) return 'bad player';
    return validateCall(entry.call, opts);
  }
  return `unknown entry kind ${entry && entry.kind}`;
}

// Applies one entry to (game, ai). Returns the engine's log event (or the
// AI's returned event). Throws GameError on an illegal action; the caller
// decides whether that means "reject the sender" (host) or "resync" (peer).
export function applyEntry(game, ai, entry) {
  if (entry.kind === 'ai') {
    if (!ai) throw new GameError('NO_AI', 'no AI driver to apply an ai entry with');
    const actor = game.actor();
    if (game.phase === 'gameOver' || !game.players[actor] || !game.players[actor].comp) {
      throw new GameError('NOT_COMPUTER', `ai entry while player ${actor} (a human) is the actor`);
    }
    const ev = ai.step(game);
    if (!ev) throw new GameError('AI_NOOP', 'ai.step() did nothing');
    return ev;
  }
  if (entry.kind === 'call') {
    const { method, params } = entry.call;
    const fn = game[method];
    if (typeof fn !== 'function') throw new GameError('BAD_ARGUMENT', `no such engine method ${method}`);
    return fn.apply(game, params);
  }
  throw new GameError('BAD_ARGUMENT', `unknown entry kind ${entry && entry.kind}`);
}

// FNV-1a over the JSON of the game state minus its log, plus the rng's
// position. Cheap enough to run after every entry.
export function stateHash(game) {
  const json = game.toJSON({ log: false });
  delete json.log;
  const rngPos = game.rng && game.rng.seed !== undefined ? game.rng.seed.toString() : '';
  const text = `${JSON.stringify(json)}|rng:${rngPos}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// A fresh world from a start config: { numPlayers, beginner, seed, computer[], names[] }.
export function createWorld(config, aiFactory = createAI) {
  const game = createGame({
    numPlayers: config.numPlayers,
    beginner: config.beginner,
    seed: config.seed,
    computer: config.computer,
  });
  const ai = aiFactory();
  return { game, ai };
}

// Rebuilds a world by applying every entry in order. Throws (with the
// failing index attached) if the log is not replayable -- a corrupt or
// tampered log, or a nondeterminism bug.
export function replay(config, entries, aiFactory = createAI) {
  const world = createWorld(config, aiFactory);
  for (let i = 0; i < entries.length; i++) {
    try {
      applyEntry(world.game, world.ai, entries[i]);
    } catch (err) {
      const e = new Error(`replay failed at entry ${i} (${entries[i] && entries[i].kind}): ${err && err.message}`);
      e.index = i;
      e.cause = err;
      throw e;
    }
  }
  return world;
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return 'config is not an object';
  const n = config.numPlayers;
  if (!Number.isInteger(n) || n < 3 || n > 6) return 'numPlayers must be 3..6';
  if (!Number.isInteger(config.beginner) || config.beginner < 1 || config.beginner > n) return 'bad beginner';
  if (!Number.isFinite(config.seed)) return 'bad seed';
  if (!Array.isArray(config.computer) || config.computer.length !== n || config.computer.some((c) => typeof c !== 'boolean')) return 'bad computer[]';
  if (config.names !== undefined) {
    if (!Array.isArray(config.names) || config.names.length !== n) return 'bad names[]';
    for (const s of config.names) if (typeof s !== 'string' || s.length > 24) return 'bad name';
  }
  // Chat personalities per seat ('' = random); never affects the game.
  if (config.personas !== undefined) {
    if (!Array.isArray(config.personas) || config.personas.length !== n) return 'bad personas[]';
    for (const p of config.personas) if (typeof p !== 'string' || !/^[a-z]{0,16}$/.test(p)) return 'bad persona';
  }
  return null;
}
