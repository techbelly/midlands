# Umgeni — development log

> **Paths.** Written before the repository became *midlands*: `src/…` is now
> `umgeni/src/…`, `src/meta/` is `umgeni/src/semantics/`, the CPU backend
> (`codegen.ts`, now `js.ts`; `wasm.ts`; `runtime.ts`) is `umgeni/src/cpu/`, `src/mooi/` is
> `mooi/`, `test/fixtures/*.nl` from gezira are in `gezira/`, and the demos'
> code and Nile (`demo/`, `src/text/`, `src/vector/`, `nl/text.nl`,
> `nl/vector.nl`) are in `demos/`. The TypeScript semantics and sugar were
> retired when Mooi became the only definition of Nile (no `UMGENI_MOOI`).

A declarative toolchain for [Nile](https://github.com/damelang/nile), aimed at a
performant text-and-graphics pipeline: Ohm grammar → AST (plain data) → IR →
compilation targets (JS for reference semantics; WebGPU/wasm for speed, chosen
by measurement).

Successor to the `chari` experiment. Lessons carried over from it and from
Frankish:

- **Declarative first, from step one.** The parser is a grammar file
  ([src/grammar/nile.ohm](../umgeni/src/grammar/nile.ohm)), not host code. The AST is
  JSON-able data. Anything the system can't inspect is a future dead end.
- **Measure before committing.** No optimization or backend lands without a
  benchmark; the plain-JS backend stays as the permanent reference oracle.
- The full Gezira kernel corpus (`test/fixtures/*.nl`, from the MIT-licensed
  gezira repo) is the parser's acceptance bar — including the higher-order
  constructs chari never handled (`DupCat`/`DupZip` pipeline arguments,
  in-body `⇒`, `(→)`).

## Status

- **Parser: working on the whole corpus.** All 8 gezira `.nl` files (114
  top-level declarations) parse to ASTs; declaration counts verified against
  raw source. Golden-AST tests cover the tricky constructs.
- **IR + reference JS backend: working, differentially verified.** The chain
  is parse → elaborate ([src/elaborate.ts](../umgeni/src/elaborate.ts), scalarization:
  records/tuples flattened to Reals, operators inlined, broadcasting/lifting
  compiled away) → IR ([src/ir.ts](../umgeni/src/ir.ts), plain data, structured control
  flow, no SSA/CSE yet) → generated JS ([src/codegen.ts](../umgeni/src/cpu/js.ts),
  inspectable source) → streaming runtime ([src/runtime.ts](../umgeni/src/cpu/runtime.ts),
  ported from chari: LIFO feedback queue, buffering sort, end() propagation).
  Tokens are flat number arrays (a Bezier is 6 Reals) — the layout that makes
  typed-array/SoA batching reachable later.
- **Oracle**: chari's tiger kernels (`chari/web/kernels.nl`) compiled by both
  toolchains and driven with identical streams produce *bitwise-identical*
  output — including the full FillTiger/StrokeTiger pipelines
  ([test/differential.test.ts](../umgeni/test/differential.test.ts)).
- **Coverage: the whole gezira corpus, unmodified.** Of its 86 processes, 74
  compile directly and 12 are *templates* (process-typed parameters), compiled
  wherever they are used; none are unsupported. A pipeline that uses a process
  which failed to compile is reported unsupported too, rather than compiling
  to a reference that fails at run time.
- **Text pipeline: working end to end.** [nl/text.nl](../demos/nl/text.nl) is the first
  Umgeni-authored Nile: a `GlyphBezier` stream type and a stateful
  `LayoutGlyphs` kernel that does pen advance and line wrapping *in Nile*, feeding the gezira kernels:
  `LayoutGlyphs → TransformBeziers → ClipBeziers → Rasterize`. The host side
  ([src/text/](../demos/src/text/)) is deliberately thin: a hand-authored stub font
  (skeleton strokes; O/Q are quadratic rounded rings, so curves are
  exercised), string→token driving, and span→coverage painting.
- **Web demo**: `npm run demo` builds [demo/](../demos/) (open `demo/index.html`
  directly — static, no server). The text page gets no compiler, just the
  generated pipeline module (~11 KB) plus runtime; the whole compile runs at
  build time in ~25 ms (the later paint page ships the whole compiler
  instead). Honest baseline: a 181-char paragraph → 2,191 tokens
  → ~25k spans in ~8.5 ms median (node, 880×360 @ 18px), before any IR
  optimization.
- **First IR transforms, benchmark-gated** ([tools/bench.ts](../demos/tools/bench.ts)
  is the scoreboard; primary metric is *dynamic IR ops* — executed
  bin/un/select nodes — because JS wall-clock is laundered by the JIT and the
  IR's real targets are future non-JIT substrates):

  (Table as measured in July 2026, when these passes landed; the text
  pipeline has since grown word wrapping — `npm run bench` prints the
  current numbers, including a wasm row.)

  | variant | dyn ops | static ops | gen bytes | raster ms |
  |---|---|---|---|---|
  | baseline | 4,627,331 | 367 | 10,836 | 3.73 |
  | +cse | 4,237,412 (−8.4%) | 291 (−21%) | 10,565 | 3.61 |
  | +bool | 4,627,331 | 367 | 9,183 (−15%) | 3.53 |
  | +fuse | 4,627,331 | 367 | 23,481 | 3.08 |
  | all three (default) | 4,237,412 | 291 | 21,421 | 3.15 |

  (Wall times include the bucketed SortBy below; before it, the same column
  read 8.63 baseline / 7.68 all-three — 2.7× overall so far.)

  Each pass is judged by the metric that matches its mechanism:
  - **CSE** ([src/passes/cse.ts](../umgeni/src/passes/cse.ts)): block-scoped value
    numbering with mutation epochs — no SSA: the IR is single-assignment
    except primed state locals, and structured control flow gives dominator
    scoping as a table stack. Wins dyn ops / static ops.
  - **bool** (codegen-level): conditions emit as native JS booleans instead
    of 1/0 round-trips. Wins bytes.
  - **fusion** ([src/passes/fuse.ts](../umgeni/src/passes/fuse.ts)): nested pipelines
    inlined, adjacent kernels grouped into segments; within a segment, emit
    is a direct call to the next stage with scalar arguments (feedback stages
    keep a local LIFO worklist; SortBy stays a barrier). Wins wall clock —
    it removes inter-stage token arrays and queues, a cost dyn-ops can't
    see — at the price of embedding stage-kernel copies (bytes ×2).

  All variants are span-identical (bench gate), and the differential suite
  passes bit-identical against chari on both fused and unfused builds.
- **SortBy: bucketed stable sort** (in [src/runtime.ts](../umgeni/src/cpu/runtime.ts)).
  Profiling showed 78% of raster time inside the two SortBy end() calls
  (~39k edge samples × 2 per paragraph, comparator sort over wrapper
  objects). Rasterization keys are half-integers in a bounded range, so
  tokens now bucket by the key's integer part — O(n), stable by
  construction, zero comparisons when a bucket holds one distinct key
  (true of every scanline bucket) — with an exact fallback to a plain
  stable sort for wide/non-finite ranges. Result: 7.68 → 3.15 ms; the
  differential suite doubles as proof of exactness (chari still uses a
  comparator sort). Note: pre-sorting *input* beziers cannot replace this —
  decomposition emits samples in curve order, so the reorder genuinely
  happens after it; what sorted input could buy is early scanline flushing
  (a latency/memory win, related to the windowing design).
- **WebGPU Phase A: boundary costs measured.** [src/gpu/](../umgeni/src/gpu/) derives a
  kernel's GPU strategy from the IR — `classify.ts` (map class: no feedback,
  no state writes, exactly one emit), `wgsl.ts` (scalar IR → WGSL compute
  shader, nearly 1:1), `eval.ts` (read-only state folded into the param
  buffer), `runtime.ts` (batched dispatch, reused buffers). Measured under
  Deno/wgpu (`npm run bench:gpu`, TransformBeziers, Apple Silicon):

  | batch | CPU ms | GPU round trip ms |
  |---|---|---|
  | 2,000 (≈1 paragraph) | 0.11 | 13.5 |
  | 200,000 | 6.1 | 14.4 |
  | 2,000,000 | 39.6 | 23.2 |

  The predicted loss, quantified — and decomposed: the ~13.5 ms fixed cost
  is **almost entirely one fence, not transfer**. Measured split: upload +
  encode + submit of 200k tokens (4.8 MB) is 1.3 ms; awaiting completion is
  ~13.4 ms — and an *empty* submit + fence also costs 13.4 ms under
  Deno/wgpu (a completion-polling floor; browsers fence far cheaper). Each
  `run()` performs exactly one fence (`mapAsync`); queued `writeBuffer`s are
  not round trips. Crossover ~10⁶ tokens; worst f32-vs-f64 relative error
  9.2e-7. Structural rule for Phase B: **count fences, not megabytes** — all
  stages in one submission, render to a texture (zero fences on our path),
  readback only in tests. Piecemeal offload of map stages can never win at
  our scales.
- **GPU Phase B v1: resident rasterizer, working and fast at scale.**
  [src/gpu/raster.ts](../umgeni/src/gpu/raster.ts): one queue submission, one fence
  (readback for verification only). Pass A runs the `DecomposeBeziers` body
  — *generated from Nile IR* — inside a per-thread worklist (feedback =
  local stack, overflow-flagged, never hangs), emitting into fixed-point
  (16.16) atomic accumulation grids. Pass B resolves scanline winding to
  coverage: the segmented-scan semantics of `CombineEdgeSamples`,
  **hand-written** — the acknowledged debt, with a language-level repayment
  plan in [docs/scan-design.md](scan-design.md). Host keeps
  layout/transform/clip (compiled Nile, CPU-cheap). Measured
  (`npm run bench:gpu:resident`):

  | workload | beziers | CPU | GPU (1 fence) |
  |---|---|---|---|
  | 1 paragraph, 880×360 | 2,192 | 4.7 ms | 14.7 ms |
  | 16 paragraphs, 1760×1600 | 35k | 58 ms | 17.7 ms |
  | 64 paragraphs, 2560×2560 | 140k | 255 ms | **24.5 ms** |

  Crossover ≈ a few paragraphs; beyond it the GPU is flat near the fence
  floor (~10× at 64 paragraphs). Verification is tolerance-based (fixed-point
  atomics + f32): mean pixel diff ~3e-6; isolated maxima ~0.05 where an f32
  floor boundary moves one sample to a neighbouring pixel. Order
  nondeterminism is sound here because same-pixel merging is additive and
  the winding scan orders by x, not arrival.
- **Extended Nile: declared access patterns**
  ([docs/access-patterns.md](access-patterns.md), spec reviewed +
  implemented). `GroupBy [stable] (@y, @x)` ties segmentation to sorting and
  makes the previously-implicit stable-sort requirement explicit — plain
  GroupBy promises key order only, and an order-sensitive consumer after it
  is a *compile error*; `ReduceBy (@y, @x; a ⊕ +, h ⊕ +)` (commutativity
  checked against ordering); `with H = +[ h ] by @y` exclusive-scan clauses;
  `p ∷ q` / `p ∷ ∅` window arms. The rasterizer rewritten in this syntax
  ([nl/rasterize-parallel.nl](../umgeni/nl/rasterize-parallel.nl)) matches the classic pipeline
  structure-exactly (coverage within 1e-12; the reference's phantom
  initial-pixel spans are gone by construction — see the one-ulp validation
  in [test/scan-decomposition.test.ts](../demos/test/scan-decomposition.test.ts)).
- **The debt repaid: GPU lowering from source**
  ([src/gpu/lower.ts](../umgeni/src/gpu/lower.ts)). `Rasterize2`'s (since renamed `RasterizeParallel`) fused IR lowers to
  both GPU passes with *no hand-written kernel logic*: GroupBy+ReduceBy
  (commutative, unstable — licensed by the declarations) become the
  fixed-point atomic grids; the scan's `by @y` declares row independence, so
  pass B partitions by scanline and re-runs the scan and window kernels'
  lowered bodies sequentially per row. Verified: the lowered shaders match
  the CPU reference with exactly the hand-assembled shaders' tolerances
  (`npm run bench:gpu:resident` prints both). Windows declare their segment
  (`∀ p ∷ q by @y`), so per-segment GPU execution is *checked* — the
  lowering verifies the window key is the scan key carried through the
  emit, and refuses unsegmented windows — not assumed.
- **Zero-fence presentation** ([src/gpu/raster.ts](../umgeni/src/gpu/raster.ts)):
  compute passes + a fullscreen draw of the coverage buffer in ONE
  submission targeting a texture — no mapAsync, no waits; presentation
  syncs against the display. Verified headless (`npm run check:present`):
  pixel-exact vs the compute-only path, ~0.65 ms of CPU submit work per
  frame, zero fences. The demo gained a third renderer mode, and both GPU
  modes now lower their WGSL **in the browser** from `Rasterize2`'s fused
  IR shipped as JSON (`pipeline.gen.js`) — the browser runs the whole
  thesis path: Nile source → IR (build time) → WGSL (page load) → pixels.
- **Higher-order Nile, compiled to first-order Nile**
  ([src/substitute.ts](../umgeni/src/substitute.ts)). Mid-stream `⇒` — the construct
  chari never compiled — needs no new runtime. A process with no `∀` is a
  *generator* (the original runtime's default body splices it out after its
  prologue), so `⇒ A → B` among generators is exactly `<< A << B`: frames fed
  back into one interpreter kernel, recursion as the existing LIFO worklist.
  A stream process that substitutes `⇒ S → G…` emits the generators' frames
  and *becomes* S — a state update over (which process, its params, its
  state). Each such process elaborates to the ordinary pipeline
  `P#head → P#gen`, so CSE, fusion and codegen apply unchanged. `DupCat` and
  `Reverse` are whole-stream builtins, like `SortBy`. **Oracle: the original
  system itself** — `tools/oracle/` builds Amelang's maru-compiled
  `gezira.c` on the original Nile C runtime (x86_64 under Rosetta; float
  widened to double), and [test/stroke-oracle.test.ts](../umgeni/test/stroke-oracle.test.ts)
  checks `OffsetBezier`, `StrokeOneSide` and the full `StrokeBezierPath` on
  27 random curved paths × every cap/join: same token count, values within
  1e-6, fused and unfused. (Run in its native float32 the original agrees
  structurally, within ~0.1px.) Cost: ~210 lines for the assembler, ~150 in
  the elaborator.
- **Templates: process-typed parameters** (`Texture`, `Compositor`,
  `ColorSpans`). A process argument is always written out where the pipeline
  is built, so it is a *closure* — the argument's pipeline plus the caller's
  scope — and a use of the parameter splices that pipeline in. No process
  values exist at run time; fusion and CSE see ordinary pipelines. `DupZip`
  streams both branches and pairs their outputs. Checked against the original
  runtime ([test/paint-oracle.test.ts](../umgeni/test/paint-oracle.test.ts)): five
  scenes — gradients with colour spans, `CompositeMultiply`,
  `CompositeSoftLight`, Gaussian/bilinear/bicubic filters — built in C exactly
  as gezira's demos build textures; 890 pixels within 1e-9.
- **The compiler in the browser**: [demo/paint.html](../demos/paint.html) is a
  live Nile editor. Each edit compiles your text with gezira's library
  (~125 declarations, ~70 ms in the page) and fills shapes with your `Paint`
  texture; presets cover gradients, blur, compositing, filters and a
  hand-written kernel. Parse errors point at the physical line and column;
  `--` comments work, as in the original grammar.
- **Textures on the GPU** ([src/gpu/texture.ts](../umgeni/src/gpu/texture.ts)): a
  texture whose pipeline is made of map kernels — gradients, colour spans,
  compositors, `DupZip` of maps — lowers to ONE WGSL function
  `paint(x, y) -> vec4f`, each stage's emit becoming the next stage's inputs
  (the GPU twin of fused JS). The tiger's compositor calls it per pixel.
  Verified headless (`tools/check-paint-gpu.ts`): GPU vs CPU paint differ on
  ~50 of 50,644 pixels, by at most 1/255. Filters (several samples per point,
  reduced by a stateful kernel) are refused with a reason and paint on the
  CPU. The paint page has a CPU/GPU switch and shows the generated WGSL live.
- **Real fonts and word wrapping.** [src/text/ttf.ts](../demos/src/text/ttf.ts) reads
  TrueType (head/hhea/hmtx/cmap 4+12/loca/glyf, composite glyphs; variable
  fonts at their default instance) — and TrueType outlines are quadratic
  Béziers, exactly gezira's `Bezier`, so glyphs feed the pipeline with no
  curve conversion. Bundled: Source Serif 4 ([fonts/](../demos/fonts/), OFL). Word
  wrapping is pure Nile ([nl/text.nl](../demos/nl/text.nl)): `Reverse → WordWidths →
  Reverse` runs backwards summing advances, restarting at spaces, so each
  word's first glyph carries the word's width; `LayoutGlyphs` then breaks
  greedily (spaces hang in the margin; over-long words break by character;
  `\n` is a hard break). A 7.5k-token paragraph lays out and rasterizes in
  ~17 ms (node). The text page sets Source Serif by default and accepts any
  dropped `.ttf`. Not yet: kerning (GPOS) and shaping.
- **WebAssembly backend** ([src/wasm.ts](../umgeni/src/cpu/wasm.ts), `compileProgram(…,
  { target: 'wasm' })`): each fused kernel segment becomes one wasm module,
  emitted directly in the binary format (~350 lines, no assembler) — stage
  = function, `>>` = direct call with f64 arguments, `<<` = LIFO worklist in
  linear memory, state/params = globals. Wasm f64 is IEEE-identical to JS,
  so the test is **bit-identity** with the JS backend
  ([test/wasm.test.ts](../umgeni/test/wasm.test.ts)): strokes, the paint library, text
  in both fonts, the whole tiger. Measured (paragraph benchmark, `all +
  wasm` row): the wasm *kernels* run ~2.7× faster than the JIT's (profile:
  ~0.6 vs ~1.6 ms per paragraph), but end to end it is ~1.4× *slower*, because
  every token still crosses the JS↔wasm boundary around the JS barriers
  (SortBy, Reverse). Batched hand-off from barriers (`pushAll`) and lean
  copies took it from 21 → 5.6 ms; the remaining lever is structural — move
  the barriers into wasm so tokens never leave linear memory (the CPU
  version of the GPU lesson: count crossings, not instructions).
- Not started: dead-kernel pruning, SSA, kerning/shaping, barriers in wasm,
  glyph-atlas caching (held: possibly expressible in Nile as declared
  memoization).

## Compiler map

Source → tokens → pixels, each stage plain data, one idea per module (line
counts as of October 2026):

| stage | module | lines | the idea |
|---|---|---|---|
| grammar | [nile.ohm](../umgeni/src/grammar/nile.ohm), [preprocess](../umgeni/src/preprocess.ts), [ops](../umgeni/src/ops.ts), [parser](../umgeni/src/parser.ts) | 161 + 107 + 48 + 369 | grammar as data; indentation and user operators kept out of it |
| sugar | [sugar.ts](../umgeni/src/semantics/sugar.mooi) | 131 | scans and windows are core Nile, by translation |
| values | [values.ts](../umgeni/src/values.ts) | 157 | rank polymorphism: a scalar broadcasts, records zip, guards are lifted `select` |
| elaboration | [elaborate.ts](../umgeni/src/elaborate.ts) | 822 | typed AST → scalar IR; templates inline process arguments as closures |
| higher-order | [substitute.ts](../umgeni/src/substitute.ts) | 205 | mid-stream `⇒` is a state machine plus feedback over frames |
| IR | [ir.ts](../umgeni/src/ir.ts), [scalar.ts](../umgeni/src/scalar.ts) | 151 + 107 | one tree, two folds; every scalar operator defined once |
| passes | [fuse](../umgeni/src/passes/fuse.ts), [cse](../umgeni/src/passes/cse.ts), [tail](../umgeni/src/passes/tail.ts) | 91 + 226 + 46 | stages call each other directly, adjacent sorts merge; value numbering without SSA; a tail `<<` is the loop's next turn |
| JS | [codegen.ts](../umgeni/src/cpu/js.ts), [runtime.ts](../umgeni/src/cpu/runtime.ts) | 269 + 313 | every kernel is a segment; barriers are functions on finite streams |
| wasm | [wasm.ts](../umgeni/src/cpu/wasm.ts) | 341 | the same segments, in the binary format, bit-identical |
| GPU | [wgsl](../umgeni/src/gpu/wgsl.ts), [lower](../umgeni/src/gpu/lower.ts), [texture](../umgeni/src/gpu/texture.ts), [classify](../umgeni/src/gpu/classify.ts) | 143 + 310 + 113 + 21 | declarations license parallel lowering; textures become one `paint()` |

## Design notes (parser)

Two small mechanisms keep the grammar itself context-free and declarative:

1. **Indentation** ([src/preprocess.ts](../umgeni/src/preprocess.ts)): physical lines are
   joined into logical lines (inside brackets, or after a trailing `→`), then
   indentation becomes INDENT/DEDENT/EOL sentinel characters, Python-style.
2. **User-defined operators** ([src/ops.ts](../umgeni/src/ops.ts)): infix operators parse
   generically (any run of operator glyphs that isn't a reserved builtin), so
   they need no registration and all sit at one precedence level, matching the
   original OMeta parser. Prefix and outfix operators are ambiguous without
   registration, so a first pass scans `opDef` headers with the same grammar's
   `OpDefHeader` rule, and the resulting operator table is rendered as a
   *generated Ohm extension grammar* overriding three placeholder rules.
   Operator tables accumulate across files in module order (`types.nl` first).

Known gaps / debt, deliberately deferred:

- Quoted "funny" identifiers, `{- -}` comments, `\` line continuations, and the
  `> n > expr` output form exist in the original OMeta grammar but not in the
  corpus; unimplemented. (`--` line comments are supported.)
- `Reverse`, `DupCat`, `DupZip` and `SortBy` parse as ordinary references;
  their builtin meaning is assigned during elaboration.
- Tuple patterns work everywhere a name can be bound, nested: `∀` arms,
  `(a, b) = e` definitions (state in a prologue), primed updates
  `(a', b') = …`, and window arms. Indexing `e[i]` is deliberately absent:
  the old OMeta grammar parsed it but nothing ever gave it a meaning, and the
  final maru grammar dropped it.
- A `with` scan clause on a window arm (two Umgeni extensions combined) is the
  one construct still reported as unsupported.

## Commands

```
npm test          # vitest
npm run typecheck
```
