# umgeni

A compiler for Nile, plus extensions (scans, windows and group-by declared as
access patterns, rather than written as hand-rolled state).

```
Nile ─Ohm─▶ AST ─sugar.mooi─▶ core AST ─nile.mooi, staged─▶ scalar IR ─▶ fuse, CSE ─▶ JS
                                                                              ├──▶ wasm
                                                                              └──▶ WGSL
```

- **Grammar**: [src/grammar/nile.ohm](src/grammar/nile.ohm), the Nile grammar
  as data. The offside rule lives in [src/preprocess.ts](src/preprocess.ts).
- **Meaning**: [src/semantics/](src/semantics/) holds three Mooi files.
  - [sugar.mooi](src/semantics/sugar.mooi) rewrites extended Nile into core Nile.
  - [values.mooi](src/semantics/values.mooi) is the value algebra (records,
    lifting operators over them).
  - [nile.mooi](src/semantics/nile.mooi) is the semantics.

  The semantics is written over a domain of eleven primitives
  ([domain.ts](src/semantics/domain.ts)). In the symbolic domain
  ([staged.ts](src/semantics/staged.ts)) every primitive records IR, so
  running the semantics compiles. In the numeric domain
  ([concrete.ts](src/semantics/concrete.ts)) it interprets.
- **Higher order**: mid-stream `⇒` (a process becoming a pipeline), DupCat,
  DupZip and Reverse are defunctionalised in [src/substitute.ts](src/substitute.ts).
- **Backends**:
  - [src/cpu/](src/cpu/): [js.ts](src/cpu/js.ts) emits JavaScript, the
    reference; [wasm.ts](src/cpu/wasm.ts) emits WebAssembly binary directly for
    fused segments, bit-identical to the JS; [runtime.ts](src/cpu/runtime.ts)
    streams tokens through both.
  - [src/gpu/](src/gpu/) lowers map kernels, scans, the Rasterize2 pipeline
    ([nl/rasterize2.nl](nl/rasterize2.nl)) and gezira's textures to WGSL.

## The host interface

A compiled program is a registry of process factories. A factory takes the
process's parameters by the names its Nile signature gives them, checked for
presence and size:

```ts
registry.SvgFill({ V: view, R: svg.matrix, min: [0, 0], max: [W, H] })
```

Tokens are flat arrays of numbers. Every named record type's layout comes
with the registry, so the host reads and builds tokens by field name too:

```ts
const PathCubic = tokenType(registry, 'PathCubic');  // (Z : Cubic, n : Real)
PathCubic.get(t, 'n');                                // the subpath number
const X = tokenType(registry, 'PaintedPixel').at('P.x');  // an offset, for hot loops
```

## Tests and oracles

`npm test` from the root runs these checks:

- **The 2012 runtime**: gezira's stroke and paint processes, compiled by
  Amelang's compiler and run on the original C runtime. Recorded in
  `test/fixtures/{stroke,paint}-oracle.json`; to rebuild,
  `sh tools/oracle/build.sh` (fetches nile and gezira at pinned commits;
  x86_64, so Rosetta on Apple Silicon), then `npx tsx tools/oracle/gen-*-fixtures.ts`.
- **chari**: an earlier closure compiler for Nile; its outputs on
  `test/fixtures/chari-kernels.nl` are recorded and must match bit for bit.
- **Interpreter ≡ compiler**: every kernel, random inputs, `Object.is` on every
  output ([test/agree.ts](test/agree.ts)).
- **wasm ≡ JS**, bit for bit; **WGSL** text snapshots. On-GPU checks run under
  Deno (`npm run check:present`, `bench:gpu`).
