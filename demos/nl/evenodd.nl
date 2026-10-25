-- The even-odd fill rule. gezira fills by non-zero winding: a pixel's
-- coverage is its winding, clamped (|c| ◁ 1), so a shape drawn over itself
-- stays filled. Under even-odd a pixel inside an odd number of outlines is
-- filled and one inside an even number is not: the winding folds back on
-- itself, 1 → 1, 2 → 0, 3 → 1, a triangle wave. The rule is one expression;
-- the rest of the rasterizer is umgeni's parallel one, unchanged.
∿(c : Real) : Real
    { 2 - |c| % 2 if |c| % 2 > 1, |c| % 2 }

SpansOfEvenOdd : WindPix >> CoverageSpan
    ∀ p ∷ q by @y
        >> (p.x, p.y, ∿ p.c, 1)
        >> (p.x + 1, p.y, ∿ p.w, q.x - p.x - 1)
    ∀ p ∷ ∅
        >> (p.x, p.y, ∿ p.c, 1)

RasterizeEvenOdd : Bezier >> CoverageSpan
    ⇒ DecomposeBeziers → GroupBy (@y, @x) → ReduceBy (@y, @x; a ⊕ +, h ⊕ +) → WindScan → SpansOfEvenOdd

-- The pixels themselves, for the GPU presenter (as RasterizePixels is to
-- RasterizeParallel).
RasterizePixelsEvenOdd : Bezier >> CoveragePoint
    ⇒ RasterizeEvenOdd → ExpandSpans
