WindPix <: (x, y, c, w : Real)

WindScan : EdgeSample >> WindPix
    ∀ (x, y, a, h) with H = +[ h ] by @y
        >> (x, y, H + a, H + h)

SpansOf : WindPix >> CoverageSpan
    ∀ p ∷ q by @y
        >> (p.x, p.y, |p.c| ◁ 1, 1)
        >> (p.x + 1, p.y, |p.w| ◁ 1, q.x - p.x - 1)
    ∀ p ∷ ∅
        >> (p.x, p.y, |p.c| ◁ 1, 1)

-- A rasterizer, said once. Curves are cut into edge samples (a Cutting),
-- the samples summed pixel by pixel in any order, the sums run along each
-- row, and each pixel's winding turned into coverage (a Winding: the fill
-- rule). Every rasterizer here and in the files beside this one is this
-- with its two choices made.
Cutting :: Bezier >> EdgeSample
Winding :: WindPix >> CoverageSpan

EdgeSums (cut : Cutting) : Bezier >> EdgeSample
    ⇒ cut → GroupBy (@y, @x) → ReduceBy (@y, @x; a ⊕ +, h ⊕ +)

RasterizeBy (cut : Cutting, fill : Winding) : Bezier >> CoverageSpan
    ⇒ EdgeSums (cut) → WindScan → fill

-- gezira's cutting, and the non-zero rule.
RasterizeParallel : Bezier >> CoverageSpan
    ⇒ RasterizeBy (DecomposeBeziers, SpansOf)

-- The pixels themselves, for a back end that paints pixels rather than spans
-- (the GPU presenter): gezira's ExpandSpans decodes each span's run.
RasterizePixels : Bezier >> CoveragePoint
    ⇒ RasterizeParallel → ExpandSpans
