// Multiplayer session: one host (authoritative) and any number of clients,
// all replicating the same world (src/net/world.js) in lockstep.
//
// Flow (docs/HALOZAT.md):
//   lobby    host.open() -> code; clients dial, send hello, get a seat;
//            host.start() fills the empty human seats with the AI and
//            broadcasts { config }.
//   play     a client applies its own action locally first (its state is
//            identical to the host's whenever it is the actor), sends
//            act{seq, entry}; the host validates authority + legality,
//            appends, and broadcasts applied{seq, entry, hash} to everyone
//            (the sender sees its own echo and just confirms it). The host's
//            own actions and every AI step take the same path without the
//            round trip. A rejected or out-of-order action makes the client
//            rebuild from the host's log (resync) -- the host's log is the
//            only truth.
//   drop     a client that vanishes mid-game keeps its seat, and the AI
//            plays it (setComputer) until the same token reconnects, which
//            hands it back.
//
// Nothing here touches the DOM or a real timer directly: `timers` is
// injectable so tests drive heartbeats with a fake clock.

import { Emitter } from './emitter.js';
import {
  PROTOCOL_VERSION, validateMessage, makeRoomCode, cleanName, MAX_NAME, MAX_CHAT_LINES, MAX_CHAT_TEXT, cleanTalk,
} from './protocol.js';
import {
  createWorld, replay, applyEntry, stateHash, validateEntry, validateConfig,
} from './world.js';
import { createAI } from '../engine/ai.js';

const HELLO_TIMEOUT_MS = 8000;
const HEARTBEAT_MISSES = 3;

function defaultTimers() {
  return {
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (...a) => globalThis.clearTimeout(...a),
    setInterval: (...a) => globalThis.setInterval(...a),
    clearInterval: (...a) => globalThis.clearInterval(...a),
  };
}

function randomToken() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 16; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function errorInfo(err) {
  return { code: (err && err.code) || 'ERROR', message: String((err && err.message) || err) };
}

// ---------------------------------------------------------------- shared base

class Session extends Emitter {
  constructor(role, { aiFactory = createAI, timers } = {}) {
    super();
    this.role = role;
    this.aiFactory = aiFactory;
    this.timers = timers || defaultTimers();
    this.game = null;
    this.ai = null;
    this.config = null;
    this.entries = [];
    this.mySeat = null;
    this.localSeats = new Set();
    this.started = false;
    this.closed = false;
    this.desynced = false;
    this.code = null;
  }

  hash() { return this.game ? stateHash(this.game) : null; }

  get names() { return this.config && this.config.names ? this.config.names.slice() : []; }

  nameOf(seat) {
    const n = this.config && this.config.names && this.config.names[seat - 1];
    return n || `${seat}.`;
  }

  // Replaces the world with one rebuilt from (config, entries). Throws if
  // the log is not replayable.
  _rebuild(config, entries) {
    const world = replay(config, entries, this.aiFactory);
    this.game = world.game;
    this.ai = world.ai;
    this.config = config;
    this.entries = entries.map((e) => ({ ...e }));
  }

  _applyLocal(entry) {
    const ev = applyEntry(this.game, this.ai, entry);
    this.entries.push(entry);
    return ev;
  }

  status() {
    return {
      role: this.role,
      code: this.code,
      started: this.started,
      closed: this.closed,
      desynced: this.desynced,
      seq: this.entries.length,
      hash: this.hash(),
      mySeat: this.mySeat,
      localSeats: [...this.localSeats],
      pending: this.pending ? this.pending.size : 0,
    };
  }
}

// ---------------------------------------------------------------- host

export function createHostSession(opts) {
  const {
    transport, name, numPlayers = 4, beginner = 1, seed, hostSeat = 1,
    heartbeatMs = 0,
  } = opts;
  const s = new Session('host', opts);
  s.transport = transport;
  s.seatCount = numPlayers;
  s.beginner = beginner;
  s.seed = seed;
  s.hostSeat = hostSeat;
  s.mySeat = hostSeat;
  s.localSeats = new Set([hostSeat]);
  s.peers = new Map(); // peer object -> { name, token, seat }
  s.seats = []; // 1-based: { seat, name, comp, host, peer|null, token|null, connected, autoComp }
  s.ended = null;
  // Bot chat lines written by this host's LLM (cosmetic, outside the
  // lockstep log): kept so a late or returning player gets the history.
  s.chatLines = [];
  // Players' chat messages and the bots' answers, numbered by the host (n)
  // and anchored to the game log length when they were written, so every
  // page interleaves them with the log-derived bot lines the same way.
  s.talk = [];
  let talkN = 0;
  let heartbeat = null;
  let pingN = 0;

  function initSeats(n) {
    s.seatCount = n;
    const old = s.seats;
    s.seats = [null];
    for (let i = 1; i <= n; i++) {
      const prev = old[i];
      if (prev) { s.seats.push(prev); continue; }
      s.seats.push({
        seat: i, name: i === hostSeat ? cleanName(name, `${i}.`) : '', comp: i !== hostSeat, host: i === hostSeat,
        peer: null, token: null, connected: i === hostSeat, autoComp: false, persona: '',
      });
    }
    // Seats that no longer exist lose their peers (refused on next lobby).
    for (let i = n + 1; i < old.length; i++) {
      const st = old[i];
      if (st && st.peer) { send(st.peer, { t: 'refuse', code: 'ROOM_SHRUNK', message: 'the host reduced the player count' }); st.peer.close(); }
    }
  }
  initSeats(numPlayers);

  function send(peer, msg) {
    if (!peer || !peer.open) return;
    try { peer.send(msg); } catch (err) { console.warn('send failed:', err); }
  }

  function broadcast(msg) {
    for (const peer of s.peers.keys()) send(peer, msg);
  }

  function lobbyMessage() {
    return {
      t: 'lobby',
      seats: s.seats.slice(1).map((st) => ({
        seat: st.seat, name: st.name, comp: st.comp, host: st.host, taken: !!(st.host || st.peer), connected: st.connected, autoComp: !!st.autoComp, persona: st.persona || '',
      })),
      config: { numPlayers: s.seatCount, beginner: s.beginner, started: s.started },
    };
  }

  function broadcastLobby() {
    const msg = lobbyMessage();
    broadcast(msg);
    s.emit('lobby', msg);
  }

  function buildConfig() {
    const computer = [];
    const names = [];
    const personas = [];
    for (let i = 1; i <= s.seatCount; i++) {
      const st = s.seats[i];
      computer.push(!!st.comp);
      names.push(st.name || (st.comp ? '' : `${i}.`));
      personas.push(st.persona || '');
    }
    return {
      numPlayers: s.seatCount, beginner: s.beginner, seed: s.seed, computer, names, personas,
    };
  }

  function freeHumanSeat() {
    for (let i = 1; i <= s.seatCount; i++) {
      const st = s.seats[i];
      if (!st.host && !st.comp && !st.peer) return st;
    }
    return null;
  }

  function seatOfPeer(peer) {
    const info = s.peers.get(peer);
    return info && info.seat ? s.seats[info.seat] : null;
  }

  function dropPeer(peer, reason) {
    const info = s.peers.get(peer);
    if (!info) return;
    s.peers.delete(peer);
    const st = info.seat ? s.seats[info.seat] : null;
    if (st && st.peer === peer) {
      st.peer = null;
      st.connected = false;
      if (!s.started) {
        // In the lobby a vanished joiner simply frees the seat.
        st.name = '';
        st.token = null;
      } else if (!s.closed && s.game && s.game.phase !== 'gameOver' && !st.comp) {
        // Mid-game the computer plays the seat until the player comes back
        // with their token (onHello hands it back).
        st.comp = true;
        st.autoComp = true;
        commit({ kind: 'call', player: 0, call: { method: 'setComputer', params: [st.seat, true] } });
      }
      s.emit('peer', { seat: st.seat, connected: false, name: st.name, reason });
    }
    broadcastLobby();
  }

  function commit(entry, { local = true } = {}) {
    const ev = s._applyLocal(entry);
    const seq = s.entries.length - 1;
    const hash = s.hash();
    broadcast({ t: 'applied', seq, entry, hash });
    s.emit('applied', { seq, entry, ev, hash, local });
    return { ok: true, ev, seq, hash };
  }

  function onHello(peer, msg) {
    const info = s.peers.get(peer);
    if (!info) return;
    if (info.helloed) return; // a second hello on the same connection changes nothing
    if (msg.v !== PROTOCOL_VERSION) {
      send(peer, { t: 'refuse', code: 'VERSION', message: `protocol ${PROTOCOL_VERSION} required` });
      peer.close();
      return;
    }
    const wantName = cleanName(msg.name, '');
    // Reconnect: a token we know. If its seat still looks attached (a page
    // reload whose goodbye never arrived, a connection the heartbeat has not
    // given up on yet), the new connection replaces the stale one.
    let st = null;
    if (msg.token) {
      for (let i = 1; i <= s.seatCount; i++) {
        const cand = s.seats[i];
        if (!cand.host && cand.token === msg.token) { st = cand; break; }
      }
      if (st && st.peer && st.peer !== peer) {
        const old = st.peer;
        s.peers.delete(old);
        st.peer = null;
        try { old.close(); } catch { /* ignore */ }
      }
    }
    if (!st) {
      if (s.started) {
        send(peer, { t: 'refuse', code: 'GAME_STARTED', message: 'the game has already started' });
        peer.close();
        return;
      }
      st = freeHumanSeat();
      if (!st) {
        send(peer, { t: 'refuse', code: 'ROOM_FULL', message: 'no free seat' });
        peer.close();
        return;
      }
      st.token = msg.token || randomToken();
    }
    st.peer = peer;
    st.connected = true;
    if (wantName || !st.name) st.name = wantName || `${st.seat}.`;
    info.seat = st.seat;
    info.name = st.name;
    info.token = st.token;
    info.helloed = true;
    send(peer, { t: 'welcome', peerId: String(peer.id || 'peer'), seat: st.seat, token: st.token });
    if (s.started) {
      send(peer, { t: 'start', config: s.config, entries: s.entries, hash: s.hash() });
      if (s.chatLines.length) send(peer, { t: 'chat', lines: s.chatLines.slice() });
      if (s.talk.length) send(peer, { t: 'talk', lines: s.talk.slice() });
      // The seat was handed to the AI while they were away: give it back.
      if (st.autoComp && s.game.phase !== 'gameOver') {
        st.autoComp = false;
        st.comp = false;
        commit({ kind: 'call', player: 0, call: { method: 'setComputer', params: [st.seat, false] } });
      }
    }
    s.emit('peer', { seat: st.seat, connected: true, name: st.name });
    broadcastLobby();
  }

  function onAct(peer, msg) {
    const st = seatOfPeer(peer);
    const reject = (code, message, resync = true) => {
      send(peer, { t: 'reject', seq: msg.seq, code, message });
      if (resync && s.started) send(peer, { t: 'resync', config: s.config, entries: s.entries, hash: s.hash() });
    };
    if (!st) { reject('NO_SEAT', 'you have no seat', false); return; }
    if (!s.started || !s.game) { reject('NOT_STARTED', 'the game has not started', false); return; }
    const entry = msg.entry;
    const shapeErr = validateEntry(entry, { hostOnly: false });
    if (shapeErr) { reject('BAD_ENTRY', shapeErr); return; }
    if (entry.kind !== 'call') { reject('NOT_ALLOWED', 'clients cannot drive the AI'); return; }
    if (msg.seq !== s.entries.length) { reject('STALE', `expected seq ${s.entries.length}, got ${msg.seq}`); return; }
    if (entry.player !== st.seat) { reject('NOT_YOUR_SEAT', `seat ${st.seat} cannot act as ${entry.player}`); return; }
    if (st.comp) { reject('SEAT_IS_COMPUTER', 'your seat is currently played by the computer'); return; }
    if (s.game.actor() !== st.seat) { reject('NOT_YOUR_TURN', `actor is ${s.game.actor()}`); return; }
    try {
      commit({ kind: 'call', player: st.seat, call: { method: entry.call.method, params: entry.call.params } }, { local: false });
    } catch (err) {
      const info = errorInfo(err);
      reject(info.code, info.message);
    }
  }

  function onMessage(peer, raw) {
    if (s.closed) return;
    const msg = validateMessage(raw);
    if (!msg) { s.emit('badMessage', { peer: peer.id, raw }); return; }
    const info = s.peers.get(peer);
    if (!info) return;
    if (msg.t === 'hello') { onHello(peer, msg); return; }
    if (!info.helloed) return; // nothing else is accepted before hello
    switch (msg.t) {
      case 'act': onAct(peer, msg); break;
      case 'pong': info.missed = 0; break;
      case 'sync':
        if (s.started) send(peer, { t: 'resync', config: s.config, entries: s.entries, hash: s.hash() });
        break;
      case 'say': {
        // Only a seated player, at most one message a second and 10 per
        // 30 seconds; anything faster is dropped silently.
        const st = seatOfPeer(peer);
        if (!st || !s.started) break;
        const now = s.timers.now ? s.timers.now() : Date.now();
        info.says = (info.says || []).filter((tm) => now - tm < 30000);
        if (info.says.length >= 10 || (info.says.length && now - info.says[info.says.length - 1] < 1000)) break;
        info.says.push(now);
        s.addTalk({ seat: st.seat, text: msg.text });
        break;
      }
      default: break; // client-only message types are ignored on the host
    }
  }

  function onConnection(peer) {
    if (s.closed) { peer.close(); return; }
    const info = { name: '', token: null, seat: 0, helloed: false, missed: 0 };
    s.peers.set(peer, info);
    const helloTimer = s.timers.setTimeout(() => {
      if (!info.helloed && peer.open) { peer.close(); }
    }, HELLO_TIMEOUT_MS);
    peer.on('message', (m) => onMessage(peer, m));
    peer.on('close', () => { s.timers.clearTimeout(helloTimer); dropPeer(peer, 'closed'); });
  }

  function startHeartbeat() {
    if (!heartbeatMs || heartbeat) return;
    heartbeat = s.timers.setInterval(() => {
      for (const [peer, info] of s.peers) {
        if (!info.helloed) continue;
        if (info.missed >= HEARTBEAT_MISSES) { peer.close(); continue; }
        info.missed++;
        send(peer, { t: 'ping', n: ++pingN });
      }
    }, heartbeatMs);
  }

  // ------------------------------------------------------------ public API

  s.open = async (code) => {
    s.code = code || makeRoomCode();
    transport.on('connection', onConnection);
    await transport.listen(s.code);
    startHeartbeat();
    broadcastLobby();
    return s.code;
  };

  s.lobby = () => lobbyMessage();

  s.setNumPlayers = (n) => {
    if (s.started) throw new Error('game already started');
    if (!Number.isInteger(n) || n < 3 || n > 6) throw new Error('numPlayers must be 3..6');
    initSeats(n);
    if (s.beginner > n) s.beginner = 1;
    broadcastLobby();
  };

  s.setSeatComputer = (seat, comp) => {
    if (s.started) throw new Error('game already started');
    const st = s.seats[seat];
    if (!st || st.host) return;
    if (comp && st.peer) { send(st.peer, { t: 'refuse', code: 'SEAT_TAKEN_BY_AI', message: 'the host gave this seat to the computer' }); st.peer.close(); }
    st.comp = !!comp;
    if (comp) { st.name = ''; st.token = null; st.peer = null; st.connected = false; }
    broadcastLobby();
  };

  // The chat personality of a seat ('' = random), lobby only. Cosmetic: it
  // travels in the config so every page shows the same bots.
  s.setSeatPersona = (seat, persona) => {
    if (s.started) throw new Error('game already started');
    const st = s.seats[seat];
    if (!st || typeof persona !== 'string' || !/^[a-z]{0,16}$/.test(persona)) return;
    st.persona = persona;
    broadcastLobby();
  };

  s.setBeginner = (b) => {
    if (s.started) throw new Error('game already started');
    if (!Number.isInteger(b) || b < 1 || b > s.seatCount) throw new Error('bad beginner');
    s.beginner = b;
    broadcastLobby();
  };

  s.setHostName = (n) => { s.seats[hostSeat].name = cleanName(n, `${hostSeat}.`); broadcastLobby(); };

  // Starts (or restarts, with a new seed) the game with the seats as they
  // are: every human seat nobody has joined is played by the computer.
  // Adds (or replaces) one LLM-written chat line and sends it to everyone.
  // Returns false for a malformed line.
  s.addChat = (line) => {
    const l = line && { idx: line.idx, seat: line.seat, text: line.text, lang: line.lang };
    if (!validateMessage({ t: 'chat', lines: [l] })) return false;
    const i = s.chatLines.findIndex((x) => x.idx === l.idx && x.seat === l.seat);
    if (i >= 0) s.chatLines[i] = l; else s.chatLines.push(l);
    while (s.chatLines.length > MAX_CHAT_LINES) s.chatLines.shift();
    broadcast({ t: 'chat', lines: [l] });
    s.emit('chat', { lines: [l] });
    return true;
  };

  // A player's message or a bot's answer, numbered and sent to everyone.
  s.addTalk = ({ seat, text, bot = false, persona }) => {
    // A player writes at most 200 characters; a bot's (LLM) answer may run
    // to two sentences.
    const t = cleanTalk(text, bot ? MAX_CHAT_TEXT : undefined);
    if (!t || !Number.isInteger(seat) || seat < 1 || seat > 6) return null;
    const line = { n: talkN++, seat, anchor: s.game ? s.game.log.length : 0, text: t, bot: !!bot };
    if (bot && typeof persona === 'string' && /^[a-z]{1,16}$/.test(persona)) line.persona = persona;
    s.talk.push(line);
    while (s.talk.length > MAX_CHAT_LINES) s.talk.shift();
    broadcast({ t: 'talk', lines: [line] });
    s.emit('talk', { lines: [line] });
    return line;
  };
  s.say = (text) => s.addTalk({ seat: s.mySeat, text });

  s.start = (newSeed) => {
    if (newSeed !== undefined) s.seed = newSeed;
    if (!Number.isFinite(Number(s.seed))) s.seed = Date.now();
    s.seed = Math.trunc(Number(s.seed));
    for (let i = 1; i <= s.seatCount; i++) {
      const st = s.seats[i];
      if (!st.host && !st.peer) { st.comp = true; st.name = ''; st.token = null; st.autoComp = false; }
      if (st.host) st.comp = false; // a new game starts with the host playing again
      // A seat whose player is merely disconnected keeps its token (reconnect).
    }
    const config = buildConfig();
    const err = validateConfig(config);
    if (err) throw new Error(err);
    const world = createWorld(config, s.aiFactory);
    s.game = world.game;
    s.ai = world.ai;
    s.config = config;
    s.entries = [];
    s.started = true;
    s.desynced = false;
    s.chatLines = [];
    s.talk = [];
    const hash = s.hash();
    broadcast({ t: 'start', config, entries: [], hash });
    broadcastLobby();
    s.emit('start', { config, hash });
    return config;
  };

  // Applies one entry authored on the host (its own seat's action or an
  // AI step) and broadcasts it. Returns { ok, ev } or { ok:false, error }.
  s.submit = (entry) => {
    if (!s.started || !s.game || s.closed) return { ok: false, error: { code: 'NOT_STARTED', message: 'no game' } };
    const shapeErr = validateEntry(entry, { hostOnly: true });
    if (shapeErr) return { ok: false, error: { code: 'BAD_ENTRY', message: shapeErr } };
    // The host may also press "continue" for a computer winner (nobody else
    // can act for that seat); every other call must be the host's own.
    const actingForAi = entry.kind === 'call' && entry.call.method === 'continueGame'
      && s.game.players[entry.player] && s.game.players[entry.player].comp && s.game.actor() === entry.player;
    if (entry.kind === 'call' && entry.call.method !== 'setComputer' && !actingForAi) {
      if (entry.player !== hostSeat) return { ok: false, error: { code: 'NOT_YOUR_SEAT', message: `host is seat ${hostSeat}` } };
      if (s.game.actor() !== hostSeat) return { ok: false, error: { code: 'NOT_YOUR_TURN', message: `actor is ${s.game.actor()}` } };
    }
    try {
      return commit(entry);
    } catch (err) {
      return { ok: false, error: errorInfo(err) };
    }
  };

  // Hands a (dropped) human seat to the computer for the rest of the game,
  // or until that player reconnects with their token.
  s.handSeatToComputer = (seat) => {
    const st = s.seats[seat];
    if (!st || st.host || !s.started || st.comp) return { ok: false, error: { code: 'BAD_ARGUMENT', message: 'not a human seat' } };
    if (st.peer) { send(st.peer, { t: 'refuse', code: 'SEAT_TAKEN_BY_AI', message: 'the host handed your seat to the computer' }); st.peer.close(); }
    st.comp = true;
    st.autoComp = true;
    const r = s.submit({ kind: 'call', player: 0, call: { method: 'setComputer', params: [seat, true] } });
    broadcastLobby();
    return r;
  };

  // The host's own seat played by the computer (comp = true) or by the host
  // again (false). The host stays the table: it still numbers the entries
  // and drives every computer seat, its own included.
  s.setOwnSeatComputer = (comp) => {
    const st = s.seats[hostSeat];
    if (!s.started || s.closed || !s.game) return { ok: false, error: { code: 'NOT_STARTED', message: 'no game' } };
    if (s.game.phase === 'gameOver') return { ok: false, error: { code: 'WRONG_PHASE', message: 'the game is over' } };
    if (!!s.game.players[hostSeat].comp === !!comp) return { ok: true };
    const r = s.submit({ kind: 'call', player: 0, call: { method: 'setComputer', params: [hostSeat, !!comp] } });
    if (r.ok) { st.comp = !!comp; broadcastLobby(); }
    return r;
  };

  s.peerSeats = () => s.seats.slice(1).map((st) => ({
    seat: st.seat, name: st.name, comp: st.comp, host: st.host, connected: st.connected, autoComp: st.autoComp, persona: st.persona || '',
  }));

  s.close = (reason = 'host left') => {
    if (s.closed) return;
    s.closed = true;
    if (heartbeat) { s.timers.clearInterval(heartbeat); heartbeat = null; }
    broadcast({ t: 'end', reason });
    for (const peer of s.peers.keys()) peer.close();
    s.peers.clear();
    try { transport.close(); } catch { /* ignore */ }
    s.emit('closed', { reason });
  };

  return s;
}

// ---------------------------------------------------------------- client

export function createClientSession(opts) {
  const {
    transport, code, name, token, heartbeatMs = 0,
  } = opts;
  const s = new Session('client', opts);
  s.transport = transport;
  s.code = code;
  s.token = token || randomToken();
  s.name = cleanName(name, '');
  s.peer = null;
  s.lobbyState = null;
  s.pending = new Map(); // seq -> entry we applied optimistically
  s.chatLines = []; // bot chat lines from the host's LLM (see host addChat)
  s.talk = []; // players' messages and bots' answers, from the host (see host addTalk)
  s.lastReject = null;
  let watchdog = null;
  let lastPingAt = 0;

  function send(msg) {
    if (!s.peer || !s.peer.open) return false;
    try { s.peer.send(msg); return true; } catch (err) { console.warn('send failed:', err); return false; }
  }

  function requestSync() { send({ t: 'sync' }); }
  // A chat message; it shows up once the host sends it back numbered.
  s.say = (text) => { const t = cleanTalk(text); return t ? send({ t: 'say', text: t }) : false; };

  function adopt(config, entries, hash, eventName) {
    const cfgErr = validateConfig(config);
    if (cfgErr) { fail('BAD_CONFIG', cfgErr); return false; }
    for (let i = 0; i < entries.length; i++) {
      const e = validateEntry(entries[i], { hostOnly: true });
      if (e) { fail('BAD_LOG', `entry ${i}: ${e}`); return false; }
    }
    try {
      s._rebuild(config, entries);
    } catch (err) {
      fail('REPLAY_FAILED', String(err && err.message));
      return false;
    }
    s.pending.clear();
    s.started = true;
    const mine = s.hash();
    if (mine !== hash) {
      s.desynced = true;
      s.emit('desync', { expected: hash, actual: mine, where: eventName });
      return false;
    }
    s.desynced = false;
    s.emit(eventName, { config, hash });
    return true;
  }

  function fail(code, message) {
    s.emit('error', { code, message });
  }

  function onApplied(msg) {
    if (!s.started || !s.game) return;
    const seq = msg.seq;
    const entryErr = validateEntry(msg.entry, { hostOnly: true });
    if (entryErr) { fail('BAD_ENTRY', entryErr); requestSync(); return; }
    if (seq < s.entries.length) {
      // Echo of something already applied here: our own optimistic entry, or
      // a duplicate. Confirm it matches the host's version.
      const mine = s.entries[seq];
      const same = JSON.stringify(mine) === JSON.stringify(msg.entry);
      const wasPending = s.pending.has(seq);
      s.pending.delete(seq);
      if (!same || (seq === s.entries.length - 1 && s.hash() !== msg.hash)) {
        s.desynced = true;
        s.emit('desync', { seq, expected: msg.hash, actual: s.hash(), where: 'echo' });
        requestSync();
        return;
      }
      s.emit('confirmed', { seq, entry: mine, optimistic: wasPending });
      return;
    }
    if (seq > s.entries.length) {
      // A gap: something was lost. Rebuild from the host.
      requestSync();
      return;
    }
    let ev;
    try {
      ev = s._applyLocal(msg.entry);
    } catch (err) {
      s.desynced = true;
      s.emit('desync', { seq, error: errorInfo(err), where: 'apply' });
      requestSync();
      return;
    }
    const mine = s.hash();
    if (mine !== msg.hash) {
      s.desynced = true;
      s.emit('desync', { seq, expected: msg.hash, actual: mine, where: 'hash' });
      requestSync();
      return;
    }
    s.emit('applied', { seq, entry: msg.entry, ev, hash: mine, local: false });
  }

  function onReject(msg) {
    s.lastReject = { seq: msg.seq, code: msg.code, message: msg.message || '' };
    // Undo the optimistic entry (and anything after it) right away; the
    // host's resync that usually follows is then a no-op.
    if (s.pending.has(msg.seq) && s.config) {
      const keep = s.entries.slice(0, msg.seq);
      try { s._rebuild(s.config, keep); } catch { /* the resync will fix it */ }
      s.pending.clear();
    }
    s.emit('rejected', s.lastReject);
  }

  function onMessage(raw) {
    if (s.closed) return;
    const msg = validateMessage(raw);
    if (!msg) { s.emit('badMessage', { raw }); return; }
    switch (msg.t) {
      case 'welcome':
        s.mySeat = msg.seat;
        s.localSeats = new Set(msg.seat ? [msg.seat] : []);
        s.token = msg.token || s.token;
        s.emit('welcome', { seat: msg.seat });
        break;
      case 'refuse':
        s.emit('refused', { code: msg.code, message: msg.message || '' });
        break;
      case 'lobby':
        s.lobbyState = { seats: msg.seats, config: msg.config };
        s.emit('lobby', s.lobbyState);
        break;
      case 'start':
        s.chatLines = [];
        s.talk = [];
        adopt(msg.config, msg.entries, msg.hash, 'start');
        break;
      case 'talk':
        for (const l of msg.lines) {
          const clean = { n: l.n, seat: l.seat, anchor: l.anchor, text: l.text, bot: !!l.bot };
          const i = s.talk.findIndex((x) => x.n === l.n);
          if (i >= 0) s.talk[i] = clean; else s.talk.push(clean);
        }
        s.talk.sort((a, b) => a.n - b.n);
        while (s.talk.length > MAX_CHAT_LINES) s.talk.shift();
        s.emit('talk', { lines: msg.lines });
        break;
      case 'chat':
        for (const l of msg.lines) {
          const i = s.chatLines.findIndex((x) => x.idx === l.idx && x.seat === l.seat);
          const clean = { idx: l.idx, seat: l.seat, text: l.text, lang: l.lang };
          if (i >= 0) s.chatLines[i] = clean; else s.chatLines.push(clean);
        }
        while (s.chatLines.length > MAX_CHAT_LINES) s.chatLines.shift();
        s.emit('chat', { lines: msg.lines });
        break;
      case 'resync':
        if (s.started && !s.desynced && s.pending.size === 0 && s.hash() === msg.hash && s.entries.length === msg.entries.length) {
          s.emit('resync', { noop: true });
        } else {
          adopt(msg.config, msg.entries, msg.hash, 'resync');
        }
        break;
      case 'applied': onApplied(msg); break;
      case 'reject': onReject(msg); break;
      case 'end':
        s.emit('closed', { reason: msg.reason });
        s.close();
        break;
      case 'ping':
        lastPingAt = Date.now();
        send({ t: 'pong', n: msg.n });
        break;
      default: break;
    }
  }

  s.join = () => new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn) => { if (settled) return; settled = true; if (timer !== null) s.timers.clearTimeout(timer); fn(); };
    // The transport's own dial has its own timeout (PeerJS: the signalling
    // server; BroadcastChannel: 1.5 s); the hello->welcome clock only starts
    // once a peer exists, so a slow WebRTC handshake is not double-counted.
    transport.dial(code).then((peer) => {
      s.peer = peer;
      timer = s.timers.setTimeout(() => {
        finish(() => {
          reject(Object.assign(new Error('no answer from the host'), { code: 'TIMEOUT' }));
          s.close();
        });
      }, HELLO_TIMEOUT_MS);
      peer.on('message', onMessage);
      peer.on('close', () => {
        if (!s.closed) { s.closed = true; s.emit('closed', { reason: 'connection lost' }); }
      });
      s.once('welcome', (w) => finish(() => resolve(w)));
      s.once('refused', (r) => finish(() => reject(Object.assign(new Error(r.message || r.code), { code: r.code }))));
      send({ t: 'hello', v: PROTOCOL_VERSION, name: s.name.slice(0, MAX_NAME), token: s.token });
      if (heartbeatMs) {
        lastPingAt = Date.now();
        // Lenient on purpose: a host tab in the background has its timers
        // throttled to once a minute, and nobody can move without the host
        // anyway -- dropping the session over that would only cost a rejoin.
        const tolerance = Math.max(heartbeatMs * (HEARTBEAT_MISSES + 1), 90000);
        watchdog = s.timers.setInterval(() => {
          if (Date.now() - lastPingAt > tolerance) {
            s.emit('closed', { reason: 'host unreachable' });
            s.close();
          }
        }, heartbeatMs);
      }
    }).catch((err) => finish(() => reject(err)));
  });

  // Applies the entry locally (optimistically) and sends it to the host.
  // Returns { ok, ev } or { ok:false, error } for a locally illegal action
  // (which is never sent).
  s.submit = (entry) => {
    if (!s.started || !s.game || s.closed) return { ok: false, error: { code: 'NOT_STARTED', message: 'no game' } };
    const shapeErr = validateEntry(entry, { hostOnly: false });
    if (shapeErr) return { ok: false, error: { code: 'BAD_ENTRY', message: shapeErr } };
    if (entry.kind !== 'call') return { ok: false, error: { code: 'NOT_ALLOWED', message: 'clients cannot drive the AI' } };
    if (!s.localSeats.has(entry.player)) return { ok: false, error: { code: 'NOT_YOUR_SEAT', message: `you are seat ${s.mySeat}` } };
    if (s.game.actor() !== entry.player) return { ok: false, error: { code: 'NOT_YOUR_TURN', message: `actor is ${s.game.actor()}` } };
    if (s.desynced) return { ok: false, error: { code: 'DESYNCED', message: 'waiting for the host to resync' } };
    const seq = s.entries.length;
    let ev;
    try {
      ev = s._applyLocal(entry);
    } catch (err) {
      return { ok: false, error: errorInfo(err) };
    }
    s.pending.set(seq, entry);
    send({ t: 'act', seq, entry });
    const hash = s.hash();
    s.emit('applied', { seq, entry, ev, hash, local: true });
    return { ok: true, ev, seq, hash };
  };

  s.requestSync = requestSync;

  s.close = () => {
    if (s.closed && !s.peer) return;
    s.closed = true;
    if (watchdog) { s.timers.clearInterval(watchdog); watchdog = null; }
    const p = s.peer;
    s.peer = null;
    if (p) { try { p.close(); } catch { /* ignore */ } }
    try { transport.close(); } catch { /* ignore */ }
  };

  return s;
}
