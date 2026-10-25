-- Dashes. The pattern is up to four lengths, on, off, on, off, repeating
-- (a two-length pattern is on, off, on, off). The distance travelled along
-- the path so far, d, says where in the pattern a bezier begins. A bezier
-- that crosses the next switch is split there: its first part is dealt with
-- and the rest is fed back, to begin at the switch. A bezier's length is
-- estimated from its control polygon, close enough once FlattenCubics has
-- made the beziers nearly flat. Lengths that are not positive count as
-- zero, and a pattern of nothing never splits.
DashBeziers (on1, off1, on2, off2, phase : Real) : Bezier >> Bezier
    b1 = on1 ▷ 0
    b2 = b1 + (off1 ▷ 0)
    b3 = b2 + (on2 ▷ 0)
    b4 = b3 + (off2 ▷ 0)
    d = phase
    ∀ (A, B, C)
        L = (‖B - A‖ + ‖C - B‖ + ‖C - A‖) / 2
        p = d % b4
        lit = p < b1 ∨ (b2 ≤ p ∧ p < b3)
        r = { b1 - p if p < b1, b2 - p if p < b2, b3 - p if p < b3, b4 - p }
        if L ≤ r ∨ r ≤ 0
            if lit
                >> (A, B, C)
            d' = d + L
        else
            t = r / L
            AB = A + (B - A) × t
            BC = B + (C - B) × t
            M = AB + (BC - AB) × t
            if lit
                >> (A, AB, M)
            d' = d + r
            << (M, BC, C)

-- Stroking the pieces. gezira's stroker joins every bezier to the next and
-- caps only the ends of the stream. Here a bezier that does not begin where
-- the last one ended starts a new piece: the last piece is capped, and the
-- new bezier is the first of its piece (so a piece can still close on
-- itself). The offsets, joins and caps are gezira's own kernels.
OffsetAndJoinPieces (o, l, c : Real, Z1, Zi : Bezier) : Bezier >> Bezier
    ∀ Zj
        if Zi.C =# Zj.A
            ⇒ OffsetAndJoinPieces (o, l, c, Z1, Zj) → JoinBeziers (o, l, Zi, Zj) → OffsetBezier (o, Zi)
        else
            ⇒ OffsetAndJoinPieces (o, l, c, Zj, Zj) → CapBezier (o, c, Zi) → OffsetBezier (o, Zi)
    if Zi.C =# Z1.A
        ⇒ JoinBeziers (o, l, Zi, Z1) → OffsetBezier (o, Zi)
    else
        ⇒ CapBezier (o, c, Zi) → OffsetBezier (o, Zi)

StrokePiecesOneSide (w, l, c : Real) : Bezier >> Bezier
    ∀ Z1
        ⇒ OffsetAndJoinPieces ((w / 2), l, c, Z1, Z1) → (→)

StrokePieces (w, l, c : Real) : Bezier >> Bezier
    ⇒ SanitizeBezierPath →
      DupCat (StrokePiecesOneSide (w, l, c),
              Reverse → ReverseBeziers → StrokePiecesOneSide (w, l, c))

-- A dashed stroke of a path of cubics: dashed in device space, then each
-- dash outlined with its own caps.
DashedStroke (M : Matrix, w, l, c, on1, off1, on2, off2, phase : Real) : Cubic >> Bezier
    ⇒ TransformCubics (M) → FlattenCubics → DashBeziers (on1, off1, on2, off2, phase) → StrokePieces (w, l, c)
