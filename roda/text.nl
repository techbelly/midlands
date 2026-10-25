-- One outline bezier of a glyph, with the glyph's metrics. `first` marks the
-- token on which the pen advances; `kind` is 0 for a glyph, 1 for a space,
-- 2 for a line break; `rest` is the width of the word from this glyph on
-- (filled in by WordWidths).
GlyphBezier <: (Z : Bezier, adv, first, kind, rest : Real)

-- Run over the stream BACKWARDS: summing advances, and restarting at each
-- space or break, gives every glyph the width remaining in its word — so a
-- word's first glyph learns the whole word's width before it is placed.
WordWidths : GlyphBezier >> GlyphBezier
    r = 0
    ∀ (Z, adv, first, kind, _)
        if kind > 0
            r' = 0
        else if first
            r' = r + adv
        >> (Z, adv, first, kind, r')

-- Greedy line breaking: break before a word that would overrun the line
-- (unless it starts the line), inside a word too wide for any line, and at
-- every line break. Spaces never break: they hang in the margin.
LayoutGlyphs (w, lh : Real) : GlyphBezier >> Bezier
    px = 0
    py = 0
    pa = 0
    inWord = 0
    ∀ (Z, adv, first, kind, rest)
        if first
            nx = px + pa
            wordStart = ¬ inWord ∧ kind = 0
            if kind = 2 ∨ (nx > 0 ∧ kind = 0 ∧ ((wordStart ∧ nx + rest > w) ∨ nx + adv > w))
                px' = 0
                py' = py + lh
            else
                px' = nx
            pa' = { 0 if kind = 2, adv }
            inWord' = kind = 0
        P = (px', py') : Point
        >> (Z.A + P, Z.B + P, Z.C + P)

TextLayout (w, lh : Real) : GlyphBezier >> Bezier
    ⇒ Reverse → WordWidths → Reverse → LayoutGlyphs (w, lh)

-- Laid-out beziers placed on the page: M maps em units to pixels, and
-- min, max is the clip rectangle.
PlaceBeziers (M : Matrix, min, max : Point) : Bezier >> Bezier
    ⇒ TransformBeziers (M) → ClipBeziers (min, max)

TextBeziers (w, lh : Real, M : Matrix, min, max : Point) : GlyphBezier >> Bezier
    ⇒ TextLayout (w, lh) → PlaceBeziers (M, min, max)

TextSpans (w, lh : Real, M : Matrix, min, max : Point) : GlyphBezier >> CoverageSpan
    ⇒ TextBeziers (w, lh, M, min, max) → Rasterize
