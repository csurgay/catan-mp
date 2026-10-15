// The 2004 applet's look (Metal, 1024x768 under a menu bar), played alone
// against the computer. Real mouse clicks through the original interaction
// model: pick a piece up from the price card and drop it on the board, roll
// by clicking the dice, select cards, trade in 4:1 through a JOptionPane,
// compose a trade on the green panel, play a knight and move the robber.

export function register(scenario, h) {
  const { assert, newTrackedPage, base } = h;

  async function open(ctx, label, query) {
    const context = await ctx.browser().newContext({ viewport: { width: 1024, height: 789 } });
    const t = await newTrackedPage(context, label);
    await t.page.goto(`${base()}/index.html?${query}&lang=en`, { waitUntil: 'load' });
    await t.page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 10000 });
    return { ...t, context };
  }
  const st = (page) => page.evaluate(() => window.__orig.state());
  const juncXY = (page, no) => page.evaluate((n) => { const j = window.__orig.game.board.junctions[n]; return [330 + j.x, 71 + j.y]; }, no);
  const waitHuman = (page) => page.waitForFunction(() => {
    const s = window.__orig.state(); const g = window.__orig.game;
    return (!g.players[s.actor].comp || g.phase === 'gameOver') && !s.busy && !s.dialog;
  }, null, { timeout: 20000 });

  scenario('o1) original look: only the applet (no header/footer), applet geometry, setup by real clicks, dice, AI rounds, menus', async (ctx) => {
    const { page, finish, context } = await open(ctx, 'o1', 'seed=42&players=4&computer=0111&test=1');
    // Nothing but the applet: no header, no footer, no modern chrome.
    const chrome = await page.evaluate(() => ({
      bodyKids: [...document.body.children].filter((e) => e.tagName !== 'SCRIPT').map((e) => e.id),
      header: !!document.querySelector('header, footer, #app-header, #app-footer'),
      applet: (() => { const r = document.getElementById('applet').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })(),
    }));
    assert(chrome.bodyKids.length === 1 && chrome.bodyKids[0] === 'applet' && !chrome.header, `only #applet in the body, got ${JSON.stringify(chrome)}`);
    assert(chrome.applet.join() === '0,0,1024,789', `applet 1024x789 at 0,0, got ${chrome.applet}`);
    // The applet's own coordinates (S.java etc.; the panel sits under a 21 px menu bar).
    const at = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }, sel);
    const want = {
      '[data-test="player-select"]': [10, 201, 255, 45], '[data-test="dice"]': [10, 251, 107, 60],
      '[data-test="btn-bank"]': [120, 251, 46, 60], '[data-test="btn-trade"]': [170, 251, 46, 60], '[data-test="btn-next"]': [220, 251, 46, 60],
      '[data-test="slot-settlement"]': [169, 413, 27, 24],
    };
    for (const [sel, box] of Object.entries(want)) {
      // eslint-disable-next-line no-await-in-loop
      const got = await at(sel);
      assert(got.join() === box.join(), `${sel} at ${box}, got ${got}`);
    }
    // Setup, twice: pick up the house, drop it on a legal junction, the same with the road, next.
    for (let round = 0; round < 2; round++) {
      // eslint-disable-next-line no-await-in-loop
      await waitHuman(page);
      // eslint-disable-next-line no-await-in-loop
      const legal = await page.evaluate(() => { const g = window.__orig.game; return g.legalSettlements(1).filter((n) => g.canPlaceSettlement(1, n)); });
      // eslint-disable-next-line no-await-in-loop
      await page.click('[data-test="slot-settlement"]');
      // eslint-disable-next-line no-await-in-loop
      assert((await st(page)).carrying === 'settlement', 'carrying the house');
      // eslint-disable-next-line no-await-in-loop
      const cursor = await page.evaluate(() => document.getElementById('applet').style.cursor);
      assert(cursor.includes('hazCursor'), `house cursor, got ${cursor}`);
      // eslint-disable-next-line no-await-in-loop
      const [x, y] = await juncXY(page, legal[0]);
      // eslint-disable-next-line no-await-in-loop
      await page.mouse.click(x, y);
      // eslint-disable-next-line no-await-in-loop
      const roads = await page.evaluate(() => window.__orig.game.legalRoads(1));
      // eslint-disable-next-line no-await-in-loop
      await page.click('[data-test="slot-road1"]');
      // eslint-disable-next-line no-await-in-loop
      const [ax, ay] = await juncXY(page, roads[0][0]);
      // eslint-disable-next-line no-await-in-loop
      const [bx, by] = await juncXY(page, roads[0][1]);
      // eslint-disable-next-line no-await-in-loop
      await page.mouse.click((ax + bx) / 2, (ay + by) / 2);
      // eslint-disable-next-line no-await-in-loop
      const placed = await page.evaluate(() => window.__orig.game.players[1].placed);
      assert(placed.settlements === round + 1 && placed.roads === round + 1, `setup round ${round + 1} placed by clicks, got ${JSON.stringify(placed)}`);
      // eslint-disable-next-line no-await-in-loop
      await page.click('[data-test="btn-next"]');
    }
    // Normal play: roll by clicking the dice, then let the computers play.
    let rolled = 0;
    for (let r = 0; r < 4; r++) {
      // eslint-disable-next-line no-await-in-loop
      await waitHuman(page);
      // eslint-disable-next-line no-await-in-loop
      let s = await st(page);
      if (s.phase === 'roll') {
        // eslint-disable-next-line no-await-in-loop
        await page.click('[data-test="dice"]');
        // eslint-disable-next-line no-await-in-loop
        await page.waitForFunction(() => window.__orig.game.phase !== 'roll', null, { timeout: 5000 });
        rolled++;
        // eslint-disable-next-line no-await-in-loop
        await waitHuman(page);
        // eslint-disable-next-line no-await-in-loop
        s = await st(page);
      }
      // A 7: discard by dialogs if asked, move the robber by picking it up.
      // eslint-disable-next-line no-await-in-loop
      while (await page.locator('[data-test="dialog-discard"]').count()) { await page.click('[data-test="dialog-discard"] [data-test="dialog-option-0"]'); await page.waitForTimeout(30); }
      // eslint-disable-next-line no-await-in-loop
      s = await st(page);
      if (s.phase === 'moveRobber') {
        // eslint-disable-next-line no-await-in-loop
        const rb = await page.evaluate(() => { const t = window.__orig.game.board.robberTile; return [330 + t.x + 20, 71 + t.y - 15]; });
        // eslint-disable-next-line no-await-in-loop
        await page.mouse.click(rb[0], rb[1]);
        // eslint-disable-next-line no-await-in-loop
        const to = await page.evaluate(() => { const g = window.__orig.game; const t = g.board.tiles.find((x) => x.type === 'N' && x !== g.board.robberTile); return [330 + t.x, 71 + t.y]; });
        // eslint-disable-next-line no-await-in-loop
        await page.mouse.click(to[0], to[1]);
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(100);
        // eslint-disable-next-line no-await-in-loop
        for (const d of ['dialog-info', 'dialog-victim']) if (await page.locator(`[data-test="${d}"]`).count()) await page.click(`[data-test="${d}"] [data-test="dialog-option-0"]`);
        // eslint-disable-next-line no-await-in-loop
        await waitHuman(page);
      }
      // eslint-disable-next-line no-await-in-loop
      if ((await st(page)).phase === 'main') await page.click('[data-test="btn-next"]');
    }
    assert(rolled >= 3, `rolled by clicking the dice ${rolled}x`);
    const turns = await page.evaluate(() => window.__orig.game.turnNumber);
    assert(turns >= 12, `computers played too (turnNumber ${turns})`);
    // Menus: New > Game for 3 players starts a 3-player game.
    await page.click('[data-test="menu-New"]');
    const items = await page.locator('.o-popup .o-mi').allInnerTexts();
    assert(items.join('|') === 'Game for 3 players|Game for 4 players|Game for 5 players|Game for 6 players', `New menu items, got ${items}`);
    await page.locator('[data-test="mi-new-3"]').dispatchEvent('mouseup');
    await page.waitForFunction(() => window.__orig.game.numPlayers === 3);
    await page.click('[data-test="menu-Options"]');
    const opts = await page.locator('.o-popup .o-mi').allInnerTexts();
    assert(opts.includes('Open Hands') && opts.includes('Entwicklungs Deck'), `Options menu, got ${opts}`);
    await page.keyboard.press('Escape');
    // The menu bar: the applet's four menus, then Network and Language.
    const titles = await page.locator('#o-menubar .o-menu-title').allInnerTexts();
    assert(titles.join('|') === 'New|Players|Computer|Options|Network|Language', `menu bar, got ${titles}`);
    finish();
    await context.close();
    return `setup by clicks, rolled ${rolled}x by the dice, ${turns} turns played, menus work`;
  });

  scenario('o2) original dialogs: 4:1 trade-in, the green trade panel, a knight and the robber, all by clicks', async (ctx) => {
    const { page, finish, context } = await open(ctx, 'o2', 'seed=42&players=4&computer=0111&test=1');
    // Fast-forward the setup with the engine's own AI, then hand player 1 cards and a knight.
    await page.evaluate(async () => {
      const { createAI } = await import('/src/engine/ai.js');
      const g = window.__orig.game;
      const ai = createAI();
      g.setComputer(1, true);
      let n = 0;
      while (!(g.rounds >= 3 && g.current === 1 && g.phase === 'roll') && n++ < 3000) ai.step(g);
      g.setComputer(1, false);
      g.forceNextRoll([3, 5]);
      g.rollDice();
      g.takeCards(1, g.players[1].hand.join(''));
      g.giveCards(1, 'ffffkt');
      g.players[1].dev.push({ res: 'l', played: false });
      window.__orig.refresh();
    });
    await waitHuman(page);
    // Select the four 'f' cards: selected cards rise by 20 px.
    for (let i = 0; i < 4; i++) await page.click(`[data-test="hand-card-${i}"]`); // eslint-disable-line no-await-in-loop
    const tops = await page.evaluate(() => [0, 4].map((i) => document.querySelector(`[data-test="hand-card-${i}"]`).getBoundingClientRect().top));
    assert(tops[1] - tops[0] === 20, `selected card raised by 20 px, got ${tops}`);
    assert(await page.locator('[data-test="btn-bank"]').isEnabled(), '4:1 enabled with four cards selected');
    await page.click('[data-test="btn-bank"]');
    await page.waitForSelector('[data-test="dialog-bank"]');
    const title = await page.locator('[data-test="dialog-bank"] .o-dlg-title').innerText();
    assert(title.includes('Trading in'), `dialog title, got ${title}`);
    await page.click('[data-test="dialog-bank"] [data-test="dialog-option-4"]');
    const handAfter = await page.evaluate(() => window.__orig.game.players[1].hand.join(''));
    assert(handAfter === 'ktk', `traded ffff for a k, got ${handAfter}`);
    // Trade panel: offer the 't' for an 'f', submit, the computers answer.
    await page.click('[data-test="hand-card-1"]');
    await page.click('[data-test="btn-trade"]');
    await page.click('[data-test="dialog-trade-offer"] [data-test="dialog-option-0"]');
    await page.waitForSelector('[data-test="trade-panel"]', { state: 'visible' });
    const panel = await page.evaluate(() => { const r = document.querySelector('[data-test="trade-panel"]').getBoundingClientRect(); return [r.left, r.top - 21, r.width, r.height, getComputedStyle(document.querySelector('[data-test="trade-panel"]')).backgroundColor]; });
    assert(panel.slice(0, 4).join() === '450,250,430,220' && panel[4] === 'rgb(20, 180, 20)', `Csere panel geometry/colour, got ${panel}`);
    await page.click('[data-test="trade-ok"]');
    await page.waitForFunction(() => window.__orig.game.phase === 'main', null, { timeout: 10000 });
    // The knight: click the card, choose its face, the robber lies down; pick it up and move it.
    await waitHuman(page);
    const robberBefore = await page.evaluate(() => window.__orig.game.board.robberTile.idx);
    await page.click('[data-test="dev-card-0"]');
    await page.click('[data-test="dialog-card"] [data-test="dialog-option-0"]');
    await page.waitForFunction(() => window.__orig.game.phase === 'moveRobber');
    const rb = await page.evaluate(() => { const t = window.__orig.game.board.robberTile; return [330 + t.x + 20, 71 + t.y - 15]; });
    await page.mouse.click(rb[0], rb[1]);
    assert((await st(page)).carrying === 'robber', 'picked the robber up');
    const to = await page.evaluate(() => { const g = window.__orig.game; const t = g.board.tiles.find((x) => x.type === 'N' && x !== g.board.robberTile); return [t.idx, 330 + t.x, 71 + t.y]; });
    await page.mouse.click(to[1], to[2]);
    await page.waitForTimeout(100);
    for (const d of ['dialog-info', 'dialog-victim']) if (await page.locator(`[data-test="${d}"]`).count()) await page.click(`[data-test="${d}"] [data-test="dialog-option-0"]`); // eslint-disable-line no-await-in-loop
    const robberAfter = await page.evaluate(() => window.__orig.game.board.robberTile.idx);
    assert(robberAfter === to[0] && robberAfter !== robberBefore, `robber moved ${robberBefore} -> ${to[0]}, got ${robberAfter}`);
    finish();
    await context.close();
    return 'trade-in, trade panel, knight + robber by clicks';
  });
}
