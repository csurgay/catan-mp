// Network play in the original look: two pages, one hosts a room, the
// other joins with the code; both play by real mouse clicks; every page
// must hold the same game (state hash) all along.
//   n1  same browser (?transport=local, BroadcastChannel), lobby by clicks
//   n2  the real relay path: mqtt.js in the page, an MQTT broker over
//       WebSocket (tests/e2e/lib/mini-mqtt.mjs); reload = reconnect to the
//       same seat; the host leaving ends the game for the guest

export function register(scenario, h) {
  const { assert, newTrackedPage, base } = h;

  async function openPage(context, label, query) {
    const t = await newTrackedPage(context, label);
    await t.page.goto(`${base()}/index.html?${query}`, { waitUntil: 'load' });
    await t.page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 10000 });
    return t;
  }

  const menu = async (page, title, item) => {
    await page.click(`[data-test="menu-${title}"]`);
    await page.locator(`[data-test="mi-${item}"]`).dispatchEvent('mouseup');
  };
  const st = (page) => page.evaluate(() => window.__orig.state());
  const hash = (page) => page.evaluate(() => window.__net.session && window.__net.session.hash());
  const juncXY = (page, no) => page.evaluate((n) => { const j = window.__orig.game.board.junctions[n]; return [330 + j.x, 71 + j.y]; }, no);

  // Waits until every page has the same number of entries and the same hash.
  async function inSync(pages, timeout = 10000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeout) {
      // eslint-disable-next-line no-await-in-loop
      const ss = await Promise.all(pages.map((p) => p.evaluate(() => { const s = window.__net.session; return s && s.game ? [s.entries.length, s.hash()] : null; })));
      last = ss;
      if (ss.every((x) => x && x[0] === ss[0][0] && x[1] === ss[0][1])) return ss[0];
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`pages not in sync: ${JSON.stringify(last)}`);
  }

  // The page's own seat is to act, nothing pending (no dialog, no dice rolling).
  const myMove = (page) => page.evaluate(() => {
    const s = window.__orig.state(); const g = window.__orig.game;
    return !!(s.net && s.net.started && g.phase !== 'gameOver' && s.actor === s.net.seat && !g.players[s.actor].comp && !s.busy);
  });

  // One setup turn by clicks: house from the price card to a legal corner, a road next to it, next.
  async function setupTurn(page, seat) {
    const legal = await page.evaluate((p) => { const g = window.__orig.game; return g.legalSettlements(p).filter((n) => g.canPlaceSettlement(p, n)); }, seat);
    await page.click('[data-test="slot-settlement"]');
    const [x, y] = await juncXY(page, legal[0]);
    await page.mouse.click(x, y);
    await page.waitForFunction((p) => window.__orig.game.phase === 'setup' && window.__orig.game.legalRoads(p).length > 0, seat);
    const roads = await page.evaluate((p) => window.__orig.game.legalRoads(p), seat);
    await page.click('[data-test="slot-road1"]');
    const [ax, ay] = await juncXY(page, roads[0][0]);
    const [bx, by] = await juncXY(page, roads[0][1]);
    await page.mouse.click((ax + bx) / 2, (ay + by) / 2);
    await page.click('[data-test="btn-next"]');
  }

  // A turn in the main game by clicks: dice, discard dialogs, robber, next.
  async function mainTurn(page, stop = null) {
    let s = await st(page);
    if (s.phase === 'roll') {
      await page.click('[data-test="dice"]');
      await page.waitForFunction(() => window.__orig.game.phase !== 'roll', null, { timeout: 5000 });
      await page.waitForTimeout(50);
    }
    for (let k = 0; k < 20; k++) {
      // eslint-disable-next-line no-await-in-loop
      if (await page.locator('[data-test="dialog-discard"]').count()) { await page.click('[data-test="dialog-discard"] [data-test="dialog-option-0"]'); await page.waitForTimeout(30); continue; } // eslint-disable-line no-await-in-loop
      // eslint-disable-next-line no-await-in-loop
      if (await page.locator('[data-test="dialog-victim"]').count()) { await page.click('[data-test="dialog-victim"] [data-test="dialog-option-0"]'); await page.waitForTimeout(30); continue; } // eslint-disable-line no-await-in-loop
      // eslint-disable-next-line no-await-in-loop
      if (await page.locator('[data-test="dialog-info"]').count()) { await page.click('[data-test="dialog-info"] [data-test="dialog-option-0"]'); continue; } // eslint-disable-line no-await-in-loop
      break;
    }
    s = await st(page);
    if (s.phase === 'moveRobber' && s.actor === s.net.seat) {
      const rb = await page.evaluate(() => { const t = window.__orig.game.board.robberTile; return [330 + t.x + 20, 71 + t.y - 15]; });
      await page.mouse.click(rb[0], rb[1]);
      const to = await page.evaluate(() => { const g = window.__orig.game; const t = g.board.tiles.find((x) => x.type === 'N' && x !== g.board.robberTile); return [330 + t.x, 71 + t.y]; });
      await page.mouse.click(to[0], to[1]);
      await page.waitForTimeout(100);
      for (const d of ['dialog-info', 'dialog-victim']) if (await page.locator(`[data-test="${d}"]`).count()) await page.click(`[data-test="${d}"] [data-test="dialog-option-0"]`); // eslint-disable-line no-await-in-loop
    }
    s = await st(page);
    if (stop && await stop()) return;
    if (s.phase === 'main' && s.actor === s.net.seat) await page.click('[data-test="btn-next"]');
  }

  // Lets whichever page is to act take its turn, until the game is `turns` turns old.
  async function play(pages, {
    setupOnly = false, turns = 0, timeout = 60000, until = null,
  } = {}) {
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > timeout) {
        // eslint-disable-next-line no-await-in-loop
        const why = await Promise.all(pages.map((p) => p.evaluate(() => ({ s: window.__orig.state(), dialogs: [...document.querySelectorAll('.o-dialog')].map((d) => d.dataset.test) }))));
        throw new Error(`play: timed out ${JSON.stringify(why)}`);
      }
      // eslint-disable-next-line no-await-in-loop
      if (until && await until()) return;
      // eslint-disable-next-line no-await-in-loop
      const g = await pages[0].evaluate(() => ({ phase: window.__orig.game.phase, turn: window.__orig.game.turnNumber }));
      if (setupOnly && g.phase !== 'setup') return;
      if (!setupOnly && !until && (g.turn >= turns || g.phase === 'gameOver')) return;
      if (until && g.phase === 'gameOver') throw new Error('play: the game ended before the condition held');
      let moved = false;
      for (const p of pages) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await myMove(p))) continue;
        // eslint-disable-next-line no-await-in-loop
        const s = await st(p);
        // eslint-disable-next-line no-await-in-loop
        if (s.phase === 'setup') await setupTurn(p, s.net.seat); else await mainTurn(p, until);
        moved = true;
      }
      // Discards and victims are asked of a seat that is not the current one.
      for (const p of pages) {
        // eslint-disable-next-line no-await-in-loop
        if (await p.locator('[data-test="dialog-discard"], [data-test="dialog-victim"]').count()) { await mainTurn(p); moved = true; }
      }
      // eslint-disable-next-line no-await-in-loop
      if (!moved) await new Promise((r) => setTimeout(r, 40));
    }
  }

  scenario('n1) net, one browser: host opens a room by the menu, guest joins by the code, setup and rounds by clicks, both pages identical', async (ctx) => {
    const context = await ctx.browser().newContext({ viewport: { width: 1024, height: 789 } });
    const A = await openPage(context, 'n1-host', 'test=1&lang=en&transport=local');
    // Host: Network > Create room…, a name, 3 players, open.
    await menu(A.page, 'Network', 'net-host');
    await A.page.waitForSelector('[data-test="net-host"]');
    await A.page.fill('[data-test="net-name"]', 'Peter');
    await A.page.click('[data-test="net-players-3"]');
    await A.page.click('[data-test="net-open"]');
    await A.page.waitForSelector('[data-test="net-code"]');
    const code = await A.page.locator('[data-test="net-code"]').innerText();
    assert(/^[A-Z2-9]{5}$/.test(code), `room code, got ${code}`);
    // The status box in the free corner shows the room.
    assert((await A.page.locator('[data-test="net-status"]').innerText()).includes(code), 'status box shows the code');

    // Guest: the invitation link opens the join dialog with the code in it.
    const B = await openPage(context, 'n1-guest', `test=1&lang=en&transport=local&join=${code}`);
    await B.page.waitForSelector('[data-test="net-join"]');
    assert(await B.page.inputValue('[data-test="net-code-input"]') === code, 'code prefilled from ?join=');
    await B.page.fill('[data-test="net-name"]', 'Anna');
    await B.page.click('[data-test="net-join-button"]');
    await B.page.waitForFunction(() => window.__net.state().session && window.__net.state().session.mySeat === 2);
    await A.page.waitForFunction(() => window.__net.state().seats.some((s) => s.seat === 2 && s.name === 'Anna' && s.connected));
    const hostSeats = await A.page.locator('[data-test="net-seats"]').innerText();
    assert(hostSeats.includes('Peter') && hostSeats.includes('Anna'), `host lobby lists both, got ${hostSeats}`);
    assert((await B.page.locator('[data-test="net-host"], [data-test="net-join"]').innerText()).includes('Waiting for the host'), 'guest waits for the start');
    // Seat 3 is empty: the computer takes it at the start.
    await A.page.click('[data-test="net-start"]');
    await Promise.all([A, B].map((x) => x.page.waitForFunction(() => { const s = window.__orig.state(); return s.net && s.net.started && !s.dialog; })));
    await inSync([A.page, B.page]);
    const comp = await B.page.evaluate(() => [1, 2, 3].map((i) => window.__orig.game.players[i].comp));
    assert(comp.join() === 'false,false,true', `seats human,human,computer, got ${comp}`);
    // In a room the deck and the other hands are secrets; the computer menu belongs to the lobby.
    await B.page.click('[data-test="menu-Options"]');
    assert(await B.page.locator('[data-test="mi-open-hands"]').evaluate((e) => e.classList.contains('disabled')), 'Open Hands disabled in a room');
    await B.page.keyboard.press('Escape');

    await play([A.page, B.page], { setupOnly: true });
    const placed = await inSync([A.page, B.page]);
    const counts = await B.page.evaluate(() => [1, 2, 3].map((i) => window.__orig.game.players[i].placed.settlements));
    assert(counts.join() === '2,2,2', `everyone placed two houses, got ${counts}`);
    await play([A.page, B.page], { turns: 12 });
    const after = await inSync([A.page, B.page]);
    assert(after[0] > placed[0], 'the game went on');
    // Each page shows its own hand face up and nobody else's.
    const faces = await Promise.all([A, B].map((x) => x.page.evaluate(() => {
      const s = window.__orig.state();
      const srcs = [...document.querySelectorAll('[data-test^="hand-card-"]')].map((i) => i.getAttribute('src'));
      return { shown: s.shown, seat: s.net.seat, back: srcs.filter((x) => x.includes('hatlap')).length, n: srcs.length };
    })));
    for (const f of faces) assert(f.shown !== f.seat || f.back === 0, `own hand face up, got ${JSON.stringify(f)}`);
    // Hovering the other human's house on the strip shows that hand face down.
    await B.page.mouse.move(10 + 1 * 42 - 32 + 10, 201 + 20);
    await B.page.waitForFunction(() => window.__orig.state().shown === 1);
    const other = await B.page.evaluate(() => [...document.querySelectorAll('[data-test^="hand-card-"]')].map((i) => i.getAttribute('src')));
    assert(other.every((x) => x.includes('hatlap')), `seat 1's hand face down on the guest's page, got ${other}`);
    await B.page.mouse.move(600, 700);
    await A.screenshot('n1-host');
    await B.screenshot('n1-guest');
    A.finish(); B.finish();
    await context.close();
    return `room ${code}: ${after[0]} entries, hash ${after[1]} on both pages`;
  });

  scenario('n2) net over the MQTT relay (real mqtt.js): join, play, reload = reconnect to the same seat, the host leaves', async (ctx) => {
    const relay = encodeURIComponent(h.broker());
    const ca = await ctx.browser().newContext({ viewport: { width: 1024, height: 789 } });
    const cb = await ctx.browser().newContext({ viewport: { width: 1024, height: 789 } });
    const A = await openPage(ca, 'n2-host', `test=1&lang=hu&transport=relay&relay=${relay}`);
    const code = await A.page.evaluate(() => window.__net.host({ name: 'Házigazda', players: 3, seed: 7 }));
    // The invitation link carries the relay override along.
    const B = await openPage(cb, 'n2-guest', `test=1&lang=hu&transport=relay&relay=${relay}&join=${code}`);
    await B.page.fill('[data-test="net-name"]', 'Vendég');
    await B.page.click('[data-test="net-join-button"]');
    await A.page.waitForFunction(() => window.__net.state().seats.some((s) => s.seat === 2 && s.connected));
    // Hungarian texts in the lobby and the menus.
    const startLabel = await A.page.locator('[data-test="net-start"]').innerText();
    assert(startLabel === 'Játék indítása', `HU start button, got ${startLabel}`);
    const titles = await A.page.locator('#o-menubar .o-menu-title').allInnerTexts();
    assert(titles.join('|') === 'Új|Játékosok|Számítógép|Beállítások|Hálózat|Nyelv', `HU menu bar, got ${titles}`);
    await A.page.click('[data-test="net-start"]');
    await Promise.all([A, B].map((x) => x.page.waitForFunction(() => { const s = window.__orig.state(); return s.net && s.net.started && !s.dialog; })));
    await play([A.page, B.page], { setupOnly: true, timeout: 60000 });
    await play([A.page, B.page], { turns: 8, timeout: 60000 });
    const before = await inSync([A.page, B.page], 15000);

    // The guest reloads the tab: the token in sessionStorage gets the same seat back.
    await B.page.reload({ waitUntil: 'load' });
    await B.page.waitForFunction(() => document.documentElement.dataset.ready === '1');
    await B.page.waitForSelector('[data-test="net-join"]');
    await B.page.click('[data-test="net-join-button"]');
    try {
      await B.page.waitForFunction(() => { const s = window.__orig.state(); return s.net && s.net.started && s.net.seat === 2; }, null, { timeout: 15000 });
    } catch (err) {
      throw new Error(`reconnect: guest ${JSON.stringify(await B.page.evaluate(() => ({ net: window.__net.state(), orig: window.__orig.state() })))}`);
    }
    const back = await inSync([A.page, B.page], 15000);
    assert(back[0] >= before[0], 'the guest got the whole game back');
    const seat2 = await A.page.evaluate(() => window.__orig.game.players[2].comp);
    assert(seat2 === false, 'seat 2 is a human again after the reconnect');
    await play([A.page, B.page], { turns: 12, timeout: 60000 });
    const later = await inSync([A.page, B.page], 15000);

    // The host leaves: the guest is told, the game stops there.
    await menu(A.page, 'Network', 'net-leave');
    await B.page.waitForSelector('[data-test="dialog-warning"]', { timeout: 15000 });
    const msg = await B.page.locator('[data-test="dialog-warning"] .o-dlg-msg').innerText();
    assert(msg.includes('A házigazda kilépett'), `guest told the host left, got ${msg}`);
    const closed = await B.page.evaluate(() => window.__orig.state().net.closed);
    assert(closed, 'guest page marks the room closed');
    // The host is back to a solo game.
    assert(await A.page.evaluate(() => window.__orig.state().net === null), 'host page left the room');
    await B.screenshot('n2-guest-host-left');
    A.finish(); B.finish();
    await ca.close(); await cb.close();
    return `relay room ${code}: ${later[0]} entries in step, reconnect kept seat 2`;
  });

  scenario('n3) net: a trade offer answered on the other page; a guest who vanishes is played by the computer; language switch in a room', async (ctx) => {
    const context = await ctx.browser().newContext({ viewport: { width: 1024, height: 789 } });
    const guestCtx = await ctx.browser().newContext({ viewport: { width: 1024, height: 789 } });
    const A = await openPage(context, 'n3-host', 'test=1&lang=en&transport=local');
    const code = await A.page.evaluate(() => window.__net.host({ name: 'Host', players: 3 }));
    // A second page of the same browser (BroadcastChannel needs one context).
    const B = await openPage(context, 'n3-guest', `test=1&lang=en&transport=local&join=${code}`);
    await B.page.evaluate(() => window.__net.join({ name: 'Guest' }));
    await A.page.evaluate(() => window.__net.start(11));
    await Promise.all([A, B].map((x) => x.page.waitForFunction(() => { const s = window.__orig.state(); return s.net && s.net.started && !s.dialog; })));
    // Play until the host is in its main phase holding a card.
    const hostCanOffer = () => A.page.evaluate(() => {
      const s = window.__orig.state(); const g = window.__orig.game;
      return s.phase === 'main' && s.actor === 1 && !s.busy && g.players[1].hand.length > 0;
    });
    await play([A.page, B.page], { until: hostCanOffer, timeout: 60000 });
    // Offer one card for a resource it is not.
    const give = await A.page.evaluate(() => window.__orig.game.players[1].hand[0]);
    const want = 'ftbjk'.split('').findIndex((r) => r !== give);
    await A.page.click('[data-test="hand-card-0"]');
    await A.page.click('[data-test="btn-trade"]');
    await A.page.click(`[data-test="dialog-trade-offer"] [data-test="dialog-option-${want}"]`);
    await A.page.click('[data-test="trade-ok"]');
    // The guest (seat 2) answers first: its page shows the panel with the buttons live.
    await B.page.waitForFunction(() => { const g = window.__orig.game; return g.phase === 'trade' && g.trade.responder === 2; });
    await B.page.waitForSelector('[data-test="trade-panel"]', { state: 'visible' });
    const passLabel = await B.page.locator('[data-test="trade-ok"]').innerText();
    assert(passLabel === 'Pass' && await B.page.locator('[data-test="trade-ok"]').isEnabled(), `guest can answer, got ${passLabel}`);
    assert(!(await A.page.locator('[data-test="trade-ok"]').isEnabled()), 'the host cannot answer for the guest');
    await B.page.click('[data-test="trade-ok"]');
    // Seat 3 (computer, driven by the host) answers next; the round closes.
    await A.page.waitForFunction(() => window.__orig.game.phase === 'main', null, { timeout: 10000 });
    await inSync([A.page, B.page]);
    const answers = await A.page.evaluate(() => window.__orig.game.log.filter((e) => e.type === 'tradeResponse').map((e) => e.player));
    assert(answers.includes(2), `the guest's answer is in the log, got ${answers}`);

    // The guest's page goes away without a word: the computer takes seat 2 over.
    await B.page.close({ runBeforeUnload: false });
    await A.page.waitForFunction(() => window.__orig.game.players[2].comp === true, null, { timeout: 20000 });
    const box = await A.page.locator('[data-test="net-status"]').innerText();
    assert(/Guest \(.*computer/.test(box), `status box shows the stand-in, got ${box}`);
    const turn0 = await A.page.evaluate(() => window.__orig.game.turnNumber);
    await play([A.page], { turns: turn0 + 3, timeout: 30000 });
    // Language switch in the middle of a room game.
    await menu(A.page, 'Language', 'lang-hu');
    const head = await A.page.locator('#o-net .o-net-head').innerText();
    assert(head === `${code} szoba`, `status box in Hungarian, got ${head}`);
    await A.screenshot('n3-host-after-drop');
    A.finish();
    await context.close(); await guestCtx.close();
    return `trade answered across pages; seat 2 handed to the computer after the drop`;
  });
}
