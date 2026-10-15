// Two languages for the applet's texts: English (the 2004 applet's own
// wording, German card names included, kept verbatim) and Hungarian.
// t(key, params) looks a dotted key up in the current table, falls back to
// English, then to the key itself; {{name}} placeholders come from `params`.
// The language is chosen once at load: ?lang=, then the saved menu choice,
// then the browser's language (hu* -> Hungarian, anything else English).

const EN = {
  menu: {
    new: 'New',
    gameFor: 'Game for {{n}} players',
    players: 'Players',
    willBegin: ' will begin',
    playerToBegin: 'Player to begin',
    computer: 'Computer',
    allComputer: 'All Players Computer',
    allHuman: 'All Players Human',
    seatComputer: ' Computer',
    options: 'Options',
    fast: 'Fast Animation',
    pakli: 'Entwicklungs Deck',
    internals: 'Show Internals',
    order: 'Deployment Order',
    openHands: 'Open Hands',
    language: 'Language',
    network: 'Network',
    host: 'Create room…',
    join: 'Join room…',
    room: 'Room…',
    newInRoom: 'New game in this room',
    botForMe: 'Computer plays for me',
    leave: 'Leave room',
    test: 'Connection test',
  },
  dlg: {
    discard: 'Throw half of your cards',
    robber: 'Robber',
    whichToRob: 'Which player to rob',
    winner: 'Settlers',
    points: '{{n}} Siegpunkte',
    pointsNamed: '{{name}}: {{n}} Siegpunkte',
    warning: 'Warning',
    diceOnce: 'Throw dice only once per turn.',
    tradingIn: 'Trading in',
    takeResource: 'Take a resource card',
    tradeOffer: 'Trade Offer',
    inReturn: 'Which resource do would you like to get in return?',
    limit: 'Cannot build more than {{n}} {{what}}',
    roads: 'roads',
    houses: 'houses',
    towns: 'towns',
    noVictim: 'There is no player to rob',
    robberWhen: 'Rablo can only be moved after throwing 7 with the dice or playing out a Knight.',
    card: 'Card',
    roadBuilding: 'Strassenbau',
    twoRoads: 'Take two pieces of road',
    plenty: 'Erfindung',
    plenty1: 'Take first resource card',
    plenty2: 'Take second resource card',
    monopoly: 'Monopol',
    monopolyWhich: 'Which resource do you take from everyone?',
    noCard: 'Sorry, you do not possess the card required by this offer',
    notPossible: 'Not possible now: {{why}}',
  },
  trade: { takeIt: 'TakeIt', remove: 'Remove', pass: 'Pass', submit: 'Submit' },
  net: {
    hostTitle: 'Create room',
    joinTitle: 'Join room',
    roomTitle: 'Room {{code}}',
    name: 'Your name',
    transport: 'Connection',
    transportAuto: 'Internet (relay + direct)',
    transportRelay: 'Internet, relay only',
    transportPeer: 'Internet, direct only (PeerJS)',
    transportLocal: 'This browser only (two tabs)',
    players: 'Players',
    open: 'Open room',
    code: 'Room code',
    codeHint: 'Send this code to the others (or the invitation link).',
    copyLink: 'Copy invitation link',
    copied: 'Copied!',
    join: 'Join',
    start: 'Start game',
    startHint: 'Seats nobody joined are played by the computer.',
    waiting: 'Joined. Waiting for the host to start the game…',
    seat: 'Seat {{n}}',
    you: 'you',
    host: 'host',
    computer: 'computer',
    free: 'free – waiting for a player',
    offline: 'disconnected',
    asComputer: 'Computer',
    handToComputer: 'Give to computer',
    close: 'Close',
    leave: 'Leave room',
    creating: 'Opening the room…',
    joining: 'Joining…',
    hostLeft: 'The host left, the game is over.',
    closed: 'The connection is lost ({{reason}}).',
    desync: 'Out of step with the host: the game was rebuilt from the host\'s log.',
    statusRoom: 'Room {{code}}',
    statusClosed: 'connection lost',
    newGameWaiting: 'The host can start a new game.',
    testRunning: 'Connection test: relay…',
    testP2pRunning: 'Connection test: direct connection…',
    testMqttOk: 'Relay ({{broker}}): OK, {{connect}} s, round trip {{rtt}} ms.',
    testMqttFailed: 'Relay: not working from here ({{reason}}).',
    testOk: 'Direct: broker {{broker}} s, connection {{connect}} s, path {{path}}.',
    testFailed: 'Direct: failed ({{reason}}).',
    status: {
      lib: 'Loading the library…',
      broker: 'Connecting to the broker ({{detail}})…',
      'broker-open': 'Broker OK, room {{detail}}',
      listening: 'The room is open, waiting for players.',
      connecting: 'Looking for the host ({{detail}})…',
      ice: 'Direct connection: {{detail}}…',
      'peer-open': 'Connected.',
      'broker-lost': 'Lost the broker, reconnecting…',
      relay: 'Connecting to the relay ({{detail}})…',
      'relay-open': 'Relay OK ({{detail}}).',
      'relay-lost': 'Lost the relay.',
      try: 'Trying: {{detail}}…',
      turn: 'TURN credentials…',
      'turn-failed': 'No TURN credentials, trying a direct connection…',
    },
  },
  err: {
    NOT_YOUR_TURN: 'It is not your turn.',
    NOT_YOUR_SEAT: 'That is not your seat.',
    NOT_STARTED: 'The game has not started.',
    STALE: 'Someone else moved meanwhile – the game was refreshed, try again.',
    DESYNCED: 'Syncing with the host… try again in a moment.',
    SEAT_IS_COMPUTER: 'The computer plays this seat now.',
    GAME_STARTED: 'The game has already started, nobody can join now.',
    ROOM_FULL: 'The room is full.',
    ROOM_SHRUNK: 'The host reduced the number of players.',
    SEAT_TAKEN_BY_AI: 'The host gave your seat to the computer.',
    NO_ROOM: 'No such room (check the code, and that the host\'s page is open).',
    CODE_EMPTY: 'Type the room code you got from the host.',
    CODE_LENGTH: 'A room code has exactly 5 characters – this has {{n}}.',
    CODE_CHARS: 'Room codes have no 0, O, 1 or I – check the code again.',
    ROOM_TAKEN: 'This room code is taken, ask for a new one.',
    TIMEOUT: 'No answer in time.',
    BROKER_TIMEOUT: 'The relay/broker did not answer. Check the internet connection and try again.',
    BROKER: 'Lost the connection to the broker (PeerJS). Try again in a moment.',
    HOST_TIMEOUT: 'The host was found, but the direct connection did not come up in time (firewall or mobile network).',
    ICE_FAILED: 'The direct connection failed (firewall or mobile network).',
    BROWSER: 'This browser has no WebRTC.',
    CONNECT: 'The connection to the host broke while it was being set up.',
    NO_PEERJS: 'Could not load the PeerJS library.',
    NO_MQTT: 'Could not load the relay library (mqtt.js).',
    VERSION: 'The host runs another version, reload the page.',
    default: 'Not possible now.',
  },
};

const HU = {
  menu: {
    new: 'Új',
    gameFor: 'Játék {{n}} játékossal',
    players: 'Játékosok',
    willBegin: ' kezd',
    playerToBegin: 'Ki kezdjen',
    computer: 'Számítógép',
    allComputer: 'Mindenki gép',
    allHuman: 'Mindenki ember',
    seatComputer: ' gép',
    options: 'Beállítások',
    fast: 'Gyors animáció',
    pakli: 'Fejlesztési pakli',
    internals: 'Belső adatok',
    order: 'Építési sorrend',
    openHands: 'Nyitott lapok',
    language: 'Nyelv',
    network: 'Hálózat',
    host: 'Szoba létrehozása…',
    join: 'Csatlakozás szobához…',
    room: 'Szoba…',
    newInRoom: 'Új játék ebben a szobában',
    botForMe: 'A gép játsszon helyettem',
    leave: 'Kilépés a szobából',
    test: 'Kapcsolatteszt',
  },
  dlg: {
    discard: 'Dobd el a lapjaid felét',
    robber: 'Rabló',
    whichToRob: 'Kitől raboljon?',
    winner: 'Telepesek',
    points: '{{n}} győzelmi pont',
    pointsNamed: '{{name}}: {{n}} győzelmi pont',
    warning: 'Figyelem',
    diceOnce: 'Körönként csak egyszer lehet dobni.',
    tradingIn: 'Beváltás',
    takeResource: 'Válassz egy nyersanyagot',
    tradeOffer: 'Cserejavaslat',
    inReturn: 'Melyik nyersanyagot kéred cserébe?',
    limit: 'Legfeljebb {{n}} {{what}} építhető',
    roads: 'út',
    houses: 'telep',
    towns: 'város',
    noVictim: 'Nincs kitől rabolni',
    robberWhen: 'A rablót csak 7-es dobás vagy kijátszott lovag után lehet áthelyezni.',
    card: 'Kártya',
    roadBuilding: 'Útépítés',
    twoRoads: 'Vegyél el két utat',
    plenty: 'Felfedezés',
    plenty1: 'Válaszd ki az első nyersanyagot',
    plenty2: 'Válaszd ki a második nyersanyagot',
    monopoly: 'Monopólium',
    monopolyWhich: 'Melyik nyersanyagot veszed el mindenkitől?',
    noCard: 'Sajnos nincs meg a lap, amit ez az ajánlat kér',
    notPossible: 'Ez most nem lehetséges: {{why}}',
  },
  trade: { takeIt: 'Elfogad', remove: 'Töröl', pass: 'Passz', submit: 'Ajánl' },
  net: {
    hostTitle: 'Szoba létrehozása',
    joinTitle: 'Csatlakozás szobához',
    roomTitle: '{{code}} szoba',
    name: 'A neved',
    transport: 'Kapcsolat',
    transportAuto: 'Internet (relé + közvetlen)',
    transportRelay: 'Internet, csak relé',
    transportPeer: 'Internet, csak közvetlen (PeerJS)',
    transportLocal: 'Csak ez a böngésző (két fül)',
    players: 'Játékosok',
    open: 'Szoba nyitása',
    code: 'Szobakód',
    codeHint: 'Ezt a kódot (vagy a meghívó linket) küldd el a többieknek.',
    copyLink: 'Meghívó link másolása',
    copied: 'Kimásolva!',
    join: 'Csatlakozás',
    start: 'Játék indítása',
    startHint: 'Az üresen maradt helyeket a gép játssza.',
    waiting: 'Csatlakoztál. Várakozás, hogy a házigazda elindítsa a játékot…',
    seat: '{{n}}. hely',
    you: 'te',
    host: 'házigazda',
    computer: 'gép',
    free: 'szabad – várjuk a csatlakozót',
    offline: 'kapcsolat megszakadt',
    asComputer: 'Gép',
    handToComputer: 'Vegye át a gép',
    close: 'Bezár',
    leave: 'Kilépés a szobából',
    creating: 'Szoba nyitása…',
    joining: 'Csatlakozás…',
    hostLeft: 'A házigazda kilépett, a játék véget ért.',
    closed: 'A kapcsolat megszakadt ({{reason}}).',
    desync: 'Eltérés a házigazdától: az állást a házigazda naplójából újraépítettük.',
    statusRoom: '{{code}} szoba',
    statusClosed: 'a kapcsolat megszakadt',
    newGameWaiting: 'A házigazda indíthat új játékot.',
    testRunning: 'Kapcsolatteszt: relé…',
    testP2pRunning: 'Kapcsolatteszt: közvetlen kapcsolat…',
    testMqttOk: 'Relé ({{broker}}): rendben, {{connect}} s, oda-vissza {{rtt}} ms.',
    testMqttFailed: 'Relé: innen nem működik ({{reason}}).',
    testOk: 'Közvetlen: közvetítő {{broker}} s, kapcsolat {{connect}} s, útvonal {{path}}.',
    testFailed: 'Közvetlen: nem sikerült ({{reason}}).',
    status: {
      lib: 'Könyvtár betöltése…',
      broker: 'Kapcsolódás a közvetítőhöz ({{detail}})…',
      'broker-open': 'Közvetítő rendben, szoba: {{detail}}',
      listening: 'A szoba nyitva, várjuk a csatlakozókat.',
      connecting: 'Házigazda keresése ({{detail}})…',
      ice: 'Közvetlen kapcsolat: {{detail}}…',
      'peer-open': 'Kapcsolat felépült.',
      'broker-lost': 'A közvetítő kapcsolat megszakadt, újracsatlakozás…',
      relay: 'Kapcsolódás a reléhez ({{detail}})…',
      'relay-open': 'Relé rendben ({{detail}}).',
      'relay-lost': 'A relé kapcsolat megszakadt.',
      try: 'Próbálkozás: {{detail}}…',
      turn: 'Továbbító (TURN) hitelesítés…',
      'turn-failed': 'A továbbító hitelesítése nem sikerült, közvetlen kapcsolattal próbálkozunk…',
    },
  },
  err: {
    NOT_YOUR_TURN: 'Nem te következel.',
    NOT_YOUR_SEAT: 'Ez nem a te helyed.',
    NOT_STARTED: 'A játék még nem indult el.',
    STALE: 'Közben más is lépett – frissítettük az állást, próbáld újra.',
    DESYNCED: 'Szinkronizálás a házigazdával… próbáld újra egy pillanat múlva.',
    SEAT_IS_COMPUTER: 'Ezt a helyet most a gép játssza.',
    GAME_STARTED: 'A játék már elindult, új játékos nem csatlakozhat.',
    ROOM_FULL: 'A szoba megtelt.',
    ROOM_SHRUNK: 'A házigazda csökkentette a játékosok számát.',
    SEAT_TAKEN_BY_AI: 'A házigazda a gépnek adta a helyedet.',
    NO_ROOM: 'Nincs ilyen szoba (ellenőrizd a kódot, és hogy a házigazda oldala nyitva van-e).',
    CODE_EMPTY: 'Írd be a házigazdától kapott szobakódot.',
    CODE_LENGTH: 'A szobakód pontosan 5 karakter – ez {{n}}.',
    CODE_CHARS: 'A szobakódban nincs 0, O, 1 és I – nézd meg újra a kódot.',
    ROOM_TAKEN: 'Ez a szobakód foglalt, kérj újat.',
    TIMEOUT: 'Nem jött válasz időben.',
    BROKER_TIMEOUT: 'A közvetítő szerver nem válaszolt. Ellenőrizd az internetkapcsolatot, és próbáld újra.',
    BROKER: 'Megszakadt a kapcsolat a közvetítővel (PeerJS). Próbáld újra egy pillanat múlva.',
    HOST_TIMEOUT: 'A házigazda megvan, de a közvetlen kapcsolat nem jött létre időben (tűzfal vagy mobilnet).',
    ICE_FAILED: 'A közvetlen kapcsolat nem jött létre (tűzfal vagy mobilnet).',
    BROWSER: 'Ez a böngésző nem támogatja a WebRTC-t.',
    CONNECT: 'A kapcsolat a házigazdával megszakadt a felépítés közben.',
    NO_PEERJS: 'Nem sikerült betölteni a PeerJS könyvtárat.',
    NO_MQTT: 'Nem sikerült betölteni a relé könyvtárát (mqtt.js).',
    VERSION: 'A házigazda más verziót futtat, frissítsd az oldalt.',
    default: 'Ez most nem lehetséges.',
  },
};

export const TABLES = { en: EN, hu: HU };
export const LANGS = ['hu', 'en'];
const LANG_KEY = 'catan-original-mp.lang';

function detectLang() {
  try {
    const q = new URL(globalThis.location.href).searchParams.get('lang');
    if (TABLES[q]) return q;
  } catch { /* not in a browser */ }
  try {
    const saved = globalThis.localStorage && globalThis.localStorage.getItem(LANG_KEY);
    if (TABLES[saved]) return saved;
  } catch { /* storage blocked */ }
  const nav = (globalThis.navigator && globalThis.navigator.language) || '';
  return nav.toLowerCase().startsWith('hu') ? 'hu' : 'en';
}

let currentLang = detectLang();

export function getLang() { return currentLang; }

export function setLang(lang, { save = true } = {}) {
  if (!TABLES[lang]) return;
  currentLang = lang;
  if (save) { try { globalThis.localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ } }
}

function lookup(table, path) {
  let node = table;
  for (const part of path.split('.')) {
    if (node == null) return undefined;
    node = node[part];
  }
  return node;
}

/** Translate `key` (dotted path, e.g. "menu.new"), substituting {{param}}. */
export function t(key, params) {
  let str = lookup(TABLES[currentLang], key);
  if (typeof str !== 'string') str = lookup(TABLES.en, key);
  if (typeof str !== 'string') return key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{{${k}}}`, String(v));
  return str;
}

/** A user-facing text for an error-like { code, message }. */
export function tError(err, params) {
  const code = err && err.code;
  const key = `err.${code}`;
  const s = t(key, params);
  if (s !== key) return s;
  return (err && err.message) ? String(err.message) : t('err.default');
}
