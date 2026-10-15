// Internet transport over WebRTC data channels, with PeerJS doing the
// signalling. By default the free public PeerJS broker (0.peerjs.com) is
// used; `broker` points at another PeerServer (a self-hosted one, or the
// local one the e2e test starts). The host's PeerJS id is
// `catan-mp-<ROOMCODE>`; joiners connect to that id. Game data then flows
// peer-to-peer; the broker only ever sees the handshake.
//
// NAT traversal: besides Google's STUN servers the ICE config lists the
// Open Relay Project's free TURN servers, so two players behind carrier
// NAT (a phone on mobile data, a strict home router) can still connect
// through a relay instead of failing the handshake. `iceTransportPolicy:
// 'relay'` forces the relay path (the lobby's connection test uses it to
// tell "STUN works" from "TURN works").
//
// The PeerJS library is loaded on demand from cdnjs (pinned version +
// subresource integrity), and only on this path -- index.html, the
// tutorial and hot-seat play never touch the network. `PeerImpl` is
// injectable so the adapter is unit-tested against a fake Peer class.
//
// Every step reports through `onStatus(step, detail)` so the lobby can
// show where a connection attempt is, and every failure carries a code the
// lobby can translate: NO_PEERJS, BROKER_TIMEOUT, BROKER, ROOM_TAKEN,
// NO_ROOM, HOST_TIMEOUT, ICE_FAILED, BROWSER.
//
// Same interface as memory.js (see the header there).

import { Emitter } from '../emitter.js';

export const PEERJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js';
export const PEERJS_INTEGRITY = 'sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR';
export const ID_PREFIX = 'catan-mp-'; // apart from the modern port's rooms (catan-hu-)
const BROKER_TIMEOUT_MS = 15000;
const HOST_TIMEOUT_MS = 20000;

// STUN for the common case (both sides behind ordinary home routers).
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// TURN for the phone-on-mobile-data case (carrier NAT): credentials are
// short-lived, so they are fetched at connect time from a credential API
// (Metered.ca's free plan: `https://<app>.metered.live/api/v1/turn/credentials?apiKey=…`,
// which answers with a JSON array of RTCIceServer entries; the key is
// restricted to this site's domain in their dashboard). Empty = STUN only.
// `?turn=<url>` on the page overrides it for one page load. The
// (free, credential-less) Open Relay Project servers used to be listed
// here; their fixed credentials no longer work, so a fetched set replaced them.
export const TURN_CREDENTIAL_URL = '';
const TURN_FETCH_TIMEOUT_MS = 4000;
let turnCache = null;

// The ICE server list for a new connection: STUN, plus whatever the TURN
// credential URL returns (cached for the page; a failure just means STUN only).
export async function resolveIceServers({ turnCredentialUrl = TURN_CREDENTIAL_URL, fetchImpl = globalThis.fetch, onStatus } = {}) {
  const base = DEFAULT_ICE_SERVERS.slice();
  if (!turnCredentialUrl || typeof fetchImpl !== 'function') return base;
  if (turnCache && turnCache.url === turnCredentialUrl && Date.now() < turnCache.until) return base.concat(turnCache.servers);
  if (onStatus) onStatus('turn');
  try {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, TURN_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(turnCredentialUrl, ctrl ? { signal: ctrl.signal } : undefined);
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) throw new Error(`turn credentials: http ${res && res.status}`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body && Array.isArray(body.iceServers) ? body.iceServers : []);
    const servers = list.filter((e) => e && e.urls);
    // 10 minutes: Metered's credentials live longer, and a page rarely
    // reconnects more often than that.
    turnCache = { url: turnCredentialUrl, servers, until: Date.now() + 10 * 60 * 1000 };
    return base.concat(servers);
  } catch (err) {
    if (onStatus) onStatus('turn-failed', String((err && err.message) || err));
    return base;
  }
}

export function hasTurn(iceServers) {
  return (iceServers || []).some((e) => [].concat(e.urls || []).some((u) => /^turns?:/.test(String(u))));
}

let loading = null;
export function loadPeerJs() {
  if (globalThis.Peer) return Promise.resolve(globalThis.Peer);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PEERJS_URL;
    script.integrity = PEERJS_INTEGRITY;
    script.crossOrigin = 'anonymous';
    script.onload = () => (globalThis.Peer ? resolve(globalThis.Peer) : reject(Object.assign(new Error('PeerJS loaded but window.Peer is missing'), { code: 'NO_PEERJS' })));
    script.onerror = () => { loading = null; reject(Object.assign(new Error('could not load PeerJS'), { code: 'NO_PEERJS' })); };
    document.head.appendChild(script);
  });
  return loading;
}

// "host:port[/path]" -> PeerJS constructor options; `secure` false for a
// plain-http local broker (the e2e test), true otherwise.
export function parseBroker(spec, { secure } = {}) {
  if (!spec) return null;
  const m = String(spec).trim().match(/^(?:(wss?|https?):\/\/)?([A-Za-z0-9.-]+)(?::(\d+))?(\/[^\s]*)?$/);
  if (!m) return null;
  const scheme = m[1] || '';
  const host = m[2];
  const isLocal = /^(localhost|127\.|10\.|192\.168\.)/.test(host);
  const sec = secure !== undefined ? !!secure : !(scheme === 'ws' || scheme === 'http' || isLocal);
  return {
    host, port: m[3] ? Number(m[3]) : (sec ? 443 : 80), path: m[4] || '/', secure: sec,
  };
}

class RtcPeer extends Emitter {
  constructor(conn) {
    super();
    this.conn = conn;
    this.id = conn.peer;
    this.open = true;
    conn.on('data', (data) => this.emit('message', data));
    conn.on('close', () => this._closed());
    conn.on('error', () => this._closed());
  }

  send(msg) {
    if (!this.open) return false;
    try { this.conn.send(msg); return true; } catch { return false; }
  }

  close() {
    if (!this.open) return;
    this.open = false;
    try { this.conn.close(); } catch { /* ignore */ }
    this.emit('close');
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
}

function withTimeout(promise, ms, code, message, detail) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code, detail: detail ? detail() : undefined })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Maps a PeerJS error `type` (https://peerjs.com/docs/#peeron-error) to
// one of this module's codes.
function mapPeerError(err) {
  const type = err && err.type;
  if (type === 'unavailable-id') return { code: 'ROOM_TAKEN', message: 'room code already in use' };
  if (type === 'peer-unavailable') return { code: 'NO_ROOM', message: 'no such room' };
  if (type === 'browser-incompatible') return { code: 'BROWSER', message: 'this browser cannot do WebRTC' };
  if (type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed' || type === 'disconnected') {
    return { code: 'BROKER', message: `signalling server: ${type}` };
  }
  return { code: type || 'PEERJS', message: String((err && err.message) || err) };
}

// Reads the selected ICE candidate pair type ('host' | 'srflx' | 'relay'
// | ...) from a live RTCPeerConnection, for the connection test/diagnostics.
export async function candidateType(pc) {
  if (!pc || typeof pc.getStats !== 'function') return null;
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => { if (r.type === 'candidate-pair' && (r.selected || r.state === 'succeeded') && !pair) pair = r; });
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    return local ? local.candidateType : null;
  } catch {
    return null;
  }
}

export function createPeerJsTransport({
  PeerImpl, prefix = ID_PREFIX, broker = null, iceServers = null, iceTransportPolicy = 'all', onStatus,
  turnCredentialUrl = TURN_CREDENTIAL_URL, fetchImpl,
} = {}) {
  const transport = new Emitter();
  transport.peers = [];
  transport.lastIce = null;
  transport.iceServers = iceServers;
  let peer = null;
  const status = (step, detail) => { transport.lastStatus = step; if (onStatus) { try { onStatus(step, detail); } catch { /* ignore */ } } transport.emit('status', { step, detail }); };

  function peerOptions(servers) {
    const opts = { config: { iceServers: servers, iceTransportPolicy }, debug: 0 };
    if (broker) Object.assign(opts, broker);
    return opts;
  }

  async function makePeer(id) {
    status('lib');
    const Peer = PeerImpl || await loadPeerJs();
    if (!transport.iceServers) {
      transport.iceServers = await resolveIceServers({ turnCredentialUrl, fetchImpl, onStatus: status });
    }
    transport.hasTurn = hasTurn(transport.iceServers);
    status('broker', broker ? `${broker.host}:${broker.port}` : '0.peerjs.com');
    return new Promise((resolve, reject) => {
      const p = id ? new Peer(id, peerOptions(transport.iceServers)) : new Peer(peerOptions(transport.iceServers));
      let settled = false;
      p.on('open', () => { if (!settled) { settled = true; status('broker-open', p.id); resolve(p); } });
      p.on('error', (err) => {
        const mapped = mapPeerError(err);
        if (!settled && mapped.code !== 'NO_ROOM') {
          settled = true;
          reject(Object.assign(new Error(mapped.message), { code: mapped.code }));
          return;
        }
        transport.emit('error', Object.assign(err || new Error('peer error'), mapped));
      });
    });
  }

  // Watches the ICE state of a DataConnection's RTCPeerConnection so the
  // lobby can show "connecting…/relayed/failed" and a failure surfaces
  // right away instead of at the timeout.
  function watchIce(conn, onFailed) {
    let pc = null;
    const attach = () => {
      if (pc || !conn.peerConnection) return;
      pc = conn.peerConnection;
      const report = () => {
        transport.lastIce = pc.iceConnectionState;
        status('ice', pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') onFailed();
      };
      pc.addEventListener('iceconnectionstatechange', report);
      report();
    };
    attach();
    const timer = setInterval(() => { attach(); if (pc) clearInterval(timer); }, 100);
    return () => clearInterval(timer);
  }

  transport.listen = async (code) => {
    peer = await withTimeout(makePeer(prefix + code), BROKER_TIMEOUT_MS, 'BROKER_TIMEOUT', 'the signalling server did not answer');
    status('listening', prefix + code);
    peer.on('connection', (conn) => {
      const wrap = () => {
        const rp = new RtcPeer(conn);
        transport.peers.push(rp);
        status('peer-open', conn.peer);
        transport.emit('connection', rp);
      };
      if (conn.open) wrap(); else conn.on('open', wrap);
    });
    peer.on('disconnected', () => {
      // Lost the broker (not the peers): try to get back so new joiners can still find us.
      status('broker-lost');
      try { peer.reconnect(); } catch { /* ignore */ }
    });
  };

  transport.dial = async (code) => {
    peer = await withTimeout(makePeer(null), BROKER_TIMEOUT_MS, 'BROKER_TIMEOUT', 'the signalling server did not answer');
    status('connecting', prefix + code);
    const conn = peer.connect(prefix + code, { reliable: true, serialization: 'json' });
    let stopWatch = () => {};
    const opened = new Promise((resolve, reject) => {
      conn.on('open', () => resolve(conn));
      conn.on('error', (err) => reject(Object.assign(new Error(String((err && err.message) || err)), { code: 'CONNECT' })));
      peer.on('error', (err) => {
        const mapped = mapPeerError(err);
        if (mapped.code === 'NO_ROOM' || mapped.code === 'BROKER') reject(Object.assign(new Error(mapped.message), { code: mapped.code }));
      });
      stopWatch = watchIce(conn, () => reject(Object.assign(new Error('direct connection failed (NAT/firewall)'), { code: 'ICE_FAILED' })));
    });
    try {
      await withTimeout(opened, HOST_TIMEOUT_MS, 'HOST_TIMEOUT', 'could not reach the host', () => transport.lastIce);
    } finally {
      stopWatch();
    }
    status('peer-open', conn.peer);
    const rp = new RtcPeer(conn);
    rp.pc = conn.peerConnection;
    transport.peers.push(rp);
    return rp;
  };

  transport.close = () => {
    for (const rp of transport.peers) rp.close();
    transport.peers = [];
    if (peer) { try { peer.destroy(); } catch { /* ignore */ } peer = null; }
  };

  return transport;
}

// Connection self-test for the lobby: two throw-away peers on this very
// page connect to each other through the broker and WebRTC. Reports how
// long the broker and the handshake took and which candidate type carried
// the data ('host' on one machine, 'srflx' through STUN, 'relay' through
// TURN). With `relayOnly` it proves whether the TURN relay works at all.
export async function selfTest({
  PeerImpl, broker = null, relayOnly = false, timeoutMs = 20000, onStatus, turnCredentialUrl = TURN_CREDENTIAL_URL, fetchImpl,
} = {}) {
  const t0 = Date.now();
  const code = `SELF${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const common = { PeerImpl, broker, prefix: 'catan-test-', iceTransportPolicy: relayOnly ? 'relay' : 'all', turnCredentialUrl, fetchImpl };
  const a = createPeerJsTransport({ ...common, onStatus });
  const b = createPeerJsTransport({ ...common, onStatus });
  const report = { ok: false, relayOnly, brokerMs: null, connectMs: null, candidate: null, error: null, hasTurn: null };
  try {
    const got = new Promise((resolve) => a.on('connection', (p) => p.on('message', (m) => resolve(m))));
    await a.listen(code);
    report.brokerMs = Date.now() - t0;
    report.hasTurn = !!a.hasTurn;
    if (relayOnly && !a.hasTurn) throw Object.assign(new Error('no TURN server configured'), { code: 'NO_TURN' });
    const t1 = Date.now();
    const peer = await withTimeout(b.dial(code), timeoutMs, 'HOST_TIMEOUT', 'self-test handshake timed out');
    report.connectMs = Date.now() - t1;
    peer.send({ t: 'ping', n: 1 });
    await withTimeout(got, 5000, 'HOST_TIMEOUT', 'self-test message never arrived');
    report.candidate = await candidateType(peer.pc);
    report.ok = true;
  } catch (err) {
    report.error = { code: (err && err.code) || 'ERROR', message: String((err && err.message) || err) };
  } finally {
    a.close();
    b.close();
  }
  return report;
}
