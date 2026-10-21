Cubic <: (A, B, C, D : Point)

-- Affine maps compose: (M ∘ N) ⊗ P = M ⊗ (N ⊗ P).
(M : Matrix) ∘ (N : Matrix) : Matrix
    (M.a × N.a + M.c × N.b, M.b × N.a + M.d × N.b, M.a × N.c + M.c × N.d, M.b × N.c + M.d × N.d, M.a × N.e + M.c × N.f + M.e, M.b × N.e + M.d × N.f + M.f)

-- How a map scales area; its square root is how it scales lengths.
∆(M : Matrix) : Real
    M.a × M.d - M.b × M.c

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
