// "Internet" = relay + peer-to-peer combined, so a player never has to
// choose. The host listens on every transport at once; a joiner dials
// them in order (relay first: it works from anywhere, then WebRTC) and
// keeps the first that answers. Peers, statuses and errors are forwarded
// unchanged; the failure reported is the last transport's, with the
// earlier ones' codes attached for the lobby's diagnostics.
//
// Same interface as memory.js (see the header there).

import { Emitter } from '../emitter.js';

export function createMultiTransport(transports, { onStatus } = {}) {
  const multi = new Emitter();
  multi.transports = transports;
  multi.active = null;
  multi.attempts = [];
  const status = (step, detail) => { multi.lastStatus = step; if (onStatus) { try { onStatus(step, detail); } catch { /* ignore */ } } multi.emit('status', { step, detail }); };
  for (const t of transports) {
    t.on('connection', (peer) => multi.emit('connection', peer));
    t.on('status', ({ step, detail }) => status(step, detail));
  }

  multi.listen = async (code) => {
    const results = await Promise.allSettled(transports.map((t) => t.listen(code)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    if (ok === 0) {
      const err = results[results.length - 1].reason || new Error('no transport could listen');
      throw err;
    }
    multi.listening = transports.filter((_, i) => results[i].status === 'fulfilled');
    return code;
  };

  multi.dial = async (code) => {
    let lastErr = null;
    multi.attempts = [];
    for (let i = 0; i < transports.length; i++) {
      const t = transports[i];
      status('try', t.name || `transport ${i + 1}`);
      try {
        // eslint-disable-next-line no-await-in-loop
        const peer = await t.dial(code);
        multi.active = t;
        // The others are not needed any more.
        for (const other of transports) if (other !== t) { try { other.close(); } catch { /* ignore */ } }
        return peer;
      } catch (err) {
        lastErr = err;
        multi.attempts.push({ transport: t.name || `transport ${i + 1}`, code: (err && err.code) || 'ERROR', message: String((err && err.message) || err) });
        try { t.close(); } catch { /* ignore */ }
      }
    }
    const err = lastErr || new Error('no transport could connect');
    err.attempts = multi.attempts.slice();
    throw err;
  };

  multi.close = () => {
    for (const t of transports) { try { t.close(); } catch { /* ignore */ } }
  };

  return multi;
}
