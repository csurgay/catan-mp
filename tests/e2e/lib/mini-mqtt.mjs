// A tiny MQTT 3.1.1 broker over WebSocket, for the browser tests only: just
// what the relay transport (src/net/transports/relay.js) uses -- CONNECT,
// SUBSCRIBE/UNSUBSCRIBE on exact topics, PUBLISH at QoS 0/1, PING,
// DISCONNECT. No retained messages, no sessions, no wildcards. Plain Node,
// no dependencies (the WebSocket handshake and framing are done here).
//
//   const b = await startMiniMqtt();   // b.url = 'ws://127.0.0.1:<port>/mqtt'
//   ...; await b.stop();

import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ------------------------------------------------------------------ WebSocket (server side, RFC 6455)

function wsFrame(payload, opcode = 2) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); } else {
    head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

// Feeds raw socket bytes, calls onMessage(Buffer) per complete data message.
function wsReader(onMessage, onControl) {
  let buf = Buffer.alloc(0);
  let fragments = [];
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) {
        if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskOff + (i % 4)];
      buf = buf.subarray(off + len);
      if (opcode >= 8) { onControl(opcode, payload); continue; }
      fragments.push(payload);
      if (fin) { const msg = Buffer.concat(fragments); fragments = []; onMessage(msg); }
    }
  };
}

// ------------------------------------------------------------------ MQTT packets

function encodeLength(n) {
  const out = [];
  do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 0x80; out.push(b); } while (n > 0);
  return Buffer.from(out);
}

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);
}

function str(s) {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }

// Splits a byte stream into MQTT packets: onPacket(type, flags, body).
function mqttReader(onPacket) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      let mult = 1; let len = 0; let i = 1; let b;
      do {
        if (i >= buf.length) return;
        b = buf[i++];
        len += (b & 0x7f) * mult;
        mult *= 128;
      } while (b & 0x80);
      if (buf.length < i + len) return;
      const type = buf[0] >> 4;
      const flags = buf[0] & 0x0f;
      const body = buf.subarray(i, i + len);
      buf = buf.subarray(i + len);
      onPacket(type, flags, body);
    }
  };
}

// ------------------------------------------------------------------ the broker

export function startMiniMqtt({ port = 0, host = '127.0.0.1' } = {}) {
  const clients = new Set();
  const server = http.createServer((req, res) => { res.writeHead(426); res.end('websocket only'); });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
    if (protos.length) lines.push(`Sec-WebSocket-Protocol: ${protos.includes('mqtt') ? 'mqtt' : protos[0]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    socket.setNoDelay(true);

    const client = { socket, subs: new Map(), nextId: 1, alive: true };
    clients.add(client);
    const send = (buf) => { if (client.alive) socket.write(wsFrame(buf)); };
    const drop = () => { if (!client.alive) return; client.alive = false; clients.delete(client); socket.destroy(); };
    client.send = send;

    const onPacket = (type, flags, body) => {
      switch (type) {
        case 1: // CONNECT
          send(packet(2, 0, Buffer.from([0, 0])));
          break;
        case 3: { // PUBLISH
          const qos = (flags >> 1) & 3;
          const tl = body.readUInt16BE(0);
          const topic = body.subarray(2, 2 + tl).toString('utf8');
          let off = 2 + tl;
          if (qos > 0) { const id = body.readUInt16BE(off); off += 2; send(packet(4, 0, u16(id))); }
          const payload = body.subarray(off);
          for (const c of clients) {
            const subQos = c.subs.get(topic);
            if (subQos === undefined) continue;
            const q = Math.min(qos, subQos, 1);
            const parts = [str(topic)];
            if (q > 0) { parts.push(u16(c.nextId)); c.nextId = (c.nextId % 65535) + 1; }
            parts.push(payload);
            c.send(packet(3, q << 1, Buffer.concat(parts)));
          }
          break;
        }
        case 4: break; // PUBACK from a client
        case 8: { // SUBSCRIBE
          const id = body.readUInt16BE(0);
          let off = 2;
          const granted = [];
          while (off < body.length) {
            const tl = body.readUInt16BE(off);
            const topic = body.subarray(off + 2, off + 2 + tl).toString('utf8');
            const q = Math.min(body[off + 2 + tl] & 3, 1);
            client.subs.set(topic, q);
            granted.push(q);
            off += 3 + tl;
          }
          send(packet(9, 0, Buffer.concat([u16(id), Buffer.from(granted)])));
          break;
        }
        case 10: { // UNSUBSCRIBE
          const id = body.readUInt16BE(0);
          let off = 2;
          while (off < body.length) {
            const tl = body.readUInt16BE(off);
            client.subs.delete(body.subarray(off + 2, off + 2 + tl).toString('utf8'));
            off += 2 + tl;
          }
          send(packet(11, 0, u16(id)));
          break;
        }
        case 12: send(packet(13, 0, Buffer.alloc(0))); break; // PINGREQ
        case 14: drop(); break; // DISCONNECT
        default: break;
      }
    };
    const readMqtt = mqttReader(onPacket);
    const readWs = wsReader(readMqtt, (opcode, payload) => {
      if (opcode === 8) { try { socket.write(wsFrame(Buffer.alloc(0), 8)); } catch { /* ignore */ } drop(); } else if (opcode === 9) socket.write(wsFrame(payload, 10));
    });
    socket.on('data', (chunk) => { try { readWs(chunk); } catch { drop(); } });
    socket.on('close', drop);
    socket.on('error', drop);
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const { port: p } = server.address();
      resolve({
        url: `ws://${host}:${p}/mqtt`,
        clients: () => clients.size,
        // Cuts every connection (a broker outage, for the tests).
        kick: () => { for (const c of [...clients]) c.socket.destroy(); },
        stop: () => new Promise((r) => { for (const c of [...clients]) c.socket.destroy(); server.close(() => r()); }),
      });
    });
  });
}
