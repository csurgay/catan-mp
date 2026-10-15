// Wire messages of the multiplayer session (docs/HALOZAT.md). Every
// message is a plain JSON object with a `t` (type) field. Everything that
// arrives from a peer is untrusted: validateMessage() checks shape and size
// before session.js looks at the content, and session.js re-checks
// authority (does this peer own the seat it is acting for?).

export const PROTOCOL_VERSION = 1;
export const MAX_NAME = 24;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const ROOM_CODE_LENGTH = 5;

export function makeRoomCode(rng = Math.random) {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) s += ROOM_CODE_ALPHABET[Math.floor(rng() * ROOM_CODE_ALPHABET.length)];
  return s;
}

// Pasted or typed codes: case-folded, spaces/dashes/punctuation dropped.
// Never truncated -- a too-long code is reported (roomCodeProblem), not
// silently cut to a different, wrong code.
export function normalizeRoomCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Why a (normalized) code cannot be a room code, or null if it can:
// CODE_EMPTY, CODE_LENGTH (not ROOM_CODE_LENGTH characters), CODE_CHARS
// (contains 0/O/1/I, which room codes never use).
export function roomCodeProblem(s) {
  const c = normalizeRoomCode(s);
  if (!c) return 'CODE_EMPTY';
  if (c.length !== ROOM_CODE_LENGTH) return 'CODE_LENGTH';
  if (![...c].every((ch) => ROOM_CODE_ALPHABET.includes(ch))) return 'CODE_CHARS';
  return null;
}

export function isRoomCode(s) {
  return typeof s === 'string' && s.length === ROOM_CODE_LENGTH && [...s].every((c) => ROOM_CODE_ALPHABET.includes(c));
}

// Display names: control characters stripped, trimmed, capped at MAX_NAME.
export function cleanName(name, fallback = '') {
  // Cut by code point, never inside an emoji's surrogate pair.
  // eslint-disable-next-line no-control-regex
  const s = [...String(name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim()].slice(0, MAX_NAME).join('').trim();
  return s || fallback;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export const MAX_CHAT_LINES = 200;
export const MAX_CHAT_TEXT = 240;
export const MAX_TALK_TEXT = 200;
function isTalkLine(l) {
  return isPlainObject(l) && Number.isInteger(l.n) && l.n >= 0 && Number.isInteger(l.anchor) && l.anchor >= 0
    && Number.isInteger(l.seat) && l.seat >= 1 && l.seat <= 6 && typeof l.text === 'string' && l.text.length > 0
    && l.text.length <= MAX_CHAT_TEXT && (l.bot === undefined || typeof l.bot === 'boolean')
    && (l.persona === undefined || (typeof l.persona === 'string' && /^[a-z]{1,16}$/.test(l.persona)));
}

// A chat message as typed: control characters out, whitespace collapsed,
// at most MAX_TALK_TEXT characters (cut by code point). '' if nothing left.
export function cleanTalk(text, max = MAX_TALK_TEXT) {
  // eslint-disable-next-line no-control-regex
  const t = String(text ?? '').replace(/[\x00-\x1f\x7f\u200b-\u200f\u2028-\u202e]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...t].slice(0, max).join('').trim();
}

function isChatLine(l) {
  return isPlainObject(l) && Number.isInteger(l.idx) && l.idx >= 0 && Number.isInteger(l.seat) && l.seat >= 1 && l.seat <= 6
    && typeof l.text === 'string' && l.text.length > 0 && l.text.length <= MAX_CHAT_TEXT && (l.lang === 'hu' || l.lang === 'en');
}

// Message shapes, by type:
//   c->h  hello    { v, name, token }
//   h->c  welcome  { peerId, seat, token }
//   h->c  refuse   { code, message }
//   h->*  lobby    { seats: [{seat, name, comp, taken, host, connected, autoComp}], config }
//   h->*  start    { config, entries, hash }      (entries: for a late/re-joiner)
//   c->h  act      { seq, entry }
//   h->*  applied  { seq, entry, hash }
//   h->c  reject   { seq, code, message }
//   h->c  resync   { config, entries, hash }
//   h->*  end      { reason }
//   h->c  ping     { n }        c->h  pong { n }
//   c->h  sync     {}   (please send me a resync)
//   h->c  chat     { lines: [{ idx, seat, text, lang }] }   (bot chat lines
//                  written by the host's LLM; cosmetic, never game state)
//   c->h  say      { text }   (a player's chat message)
//   h->*  talk     { lines: [{ n, seat, anchor, text, bot, persona? }] }
//                  (players' messages and the bots' answers, numbered by
//                  the host; a bot line names who said it)
const SHAPES = {
  hello: (m) => Number.isInteger(m.v) && typeof m.name === 'string' && m.name.length <= MAX_NAME
    && (m.token === undefined || (typeof m.token === 'string' && m.token.length <= 64)),
  welcome: (m) => typeof m.peerId === 'string' && (m.seat === null || Number.isInteger(m.seat)) && typeof m.token === 'string',
  refuse: (m) => typeof m.code === 'string',
  lobby: (m) => Array.isArray(m.seats) && m.seats.length <= 6 && isPlainObject(m.config),
  start: (m) => isPlainObject(m.config) && Array.isArray(m.entries) && typeof m.hash === 'string',
  act: (m) => Number.isInteger(m.seq) && m.seq >= 0 && isPlainObject(m.entry),
  applied: (m) => Number.isInteger(m.seq) && m.seq >= 0 && isPlainObject(m.entry) && typeof m.hash === 'string',
  reject: (m) => Number.isInteger(m.seq) && typeof m.code === 'string',
  resync: (m) => isPlainObject(m.config) && Array.isArray(m.entries) && typeof m.hash === 'string',
  end: (m) => typeof m.reason === 'string',
  ping: (m) => Number.isInteger(m.n),
  pong: (m) => Number.isInteger(m.n),
  sync: () => true,
  chat: (m) => Array.isArray(m.lines) && m.lines.length <= MAX_CHAT_LINES && m.lines.every(isChatLine),
  say: (m) => typeof m.text === 'string' && m.text.length > 0 && m.text.length <= 400,
  talk: (m) => Array.isArray(m.lines) && m.lines.length <= MAX_CHAT_LINES && m.lines.every(isTalkLine),
};

// Returns the message if its shape is acceptable, else null. Never throws.
export function validateMessage(msg) {
  try {
    if (!isPlainObject(msg)) return null;
    const check = SHAPES[msg.t];
    if (typeof check !== 'function') return null;
    return check(msg) ? msg : null;
  } catch {
    return null;
  }
}

export const MSG_TYPES = Object.keys(SHAPES);
