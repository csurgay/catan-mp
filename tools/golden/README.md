# Golden reference from the original Java applet

`Golden.java` is a headless harness that instantiates the original `Board`
class (unchanged except for one null-guard on the Swing robber component),
seeds its `java.util.Random` and prints the generated board as JSON.

`make-fixtures.sh` clones https://github.com/csurgay/catan, compiles it with
the harness and writes `tests/golden/board-<size>-<seed>.json`.

`tests/golden.test.js` generates the same boards with the JavaScript port
(`createBoard` + `setupBoard` + the bit-exact `JavaRandom`) and asserts that
terrain, harbors, number tokens, robber position and junction adjacency are
identical. This is the strongest evidence we have that the port's board
generation is faithful: same seed, same board, in both languages.
