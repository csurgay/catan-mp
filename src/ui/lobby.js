// The network lobby, as a Swing dialog in the applet's own look: open a
// room (host) or join one with a 5-letter code, see who sits where, start.
// Hands the session (src/net/session.js) to app.js through `attach`.
//
// Transports: "auto" (default) listens/dials on the MQTT relay and on
// PeerJS/WebRTC at once; "relay" or "peerjs" force one path. ?transport=local
// (BroadcastChannel, two tabs of one browser) exists for trying it alone and
// for the browser test; it is not offered in the dialog unless asked for.
//
// window.__net (tests): host(opts) -> code, join(opts) -> seat, start(seed),
// leave(), state(), session.

import { createHostSession, createClientSession } from '../net/session.js';
import { createBroadcastTransport } from '../net/transports/broadcast.js';
import { createPeerJsTransport, parseBroker, selfTest } from '../net/transports/peerjs.js';
import { createRelayTransport, relaySelfTest, DEFAULT_BROKERS } from '../net/transports/relay.js';
import { createMultiTransport } from '../net/transports/multi.js';
import {
  makeRoomCode, normalizeRoomCode, isRoomCode, roomCodeProblem, cleanName, MAX_NAME,
} from '../net/protocol.js';
import { el, frameDialog, focusButton, messageDialog } from './swing.js';
import { paintHaz } from './paint.js';
import { t, tError } from './i18n.js';

const HEARTBEAT_MS = 4000;
const NAME_KEY = 'catan-mp.name';
const TOKEN_KEY = 'catan-mp.token'; // sessionStorage, per tab: a reload reconnects
const TRANSPORTS = ['auto', 'relay', 'peerjs', 'local'];

function readStored(storage, key) { try { return storage.getItem(key) || ''; } catch { return ''; } }
function writeStored(storage, key, value) { try { storage.setItem(key, value); } catch { /* private mode */ } }

export function createLobby({ applet, attach, detach, stopGame, backToSolo }) {
  const params = new URL(window.location.href).searchParams;
  const qTransport = params.get('transport');
  // ?broker=host:port[/path], ?ice=relay, ?turn=<url>, ?relay=ws://…[,…]:
  // overrides for diagnostics and the tests.
  const brokerOverride = parseBroker(params.get('broker'));
  const iceTransportPolicy = params.get('ice') === 'relay' ? 'relay' : 'all';
  const turnOverride = params.get('turn') ? { turnCredentialUrl: params.get('turn') } : {};
  const relayBrokers = params.get('relay') ? params.get('relay').split(',').map((x) => x.trim()).filter(Boolean) : DEFAULT_BROKERS;

  const state = {
    transport: TRANSPORTS.includes(qTransport) ? qTransport : 'auto',
    showLocal: qTransport === 'local',
    name: cleanName(params.get('name') || readStored(localStorage, NAME_KEY), ''),
    players: Math.max(3, Math.min(6, Number(params.get('players')) || 4)),
    code: normalizeRoomCode(params.get('join') || ''),
    session: null,
    busy: false,
    message: '',
    error: false,
    frame: null, // the open dialog: { kind: 'host'|'join'|'room', ui }
    lastStatus: null,
  };

  // ---------------------------------------------------------------- transports

  function makeTransport() {
    const onStatus = (step, detail) => showNetStatus(step, detail);
    const peer = (cb) => Object.assign(createPeerJsTransport({
      broker: brokerOverride, iceTransportPolicy, ...turnOverride, onStatus: cb,
    }), { name: 'p2p' });
    const relay = (cb) => Object.assign(createRelayTransport({ brokers: relayBrokers, onStatus: cb }), { name: 'relay' });
    if (state.transport === 'local') return createBroadcastTransport({ prefix: 'catan-mp' });
    if (state.transport === 'relay') return relay(onStatus);
    if (state.transport === 'peerjs') return peer(onStatus);
    return createMultiTransport([relay(null), peer(null)], { onStatus });
  }

  function showNetStatus(step, detail) {
    state.lastStatus = { step, detail };
    const key = `net.status.${step}`;
    const text = t(key, { detail: detail || '' });
    if (text !== key && state.busy) setMessage(text);
  }

  function setMessage(msg, isError = false) {
    state.message = msg || '';
    state.error = !!isError;
    const line = state.frame && state.frame.ui.dlg.querySelector('[data-test="net-message"]');
    if (line) { line.textContent = state.message; line.classList.toggle('error', state.error); }
  }

  // ---------------------------------------------------------------- seats

  function seatList() {
    const s = state.session;
    if (!s) return [];
    if (s.role === 'host') return s.peerSeats();
    return (s.lobbyState && s.lobbyState.seats) || [];
  }

  function seatLabel(st) {
    const s = state.session;
    const me = s && s.mySeat === st.seat;
    if (st.comp && !st.autoComp) return t('net.computer');
    const name = st.name || t('net.seat', { n: st.seat });
    const tags = [];
    if (me) tags.push(t('net.you'));
    if (st.host) tags.push(t('net.host'));
    if (!st.connected && !st.host && (st.name || st.taken)) tags.push(t('net.offline'));
    if (st.autoComp) tags.push(t('net.computer'));
    if (!st.name && !st.connected && !st.host && !me && !(s && s.started)) return t('net.free');
    return tags.length ? `${name} (${tags.join(', ')})` : name;
  }

  // ---------------------------------------------------------------- the dialog

  function closeFrame() {
    if (state.frame) { const f = state.frame; state.frame = null; f.ui.close(); }
  }

  function openFrame(kind) {
    closeFrame();
    const ui = frameDialog(applet, {
      title: '', test: `net-${kind}`, onClose: () => { if (state.frame && state.frame.ui === ui) state.frame = null; },
    });
    state.frame = { kind, ui };
    renderFrame();
  }

  function button(parent, text, test, onClick, enabled = true) {
    const b = el('button', 'o-btn text', parent);
    b.type = 'button';
    b.dataset.test = test;
    el('span', null, b).textContent = text;
    b.disabled = !enabled;
    b.addEventListener('mousedown', () => focusButton(b));
    b.addEventListener('click', () => { if (!b.disabled) onClick(); });
    return b;
  }

  function field(parent, label) {
    const row = el('label', 'o-field', parent);
    el('span', 'o-field-label', row).textContent = label;
    return row;
  }

  function nameField(body) {
    const inp = el('input', 'o-input', field(body, t('net.name')));
    inp.type = 'text';
    inp.maxLength = MAX_NAME;
    inp.value = state.name;
    inp.dataset.test = 'net-name';
    inp.addEventListener('input', () => { state.name = cleanName(inp.value, ''); writeStored(localStorage, NAME_KEY, state.name); });
    return inp;
  }

  function transportField(body) {
    const sel = el('select', 'o-input', field(body, t('net.transport')));
    sel.dataset.test = 'net-transport';
    const opts = [['auto', 'net.transportAuto'], ['relay', 'net.transportRelay'], ['peerjs', 'net.transportPeer']];
    if (state.showLocal || state.transport === 'local') opts.push(['local', 'net.transportLocal']);
    for (const [v, key] of opts) {
      const o = el('option', null, sel);
      o.value = v;
      o.textContent = t(key);
    }
    sel.value = state.transport;
    sel.addEventListener('change', () => { state.transport = sel.value; });
    return sel;
  }

  function playersField(body, onChange) {
    const row = field(body, t('net.players'));
    row.dataset.test = 'net-players';
    const group = el('span', 'o-radios', row);
    for (const n of [3, 4, 5, 6]) {
      const lab = el('label', 'o-radio', group);
      const r = el('input', null, lab);
      r.type = 'radio';
      r.name = 'net-players';
      r.value = String(n);
      r.checked = state.players === n;
      r.dataset.test = `net-players-${n}`;
      r.addEventListener('change', () => { state.players = n; if (onChange) onChange(n); });
      el('span', null, lab).textContent = String(n);
    }
  }

  function seatsTable(body, editable) {
    const box = el('div', 'o-seats', body);
    box.dataset.test = 'net-seats';
    const s = state.session;
    for (const st of seatList()) {
      const row = el('div', 'o-seat', box);
      row.dataset.test = `net-lobby-seat-${st.seat}`;
      const c = el('canvas', null, row);
      c.width = 30; c.height = 22;
      paintHaz(c.getContext('2d'), 2, st.seat, 4, 1);
      el('span', 'o-seat-name', row).textContent = seatLabel(st);
      if (editable && !st.host && !s.started) {
        const lab = el('label', 'o-check', row);
        const cb = el('input', null, lab);
        cb.type = 'checkbox';
        cb.checked = !!st.comp;
        cb.dataset.test = `net-seat-computer-${st.seat}`;
        cb.addEventListener('change', () => { s.setSeatComputer(st.seat, cb.checked); renderFrame(); });
        el('span', null, lab).textContent = t('net.asComputer');
      }
      if (editable && s.started && !st.host && !st.comp && !st.connected) {
        button(row, t('net.handToComputer'), `net-hand-${st.seat}`, () => { s.handSeatToComputer(st.seat); renderFrame(); });
      }
    }
    return box;
  }

  function messageLine(body) {
    const m = el('div', 'o-net-message', body);
    m.dataset.test = 'net-message';
    m.textContent = state.message;
    m.classList.toggle('error', state.error);
  }

  function inviteLink(code) {
    const u = new URL(window.location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('join', code);
    if (state.transport !== 'auto') u.searchParams.set('transport', state.transport);
    for (const k of ['relay', 'broker', 'lang']) if (params.get(k)) u.searchParams.set(k, params.get(k));
    return u.toString();
  }

  function codeBlock(body, code) {
    const row = field(body, t('net.code'));
    const c = el('span', 'o-code', row);
    c.textContent = code;
    c.dataset.test = 'net-code';
    const hint = el('div', 'o-hint', body);
    hint.textContent = t('net.codeHint');
    const btns = el('div', 'o-net-buttons left', body);
    const b = button(btns, t('net.copyLink'), 'net-copy', async () => {
      try { await navigator.clipboard.writeText(inviteLink(code)); setMessage(t('net.copied')); } catch { setMessage(inviteLink(code)); }
    });
    b.title = inviteLink(code);
  }

  function renderFrame() {
    if (!state.frame) return;
    const { kind, ui } = state.frame;
    const body = ui.body;
    body.innerHTML = '';
    const s = state.session;
    if (kind === 'host' && !s) {
      ui.setTitle(t('net.hostTitle'));
      const nameIn = nameField(body);
      transportField(body);
      playersField(body);
      messageLine(body);
      const btns = el('div', 'o-net-buttons', body);
      button(btns, t('net.open'), 'net-open', () => hostRoom().catch(() => {}), !state.busy);
      button(btns, t('net.close'), 'net-cancel', closeFrame);
      if (!state.busy) setTimeout(() => nameIn.focus(), 0);
    } else if (kind === 'join' && !s) {
      ui.setTitle(t('net.joinTitle'));
      nameField(body);
      const codeIn = el('input', 'o-input o-code-input', field(body, t('net.code')));
      codeIn.maxLength = 8;
      codeIn.value = state.code;
      codeIn.dataset.test = 'net-code-input';
      codeIn.autocapitalize = 'characters';
      codeIn.addEventListener('input', () => { state.code = normalizeRoomCode(codeIn.value); });
      codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom().catch(() => {}); });
      transportField(body);
      messageLine(body);
      const btns = el('div', 'o-net-buttons', body);
      button(btns, t('net.join'), 'net-join-button', () => joinRoom().catch(() => {}), !state.busy);
      button(btns, t('net.close'), 'net-cancel', closeFrame);
      if (!state.busy) setTimeout(() => (state.code ? codeIn : body.querySelector('[data-test="net-name"]')).focus(), 0);
    } else if (s) {
      ui.setTitle(t('net.roomTitle', { code: s.code || '?' }));
      codeBlock(body, s.code || '?');
      const host = s.role === 'host';
      if (host && !s.started) playersField(body, (n) => { try { s.setNumPlayers(n); } catch (err) { setMessage(tError(err), true); } renderFrame(); });
      seatsTable(body, host);
      if (!s.started) el('div', 'o-hint', body).textContent = host ? t('net.startHint') : t('net.waiting');
      messageLine(body);
      const btns = el('div', 'o-net-buttons', body);
      if (host && !s.started) button(btns, t('net.start'), 'net-start', () => startRoom());
      if (host && s.started) button(btns, t('menu.newInRoom'), 'net-restart', () => { restart(); });
      if (s.started) button(btns, t('net.close'), 'net-close', closeFrame);
      button(btns, t('net.leave'), 'net-leave', () => leaveRoom());
    }
    ui.center();
  }

  // ---------------------------------------------------------------- actions

  function bindSession(s) {
    const rerender = () => { if (state.session === s) renderFrame(); };
    s.on('lobby', rerender);
    s.on('peer', rerender);
    s.on('start', () => { if (state.session === s && state.frame && !state.frame.manual) closeFrame(); });
    s.on('refused', (r) => setMessage(tError(r), true));
  }

  async function hostRoom(opts = {}) {
    if (state.session) throw new Error('already in a room');
    state.busy = true;
    setMessage(t('net.creating'));
    renderFrame();
    const transport = makeTransport();
    const s = createHostSession({
      transport,
      name: opts.name || state.name || t('net.host'),
      numPlayers: opts.players || state.players,
      seed: opts.seed,
      heartbeatMs: HEARTBEAT_MS,
    });
    try {
      const code = await s.open(opts.code || makeRoomCode());
      state.session = s;
      state.code = code;
      // The other seats wait for people unless told otherwise.
      for (let i = 2; i <= s.seatCount; i++) s.setSeatComputer(i, !!(opts.computer && opts.computer[i - 1]));
      bindSession(s);
      stopGame();
      attach(s);
      state.busy = false;
      setMessage('');
      if (state.frame) renderFrame(); else openFrame('room');
      return code;
    } catch (err) {
      state.busy = false;
      try { transport.close(); } catch { /* ignore */ }
      setMessage(tError(err), true);
      renderFrame();
      throw err;
    }
  }

  function startRoom(seed) {
    const s = state.session;
    if (!s || s.role !== 'host') return false;
    try {
      s.start(seed !== undefined ? seed : Date.now());
    } catch (err) {
      setMessage(tError(err), true);
      return false;
    }
    closeFrame();
    return true;
  }

  function restart(seed) {
    const s = state.session;
    if (!s || s.role !== 'host' || !s.started) return false;
    s.start(seed !== undefined ? seed : Date.now());
    closeFrame();
    return true;
  }

  async function joinRoom(opts = {}) {
    if (state.session) throw new Error('already in a room');
    const code = normalizeRoomCode(opts.code || state.code);
    state.code = code;
    const problem = roomCodeProblem(code);
    if (problem) {
      setMessage(t(`err.${problem}`, { n: code.length }), true);
      throw Object.assign(new Error('bad code'), { code: problem });
    }
    state.busy = true;
    setMessage(t('net.joining'));
    renderFrame();
    const transport = makeTransport();
    const s = createClientSession({
      transport,
      code,
      name: opts.name || state.name || t('net.you'),
      token: readStored(sessionStorage, `${TOKEN_KEY}.${code}`) || undefined,
      heartbeatMs: HEARTBEAT_MS,
    });
    bindSession(s);
    try {
      const w = await s.join();
      state.session = s;
      writeStored(sessionStorage, `${TOKEN_KEY}.${code}`, s.token);
      stopGame();
      attach(s);
      state.busy = false;
      setMessage('');
      if (s.started) closeFrame(); else if (state.frame) renderFrame(); else openFrame('room');
      return w.seat;
    } catch (err) {
      state.busy = false;
      try { s.close(); } catch { /* ignore */ }
      setMessage(tError(err, { n: code.length }), true);
      renderFrame();
      throw err;
    }
  }

  function leaveRoom({ solo = true } = {}) {
    const s = state.session;
    state.session = null;
    if (s) { try { s.close('host left'); } catch { /* ignore */ } }
    closeFrame();
    state.message = '';
    if (solo) backToSolo(); else detach();
  }

  // The host closed the room (or the connection broke for good).
  function hostGone(reason) {
    if (!state.session || state.session.role !== 'client') return;
    messageDialog(applet, t('dlg.warning'), `${t('net.hostLeft')}${reason ? ` (${reason})` : ''}`, 'warning');
  }

  async function connectionTest() {
    if (state.busy) return null;
    state.busy = true;
    const report = { mqtt: null, direct: null };
    const lines = [];
    try {
      report.mqtt = await relaySelfTest({ brokers: relayBrokers });
      const m = report.mqtt;
      lines.push(m.ok
        ? t('net.testMqttOk', { broker: m.broker.replace(/^wss?:\/\//, '').replace(/[:/].*$/, ''), connect: ((m.brokerMs + m.connectMs) / 1000).toFixed(1), rtt: m.roundTripMs })
        : t('net.testMqttFailed', { reason: tError(m.error || m) }));
      report.direct = await selfTest({ broker: brokerOverride, ...turnOverride });
      const d = report.direct;
      lines.push(d.ok
        ? t('net.testOk', { broker: (d.brokerMs / 1000).toFixed(1), connect: (d.connectMs / 1000).toFixed(1), path: d.candidate || '?' })
        : t('net.testFailed', { reason: tError(d.error || d) }));
    } catch (err) {
      lines.push(tError(err));
    } finally {
      state.busy = false;
    }
    state.lastTest = report;
    await messageDialog(applet, t('menu.test'), lines.join('  ·  '), 'info');
    return report;
  }

  function boot() {
    if (params.get('join')) openJoin();
    else if (params.get('host') === '1') openHost();
    // Leaving the page while in a room: tell the others now, not after a timeout.
    window.addEventListener('pagehide', () => { if (state.session) { try { state.session.close('host left'); } catch { /* ignore */ } } });
  }

  function openHost() { if (!state.session) openFrame('host'); }
  function openJoin() { if (!state.session) openFrame('join'); }
  function openRoom() {
    if (!state.session) return;
    openFrame('room');
    if (state.frame) state.frame.manual = true;
  }

  const api = {
    openHost,
    openJoin,
    openRoom,
    restart,
    leave: () => leaveRoom(),
    connectionTest,
    refresh: renderFrame,
    seatList,
    seatLabel,
    hostGone,
    boot,
    get session() { return state.session; },
  };

  window.__net = {
    async host(opts = {}) {
      if (opts.transport) state.transport = opts.transport;
      if (opts.name) state.name = opts.name;
      if (opts.players) state.players = opts.players;
      return hostRoom(opts);
    },
    async join(opts = {}) {
      if (opts.transport) state.transport = opts.transport;
      if (opts.name) state.name = opts.name;
      return joinRoom(opts);
    },
    start: (seed) => startRoom(seed),
    restart: (seed) => restart(seed),
    leave: () => leaveRoom(),
    setSeatComputer(seat, comp) { if (state.session && state.session.role === 'host') { state.session.setSeatComputer(seat, comp); renderFrame(); } },
    state() {
      const s = state.session;
      return {
        transport: state.transport,
        code: state.code,
        busy: state.busy,
        message: state.message,
        frame: state.frame ? state.frame.kind : null,
        lastStatus: state.lastStatus,
        session: s ? s.status() : null,
        seats: s ? seatList() : null,
      };
    },
    get session() { return state.session; },
    isRoomCode,
  };

  return api;
}
