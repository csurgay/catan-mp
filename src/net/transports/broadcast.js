// Same-browser transport over BroadcastChannel: every tab of this origin
// that opens the channel `catan-mp:<code>` hears every post, so a tiny
// handshake turns the shared bus into host<->client point-to-point peers.
// Used for "two tabs on one computer" (trying the multiplayer out alone)
// and by the e2e test, which drives two real pages through it.
//
//   { t:'dial',   from }                joiner -> everyone; the host answers
//   { t:'accept', from, to }            host -> joiner
//   { t:'msg',    from, to, data }      either way
//   { t:'bye',    from, to }            either way, best effort on close
//
// Same interface as memory.js (see the header there).

import { Emitter } from '../emitter.js';

const DIAL_TIMEOUT_MS = 1500;

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

class BcPeer extends Emitter {
  constructor(bus, localId, remoteId) {
    super();
    this.bus = bus;
    this.localId = localId;
    this.id = remoteId;
    this.open = true;
  }

  send(msg) {
    if (!this.open) return false;
    this.bus.postMessage({ t: 'msg', from: this.localId, to: this.id, data: msg });
    return true;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    try { this.bus.postMessage({ t: 'bye', from: this.localId, to: this.id }); } catch { /* channel gone */ }
    this.emit('close');
  }

  _remoteClosed() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
}

export function createBroadcastTransport({ prefix = 'catan-mp', BroadcastChannelImpl } = {}) {
  const BC = BroadcastChannelImpl || globalThis.BroadcastChannel;
  if (typeof BC !== 'function') throw new Error('BroadcastChannel is not available');
  const transport = new Emitter();
  const myId = randomId();
  transport.id = myId;
  transport.peers = new Map(); // remoteId -> BcPeer
  let bus = null;
  let hosting = false;
  let pageHideHooked = false;

  function onBusMessage(evt) {
    const m = evt && evt.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'dial' && hosting && typeof m.from === 'string') {
      if (transport.peers.has(m.from)) return;
      const peer = new BcPeer(bus, myId, m.from);
      transport.peers.set(m.from, peer);
      bus.postMessage({ t: 'accept', from: myId, to: m.from });
      transport.emit('connection', peer);
      return;
    }
    if (m.to !== myId) return;
    const peer = transport.peers.get(m.from);
    if (!peer) return;
    if (m.t === 'msg') peer.emit('message', m.data);
    else if (m.t === 'bye') { transport.peers.delete(m.from); peer._remoteClosed(); }
  }

  function openBus(code) {
    bus = new BC(`${prefix}:${code}`);
    bus.onmessage = onBusMessage;
    if (!pageHideHooked && typeof globalThis.addEventListener === 'function') {
      pageHideHooked = true;
      globalThis.addEventListener('pagehide', () => transport.close());
    }
  }

  transport.listen = async (code) => {
    openBus(code);
    hosting = true;
  };

  transport.dial = (code) => new Promise((resolve, reject) => {
    openBus(code);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      bus.onmessage = null;
      reject(Object.assign(new Error('no host answered on this channel'), { code: 'NO_ROOM' }));
    }, DIAL_TIMEOUT_MS);
    const baseHandler = onBusMessage;
    bus.onmessage = (evt) => {
      const m = evt && evt.data;
      if (!done && m && m.t === 'accept' && m.to === myId && typeof m.from === 'string') {
        done = true;
        clearTimeout(timer);
        const peer = new BcPeer(bus, myId, m.from);
        transport.peers.set(m.from, peer);
        bus.onmessage = baseHandler;
        resolve(peer);
        return;
      }
      baseHandler(evt);
    };
    bus.postMessage({ t: 'dial', from: myId });
  });

  transport.close = () => {
    for (const peer of [...transport.peers.values()]) peer.close();
    transport.peers.clear();
    hosting = false;
    if (bus) { try { bus.close(); } catch { /* ignore */ } bus = null; }
  };

  return transport;
}
