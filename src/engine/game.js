// Game state and rules. Faithful port of the game-logic portions of S.java,
// PlayerSelect.java, Board.java (collect), Pakli.java, Card.java, Haz.java,
// Player.java, Rablo.java, Deck.java, Longest.java and Kocka.java
// (P. Csurgay, 2004). See docs/ARCHITECTURE.md for the full state/action
// contract this file implements.
//
// No DOM, no dependencies beyond board.js/rng.js. Every action validates its
// preconditions and throws GameError on violation; nothing is silently
// ignored. Every source of randomness goes through `this.rng.nextInt(n)`.

import {
  createBoard, setupBoard, boardSizeForPlayers, boardToJSON,
  hasHarbor, hasAdjacentBuilding, hasOwnRoad, roadOwner, setRoad, longestRoadOf,
  RESOURCES,
} from './board.js';
import { JavaRandom } from './rng.js';

// Build costs and piece limits (see docs/ARCHITECTURE.md, Haz.hvString and
// Player.maxNoHazVaros/maxNoUt).
export const COST = { road: 'ft', settlement: 'ftbj', city: 'bbkkk', devcard: 'bjk' };
export const MAX_PIECES = { settlement: 5, city: 4, road: 15 };

// 5 victory point cards, 14 knights, 2 road building, 2 year of plenty,
// 2 monopoly = 25 cards (Pakli.cardString).
export const DEV_DECK = 'ktepolllllllllllllluuffmm';

const VP_CARDS = ['k', 't', 'e', 'p', 'o'];

export class GameError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'GameError';
    this.code = code;
  }
}

export class Game {
  constructor(opts = {}) {
    const numPlayers = opts.numPlayers ?? 4;
    const beginner = opts.beginner ?? 1;
    const rawSeed = opts.seed ?? Date.now();
    const seed = Number.isFinite(Number(rawSeed)) ? Math.trunc(Number(rawSeed)) : Date.now();
    if (!Number.isInteger(numPlayers) || numPlayers < 3 || numPlayers > 6) {
      throw new GameError('BAD_ARGUMENT', `numPlayers must be 3..6, got ${numPlayers}`);
    }
    if (!Number.isInteger(beginner) || beginner < 1 || beginner > numPlayers) {
      throw new GameError('BAD_ARGUMENT', `beginner must be 1..${numPlayers}, got ${beginner}`);
    }

    this.numPlayers = numPlayers;
    this.beginner = beginner;
    this.seed = seed;
    this.rng = new JavaRandom(seed);

    // Board.create()/Board.init() -- terrain, harbors, numbers dealt from the same rng.
    this.board = createBoard(boardSizeForPlayers(numPlayers));
    setupBoard(this.board, this.rng);

    // Pakli() -- construct then shuffle the 25-card development deck.
    this.devDeck = shuffleDevDeck(this.rng);

    // Player() / Player.init()
    this.players = new Array(numPlayers + 1); // index 0 unused, 1..n are players
    for (let i = 1; i <= numPlayers; i++) {
      this.players[i] = {
        id: i,
        comp: !!(opts.computer && opts.computer[i - 1]),
        hand: [],
        dev: [],
        supply: { settlement: 0, city: 0, roads: 0 },
        placed: { settlements: 0, cities: 0, roads: 0 },
        settlementCount: 0,
        // How many of supply.roads are free grants from a road-building card
        // (not yet placed), as opposed to bought with 'ft' -- refund() must
        // not hand back cards for one of these (see refund()/_grantRoad()).
        grantedRoads: 0,
      };
    }

    this.current = beginner - 1; // PlayerSelect: `ps.current--;` before the first nextPlayer()
    this.phase = 'setup';
    this.rounds = 0; // PlayerSelect: S.noRounds = 0
    this.dice = [4, 3]; // Kocka: v[0]=4; v[1]=3;
    this.discardQueue = [];
    this.robberReturnPhase = 'main';
    this.robberVictims = [];
    this.trade = null;
    this.longestRoad = { length: 4, player: 0 }; // Longest.init()
    this.largestArmy = { size: 2, player: 0 };
    this.winner = 0;
    this.log = [];
    this.turnNumber = 0;

    this._forcedRoll = null; // tutorial affordance, see forceNextRoll
    this._backwards = false; // PlayerSelect.backwards
    this._secondRoundOver = false; // PlayerSelect.masodikKorVege

    // `computer` lets a log reader (the bot chat) know who the computer
    // players are from the log alone; later changes are logged by
    // setComputer().
    this.log.push({
      type: 'newGame', numPlayers, beginner, seed, computer: this.players.slice(1).map((p) => p.comp),
    });

    // PlayerSelect.nextPlayer(), first call from S.newGame(): lands on `beginner`,
    // rounds becomes 1, and the first setup player gets a free settlement+road.
    this._advanceTurn();
  }

  // ---------------------------------------------------------------------
  // Pure helpers (no mutation, no log entries)

  // discardQueue actor, then trade responder, else the player whose turn it is.
  actor() {
    if (this.phase === 'discard' && this.discardQueue.length > 0) return this.discardQueue[0].player;
    if (this.phase === 'trade' && this.trade) return this.trade.responder;
    return this.current;
  }

  // settlements + 2*cities + 2 (longest road) + 2 (largest army) + played VP cards
  victoryPoints(player) {
    const pl = this.players[player];
    let vp = pl.placed.settlements + 2 * pl.placed.cities;
    if (this.longestRoad.player === player) vp += 2;
    if (this.largestArmy.player === player) vp += 2;
    for (const c of pl.dev) if (c.played && VP_CARDS.includes(c.res)) vp++;
    return vp;
  }

  knightsPlayed(player) {
    let n = 0;
    for (const c of this.players[player].dev) if (c.res === 'l' && c.played) n++;
    return n;
  }

  // Pure predicate mirroring buy()'s checks (Player.maxNoHazVaros / maxNoUt).
  canBuy(kind) {
    if (this.phase !== 'main') return false;
    if (kind !== 'road' && kind !== 'settlement' && kind !== 'city' && kind !== 'devcard') return false;
    const pl = this.players[this.current];
    if (kind === 'devcard') return this.devDeck.length > 0 && this._hasCards(pl.hand, COST.devcard);
    const { placedKey, supplyKey, maxStock } = pieceKeys(kind);
    if (pl.placed[placedKey] + pl.supply[supplyKey] >= MAX_PIECES[kind]) return false;
    if (pl.supply[supplyKey] >= maxStock) return false;
    return this._hasCards(pl.hand, COST[kind]);
  }

  // Junction.vanszomszed (distance rule) + Junction.vanideut (own road) once rounds >= 3.
  canPlaceSettlement(player, juncNo) {
    const junc = this.board.junctions[juncNo];
    if (!junc) return false;
    if (junc.building.type !== 0) return false;
    if (hasAdjacentBuilding(junc)) return false;
    if (this.rounds >= 3 && !hasOwnRoad(junc, player)) return false;
    return true;
  }

  canPlaceCity(player, juncNo) {
    const junc = this.board.junctions[juncNo];
    if (!junc) return false;
    return junc.building.type === 1 && junc.building.player === player;
  }

  // Road must be a real edge, empty, and reach the player's own network at
  // one endpoint; an opponent's building at that endpoint blocks the connection.
  canPlaceRoad(player, aNo, bNo) {
    const a = this.board.junctions[aNo];
    const b = this.board.junctions[bNo];
    if (!a || !b || a.juncs.indexOf(b) === -1) return false;
    if (roadOwner(a, b) !== 0) return false;
    const endpointOk = (j) => {
      const bld = j.building;
      if (bld.type > 0) return bld.player === player;
      return hasOwnRoad(j, player);
    };
    return endpointOk(a) || endpointOk(b);
  }

  legalSettlements(player) {
    const out = [];
    for (const j of this.board.junctions) if (this.canPlaceSettlement(player, j.no)) out.push(j.no);
    return out;
  }

  legalRoads(player) {
    const out = [];
    for (const a of this.board.junctions) {
      for (const b of a.juncs) {
        if (a.no < b.no && this.canPlaceRoad(player, a.no, b.no)) out.push([a.no, b.no]);
      }
    }
    return out;
  }

  // S.buttonEnabler(): 4 any cards -> 4:1; 3 cards + '3' harbor -> 3:1;
  // 2 identical cards + a matching 2:1 harbor -> 2:1. (The original does not
  // require the 4 or 3 cards to match each other -- faithfully kept here.)
  bankTradeRatio(give) {
    if (typeof give !== 'string') return 0;
    const n = give.length;
    if (n === 4) return 4;
    if (n === 3) return hasHarbor(this.board, this.current, '3') ? 3 : 0;
    if (n === 2) {
      if (give[0] !== give[1]) return 0;
      return hasHarbor(this.board, this.current, give[0]) ? 2 : 0;
    }
    return 0;
  }

  // `opts.log === false` leaves the (ever-growing) log out -- used by the
  // multiplayer state hash, which runs after every action. Note
  // JSON.stringify() passes a string key as the first argument; that is
  // treated like no options.
  toJSON(opts) {
    const includeLog = !(opts && typeof opts === 'object' && opts.log === false);
    const players = {};
    for (let i = 1; i <= this.numPlayers; i++) {
      const pl = this.players[i];
      players[i] = {
        id: pl.id,
        comp: pl.comp,
        hand: pl.hand.slice(),
        dev: pl.dev.map((c) => ({ res: c.res, played: c.played })),
        supply: { ...pl.supply },
        placed: { ...pl.placed },
        settlementCount: pl.settlementCount,
      };
    }
    return {
      numPlayers: this.numPlayers,
      beginner: this.beginner,
      seed: this.seed,
      board: boardToJSON(this.board),
      players,
      current: this.current,
      phase: this.phase,
      rounds: this.rounds,
      dice: this.dice.slice(),
      devDeck: this.devDeck.slice(),
      discardQueue: this.discardQueue.map((e) => ({ ...e })),
      robberReturnPhase: this.robberReturnPhase,
      robberVictims: this.robberVictims.slice(),
      trade: this.trade
        ? { from: this.trade.from, offers: this.trade.offers.map((o) => ({ ...o })), responder: this.trade.responder }
        : null,
      longestRoad: { ...this.longestRoad },
      largestArmy: { ...this.largestArmy },
      winner: this.winner,
      // True once a winner has ever been decided, even after continueGame()
      // takes the phase back to 'main' -- distinct from `phase === 'gameOver'`
      // (task item 8): a finished game that is still being played out.
      finished: this.winner !== 0,
      turnNumber: this.turnNumber,
      log: includeLog ? this.log.map((e) => ({ ...e })) : undefined,
    };
  }

  // ---------------------------------------------------------------------
  // Internal mutation helpers

  _requirePhase(expected) {
    if (this.phase !== expected) {
      throw new GameError('WRONG_PHASE', `expected phase '${expected}', got '${this.phase}'`);
    }
  }

  _hasCards(hand, letters) {
    const copy = hand.slice();
    for (const c of letters) {
      const idx = copy.indexOf(c);
      if (idx === -1) return false;
      copy.splice(idx, 1);
    }
    return true;
  }

  // Removes the *first* occurrence of each letter (acquisition order kept for the rest).
  _takeCards(hand, letters) {
    for (const c of letters) {
      const idx = hand.indexOf(c);
      if (idx === -1) throw new GameError('NO_CARDS', `missing '${c}' in hand`);
      hand.splice(idx, 1);
    }
  }

  // Board.collect(pV): every land tile without the robber showing that number
  // pays each adjacent building `building.type` cards of its resource. No bank limit.
  _collect(v) {
    for (const tile of this.board.landTiles) {
      if (tile.hasRobber || tile.number !== v) continue;
      for (const junc of tile.juncs) {
        const b = junc.building;
        if (b.type === 0) continue;
        for (let k = 0; k < b.type; k++) this.players[b.player].hand.push(tile.resource);
        this.log.push({
          type: 'collect', player: b.player, res: tile.resource, count: b.type, tile: tile.idx,
        });
      }
    }
  }

  // PlayerSelect.next()
  _next() {
    this.current++;
    if (this.current > this.numPlayers) this.current = 1;
    if (this.current === this.beginner) this.rounds++;
  }

  // PlayerSelect.previous()
  _previous() {
    this.current--;
    if (this.current < 1) this.current = this.numPlayers;
    if (this._secondRoundOver) this.rounds++;
    if (this.current === this.beginner) this._secondRoundOver = true;
  }

  // PlayerSelect.nextPlayer(): advances current/rounds, reverses direction after
  // round 1, flips back to forward (and hands out initial resources) after the
  // reversed round 2, and grants the free setup pieces while rounds <= 2.
  _advanceTurn() {
    if (!this._backwards) this._next(); else this._previous();

    if (this.rounds === 2 && !this._backwards) {
      this._backwards = true;
      this._previous();
    }
    if (this._backwards && this.rounds === 3) {
      this._backwards = false;
      this.rounds--;
      this._next();
      // "laposztas": one card per adjacent producing tile for every settlement.
      for (let v = 2; v <= 12; v++) if (v !== 7) this._collect(v);
    }
    if (this.rounds <= 2) {
      const pl = this.players[this.current];
      pl.supply.settlement = 1;
      pl.supply.roads = 1;
    }
    this.phase = this.rounds > 2 ? 'roll' : 'setup';
    this.log.push({
      type: 'turn', player: this.current, rounds: this.rounds, phase: this.phase,
    });
  }

  // Rablo.robPlayer(): steal one random card from a victim's hand.
  _stealFrom(victim) {
    const pl = this.players[victim];
    const idx = this.rng.nextInt(pl.hand.length);
    const card = pl.hand.splice(idx, 1)[0];
    this.players[this.current].hand.push(card);
    this.log.push({ type: 'steal', from: victim, to: this.current, card });
  }

  // Pakli.teddvissza: insert a used u/f/m card back at a random position.
  _recycleCard(res) {
    const r = this.rng.nextInt(this.devDeck.length + 1);
    this.devDeck.splice(r, 0, res);
  }

  // Card.adjKetUtat: grant one road to supply, respecting the 2-in-supply and
  // 15-total limits. Tracked in grantedRoads so refund() (see below) never
  // pays out 'ft' cards for a road nobody bought.
  _grantRoad() {
    const pl = this.players[this.current];
    if (pl.supply.roads < 2 && pl.placed.roads + pl.supply.roads < MAX_PIECES.road) {
      pl.supply.roads++;
      pl.grantedRoads++;
      return true;
    }
    return false;
  }

  // Longest.longestPlayer()/setLongestRoad(): strictly-greater wins; ties keep the holder.
  _updateLongestRoad() {
    for (let p = 1; p <= this.numPlayers; p++) {
      const len = longestRoadOf(this.board, p);
      if (len > this.longestRoad.length) {
        this.longestRoad = { length: len, player: p };
        this.log.push({ type: 'longestRoad', player: p, length: len });
      }
    }
    this._checkWinner();
  }

  // Longest.largest()/setLongestRoad(): same for knights played.
  _updateLargestArmy() {
    for (let p = 1; p <= this.numPlayers; p++) {
      const size = this.knightsPlayed(p);
      if (size > this.largestArmy.size) {
        this.largestArmy = { size, player: p };
        this.log.push({ type: 'largestArmy', player: p, size });
      }
    }
    this._checkWinner();
  }

  // The original never checked for a winner; the port adds it, checked after
  // placeSettlement/placeCity/playCard/updateLongestRoad/updateLargestArmy.
  // Guarded on `this.winner` (not `this.phase`) so it never fires a second
  // time once a winner exists, even after continueGame() has moved the phase
  // back to 'main' and play goes on (task item 8) -- a player at 10+ VP who
  // keeps building must not get a second 'gameOver' log entry.
  _checkWinner() {
    if (this.winner !== 0) return;
    if (this.victoryPoints(this.current) >= 10) {
      this.winner = this.current;
      this.phase = 'gameOver';
      this.log.push({ type: 'gameOver', winner: this.current });
    }
  }

  // ---------------------------------------------------------------------
  // Actions

  // Kocka.dobj() + Board.collect()
  rollDice() {
    this._requirePhase('roll');
    let d1;
    let d2;
    if (this._forcedRoll) {
      [d1, d2] = this._forcedRoll;
      this._forcedRoll = null;
    } else {
      d1 = this.rng.nextInt(6) + 1;
      d2 = this.rng.nextInt(6) + 1;
    }
    this.dice = [d1, d2];
    const sum = d1 + d2;
    const event = { type: 'roll', player: this.current, dice: [d1, d2], sum };
    this.log.push(event);
    if (sum !== 7) {
      this._collect(sum);
      this.phase = 'main';
    } else {
      this.discardQueue = [];
      for (let i = 1; i <= this.numPlayers; i++) {
        const pl = this.players[i];
        if (pl.hand.length > 7) this.discardQueue.push({ player: i, count: Math.floor(pl.hand.length / 2) });
      }
      this.robberReturnPhase = 'main';
      this.phase = this.discardQueue.length > 0 ? 'discard' : 'moveRobber';
    }
    return event;
  }

  // Rablo.throwHalf()
  discard(player, cards) {
    this._requirePhase('discard');
    const entry = this.discardQueue[0];
    if (!entry) throw new GameError('WRONG_PHASE', 'no player owes a discard');
    if (entry.player !== player) throw new GameError('NOT_YOUR_TURN', `player ${entry.player} must discard first`);
    if (!Array.isArray(cards) || cards.length !== entry.count) {
      throw new GameError('BAD_ARGUMENT', `must discard exactly ${entry.count} cards`);
    }
    const pl = this.players[player];
    if (!this._hasCards(pl.hand, cards)) throw new GameError('BAD_ARGUMENT', 'cards not in hand');
    this._takeCards(pl.hand, cards);
    const event = { type: 'discard', player, cards: cards.slice() };
    this.log.push(event);
    this.discardQueue.shift();
    if (this.discardQueue.length === 0) this.phase = 'moveRobber';
    return event;
  }

  // S.mouseClicked (rablo.moves branch) + Rablo.robPlayer()/getRablosak()
  moveRobber(tileIdx) {
    this._requirePhase('moveRobber');
    const tile = this.board.tiles[tileIdx];
    if (!tile) throw new GameError('BAD_ARGUMENT', `no such tile ${tileIdx}`);
    if (tile.type !== 'N' && tile.type !== 'S') throw new GameError('ILLEGAL_PLACEMENT', 'robber must move to a land tile');
    if (tile === this.board.robberTile) throw new GameError('ILLEGAL_PLACEMENT', 'robber is already there');

    this.board.robberTile.hasRobber = false;
    this.board.robberTile = tile;
    tile.hasRobber = true;
    const event = { type: 'robber', player: this.current, tile: tile.idx };
    this.log.push(event);

    const victims = [];
    for (const junc of tile.juncs) {
      const b = junc.building;
      if (b.type > 0 && b.player !== this.current && !victims.includes(b.player) && this.players[b.player].hand.length > 0) {
        victims.push(b.player);
      }
    }
    if (victims.length === 0) {
      this.phase = this.robberReturnPhase;
    } else if (victims.length === 1) {
      this._stealFrom(victims[0]);
      this.phase = this.robberReturnPhase;
    } else {
      this.robberVictims = victims;
      this.phase = 'chooseVictim';
    }
    return event;
  }

  chooseVictim(player) {
    this._requirePhase('chooseVictim');
    if (!this.robberVictims.includes(player)) throw new GameError('BAD_ARGUMENT', `${player} is not a valid victim`);
    this._stealFrom(player);
    this.robberVictims = [];
    this.phase = this.robberReturnPhase;
    return { type: 'steal', to: this.current };
  }

  // Haz.mouseClicked (arakKartya buy branch) / Player.EntwClass.mouseClicked
  buy(kind) {
    this._requirePhase('main');
    if (kind !== 'road' && kind !== 'settlement' && kind !== 'city' && kind !== 'devcard') {
      throw new GameError('BAD_ARGUMENT', `unknown kind '${kind}'`);
    }
    const pl = this.players[this.current];
    if (kind === 'devcard') {
      if (this.devDeck.length === 0) throw new GameError('DECK_EMPTY', 'the development deck is empty');
      if (!this._hasCards(pl.hand, COST.devcard)) throw new GameError('NO_CARDS', 'not enough cards to buy a development card');
      this._takeCards(pl.hand, COST.devcard);
      const res = this.devDeck.pop();
      pl.dev.push({ res, played: false });
    } else {
      const { placedKey, supplyKey, maxStock } = pieceKeys(kind);
      if (pl.placed[placedKey] + pl.supply[supplyKey] >= MAX_PIECES[kind]) {
        throw new GameError('LIMIT', `no more than ${MAX_PIECES[kind]} ${kind}s allowed`);
      }
      if (pl.supply[supplyKey] >= maxStock) throw new GameError('LIMIT', `already ${maxStock} unplaced ${kind}(s)`);
      if (!this._hasCards(pl.hand, COST[kind])) throw new GameError('NO_CARDS', `not enough cards to buy a ${kind}`);
      this._takeCards(pl.hand, COST[kind]);
      pl.supply[supplyKey]++;
    }
    const event = { type: 'buy', player: this.current, kind };
    this.log.push(event);
    return event;
  }

  refund(kind) {
    this._requirePhase('main');
    if (kind !== 'road' && kind !== 'settlement' && kind !== 'city') {
      throw new GameError('BAD_ARGUMENT', `cannot refund '${kind}'`);
    }
    const pl = this.players[this.current];
    const { supplyKey } = pieceKeys(kind);
    if (!pl.supply[supplyKey]) throw new GameError('NO_SUPPLY', `no ${kind} in supply to refund`);
    pl.supply[supplyKey]--;
    // A road granted for free by a road-building card was never paid for --
    // give it back to supply-of-nothing, not to the player's hand (that
    // would mint free 'ft' cards out of thin air every time one is carried
    // then dropped again via the price card).
    if (kind === 'road' && pl.grantedRoads > 0) {
      pl.grantedRoads--;
    } else {
      for (const c of COST[kind]) pl.hand.push(c);
    }
    const event = { type: 'refund', player: this.current, kind };
    this.log.push(event);
    return event;
  }

  // Haz.mouseClicked (place on board branch)
  placeSettlement(juncNo) {
    if (this.phase !== 'setup' && this.phase !== 'main') throw new GameError('WRONG_PHASE', `cannot place in phase '${this.phase}'`);
    const pl = this.players[this.current];
    if (!pl.supply.settlement) throw new GameError('NO_SUPPLY', 'no settlement in supply');
    if (!this.canPlaceSettlement(this.current, juncNo)) throw new GameError('ILLEGAL_PLACEMENT', `cannot place a settlement on ${juncNo}`);
    const junc = this.board.junctions[juncNo];
    pl.settlementCount++;
    junc.building = { type: 1, player: this.current, order: pl.settlementCount };
    pl.placed.settlements++;
    pl.supply.settlement--;
    const event = { type: 'place', player: this.current, kind: 'settlement', junc: juncNo };
    this.log.push(event);
    this._checkWinner();
    return event;
  }

  placeCity(juncNo) {
    this._requirePhase('main');
    const pl = this.players[this.current];
    if (!pl.supply.city) throw new GameError('NO_SUPPLY', 'no city in supply');
    if (!this.canPlaceCity(this.current, juncNo)) throw new GameError('ILLEGAL_PLACEMENT', `cannot upgrade ${juncNo} to a city`);
    const junc = this.board.junctions[juncNo];
    junc.building.type = 2;
    pl.placed.settlements--;
    pl.placed.cities++;
    pl.supply.city--;
    const event = { type: 'place', player: this.current, kind: 'city', junc: juncNo };
    this.log.push(event);
    this._checkWinner();
    return event;
  }

  placeRoad(aNo, bNo) {
    if (this.phase !== 'setup' && this.phase !== 'main') throw new GameError('WRONG_PHASE', `cannot place in phase '${this.phase}'`);
    const pl = this.players[this.current];
    if (!pl.supply.roads) throw new GameError('NO_SUPPLY', 'no road in supply');
    if (!this.canPlaceRoad(this.current, aNo, bNo)) throw new GameError('ILLEGAL_PLACEMENT', `cannot place a road ${aNo}-${bNo}`);
    const a = this.board.junctions[aNo];
    const b = this.board.junctions[bNo];
    setRoad(a, b, this.current);
    pl.placed.roads++;
    pl.supply.roads--;
    if (pl.grantedRoads > pl.supply.roads) pl.grantedRoads = pl.supply.roads;
    const event = { type: 'place', player: this.current, kind: 'road', edge: [aNo, bNo] };
    this.log.push(event);
    this._updateLongestRoad();
    return event;
  }

  // Card.mouseClicked (the 'E' branch): knights may also be played before
  // rolling (in phase 'roll'), everything else only in 'main'.
  playCard(index, opts = {}) {
    const pl = this.players[this.current];
    const card = pl.dev[index];
    if (!card) throw new GameError('BAD_ARGUMENT', `no development card at index ${index}`);
    const isKnight = card.res === 'l';
    if (this.phase !== 'main' && !(isKnight && this.phase === 'roll')) {
      throw new GameError('WRONG_PHASE', `cannot play cards in phase '${this.phase}'`);
    }
    if (card.played) throw new GameError('BAD_ARGUMENT', 'card already played');

    if (isKnight) {
      card.played = true;
      this._updateLargestArmy();
      this.robberReturnPhase = this.phase;
      this.phase = 'moveRobber';
      const event = { type: 'playCard', player: this.current, res: 'l' };
      this.log.push(event);
      this._checkWinner();
      return event;
    }

    if (card.res === 'u') {
      this._grantRoad();
      this._grantRoad();
      pl.dev.splice(index, 1);
      this._recycleCard('u');
      const event = { type: 'playCard', player: this.current, res: 'u' };
      this.log.push(event);
      return event;
    }

    if (card.res === 'f') {
      const resources = opts.resources;
      if (!Array.isArray(resources) || resources.length !== 2 || resources.some((r) => !RESOURCES.includes(r))) {
        throw new GameError('BAD_ARGUMENT', 'opts.resources must be two resource letters');
      }
      for (const r of resources) pl.hand.push(r);
      pl.dev.splice(index, 1);
      this._recycleCard('f');
      const event = { type: 'playCard', player: this.current, res: 'f', resources: resources.slice() };
      this.log.push(event);
      return event;
    }

    if (card.res === 'm') {
      const res = opts.resource;
      if (!RESOURCES.includes(res)) throw new GameError('BAD_ARGUMENT', 'opts.resource must be a resource letter');
      let total = 0;
      for (let i = 1; i <= this.numPlayers; i++) {
        if (i === this.current) continue;
        const other = this.players[i];
        const remaining = [];
        for (const c of other.hand) { if (c === res) total++; else remaining.push(c); }
        other.hand = remaining;
      }
      for (let k = 0; k < total; k++) pl.hand.push(res);
      pl.dev.splice(index, 1);
      this._recycleCard('m');
      const event = { type: 'playCard', player: this.current, res: 'm', resource: res, taken: total };
      this.log.push(event);
      return event;
    }

    if (VP_CARDS.includes(card.res)) {
      card.played = true;
      const event = { type: 'playCard', player: this.current, res: card.res };
      this.log.push(event);
      this._checkWinner();
      return event;
    }

    throw new GameError('BAD_ARGUMENT', `unknown development card '${card.res}'`);
  }

  // S.buttonEnabler() / S.actionPerformed("becserel")
  bankTrade(give, want) {
    this._requirePhase('main');
    if (!RESOURCES.includes(want)) throw new GameError('BAD_ARGUMENT', `bad resource '${want}'`);
    const ratio = this.bankTradeRatio(give);
    if (ratio === 0) throw new GameError('BAD_TRADE', `cannot trade '${give}'`);
    const pl = this.players[this.current];
    if (!this._hasCards(pl.hand, give)) throw new GameError('NO_CARDS', 'missing cards to trade');
    this._takeCards(pl.hand, give);
    pl.hand.push(want);
    const event = {
      type: 'bankTrade', player: this.current, give, want, ratio,
    };
    this.log.push(event);
    return event;
  }

  // S.actionPerformed("csere") + Csere.addOffer(): stack up to 6 offers, then
  // the round-robin starts with the player right after the offerer.
  offerTrade(offers) {
    this._requirePhase('main');
    if (!Array.isArray(offers) || offers.length < 1 || offers.length > 6) {
      throw new GameError('BAD_ARGUMENT', 'offers must have 1..6 entries');
    }
    const pl = this.players[this.current];
    for (const o of offers) {
      if (!o || typeof o.give !== 'string' || o.give.length === 0) throw new GameError('BAD_ARGUMENT', 'bad offer.give');
      if (!RESOURCES.includes(o.want)) throw new GameError('BAD_ARGUMENT', 'bad offer.want');
      if (!this._hasCards(pl.hand, o.give)) throw new GameError('BAD_ARGUMENT', 'offer.give not in hand');
      if (o.give.includes(o.want)) throw new GameError('BAD_ARGUMENT', 'offer.want must not be part of offer.give');
    }
    const responder = (this.current % this.numPlayers) + 1;
    this.trade = { from: this.current, offers: offers.map((o) => ({ give: o.give, want: o.want })), responder };
    this.phase = 'trade';
    const event = { type: 'offerTrade', player: this.current, offers: this.trade.offers };
    this.log.push(event);
    return event;
  }

  // Csere.actionPerformed(): "Pass" advances the responder; wrapping back to
  // the offerer closes the round with nothing accepted.
  respondTrade(offerIndex) {
    this._requirePhase('trade');
    const responder = this.trade.responder;
    if (offerIndex === null || offerIndex === undefined) {
      const event = { type: 'tradeResponse', player: responder, accepted: null };
      this.log.push(event);
      const next = (responder % this.numPlayers) + 1;
      if (next === this.trade.from) {
        this.trade = null;
        this.phase = 'main';
      } else {
        this.trade.responder = next;
      }
      return event;
    }
    const offer = this.trade.offers[offerIndex];
    if (!offer) throw new GameError('BAD_ARGUMENT', `no offer at index ${offerIndex}`);
    const responderPl = this.players[responder];
    const offererPl = this.players[this.trade.from];
    if (!this._hasCards(responderPl.hand, offer.want)) throw new GameError('BAD_TRADE', 'responder does not hold the wanted card');
    if (!this._hasCards(offererPl.hand, offer.give)) throw new GameError('BAD_TRADE', 'offerer no longer holds the offered cards');
    this._takeCards(responderPl.hand, offer.want);
    this._takeCards(offererPl.hand, offer.give);
    for (const c of offer.give) responderPl.hand.push(c);
    offererPl.hand.push(offer.want);
    const responseEvent = { type: 'tradeResponse', player: responder, accepted: offerIndex };
    this.log.push(responseEvent);
    this.log.push({
      type: 'trade', from: this.trade.from, to: responder, give: offer.give, want: offer.want,
    });
    this.trade = null;
    this.phase = 'main';
    return responseEvent;
  }

  cancelTrade() {
    this._requirePhase('trade');
    const event = { type: 'cancelTrade', player: this.trade.from };
    this.log.push(event);
    this.trade = null;
    this.phase = 'main';
    return event;
  }

  // PlayerSelect.nextPlayer() driven from S's "kovetkezo" button.
  endTurn() {
    if (this.phase === 'setup') {
      const pl = this.players[this.current];
      // Both free pieces must be placed -- unless there is nowhere legal to
      // put one (e.g. every edge around the new settlement already carries an
      // opponent's road). Then the piece is forfeited instead of deadlocking
      // the game; the original had no check at all here.
      if (pl.supply.settlement !== 0 && this.legalSettlements(this.current).length > 0) {
        throw new GameError('SETUP_INCOMPLETE', 'place your free settlement before ending your setup turn');
      }
      if (pl.supply.roads !== 0 && this.legalRoads(this.current).length > 0) {
        throw new GameError('SETUP_INCOMPLETE', 'place your free road before ending your setup turn');
      }
      if (pl.supply.settlement !== 0 || pl.supply.roads !== 0) {
        this.log.push({
          type: 'forfeit', player: this.current, settlement: pl.supply.settlement, roads: pl.supply.roads,
        });
        pl.supply.settlement = 0;
        pl.supply.roads = 0;
      }
    } else if (this.phase !== 'main') {
      throw new GameError('WRONG_PHASE', `cannot end turn in phase '${this.phase}'`);
    }
    this.turnNumber++;
    this._advanceTurn();
    return this.log[this.log.length - 1];
  }

  // Task item 8 ("game over must not cover the board; play can go on"):
  // like the original applet, the win is announced but the table stays
  // playable. Legal only in phase 'gameOver'; hands the turn back to the
  // winner (whose turn it already was -- nothing else can run in
  // 'gameOver', so `current` cannot have moved) and resumes normal play.
  // `winner` stays set and `_checkWinner()` (see above) never fires again,
  // so no matter how many more times this player reaches >=10 VP, only the
  // original 'gameOver' log entry ever exists -- this only logs 'continue'.
  continueGame() {
    this._requirePhase('gameOver');
    this.current = this.winner;
    this.phase = 'main';
    const event = { type: 'continue', winner: this.winner };
    this.log.push(event);
    return event;
  }
}

// ---------------------------------------------------------------------
// Tutorial / test affordances (docs/TUTORIAL-DESIGN.md section 3). They are
// deliberate back doors used by lessons and tests, never by the UI proper.
// Every use is logged as a 'tutorial' event so a game log stays honest.

Game.prototype.forceNextRoll = function forceNextRoll(dice) {
  if (!Array.isArray(dice) || dice.length !== 2 || dice.some((d) => !Number.isInteger(d) || d < 1 || d > 6)) {
    throw new GameError('BAD_ARGUMENT', 'forceNextRoll expects [d1, d2] with 1..6');
  }
  this._forcedRoll = [dice[0], dice[1]];
  this.log.push({ type: 'tutorial', op: 'forceNextRoll', dice: dice.slice() });
};

Game.prototype.giveCards = function giveCards(player, letters) {
  const pl = this.players[player];
  if (!pl) throw new GameError('BAD_ARGUMENT', `no player ${player}`);
  if (this.phase === 'gameOver') throw new GameError('WRONG_PHASE', 'game is over');
  for (const c of letters) {
    if (!RESOURCES.includes(c)) throw new GameError('BAD_ARGUMENT', `bad resource '${c}'`);
    pl.hand.push(c);
  }
  this.log.push({ type: 'tutorial', op: 'giveCards', player, cards: letters });
};

Game.prototype.takeCards = function takeCards(player, letters) {
  const pl = this.players[player];
  if (!pl) throw new GameError('BAD_ARGUMENT', `no player ${player}`);
  if (!this._hasCards(pl.hand, letters)) throw new GameError('NO_CARDS', 'cards not in hand');
  this._takeCards(pl.hand, letters);
  this.log.push({ type: 'tutorial', op: 'takeCards', player, cards: letters });
};

// Move one development card of the given type to the end of the deck, i.e.
// make it the next card drawn. Throws NO_CARDS if none is left in the deck.
Game.prototype.setDevDeckTop = function setDevDeckTop(res) {
  const i = this.devDeck.lastIndexOf(res);
  if (i === -1) throw new GameError('NO_CARDS', `no '${res}' left in the development deck`);
  this.devDeck.splice(i, 1);
  this.devDeck.push(res);
  this.log.push({ type: 'tutorial', op: 'setDevDeckTop', res });
};

Game.prototype.setComputer = function setComputer(player, comp) {
  const pl = this.players[player];
  if (!pl) throw new GameError('BAD_ARGUMENT', `no player ${player}`);
  pl.comp = !!comp;
  this.log.push({ type: 'tutorial', op: 'setComputer', player, comp: pl.comp });
};

// placed.* uses English plurals: 'cities', not `${kind}s` -- the old
// 'citys' key read undefined, so the 4-city limit was never enforced
// (found by the fuzz test on seeds beyond the 40 it runs).
const PLACED_KEY = { road: 'roads', settlement: 'settlements', city: 'cities' };
function pieceKeys(kind) {
  if (kind === 'road') return { placedKey: PLACED_KEY.road, supplyKey: 'roads', maxStock: 2 };
  return { placedKey: PLACED_KEY[kind], supplyKey: kind, maxStock: 1 };
}

// Pakli.shuffle(): Fisher-Yates-ish riffle using rng.nextInt(nCards) each step.
function shuffleDevDeck(rng) {
  const cards = DEV_DECK.split('');
  for (let i = 0; i < cards.length; i++) {
    const r = rng.nextInt(cards.length);
    const tmp = cards[i];
    cards[i] = cards[r];
    cards[r] = tmp;
  }
  return cards;
}

export function createGame(opts) {
  return new Game(opts);
}
