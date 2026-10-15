// Golden test: the JavaScript board generator must produce exactly the board
// the ORIGINAL Java applet produces for the same java.util.Random seed.
// Fixtures in tests/golden/ were dumped by tools/golden/Golden.java.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createBoard, setupBoard } from '../src/engine/board.js';
import { JavaRandom } from '../src/engine/rng.js';

const dir = new URL('./golden/', import.meta.url);
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json'));

test('golden fixtures exist for both board sizes', () => {
  assert.ok(fixtures.some((f) => f.startsWith('board-34-')));
  assert.ok(fixtures.some((f) => f.startsWith('board-56-')));
});

for (const file of fixtures) {
  const [, size, seed] = file.match(/^board-(\d+)-(\d+)\.json$/);
  test(`board ${size} seed ${seed}: identical to the original Java applet`, () => {
    const golden = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const board = setupBoard(createBoard(Number(size)), new JavaRandom(Number(seed)));

    assert.equal(board.tiles.length, golden.tiles.length);
    board.tiles.forEach((t, i) => {
      const g = golden.tiles[i];
      assert.equal(t.type, g.type, `tile ${i} type`);
      // Java keeps the terrain initial in `resource` for land tiles and the harbor letter for 'K'.
      const javaLetter = t.type === 'N' ? t.terrain : t.resource;
      assert.equal(javaLetter, g.resource.trim() || ' ', `tile ${i} resource`);
      assert.equal(t.number, g.number, `tile ${i} number`);
      if (t.type === 'K') assert.deepEqual(t.juncs.map((j) => j.no), g.juncs, `harbor ${i} junctions`);
    });
    // Java flags every desert as hasRablo; the port keeps only the actual robber tile.
    const javaRobber = golden.tiles.map((t, i) => (t.robber ? i : -1)).filter((i) => i >= 0);
    assert.ok(javaRobber.includes(board.robberTile.idx));
    assert.equal(board.robberTile.idx, javaRobber[javaRobber.length - 1]);

    assert.equal(board.junctions.length, golden.junctions.length);
    board.junctions.forEach((j, i) => {
      const g = golden.junctions[i];
      assert.equal(j.no, g.no);
      assert.equal(j.harbor, g.harbor, `junction ${i} harbor`);
      assert.deepEqual(j.juncs.map((n) => n.no), g.juncs, `junction ${i} neighbours`);
    });
  });
}
