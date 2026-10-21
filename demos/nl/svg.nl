-- SVG path data, interpreted. The host only lexes `d` into commands: one
-- token per command as written, its numbers in order (unused ones 0). Here
-- they become absolute cubics: relative coordinates resolved against the
-- current point, H and V and L as straight cubics, S reflecting the last
-- control point, Z (and, for fills, every subpath end) closing back to the
-- subpath's start.

-- op: M 1, L 2, H 3, V 4, C 5, S 6, Z 7; rel: 1 for the lower-case form.
PathCommand <: (op, rel, a, b, c, d, e, f : Real)

-- A cubic, numbered by its subpath (strokes cap or close each subpath).
PathCubic <: (Z : Cubic, n : Real)

-- A straight segment as a cubic: controls at a third and two thirds, so
-- FlattenCubics passes it through in one step.
(A : Point) ↦ (B : Point) : Cubic
    (A, A + (B - A) / 3, A + (B - A) × 2 / 3, B)

PathCubics (closeAll : Real) : PathCommand >> PathCubic
    P = (0, 0) : Point
    S = (0, 0) : Point
    K = (0, 0) : Point
    n = 0
    open = 0
    curved = 0
    ∀ (op, rel, a, b, c, d, e, f)
        O = { P if rel, (0, 0) } : Point
        away = P.x ≠ S.x ∨ P.y ≠ S.y
        if op = 1
            if open ∧ closeAll ∧ away
                >> (P ↦ S, n)
            if open
                n' = n + 1
            P' = O + (a, b)
            S' = O + (a, b)
            open' = 0
        else if op = 7
            if open ∧ away
                >> (P ↦ S, n)
            n' = n + 1
            P' = S
            open' = 0
        else
            Q = { (O.x + a, P.y) if op = 3, (P.x, O.y + a) if op = 4, O + (a, b) } : Point
            if op = 5
                >> ((P, O + (a, b), O + (c, d), O + (e, f)), n)
                K' = O + (c, d)
                P' = O + (e, f)
            else if op = 6
                R = { P × 2 - K if curved, P } : Point
                >> ((P, R, O + (a, b), O + (c, d)), n)
                K' = O + (a, b)
                P' = O + (c, d)
            else
                >> (P ↦ Q, n)
                P' = Q
            open' = 1
        curved' = op = 5 ∨ op = 6
    if open ∧ closeAll ∧ (P.x ≠ S.x ∨ P.y ≠ S.y)
        >> (P ↦ S, n)

-- A path drawn by an SVG (whose own transform is R) into a view V: filled,
-- or stroked with its width scaled as the map scales lengths, but never
-- thinner than minw. Strokes run once per subpath (each end caps or closes).
SvgFill (V, R : Matrix, min, max : Point) : Cubic >> CoverageSpan
    ⇒ FillPath (V ∘ R, min, max)

SvgFillBeziers (V, R : Matrix, min, max : Point) : Cubic >> Bezier
    ⇒ TransformCubics (V ∘ R) → FlattenCubics → ClipBeziers (min, max)

SvgStroke (V, R : Matrix, w, minw, l, c : Real) : Cubic >> Bezier
    ⇒ StrokeOutline (V ∘ R, (w × √|∆(V ∘ R)|) ▷ minw, l, c)
