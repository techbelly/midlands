-- A rasterizer that is exact for the curve it is given. gezira's
-- DecomposeBeziers halves a curve until a midpoint falls within 0.1 of the
-- pixel grid, moves it onto the grid, and takes the piece inside a pixel as
-- its chord: the coverage is the exact area of a curve that is not quite the
-- one drawn, and as a control point moves it steps about the true area
-- instead of following it. Here a curve is cut where it meets the grid, and
-- a piece says the area under the curve itself. Each pixel's coverage then
-- follows its control points smoothly, so its derivative (umgeni's dual
-- numbers) is the area's, except where a point lies exactly on the grid.

-- Two points, and a point kept between them. Cutting a curve takes points
-- part of the way from one control point to the next; rounding can put such
-- a point a hair past the end it is nearest, and a piece that should run
-- one way then turns back. Kept within its two ends it cannot, and that is
-- what the two processes below rest on to end.
Ends <: (A, B : Point)

(P : Point) ⊓ (E : Ends) : Point
    (P ▷ (E.A ◁ E.B)) ◁ (E.A ▷ E.B)

(E : Ends) ⇢ (t : Real) : Point
    (E.A + (E.B - E.A) × t) ⊓ E

-- A quadratic turns back at most once in x and once in y: where its middle
-- control point is not between its ends, at t = (A - B) / (A - 2B + C). Cut
-- there, each piece runs one way in x and one way in y, and so lies within
-- the rectangle of its ends. At the turn the piece's tangent is level, so
-- its new control points have the turn's own coordinate, and that is said
-- outright (`level`). A coordinate that already ran one way still does in
-- both pieces, their points being kept between the ones they come from. So
-- a curve is cut at most twice over, once for x and once for y.
MonotoneBeziers : Bezier >> Bezier
    ∀ (A, B, C)
        turns = (B - A) × (C - B) < 0
        if turns.x ∨ turns.y
            T     = (A - B) / ((A - 2 × B + C) ? 1)
            t     = { T.x if turns.x, T.y }
            level = (turns.x, ¬turns.x) : Point
            AB    = (A, B) ⇢ t
            BC    = (B, C) ⇢ t
            M     = (AB, BC) ⇢ t
            << (M, { M if level, BC }, C) << (A, { M if level, AB }, M)
        else
            >> (A, B, C)

-- For MonotoneBeziers' pieces: a piece that runs one way meets a grid line
-- at most once. K is the first grid line from A on the way to C, in x and
-- in y; if K lies strictly between the ends the piece is cut there, at the
-- root of its quadratic, and the cut point is put on the line exactly. The
-- two pieces run one way still, within the piece they came from, with one
-- grid line fewer between the ends of each: which is why this ends. (An
-- end at infinity has no last grid line before it, so such a piece is not
-- cut: `C - C = 0` says C is a number one can reach.)
--
-- The piece from A is fed last and so taken first, and it is the short one:
-- what waits is only the rest of the curve, never a row of pieces. (The GPU
-- gives each thread a small stack for what waits.)
--
-- A piece with no grid line between its ends lies in one pixel, P. Its
-- sample is the area between it and the pixel's right side: the integral of
-- (P.x + 1 - x) dy along the quadratic, in closed form.
DecomposeExact : Bezier >> EdgeSample
    ∀ (A, B, C)
        K       = { ⌊ A ⌋ + 1 if A < C, ⌈ A ⌉ - 1 }
        crosses = ((A < K ∧ K < C) ∨ (C < K ∧ K < A)) ∧ (C - C = 0)
        if crosses.x ∨ crosses.y
            a  = A - 2 × B + C
            b  = 2 × (B - A)
            s  = { 1 if A < C, -1 }
            T  = 2 × (K - A) / ((b + s × √((b × b - 4 × a × (A - K)) ▷ 0)) ? 1)
            t  = { T.x if crosses.x, T.y }
            on = (crosses.x, ¬crosses.x) : Point
            AB = (A, B) ⇢ t
            BC = (B, C) ⇢ t
            M  = { K if on, (AB, BC) ⇢ t }
            << (M, BC ⊓ (M, C), C) << (A, AB ⊓ (A, M), M)
        else
            P = ⌊ A ⌋ ◁ ⌊ C ⌋
            u = P.x + 1 - A.x
            v = P.x + 1 - B.x
            w = P.x + 1 - C.x
            >> (P.x + 1/2, P.y + 1/2,
                (B.y - A.y) × (u / 2 + v / 3 + w / 6) + (C.y - B.y) × (u / 6 + v / 3 + w / 2),
                C.y - A.y)

RasterizeExact : Bezier >> CoverageSpan
    ⇒ RasterizeBy (MonotoneBeziers → DecomposeExact, SpansOf)

-- The pixels themselves, for the GPU presenter (as RasterizePixels is to
-- RasterizeParallel).
RasterizePixelsExact : Bezier >> CoveragePoint
    ⇒ RasterizeExact → ExpandSpans
