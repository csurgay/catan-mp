// The two language tables have the same keys, every placeholder survives
// translation, and t()/tError() fall back sensibly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TABLES, t, tError, setLang, getLang,
} from '../src/ui/i18n.js';

function keys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}
function lookup(table, key) { return key.split('.').reduce((n, p) => (n == null ? n : n[p]), table); }

test('i18n: Hungarian and English have exactly the same keys', () => {
  const en = keys(TABLES.en).sort();
  const hu = keys(TABLES.hu).sort();
  assert.deepEqual(hu.filter((k) => !en.includes(k)), [], 'only in hu');
  assert.deepEqual(en.filter((k) => !hu.includes(k)), [], 'only in en');
});

test('i18n: the same {{placeholders}} in both languages', () => {
  const ph = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
  for (const k of keys(TABLES.en)) assert.equal(ph(lookup(TABLES.hu, k)), ph(lookup(TABLES.en, k)), k);
});

test('i18n: t() substitutes, switches language, falls back to the key', () => {
  const was = getLang();
  setLang('en', { save: false });
  assert.equal(t('menu.gameFor', { n: 4 }), 'Game for 4 players');
  assert.equal(t('dlg.points', { n: 10 }), '10 Siegpunkte', 'the applet\'s own words in English');
  setLang('hu', { save: false });
  assert.equal(t('menu.gameFor', { n: 4 }), 'Játék 4 játékossal');
  assert.equal(t('no.such.key'), 'no.such.key');
  setLang('xx', { save: false });
  assert.equal(getLang(), 'hu', 'an unknown language is ignored');
  assert.equal(tError({ code: 'ROOM_FULL' }), 'A szoba megtelt.');
  assert.equal(tError({ code: 'WEIRD', message: 'raw text' }), 'raw text');
  assert.equal(tError({ code: 'WEIRD' }), 'Ez most nem lehetséges.');
  setLang(was, { save: false });
});
