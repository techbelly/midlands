# Declared access patterns: scans, reductions, groups, and windows

Status: IMPLEMENTED 2026-07-05 (CPU/reference backend; the GPU lowering of
these constructs is the remaining repayment step). Spec reviewed and
approved. See [nl/rasterize2.nl](../umgeni/nl/rasterize2.nl) for the rasterizer in
this syntax and [test/access-patterns.test.ts](../demos/test/access-patterns.test.ts)
for the validation, including the stability discipline. Successor to
[scan-design.md](scan-design.md).

## Principle

A Nile kernel today declares one access pattern: `∀` — one token at a time,
carried state, arrival order. That single form over-serializes: it cannot say
"this accumulation is associative", "this grouping only needs key order", or
"this kernel looks at adjacent pairs". The compiler then has no license to
parallelize, and fast backends must be hand-ported (the GPU resolve shader).

The extension: a small family of *declared access patterns*, each stating
exactly how much stream context a kernel needs and what algebraic structure
its operations have. Each construct has a sequential lowering (the reference
semantics — what the JS backend emits, equivalent to what we write by hand
today) and a parallel lowering (what the GPU backend emits). What a construct
*declares* is precisely what the parallel lowering *licenses*.

Design rules carried over from the windowing proposal: causal by default;
edge cases are pattern matches, not leaked initial state; everything desugars
to existing kernel machinery on the reference backend.

## Ordering and grouping: `GroupBy`

    … → GroupBy (@y, @x) → …

A pipeline stage declaring that downstream consumers receive the stream
grouped by `y` (major), then `x` (minor within `y`). Replaces
`SortBy (@x) → SortBy (@y)`.

**The stability rule** (the point of tying segmentation to sorting): GroupBy
promises *key order only*. Arrival order within equal keys is deliberately
unspecified. Consequences:

- A downstream `ReduceBy` with commutative operators is insensitive to
  within-group order — the pair compiles to unstable sort, bucket/bin, or
  GPU atomic accumulation, all licensed by the declaration.
- A downstream construct that *is* arrival-order-sensitive within groups
  (`∀`, `∷`, non-commutative reduce) is a compile-time error against plain
  `GroupBy`; the source must say `GroupBy stable (@y, @x)` to buy back
  today's implicit behavior — making the current unstated stable-sort
  requirement explicit, and revealing that the rasterizer never needed it.

## Reduction: `ReduceBy`

    … → ReduceBy (@y, @x; a ⊕ +, h ⊕ +) → …

Merges each (y, x) group to one token; listed fields combine with the given
operator (associative required, commutative unless upstream is
`GroupBy stable`); key fields pass through; the form for non-fieldwise
reductions is an open question (the corpus is entirely fieldwise: `+` here,
`◁`/`▷` in CalculateBounds, `+` in SumWeightedColors).

Declared: associativity (licenses reassociation — coverage may differ from
the sequential lowering by accumulated ulps, and the differential-test policy
for scans/reduces is tolerance `≤ depth × ulp`, not bit equality) and
commutativity (licenses order-freedom, hence atomics).

There is no phantom initial element: an empty group produces nothing. The
reference kernel's (0,0) artifact spans disappear — a semantic *fix*, not a
regression (they carried zero coverage).

## Running values: the scan clause

    WindScanline : EdgeSample >> WindingPixel
        ∀ (x, y, a, h) with H = +[ h ] by @y
            >> (x, y, H + a, H + h)

`with name = op[ expr ] by @key` binds, for each token, the *exclusive*
running reduction of `expr` over the current `@key` group — the value before
this token. (Exclusive is primitive: the inclusive value is `H + h` in the
body; the reverse derivation needs an inverse, which `◁` doesn't have.)
`op[ · ]` generalizes the reduce brackets already reserved in the original
grammar (`∧[…]`, `∨[…]`); `Σ` could sugar `+[…]`. The kernel body remains an
ordinary `∀` body — the clause is the only new binding form.

Sequential lowering: exactly the carried-state kernel we write today.
Parallel lowering: segmented prefix scan (the GPU resolve shader's shape).

## Windows: `∷` (from the windowing proposal)

    SpansOfPixels : WindingPixel >> CoverageSpan
        ∀ p ∷ q
            >> (p.x, p.y, |p.c| ◁ 1, 1)
            if q.y = p.y
                >> (p.x + 1, p.y, |p.w| ◁ 1, q.x - p.x - 1)
        ∀ p ∷ ∅
            >> (p.x, p.y, |p.c| ◁ 1, 1)

Pairwise (and by extension n-wise) windows over the stream, causal, with the
edge written as a pattern arm (`∅` = no successor; the last element's arm
here). Multiple `∀` arms in one kernel select by pattern. Windows are
arrival-order-sensitive by definition, so after a `GroupBy` they require
`stable` — unless the window is over the *reduced* stream (as here, where
ReduceBy made keys unique, so key order fully determines order and the
requirement discharges).

**Segmented windows** (`∀ p ∷ q by @key`, implemented): pairs never span a
key change; the `∅` arm fires at each segment end as well as at flush. This
removes boundary guards from arm bodies (SpansOf needs no `if q.y = p.y`)
and, on the GPU, makes segment-per-thread execution *checked* rather than
assumed — the lowering verifies the window's key is the scan's key carried
through the emit, and rejects unsegmented windows.

## The rasterizer, rewritten

    Rasterize : Bezier >> CoverageSpan
        ⇒ DecomposeBeziers
          → GroupBy (@y, @x)
          → ReduceBy (@y, @x; a ⊕ +, h ⊕ +)
          → WindScanline
          → SpansOfPixels

Every stage now carries its parallelization license in its declaration. The
CPU lowering of this pipeline is (modulo the artifact spans) the validated
nl/combine-scan.nl; the GPU lowering is the existing raster.ts shaders — at
which point the hand-written resolve shader is repaid: both backends compile
from one source.

## Grammar and IR impact (deliberately small)

- Two new stage builtins (`GroupBy`, `ReduceBy`) — parsed like `SortBy`.
- One new clause on `∀` (`with … = op[ … ] by @key`).
- `∷` patterns with `∅` arms; multiple `∀` arms per kernel.
- IR: reduce/scan nodes carrying key fields, operator, and the
  associative/commutative flags; stream-level GroupBy node with stability.

## Open questions for review

1. `⊕` as the fieldwise-reduce marker vs plain `a: +` — and whether
   non-fieldwise reduction (whole-record operator) is needed at all.
2. Associativity/commutativity: asserted by form (recommended), with a
   randomized-reassociation testing mode in the JS backend to catch false
   claims; is that check enough?
3. The `stable`-requirement discharge rule when keys are unique.
4. Does `with … by` subsume `RectangleSpans`-style generators, or are
   self-feeding kernels a third, separate pattern (recommendation: keep
   feedback as-is; it is already parallel-friendly via per-thread worklists).
5. Naming: `GroupBy`/`ReduceBy` read as SQL; alternatives welcome.
