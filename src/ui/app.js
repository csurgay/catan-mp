// The game as the 2004 applet looked and handled, on top of the engine
// (game.js) and the computer player (ai.js), playable alone against the
// computer or by several people over the network (src/net, lobby.js).
//
// Network play: a session (src/net/session.js) owns the game. Every engine
// call goes through call(), which in a room becomes session.submit(); the
// computer seats are driven by the host only (session.submit({kind:'ai'}));
// the other pages apply what the host sends and re-render on 'applied'.
// Layout, sizes and behaviour follow the applet's own classes:
//   S.java (main panel), PlayerSelect, Kocka, Player (price card, decks),
//   Deck/Card (hand), Csere (trade panel), Rablo, Settlers (menus).
// Coordinates below are the applet's: the main panel S sits under a 21 px
// menu bar, and everything inside it is absolutely positioned.

import { createGame, GameError, COST } from '../engine/game.js';
import { createAI } from '../engine/ai.js';
import { preloadAssets, RESOURCE_IMAGE, DEVCARD_IMAGE } from './assets.js';
import {
  paintBoard, paintHaz, paintDice, DICE_W, DICE_H, BOARD_X, BOARD_Y, PLAYER_COLORS,
} from './paint.js';
import {
  el, imageButton, createMenuBar, optionDialog, messageDialog, dialogOpen, paintBevel, focusButton, iconSrc,
} from './swing.js';
import { t, tError, getLang, setLang } from './i18n.js';
import { createLobby } from './lobby.js';

const RES = 'ftbjk';
const RES_ICONS = RES.split('').map((r) => ({ icon: RESOURCE_IMAGE[r] }));
const BIG_CARD = { l: 'lovag232.jpg', u: 'utepito232.jpg', f: 'felfedezes232.jpg', m: 'monopol232.jpg' };
const CURSOR = { settlement: ['hazCursor', 6, 10], city: ['varosCursor', 10, 10], road: ['utCursor', 15, 3], robber: ['rabloCursor', 15, 18] };

// Timings (CompAction / Kocka), index 0 = ?test=1, 1 = Fast Animation, 2 = normal.
// The applet's Fast Animation was 1 ms per step, which hides what the
// computer players did; here it stays quick but every move is still seen.
const DICE_TICKS = [[1, 1, 1, 1, 1, 1], [60, 60, 60, 60, 60, 50], [300, 200, 100, 100, 100, 100]];
const AI_BIG = [1, 300, 800]; // nagyTime: building, placing, deciding a trade
const AI_SMALL = [1, 100, 250];

const params = new URL(window.location.href).searchParams;
const testMode = params.get('test') === '1';

// ------------------------------------------------------------------ state

const settings = {
  players: clampInt(params.get('players'), 3, 6, 6), // "Game for 6 players" was the default
  beginner: 1,
  computer: parseComputer(params.get('computer')),
  fast: testMode,
  pakli: false,
  internals: false,
  order: false,
  openHands: false,
};

let game = null;
let ai = null;
let firstSeed = params.has('seed') ? Number(params.get('seed')) : null;
let paused = false;
let sel = new Set(); // selected hand cards (indices) of the shown player
let selKey = '';
let savedSel = null; // Deck.saveSelect() while hovering a price-card slot
let carrying = null; // 'settlement' | 'city' | 'road' | 'robber'
let hoverPlayer = 0; // PlayerSelect hover
let diceShown = [4, 3];
let diceAnim = null;
let aiTimer = null;
let pendingOffers = []; // the trade panel while the offerer is still composing
let busy = false; // a dialog sequence is running
let announcedWinner = 0;
const revealed = new WeakSet(); // dev cards the owner turned face up
let seenLog = 0; // game.log entries already looked at (dice faces)

// Network play: { session, offs, closed } while this page is in a room.
let net = null;

function clampInt(v, lo, hi, def) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}
function parseComputer(v) {
  // Default: player 1 human, the rest computer. ?computer=011111 overrides.
  if (v && /^[01]{1,6}$/.test(v)) return Array.from({ length: 6 }, (_, i) => v[i] === '1');
  return [false, true, true, true, true, true];
}

// ------------------------------------------------------------------ DOM

const applet = document.getElementById('applet');
const sPanel = el('div', null, applet);
sPanel.id = 'o-s';

const boardCanvas = el('canvas', null, sPanel);
boardCanvas.id = 'o-board';
boardCanvas.width = 1024;
boardCanvas.height = 768;
boardCanvas.dataset.test = 'board';
const bctx = boardCanvas.getContext('2d');

// Longest road / largest army cards lying on the table (S.utLabel/hadseregLabel).
const tableArmy = imgAt(sPanel, 'hadsereg', 0, 0);
const tableRoad = imgAt(sPanel, 'ut', 0, 0);

// The player panel (Player.java), 900x320 at (5, 290).
const panel = el('div', 'o-abs', sPanel);
Object.assign(panel.style, { left: '5px', top: '290px', width: '900px', height: '320px', pointerEvents: 'none' });
const plArmy = imgAt(panel, 'hadsereg', 270, 10);
const plRoad = imgAt(panel, 'ut', 270, 117);
const arak = imgAt(panel, 'arak', 5, 10);
const slotCanvas = el('canvas', 'o-abs', panel);
slotCanvas.width = 190; slotCanvas.height = 216;
Object.assign(slotCanvas.style, { left: '5px', top: '10px' });
const sctx = slotCanvas.getContext('2d');
const eDeck = el('div', 'o-abs', panel);
Object.assign(eDeck.style, { left: '205px', top: '10px' });
const rDeck = el('div', 'o-abs', panel);
Object.assign(rDeck.style, { left: '5px', top: '210px' });
// Price-card hot spots (UtClass x2, Haz x2, EntwClass), relative to the panel.
const SLOTS = {
  road1: [155, 56, 34, 10], road2: [155, 46, 34, 10], settlement: [164, 102, 27, 24], city: [156, 147, 27, 24], devcard: [155, 180, 34, 34],
};
const slotNodes = {};
for (const [k, [x, y, w, h]] of Object.entries(SLOTS)) {
  const d = el('div', 'o-abs', panel);
  Object.assign(d.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, pointerEvents: 'auto' });
  d.dataset.test = `slot-${k}`;
  d.addEventListener('mouseenter', () => slotEnter(k));
  d.addEventListener('mouseleave', () => slotLeave(k));
  d.addEventListener('click', () => slotClick(k));
  slotNodes[k] = d;
}

// PlayerSelect, 255x45 at (10, 180), lowered BevelBorder.
const psCanvas = el('canvas', 'o-abs', sPanel);
psCanvas.width = 255; psCanvas.height = 45;
Object.assign(psCanvas.style, { left: '10px', top: '180px' });
psCanvas.dataset.test = 'player-select';
const psctx = psCanvas.getContext('2d');

// Kocka at (10, 230), lowered SoftBevelBorder.
const diceCanvas = el('canvas', 'o-abs', sPanel);
diceCanvas.width = DICE_W; diceCanvas.height = DICE_H;
Object.assign(diceCanvas.style, { left: '10px', top: '230px' });
diceCanvas.dataset.test = 'dice';
const dctx = diceCanvas.getContext('2d');

// The three buttons: becserel (4:1), csere (trade), kovetkezo (next).
const btnBank = imageButton(sPanel, 'becserelButton', 120, 230, 46, 60, onBank);
const btnTrade = imageButton(sPanel, 'csereButton', 170, 230, 46, 60, onTrade);
const btnNext = imageButton(sPanel, 'kovetkezoButton', 220, 230, 46, 60, onNext);
btnBank.node.dataset.test = 'btn-bank';
btnTrade.node.dataset.test = 'btn-trade';
btnNext.node.dataset.test = 'btn-next';

// Internals (round counter) at (10, 10) and the Entwicklungs deck at (300, 0).
const internalsBox = el('div', 'o-abs', sPanel);
Object.assign(internalsBox.style, { left: '15px', top: '12px', font: '12px Arial, Helvetica, sans-serif', pointerEvents: 'none' });
const pakliBox = el('div', 'o-abs', sPanel);
// The room (network play), in the free corner above the player strip.
const netBox = el('div', 'o-abs', sPanel);
netBox.id = 'o-net';
netBox.dataset.test = 'net-status';
netBox.style.display = 'none';
Object.assign(pakliBox.style, { left: '300px', top: '0px', zIndex: 30, pointerEvents: 'none' });

// Csere: the green trade panel.
const tradeBox = el('div', null, sPanel);
tradeBox.id = 'o-trade';
tradeBox.dataset.test = 'trade-panel';
tradeBox.style.display = 'none';

function imgAt(parent, name, x, y) {
  const im = el('img', 'o-label', parent);
  im.src = iconSrc(name);
  im.alt = '';
  im.draggable = false;
  im.style.left = `${x}px`;
  im.style.top = `${y}px`;
  return im;
}

// ------------------------------------------------------------------ menus (Settlers.createGUI)

const inRoom = () => !!net;
const isHost = () => !!(net && net.session.role === 'host');

const menubar = createMenuBar(applet, [
  {
    title: () => t('menu.new'), test: 'New',
    items: () => [3, 4, 5, 6].map((n) => ({
      kind: 'radio', label: t('menu.gameFor', { n }), test: `new-${n}`, checked: game && game.numPlayers === n,
      onSelect: () => {
        if (inRoom()) lobby.leave();
        settings.players = n; if (settings.beginner > n) settings.beginner = 1; newGame();
      },
    })),
  },
  {
    title: () => t('menu.players'), test: 'Players',
    items: () => [
      { kind: 'item', label: t('menu.willBegin'), icon: `pl${settings.beginner}Icon`, test: 'who-begins' },
      { kind: 'sep' },
      {
        kind: 'sub', label: t('menu.playerToBegin'), test: 'player-to-begin',
        items: [1, 2, 3, 4, 5, 6].map((i) => ({
          kind: 'item', label: t('menu.willBegin'), icon: `pl${i}Icon`, test: `begin-${i}`, enabled: i <= settings.players,
          onSelect: () => { settings.beginner = i; },
        })),
      },
    ],
  },
  {
    title: () => t('menu.computer'), test: 'Computer',
    items: () => [
      { kind: 'item', label: t('menu.allComputer'), test: 'all-computer', enabled: !inRoom(), onSelect: () => setAllComputer(true) },
      { kind: 'item', label: t('menu.allHuman'), test: 'all-human', enabled: !inRoom(), onSelect: () => setAllComputer(false) },
      { kind: 'sep' },
      ...[1, 2, 3, 4, 5, 6].map((i) => ({
        kind: 'check', label: t('menu.seatComputer'), icon: `pl${i}Icon`, test: `computer-${i}`,
        checked: game && i <= game.numPlayers ? game.players[i].comp : settings.computer[i - 1],
        enabled: !inRoom() && (game ? i <= game.numPlayers : true),
        onSelect: () => toggleComputer(i),
      })),
    ],
  },
  {
    title: () => t('menu.options'), test: 'Options',
    items: () => [
      { kind: 'check', label: t('menu.fast'), test: 'fast', checked: settings.fast, onSelect: () => { settings.fast = !settings.fast; } },
      // The deck and the other hands are secrets in a room.
      { kind: 'check', label: t('menu.pakli'), test: 'pakli', checked: settings.pakli, enabled: !inRoom(), onSelect: () => { settings.pakli = !settings.pakli; render(); } },
      { kind: 'check', label: t('menu.internals'), test: 'internals', checked: settings.internals, onSelect: () => { settings.internals = !settings.internals; render(); } },
      { kind: 'check', label: t('menu.order'), test: 'order', checked: settings.order, onSelect: () => { settings.order = !settings.order; render(); } },
      { kind: 'check', label: t('menu.openHands'), test: 'open-hands', checked: settings.openHands, enabled: !inRoom(), onSelect: () => { settings.openHands = !settings.openHands; render(); } },
    ],
  },
  {
    title: () => t('menu.network'), test: 'Network',
    items: () => {
      const started = !!(net && net.session.started && !net.closed);
      const mine = started && game && game.players[net.session.mySeat];
      return [
        { kind: 'item', label: t('menu.host'), test: 'net-host', enabled: !inRoom(), onSelect: () => lobby.openHost() },
        { kind: 'item', label: t('menu.join'), test: 'net-join', enabled: !inRoom(), onSelect: () => lobby.openJoin() },
        { kind: 'item', label: t('menu.room'), test: 'net-room', enabled: inRoom(), onSelect: () => lobby.openRoom() },
        { kind: 'sep' },
        { kind: 'item', label: t('menu.newInRoom'), test: 'net-new', enabled: isHost() && started, onSelect: () => lobby.restart() },
        {
          kind: 'check', label: t('menu.botForMe'), test: 'net-bot-me', enabled: isHost() && started && game.phase !== 'gameOver',
          checked: !!(mine && mine.comp), onSelect: () => { net.session.setOwnSeatComputer(!mine.comp); afterAction(); },
        },
        { kind: 'item', label: t('menu.leave'), test: 'net-leave', enabled: inRoom(), onSelect: () => lobby.leave() },
        { kind: 'sep' },
        { kind: 'item', label: t('menu.test'), test: 'net-test', enabled: !inRoom(), onSelect: () => lobby.connectionTest() },
      ];
    },
  },
  {
    title: () => t('menu.language'), test: 'Language',
    items: () => [
      { kind: 'radio', label: 'Magyar', test: 'lang-hu', checked: getLang() === 'hu', onSelect: () => changeLang('hu') },
      { kind: 'radio', label: 'English', test: 'lang-en', checked: getLang() === 'en', onSelect: () => changeLang('en') },
    ],
  },
]);

function changeLang(lang) {
  setLang(lang);
  document.documentElement.lang = lang;
  menubar.refresh();
  lobby.refresh();
  render();
}

function setAllComputer(on) {
  if (inRoom()) return;
  for (let i = 1; i <= 6; i++) settings.computer[i - 1] = on;
  if (game) for (let i = 1; i <= game.numPlayers; i++) if (game.players[i].comp !== on) game.setComputer(i, on);
  paused = false;
  afterAction();
}
function toggleComputer(i) {
  if (inRoom()) return;
  settings.computer[i - 1] = !settings.computer[i - 1];
  if (game && i <= game.numPlayers) game.setComputer(i, !game.players[i].comp);
  afterAction();
}

// ------------------------------------------------------------------ game lifecycle

function newGame(opts = {}) {
  stopAi();
  const n = opts.players || settings.players;
  let seed = opts.seed !== undefined ? opts.seed : firstSeed;
  if (seed === null || !Number.isFinite(seed)) seed = Date.now();
  firstSeed = null;
  game = createGame({
    numPlayers: n, beginner: Math.min(settings.beginner, n), seed,
    computer: settings.computer.slice(0, n),
  });
  ai = createAI();
  resetView();
  render();
  drive();
}

// Forget everything this page knew about the previous game's view.
function resetView() {
  sel = new Set(); selKey = ''; savedSel = null; carrying = null; hoverPlayer = 0;
  pendingOffers = []; paused = false; announcedWinner = 0;
  diceShown = game.dice.slice();
  seenLog = game.log.length;
  setCursor(null);
}

// ------------------------------------------------------------------ seats: who plays where

// A seat played by a person at this page: alone, every human seat (the
// applet's hot seat); in a room, only this page's own seat.
function isLocalSeat(i) {
  if (!game || !game.players[i] || game.players[i].comp) return false;
  if (!net) return true;
  if (net.closed || !net.session.started) return false;
  return net.session.localSeats.has(i);
}

// The hand on the price card when nobody hovers the strip: whoever is to
// act, if that is this page; otherwise, in a room, this page's own seat.
function defaultShown() {
  if (game.phase === 'trade' && game.trade && (!net || isLocalSeat(game.trade.responder))) return game.trade.responder;
  if (!net || isLocalSeat(game.current)) return game.current;
  return net.session.mySeat || game.current;
}

function seatName(i) {
  if (!net || !net.session.config) return '';
  const n = net.session.config.names && net.session.config.names[i - 1];
  return n || '';
}

function shownPlayer() {
  if (hoverPlayer) return hoverPlayer;
  return defaultShown();
}

function humanTurn() {
  return isLocalSeat(game.current) && game.actor() === game.current;
}

function hand() { return game.players[game.current].hand; }
function selString() {
  const h = hand();
  return [...sel].sort((a, b) => a - b).map((i) => h[i]).join('');
}

// Keeps the selection only while it still refers to the same hand.
function syncSelection() {
  const key = `${game.current}|${hand().join('')}`;
  if (key !== selKey) { sel = new Set(); savedSel = null; selKey = key; }
}

// Deck.select(mit): keep the selected cards that are part of `cost`,
// deselect the rest, then select the missing letters from left to right.
function selectCost(cost) {
  const h = hand();
  const need = cost.split('');
  const next = new Set();
  for (const i of [...sel].sort((a, b) => a - b)) {
    const k = need.indexOf(h[i]);
    if (k !== -1) { need.splice(k, 1); next.add(i); }
  }
  for (let i = 0; i < h.length && need.length; i++) {
    if (next.has(i)) continue;
    const k = need.indexOf(h[i]);
    if (k !== -1) { need.splice(k, 1); next.add(i); }
  }
  sel = next;
}
function hasCards(cost) {
  const h = hand().slice();
  for (const c of cost) { const k = h.indexOf(c); if (k === -1) return false; h.splice(k, 1); }
  return true;
}
// Deck.isSelect(mit): the selected cards are exactly `cost`.
function isSelected(cost) {
  return [...selString()].sort().join('') === [...cost].sort().join('');
}

// ------------------------------------------------------------------ engine calls

// One engine action by the seat that is to act. Alone it is a plain method
// call; in a room the session applies it and sends it to the others.
function call(method, ...params) {
  if (!net) return game[method](...params);
  const r = net.session.submit({ kind: 'call', player: game.actor(), call: { method, params } });
  if (!r.ok) throw new GameError(r.error.code, r.error.message);
  return r.ev;
}

function act(fn) {
  try {
    const r = fn();
    afterAction();
    return r;
  } catch (err) {
    if (!(err instanceof GameError)) console.error(err);
    else if (net && /^(NOT_YOUR|DESYNCED|STALE|NOT_STARTED|SEAT_IS)/.test(err.code || '')) {
      messageDialog(applet, t('dlg.warning'), tError(err), 'warning');
    }
    afterAction();
    return err instanceof GameError ? err : null;
  }
}

function afterAction() {
  if (!game) return;
  absorbLog();
  syncSelection();
  if (carrying && !canKeepCarrying()) { carrying = null; setCursor(null); }
  render();
  drive();
}

function canKeepCarrying() {
  if (!humanTurn()) return false;
  if (carrying === 'robber') return game.phase === 'moveRobber';
  const sup = game.players[game.current].supply;
  if (carrying === 'road') return sup.roads > 0;
  if (carrying === 'settlement') return sup.settlement > 0;
  if (carrying === 'city') return sup.city > 0;
  return false;
}

// The dice show the last roll in the log (whoever rolled it, wherever).
function absorbLog() {
  if (seenLog > game.log.length) seenLog = 0;
  for (let i = seenLog; i < game.log.length; i++) {
    const ev = game.log[i];
    if (ev.type === 'roll' && !diceAnim) diceShown = ev.dice.slice();
  }
  seenLog = game.log.length;
}

function setCursor(kind) {
  const c = kind && CURSOR[kind];
  applet.style.cursor = c ? `url(${iconSrc(c[0])}) ${c[1]} ${c[2]}, crosshair` : '';
}

// ------------------------------------------------------------------ the turn engine: computer players and prompts

function speedIndex() {
  if (!settings.fast) return 2;
  return testMode ? 0 : 1;
}

function stopAi() {
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  if (diceAnim) { clearTimeout(diceAnim.timer); diceAnim = null; }
}

function drive() {
  if (!game || busy || dialogOpen() || aiTimer || diceAnim) return;
  if (net && (net.closed || !net.session.started)) return;
  if (game.phase === 'gameOver') { announceWinner(); return; }
  const actor = game.actor();
  const p = game.players[actor];
  if (p.comp) {
    // In a room only the host moves the computer players.
    if (net && net.session.role !== 'host') return;
    if (paused) return;
    if (game.phase === 'roll') { rollDice(() => aiStep()); return; }
    const big = game.phase === 'setup' || game.phase === 'main' || game.phase === 'trade';
    aiTimer = setTimeout(() => { aiTimer = null; aiStep(); }, (big ? AI_BIG : AI_SMALL)[speedIndex()]);
    return;
  }
  // A human must act: here, or at another page of the room.
  if (!isLocalSeat(actor)) return;
  if (game.phase === 'discard') { promptDiscard(); return; }
  if (game.phase === 'chooseVictim') { promptVictim(); }
}

function aiStep() {
  // A seat may have been handed back to a human while the step was pending.
  if (!game || !game.players[game.actor()].comp || game.phase === 'gameOver') { afterAction(); return; }
  if (net) {
    if (net.session.role !== 'host' || net.closed) { afterAction(); return; }
    const r = net.session.submit({ kind: 'ai' });
    if (!r.ok) console.error('AI step', r.error);
  } else {
    try { ai.step(game); } catch (err) { console.error('AI step', err); }
  }
  if (game.phase === 'trade') pendingOffers = [];
  afterAction();
}

// Kocka: six ticks of random faces, then the real roll.
function rollDice(then) {
  const ticks = DICE_TICKS[speedIndex()].slice();
  const tick = () => {
    if (!ticks.length) {
      diceAnim = null;
      then();
      return;
    }
    diceShown = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
    renderDice();
    diceAnim = { timer: setTimeout(tick, ticks.shift()) };
  };
  diceAnim = { timer: setTimeout(tick, 0) };
}

// A roll that happened at another page: the same tumbling, then its faces.
function showRemoteRoll(dice) {
  if (diceAnim) { clearTimeout(diceAnim.timer); diceAnim = null; }
  rollDice(() => { diceShown = dice.slice(); afterAction(); });
}

async function promptDiscard() {
  busy = true;
  const entry = game.discardQueue[0];
  const pl = game.players[entry.player];
  const left = pl.hand.slice();
  const chosen = [];
  while (chosen.length < entry.count) {
    // eslint-disable-next-line no-await-in-loop
    const v = await optionDialog(applet, {
      title: t('dlg.discard'), icon: `pl${entry.player}Icon`, test: 'dialog-discard',
      options: left.map((c) => ({ icon: RESOURCE_IMAGE[c] })),
    });
    if (v >= 0) chosen.push(left.splice(v, 1)[0]);
  }
  busy = false;
  if (!game || game.phase !== 'discard' || game.discardQueue[0] !== entry) { afterAction(); return; }
  act(() => call('discard', entry.player, chosen));
}

async function promptVictim() {
  busy = true;
  const victims = game.robberVictims.slice();
  let v = -1;
  while (v < 0) {
    // eslint-disable-next-line no-await-in-loop
    v = await optionDialog(applet, {
      title: t('dlg.robber'), message: t('dlg.whichToRob'), test: 'dialog-victim',
      options: victims.map((p) => ({ icon: `pl${p}Icon` })),
    });
  }
  busy = false;
  if (!game || game.phase !== 'chooseVictim') { afterAction(); return; }
  act(() => call('chooseVictim', victims[v]));
}

async function announceWinner() {
  if (announcedWinner === game.winner) return;
  announcedWinner = game.winner;
  const winner = game.winner;
  const theGame = game;
  busy = true;
  const name = seatName(winner);
  const points = game.victoryPoints(winner);
  await optionDialog(applet, {
    title: t('dlg.winner'), message: name ? t('dlg.pointsNamed', { name, n: points }) : t('dlg.points', { n: points }),
    icon: `pl${winner}Icon`, test: 'dialog-winner', options: [{ text: 'OK' }],
  });
  busy = false;
  if (game !== theGame || game.phase !== 'gameOver') { afterAction(); return; }
  // The applet never stopped a game; play on. In a room the winner's page
  // says so (or the host, for a computer winner).
  if (!net || isLocalSeat(winner) || (isHost() && game.players[winner].comp)) act(() => call('continueGame'));
  else afterAction();
}

// ------------------------------------------------------------------ input: dice, buttons

diceCanvas.addEventListener('click', () => {
  if (!game || busy || diceAnim) return;
  if (game.phase === 'roll' && humanTurn()) {
    rollDice(() => {
      const before = game.log.length;
      act(() => call('rollDice'));
      const ev = game.log.slice(before).find((e) => e.type === 'roll');
      if (ev) { diceShown = ev.dice.slice(); renderDice(); }
    });
  } else if (isLocalSeat(game.current) && game.phase !== 'setup') {
    messageDialog(applet, t('dlg.warning'), t('dlg.diceOnce'), 'warning');
  }
});

async function onBank() {
  const give = selString();
  if (!give || !humanTurn() || game.phase !== 'main') return;
  const v = await optionDialog(applet, { title: t('dlg.tradingIn'), message: t('dlg.takeResource'), options: RES_ICONS, test: 'dialog-bank' });
  if (v >= 0 && humanTurn() && game.phase === 'main') act(() => call('bankTrade', give, RES[v]));
}

async function onTrade() {
  const give = selString();
  if (!give || !humanTurn() || game.phase !== 'main') return;
  const v = await optionDialog(applet, {
    title: t('dlg.tradeOffer'), message: t('dlg.inReturn'), options: RES_ICONS, test: 'dialog-trade-offer',
  });
  if (v < 0 || pendingOffers.length >= 6) return;
  pendingOffers.push({ give, want: RES[v] });
  render();
}

function onNext() {
  if (!game) return;
  if (!net && allComputer()) { paused = !paused; render(); drive(); return; }
  if (!humanTurn()) return;
  pendingOffers = [];
  act(() => call('endTurn'));
}

function allComputer() {
  for (let i = 1; i <= game.numPlayers; i++) if (!game.players[i].comp) return false;
  return true;
}

// ------------------------------------------------------------------ input: the price card (Player.java)

function slotPieces() {
  const pl = game.players[shownPlayer()];
  const sup = { ...pl.supply };
  if (shownPlayer() === game.current) {
    if (carrying === 'road') sup.roads--;
    if (carrying === 'settlement') sup.settlement--;
    if (carrying === 'city') sup.city--;
  }
  return sup;
}

function slotEmpty(k) {
  const sup = slotPieces();
  if (k === 'road1') return sup.roads < 1;
  if (k === 'road2') return sup.roads < 2;
  if (k === 'settlement') return sup.settlement < 1;
  if (k === 'city') return sup.city < 1;
  return true;
}

const SLOT_COST = { road1: COST.road, settlement: COST.settlement, city: COST.city, devcard: COST.devcard };

function slotEnter(k) {
  if (!game || !humanTurn() || shownPlayer() !== game.current || carrying) return;
  const cost = SLOT_COST[k];
  if (!cost || !slotEmpty(k)) return;
  savedSel = new Set(sel);
  if (!isSelected(cost) && hasCards(cost)) { selectCost(cost); render(); }
}
function slotLeave() {
  if (savedSel) { sel = savedSel; savedSel = null; render(); }
}

function slotClick(k) {
  if (!game || busy || !humanTurn() || shownPlayer() !== game.current) return;
  const kind = k === 'road1' || k === 'road2' ? 'road' : k;
  if (k === 'devcard') {
    if (isSelected(COST.devcard)) { savedSel = null; act(() => call('buy', 'devcard')); }
    return;
  }
  if (!slotEmpty(k)) {
    // A piece is lying on the card: pick it up (unless one is already in hand).
    if (!carrying) { carrying = kind; setCursor(kind); render(); }
    return;
  }
  if (carrying === kind) {
    // Putting it back on the card trades it back into cards (in the main phase).
    carrying = null; setCursor(null);
    if (game.phase === 'main') act(() => call('refund', kind)); else render();
    return;
  }
  if (carrying) return;
  if (k === 'road2') return;
  if (isSelected(SLOT_COST[k])) {
    savedSel = null;
    const r = act(() => call('buy', kind));
    if (r instanceof GameError && r.code === 'LIMIT') {
      const max = { road: 15, settlement: 5, city: 4 }[kind];
      const what = t(`dlg.${{ road: 'roads', settlement: 'houses', city: 'towns' }[kind]}`);
      messageDialog(applet, t('dlg.warning'), t('dlg.limit', { n: max, what }), 'warning');
    }
  }
}

// ------------------------------------------------------------------ input: the board (S.mouseClicked, Haz.mouseClicked)

function boardPoint(e) {
  const r = sPanel.getBoundingClientRect();
  const scale = r.width / 1024;
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
}

sPanel.addEventListener('click', (e) => {
  if (!game || busy || e.target.closest('.o-btn, #o-trade, .o-card, [data-test^="slot-"], [data-test="dice"], [data-test="player-select"]')) return;
  const { x, y } = boardPoint(e);
  const bx = x - BOARD_X;
  const by = y - BOARD_Y;
  if (!humanTurn()) return;
  if (carrying === 'robber') {
    const tile = nearestTile(bx, by, 100);
    if (!tile) return;
    const before = game.log.length;
    const r = act(() => call('moveRobber', tile.idx));
    if (!(r instanceof GameError)) {
      carrying = null; setCursor(null); render();
      const evs = game.log.slice(before);
      if (game.phase !== 'chooseVictim' && !evs.some((ev) => ev.type === 'steal')) {
        messageDialog(applet, t('dlg.robber'), t('dlg.noVictim'), 'info');
      }
    }
    return;
  }
  if (carrying === 'settlement' || carrying === 'city') {
    const j = game.board.junctions.find((jj) => bx >= jj.x - 9 && bx < jj.x + 18 && by >= jj.y - 13 && by < jj.y + 11);
    if (!j) return;
    const kind = carrying;
    const r = act(() => (kind === 'settlement' ? call('placeSettlement', j.no) : call('placeCity', j.no)));
    if (!(r instanceof GameError)) { carrying = null; setCursor(null); render(); }
    return;
  }
  if (carrying === 'road') {
    // The junction nearest the click (within 35 px), then its neighbour that
    // is also within 35 px: the road between them.
    const d = 35;
    let junc = null; let best = Infinity;
    for (const j of game.board.junctions) {
      const m = (bx - j.x) ** 2 + (by - j.y) ** 2;
      if (m < best) { best = m; junc = j; }
    }
    if (!junc || best >= d * d) return;
    let mJunc = null;
    for (const ju of junc.juncs) if ((ju.x - bx) ** 2 + (ju.y - by) ** 2 < d * d) mJunc = ju;
    if (!mJunc) return;
    const r = act(() => call('placeRoad', junc.no, mJunc.no));
    if (!(r instanceof GameError)) { carrying = null; setCursor(null); render(); }
    return;
  }
  // The robber itself: lying down means it may be picked up.
  const rt = game.board.robberTile;
  if (rt) {
    const rx = BOARD_X + rt.x + 10; const ry = BOARD_Y + rt.y - 25;
    const lying = game.phase === 'moveRobber';
    const w = lying ? 47 : 23; const h = lying ? 23 : 47;
    if (x >= rx && x < rx + w && y >= ry && y < ry + h) {
      if (lying) { carrying = 'robber'; setCursor('robber'); render(); } else {
        messageDialog(applet, t('dlg.warning'), t('dlg.robberWhen'), 'warning');
      }
    }
  }
});

function nearestTile(bx, by, maxD) {
  let best = null; let m = maxD * maxD;
  for (const t of game.board.tiles) {
    const d = (t.x - bx) ** 2 + (t.y - by) ** 2;
    if (d < m) { m = d; best = t; }
  }
  return best;
}

// PlayerSelect: hovering a player's town shows that player's panel.
psCanvas.addEventListener('mousemove', (e) => {
  if (!game) return;
  const r = psCanvas.getBoundingClientRect();
  const scale = r.width / 255;
  const x = (e.clientX - r.left) / scale; const y = (e.clientY - r.top) / scale;
  let over = 0;
  for (let i = 1; i <= game.numPlayers; i++) if (x >= i * 42 - 32 && x < i * 42 + 10 && y >= 10 && y < 34) over = i;
  if (over && over !== hoverPlayer) { hoverPlayer = over; render(); }
});
psCanvas.addEventListener('mouseleave', () => { if (hoverPlayer) { hoverPlayer = 0; render(); } });

// ------------------------------------------------------------------ input: cards

function onHandCard(i) {
  if (!game || busy || !humanTurn() || shownPlayer() !== game.current) return;
  savedSel = null;
  if (sel.has(i)) sel.delete(i); else sel.add(i);
  render();
}

async function onDevCard(idx, e) {
  if (!game || busy) return;
  const player = shownPlayer();
  const card = game.players[player].dev[idx];
  if (!card || card.played || player !== game.current || !humanTurn()) return;
  const res = card.res;
  if (e && e.button === 2) {
    if (BIG_CARD[res]) optionDialog(applet, { title: t('dlg.card'), options: [{ icon: BIG_CARD[res] }], test: 'dialog-bigcard' });
    return;
  }
  revealed.add(card);
  render();
  busy = true;
  const v = await optionDialog(applet, { title: t('dlg.card'), options: [{ icon: DEVCARD_IMAGE[res] }, { icon: 'hatlaps' }], test: 'dialog-card' });
  busy = false;
  if (v !== 0) { revealed.delete(card); render(); drive(); return; }
  // The game may have moved on (another page) while a dialog was open.
  const still = () => humanTurn() && game.players[player].dev[idx] === card;
  if (res === 'u') {
    busy = true;
    await messageDialog(applet, t('dlg.roadBuilding'), t('dlg.twoRoads'), 'info');
    busy = false;
    if (still()) act(() => call('playCard', idx)); else afterAction();
  } else if (res === 'f') {
    busy = true;
    const a = await optionDialog(applet, { title: t('dlg.plenty'), message: t('dlg.plenty1'), options: RES_ICONS, test: 'dialog-plenty-1' });
    const b = a < 0 ? -1 : await optionDialog(applet, { title: t('dlg.plenty'), message: t('dlg.plenty2'), options: RES_ICONS, test: 'dialog-plenty-2' });
    busy = false;
    if (a >= 0 && b >= 0 && still()) act(() => call('playCard', idx, { resources: [RES[a], RES[b]] })); else afterAction();
  } else if (res === 'm') {
    busy = true;
    const m = await optionDialog(applet, { title: t('dlg.monopoly'), message: t('dlg.monopolyWhich'), options: RES_ICONS, test: 'dialog-monopoly' });
    busy = false;
    if (m >= 0 && still()) act(() => call('playCard', idx, { resource: RES[m] })); else afterAction();
  } else {
    act(() => call('playCard', idx));
  }
}

// ------------------------------------------------------------------ the trade panel (Csere.java)

function renderTrade() {
  const inGame = game.phase === 'trade' && game.trade;
  const offers = inGame ? game.trade.offers : pendingOffers;
  if (!offers.length) { tradeBox.style.display = 'none'; tradeBox.innerHTML = ''; return; }
  const n = offers.length;
  tradeBox.style.display = 'block';
  Object.assign(tradeBox.style, { left: '450px', top: `${300 - n * 50}px`, width: '430px', height: `${n * 100 + 120}px` });
  tradeBox.innerHTML = '';
  const from = inGame ? game.trade.from : game.current;
  const hazCanvas = el('canvas', 'o-abs', tradeBox);
  hazCanvas.width = 430; hazCanvas.height = 40;
  hazCanvas.style.left = '0'; hazCanvas.style.top = '0';
  const hctx = hazCanvas.getContext('2d');
  paintHaz(hctx, 2, from, 40, 10);
  const responder = inGame ? game.trade.responder : 0;
  if (responder) paintHaz(hctx, 2, responder, 215, 10);
  const respHuman = inGame && isLocalSeat(responder);
  offers.forEach((o, i) => {
    o.give.split('').forEach((c, k) => {
      const im = cardImg(tradeBox, RESOURCE_IMAGE[c], 30 * k + 20, i * 100 + 40);
      im.style.zIndex = String(10 - k);
    });
    cardImg(tradeBox, RESOURCE_IMAGE[o.want], 200, i * 100 + 40);
    const b = textButton(tradeBox, inGame ? t('trade.takeIt') : t('trade.remove'), 300, i * 100 + 70, 100, 40, () => {
      if (!inGame) { pendingOffers.splice(i, 1); render(); return; }
      const r = act(() => call('respondTrade', i));
      if (r instanceof GameError && r.code === 'NO_CARDS') messageDialog(applet, t('dlg.warning'), t('dlg.noCard'), 'warning');
    });
    b.dataset.test = `trade-offer-${i}`;
    if (inGame && !respHuman) b.disabled = true;
  });
  const ok = textButton(tradeBox, inGame ? t('trade.pass') : t('trade.submit'), 160, n * 100 + 60, 100, 40, () => {
    if (!inGame) {
      const list = pendingOffers.slice();
      pendingOffers = [];
      act(() => call('offerTrade', list));
    } else {
      act(() => call('respondTrade', null));
    }
  });
  ok.dataset.test = 'trade-ok';
  if (inGame && !respHuman) ok.disabled = true;
}

function cardImg(parent, name, x, y) {
  const im = el('img', 'o-card', parent);
  im.src = iconSrc(name);
  im.alt = '';
  im.draggable = false;
  im.style.left = `${x}px`;
  im.style.top = `${y}px`;
  return im;
}

function textButton(parent, text, x, y, w, h, onClick) {
  const b = el('button', 'o-btn text', parent);
  b.type = 'button';
  Object.assign(b.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  el('span', null, b).textContent = text;
  b.addEventListener('mousedown', () => focusButton(b));
  b.addEventListener('click', () => { if (!b.disabled) onClick(); });
  return b;
}

// ------------------------------------------------------------------ rendering

function render() {
  if (!game) return;
  syncSelection();
  const shown = shownPlayer();
  const pl = game.players[shown];
  const board = game.board;

  // Board, roads, buildings, robber.
  bctx.clearRect(0, 0, 1024, 768);
  paintBoard(bctx, board, {
    order: settings.order, internals: settings.internals,
    robber: carrying === 'robber' ? 'hidden' : (game.phase === 'moveRobber' ? 'lie' : 'stand'),
    redraw: () => render(),
  });

  // Longest road / largest army: on the table until somebody holds them.
  const big = board.size === 56;
  place(tableArmy, big ? 850 : 690, big ? 545 : 505, !game.largestArmy.player);
  place(tableRoad, big ? 910 : 750, big ? 510 : 470, !game.longestRoad.player);
  plArmy.style.display = game.largestArmy.player === shown ? 'block' : 'none';
  plRoad.style.display = game.longestRoad.player === shown ? 'block' : 'none';

  renderStrip();
  renderDice();
  renderPriceCard(shown, pl);
  renderDevDeck(shown, pl);
  renderHand(shown, pl);
  renderTrade();

  // Buttons (S.buttonEnabler, plus the engine's phase rules).
  const human = humanTurn() && shown === game.current;
  const give = human ? selString() : '';
  btnBank.setEnabled(human && game.phase === 'main' && give.length > 0 && game.bankTradeRatio(give) > 0);
  btnTrade.setEnabled(human && game.phase === 'main' && give.length > 0);
  // The applet left "next" enabled throughout a human's turn (it only
  // disabled it while a computer played); the engine refuses a premature
  // end of turn, which then simply does nothing.
  btnNext.setEnabled(humanTurn() || (!net && allComputer()));

  internalsBox.textContent = settings.internals ? String(Math.min(game.rounds, 9)) : '';
  renderPakli();
  renderNetStatus();
}

// The room in the free corner left of the board: code, then one line per
// seat (house in the seat's colour, name, who plays it).
function renderNetStatus() {
  netBox.innerHTML = '';
  if (!net) { netBox.style.display = 'none'; return; }
  netBox.style.display = 'block';
  const s = net.session;
  const head = el('div', 'o-net-head', netBox);
  head.textContent = t('net.statusRoom', { code: s.code || '?' }) + (net.closed ? ` – ${t('net.statusClosed')}` : '');
  const seats = lobby.seatList();
  for (const st of seats) {
    const row = el('div', 'o-net-row', netBox);
    row.dataset.test = `net-seat-${st.seat}`;
    const c = el('canvas', null, row);
    c.width = 22; c.height = 16;
    paintHaz(c.getContext('2d'), 1, st.seat, 3, 1);
    const turn = game && s.started && game.actor() === st.seat && game.phase !== 'gameOver';
    const label = el('span', turn ? 'turn' : null, row);
    label.textContent = lobby.seatLabel(st);
  }
}

function place(node, x, y, visible) {
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.style.display = visible ? 'block' : 'none';
}

function renderStrip() {
  psctx.clearRect(0, 0, 255, 45);
  const active = hoverPlayer || game.current;
  // The applet marked the active player only with a 1 px yellow outline on
  // the house, which is all but invisible on the grey strip. Its slot gets a
  // yellow ground with a black frame, in the applet's own yellow. It follows
  // whose turn it is, not the house under the mouse.
  const turn = game.current;
  psctx.fillStyle = '#ffff00';
  psctx.fillRect(turn * 42 - 37, 5, 34, 35);
  psctx.strokeStyle = '#000';
  psctx.lineWidth = 1;
  psctx.strokeRect(turn * 42 - 36.5, 5.5, 33, 34);
  for (let i = 1; i <= game.numPlayers; i++) {
    const p = game.players[i];
    paintHaz(psctx, 2, i, i * 42 - 32, 10, {
      strip: true, frameOnly: i !== active, vp: game.victoryPoints(i), comp: p.comp,
      internals: settings.internals, settlements: p.placed.settlements, cities: p.placed.cities, roads: p.placed.roads,
    });
  }
  paintBevel(psctx, 255, 45, [131, 99, 178], [255, 255, 217]);
}

function renderDice() {
  paintDice(dctx, diceShown, game.phase === 'roll' || !!diceAnim);
  paintBevel(dctx, DICE_W, DICE_H, [110, 142, 189], [255, 217]);
}

function renderPriceCard(shown, pl) {
  sctx.clearRect(0, 0, 190, 216);
  const sup = slotPieces();
  const color = PLAYER_COLORS[shown];
  // UtClass: a 6 px road line at (0,3)-(32,3) in its 34x10 box; the price
  // card itself is at (5, 10) in the panel, so slot (x, y) -> (x-5, y-10).
  sctx.save();
  sctx.lineWidth = 6;
  sctx.lineCap = 'butt';
  sctx.strokeStyle = color;
  const road = (x, y) => { sctx.beginPath(); sctx.moveTo(x - 5, y - 10 + 3); sctx.lineTo(x - 5 + 32, y - 10 + 3); sctx.stroke(); };
  if (sup.roads >= 1) road(155, 56);
  if (sup.roads >= 2) road(155, 46);
  sctx.restore();
  if (sup.settlement > 0) paintHaz(sctx, 1, shown, 164 - 5, 102 - 10);
  if (sup.city > 0) paintHaz(sctx, 2, shown, 156 - 5, 147 - 10);
}

function faceUp(shown) {
  if (net) return net.session.localSeats.has(shown);
  return settings.openHands || shown === game.current || (game.phase === 'trade' && game.trade && shown === game.trade.responder);
}

function renderHand(shown, pl) {
  rDeck.innerHTML = '';
  const up = faceUp(shown);
  const mine = shown === game.current;
  pl.hand.forEach((c, i) => {
    const raised = mine && sel.has(i);
    const im = cardImg(rDeck, up ? RESOURCE_IMAGE[c] : 'hatlap', i * 30, raised ? 0 : 20);
    // Swing painted the first-added card on top.
    im.style.zIndex = String(100 - i);
    im.style.pointerEvents = 'auto';
    im.dataset.test = `hand-card-${i}`;
    im.addEventListener('click', () => onHandCard(i));
  });
}

function renderDevDeck(shown, pl) {
  eDeck.innerHTML = '';
  pl.dev.forEach((card, i) => {
    const up = card.played || revealed.has(card);
    const im = cardImg(eDeck, up ? DEVCARD_IMAGE[card.res] : 'hatlaps', 0, i * 15);
    // add(card, 0): the newest card is on top.
    im.style.zIndex = String(i + 1);
    im.style.pointerEvents = 'auto';
    im.dataset.test = `dev-card-${i}`;
    im.addEventListener('click', (e) => onDevCard(i, e));
    im.addEventListener('contextmenu', (e) => { e.preventDefault(); onDevCard(i, { button: 2 }); });
  });
}

function renderPakli() {
  pakliBox.innerHTML = '';
  if (!settings.pakli || net) return;
  game.devDeck.forEach((res, i) => {
    const im = cardImg(pakliBox, DEVCARD_IMAGE[res], 0, i * 15);
    im.style.zIndex = String(i + 1);
  });
}

// ------------------------------------------------------------------ scaling

function fit() {
  const scale = Math.min(1, window.innerWidth / 1024);
  applet.style.transform = scale < 1 ? `scale(${scale})` : '';
  document.body.style.height = `${Math.ceil(789 * scale)}px`;
  document.body.style.overflow = scale < 1 ? 'hidden auto' : 'hidden';
}
window.addEventListener('resize', fit);
fit();

// ------------------------------------------------------------------ network: binding a session to this page

// The lobby (lobby.js) hands over a session once a room is open or joined.
// Until the host starts, the page keeps showing whatever it showed.
function attachSession(session) {
  detachSession();
  stopAi();
  net = { session, offs: [], closed: false };
  const on = (ev, fn) => net.offs.push(session.on(ev, (e) => { if (net && net.session === session) fn(e); }));
  on('start', () => adoptSessionGame());
  on('resync', (e) => { if (!e || !e.noop) adoptSessionGame(); });
  on('rejected', (r) => {
    // The client already rolled its own optimistic step back.
    adoptSessionGame(true);
    messageDialog(applet, t('dlg.warning'), tError(r), 'warning');
  });
  on('applied', (e) => onApplied(e));
  on('desync', () => { messageDialog(applet, t('dlg.warning'), t('net.desync'), 'warning'); });
  on('lobby', () => render());
  on('peer', () => render());
  on('closed', (e) => {
    net.closed = true;
    stopAi();
    render();
    if (session.role === 'client') lobby.hostGone(e && e.reason);
  });
  if (session.game) adoptSessionGame();
  else render();
}

function detachSession() {
  if (!net) return;
  for (const off of net.offs) { try { off(); } catch { /* ignore */ } }
  net = null;
  stopAi();
}

// The session's world becomes this page's game (a start, a new game in the
// room, or a rebuild from the host's log).
function adoptSessionGame(keepView = false) {
  const s = net.session;
  if (!s.game) return;
  const fresh = game !== s.game;
  stopAi();
  game = s.game;
  ai = s.ai;
  if (fresh && !keepView) resetView();
  else { seenLog = Math.min(seenLog, game.log.length); carrying = null; setCursor(null); }
  busy = false;
  afterAction();
}

// Something happened at another page (or, at the host, a guest's move).
function onApplied(e) {
  if (e.local) return; // our own: act()/aiStep() re-render already
  if (game !== net.session.game) { adoptSessionGame(); return; }
  const from = seenLog;
  let roll = null;
  for (let i = from; i < game.log.length; i++) if (game.log[i].type === 'roll') roll = game.log[i].dice;
  if (!humanTurn() || game.phase !== 'main') pendingOffers = [];
  if (roll) { seenLog = game.log.length; showRemoteRoll(roll); return; }
  afterAction();
}

const lobby = createLobby({
  applet,
  attach: attachSession,
  detach: () => { detachSession(); render(); },
  stopGame: () => stopAi(),
  backToSolo: () => { detachSession(); newGame(); },
  game: () => game,
});

// ------------------------------------------------------------------ test hooks

window.__orig = {
  get game() { return game; },
  state: () => ({
    phase: game.phase, current: game.current, actor: game.actor(), carrying, selected: selString(),
    shown: shownPlayer(), dialog: dialogOpen(), busy, pendingOffers: pendingOffers.length, paused,
    net: net ? { role: net.session.role, seat: net.session.mySeat, started: !!net.session.started, closed: net.closed, code: net.session.code } : null,
  }),
  newGame: (opts = {}) => {
    if (opts.computer) settings.computer = opts.computer.slice();
    if (opts.fast !== undefined) settings.fast = opts.fast;
    if (net) lobby.leave();
    newGame(opts);
  },
  menubar,
  lobby,
  setLang: changeLang,
  // Re-render after a test changed the game directly.
  refresh: () => { syncSelection(); render(); drive(); },
};

document.documentElement.lang = getLang();
preloadAssets().then(() => {
  newGame();
  document.documentElement.dataset.ready = '1';
  lobby.boot();
});
