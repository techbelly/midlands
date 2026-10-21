# Scans, reductions, and windows: the repayment plan for the GPU debt

Status: design sketch, 2026-07-04. Not implemented. Written alongside GPU
Phase B, whose `resolve` shader is the debt this plan repays.

## The debt

`CombineEdgeSamples` as written in Nile is a `∀` loop with carried primed
state — sequential by construction. The GPU backend cannot compile that to a
parallel shader; Phase B ships a hand-written scanline-scan shader instead,
validated against the compiled-from-Nile reference. The kernel now exists
twice. That is exactly the situation the project exists to avoid.

## The observation

The sequential formulation over-serializes. What the algorithm *is*, after
sorting by (y, x):

1. **reduce by key** — merge same-pixel samples: `(x, y, Σa, Σh)` per pixel.
   A segmented reduction; the operator (+) is associative and commutative.
2. **segmented scan** — running winding along each scanline: for pixel i,
   `H_i = Σ_{j≤i} h_j`, segments keyed by y. Associative again.
3. **windowed map** — coverage per pixel `|H_{i-1} + Σa_i| ◁ 1`, and the gap
   span between pixel i and pixel i+1 at `|H_i| ◁ 1` — a pairwise (cons)
   window over adjacent pixels, exactly the `∷` pattern from the windowing
   proposal.

Everything the GPU needs — associativity, segmentation, window width — is
present in this decomposition and absent from the `∀`-with-primed-state
formulation. The information belongs in the source.

## Sketch of the constructs

Provisional syntax, to be designed properly (the windowing proposal's rules
apply: causal, edge cases as pattern matching, desugars to kernel machinery):

    SumByPixel : EdgeSample >> EdgeSample
      ⊕ (s, t) if s.x = t.x ∧ s.y = t.y      -- reduce-by-key: declared
        >> (s.x, s.y, s.a + t.a, s.h + t.h)   -- associative merge of neighbours

    WindScanline : EdgeSample >> CoveragePixel
      ∮ H = 0 by y                            -- segmented scan, key y
        >> (x, y, H + a, H + h)               -- H resumes per segment

    SpansOf : CoveragePixel >> CoverageSpan
      ∀ p ∷ q                                 -- pairwise window (∷ proposal)
        >> (p.x, p.y, |p.c| ◁ 1, 1)
        >> (p.x + 1, p.y, |p.w| ◁ 1, q.x - p.x - 1) if p.y = q.y

(Glyphs and forms illustrative only. The real design questions: how
associativity is asserted vs checked; whether segmentation is a key
expression or a sort-boundary annotation; how scans compose with `→`;
what the JS backend lowers them to — trivially, the current sequential
loop, so the reference semantics never changes.)

## Why this is the thesis

If these constructs land, the ledger entry for `CombineEdgeSamples` moves
from "hand-ported" to "compiled": the JS backend lowers the scan
sequentially, the GPU backend lowers it as a parallel segmented scan, both
from one source. The same shape then covers the held glyph-atlas question
(caching = a declared memoization structure) and `CalculateBounds`
(a pure reduction). Declared algebraic structure is what lets a declarative
language be *fast* without being *rewritten* — that was the bet of the
whole project.

## Order of work

1. ~~Validate the decomposition concretely~~ **DONE 2026-07-04**
   ([nl/combine-scan.nl](../demos/test/fixtures/combine-scan.nl),
   [test/scan-decomposition.test.ts](../demos/test/scan-decomposition.test.ts)):
   `SumByPixel → WindScanline → SpansOfPixels`, written as ordinary
   sequential Nile, reproduces `CombineEdgeSamples` with **identical span
   structure on all tested streams** — including the reference's
   initial-state artifact spans and the empty-stream epilogue — and
   coverage equal to within **one ulp (2.22e-16 max)** on real text
   geometry. Findings that feed the design:
   - The only inequality is float reassociation: the reference computes
     `(H+a₁)+a₂`, the decomposition `H+(a₁+a₂)`. Equal in real arithmetic.
     A declared-associative construct *licenses exactly this
     reassociation* — meaning the reference's bit pattern is an
     over-specification, and "equivalence" for scans should be defined
     modulo operator reassociation. The differential-test policy follows.
   - The reference's initial state (pixel (0,0), zero coverage) leaks
     artifact spans into its output. Reproducing them required giving
     `SumByPixel` the same phantom initial pixel. A designed reduce-by-key
     construct should make the empty/initial case explicit (the windowing
     proposal's edges-as-pattern-matching rule) rather than inheriting it
     from state initialization.
2. Design the surface syntax against the windowing proposal.
3. Elaborate to IR with an `associative` flag; JS backend lowers
   sequentially; differential tests unchanged.
4. GPU backend lowers scan/reduce constructs to the existing grid/scan
   shaders, replacing the hand-written resolve.
