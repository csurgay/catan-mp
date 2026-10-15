// The page loads without errors and a game of computers runs to its end.
export function register(scenario, h) {
  scenario('s0) smoke: the page loads, four computers play a game to the end', async (ctx) => {
    const context = await ctx.browser().newContext({ viewport: { width: 1024, height: 789 } });
    const { page, finish, screenshot } = await h.newTrackedPage(context, 's0');
    await page.goto(`${h.base()}/index.html?seed=42&players=4&computer=1111&test=1&lang=en`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
    await page.waitForFunction(() => window.__orig.game.phase === 'gameOver', null, { timeout: 30000 });
    await page.waitForSelector('[data-test="dialog-winner"]');
    const msg = await page.locator('[data-test="dialog-winner"] .o-dlg-msg').innerText();
    h.assert(/\d+ Siegpunkte/.test(msg), `winner dialog, got ${msg}`);
    await screenshot('s0-game-over');
    finish();
    await context.close();
    return msg;
  });
}
