-- Coverage spans painted in one colour: each span expanded to its pixels by
-- gezira's ExpandSpans (a span of length 0 paints nothing), each pixel given
-- the colour, premultiplied. The host writes the resulting
-- (Color, CoveragePoint)s into the image.
--
-- gezira would write ApplyTexture (UniformColor (C)), which samples any
-- texture at each pixel through a DupZip; for one colour there is nothing to
-- sample, and the plain map is 7× cheaper in umgeni today.
PaintSpans (C : Color) : CoverageSpan >> (Color, CoveragePoint)
    ⇒ ExpandSpans → ColorPoints (C)

ColorPoints (C : Color) : CoveragePoint >> (Color, CoveragePoint)
    D = (C.a, C.a × C.r, C.a × C.g, C.a × C.b)
    ∀ P
        >> (D, P)
