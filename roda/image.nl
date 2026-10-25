-- Painting with an image. Nile has no memory to read, so ReadImage is a
-- process the host supplies, declared here by its signature alone: the
-- colour (premultiplied) of the pixel under a point, transparent outside
-- the image. Everything around it is Nile: M places the image on the page,
-- so its inverse carries each pixel into the image's space, where it is
-- sampled bilinearly as Cairo's default filter does. A pattern repeats the
-- image across the plane, and has a matrix of its own, from the page's
-- user space into the image's (Cairo's pattern matrix).
ReadImage :: (img : Real) : Point >> Color

PaintImage (M : Matrix, img : Real) : CoverageSpan >> PaintedPixel
    ⇒ ApplyTexture (TransformPoints (⁻¹ M) → BilinearFilter (ReadImage (img)))

PaintImageRepeat (M, Mp : Matrix, D : Point, img : Real) : CoverageSpan >> PaintedPixel
    ⇒ ApplyTexture (TransformPoints (Mp ∘ ⁻¹ M) → RepeatTexture (D) → BilinearFilter (ReadImage (img)))
