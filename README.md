# catan-mp – Settlers from Catan (2004), hálózati játékkal

Klaus Teuber's Settlers of Catan boardgame with computer players and multiplayers

**Játék:** https://csurgay.github.io/catan-mp/

P. Csurgay 2004-es Java appletje böngészőben, **pontosan az eredeti kinézettel
és kezeléssel**, egyedül a gép ellen vagy **többen, hálózaton át**. Nincs
build-lépés, nincs függőség: sima HTML5 + JavaScript modulok.

*The 2004 Java applet "Settlers from Catan" by P. Csurgay, in the browser,
in its original look and handling, against the computer or with friends
over the network. Plain HTML5 + ES modules, no build, no dependencies.*

## Mi van benne

* **Az eredeti nézet**: Swing Metal menüsor, 1024×768-as panel az applet
  saját koordinátáival, házak és utak felvétele az árkártyáról, dobás a
  kockára kattintva, JOptionPane-ablakok, zöld cserepanel.
* **Hálózati játék** (*Hálózat* menü): az egyik játékos szobát nyit, kap egy
  ötbetűs kódot (vagy meghívó linket), a többiek ezzel csatlakoznak. Az
  üresen maradt helyeket a gép játssza. Szerver nincs: a házigazda
  böngészője a „szerver”.
  * Kapcsolat: alapból nyilvános MQTT-relén át (mobilnet és tűzfal mögül is
    megy), mellette közvetlen WebRTC (PeerJS). A szobaablakban
    kiválasztható csak az egyik is.
  * Ha valaki kiesik, a helye azonnal a gépre száll; ha ugyanabból a
    böngészőfülből visszajön (akár oldalfrissítés után), visszakapja.
  * A házigazda a *Hálózat* menüben a saját helyét is átadhatja a gépnek,
    és új játékot indíthat ugyanabban a szobában.
  * Szobában a többiek lapjai és a fejlesztési pakli titkosak (a *Nyitott
    lapok* és a *Fejlesztési pakli* opció ott nem elérhető).
* **Nyelv**: magyar vagy angol (*Nyelv* menü). Az angol szövegek az applet
  eredeti feliratai, a német kártyanevekkel együtt („Siegpunkte”,
  „Strassenbau”).

## Futtatás helyben

A böngészők `file://`-ról nem töltenek be JavaScript-modulokat, ezért egy
helyi webszerver kell:

```sh
npx serve -l 8080 .        # vagy: python -m http.server 8080
```

Utána: http://localhost:8080/

Kipróbálás egyedül, két fülön: http://localhost:8080/?transport=local
(ilyenkor a szobaablakban megjelenik a „Csak ez a böngésző” kapcsolat;
BroadcastChannel a két fül között, internet nélkül).

### URL-paraméterek

| paraméter | jelentés |
|---|---|
| `?seed=<n>` | ugyanaz a tábla és dobássor |
| `?players=3..6` | játékosszám (egyedül) |
| `?computer=011111` | melyik hely gépi (egyedül) |
| `?lang=hu\|en` | nyelv |
| `?join=KÓD` | megnyitja a csatlakozás ablakot a kóddal (ez a meghívó link) |
| `?host=1` | megnyitja a szobanyitás ablakot |
| `?transport=auto\|relay\|peerjs\|local` | kapcsolat típusa |
| `?relay=ws://host:port/mqtt` | saját MQTT-bróker (pl. teszthez) |
| `?broker=host:port` | saját PeerServer |
| `?test=1` | animáció nélküli, azonnali mód (tesztekhez) |

## Tesztek

```sh
npm test            # node --test: szabályok, tábla, gépi játékos, aranyminták, hálózati session (~15 s)
npm run test:e2e    # Playwright: egyjátékos kattintással, két oldal egy szobában, valódi mqtt.js reléken át
```

* A `tests/golden/` táblái az **eredeti Java programmal** készültek
  (`tools/golden/`); a JavaScript táblagenerátor ugyanazzal a
  `java.util.Random` maggal bitre ugyanazt a táblát kell adja.
* A böngészős tesztek (`tests/e2e/`) saját statikus szervert és egy
  függőség nélküli MQTT-over-WebSocket brókert indítanak
  (`tests/e2e/lib/mini-mqtt.mjs`), így a relés hálózati játék valódi
  mqtt.js-sel, internet nélkül is tesztelhető. A Playwrightot a
  `PLAYWRIGHT_MODULE` változóból vagy egy telepített `playwright`
  csomagból veszik.
* A `tests/net-relay.test.js` valódi-brókeres része csak akkor fut, ha az
  `aedes`, `ws` és `mqtt` csomag telepítve van (`npm install --no-save aedes ws mqtt`).

## Szerkezet

```
index.html            az applet (egyetlen oldal)
src/engine/           szabályok (game.js), tábla (board.js), gépi játékos (ai.js), Java-kompatibilis RNG
src/net/              lockstep session (session.js), világ/napló (world.js), protokoll, átvitelek:
  transports/         relay.js (MQTT), peerjs.js (WebRTC), multi.js (a kettő együtt),
                      broadcast.js (két fül), memory.js (unit tesztek)
src/ui/app.js         az applet: panel, árkártya, kezek, kocka, gombok, cserepanel, menük
src/ui/lobby.js       a hálózati ablak (szoba nyitása, csatlakozás, helyek, indítás)
src/ui/paint.js       Board/Haz/Rablo/Kocka rajzolása az applet kódja szerint
src/ui/swing.js       Swing Metal: menüsor, gombok, JOptionPane, keretes ablak
src/ui/i18n.js        magyar és angol szövegek
assets/image/         az eredeti applet képei
tests/                unit tesztek; tests/e2e/ böngészős tesztek
docs/HALOZAT.md       hogyan működik a hálózati játék
```

## Hogyan működik a hálózat (röviden)

A motor determinisztikus (minden véletlenszám a játék saját RNG-jéből jön),
ezért egy játszma teljesen leírható a kezdőbeállításokkal és a lépések
sorrendjével. Mindenkinél fut egy teljes játék, és mindenki ugyanazokat a
lépéseket alkalmazza ugyanabban a sorrendben; a sorrendet a házigazda
dönti el, és minden lépés után állapot-hash-t küld, így az eltérés azonnal
kiderül (ilyenkor a vendég a házigazda naplójából újraépíti az állást).
Részletek: `docs/HALOZAT.md`.

## GitHub Pages

A `.github/workflows/pages.yml` minden pusholáskor futtatja a teszteket, és
a `main` ágat kiteszi GitHub Pagesre (Settings → Pages → Source: *GitHub
Actions*). Így a játék egy linkkel elérhető, a hálózati játékhoz nem kell
semmit telepíteni.

## Eredet és licenc

* Az eredeti applet és a képek: P. Csurgay, 2004 (https://github.com/csurgay/catan).
* A motor, a gépi játékos, a hálózati réteg és az eredeti nézet HTML5-ös
  változata a https://github.com/LansPeti/catan-javascript projektből
  (Lanszki Péter, MIT) származik; ez a repó annak az eredeti nézetre és a
  hálózati játékra szűkített, továbbfejlesztett változata.
* Forráskód: MIT. Az `assets/image/` képei az eredeti appletből valók.
  A „Catan” a Catan GmbH védjegye.
