# umgeni

A compiler for Nile, plus a few extensions: running sums, adjacent-pair
windows and grouping are declared in the source (as *access patterns*)
rather than written out as hand-kept state, so a parallel back end can see
what it is allowed to do.

The stages, left to right:

```
Nile ─Ohm─▶ syntax tree ─sugar.mooi─▶ core Nile ─nile.mooi, staged─▶ scalar IR ─▶ fuse, CSE ─▶ JS
                                                                                     ├──▶ wasm
                                                                                     └──▶ WGSL
```

- **Grammar**: [src/grammar/nile.ohm](src/grammar/nile.ohm) describes Nile's
  syntax as data, and the [Ohm](https://ohmjs.org) library parses with it.
  Indentation-as-structure (the offside rule) is handled first, in
  [src/preprocess.ts](src/preprocess.ts).
- **Meaning**: [src/semantics/](src/semantics/) holds three Mooi files, which
  together are the only definition of what Nile means.
  - [sugar.mooi](src/semantics/sugar.mooi) rewrites the extensions into plain
    Nile (state, primed updates, `if`s), remembering what was declared.
  - [values.mooi](src/semantics/values.mooi) says what a value is: a tree of
    numbers, so that `+` on two Points means `+` on each coordinate (the
    value algebra: records, operators lifted over them).
  - [nile.mooi](src/semantics/nile.mooi) says what each expression and
    statement does.

  The meaning is written in terms of eleven basic operations on numbers
  ([domain.ts](src/semantics/domain.ts)): make a number, add, compare,
  remember a value, emit a token, and so on. Hand it real numbers
  ([concrete.ts](src/semantics/concrete.ts)) and running the definition
  runs the Nile: an interpreter. Hand it placeholders that write down
  each operation instead of doing it ([staged.ts](src/semantics/staged.ts))
  and what it writes down is the compiled code (the *scalar IR*, an
  intermediate form in which every record has been flattened to plain
  numbers). The same equations do both jobs.
- **Processes as values**: a Nile process may say, mid-stream, `⇒ A → B`:
  from here on I am that pipeline. The compiler turns this into ordinary
  data ([src/substitute.ts](src/substitute.ts)): each process that can be
  switched to gets a number, and one kernel dispatches on it. No process is
  created at run time (*defunctionalisation*). DupCat, DupZip and Reverse
  take pipelines as arguments; those are expanded in place at compile time,
  and the runtime implements the three as stages that buffer tokens.
- **Back ends**:
  - [src/cpu/](src/cpu/): [js.ts](src/cpu/js.ts) writes JavaScript, the
    reference. [wasm.ts](src/cpu/wasm.ts) writes a whole pipeline as one
    WebAssembly module, bytes directly with no assembler: the kernels, and the
    stages between them that need the whole stream (SortBy, GroupBy, ReduceBy
    and Reverse, done in place in the module's memory), so tokens only leave
    linear memory as the final output. Its output is bit for bit the same as
    the JavaScript's, and about twice as fast on the text benchmark.
    [runtime.ts](src/cpu/runtime.ts) streams tokens through both.
  - [src/gpu/](src/gpu/): [lower.ts](src/gpu/lower.ts) turns a pipeline into
    a plan of GPU compute passes, applying one rule per declaration in the
    source. A run of kernels becomes one pass, with a thread per token or a
    thread per row of a grid. An unordered `GroupBy → ReduceBy` with `+`
    becomes a grid that threads add into concurrently (atomics). A kernel
    that keeps state from one token to the next must declare its running
    sum or window by the grid's key, which is what makes the rows
    independent. Anything else is refused, naming the declaration that
    would allow it. [execute.ts](src/gpu/execute.ts) runs a plan and holds
    the two destinations for a pipeline's output (a coverage image, or
    tokens appended to a buffer); [present.ts](src/gpu/present.ts) draws
    many paths in one submission without waiting on the GPU;
    [texture.ts](src/gpu/texture.ts) turns gezira's textures into a shader
    `paint()` function.

Before code is written, three passes tidy the intermediate form: consecutive
kernels are joined so tokens pass between them as function arguments rather
than arrays, and two sorts in a row become one sort by both keys (*fusion*);
repeated calculations are done once (*common subexpression elimination*,
CSE); and a `<<` that nothing follows is marked as the stage's next token, so
a back end loops instead of pushing it onto the worklist and popping it
straight back ([tail.ts](src/passes/tail.ts)).

## The host interface

A compiled library is used through its API: `library.api`, or
`api(registry)` for a registry generated at build time. Each process is a
function taking its parameters by the names its Nile signature gives them,
checked for presence and size; `.run(tokens)` streams tokens through and
returns what it emits:

```ts
const nile = library.api;
const spans = nile.SvgFill({ V: view, R: svg.matrix, min: [0, 0], max: [W, H] }).run(cubics);
```

Tokens are flat arrays of numbers, and every named record type comes with
its layout, so the host reads and builds tokens by field name too:

```ts
const { PathCubic, PaintedPixel } = nile.types;
PathCubic.get(t, 'n');              // a field
const X = PaintedPixel.at('P.x');   // an offset, for hot loops
```

## Tests and oracles

`npm test` from the root runs these checks:

- **The 2012 runtime**: gezira's stroke and paint processes, compiled by
  Amelang's compiler and run on the original C runtime. Recorded in
  `test/fixtures/{stroke,paint}-oracle.json`; to rebuild,
  `sh tools/oracle/build.sh` (fetches nile and gezira at pinned commits;
  x86_64, so Rosetta on Apple Silicon), then `npx tsx tools/oracle/gen-*-fixtures.ts`.
- **chari**: an earlier compiler for Nile; its outputs on
  `test/fixtures/chari-kernels.nl` are recorded and must match bit for bit.
- **Interpreter ≡ compiler**: every kernel, random inputs, every output
  number identical ([test/agree.ts](test/agree.ts)).
- **wasm ≡ JS**, bit for bit; **WGSL** text snapshots. Checks that run on a
  real GPU use Deno: `npm run check:present`, and `npm run check:lowering`,
  which lowers three pipelines the GPU code was not written against (a
  self-feeding kernel after the window, a parameterised transform ahead of
  the rasterizer, a kernel on its own with its output appended) and compares
  them with the CPU.
