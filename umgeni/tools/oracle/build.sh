#!/bin/sh
# Build the oracle: the original Nile C runtime + gezira.c (Dan Amelang's
# upstream repositories, fetched at pinned commits unless NILE / GEZIRA point
# at checkouts), compiled with every float widened to double so it can be
# compared exactly with umgeni's f64 JS. (Built as-is in
# float32 it agrees structurally, within ~0.1px.) The runtime's spinlock is
# x86 inline asm, so on Apple Silicon this builds x86_64 and runs under Rosetta.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:-$HERE/build}
mkdir -p "$OUT"
fetch() { # repo commit dir
  if [ ! -d "$3" ]; then
    git clone --quiet "https://github.com/damelang/$1.git" "$3"
    git -C "$3" checkout --quiet "$2"
  fi
}
if [ -z "$NILE" ]; then fetch nile 8c7690313642652c7361dded5464279929fa7412 "$OUT/nile"; NILE=$OUT/nile/runtimes/c; fi
if [ -z "$GEZIRA" ]; then fetch gezira 9f3e6846f4a1732c344a3b99e5d670deac618b17 "$OUT/gezira"; GEZIRA=$OUT/gezira/c; fi
for src in "$NILE/nile.c" "$GEZIRA/gezira.c" "$HERE/harness.c"; do
  name=$(basename "$src" .c)
  # Headers that legitimately use float are included before the widening macro.
  printf '#include <xmmintrin.h>\n#include <math.h>\n#include <stdio.h>\n#include <stdlib.h>\n#define float double\n#define sqrtf sqrt\n#include "%s"\n' "$src" > "$OUT/$name-f64.c"
  cc -arch x86_64 -O1 -w -I"$NILE" -I"$GEZIRA" -c "$OUT/$name-f64.c" -o "$OUT/$name.o"
done
cc -arch x86_64 "$OUT"/nile.o "$OUT"/gezira.o "$OUT"/harness.o -o "$OUT/harness" -lm
echo "$OUT/harness"
