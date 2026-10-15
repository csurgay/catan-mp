// Relay transport: every message goes through a public MQTT broker over a
// WebSocket (port 443/8084/8884 outbound), never peer-to-peer. It works
// wherever a web page works -- a phone on mobile data behind carrier NAT,
// an office firewall, a locked-down VM -- which is exactly where WebRTC
// (peerjs.js) fails without a TURN relay. The price: ~100-300 ms per hop
// (fine for a turn-based game) and a shared public broker with no SLA,
// which is why three brokers are tried in order.
//
// Topics (MQTT 3.1.1, QoS 1):
//   <prefix>/<code>/h          joiner -> host  { t:'dial'|'msg'|'bye', from, data? }
//   <prefix>/<code>/c/<peer>   host -> joiner  { t:'accept'|'msg'|'bye', data? }
//
// Anyone who guesses a room code can read the room's traffic; the game's
// state is not secret anyway (docs/HALOZAT.md "Bizalmi modell"), and the
// host validates every entry it receives.
//
// mqtt.js is loaded on demand from cdnjs (pinned, SRI). `mqttImpl` is
// injectable (a fake in unit tests, the `mqtt` npm package in Node tests).
//
// Same interface as memory.js (see the header there).

import { Emitter } from '../emitter.js';

export const MQTT_URL = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.10.1/mqtt.min.js';
export const MQTT_INTEGRITY = 'sha384-u4uqeACkFcoKl57rBQJHVGDd1pqhW4w8X3WjTu1ZksPdxoLqdt34jpoNkJisE25W';
export const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081',
];
export const TOPIC_PREFIX = 'catan-mp/v1'; // apart from the modern port's rooms (catan-hu/v1)
const CONNECT_TIMEOUT_MS = 8000;
const DIAL_TIMEOUT_MS = 8000;

let loading = null;
export function loadMqtt() {
  if (globalThis.mqtt && typeof globalThis.mqtt.connect === 'function') return Promise.resolve(globalThis.mqtt);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = MQTT_URL;
    script.integrity = MQTT_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.onload = () => (globalThis.mqtt ? resolve(globalThis.mqtt) : reject(Object.assign(new Error('mqtt.js loaded but window.mqtt is missing'), { code: 'NO_MQTT' })));
    script.onerror = () => { loading = null; reject(Object.assign(new Error('could not load mqtt.js'), { code: 'NO_MQTT' })); };
    document.head.appendChild(script);
  });
  return loading;
}

function randomId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

function parseJson(payload) {
  try { return JSON.parse(typeof payload === 'string' ? payload : new TextDecoder().decode(payload)); } catch { return null; }
}

class RelayPeer extends Emitter {
  constructor(transport, id, topic) {
    super();
    this.transport = transport;
    this.id = id; // the remote side's id
    this.topic = topic; // where messages to the remote side go
    this.open = true;
  }

  send(msg) {
    if (!this.open) return false;
    return this.transport._publish(this.topic, { t: 'msg', from: this.transport.id, data: msg });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.transport._publish(this.topic, { t: 'bye', from: this.transport.id });
    this.transport.peers.delete(this.id);
    this.emit('close');
  }

  _remoteClosed() {
    if (!this.open) return;
    this.open = false;
    this.transport.peers.delete(this.id);
    this.emit('close');
  }
}

export function createRelayTransport({
  brokers = DEFAULT_BROKERS, prefix = TOPIC_PREFIX, mqttImpl, onStatus, clientId,
} = {}) {
  const transport = new Emitter();
  transport.id = clientId || randomId();
  transport.peers = new Map(); // remoteId -> RelayPeer
  transport.broker = null;
  let client = null;
  let code = null;
  let hosting = false;
  let pendingDial = null; // { resolve, reject, timer }
  const status = (step, detail) => { transport.lastStatus = step; if (onStatus) { try { onStatus(step, detail); } catch { /* ignore */ } } transport.emit('status', { step, detail }); };

  const hostTopic = () => `${prefix}/${code}/h`;
  const clientTopic = (id) => `${prefix}/${code}/c/${id}`;

  transport._publish = (topic, obj) => {
    if (!client) return false;
    try { client.publish(topic, JSON.stringify(obj), { qos: 1 }); return true; } catch { return false; }
  };

  // Connects to the first broker that answers; the others are fallbacks.
  async function connect() {
    if (client) return client;
    status('lib');
    const mqtt = mqttImpl || await loadMqtt();
    let lastErr = null;
    for (const url of brokers) {
      status('relay', url);
      // eslint-disable-next-line no-await-in-loop
      const c = await new Promise((resolve) => {
        let settled = false;
        let cl;
        try {
          cl = mqtt.connect(url, {
            clientId: `catan-${transport.id}`, clean: true, keepalive: 20, connectTimeout: CONNECT_TIMEOUT_MS, reconnectPeriod: 0, protocolVersion: 4,
          });
        } catch (err) { lastErr = err; resolve(null); return; }
        const fail = (err) => { if (settled) return; settled = true; lastErr = err || new Error('broker unreachable'); try { cl.end(true); } catch { /* ignore */ } resolve(null); };
        cl.on('connect', () => { if (settled) return; settled = true; resolve(cl); });
        cl.on('error', fail);
        cl.on('close', () => fail(new Error('closed before connect')));
        cl.on('offline', () => fail(new Error('offline')));
      });
      if (c) {
        client = c;
        transport.broker = url;
        // Listeners for the lifetime of the connection.
        client.removeAllListeners('close');
        client.removeAllListeners('error');
        client.on('message', onMessage);
        client.on('close', () => { if (client === c) { client = null; status('relay-lost'); for (const p of [...transport.peers.values()]) p._remoteClosed(); } });
        client.on('error', () => {});
        status('relay-open', url);
        return client;
      }
    }
    throw Object.assign(new Error(`no relay broker answered (${lastErr && lastErr.message})`), { code: 'BROKER_TIMEOUT' });
  }

  function onMessage(topic, payload) {
    const m = parseJson(payload);
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    if (hosting && topic === hostTopic()) {
      if (typeof m.from !== 'string' || m.from === transport.id) return;
      let peer = transport.peers.get(m.from);
      if (m.t === 'dial') {
        if (!peer) {
          peer = new RelayPeer(transport, m.from, clientTopic(m.from));
          transport.peers.set(m.from, peer);
          transport._publish(peer.topic, { t: 'accept', from: transport.id });
          status('peer-open', m.from);
          transport.emit('connection', peer);
        } else {
          transport._publish(peer.topic, { t: 'accept', from: transport.id });
        }
        return;
      }
      if (!peer) return;
      if (m.t === 'msg') peer.emit('message', m.data);
      else if (m.t === 'bye') peer._remoteClosed();
      return;
    }
    if (!hosting && code && topic === clientTopic(transport.id)) {
      if (m.t === 'accept' && pendingDial) {
        const { resolve, timer } = pendingDial;
        pendingDial = null;
        clearTimeout(timer);
        const peer = new RelayPeer(transport, m.from || 'host', hostTopic());
        transport.peers.set(peer.id, peer);
        status('peer-open', peer.id);
        resolve(peer);
        return;
      }
      const peer = [...transport.peers.values()][0];
      if (!peer) return;
      if (m.t === 'msg') peer.emit('message', m.data);
      else if (m.t === 'bye') peer._remoteClosed();
    }
  }

  function subscribe(topic) {
    return new Promise((resolve, reject) => {
      client.subscribe(topic, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
  }

  transport.listen = async (roomCode) => {
    code = roomCode;
    hosting = true;
    await connect();
    await subscribe(hostTopic());
    status('listening', roomCode);
  };

  transport.dial = async (roomCode) => {
    code = roomCode;
    hosting = false;
    await connect();
    await subscribe(clientTopic(transport.id));
    status('connecting', roomCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingDial = null;
        reject(Object.assign(new Error('no host answered on the relay'), { code: 'NO_ROOM' }));
      }, DIAL_TIMEOUT_MS);
      pendingDial = { resolve, reject, timer };
      transport._publish(hostTopic(), { t: 'dial', from: transport.id });
    });
  };

  transport.close = () => {
    for (const p of [...transport.peers.values()]) p.close();
    transport.peers.clear();
    if (pendingDial) { clearTimeout(pendingDial.timer); pendingDial = null; }
    const c = client;
    client = null;
    // Gently: the goodbyes just published ('end', 'bye') still go out; a
    // broker that does not answer within a second gets cut off.
    if (c) {
      try {
        const force = setTimeout(() => { try { c.end(true); } catch { /* ignore */ } }, 1000);
        c.end(false, {}, () => clearTimeout(force));
      } catch { try { c.end(true); } catch { /* ignore */ } }
    }
  };

  return transport;
}

// A tiny in-process MQTT stand-in for unit tests: `createFakeMqtt()` returns
// something shaped like the mqtt.js module whose clients see each other's
// publishes (asynchronously, like a broker). `failing` URLs never connect.
export function createFakeMqtt({ failing = [] } = {}) {
  const clients = new Set();
  function connect(url, opts = {}) {
    const c = new Emitter();
    c.url = url;
    c.subs = new Set();
    c.connected = false;
    c.subscribe = (topic, o, cb) => { c.subs.add(topic); if (typeof o === 'function') o(null); else if (cb) cb(null); };
    c.publish = (topic, payload) => {
      if (!c.connected) return;
      for (const other of clients) {
        if (other.connected && other.subs.has(topic)) setTimeout(() => other.emit('message', topic, Buffer.from ? Buffer.from(payload) : payload), 0);
      }
    };
    c.end = (...args) => {
      const wasOpen = c.connected || clients.has(c);
      c.connected = false;
      clients.delete(c);
      if (wasOpen) c.emit('close');
      const cb = args.find((a) => typeof a === 'function');
      if (cb) cb();
    };
    c.removeAllListeners = (type) => { c._listeners.delete(type); };
    setTimeout(() => {
      if (failing.includes(url)) { c.emit('error', new Error(`ECONNREFUSED ${url}`)); return; }
      c.connected = true;
      clients.add(c);
      c.emit('connect');
    }, 0);
    void opts;
    return c;
  }
  return { connect, clients };
}

// Connection self-test for the lobby: a throw-away host and joiner on this
// page meet through the relay and exchange one message. Reports which
// broker answered and how long the connect and the round trip took.
export async function relaySelfTest({ brokers = DEFAULT_BROKERS, mqttImpl, onStatus, timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  const code = `SELF${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const a = createRelayTransport({ brokers, mqttImpl, onStatus, prefix: `${TOPIC_PREFIX}/test` });
  const b = createRelayTransport({ brokers, mqttImpl, prefix: `${TOPIC_PREFIX}/test` });
  const report = { ok: false, broker: null, brokerMs: null, connectMs: null, roundTripMs: null, error: null };
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('relay self-test timed out'), { code: 'BROKER_TIMEOUT' })), timeoutMs); });
  try {
    const got = new Promise((resolve) => a.on('connection', (p) => { p.on('message', (m) => resolve(m)); }));
    await Promise.race([a.listen(code), deadline]);
    report.broker = a.broker;
    report.brokerMs = Date.now() - t0;
    const t1 = Date.now();
    const peer = await Promise.race([b.dial(code), deadline]);
    report.connectMs = Date.now() - t1;
    const t2 = Date.now();
    peer.send({ t: 'ping', n: 1 });
    await Promise.race([got, deadline]);
    report.roundTripMs = Date.now() - t2;
    report.ok = true;
  } catch (err) {
    report.error = { code: (err && err.code) || 'ERROR', message: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
    a.close();
    b.close();
  }
  return report;
}

