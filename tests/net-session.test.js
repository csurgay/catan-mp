// Multiplayer session over the in-memory transport: lobby, lockstep play
// with random legal moves from every human seat, hash agreement after every
// entry, rejection of illegal/forged/stale actions, message loss, drop +
// hand-over to the AI + reconnect, desync recovery, heartbeats, restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryNetwork } from '../src/net/transports/memory.js';
import { createHostSession, createClientSession } from '../src/net/session.js';
import { replay, stateHash } from '../src/net/world.js';
import { PROTOCOL_VERSION } from '../src/net/protocol.js';
import { Mulberry32 } from '../src/engine/rng.js';
import { legalCalls } from './helpers/legal-calls.js';

async function makeRoom({ numPlayers = 3, humans = 3, seed = 1, hostSeat = 1, heartbeatMs = 0, timers } = {}) {
  const net = createMemoryNetwork();
  const host = createHostSession({
    transport: net.createTransport('host'), name: 'Host', numPlayers, seed, hostSeat, heartbeatMs, timers,
  });
  const code = await host.open('ROOM1');
  // Seats 2..humans are human (joinable); the rest stay computer.
  for (let i = 1; i <= numPlayers; i++) if (i !== hostSeat) host.setSeatComputer(i, i > humans);
  const clients = [];
  for (let i = 2; i <= humans; i++) {
    const c = createClientSession({
      transport: net.createTransport(`c${i}`), code, name: `Player${i}`, heartbeatMs, timers,
    });
    const joined = c.join();
    await net.settle();
    await joined;
    clients.push(c);
  }
  return { net, host, clients, code };
}

function everyone(room) { return [room.host, ...room.clients]; }

// join() that is expected to fail: the rejection is caught right away (the
// memory network delivers the refusal during settle(), before an
// assert.rejects() could attach), and the error is returned.
async function joinExpectingError(client, net) {
  const p = client.join().then(() => null, (err) => err);
  await net.settle();
  const err = await p;
  assert.ok(err, 'join unexpectedly succeeded');
  return err;
}

// Every client already compares its own hash against the host's on every
// applied{} it receives (and flags `desynced`), so the per-step check here
// is cheap; the full hash comparison runs every `deep`-th call (and always
// when deep === true).
let syncCalls = 0;
function assertInSync(room, label = '', deep = 25) {
  const h = room.host;
  syncCalls++;
  const full = deep === true || syncCalls % deep === 0;
  const hostHash = full ? h.hash() : null;
  for (const c of room.clients) {
    assert.equal(c.desynced, false, `${label} client seat ${c.mySeat} desynced`);
    assert.equal(c.entries.length, h.entries.length, `${label} client seat ${c.mySeat} entries`);
    if (full) assert.equal(c.hash(), hostHash, `${label} client seat ${c.mySeat} hash`);
  }
}

function sessionForSeat(room, seat) {
  return everyone(room).find((s) => s.mySeat === seat);
}

// Plays the game out with random legal moves; the host drives the AI.
// Returns the number of entries produced.
function playOut(room, rng, { maxEntries = 4000, everyStep } = {}) {
  const { host, net } = room;
  let n = 0;
  while (host.game.phase !== 'gameOver' && host.entries.length < maxEntries) {
    const g = host.game;
    const actor = g.actor();
    let r;
    if (g.players[actor].comp) {
      r = host.submit({ kind: 'ai' });
    } else {
      const sess = sessionForSeat(room, actor);
      assert.ok(sess, `no session controls seat ${actor}`);
      const calls = legalCalls(sess.game, rng);
      const call = calls[rng.nextInt(calls.length)];
      r = sess.submit({ kind: 'call', player: actor, call });
    }
    assert.ok(r.ok, `entry ${host.entries.length} rejected: ${JSON.stringify(r.error)}`);
    net.flush();
    assertInSync(room, `after entry ${host.entries.length}`);
    if (everyStep) everyStep(host.entries.length);
    n++;
  }
  return n;
}

test('lobby: host opens, clients get seats in order, full room refused, wrong protocol refused', async () => {
  const room = await makeRoom({ numPlayers: 3, humans: 3, seed: 7 });
  const { host, clients, net } = room;
  assert.equal(host.mySeat, 1);
  assert.deepEqual(clients.map((c) => c.mySeat), [2, 3]);
  const lobby = host.lobby();
  assert.deepEqual(lobby.seats.map((s) => [s.seat, s.name, s.comp, s.taken]), [[1, 'Host', false, true], [2, 'Player2', false, true], [3, 'Player3', false, true]]);
  // A 4th joiner: no free seat.
  const extra = createClientSession({ transport: net.createTransport('x'), code: room.code, name: 'Extra' });
  assert.equal((await joinExpectingError(extra, net)).code, 'ROOM_FULL');
  // Wrong protocol version: refused before any seat is touched.
  const badTransport = net.createTransport('bad');
  const peer = await badTransport.dial(room.code);
  const got = [];
  peer.on('message', (m) => got.push(m));
  peer.send({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'Old' });
  await net.settle();
  assert.equal(got[0].t, 'refuse');
  assert.equal(got[0].code, 'VERSION');
  assert.equal(host.lobby().seats.filter((s) => s.taken).length, 3);
  host.close();
});

for (const cfg of [
  { numPlayers: 3, humans: 3, seeds: [1, 2, 3] },
  { numPlayers: 4, humans: 2, seeds: [4, 5] },
  { numPlayers: 6, humans: 4, seeds: [6] },
]) {
  test(`lockstep: ${cfg.numPlayers} players, ${cfg.humans} humans -- hashes agree after every entry, replay equals host`, async () => {
    for (const seed of cfg.seeds) {
      const room = await makeRoom({ numPlayers: cfg.numPlayers, humans: cfg.humans, seed });
      const { host, clients, net } = room;
      host.start();
      net.flush();
      assertInSync(room, 'after start');
      assert.equal(host.config.computer.filter(Boolean).length, cfg.numPlayers - cfg.humans);
      const rng = new Mulberry32(seed * 31);
      const n = playOut(room, rng, { maxEntries: 5000 });
      assert.ok(n > 50, `only ${n} entries`);
      assertInSync(room, 'end', true);
      // Byte-identical worlds, not just equal hashes.
      const hostJson = JSON.stringify(host.game.toJSON());
      for (const c of clients) assert.equal(JSON.stringify(c.game.toJSON()), hostJson);
      // The log alone rebuilds the same world on a fresh machine.
      const rebuilt = replay(host.config, host.entries);
      assert.equal(stateHash(rebuilt.game), host.hash());
      assert.equal(JSON.stringify(rebuilt.game.toJSON()), hostJson);
      for (const c of clients) assert.equal(c.pending.size, 0, 'every optimistic entry was confirmed');
      host.close();
    }
  });
}

test('authority: out-of-turn, forged seat, non-whitelisted method, illegal action -- rejected without changing the world', async () => {
  const room = await makeRoom({ numPlayers: 3, humans: 3, seed: 11 });
  const { host, clients, net } = room;
  host.start();
  net.flush();
  const c2 = clients[0];
  const c3 = clients[1];
  const before = host.hash();
  assert.equal(host.game.actor(), 1);

  // Client-side guard: not my turn -> refused locally, nothing sent.
  const sentBefore = net.stats.sent;
  let r = c2.submit({ kind: 'call', player: 2, call: { method: 'endTurn', params: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NOT_YOUR_TURN');
  assert.equal(net.stats.sent, sentBefore);
  // Client-side guard: forged seat.
  r = c2.submit({ kind: 'call', player: 1, call: { method: 'endTurn', params: [] } });
  assert.equal(r.error.code, 'NOT_YOUR_SEAT');
  // Client-side guard: the AI cannot be driven by a client.
  r = c2.submit({ kind: 'ai' });
  assert.equal(r.error.code, 'NOT_ALLOWED');

  // Raw wire messages that bypass the client's own checks.
  const rejected = [];
  c3.on('rejected', (x) => rejected.push(x));
  const raw = (m) => c3.peer.send(m);
  raw({ t: 'act', seq: host.entries.length, entry: { kind: 'call', player: 1, call: { method: 'endTurn', params: [] } } });
  raw({ t: 'act', seq: host.entries.length, entry: { kind: 'call', player: 3, call: { method: 'endTurn', params: [] } } });
  raw({ t: 'act', seq: host.entries.length, entry: { kind: 'call', player: 3, call: { method: 'giveCards', params: [3, 'kkk'] } } });
  raw({ t: 'act', seq: host.entries.length, entry: { kind: 'call', player: 3, call: { method: 'toJSON', params: [] } } });
  raw({ t: 'act', seq: host.entries.length, entry: { kind: 'ai' } });
  raw({ t: 'act', seq: host.entries.length, entry: { kind: 'call', player: 3, call: { method: 'placeSettlement', params: [JSON.parse('{"__proto__":{"x":1}}')] } } });
  raw({ t: 'applied', seq: 0, entry: { kind: 'ai' }, hash: 'deadbeef' }); // host-only type, ignored
  raw({ nonsense: true });
  raw('just a string');
  net.flush();
  assert.deepEqual(rejected.map((x) => x.code), ['NOT_YOUR_SEAT', 'NOT_YOUR_TURN', 'BAD_ENTRY', 'BAD_ENTRY', 'NOT_ALLOWED', 'BAD_ENTRY']);
  assert.equal(host.hash(), before);
  assert.equal(host.entries.length, 0);
  assertInSync(room, 'authority', true);

  // A legal-looking but illegal action from the actor: host says WRONG_PHASE-ish via the engine.
  const hostRejected = host.submit({ kind: 'call', player: 1, call: { method: 'rollDice', params: [] } });
  assert.equal(hostRejected.ok, false);
  assert.equal(hostRejected.error.code, 'WRONG_PHASE');
  assert.equal(host.hash(), before);
  host.close();
});

test('stale seq from a client: rejected + resynced, client ends up equal to the host', async () => {
  const room = await makeRoom({ numPlayers: 3, humans: 2, seed: 12 });
  const { host, clients, net } = room;
  host.start();
  net.flush();
  const c2 = clients[0];
  // Host plays its whole setup turn.
  const rng = new Mulberry32(5);
  while (host.game.actor() === 1) {
    const calls = legalCalls(host.game, rng);
    assert.ok(host.submit({ kind: 'call', player: 1, call: calls[0] }).ok);
  }
  // Do not deliver those to the client: from its point of view seat 1 is still acting.
  const hostSeq = host.entries.length;
  assert.equal(c2.entries.length, 0);
  // The client's own guard refuses (it thinks it is not its turn); send raw.
  const events = [];
  c2.on('rejected', (x) => events.push(['rejected', x.code]));
  c2.on('resync', (x) => events.push(['resync', !!x.noop]));
  c2.peer.send({ t: 'act', seq: 0, entry: { kind: 'call', player: 2, call: { method: 'endTurn', params: [] } } });
  net.flush();
  assert.deepEqual(events[0], ['rejected', 'STALE']);
  assert.ok(events.some((e) => e[0] === 'resync'));
  assert.equal(c2.entries.length, hostSeq);
  assertInSync(room, 'after stale', true);
  host.close();
});

test('message loss: a dropped applied{} leaves a gap the client closes by resyncing; play continues in sync', async () => {
  const room = await makeRoom({ numPlayers: 4, humans: 2, seed: 13 });
  const { host, clients, net } = room;
  host.start();
  net.flush();
  const c2 = clients[0];
  const rng = new Mulberry32(99);
  // Play a few entries, dropping the first two 'applied' messages headed to the client.
  let dropped = 0;
  for (let i = 0; i < 6; i++) {
    const actor = host.game.actor();
    if (host.game.players[actor].comp) host.submit({ kind: 'ai' });
    else if (actor === 1) host.submit({ kind: 'call', player: 1, call: legalCalls(host.game, rng)[0] });
    else break;
    if (dropped < 2 && net.dropNext((m) => m.t === 'applied')) dropped++;
    net.flush();
  }
  assert.equal(dropped, 2);
  assertInSync(room, 'after gap recovery');
  assert.equal(c2.entries.length, host.entries.length);
  // And the rest of the game still agrees.
  playOut(room, rng, { maxEntries: 400 });
  assertInSync(room, 'end', true);
  host.close();
});

test('the host can let the computer play its own seat, mid-turn, and take it back; a new game resets it', async () => {
  const room = await makeRoom({ numPlayers: 3, humans: 2, seed: 21 });
  const { host, clients, net } = room;
  // Not before the game has started.
  assert.equal(host.setOwnSeatComputer(true).ok, false);
  host.start();
  net.flush();
  const rng = new Mulberry32(11);
  // Advance until it is the host's own turn in the main game.
  while (!(host.game.actor() === 1 && host.game.phase === 'main')) {
    const actor = host.game.actor();
    const r = host.game.players[actor].comp ? host.submit({ kind: 'ai' })
      : sessionForSeat(room, actor).submit({ kind: 'call', player: actor, call: legalCalls(sessionForSeat(room, actor).game, rng)[0] });
    assert.ok(r.ok, JSON.stringify(r.error));
    net.flush();
  }
  // Hand the seat over in the middle of the host's own turn.
  const seqBefore = host.entries.length;
  assert.ok(host.setOwnSeatComputer(true).ok);
  assert.equal(host.game.players[1].comp, true);
  assert.deepEqual(host.entries[seqBefore].call, { method: 'setComputer', params: [1, true] });
  assert.equal(host.peerSeats()[0].comp, true);
  assert.ok(host.setOwnSeatComputer(true).ok, 'asking twice is a no-op');
  assert.equal(host.entries.length, seqBefore + 1);
  net.flush();
  assert.equal(clients[0].game.players[1].comp, true);
  // The computer finishes the host's turn; the client stays in sync.
  let aiSteps = 0;
  while (host.game.actor() === 1 && host.game.phase !== 'gameOver' && aiSteps < 60) { assert.ok(host.submit({ kind: 'ai' }).ok); aiSteps++; }
  assert.ok(aiSteps > 0);
  net.flush();
  assertInSync(room, 'after the computer played the host seat', true);
  // Play on for a while with the host seat on the computer, then take it back.
  playOut(room, rng, { maxEntries: host.entries.length + 120 });
  if (host.game.phase !== 'gameOver') {
    assert.ok(host.setOwnSeatComputer(false).ok);
    assert.equal(host.game.players[1].comp, false);
    net.flush();
    assert.equal(clients[0].game.players[1].comp, false);
    assertInSync(room, 'after taking the seat back', true);
  }
  // A restarted room has the host playing again.
  host.setOwnSeatComputer(true);
  host.start(99);
  net.flush();
  assert.equal(host.game.players[1].comp, false);
  assert.equal(host.config.computer[0], false);
  host.close();
  assert.equal(host.setOwnSeatComputer(false).ok, false, 'not after the room closed');
});

test('drop: the computer takes the seat over at once; reconnecting with the token gets it back, fully replayed', async () => {
  const room = await makeRoom({ numPlayers: 3, humans: 3, seed: 14 });
  const { host, clients, net } = room;
  host.start();
  net.flush();
  const rng = new Mulberry32(7);
  const c3 = clients[1];
  const token = c3.token;
  // Advance until seat 3 is the actor in the main game.
  while (!(host.game.actor() === 3 && host.game.phase !== 'setup')) {
    const actor = host.game.actor();
    const sess = sessionForSeat(room, actor);
    const calls = legalCalls(sess.game, rng);
    const r = host.game.players[actor].comp ? host.submit({ kind: 'ai' }) : sess.submit({ kind: 'call', player: actor, call: calls[rng.nextInt(calls.length)] });
    assert.ok(r.ok);
    net.flush();
  }
  const peerEvents = [];
  host.on('peer', (e) => peerEvents.push(e));
  c3.close();
  net.flush();
  assert.deepEqual(peerEvents[0], { seat: 3, connected: false, name: 'Player3', reason: 'closed' });
  assert.equal(host.game.actor(), 3);
  // The computer took the seat over the moment the player left, with one
  // setComputer entry every peer replays; the host need not do anything.
  assert.equal(host.game.players[3].comp, true);
  const last = host.entries[host.entries.length - 1];
  assert.deepEqual(last.call, { method: 'setComputer', params: [3, true] });
  assert.equal(host.peerSeats()[2].autoComp, true);
  assert.equal(host.handSeatToComputer(3).ok, false, 'already on the computer');
  net.flush();
  assert.equal(clients[0].game.players[3].comp, true);
  assert.equal(clients[0].lobbyState.seats[2].autoComp, true, 'the guests are told it is a stand-in');
  let aiSteps = 0;
  while (host.game.actor() === 3 && host.game.phase !== 'gameOver' && aiSteps < 50) { assert.ok(host.submit({ kind: 'ai' }).ok); aiSteps++; }
  assert.ok(aiSteps > 0);
  net.flush();
  // The remaining client is still in sync through all of this.
  assert.equal(clients[0].hash(), host.hash());
  assert.equal(clients[0].desynced, false);
  // Player 3 comes back with the same token: same seat, full log replayed,
  // and the seat is handed back to a human.
  const back = createClientSession({ transport: net.createTransport('c3b'), code: room.code, name: 'Player3', token });
  const joined = back.join();
  await net.settle();
  const w = await joined;
  assert.equal(w.seat, 3);
  assert.equal(back.started, true);
  assert.equal(back.entries.length, host.entries.length);
  assert.equal(back.hash(), host.hash());
  assert.equal(host.game.players[3].comp, false);
  assert.equal(back.game.players[3].comp, false);
  assert.equal(host.entries[host.entries.length - 1].call.method, 'setComputer');
  room.clients[1] = back;
  // Play on with the returned player.
  playOut(room, rng, { maxEntries: host.entries.length + 300 });
  assertInSync(room, 'after reconnect', true);
  // A stranger (no token) cannot join a started game.
  const stranger = createClientSession({ transport: net.createTransport('s'), code: room.code, name: 'S' });
  assert.equal((await joinExpectingError(stranger, net)).code, 'GAME_STARTED');
  host.close();
});

test('desync recovery: a client whose world was tampered with detects the hash mismatch on its own echo and rebuilds', async () => {
  const room = await makeRoom({ numPlayers: 3, humans: 2, seed: 15 });
  const { host, clients, net } = room;
  host.start();
  net.flush();
  const c2 = clients[0];
  const rng = new Mulberry32(3);
  // Move to seat 2's setup turn.
  while (host.game.actor() !== 2) {
    const actor = host.game.actor();
    const sess = sessionForSeat(room, actor);
    const calls = legalCalls(sess.game, rng);
    const r = host.game.players[actor].comp ? host.submit({ kind: 'ai' }) : sess.submit({ kind: 'call', player: actor, call: calls[0] });
    assert.ok(r.ok);
    net.flush();
  }
  // Tamper: a card appears out of thin air on the client only (a cheat, or a bug).
  c2.game.giveCards(2, 'k');
  const desyncs = [];
  c2.on('desync', (d) => desyncs.push(d));
  const call = legalCalls(c2.game, rng)[0];
  const r = c2.submit({ kind: 'call', player: 2, call });
  assert.ok(r.ok);
  net.flush();
  assert.equal(desyncs.length, 1);
  assert.equal(desyncs[0].where, 'echo');
  // ...and after the resync the client is back to the host's truth.
  assert.equal(c2.desynced, false);
  assertInSync(room, 'after desync', true);
  assert.equal(c2.game.players[2].hand.filter((c) => c === 'k').length, host.game.players[2].hand.filter((c) => c === 'k').length);
  host.close();
});

test('heartbeat with a fake clock: a silent client is dropped after 3 missed pings; a responsive one stays', async () => {
  // Fake timers: we tick manually.
  const intervals = [];
  const timers = {
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: (id) => { intervals[id - 1] = null; },
  };
  const room = await makeRoom({ numPlayers: 3, humans: 3, seed: 16, heartbeatMs: 1000, timers });
  const { host, clients, net } = room;
  const hostBeat = intervals[0];
  assert.equal(hostBeat.ms, 1000);
  const events = [];
  host.on('peer', (e) => events.push(e));
  // Client 3 goes silent: its outgoing link is cut (pongs never arrive).
  net.cut(clients[1].peer);
  for (let i = 0; i < 3; i++) { hostBeat.fn(); net.flush(); }
  assert.equal(events.length, 0, 'not yet');
  hostBeat.fn(); net.flush();
  assert.deepEqual(events.map((e) => [e.seat, e.connected]), [[3, false]]);
  assert.equal(host.lobby().seats[1].connected, true, 'client 2 answered every ping');
  assert.equal(host.lobby().seats[2].taken, false, 'seat 3 is free again in the lobby');
  host.close();
});

test('restart with a new seed rebuilds every client; host close ends every client', async () => {
  const room = await makeRoom({ numPlayers: 3, humans: 3, seed: 17 });
  const { host, clients, net } = room;
  host.start();
  net.flush();
  const rng = new Mulberry32(1);
  playOut(room, rng, { maxEntries: 40 });
  const starts = [];
  for (const c of clients) c.on('start', (e) => starts.push([c.mySeat, e.config.seed]));
  host.start(4242);
  net.flush();
  assert.deepEqual(starts, [[2, 4242], [3, 4242]]);
  assert.equal(host.entries.length, 0);
  assertInSync(room, 'after restart', true);
  assert.equal(host.game.seed, 4242);
  const closed = [];
  for (const c of clients) c.on('closed', (e) => closed.push([c.mySeat, e.reason]));
  host.close('bye');
  net.flush();
  assert.deepEqual(closed, [[2, 'bye'], [3, 'bye']]);
});

test('seat changes in the lobby: shrinking the room refuses the displaced player; a seat given to the AI kicks its occupant', async () => {
  const room = await makeRoom({ numPlayers: 4, humans: 4, seed: 18 });
  const { host, clients, net } = room;
  const refused = [];
  clients[2].on('refused', (r) => refused.push(r.code));
  host.setNumPlayers(3);
  net.flush();
  assert.deepEqual(refused, ['ROOM_SHRUNK']);
  assert.equal(host.lobby().seats.length, 3);
  const refused2 = [];
  clients[1].on('refused', (r) => refused2.push(r.code));
  host.setSeatComputer(3, true);
  net.flush();
  assert.deepEqual(refused2, ['SEAT_TAKEN_BY_AI']);
  host.start();
  net.flush();
  assert.deepEqual(host.config.computer, [false, false, true]);
  assert.deepEqual(host.config.names, ['Host', 'Player2', '']);
  assertInSync({ host, clients: [clients[0]] }, 'lobby changes', true);
  host.close();
});

test('a second hello on the same connection is ignored (no second seat for one peer)', async () => {
  const room = await makeRoom({ numPlayers: 4, humans: 4, seed: 19 });
  const { host, clients, net } = room;
  clients[0].peer.send({ t: 'hello', v: PROTOCOL_VERSION, name: 'Again', token: 'other' });
  net.flush();
  const seats = host.lobby().seats;
  assert.deepEqual(seats.map((x) => x.name), ['Host', 'Player2', 'Player3', 'Player4']);
  assert.equal(seats.filter((x) => x.taken).length, 4);
  host.close();
});

test('join(): the hello timeout only starts once the transport has dialed (a slow dial is not double-counted)', async () => {
  const net = createMemoryNetwork();
  const host = createHostSession({ transport: net.createTransport('host'), name: 'H', numPlayers: 3, seed: 1 });
  await host.open('SLOW1');
  host.setSeatComputer(2, false);
  const scheduled = [];
  const timers = {
    setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length; },
    clearTimeout: (id) => { scheduled[id - 1] = null; },
    setInterval: () => 0, clearInterval: () => {},
  };
  const slow = net.createTransport('slow');
  const realDial = slow.dial;
  let release;
  slow.dial = (code) => new Promise((resolve) => { release = () => resolve(realDial(code)); });
  const c = createClientSession({ transport: slow, code: 'SLOW1', name: 'C', timers });
  const p = c.join();
  await net.settle();
  assert.equal(scheduled.length, 0, 'no hello timer while still dialing');
  release();
  await net.settle();
  assert.equal(scheduled.filter(Boolean).length, 0, 'hello timer armed after dial, cleared on welcome');
  assert.equal(scheduled.length, 1);
  const w = await p;
  assert.equal(w.seat, 2);
  host.close();
});

test('wire fuzz: a hostile peer sends 3000 random messages; the host never throws, the world only changes through legal entries, honest peers stay in sync', async () => {
  const room = await makeRoom({ numPlayers: 4, humans: 3, seed: 20 });
  const { host, clients, net } = room;
  const hostile = clients[1]; // seat 3, will misbehave on the wire
  const honest = clients[0]; // seat 2
  host.start();
  net.flush();
  const rng = new Mulberry32(2024);
  const pick = (arr) => arr[rng.nextInt(arr.length)];
  const methods = ['rollDice', 'discard', 'moveRobber', 'chooseVictim', 'buy', 'refund', 'placeSettlement', 'placeCity', 'placeRoad',
    'playCard', 'bankTrade', 'offerTrade', 'respondTrade', 'cancelTrade', 'endTurn', 'setComputer', 'giveCards', 'toJSON', 'constructor', '__proto__', ''];
  const values = () => pick([0, 1, 2, 3, 7, 12, 40, -1, 1e9, NaN, null, true, 'f', 'ftbj', 'kkkkk', 'road', 'city', 'settlement', 'devcard',
    [], [1, 2], [0, 1], { resource: 'k' }, { resources: ['f', 'b'] }, [{ give: 'f', want: 'k' }], 'x'.repeat(100), { a: { b: { c: { d: 1 } } } }]);
  const randomEntry = () => {
    const r = rng.nextInt(10);
    if (r === 0) return { kind: 'ai' };
    if (r === 1) return { kind: pick(['nope', 3, null]) };
    const params = [];
    for (let i = rng.nextInt(4); i > 0; i--) params.push(values());
    return { kind: 'call', player: pick([1, 2, 3, 4, 0, 9, -1, 'x']), call: { method: pick(methods), params } };
  };
  const randomMessage = () => {
    const r = rng.nextInt(12);
    if (r === 0) return values();
    if (r === 1) return { t: pick(['hello', 'welcome', 'lobby', 'start', 'applied', 'reject', 'resync', 'end', 'ping', 'pong', 'zzz']), seq: rng.nextInt(50), v: 1, name: 'x', entry: randomEntry(), hash: 'h', config: {}, entries: [], reason: 'r', n: 1, code: 'c' };
    if (r === 2) return { t: 'sync' };
    return { t: 'act', seq: pick([host.entries.length, host.entries.length - 1, host.entries.length + 1, 0, 99999]), entry: randomEntry() };
  };
  const bad = [];
  host.on('badMessage', (m) => bad.push(m));
  let legalFromHostile = 0;
  let luckyLegal = 0;
  const hostileRng = new Mulberry32(77);
  for (let i = 0; i < 3000 && host.game.phase !== 'gameOver'; i++) {
    const before = { hash: host.hash(), seq: host.entries.length };
    const g = host.game;
    const actor = g.actor();
    if (rng.nextInt(3) === 0) {
      // Keep the game moving: whoever is the actor plays one legal entry.
      if (g.players[actor].comp) host.submit({ kind: 'ai' });
      else if (actor === 1) host.submit({ kind: 'call', player: 1, call: pick(legalCalls(g, hostileRng)) });
      else if (actor === 2) honest.submit({ kind: 'call', player: 2, call: pick(legalCalls(honest.game, hostileRng)) });
      else { const calls = legalCalls(g, hostileRng); hostile.peer.send({ t: 'act', seq: host.entries.length, entry: { kind: 'call', player: 3, call: pick(calls) } }); legalFromHostile++; }
      net.flush();
      continue;
    }
    const msg = randomMessage();
    // The host must survive anything the wire can carry (JSON round trip happens in the network).
    try { hostile.peer.send(msg); } catch { continue; } // BigInt/cycles cannot even be sent
    net.flush();
    const changed = host.entries.length !== before.seq;
    if (changed) {
      // Only an 'act' with the right seq, from seat 3, while seat 3 is the actor, and legal, may change the world.
      assert.equal(msg.t, 'act');
      assert.equal(msg.seq, before.seq);
      assert.equal(msg.entry.kind, 'call');
      assert.equal(msg.entry.player, 3);
      assert.equal(actor, 3);
      assert.equal(host.entries.length, before.seq + 1);
      luckyLegal++; // a random action that happened to be legal -- fine, not an error
    } else {
      assert.equal(host.hash(), before.hash, `message ${i} changed the world without an entry: ${JSON.stringify(msg).slice(0, 200)}`);
    }
    assert.equal(honest.desynced, false);
    assert.equal(honest.entries.length, host.entries.length);
  }
  assert.ok(bad.length > 20, `malformed messages were flagged (${bad.length})`);
  assert.ok(legalFromHostile > 0);
  assertInSync({ host, clients: [honest] }, 'honest client after the fuzz', true);
  // The hostile peer's own world may be anything (it forged its own messages); the host is what matters.
  host.close();
});

// Task item 8 ("game over must not cover the board; play can go on"):
// continueGame() is a normal CALL_METHOD, gated exactly like every other
// action by game.actor() -- only the winner (whoever's turn it was when
// 'gameOver' fired) may send it, from either the host or a client seat.
test('continueGame: only the winner may send it; host and clients stay in sync after it', async () => {
  const room = await makeRoom({ numPlayers: 3, humans: 3, seed: 50 });
  const { host, clients, net } = room;
  host.start();
  net.flush();
  assertInSync(room, 'after start');
  const rng = new Mulberry32(50 * 31);

  // Drive real entries (through submit(), never direct mutation) up to the
  // first 'main' phase: random-but-legal setup, then a deterministic path
  // through whatever the first roll triggers.
  while (host.game.phase !== 'main') {
    const g = host.game;
    const actor = g.actor();
    const sess = sessionForSeat(room, actor);
    let call;
    if (g.phase === 'setup') { const calls = legalCalls(sess.game, rng); call = calls[rng.nextInt(calls.length)]; } else if (g.phase === 'roll') call = { method: 'rollDice', params: [] };
    else if (g.phase === 'discard') call = { method: 'discard', params: [actor, g.players[actor].hand.slice(0, g.discardQueue[0].count)] };
    else if (g.phase === 'moveRobber') call = { method: 'moveRobber', params: [g.board.landTiles.find((t) => t !== g.board.robberTile).idx] };
    else if (g.phase === 'chooseVictim') call = { method: 'chooseVictim', params: [g.robberVictims[0]] };
    else break;
    const r = sess.submit({ kind: 'call', player: actor, call });
    assert.ok(r.ok, `setup entry rejected: ${JSON.stringify(r.error)}`);
    net.flush();
  }
  assert.equal(host.game.phase, 'main');
  assertInSync(room, 'before forcing a win', true);
  const winner = host.game.actor();
  const winnerSession = sessionForSeat(room, winner);

  // Reach 10 VP fast without a long random playthrough: identically inject
  // unplayed VP cards into every peer's own copy of the winner's dev[] (a
  // direct, deterministic mutation done the SAME way on every session, not
  // an entry -- see the "no random play in reasonable time" note in
  // tests/fuzz.test.js), then let the winner's own submit()ted playCard
  // calls -- real entries every peer applies and hashes -- do the winning.
  const need = 10 - host.game.victoryPoints(winner);
  assert.ok(need > 0 && need <= 10);
  for (const sess of everyone(room)) {
    for (let i = 0; i < need; i++) sess.game.players[winner].dev.push({ res: 'k', played: false });
  }
  assertInSync(room, 'after identical direct VP injection', true);
  while (host.game.phase === 'main') {
    const idx = winnerSession.game.players[winner].dev.findIndex((c) => !c.played);
    if (idx === -1) break;
    const r = winnerSession.submit({ kind: 'call', player: winner, call: { method: 'playCard', params: [idx] } });
    assert.ok(r.ok, `playCard rejected: ${JSON.stringify(r.error)}`);
    net.flush();
  }
  assert.equal(host.game.phase, 'gameOver');
  assert.equal(host.game.winner, winner);
  assertInSync(room, 'at gameOver', true);

  // A non-winner seat cannot continueGame, on the host side or a client side.
  const otherSeat = (winner % room.host.config.numPlayers) + 1;
  const otherSession = sessionForSeat(room, otherSeat);
  const beforeHash = host.hash();
  const beforeEntries = host.entries.length;
  let r = otherSession.submit({ kind: 'call', player: otherSeat, call: { method: 'continueGame', params: [] } });
  net.flush();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NOT_YOUR_TURN');
  assert.equal(host.game.phase, 'gameOver', 'a non-winner continueGame must change nothing');
  assert.equal(host.hash(), beforeHash);
  assert.equal(host.entries.length, beforeEntries);

  // The winner may continue; every peer applies the same entry and stays in sync.
  r = winnerSession.submit({ kind: 'call', player: winner, call: { method: 'continueGame', params: [] } });
  net.flush();
  assert.ok(r.ok, `continueGame rejected: ${JSON.stringify(r.error)}`);
  assert.equal(host.game.phase, 'main');
  assert.equal(host.game.winner, winner);
  assert.equal(host.game.log[host.game.log.length - 1].type, 'continue');
  assertInSync(room, 'after continueGame', true);
  for (const c of clients) {
    assert.equal(c.game.phase, 'main');
    assert.equal(c.game.winner, winner);
  }
  host.close();
});


test('reload without a goodbye: the same token takes its seat back from the stale connection; another token cannot', async () => {
  const room = await makeRoom({ numPlayers: 3, humans: 3, seed: 21 });
  const { host, clients, net } = room;
  host.start();
  net.flush();
  const rng = new Mulberry32(3);
  playOut(room, rng, { maxEntries: 40 });
  net.flush();
  const old = clients[1];
  assert.equal(old.mySeat, 3);
  const entriesBefore = host.entries.length;
  // The page reloads: the old connection is still open as far as the host
  // knows (no bye arrived), and a new one says hello with the same token.
  const back = createClientSession({ transport: net.createTransport('c3-reload'), code: room.code, name: 'Player3', token: old.token });
  const joined = back.join();
  await net.settle();
  const w = await joined;
  assert.equal(w.seat, 3, 'same seat');
  assert.equal(back.entries.length, host.entries.length, 'the whole log replayed');
  assert.equal(back.hash(), host.hash());
  assert.equal(host.entries.length, entriesBefore, 'no setComputer hand-over: the seat never left a human');
  assert.equal(host.game.players[3].comp, false);
  assert.equal(old.closed, true, 'the stale connection was closed by the host');
  assert.equal(host.peerSeats()[2].connected, true);
  // Somebody with a different token still cannot sit down in a started game.
  const stranger = createClientSession({ transport: net.createTransport('s2'), code: room.code, name: 'S', token: 'not-the-token' });
  assert.equal((await joinExpectingError(stranger, net)).code, 'GAME_STARTED');
  room.clients[1] = back;
  playOut(room, rng, { maxEntries: host.entries.length + 300 });
  assertInSync(room, 'after the reload', true);
  host.close();
});
