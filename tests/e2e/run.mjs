// Browser tests against the real page (npm run test:e2e).
//
// Starts its own static file server and a tiny MQTT-over-WebSocket broker
// (lib/mini-mqtt.mjs, no dependencies), serves the vendored mqtt.js /
// PeerJS bundles in place of the CDN, and runs every scenario in
// scenarios/*.mjs. Each scenario fails on an assertion, a console error, a
// page error or an unexpected 404. Screenshots go to tests/e2e/out/.
//
// Playwright is not a dependency: it is imported from PLAYWRIGHT_MODULE, or
// `playwright` if it resolves, or the pre-installed global copy.
//   node tests/e2e/run.mjs            all scenarios
//   node tests/e2e/run.mjs net        only scenarios whose title has "net"

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startMiniMqtt } from './lib/mini-mqtt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'out');
const VENDOR = path.join(__dirname, 'vendor');
fs.mkdirSync(OUT_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const filePath = path.normalize(path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath));
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/node22/lib/node_modules/playwright/index.mjs', '/usr/lib/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const p of tries) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await import(p.startsWith('/') ? pathToFileURL(p).href : p);
    } catch { /* next */ }
  }
  throw new Error('Playwright not found: set PLAYWRIGHT_MODULE or npm install playwright');
}

// ------------------------------------------------------------------ helpers handed to the scenarios

function assert(cond, msg) { if (!cond) throw new Error(`assertion failed: ${msg}`); }

let BASE = '';
let BROKER_URL = '';
let browser = null;

// A page that records console errors, page errors and failed requests;
// finish() throws if any happened.
async function newTrackedPage(context, label) {
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.stack || e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(BASE)) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  // The CDN libraries come from tests/e2e/vendor (same files, same SRI).
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/mqtt/**', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(VENDOR, 'mqtt.min.js')), headers: { 'Access-Control-Allow-Origin': '*' },
  }));
  await page.route('https://cdnjs.cloudflare.com/ajax/libs/peerjs/**', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(VENDOR, 'peerjs.min.js')), headers: { 'Access-Control-Allow-Origin': '*' },
  }));
  return {
    page,
    finish: () => { if (problems.length) throw new Error(`${label}: ${problems.length} problem(s):\n  ${problems.join('\n  ')}`); },
    screenshot: (name) => page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) }),
  };
}

const scenarios = [];
function scenario(title, fn) { scenarios.push({ title, fn }); }

const helpers = {
  assert,
  newTrackedPage,
  base: () => BASE,
  broker: () => BROKER_URL,
  outDir: OUT_DIR,
};

// ------------------------------------------------------------------ main

const filter = process.argv[2] || '';
const dir = path.join(__dirname, 'scenarios');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs')).sort()) {
  // eslint-disable-next-line no-await-in-loop
  const mod = await import(pathToFileURL(path.join(dir, f)).href);
  mod.register(scenario, helpers);
}

const pw = await loadPlaywright();
const server = await startServer();
BASE = `http://127.0.0.1:${server.address().port}`;
const broker = await startMiniMqtt();
BROKER_URL = broker.url;
browser = await (pw.chromium || pw.default.chromium).launch();
const ctx = { browser: () => browser };

let failed = 0;
for (const sc of scenarios.filter((s) => s.title.includes(filter))) {
  const t0 = Date.now();
  try {
    // eslint-disable-next-line no-await-in-loop
    const note = await sc.fn(ctx);
    console.log(`ok   ${sc.title} (${((Date.now() - t0) / 1000).toFixed(1)} s)${note ? ` -- ${note}` : ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${sc.title}\n     ${String(err.stack || err).split('\n').join('\n     ')}`);
  }
}

await browser.close();
await broker.stop();
server.close();
console.log(failed ? `\n${failed} scenario(s) failed` : '\nall scenarios passed');
process.exit(failed ? 1 : 0);
