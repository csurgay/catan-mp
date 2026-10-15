// Relay transport (public-MQTT-broker path) and the combined "auto"
// transport: against an in-process fake broker (deterministic), and --
// when the `aedes`, `ws` and `mqtt` packages are installed -- against a
// real local MQTT broker with the real mqtt.js client, running a whole
// lockstep session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayTransport, createFakeMqtt, DEFAULT_BROKERS } from '../src/net/transports/relay.js';
import { createMultiTransport } from '../src/net/transports/multi.js';
import { createMemoryNetwork } from '../src/net/transports/memory.js';
import { createHostSession, createClientSession } from '../src/net/session.js';
import { Mulberry32 } from '../src/engine/rng.js';
import { legalCalls } from './helpers/legal-calls.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(pred, label, tries = 300) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    // eslint-disable-next-line no-await-in-loop
    await tick();
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('relay (fake broker): handshake, messages both ways, bye, and statuses in order', async () => {
  const mqtt = createFakeMqtt();
  const steps = [];
  const host = createRelayTransport({ mqttImpl: mqtt, brokers: ['wss://a.test/mqtt'], onStatus: (s) => steps.push(`h:${s}`) });
  const guest = createRelayTransport({ mqttImpl: mqtt, brokers: ['wss://a.test/mqtt'], onStatus: (s) => steps.push(`g:${s}`) });
  const got = { host: [], guest: [] };
  const conns = [];
  host.on('connection', (p) => { conns.push(p); p.on('message', (m) => got.host.push(m)); });
  await host.listen('ROOM1');
  const peer = await guest.dial('ROOM1');
  peer.on('message', (m) => got.guest.push(m));
  await until(() => conns.length === 1, 'host connection');
  peer.send({ t: 'hello', v: 1 });
  conns[0].send({ t: 'welcome', seat: 2 });
  await until(() => got.host.length === 1 && got.guest.length === 1, 'messages');
  assert.deepEqual(got.host[0], { t: 'hello', v: 1 });
  assert.deepEqual(got.guest[0], { t: 'welcome', seat: 2 });
  assert.deepEqual(steps.filter((s) => s.startsWith('h:')), ['h:lib', 'h:relay', 'h:relay-open', 'h:listening', 'h:peer-open']);
  assert.deepEqual(steps.filter((s) => s.startsWith('g:')), ['g:lib', 'g:relay', 'g:relay-open', 'g:connecting', 'g:peer-open']);
  const closed = [];
  conns[0].on('close', () => closed.push('host side'));
  peer.close();
  await until(() => closed.length === 1, 'bye propagated');
  host.close(); guest.close();
});

test('relay (fake broker): the first dead broker is skipped, the next one is used; all dead -> BROKER_TIMEOUT; no host -> NO_ROOM', async () => {
  const mqtt = createFakeMqtt({ failing: ['wss://dead.test/mqtt', 'wss://dead2.test/mqtt'] });
  const t = createRelayTransport({ mqttImpl: mqtt, brokers: ['wss://dead.test/mqtt', 'wss://alive.test/mqtt'] });
  await t.listen('X1');
  assert.equal(t.broker, 'wss://alive.test/mqtt');
  t.close();
  const dead = createRelayTransport({ mqttImpl: mqtt, brokers: ['wss://dead.test/mqtt', 'wss://dead2.test/mqtt'] });
  await assert.rejects(dead.listen('X2'), (err) => err.code === 'BROKER_TIMEOUT');
  // No host on the code: the dial times out with NO_ROOM (8 s in production; shortened here).
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 8000 ? 5 : ms, ...rest);
  try {
    const lonely = createRelayTransport({ mqttImpl: mqtt, brokers: ['wss://alive.test/mqtt'] });
    await assert.rejects(lonely.dial('NOBODY'), (err) => err.code === 'NO_ROOM');
    lonely.close();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(DEFAULT_BROKERS.length, 3);
});

test('relay (fake broker): a whole session (host + 2 clients) stays in sync over the relay', async () => {
  const mqtt = createFakeMqtt();
  const host = createHostSession({ transport: createRelayTransport({ mqttImpl: mqtt }), name: 'H', numPlayers: 3, seed: 41 });
  await host.open('RELAY');
  host.setSeatComputer(2, false);
  host.setSeatComputer(3, false);
  const clients = [];
  for (const name of ['A', 'B']) {
    const c = createClientSession({ transport: createRelayTransport({ mqttImpl: mqtt }), code: 'RELAY', name });
    // eslint-disable-next-line no-await-in-loop
    await c.join();
    clients.push(c);
  }
  host.start();
  await until(() => clients.every((c) => c.started), 'started');
  const rng = new Mulberry32(9);
  const sessions = [host, ...clients];
  for (let i = 0; i < 120 && host.game.phase !== 'gameOver'; i++) {
    const actor = host.game.actor();
    const sess = host.game.players[actor].comp ? host : sessions.find((s) => s.mySeat === actor);
    const r = host.game.players[actor].comp
      ? host.submit({ kind: 'ai' })
      : sess.submit({ kind: 'call', player: actor, call: (() => { const l = legalCalls(sess.game, rng); return l[rng.nextInt(l.length)]; })() });
    assert.ok(r.ok, JSON.stringify(r.error));
    const want = i + 1;
    // eslint-disable-next-line no-await-in-loop
    await until(() => host.entries.length === want && clients.every((c) => c.entries.length === want && c.pending.size === 0), `entry ${want}`);
    for (const c of clients) { assert.equal(c.desynced, false); assert.equal(c.hash(), host.hash()); }
  }
  host.close();
  for (const c of clients) c.close();
});

test('multi transport: the host listens on all, a joiner takes the first that answers and the failure carries every attempt', async () => {
  const mqtt = createFakeMqtt({ failing: ['wss://dead.test/mqtt'] });
  const net = createMemoryNetwork();
  // Host: relay + memory. Guest 1: relay (dead broker) + memory -> falls back to memory.
  const host = createMultiTransport([
    Object.assign(createRelayTransport({ mqttImpl: mqtt, brokers: ['wss://ok.test/mqtt'] }), { name: 'relay' }),
    Object.assign(net.createTransport('host'), { name: 'memory' }),
  ]);
  const conns = [];
  host.on('connection', (p) => conns.push(p));
  await host.listen('MULTI');
  assert.equal(host.listening.length, 2);
  const g1 = createMultiTransport([
    Object.assign(createRelayTransport({ mqttImpl: mqtt, brokers: ['wss://dead.test/mqtt'] }), { name: 'relay' }),
    Object.assign(net.createTransport('g1'), { name: 'memory' }),
  ]);
  const p1 = await g1.dial('MULTI');
  assert.equal(g1.active.name, 'memory');
  assert.deepEqual(g1.attempts.map((a) => [a.transport, a.code]), [['relay', 'BROKER_TIMEOUT']]);
  net.flush();
  assert.equal(conns.length, 1);
  p1.send({ t: 'x' });
  // Guest 2: relay works -> first choice.
  const g2 = createMultiTransport([
    Object.assign(createRelayTransport({ mqttImpl: mqtt, brokers: ['wss://ok.test/mqtt'] }), { name: 'relay' }),
    Object.assign(net.createTransport('g2'), { name: 'memory' }),
  ]);
  await g2.dial('MULTI');
  assert.equal(g2.active.name, 'relay');
  await until(() => conns.length === 2, 'second connection over the relay');
  // Everything dead: the error lists both attempts.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 8000 ? 5 : ms, ...rest);
  try {
    const g3 = createMultiTransport([
      Object.assign(createRelayTransport({ mqttImpl: mqtt, brokers: ['wss://dead.test/mqtt'] }), { name: 'relay' }),
      Object.assign(net.createTransport('g3'), { name: 'memory' }),
    ]);
    await assert.rejects(g3.dial('NOSUCH'), (err) => err.code === 'NO_ROOM' && err.attempts.length === 2 && err.attempts[0].code === 'BROKER_TIMEOUT');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  host.close(); g1.close(); g2.close();
});

test('relay (real local MQTT broker + real mqtt.js): host and client sessions stay in sync', async (t) => {
  let Aedes; let ws; let mqtt;
  try {
    Aedes = (await import('aedes')).default;
    ws = await import('ws');
    mqtt = (await import('mqtt')).default;
  } catch {
    t.skip('aedes/ws/mqtt not installed (npm install --no-save aedes ws mqtt)');
    return;
  }
  const { createServer } = await import('node:http');
  const aedes = new Aedes();
  const httpServer = createServer();
  const wss = new ws.WebSocketServer({ server: httpServer });
  wss.on('connection', (sock) => aedes.handle(ws.createWebSocketStream(sock)));
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${httpServer.address().port}/mqtt`;
  try {
    const host = createHostSession({ transport: createRelayTransport({ mqttImpl: mqtt, brokers: [url] }), name: 'H', numPlayers: 3, seed: 43 });
    await host.open('AEDES');
    host.setSeatComputer(2, false);
    const c = createClientSession({ transport: createRelayTransport({ mqttImpl: mqtt, brokers: [url] }), code: 'AEDES', name: 'C' });
    const w = await c.join();
    assert.equal(w.seat, 2);
    host.start();
    await until(() => c.started, 'client started', 2000);
    const rng = new Mulberry32(5);
    for (let i = 0; i < 60 && host.game.phase !== 'gameOver'; i++) {
      const actor = host.game.actor();
      const sess = actor === 2 ? c : host;
      const r = host.game.players[actor].comp
        ? host.submit({ kind: 'ai' })
        : sess.submit({ kind: 'call', player: actor, call: (() => { const l = legalCalls(sess.game, rng); return l[rng.nextInt(l.length)]; })() });
      assert.ok(r.ok, JSON.stringify(r.error));
      const want = i + 1;
      // eslint-disable-next-line no-await-in-loop
      await until(() => host.entries.length === want && c.entries.length === want && c.pending.size === 0, `entry ${want}`, 2000);
      assert.equal(c.hash(), host.hash());
    }
    // A stranger: unknown room -> NO_ROOM (real 8 s timeout is too slow for a unit test; use a dead-broker check instead).
    const dead = createRelayTransport({ mqttImpl: mqtt, brokers: ['ws://127.0.0.1:1/mqtt'] });
    await assert.rejects(dead.listen('X'), (err) => err.code === 'BROKER_TIMEOUT');
    host.close();
    c.close();
  } finally {
    await new Promise((r) => httpServer.close(r));
    await new Promise((r) => aedes.close(r));
  }
});
