# Simplification experiments — October 2026

> **Paths.** Written before the repository became *midlands*: `src/…` is now
> `umgeni/src/…`, `src/meta/` is `umgeni/src/semantics/`, the CPU backend
> (`codegen.ts`, now `js.ts`; `wasm.ts`; `runtime.ts`) is `umgeni/src/cpu/`, `src/mooi/` is
> `mooi/`, `test/fixtures/*.nl` from gezira are in `gezira/`, and the demos'
> code and Nile (`demo/`, `src/text/`, `src/vector/`, `nl/text.nl`,
> `nl/vector.nl`) are in `demos/`. The TypeScript semantics and sugar were
> retired when Mooi became the only definition of Nile (no `UMGENI_MOOI`).

After the last rendering target landed (JS, WebGPU/WGSL, WebAssembly), the
compiler was simplified in a series of experiments, one idea per git branch
(`exp/*`, all kept for reference). Each had to pass the same bar before
merging: all tests green — including the bit-identical differential suites
(chari, the 2012 C oracle for strokes and paint, wasm vs JS) — the
benchmark's span-identity gate, and, where shaders could change, the
headless GPU checks.

Overall: `src/` went from 6,129 to 5,861 lines while gaining three modules
that each state one idea; `elaborate.ts` went from 1,119 to 822.

| # | branch | idea | verification | lines | kept |
|---|---|---|---|---|---|
| A | `exp/rank-polymorphism` | Guards are folds of a lifted `select`: `{ a if c, b }` = `select(c, a, b)`, lifted like any operator. Subsumes the hand-written guard lifting (record conditions, record values, broadcast arms). | generated code **byte-identical** across the corpus (712 KB, fused + unfused) | −38 | yes |
| E | `exp/windows-as-sugar` | Scans and windows — the extended-Nile constructs — are desugared into core Nile (state, primed updates, `if`s) by an AST→AST rewrite (`src/sugar.ts`) that returns what was *declared* (scan key/op, window key) for the GPU lowering. The windowing proposal always said "pure sugar"; now the code says it too. | CPU outputs bit-identical; GPU source-lowered shaders still match the CPU with exactly the old tolerances (0.0139 / 0.0553 / 0.0404); lowering snapshot text updated | ≈ 0 (−130 in the elaborator, +131 sugar, +16 WGSL gained general primed state) | yes — a clarity win, size-neutral |
| B | `exp/op-table` | One operator table (`src/scalar.ts`): each builtin's Nile glyph, class, evaluator (its specification), C-like symbol and wasm opcode. JS and WGSL codegen become two *dialects* of one renderer; wasm, the host evaluator and the elaborator read the table. | all outputs bit-identical, WGSL goldens unchanged; new table-generated conformance test (17 operators × 144 value pairs incl. NaN, ±0, ±∞ × 3 backends, `Object.is`) | −39 | yes |
| D | `exp/ir-folds` | The IR (and AST) are trees with folds: `mapExpr`, `allStmts`/`anyStmt` replace seven hand-written walkers. The value algebra moves to `src/values.ts` (157 lines, pure). | generated code byte-identical | −13, plus the module split | yes |
| C | `exp/gpu-hosts` | Retire the hand-written resolve shader (its debt was repaid by `lower.ts`; the CPU is the oracle) and the separate zero-fence presenter (it is the tiger compositor with one black path). | `check:present` still pixel-exact (max channel error 0), no ghosting; `bench:gpu:resident` tolerances unchanged | −145 | yes |
| F | `exp/barriers` | Barriers are functions on finite streams: `barrier(f)` buffers, applies `f`, emits. `SortBy`, `GroupBy`, `Reverse` are one line each. | bench gate span-identical; all tests | −33 | yes |
| G | `exp/one-kernel-model` | A kernel is a segment of one. Segments learned lazy seeding (prologue statements) and persistent worklists, so the closure-based `makeOp` path, `genKernel`'s second code shape, and fusion's bail on kernels with prologues all went. | all tests incl. oracles fused + unfused; bench gate. Side effect: unfused variants ~4.4–4.9 → ~3.9 ms | −60 | yes |

Considered and not pursued:

- **CSE by hash-consing.** The existing pass is already a clean two-pass
  value numbering (mutation epochs, scope stack); a rewrite would trade a
  known-correct 226 lines for a riskier ~similar size.
- **Table-driven pipeline builtins** in `elabStages`: each builtin has its
  own checks (ordering discipline, commutativity, key types); a table would
  hide them rather than simplify them.
- **Compressing the parser's semantic actions:** they are one-line CST→AST
  mappings; generic derivation would cost readability.

Open, from the same session's measurements:

- **Barriers in wasm.** The wasm kernels run ~2.7× faster than the JIT's,
  but end to end the wasm build is slower (≈5.3 vs 3.8 ms) because tokens
  cross JS↔wasm around the JS barriers. Moving `SortBy`/`GroupBy`/`Reverse`
  into wasm (so tokens never leave linear memory) is the structural lever.
