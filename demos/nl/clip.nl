-- Clipping to a path, and masking. gezira clips to a rectangle (ClipBeziers).
-- To clip to any shape, rasterize the shape and the clip separately, then
-- keep each pixel's product of the two coverages: a pixel the clip does not
-- cover has nothing to multiply and drops out. This is a join of two
-- streams by pixel, written with the declared stages: the spans of both,
-- concatenated by the host, are expanded to pixels, each counted once;
-- grouped by pixel, the counts add, and so do the coverages and their
-- squares, which is enough: two numbers' product is half the difference of
-- the square of their sum and the sum of their squares, 2ab = (a + b)² - (a²
-- + b²). Adding is all the join needs, so a GPU can accumulate it in any
-- order (gpu/lower.ts lowers a ReduceBy by +, and only +).
CountedPixel <: (x, y, s, q, n : Real)

CountPixels : CoveragePoint >> CountedPixel
    ∀ (x, y, c, _)
        >> (x, y, c, c × c, 1)

BothCovered : CountedPixel >> CoveragePoint
    ∀ (x, y, s, q, n)
        if n = 2
            c = (s × s - q) / 2
            >> (x, y, c, 1 - c)

Intersect : CoverageSpan >> CoveragePoint
    ⇒ ExpandSpans → CountPixels → GroupBy (@y, @x) → ReduceBy (@y, @x; s ⊕ +, q ⊕ +, n ⊕ +) → BothCovered

ClipPaint (C : Color) : CoverageSpan >> PaintedPixel
    ⇒ Intersect → ColorPoints (C)

-- A mask is a texture whose alpha scales the coverage: paint through a
-- gradient, and the shape fades with it.
Masked : (Color, CoveragePoint) >> CoveragePoint
    ∀ (C, P)
        >> (P.x, P.y, P.c × C.a, 1 - P.c × C.a)

MaskSpans (t : Texture) : CoverageSpan >> CoveragePoint
    ⇒ ApplyTexture (t) → Masked
