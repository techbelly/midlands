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

Rasterize2 : Bezier >> CoverageSpan
    ⇒ DecomposeBeziers → GroupBy (@y, @x) → ReduceBy (@y, @x; a ⊕ +, h ⊕ +) → WindScan → SpansOf
