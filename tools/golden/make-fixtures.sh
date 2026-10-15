#!/usr/bin/env sh
# Regenerates tests/golden/*.json from the ORIGINAL Java applet.
# Requires a JDK (tested with OpenJDK 21) and network access to clone the original.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=${TMPDIR:-/tmp}/catan-golden
rm -rf "$WORK" && mkdir -p "$WORK/src" "$WORK/out"
git clone --depth 1 https://github.com/csurgay/catan.git "$WORK/orig"
cp "$WORK/orig/java/"*.java "$WORK/src/"
# Board.init() positions the Swing robber component; make that a no-op without a parent.
sed -i 's#parent.rablo.setLocation(tile.x+10,tile.y-25);#if(parent!=null) parent.rablo.setLocation(tile.x+10,tile.y-25);#' "$WORK/src/Board.java"
cp "$HERE/Golden.java" "$WORK/src/"
javac -nowarn -d "$WORK/out" "$WORK/src/"*.java
for size in 34 56; do
  for seed in 1 2 3 42 20040410 987654321; do
    java -Djava.awt.headless=true -cp "$WORK/out" Golden "$size" "$seed" > "$ROOT/tests/golden/board-$size-$seed.json"
  done
done
echo "fixtures written to $ROOT/tests/golden"
