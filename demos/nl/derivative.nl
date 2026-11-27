-- The derivative page's own Nile: a shape's edge samples summed pixel by
-- pixel, which is where a rasterizer stops being about the curve and
-- starts being about the picture. Each sample's h is the signed height of
-- outline crossing its pixel (the charge on the edge); the running sum of
-- h along a row, in WindScan, is the picture. One pipeline for each of the
-- two ways of cutting a curve.
EdgeCharge : Bezier >> EdgeSample
    ⇒ MonotoneBeziers → DecomposeExact → GroupBy (@y, @x) → ReduceBy (@y, @x; a ⊕ +, h ⊕ +)

EdgeChargeSnapped : Bezier >> EdgeSample
    ⇒ DecomposeBeziers → GroupBy (@y, @x) → ReduceBy (@y, @x; a ⊕ +, h ⊕ +)
