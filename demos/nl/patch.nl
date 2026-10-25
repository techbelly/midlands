-- Mesh gradients: Coons patches (PDF's type 6 shading, Cairo's mesh
-- pattern). A patch is four cubic sides, T and B running left to right
-- along the top and bottom, L and R running top to bottom down the sides,
-- and a colour at each corner. A patch is drawn the way a bezier is
-- rasterized: cut in two across its longer side, each half fed back,
-- until a piece lies within one pixel or is a sixteenth of a pixel across;
-- then the pieces are added up per pixel, each weighted by its area, which
-- gives the pixel's colour and, at the patch's edge, its coverage. The cut
-- is exact: the new middle side is the Coons surface's own curve halfway,
-- the two sides it joins averaged, bent by how far the two sides it
-- crosses bow from their chords. (Pieces of a curved patch seldom fit a
-- pixel, so most are cut down to the sixteenth: it is simple, not quick.)
Patch <: (T, B, L, R : Cubic, C00, C10, C01, C11 : Color, d : Real)
Piece <: (x, y, a, ca, cr, cg, cb : Real)

-- The two halves of a cubic (de Casteljau at the midpoint).
◐(Z : Cubic) : Cubic
    (Z.A, Z.A ~ Z.B, (Z.A ~ Z.B) ~ (Z.B ~ Z.C), ((Z.A ~ Z.B) ~ (Z.B ~ Z.C)) ~ ((Z.B ~ Z.C) ~ (Z.C ~ Z.D)))

◑(Z : Cubic) : Cubic
    (((Z.A ~ Z.B) ~ (Z.B ~ Z.C)) ~ ((Z.B ~ Z.C) ~ (Z.C ~ Z.D)), (Z.B ~ Z.C) ~ (Z.C ~ Z.D), Z.C ~ Z.D, Z.D)

SplitPatches : Patch >> Piece
    ∀ (T, B, L, R, C00, C10, C01, C11, d)
        lo = T.A ◁ T.B ◁ T.C ◁ T.D ◁ B.A ◁ B.B ◁ B.C ◁ B.D ◁ L.B ◁ L.C ◁ R.B ◁ R.C
        hi = T.A ▷ T.B ▷ T.C ▷ T.D ▷ B.A ▷ B.B ▷ B.C ▷ B.D ▷ L.B ▷ L.C ▷ R.B ▷ R.C
        s = hi - lo
        inside = ⌊ lo ⌋ ≥ ⌈ hi ⌉ - 1
        if (inside.x ∧ inside.y) ∨ (s.x ≤ 1/16 ∧ s.y ≤ 1/16) ∨ d ≥ 32
            P = ⌊ (T.A + T.D + B.A + B.D) / 4 ⌋ + 0.5
            a = | (T.A.x × T.D.y - T.D.x × T.A.y) + (T.D.x × B.D.y - B.D.x × T.D.y) + (B.D.x × B.A.y - B.A.x × B.D.y) + (B.A.x × T.A.y - T.A.x × B.A.y) | / 2
            C = (C00 + C10 + C01 + C11) / 4
            >> (P.x, P.y, a, C.a × a, C.r × a, C.g × a, C.b × a)
        else
            -- across T and B when the piece is wider than tall and they run
            -- that way, else across L and R
            uInX = | T.D.x - T.A.x | ≥ | T.D.y - T.A.y |
            if { uInX if s.x ≥ s.y, ¬ uInX }
                p = (◐ T).D - (T.A ~ T.D)
                q = (◐ B).D - (B.A ~ B.D)
                M = ((L.A + R.A) / 2 + p, (L.B + R.B) / 2 + p + (q - p) / 3, (L.C + R.C) / 2 + p + (q - p) × 2 / 3, (L.D + R.D) / 2 + q) : Cubic
                << (◑ T, ◑ B, M, R, C00 ~ C10, C10, C01 ~ C11, C11, d + 1)
                << (◐ T, ◐ B, L, M, C00, C00 ~ C10, C01, C01 ~ C11, d + 1)
            else
                p = (◐ L).D - (L.A ~ L.D)
                q = (◐ R).D - (R.A ~ R.D)
                N = ((T.A + B.A) / 2 + p, (T.B + B.B) / 2 + p + (q - p) / 3, (T.C + B.C) / 2 + p + (q - p) × 2 / 3, (T.D + B.D) / 2 + q) : Cubic
                << (N, B, ◑ L, ◑ R, C00 ~ C01, C10 ~ C11, C01, C11, d + 1)
                << (T, N, ◐ L, ◐ R, C00, C10, C00 ~ C01, C10 ~ C11, d + 1)

-- A pixel's pieces, added up: the mean colour, premultiplied, and the area
-- covered.
PiecePixels : Piece >> PaintedPixel
    ∀ (x, y, a, ca, cr, cg, cb)
        if a > 0
            C = ((ca, cr, cg, cb) / a) : Color
            c = a ◁ 1
            >> ((C.a, C.a × C.r, C.a × C.g, C.a × C.b), (x, y, c, 1 - c))

MeshPixels : Patch >> PaintedPixel
    ⇒ SplitPatches → GroupBy (@y, @x) → ReduceBy (@y, @x; a ⊕ +, ca ⊕ +, cr ⊕ +, cg ⊕ +, cb ⊕ +) → PiecePixels
