// What people type or paste into the lobby: room codes and names. Found by
// an external UX tester: pasting "x984k" into the 5-character field lost the
// last letter, a 6-character code was silently cut to a different room, and
// an empty field said "no such room".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRoomCode, roomCodeProblem, isRoomCode, cleanName, makeRoomCode, MAX_NAME, ROOM_CODE_LENGTH,
} from '../src/net/protocol.js';

test('room code: pasted lowercase, spaces, dashes and newlines normalize without losing characters', () => {
  assert.equal(normalizeRoomCode('x984k'), 'X984K');
  assert.equal(normalizeRoomCode('  x984k \n'), 'X984K');
  assert.equal(normalizeRoomCode('x9-84 k'), 'X984K');
  assert.equal(normalizeRoomCode('\tAbCdE'), 'ABCDE');
  assert.equal(roomCodeProblem(' abcde '), null);
});

test('room code: too long is reported, never truncated to another code', () => {
  assert.equal(normalizeRoomCode('ABCDEF'), 'ABCDEF');
  assert.equal(roomCodeProblem('ABCDEF'), 'CODE_LENGTH');
  assert.equal(roomCodeProblem('ABCD'), 'CODE_LENGTH');
  assert.equal(isRoomCode(normalizeRoomCode('ABCDEF')), false);
});

test('room code: empty and look-alike characters get their own reasons', () => {
  assert.equal(roomCodeProblem(''), 'CODE_EMPTY');
  assert.equal(roomCodeProblem('   '), 'CODE_EMPTY');
  assert.equal(roomCodeProblem('-- '), 'CODE_EMPTY');
  assert.equal(roomCodeProblem('ABC0E'), 'CODE_CHARS');
  assert.equal(roomCodeProblem('ABCOE'), 'CODE_CHARS');
  assert.equal(roomCodeProblem('AB1DE'), 'CODE_CHARS');
  assert.equal(roomCodeProblem('ABIDE'), 'CODE_CHARS');
});

test('room code: every generated code passes its own check', () => {
  let seed = 7;
  const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 500; i++) {
    const c = makeRoomCode(rng);
    assert.equal(c.length, ROOM_CODE_LENGTH);
    assert.equal(roomCodeProblem(c), null, c);
    assert.equal(roomCodeProblem(c.toLowerCase()), null, c);
  }
});

test('names: cut by code point, never inside an emoji; control characters and edge spaces dropped', () => {
  const emoji = '🦊'.repeat(40);
  const cut = cleanName(emoji);
  assert.equal([...cut].length, MAX_NAME);
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut), 'no dangling high surrogate');
  assert.equal(cleanName('  Péter \u0007 '), 'Péter');
  assert.equal(cleanName('    ', 'fallback'), 'fallback');
  // A cut that lands on a space does not leave a trailing space.
  assert.equal(cleanName(`${'a'.repeat(MAX_NAME - 1)} b`), 'a'.repeat(MAX_NAME - 1));
});
