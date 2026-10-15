# Hálózati játék

## Az elv: lockstep egy determinisztikus motoron

A motor (`src/engine/`) minden véletlenszámot a játék saját RNG-jéből vesz,
a gépi játékost is beleértve. Egy játszma így teljesen leírható a
kezdőbeállítással (`config`: játékosszám, kezdő, mag, gépi helyek, nevek)
és a lépések sorrendjével. Ezt replikáljuk: mindenkinél fut egy teljes
`Game`, és mindenki ugyanazokat a **bejegyzéseket** alkalmazza ugyanabban a
sorrendben.

```
{ kind: 'call', player, call: { method, params } }   egy motorhívás
{ kind: 'ai' }                                        egy ai.step(game)
```

* A gépi lépést nem küldjük el, hanem mindenki maga számolja ki
  (`{kind:'ai'}`), mert a gépi döntések RNG-t fogyasztanak: aki kihagyná,
  annál a következő dobás már más lenne.
* A sorrendet a házigazda dönti el: ő számozza a bejegyzéseket, és minden
  után elküldi az állapot hash-ét (`stateHash`: FNV-1a a JSON-állapotra és
  az RNG pozíciójára). Eltérésnél a vendég a házigazda naplójából
  újraépíti az állást (`replay`).
* A vendég a saját lépését előbb helyben alkalmazza (amikor ő következik, az
  állapota azonos a házigazdáéval), elküldi (`act`), a házigazda ellenőrzi
  (jó sorszám, a saját helye, ő következik, a motor elfogadja), és
  mindenkinek kiküldi (`applied`). Elutasításnál a vendég visszalép, és
  megkapja a teljes naplót (`resync`).
* Csak a `world.js` `CALL_METHODS` listáján lévő motorhívás mehet át a
  hálózaton; a paraméterek alakját (`validateCall`) a motor előtt
  ellenőrizzük.

## Szoba, helyek, kiesés

* `host.open()` ad egy ötbetűs kódot (nincs benne 0, O, 1, I). A
  csatlakozó `hello`-t küld névvel és egy tokennel; a házigazda helyet ad
  (`welcome`) vagy elutasít (`ROOM_FULL`, `GAME_STARTED`, `VERSION`).
* Indításkor (`start`) minden üresen maradt emberi hely gépi lesz.
* **Kiesés**: ha egy vendég kapcsolata megszakad, a helyét azonnal a gép
  veszi át (`setComputer(hely, true)` bejegyzés, így mindenkinél ugyanaz
  történik). Ha ugyanazzal a tokennel visszajön, a teljes naplót megkapja,
  és a helye visszaszáll rá.
* **Oldalfrissítés**: a token a böngészőfül `sessionStorage`-ában van, így
  frissítés után a *Csatlakozás* gomb ugyanarra a helyre visz vissza. Ha a
  házigazda a régi kapcsolatot még élőnek látja (nem jött el a búcsú), az
  új kapcsolat lecseréli a régit.
* **Házigazda**: a saját helyét átadhatja a gépnek (*Hálózat → A gép
  játsszon helyettem*), de a szobát nem: ő a „tábla”, ő számozza a
  lépéseket és ő mozgatja a gépi játékosokat. Ha kilép, a szoba megszűnik,
  a vendégek erről üzenetet kapnak.
* Életjel: a házigazda 4 másodpercenként pingel; három elmaradt válasz
  után a vendéget kiesettnek tekinti.

## Átvitelek (`src/net/transports/`)

Mindegyiknek ugyanaz a felülete: `listen(code)` / `dial(code)` → peer
`send`, `on('message'|'close')`, `close` metódusokkal.

| átvitel | mire |
|---|---|
| `relay.js` | Internet relén át: minden üzenet egy nyilvános MQTT-brókeren megy (WebSocket, mqtt.js 5.10.1 a cdnjs-ről, SRI-hash-sel). Három bróker sorban (`DEFAULT_BROKERS`). Mobilnet és tűzfal mögül is működik. `?relay=ws://…` saját brókert ad meg. |
| `peerjs.js` | Internet közvetlenül: PeerJS (1.5.4, cdnjs, SRI) a kézfogáshoz, utána WebRTC adatcsatorna. Szigorú NAT mögött elakadhat (TURN nincs beállítva). |
| `multi.js` | Az alapértelmezett „Internet (relé + közvetlen)”: a házigazda mindkettőn figyel, a csatlakozó előbb a relét próbálja. |
| `broadcast.js` | Egy böngésző két füle között (BroadcastChannel). Csak `?transport=local`-lal jelenik meg; kipróbáláshoz és a böngészős teszthez. |
| `memory.js` | Unit tesztekhez: a kézbesítést a teszt vezérli (`flush`, `dropNext`, `cut`). |

A külső könyvtárak csak akkor töltődnek be, amikor valaki szobát nyit vagy
csatlakozik; egyjátékos módban az oldal semmit nem tölt le az internetről.

## A felület bekötése (`src/ui/app.js`, `src/ui/lobby.js`)

* Minden motorhívás a `call(method, ...params)` függvényen megy át: egyedül
  ez sima metódushívás, szobában `session.submit()`.
* `isLocalSeat(hely)`: ember, és erről az oldalról játsszák. Egyedül
  minden emberi hely ilyen (az applet „hot seat” módja), szobában csak a
  saját hely. Minden kattintás, kérdőablak (dobj el lapot, kitől rabolj) és
  a cserepanel gombjai ezen múlnak.
* A gépi játékost csak a házigazda lépteti (`{kind:'ai'}`); a vendégek a
  `applied` eseményre rajzolnak újra. Egy máshol történt dobásnál a kocka
  ugyanúgy pörög, mint a sajátnál.
* Az árkártyán alapból a saját kezed látszik felfordítva; a többiekét a
  játékoscsíkon a házukra mutatva lehet megnézni, lefordítva.
* A bal felső sarokban (a tábla mellett, ahol az appletben üres hely volt)
  a szoba kódja és a helyek látszanak: ki ül ott, ki következik, ki esett ki.

## Bizalmi modell

Mindenkinél a **teljes** állás megvan, a többiek lapjai és a fejlesztési
pakli is: ettől olcsó és ellenőrizhető a lockstep. Aki megnyitja a böngésző
fejlesztői eszközeit, belenézhet. Amit **nem** tud megtenni: más helyett
lépni, soron kívül lépni, szabálytalan lépést elfogadtatni, vagy a többiek
állását elrontani – a házigazda minden lépést a saját motorján ellenőriz, a
vendégek pedig a házigazda hash-ét. Barátok közötti játékra ez a jó
egyensúly. A szobakód nem titkos: aki kitalálja, láthatja a forgalmat.

## Tesztek

* `tests/net-session.test.js`: memóriás átvitelen teljes, véletlen lépésekkel
  végigjátszott játszmák 3–6 hellyel, hash-egyezés minden lépés után;
  hamis hely, soron kívüli és tiltott hívások, üzenetvesztés, kiesés és
  visszatérés, oldalfrissítés búcsú nélkül, életjel álórával, újraindítás.
* `tests/net-transports.test.js`, `tests/net-relay.test.js`: az átvitelek
  (PeerJS-adapter álkönyvtárral, MQTT álbrókerrel; valódi brókerrel, ha
  az `aedes`/`ws`/`mqtt` telepítve van).
* `tests/e2e/scenarios/20-network.mjs`: két valódi oldal a böngészőben,
  szobanyitás és csatlakozás a menüből, setup és körök valódi
  kattintásokkal, csere a másik oldalon megválaszolva, kiesés,
  oldalfrissítés utáni visszatérés, a házigazda kilépése – egyszer két fül
  között, egyszer valódi mqtt.js-sel egy helyi MQTT-brókeren át.
