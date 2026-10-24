# Can a compiler be to Umgeni what gezira is to Cairo?

*Research notes, 20 October 2026. Branch `exp/staged-semantics` (since merged).*

> **Paths.** Written before the repository became *midlands*: `src/…` is now
> `umgeni/src/…`, `src/meta/` is `umgeni/src/semantics/`, the CPU backend
> (`codegen.ts`, now `js.ts`; `wasm.ts`; `runtime.ts`) is `umgeni/src/cpu/`, `src/mooi/` is
> `mooi/`, `test/fixtures/*.nl` from gezira are in `gezira/`, and the demos'
> code and Nile (`demo/`, `src/text/`, `src/vector/`, `nl/text.nl`,
> `nl/vector.nl`) are in `demos/`. The TypeScript semantics and sugar were
> retired when Mooi became the only definition of Nile (no `UMGENI_MOOI`).

Gezira expresses what Cairo does in ~600 lines of Nile instead of ~100k
lines of C, because Nile's primitives — streams of tokens, kernels,
mathematical operators lifted over records — are the shape of 2D graphics,
and Nile's compiler and runtime absorb the plumbing (iteration, buffering,
scheduling). The question here: is there a set of primitives that are the
shape of *compiling*, such that Umgeni's compiler becomes a few pages of
mathematics that still produce the same code?

## Baselines

| | lines | notes |
|---|---|---|
| Nile's original compiler (Amelang, Maru) | ~1,540 | 140-line PEG grammar + generic-function passes; first-order; leaned on a dynamic runtime for higher-order Nile |
| Nile's OMeta translators (Frank) | ~4,300 each | Nile→C, Nile→Squeak |
| Umgeni's compiler (`src/`, before this work) | ~5,000 TS + 160 grammar | three backends (JS, WebGPU, wasm), fusion, CSE, higher-order eliminated at compile time, GPU lowering |

Maru's compactness is terseness — one method per AST node per pass — not a
different abstraction. Something different was needed.

## The abstractions considered

- **Grammars as data** (OMeta, Ohm). Already used for parsing; the STEPS
  answer for every pass. Compresses syntax, not meaning.
- **Attribute grammars** (Knuth; JastAdd, Silver). Natural for types and
  signatures; little of Umgeni's bulk is there.
- **Term rewriting with strategies** (Stratego/Spoofax, Maude, K). Natural for
  desugaring and lowering.
- **Nanopass** (Sarkar, Dybvig, Keep). Many tiny passes over defined
  intermediate languages; organizes, doesn't by itself compress.
- **Equality saturation** (e-graphs; egg). Optimizations as equations.
- **Partial evaluation and staging** — Futamura's projections (1971);
  Jones, Gomard & Sestoft (1993); Lightweight Modular Staging (Rompf &
  Odersky); Truffle/Graal and PyPy, which ship compilers that *are*
  partially-evaluated interpreters; "Collapsing Towers of Interpreters"
  (Amin & Rompf 2018).
- **Tagless-final / free structures** (Carette, Kiselyov & Shan). One
  signature of operations, many interpretations of it.

## The hypothesis

Read through partial evaluation, every part of Umgeni's compiler is a known
idea:

| Umgeni pass | what it is |
|---|---|
| elaboration (records flattened, operators inlined, lifting, guards, state) | running Nile's interpreter on **symbolic scalars** — staging |
| templates (process arguments inlined) | static closures, eliminated by specialization |
| families (mid-stream `⇒` → state machines + frames) | **The Trick** (a dynamic value from a finite static set → a case dispatch) plus polyvariant specialization |
| CSE | sharing in the residual program |
| fusion | inlining one stage's semantics at another's emit |
| JS / WGSL / wasm generation | folds of the IR into different models |

So: **the compiler should be Nile's definitional interpreter, partially
evaluated.** Write what Nile *means* once, over an abstract domain of
primitives; run it on numbers and it is an interpreter; run it on symbolic
scalars and its residue is the IR.

## Experiments

All verification reused the project's oracles: the chari bitwise
differential, the **2012 C runtime** oracles (strokes, paint), wasm-vs-JS bit
identity, text goldens, the operator conformance tests, the benchmark's
span-identity gate, and the headless GPU checks.

**1. Semantics over a domain, staged = the front end.** `src/meta/semantics.ts`
defines Nile kernels (values, lifting, user operators, guards, statements,
primed state, kernel structure) over a `Domain` of eleven primitives.
`src/meta/staged.ts` is the symbolic domain: each primitive records IR.
Result: it replaced the elaborator's whole evaluator (expressions,
statements, kernels, generators, `⇒`); `elaborate.ts` went 822 → 538 lines;
**304/304 tests**; GPU tolerances unchanged; the benchmark's executed-op count
**identical** (4,246,653). Size: semantics 264 + staged 113 — **net +93
lines**. The old elaborator already *was* a staged interpreter, written ad
hoc; staging restructures, it does not by itself compress.

**2. The same semantics on numbers is an interpreter.** `src/meta/concrete.ts`
(78 lines) is the number domain. For every plain kernel in every program —
all 66 gezira kernels, the paint scenes, text, `RasterizeParallel`, the vector
kernels, chari's — random parameters and streams through interpreter and
compiled code agree **bit for bit** (`Object.is`, 155 tests).

**3. A notation for semantics: Mooi.** A small equational language
(`src/mooi/`: Ohm grammar + curried evaluator, 282 lines): clauses with
node patterns (`binOp{op, left, right}`) and guards, lambdas, `let`, lists,
records with spread, sequencing. Three parts of the compiler rewritten in it:

| | TypeScript | Mooi | |
|---|---|---|---|
| kernel semantics | 224 | `nile.mooi` 73 | 3.1× |
| value algebra (fit, broadcast, lift, destructure) | 111 | `values.mooi` 41 | 2.7× |
| sugar (scans, windows → core Nile) | 91 | `sugar.mooi` 55 | 1.7× |

(non-blank, non-comment lines.) With all three in Mooi
(`UMGENI_MOOI=1`): **304/304 tests, generated code byte-identical across
the corpus (817 KB)**, GPU checks unchanged. Compiling the gezira library
takes 124 ms against 73 ms. (It first took 2.5 s; the profile showed Ohm
re-parsing the Mooi source per kernel, not evaluation.)

**4. Mid-stream `⇒`, interpreted literally.** The number domain implements
the `forward` primitive as the 2012 C runtime did — the process *becomes*
the pipeline, which receives the rest of the input. Gezira's
`OffsetBezier`, `StrokeOneSide` and the full `StrokeBezierPath` then match
the compiler's defunctionalized families **bit for bit** and the 2012
runtime within 1e-6 on all 81 oracle cases, with the TypeScript and the
Mooi semantics alike. So `substitute.ts` (205 lines) is a specialization of
about fifteen lines of semantics.

## The primitives

**Of meaning** — what a domain must say (and all a backend must implement to
interpret Nile): `num`, `bin`, `un`, `select` (scalars); `let` (sharing),
`cell` (mutable state), `branch`, `emit`, `feed`, `state`, `forward`
(effects). Everything else — records, broadcasting, lifting, user
operators, patterns, primed state — is defined once, on top.

**Of notation** — what Mooi needed: clauses matched in order, patterns that
name AST/IR nodes, guards, lambdas with patterns, `let`, lists, records with
spread, sequencing for effects, and a dozen prelude functions.

**Of structure** — the IR is the free term of the domain's signature, so
every consumer is a model of that signature: numbers (the interpreter), IR
(the compiler), and, in principle, JS text, WGSL text, wasm bytes and op
counts. The existing generators already fold the IR through an environment
(`GenEnv`, `WgslEnv`), so recasting them would mostly re-shape code; it is
recorded here as the right frame rather than done.

## Honest assessment

- **What worked.** Nile now has a single definition of what it means, in 73
  lines of equations, from which both an interpreter and the compiler's
  front end are derived, verified byte-for-byte and against the 2012
  runtime. The compiler's hardest pass is shown to be partial evaluation of
  a tiny piece of that definition.
- **What did not.** Notation alone gives 2–3×, not gezira's 20–100×. Gezira's
  ratio comes from a uniform domain (geometry on streams) and a runtime that
  absorbs all the plumbing. A compiler has more distinct concerns; the gain
  comes from making each one a small specification over a shared engine.
- **An estimate, not a measurement:** with every part in this style —
  grammar 160, sugar 55, algebra 41, semantics 73, backends as models
  (~150), a generic specializer replacing templates/families/fusion (~300),
  Mooi itself (~300) — the compiler would be ~1,100 lines instead of
  ~5,000: about 4–5×.

## What would push further

1. **A generic specializer**: derive templates (static closures), families
   (The Trick) and generator frames (polyvariant specialization) from the
   semantics instead of hand-writing `substitute.ts` and the template code.
   Experiment 4 is the oracle such a specializer must match.
2. **Optimizations as equations** (e-graphs): CSE falls out of sharing;
   algebraic simplifications and fusion as rewrite rules.
3. **Backends as models** of the domain signature, in Mooi.
4. **Patterns in Nile's own concrete syntax** (`⟦ a + b ⟧`), so the
   semantics reads like Nile's specification.

## Where it lives

Branch `exp/staged-semantics`, eight commits on top of `main`:
`src/meta/` (semantics, staged and concrete domains), `src/mooi/` (the
language and three programs in it), `test/semantics.test.ts`. Switches:
`UMGENI_MOOI=1` selects the Mooi semantics, value algebra and sugar.

Recommendation: experiments 1, 2 and 4 are a structural improvement at
equal size (one definition of Nile; a free reference interpreter that
covers `⇒`) and could be merged; Mooi is the research thread to continue.
