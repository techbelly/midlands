-- The Cairo samples' own Nile. Most samples need only the kernels in the
-- other files; the gradient sample's two sources are textures, defined here,
-- with the pipelines that paint a shape with them.

-- Cairo's linear gradient from (0, 0) to (0, 256), white to black.
Sky : Texture
    ⇒ LinearGradient ((0, 0), (0, 256)) → PadGradient →
      ApplyColorSpans (ColorSpan ((1, 1, 1, 1), (1, 0, 0, 0), 1))

-- Cairo's radial gradient runs between two circles; with one centre, that
-- is gezira's with the inner circle's share of the distance taken off first.
FromInner (r0 : Real) : Real >> Real
    ∀ s
        >> (s - r0) / (1 - r0)

Sun : Texture
    ⇒ RadialGradient ((102.4, 102.4), 128) → FromInner (0.2) → PadGradient →
      ApplyColorSpans (ColorSpan ((1, 1, 1, 1), (1, 0, 0, 0), 1))

PaintSky (min, max : Point) : Bezier >> PaintedPixel
    ⇒ ClipBeziers (min, max) → RasterizeParallel → ApplyTexture (Sky)

PaintSun (min, max : Point) : Bezier >> PaintedPixel
    ⇒ ClipBeziers (min, max) → RasterizeParallel → ApplyTexture (Sun)

-- A shape's coverage: its beziers clipped to the page and rasterized, under
-- either fill rule.
FillWinding (min, max : Point) : Bezier >> CoverageSpan
    ⇒ ClipBeziers (min, max) → RasterizeParallel

FillEvenOdd (min, max : Point) : Bezier >> CoverageSpan
    ⇒ ClipBeziers (min, max) → RasterizeEvenOdd

-- An image as a source. Nile has no memory to read, so ReadImage is a
-- process the host supplies, declared here by its signature alone: the
-- colour (premultiplied) of the pixel under a point, transparent outside
-- the image. Everything around it is Nile: the points are carried into the
-- image's space, sampled bilinearly as Cairo's default filter does, and
-- repeated across the plane for a pattern.
ReadImage :: (img : Real) : Point >> Color

PaintImage (Mi : Matrix, img : Real) : CoverageSpan >> PaintedPixel
    ⇒ ApplyTexture (TransformPoints (Mi) → BilinearFilter (ReadImage (img)))

PaintImageRepeat (Mi : Matrix, D : Point, img : Real) : CoverageSpan >> PaintedPixel
    ⇒ ApplyTexture (TransformPoints (Mi) → RepeatTexture (D) → BilinearFilter (ReadImage (img)))
