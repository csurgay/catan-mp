// The two browser transports, exercised in Node: BroadcastChannel is built
// into Node (same semantics as the browser's, asynchronous delivery), and
// the PeerJS adapter runs against a fake Peer class that mimics the parts
// of the PeerJS API it uses (open/connection/data/close/error events).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroadcastTransport } from '../src/net/transports/broadcast.js';
import { createPeerJsTransport, ID_PREFIX } from '../src/net/transports/peerjs.js';
import { createHostSession, createClientSession } from '../src/net/session.js';
import { Mulberry32 } from '../src/engine/rng.js';
import { legalCalls } from './helpers/legal-calls.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(pred, label, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ------------------------------------------------------------ BroadcastChannel

test('broadcast transport: host + 2 clients over a real BroadcastChannel play 150 lockstep entries in sync', async () => {
  const code = `T${Date.now() % 100000}`;
  const host = createHostSession({ transport: createBroadcastTransport(), name: 'H', numPlayers: 3, seed: 21 });
  await host.open(code);
  host.setSeatComputer(2, false);
  host.setSeatComputer(3, false);
  const clients = [];
  for (const name of ['A', 'B']) {
    const c = createClientSession({ transport: createBroadcastTransport(), code, name });
    // eslint-disable-next-line no-await-in-loop
    const w = await c.join();
    assert.ok(w.seat === 2 || w.seat === 3);
    clients.push(c);
  }
  host.start();
  await until(() => clients.every((c) => c.started), 'clients started');
  const rng = new Mulberry32(4);
  const sessions = [host, ...clients];
  for (let i = 0; i < 150 && host.game.phase !== 'gameOver'; i++) {
    const actor = host.game.actor();
    const sess = host.game.players[actor].comp ? host : sessions.find((s) => s.mySeat === actor);
    const r = host.game.players[actor].comp
      ? host.submit({ kind: 'ai' })
      : sess.submit({ kind: 'call', player: actor, call: (() => { const l = legalCalls(sess.game, rng); return l[rng.nextInt(l.length)]; })() });
    assert.ok(r.ok, JSON.stringify(r.error));
    // A client's own action reaches the host with a delay: wait until the
    // host and every client hold one more entry and no echo is outstanding.
    const want = i + 1;
    // eslint-disable-next-line no-await-in-loop
    await until(() => host.entries.length === want && clients.every((c) => c.entries.length === want && c.pending.size === 0), `entry ${want} everywhere`);
    for (const c of clients) { assert.equal(c.desynced, false); assert.equal(c.hash(), host.hash()); }
  }
  assert.ok(host.entries.length >= 100);
  const closed = [];
  for (const c of clients) c.on('closed', (e) => closed.push(e.reason));
  host.close('done');
  await until(() => closed.length === 2, 'clients closed');
  assert.deepEqual(closed, ['done', 'done']);
  for (const c of clients) c.close();
});

test('broadcast transport: dialing a channel nobody hosts fails with NO_ROOM (after the dial timeout)', async () => {
  const t = createBroadcastTransport();
  const t0 = Date.now();
  await assert.rejects(t.dial('NOBODY'), (err) => err.code === 'NO_ROOM');
  assert.ok(Date.now() - t0 >= 1000, 'waited for the answer');
  t.close();
});

test('broadcast transport: a joiner dropping mid-lobby frees its seat on the host', async () => {
  const code = `D${Date.now() % 100000}`;
  const host = createHostSession({ transport: createBroadcastTransport(), name: 'H', numPlayers: 3, seed: 1 });
  await host.open(code);
  host.setSeatComputer(2, false);
  const c = createClientSession({ transport: createBroadcastTransport(), code, name: 'Drop' });
  await c.join();
  assert.equal(host.lobby().seats[1].taken, true);
  c.close();
  await until(() => host.lobby().seats[1].taken === false, 'seat freed');
  assert.equal(host.lobby().seats[1].name, '');
  host.close();
});

// ------------------------------------------------------------ PeerJS (fake)

// A minimal in-process stand-in for the PeerJS `Peer` class: ids are global
// within the test, connect() creates two linked DataConnection-like objects.
function makeFakePeerClass() {
  const registry = new Map();
  class FakeConn {
    constructor(peerId) { this.peer = peerId; this.open = false; this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
    _emit(ev, a) { for (const fn of this._h[ev] || []) fn(a); }
    send(data) { const d = JSON.parse(JSON.stringify(data)); setTimeout(() => this.other && this.other.open && this.other._emit('data', d), 0); }
    close() { if (!this.open) return; this.open = false; const o = this.other; setTimeout(() => { if (o && o.open) { o.open = false; o._emit('close'); } }, 0); this._emit('close'); }
  }
  class FakePeer {
    constructor(id) {
      this.id = id || `anon-${Math.random().toString(36).slice(2, 8)}`;
      this._h = {};
      this.destroyed = false;
      setTimeout(() => {
        if (registry.has(this.id)) { this._emit('error', Object.assign(new Error('ID is taken'), { type: 'unavailable-id' })); return; }
        registry.set(this.id, this);
        this._emit('open', this.id);
      }, 0);
    }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
    _emit(ev, a) { for (const fn of this._h[ev] || []) fn(a); }
    connect(remoteId) {
      const mine = new FakeConn(remoteId);
      setTimeout(() => {
        const remote = registry.get(remoteId);
        if (!remote) { this._emit('error', Object.assign(new Error(`Could not connect to peer ${remoteId}`), { type: 'peer-unavailable' })); return; }
        const theirs = new FakeConn(this.id);
        mine.other = theirs; theirs.other = mine;
        mine.open = true; theirs.open = true;
        remote._emit('connection', theirs);
        theirs._emit('open');
        mine._emit('open');
      }, 0);
      return mine;
    }
    reconnect() {}
    destroy() { this.destroyed = true; registry.delete(this.id); }
  }
  return { FakePeer, registry };
}

test('peerjs adapter: host id carries the prefix, a client dials by room code, messages flow both ways, close propagates', async () => {
  const { FakePeer, registry } = makeFakePeerClass();
  const hostT = createPeerJsTransport({ PeerImpl: FakePeer });
  const got = { host: [], client: [] };
  const connections = [];
  hostT.on('connection', (p) => { connections.push(p); p.on('message', (m) => got.host.push(m)); });
  await hostT.listen('ABCDE');
  assert.ok(registry.has(`${ID_PREFIX}ABCDE`));
  const clientT = createPeerJsTransport({ PeerImpl: FakePeer });
  const peer = await clientT.dial('ABCDE');
  peer.on('message', (m) => got.client.push(m));
  await until(() => connections.length === 1, 'host saw the connection');
  peer.send({ t: 'hello', v: 1, name: 'x' });
  connections[0].send({ t: 'welcome', peerId: 'p', seat: 2, token: 't' });
  await until(() => got.host.length === 1 && got.client.length === 1, 'messages');
  assert.equal(got.host[0].t, 'hello');
  assert.equal(got.client[0].t, 'welcome');
  const closed = [];
  connections[0].on('close', () => closed.push('host side'));
  peer.close();
  await until(() => closed.length === 1, 'close propagated');
  hostT.close();
  assert.equal(registry.has(`${ID_PREFIX}ABCDE`), false, 'destroy() released the id');
  clientT.close();
});

test('peerjs adapter: a taken room code is ROOM_TAKEN, an unknown code is NO_ROOM', async () => {
  const { FakePeer } = makeFakePeerClass();
  const a = createPeerJsTransport({ PeerImpl: FakePeer });
  await a.listen('ZZZZZ');
  const b = createPeerJsTransport({ PeerImpl: FakePeer });
  await assert.rejects(b.listen('ZZZZZ'), (err) => err.code === 'ROOM_TAKEN');
  const c = createPeerJsTransport({ PeerImpl: FakePeer });
  await assert.rejects(c.dial('QQQQQ'), (err) => err.code === 'NO_ROOM');
  a.close(); b.close(); c.close();
});

test('peerjs adapter: a whole session (host + client) runs over the fake PeerJS wire', async () => {
  const { FakePeer } = makeFakePeerClass();
  const host = createHostSession({ transport: createPeerJsTransport({ PeerImpl: FakePeer }), name: 'H', numPlayers: 3, seed: 33 });
  await host.open('PEER1');
  host.setSeatComputer(2, false);
  const c = createClientSession({ transport: createPeerJsTransport({ PeerImpl: FakePeer }), code: 'PEER1', name: 'C' });
  const w = await c.join();
  assert.equal(w.seat, 2);
  host.start();
  await until(() => c.started, 'client started');
  const rng = new Mulberry32(2);
  for (let i = 0; i < 60 && host.game.phase !== 'gameOver'; i++) {
    const actor = host.game.actor();
    const sess = actor === 2 ? c : host;
    const r = host.game.players[actor].comp
      ? host.submit({ kind: 'ai' })
      : sess.submit({ kind: 'call', player: actor, call: (() => { const l = legalCalls(sess.game, rng); return l[rng.nextInt(l.length)]; })() });
    assert.ok(r.ok, JSON.stringify(r.error));
    const want = i + 1;
    // eslint-disable-next-line no-await-in-loop
    await until(() => host.entries.length === want && c.entries.length === want && c.pending.size === 0, `entry ${want}`);
    assert.equal(c.hash(), host.hash());
  }
  host.close();
  c.close();
});

test('peerjs adapter: status steps are reported in order, and the failure codes are specific (BROKER_TIMEOUT, ICE_FAILED)', async () => {
  const { FakePeer } = makeFakePeerClass();
  const steps = [];
  const a = createPeerJsTransport({ PeerImpl: FakePeer, onStatus: (step) => steps.push(step) });
  await a.listen('STAT1');
  const b = createPeerJsTransport({ PeerImpl: FakePeer, onStatus: (step) => steps.push(`b:${step}`) });
  await b.dial('STAT1');
  assert.deepEqual(steps.filter((x) => !x.startsWith('b:')), ['lib', 'broker', 'broker-open', 'listening', 'peer-open']);
  assert.deepEqual(steps.filter((x) => x.startsWith('b:')), ['b:lib', 'b:broker', 'b:broker-open', 'b:connecting', 'b:peer-open']);
  a.close(); b.close();

  // A broker that never answers: BROKER_TIMEOUT (not a generic TIMEOUT).
  class SilentPeer { constructor() { this._h = {}; } on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); } destroy() {} }
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 15000 ? 5 : ms, ...rest);
  try {
    const c = createPeerJsTransport({ PeerImpl: SilentPeer });
    await assert.rejects(c.dial('ABCDE'), (err) => err.code === 'BROKER_TIMEOUT');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  // A DataConnection whose ICE fails: ICE_FAILED right away, with the state attached.
  class IcePeer extends FakePeer {
    connect(remoteId) {
      const conn = super.connect(remoteId);
      const listeners = {};
      conn.peerConnection = {
        iceConnectionState: 'checking',
        addEventListener: (ev, fn) => { listeners[ev] = fn; },
      };
      realSetTimeout(() => { conn.peerConnection.iceConnectionState = 'failed'; if (listeners.iceconnectionstatechange) listeners.iceconnectionstatechange(); }, 20);
      // Never open: the ICE failure must win over the host timeout.
      conn._emit = (ev, arg) => { if (ev !== 'open') for (const fn of conn._h[ev] || []) fn(arg); };
      return conn;
    }
  }
  const d0 = createPeerJsTransport({ PeerImpl: FakePeer });
  await d0.listen('ICE01');
  const d = createPeerJsTransport({ PeerImpl: IcePeer });
  await assert.rejects(d.dial('ICE01'), (err) => err.code === 'ICE_FAILED');
  assert.equal(d.lastIce, 'failed');
  d0.close(); d.close();
});

test('parseBroker: host:port[/path] forms, local brokers default to plain ws, public ones to secure', async () => {
  const { parseBroker } = await import('../src/net/transports/peerjs.js');
  assert.deepEqual(parseBroker('127.0.0.1:9123'), { host: '127.0.0.1', port: 9123, path: '/', secure: false });
  assert.deepEqual(parseBroker('peer.example.org'), { host: 'peer.example.org', port: 443, path: '/', secure: true });
  assert.deepEqual(parseBroker('http://peer.example.org:9000/peerjs'), { host: 'peer.example.org', port: 9000, path: '/peerjs', secure: false });
  assert.equal(parseBroker(''), null);
  assert.equal(parseBroker('not a host!'), null);
});

test('resolveIceServers: STUN only without a credential URL; Metered-style JSON is appended and cached; a failing fetch falls back to STUN', async () => {
  const { resolveIceServers, hasTurn, DEFAULT_ICE_SERVERS } = await import('../src/net/transports/peerjs.js');
  assert.deepEqual(await resolveIceServers({ turnCredentialUrl: '' }), DEFAULT_ICE_SERVERS);
  let calls = 0;
  const okFetch = async () => { calls++; return { ok: true, status: 200, json: async () => [{ urls: 'stun:a.b:3478' }, { urls: 'turn:a.b:443?transport=tcp', username: 'u', credential: 'p' }] }; };
  const steps = [];
  const list = await resolveIceServers({ turnCredentialUrl: 'https://x.test/creds', fetchImpl: okFetch, onStatus: (s2) => steps.push(s2) });
  assert.equal(list.length, DEFAULT_ICE_SERVERS.length + 2);
  assert.equal(hasTurn(list), true);
  assert.equal(hasTurn(DEFAULT_ICE_SERVERS), false);
  assert.deepEqual(steps, ['turn']);
  await resolveIceServers({ turnCredentialUrl: 'https://x.test/creds', fetchImpl: okFetch });
  assert.equal(calls, 1, 'second call served from the cache');
  const badSteps = [];
  const bad = await resolveIceServers({ turnCredentialUrl: 'https://y.test/creds', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }), onStatus: (s2) => badSteps.push(s2) });
  assert.deepEqual(bad, DEFAULT_ICE_SERVERS);
  assert.deepEqual(badSteps, ['turn', 'turn-failed']);
  const thrown = await resolveIceServers({ turnCredentialUrl: 'https://z.test/creds', fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(thrown, DEFAULT_ICE_SERVERS);
});

test('peerjs adapter: the fetched ICE servers reach the Peer constructor; the relay-only self-test says NO_TURN without one', async () => {
  const { selfTest } = await import('../src/net/transports/peerjs.js');
  const { FakePeer } = makeFakePeerClass();
  const seen = [];
  class SpyPeer extends FakePeer {
    constructor(id, opts) { super(typeof id === 'string' ? id : undefined); seen.push((typeof id === 'string' ? opts : id).config); }
  }
  const t = createPeerJsTransport({
    PeerImpl: SpyPeer, turnCredentialUrl: 'https://spy.test/creds',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => [{ urls: 'turn:relay.test:443', username: 'u', credential: 'p' }] }),
  });
  await t.listen('TURN1');
  assert.equal(t.hasTurn, true);
  assert.ok(seen[0].iceServers.some((e) => e.urls === 'turn:relay.test:443'));
  assert.equal(seen[0].iceTransportPolicy, 'all');
  t.close();
  const r = await selfTest({ PeerImpl: SpyPeer, relayOnly: true, turnCredentialUrl: '' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_TURN');
  assert.equal(r.hasTurn, false);
});

