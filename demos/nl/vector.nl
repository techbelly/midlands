Cubic <: (A, B, C, D : Point)

TransformCubics (M : Matrix) : Cubic >> Cubic
    ∀ (A, B, C, D)
        >> (M ⊗ A, M ⊗ B, M ⊗ C, M ⊗ D)

FlattenCubics : Cubic >> Bezier
    ∀ (A, B, C, D)
        u  = B × 3 - A × 2 - D
        v  = C × 3 - A - D × 2
        d2 = (u.x × u.x ▷ v.x × v.x) + (u.y × u.y ▷ v.y × v.y)
        if d2 ≤ 0.64
            >> (A, A ~ D, D)
        else
            AB  = A ~ B
            BC  = B ~ C
            CD  = C ~ D
            ABC = AB ~ BC
            BCD = BC ~ CD
            Mid = ABC ~ BCD
            << (Mid, BCD, CD, D) << (A, AB, ABC, Mid)

StrokeOutline (M : Matrix, w, l, c : Real) : Cubic >> Bezier
    ⇒ TransformCubics (M) → FlattenCubics → StrokeBezierPath (w, l, c)

FillBeziers (min, max : Point) : Bezier >> CoverageSpan
    ⇒ ClipBeziers (min, max) → Rasterize

FillPath (M : Matrix, min, max : Point) : Cubic >> CoverageSpan
    ⇒ TransformCubics (M) → FlattenCubics → FillBeziers (min, max)
