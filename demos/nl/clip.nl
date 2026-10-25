-- Clipping to a path, and masking. gezira clips to a rectangle (ClipBeziers).
-- To clip to any shape, rasterize the shape and the clip separately, then
-- keep each pixel's product of the two coverages: a pixel the clip does not
-- cover has nothing to multiply and drops out. This is a join of two
-- streams by pixel, written with the declared stages: the spans of both,
-- concatenated by the host, are expanded to pixels, each counted once;
-- grouped by pixel, the coverages multiply and the counts add; a pixel
-- counted twice was in both.
CountedPixel <: (x, y, c, n : Real)

CountPixels : CoveragePoint >> CountedPixel
    ∀ (x, y, c, _)
        >> (x, y, c, 1)

BothCovered : CountedPixel >> CoveragePoint
    ∀ (x, y, c, n)
        if n = 2
            >> (x, y, c, 1 - c)

Intersect : CoverageSpan >> CoveragePoint
    ⇒ ExpandSpans → CountPixels → GroupBy (@y, @x) → ReduceBy (@y, @x; c ⊕ ×, n ⊕ +) → BothCovered

ClipPaint (C : Color) : CoverageSpan >> PaintedPixel
    ⇒ Intersect → ColorPoints (C)

-- A mask is a texture whose alpha scales the coverage: paint through a
-- gradient, and the shape fades with it.
Masked : (Color, CoveragePoint) >> CoveragePoint
    ∀ (C, P)
        >> (P.x, P.y, P.c × C.a, 1 - P.c × C.a)

MaskSpans (t : Texture) : CoverageSpan >> CoveragePoint
    ⇒ ApplyTexture (t) → Masked
