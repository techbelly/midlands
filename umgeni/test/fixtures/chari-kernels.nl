Point        <: (x, y : Real)
Vector       <: (x, y : Real)
Matrix       <: (a, b, c, d, e, f : Real)
Cubic        <: (A, B, C, D : Point)
Bezier       <: (A, B, C : Point)
EdgeSample   <: (x, y, a, h : Real)
CoverageSpan <: (x, y, c, l : Real)

(a : Real) ◁ (b : Real) : Real
    { a if a < b, b }

(a : Real) ▷ (b : Real) : Real
    { a if a > b, b }

| (a : Real) | : Real
    { -a if a < 0, a }

(M : Matrix) ⊗ (A : Point) : Point
    (M.a × A.x + M.c × A.y + M.e, M.b × A.x + M.d × A.y + M.f)

(u : Point) ∙ (v : Point) : Real
    u.x × v.x + u.y × v.y

‖ (u : Point) ‖ : Real
    √ (u ∙ u)

^ (u : Point) : Point
    { u / ‖ u ‖ if ‖ u ‖ ≠ 0, (0, 0) }

(A : Point) ⟂ (B : Point) : Point
    ^ (A.y - B.y, B.x - A.x)

(A : Point) ≠# (B : Point) : Real
    A.x ≠ B.x ∨ A.y ≠ B.y

(u : Point) ≠* (v : Point) : Real
    u.x ≠ v.x ∨ u.y ≠ v.y

(u : Point) ?* (v : Point) : Point
    { u if u ≠* (0, 0), v }

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

StrokeBezier (w : Real) : Bezier >> Bezier
    ∀ (A, B, C)
        u = A ⟂ B
        v = B ⟂ C
        M = (A ~ B) ~ (B ~ C)
        if u ∙ v ≥ 0.9
            o  = w / 2
            wm = (A ~ B) ⟂ (B ~ C)
            D = A + o × u
            F = C + o × v
            N = M + o × wm
            E = 2 × N - (D ~ F)
            G = A - o × u
            I = C - o × v
            J = M - o × wm
            K = 2 × J - (G ~ I)
            >> (D, E, F)
            >> (F, F ~ I, I)
            >> (I, K, G)
            >> (G, G ~ D, D)
            if w ≥ 2
                >> ((A.x + o, A.y), (A.x + o, A.y - o), (A.x, A.y - o))
                >> ((A.x, A.y - o), (A.x - o, A.y - o), (A.x - o, A.y))
                >> ((A.x - o, A.y), (A.x - o, A.y + o), (A.x, A.y + o))
                >> ((A.x, A.y + o), (A.x + o, A.y + o), (A.x + o, A.y))
                >> ((C.x + o, C.y), (C.x + o, C.y - o), (C.x, C.y - o))
                >> ((C.x, C.y - o), (C.x - o, C.y - o), (C.x - o, C.y))
                >> ((C.x - o, C.y), (C.x - o, C.y + o), (C.x, C.y + o))
                >> ((C.x, C.y + o), (C.x + o, C.y + o), (C.x + o, C.y))
        else
            if A ≠# B ∧ B ≠# C
                << (M, B ~ C, C) << (A, A ~ B, M)

StrokeStyled (w, cap, join : Real) : Bezier >> Bezier
    started = 0
    pn = (0, 0) : Point
    pe = (0, 0) : Point
    pd = (0, 0) : Point
    ∀ (A, B, C)
        o = w / 2
        n = A ⟂ C
        d = ^ (C.x - A.x, C.y - A.y)
        D = A + o × n
        F = C + o × n
        G = A - o × n
        I = C - o × n
        >> (D, D ~ F, F)
        >> (F, F ~ I, I)
        >> (I, I ~ G, G)
        >> (G, G ~ D, D)
        if started
            if join ≥ 1.5
                Ap = A + o × pn
                wp = (Ap ⟂ D) ?* pn
                Mp = { A + (o / (pn ∙ wp)) × wp if pn ∙ wp ≥ 0.25, Ap ~ D }
                >> (A, A ~ Ap, Ap)
                >> (Ap, Ap ~ Mp, Mp)
                >> (Mp, Mp ~ D, D)
                >> (D, D ~ A, A)
                qn = 0 - pn
                Am = A + o × qn
                wq = (Am ⟂ G) ?* qn
                Mm = { A + (o / (qn ∙ wq)) × wq if qn ∙ wq ≥ 0.25, Am ~ G }
                >> (A, A ~ Am, Am)
                >> (Am, Am ~ Mm, Mm)
                >> (Mm, Mm ~ G, G)
                >> (G, G ~ A, A)
            else
                if join ≥ 0.5
                    >> ((A.x + o, A.y), (A.x + o, A.y - o), (A.x, A.y - o))
                    >> ((A.x, A.y - o), (A.x - o, A.y - o), (A.x - o, A.y))
                    >> ((A.x - o, A.y), (A.x - o, A.y + o), (A.x, A.y + o))
                    >> ((A.x, A.y + o), (A.x + o, A.y + o), (A.x + o, A.y))
                else
                    Bp = A + o × pn
                    Bm = A - o × pn
                    >> (A, A ~ Bp, Bp)
                    >> (Bp, Bp ~ D, D)
                    >> (D, D ~ A, A)
                    >> (A, A ~ Bm, Bm)
                    >> (Bm, Bm ~ G, G)
                    >> (G, G ~ A, A)
        else
            if cap ≥ 0.5
                if cap ≥ 1.5
                    sa = G - o × d
                    sb = D - o × d
                    >> (D, D ~ sb, sb)
                    >> (sb, sb ~ sa, sa)
                    >> (sa, sa ~ G, G)
                    >> (G, G ~ D, D)
                else
                    >> ((A.x + o, A.y), (A.x + o, A.y - o), (A.x, A.y - o))
                    >> ((A.x, A.y - o), (A.x - o, A.y - o), (A.x - o, A.y))
                    >> ((A.x - o, A.y), (A.x - o, A.y + o), (A.x, A.y + o))
                    >> ((A.x, A.y + o), (A.x + o, A.y + o), (A.x + o, A.y))
        started' = 1
        pn' = n
        pe' = C
        pd' = d
    if cap ≥ 0.5
        o = w / 2
        Ed = pe + o × pn
        Eg = pe - o × pn
        if cap ≥ 1.5
            ea = Ed + o × pd
            eb = Eg + o × pd
            >> (Ed, Ed ~ ea, ea)
            >> (ea, ea ~ eb, eb)
            >> (eb, eb ~ Eg, Eg)
            >> (Eg, Eg ~ Ed, Ed)
        else
            >> ((pe.x + o, pe.y), (pe.x + o, pe.y - o), (pe.x, pe.y - o))
            >> ((pe.x, pe.y - o), (pe.x - o, pe.y - o), (pe.x - o, pe.y))
            >> ((pe.x - o, pe.y), (pe.x - o, pe.y + o), (pe.x, pe.y + o))
            >> ((pe.x, pe.y + o), (pe.x + o, pe.y + o), (pe.x + o, pe.y))

DecomposeBeziers : Bezier >> EdgeSample
    ∀ (A, B, C)
        inside = (⌊ A ⌋ = ⌊ C ⌋ ∨ ⌈ A ⌉ = ⌈ C ⌉)
        if inside.x ∧ inside.y
            P = ⌊ A ⌋ ◁ ⌊ C ⌋
            w = P.x + 1 - (C.x ~ A.x)
            h = C.y - A.y
            >> (P.x + 1/2, P.y + 1/2, w × h, h)
        else
            straight = | B.x - (A.x ~ C.x) | < 0.001 ∧ | B.y - (A.y ~ C.y) | < 0.001
            if straight
                rx = ⌊ A.x + 1/2 ⌋
                ry = ⌊ A.y + 1/2 ⌋
                ax = { rx if | A.x - rx | < 0.0001, A.x }
                ay = { ry if | A.y - ry | < 0.0001, A.y }
                dx = C.x - ax
                dy = C.y - ay
                xb = { ⌊ ax ⌋ + 1 if dx > 0, ⌈ ax ⌉ - 1 if dx < 0, ax }
                yb = { ⌊ ay ⌋ + 1 if dy > 0, ⌈ ay ⌉ - 1 if dy < 0, ay }
                tx = { 2 if | dx | < 0.000001, (xb - ax) / dx }
                ty = { 2 if | dy | < 0.000001, (yb - ay) / dy }
                t  = tx ◁ ty
                Px = ax + t × dx
                Py = ay + t × dy
                mx = ax ~ Px
                my = ay ~ Py
                cx = ⌊ mx ⌋
                cy = ⌊ my ⌋
                hh = Py - ay
                ww = cx + 1 - mx
                >> (cx + 1/2, cy + 1/2, ww × hh, hh)
                << ((Px, Py), (Px ~ C.x, Py ~ C.y), C)
            else
                ABBC    = (A ~ B) ~ (B ~ C)
                min     = ⌊ ABBC ⌋
                max     = ⌈ ABBC ⌉
                nearmin = | ABBC - min | < 0.1
                nearmax = | ABBC - max | < 0.1
                M       = {min if nearmin, max if nearmax, ABBC}
                << (M, B ~ C, C) << (A, A ~ B, M)

CombineEdgeSamples : EdgeSample >> CoverageSpan
    x = 0
    y = 0
    A = 0
    H = 0
    ∀ (x', y', a, h)
        if y' = y
            if x' = x
                A' = A + a
                H' = H + h
            else
                >> (x,     y, |A| ◁ 1,          1)
                >> (x + 1, y, |H| ◁ 1, x' - x - 1)
                A' = H + a
                H' = H + h
        else
            >> (x, y, |A| ◁ 1, 1)
            A' = a
            H' = h
    >> (x, y, |A| ◁ 1, 1)

ClipBeziers (min, max : Point) : Bezier >> Bezier
    ∀ (A, B, C)
        bmin    = A ◁ B ◁ C
        bmax    = A ▷ B ▷ C
        inside  = min ≤ bmin ∧ bmax ≤ max
        outside = bmax ≤ min ∨ max ≤ bmin
        if inside.x ∧ inside.y
            >> (A, B, C)
        else
            if outside.x ∨ outside.y
                cA = min ▷ A ◁ max
                cC = min ▷ C ◁ max
                >> (cA, cA ~ cC, cC)
            else
                ABBC = (A ~ B) ~ (B ~ C)
                edge = {min if |ABBC - min| < |ABBC - max|, max}
                M    = {edge if |ABBC - edge| < 0.1, ABBC}
                << (M, B ~ C, C) << (A, A ~ B, M)

FillTiger (M : Matrix, min, max : Point) : Cubic >> CoverageSpan
    ⇒ TransformCubics (M) → FlattenCubics → ClipBeziers (min, max) → DecomposeBeziers → SortBy (@x) → SortBy (@y) → CombineEdgeSamples

StrokeTiger (M : Matrix, w : Real, min, max : Point) : Cubic >> CoverageSpan
    ⇒ TransformCubics (M) → FlattenCubics → StrokeBezier (w) → ClipBeziers (min, max) → DecomposeBeziers → SortBy (@x) → SortBy (@y) → CombineEdgeSamples

StrokeStyledPath (M : Matrix, w, cap, join : Real, min, max : Point) : Cubic >> CoverageSpan
    ⇒ TransformCubics (M) → FlattenCubics → StrokeStyled (w, cap, join) → ClipBeziers (min, max) → DecomposeBeziers → SortBy (@x) → SortBy (@y) → CombineEdgeSamples
