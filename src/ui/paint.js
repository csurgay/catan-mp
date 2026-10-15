// Canvas painting for the "original" look: a line-by-line port of the 2004
// applet's own paint code, at its own pixel coordinates.
//   Board.paintComponent  -> paintBoard()   (tiles, harbors, tokens, roads)
//   Haz.paintComponent    -> paintHaz()     (settlement/city polygons)
//   Rablo.paintComponent  -> paintRobber()
//   Kocka.paintComponent  -> paintDice()
// Everything is drawn in the coordinate space of the applet's main panel
// (S.java), where the board sits at (330, 50). S switched antialiasing on and
// set a 1.5 px stroke, and Swing handed that Graphics to every child, so the
// applet's lines were soft 1.5 px lines; the canvas default matches that.

import { getImage, RESOURCE_IMAGE } from './assets.js';

export const BOARD_X = 330; // Board(this, 330, 50) in S.java
export const BOARD_Y = 50;

export const PLAYER_COLORS = [
  '#000000', '#ff0000', '#0000ff', '#ffffff', 'rgb(255,150,10)', 'rgb(0,190,0)', 'rgb(153,92,0)',
];
const PONTERTEK = 'rgb(255,204,102)'; // U.pontertekColor (number tokens)
const KIKOTO = 'rgb(210,210,210)'; // U.kikotoColor (3:1 harbors)
const KOCKA = 'rgb(255,215,148)'; // U.kockaColor (dice)
const GREEN = 'rgb(20,180,20)'; // dice tray, trade panel

const TILE_IMAGE = { e: 'erdo', a: 'agyag', g: 'gabonatabla', l: 'legelo', h: 'hegy' };

// Haz.hvPx/hvPy: [1] settlement, [2] city, drawn in a 27x24 box.
export const HAZ_POLY = [
  null,
  [[3, 10], [10, 3], [17, 10], [17, 19], [3, 19], [3, 19], [3, 19]],
  [[1, 7], [7, 1], [13, 7], [13, 11], [25, 11], [25, 22], [1, 22]],
];

function poly(ctx, pts, ox, oy) {
  ctx.beginPath();
  ctx.moveTo(ox + pts[0][0], oy + pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(ox + pts[i][0], oy + pts[i][1]);
  ctx.closePath();
}

/**
 * Haz.paintComponent: a settlement (1) or city (2) in `player`'s colour with
 * a black 1.5 px outline, its 27x24 box at (x, y).
 * opts.order  -> the deployment-order digit (Options > Deployment Order)
 * opts.strip  -> the player-strip variant: yellow outline unless frameOnly,
 *                then the victory points, internals digits and the 'c' mark.
 */
export function paintHaz(ctx, type, player, x, y, opts = {}) {
  if (!type || !player) return;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'miter';
  ctx.fillStyle = PLAYER_COLORS[player];
  poly(ctx, HAZ_POLY[type], x, y);
  ctx.fill();
  ctx.strokeStyle = '#000';
  ctx.stroke();
  ctx.font = '12px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';
  if (opts.order) {
    const c = String(opts.order).charAt(0);
    if (type === 1) ctx.fillText(c, x + 7, y + 17); else ctx.fillText(c, x + 4, y + 19);
  }
  if (opts.strip) {
    if (!opts.frameOnly) {
      ctx.strokeStyle = '#ffff00';
      poly(ctx, HAZ_POLY[type], x, y);
      ctx.stroke();
    }
    const e = opts.vp || 0;
    if (e > 9) ctx.fillText(String(e).slice(0, 2), x + 1, y + 19);
    else ctx.fillText(String(e), x + 4, y + 19);
    if (opts.internals) {
      ctx.fillText(String(opts.settlements).charAt(0), x + 9, y + 21);
      ctx.fillText(String(opts.cities).charAt(0), x + 14, y + 21);
      ctx.fillText(String(opts.roads).charAt(0), x + 19, y + 21);
    }
    if (opts.comp) ctx.fillText('c', x + 18, y + 21);
  }
  ctx.restore();
}

// Board.getMask: the hexagon a tile image is clipped to.
function hexMask(ctx, x, y) {
  ctx.beginPath();
  ctx.moveTo(x + 25, y);
  ctx.lineTo(x + 74, y);
  ctx.lineTo(x + 99, y + 43);
  ctx.lineTo(x + 74, y + 86);
  ctx.lineTo(x + 25, y + 86);
  ctx.lineTo(x, y + 43);
  ctx.closePath();
}

function img(name, redraw) {
  const i = getImage(name, redraw);
  return i.complete && i.naturalWidth ? i : null;
}

// Java's drawArc(x, y, w, h, 0, 360) with w == h: a circle in that box.
function circle(ctx, x, y, d) {
  ctx.beginPath();
  ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/**
 * Board.paintComponent + the board's Haz children + the robber, in S space.
 * opts: { order: bool, internals: bool, robber: 'stand'|'lie'|'hidden', redraw }
 */
export function paintBoard(ctx, board, opts = {}) {
  const ox = BOARD_X;
  const oy = BOARD_Y;
  const redraw = opts.redraw;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.font = 'bold 16px "Times New Roman", Times, serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const tile of board.tiles) {
    const mt = tile.type;
    const x = ox + tile.x - 49;
    const y = oy + tile.y - 43;
    ctx.save();
    hexMask(ctx, x, y);
    ctx.clip();
    let name = null;
    if (mt === 'T') name = 'tenger';
    else if (mt === 'K') name = 'kikoto';
    else if (mt === 'S') name = 'sivatag';
    else if (mt === 'N') name = TILE_IMAGE[tile.terrain];
    const im = name && img(name, redraw);
    if (im) ctx.drawImage(im, x, y);
    if (mt === 'K') {
      ctx.strokeStyle = '#000';
      const d = tile.harborDirs || [];
      if (d[3]) { circle(ctx, x + 89, y + 33, 20); ctx.stroke(); line(ctx, x + 49, y + 43, x + 99 - 10, y + 43); }
      if (d[5]) { circle(ctx, x + 64, y + 76, 20); ctx.stroke(); line(ctx, x + 49, y + 43, x + 74 - 5, y + 86 - 9); }
      if (d[7]) { circle(ctx, x + 15, y + 76, 20); ctx.stroke(); line(ctx, x + 49, y + 43, x + 25 + 5, y + 86 - 9); }
      if (d[9]) { circle(ctx, x - 10, y + 33, 20); ctx.stroke(); line(ctx, x + 49, y + 43, x + 10, y + 43); }
      if (d[11]) { circle(ctx, x + 15, y - 10, 20); ctx.stroke(); line(ctx, x + 49, y + 43, x + 25 + 6, y + 8); }
      if (d[1]) { circle(ctx, x + 64, y - 10, 20); ctx.stroke(); line(ctx, x + 49, y + 43, x + 74 - 6, y + 8); }
      if (tile.resource !== '3') {
        ctx.save();
        circle(ctx, x + 33, y + 27, 33);
        ctx.clip();
        const r = img(RESOURCE_IMAGE[tile.resource], redraw);
        if (r) ctx.drawImage(r, x + 21, y - 3);
        ctx.restore();
      } else {
        ctx.fillStyle = KIKOTO;
        ctx.beginPath();
        ctx.ellipse(x + 34 + 15.5, y + 28 + 15.5, 15.5, 15.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.fillText('3:1', x + 40, y + 50);
      }
    } else if (mt === 'N' && tile.number) {
      const e = tile.number;
      ctx.fillStyle = PONTERTEK;
      ctx.beginPath();
      ctx.ellipse(x + 35 + 14.5, y + 29 + 14.5, 14.5, 14.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = (e === 6 || e === 8) ? '#ff0000' : '#000';
      ctx.fillText(String(e), e > 9 ? x + 42 : x + 45, y + 50);
    }
    ctx.restore();
  }

  // Roads: 6 px butt-capped lines, shortened by a sixth at both ends.
  ctx.lineWidth = 6;
  ctx.lineCap = 'butt';
  for (const a of board.junctions) {
    a.juncs.forEach((b, k) => {
      const pl = a.roads[k];
      if (!pl || a.no > b.no) return;
      const ax = ox + a.x; const ay = oy + a.y; const bx = ox + b.x; const by = oy + b.y;
      ctx.strokeStyle = PLAYER_COLORS[pl];
      line(ctx, ax + Math.trunc((bx - ax) / 6), ay + Math.trunc((by - ay) / 6), bx - Math.trunc((bx - ax) / 6), by - Math.trunc((by - ay) / 6));
    });
  }

  // The junctions' Haz components, each in a 27x24 box at (x-9, y-13).
  for (const j of board.junctions) {
    const b = j.building;
    if (!b || !b.type) continue;
    paintHaz(ctx, b.type, b.player, ox + j.x - 9, oy + j.y - 13, { order: opts.order && b.type === 1 ? b.order : 0 });
  }

  if (opts.internals) {
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.font = '12px Arial, Helvetica, sans-serif';
    for (const t of board.tiles) {
      const tx = ox + t.x; const ty = oy + t.y;
      ctx.fillText(t.resource || ' ', tx, ty);
      const r = t.type === 'N' ? 15 : (t.type === 'K' ? 25 : 5);
      ctx.beginPath(); ctx.arc(tx, ty, r, 0, Math.PI * 2); ctx.stroke();
    }
    for (const j of board.junctions) {
      const jx = ox + j.x; const jy = oy + j.y;
      ctx.fillText(j.harbor || ' ', jx, jy);
      ctx.beginPath(); ctx.arc(jx, jy, 15, 0, Math.PI * 2); ctx.stroke();
    }
  }

  const rt = board.robberTile;
  if (rt && opts.robber !== 'hidden') paintRobber(ctx, ox + rt.x + 10, oy + rt.y - 25, opts.robber === 'lie');
  ctx.restore();
}

/** Rablo.paintComponent at (x, y): standing 23x47, or lying 47x23 once it may be moved. */
export function paintRobber(ctx, x, y, lying) {
  ctx.save();
  ctx.fillStyle = '#000';
  const oval = (ex, ey, w, h) => { ctx.beginPath(); ctx.ellipse(x + ex + w / 2, y + ey + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill(); };
  const polyFill = (pts) => { poly(ctx, pts, x, y); ctx.fill(); };
  if (lying) {
    oval(0, 3, 18, 16); oval(11, 0, 32, 22);
    ctx.fillRect(x + 42, y, 3, 22);
    polyFill([[37, 5], [42, 0], [46, 0], [46, 22], [42, 22], [37, 17]]);
  } else {
    oval(3, 0, 16, 18); oval(0, 11, 22, 32);
    ctx.fillRect(x, y + 42, 22, 3);
    polyFill([[5, 37], [0, 42], [0, 46], [22, 46], [22, 42], [17, 37]]);
  }
  ctx.restore();
}

// Kocka geometry: die radius 21, gap 5, pip radius 4, pip offset 9, tray border 7.
const DD = 21; const DB = 5; const DP = 4; const D6 = 2; const DBP = 9; const DT = 7;
export const DICE_W = 4 * DD + DB + 4 + 2 * DT; // 107
export const DICE_H = 2 * DD + 4 + 2 * DT; // 60

/** Kocka.paintComponent into a DICE_W x DICE_H canvas (border drawn by CSS). */
export function paintDice(ctx, v, active) {
  ctx.clearRect(0, 0, DICE_W, DICE_H);
  const xs = [DD + 2 + DT, 3 * DD + DB + 2 + DT];
  const y = DD + 2 + DT;
  ctx.save();
  ctx.lineWidth = 2;
  if (active) {
    ctx.fillStyle = GREEN;
    ctx.fillRect(xs[0] - DD - DT, y - DD - DT, 4 * DD + DB + 2 * DT, 2 * DD + 2 * DT);
  }
  const pip = (px, py) => { ctx.beginPath(); ctx.arc(px, py, DP, 0, Math.PI * 2); ctx.fill(); };
  for (let i = 0; i < 2; i++) {
    const x = xs[i];
    const val = v[i];
    ctx.fillStyle = KOCKA;
    roundRect(ctx, x - DD, y - DD, 2 * DD, 2 * DD, 12);
    ctx.fill();
    ctx.strokeStyle = '#000';
    roundRect(ctx, x - DD, y - DD, 2 * DD, 2 * DD, 12);
    ctx.stroke();
    ctx.fillStyle = '#000';
    if (val === 1 || val === 3 || val === 5) pip(x, y);
    if (val >= 2 && val <= 5) { pip(x - DBP, y - DBP); pip(x + DBP, y + DBP); }
    if (val === 4 || val === 5) { pip(x + DBP, y - DBP); pip(x - DBP, y + DBP); }
    if (val === 6) {
      pip(x - DBP, y); pip(x + DBP, y);
      pip(x - DBP, y - DBP - D6); pip(x + DBP, y - DBP - D6);
      pip(x - DBP, y + DBP + D6); pip(x + DBP, y + DBP + D6);
    }
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The trade panel's green (Csere.paintComponent). */
export const TRADE_GREEN = GREEN;
