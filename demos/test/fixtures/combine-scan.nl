WindingPixel <: (x, y, c, w : Real)

SumByPixel : EdgeSample >> EdgeSample
    x = 0
    y = 0
    A = 0
    H = 0
    ∀ (x', y', a, h)
        if x' = x ∧ y' = y
            A' = A + a
            H' = H + h
        else
            >> (x, y, A, H)
            A' = a
            H' = h
    >> (x, y, A, H)

WindScanline : EdgeSample >> WindingPixel
    y = 0
    H = 0
    ∀ (x', y', a, h)
        Hb = {H if y' = y, 0}
        >> (x', y', Hb + a, Hb + h)
        H' = Hb + h

SpansOfPixels : WindingPixel >> CoverageSpan
    x = 0
    y = 0
    c = 0
    w = 0
    started = 0
    ∀ (x', y', c', w')
        if started
            >> (x, y, |c| ◁ 1, 1)
            if y' = y
                >> (x + 1, y, |w| ◁ 1, x' - x - 1)
        started' = 1
    >> (x, y, |c| ◁ 1, 1)

RasterizeScan : Bezier >> CoverageSpan
    ⇒ DecomposeBeziers → SortBy (@x) → SortBy (@y) → SumByPixel → WindScanline → SpansOfPixels
