// In-memory transport for tests: a "network" object owns every message in
// flight, and nothing is delivered until the test says so (flush()), so a
// test controls interleaving exactly and can drop, delay or cut links.
//
// Transport interface (shared by memory.js, broadcast.js, peerjs.js):
//   transport.listen(code)  -> Promise<void>; emits 'connection' (peer) per joiner
//   transport.dial(code)    -> Promise<peer>
//   transport.close()
//   peer.id, peer.open, peer.send(msg), peer.on('message'|'close', fn), peer.close()
//
// Messages are JSON round-tripped on the way through, like a real wire, so
// anything non-serialisable (a Set, a BigInt, a function) fails here too.

import { Emitter } from '../emitter.js';

class MemoryPeer extends Emitter {
  constructor(network, id, remote) {
    super();
    this.network = network;
    this.id = id; // id of the *remote* side, as seen by the owner
    this.remote = remote; // filled once both ends exist
    this.open = true;
    this.localId = null;
  }

  send(msg) {
    if (!this.open) return false;
    this.network.enqueue(this, msg);
    return true;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    const other = this.remote;
    this.network.enqueueClose(other);
    this.emit('close');
  }
}

export function createMemoryNetwork() {
  const rooms = new Map(); // code -> host transport
  const queue = []; // { peer (sender side object), msg } delivered to peer.remote
  let counter = 0;
  const stats = { sent: 0, delivered: 0, dropped: 0 };
  const cutLinks = new Set(); // peer objects whose deliveries are dropped

  const network = {
    rooms,
    queue,
    stats,
    enqueue(fromPeer, msg) {
      stats.sent++;
      // JSON round trip: throws for BigInt/cycles, strips functions/Sets.
      const wire = JSON.parse(JSON.stringify(msg));
      queue.push({ type: 'msg', from: fromPeer, msg: wire });
    },
    enqueueClose(targetPeer) {
      if (targetPeer) queue.push({ type: 'close', target: targetPeer });
    },
    // Delivers the oldest pending item. Returns false when nothing is pending.
    deliverOne() {
      const item = queue.shift();
      if (!item) return false;
      if (item.type === 'close') {
        const p = item.target;
        if (p && p.open) { p.open = false; p.emit('close'); }
        return true;
      }
      if (item.type === 'connect') {
        item.host.emit('connection', item.peer);
        return true;
      }
      const target = item.from.remote;
      if (!target || !target.open || cutLinks.has(item.from) || cutLinks.has(target)) { stats.dropped++; return true; }
      stats.delivered++;
      target.emit('message', item.msg);
      return true;
    },
    // Delivers everything currently pending, including messages produced
    // while delivering (bounded so a ping-pong loop can't hang a test).
    flush(limit = 10000) {
      let n = 0;
      while (queue.length && n < limit) { network.deliverOne(); n++; }
      return n;
    },
    // flush() plus microtask turns, until the network is quiet: what a test
    // awaits after any action so every promise chain in the sessions settles.
    async settle(rounds = 50) {
      for (let i = 0; i < rounds; i++) {
        network.flush();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        if (queue.length === 0) {
          await Promise.resolve();
          if (queue.length === 0) return;
        }
      }
    },
    // Drops the next message matching `pred` (default: any) without delivering.
    dropNext(pred = () => true) {
      const i = queue.findIndex((it) => it.type === 'msg' && pred(it.msg, it));
      if (i === -1) return null;
      stats.dropped++;
      return queue.splice(i, 1)[0].msg;
    },
    // Cuts one direction of a link (messages from this peer object are lost).
    cut(peer) { cutLinks.add(peer); },
    uncut(peer) { cutLinks.delete(peer); },
    createTransport(name = `t${++counter}`) {
      const transport = new Emitter();
      transport.name = name;
      transport.peers = [];
      transport.listen = async (code) => {
        if (rooms.has(code)) throw new Error(`room ${code} already exists`);
        rooms.set(code, transport);
        transport.code = code;
      };
      transport.dial = async (code) => {
        const host = rooms.get(code);
        if (!host) { const e = new Error('no such room'); e.code = 'NO_ROOM'; throw e; }
        const joinerId = `${name}#${++counter}`;
        const hostSidePeer = new MemoryPeer(network, joinerId, null);
        const joinerSidePeer = new MemoryPeer(network, host.name, hostSidePeer);
        hostSidePeer.remote = joinerSidePeer;
        hostSidePeer.localId = host.name;
        joinerSidePeer.localId = joinerId;
        host.peers.push(hostSidePeer);
        transport.peers.push(joinerSidePeer);
        // The connection event is itself "in flight": it lands on the host
        // at the next delivery, like a real handshake completing.
        queue.push({ type: 'connect', host, peer: hostSidePeer });
        return joinerSidePeer;
      };
      transport.close = () => {
        if (transport.code) rooms.delete(transport.code);
        for (const p of transport.peers) p.close();
      };
      return transport;
    },
  };
  return network;
}
