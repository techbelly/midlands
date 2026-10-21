// Starting points for the paint page. Each defines `Paint : Point >> Color`
// using gezira's library (gradient, texture, compositor, filter .nl), or
// kernels written right here. Colors are (alpha, red, green, blue).

export const PRESETS: { name: string; source: string }[] = [
  {
    name: 'Linear gradient, reflected',
    source: `-- A gradient is a pipeline: positions → a parameter s → colours.
-- Try RepeatGradient or PadGradient instead of ReflectGradient.
Paint : Point >> Color
    ⇒ LinearGradient ((60, 40), (190, 130)) → ReflectGradient →
      ApplyColorSpans (
          ColorSpan ((1, 0.98, 0.36, 0.20), (1, 0.98, 0.80, 0.25), 0.5) →
          ColorSpan ((1, 0.98, 0.80, 0.25), (1, 0.20, 0.45, 0.85), 0.5))
`,
  },
  {
    name: 'Radial glow',
    source: `-- RadialGradient measures distance from a centre, in units of r.
Paint : Point >> Color
    ⇒ RadialGradient ((220, 150), 190) → PadGradient →
      ApplyColorSpans (
          ColorSpan ((1, 1, 1, 0.85), (1, 0.95, 0.40, 0.30), 0.35) →
          ColorSpan ((1, 0.95, 0.40, 0.30), (1, 0.25, 0.05, 0.40), 0.65))
`,
  },
  {
    name: 'Stripes, Gaussian-blurred',
    source: `-- Hard-edged stripes, then a separable 5×5 Gaussian blur.
-- A blur is a texture of a texture: GaussianBlur5x1 (f, t) samples t
-- five times per pixel (DupZip pairs samples with weights).
-- Remove the blur to see the hard edges; try GaussianBlur11x1/1x11.
Stripes : Point >> Color
    ⇒ LinearGradient ((0, 0), (14, 6)) → RepeatGradient →
      ApplyColorSpans (
          ColorSpan ((1, 0.10, 0.10, 0.15), (1, 0.10, 0.10, 0.15), 0.5) →
          ColorSpan ((1, 0.95, 0.90, 0.80), (1, 0.95, 0.90, 0.80), 0.5))

Paint : Point >> Color
    ⇒ GaussianBlur5x1 (0, GaussianBlur1x5 (0, Stripes))
`,
  },
  {
    name: 'Compositing two textures',
    source: `-- CompositeTextures (a, b, mode) runs both textures on every point
-- and blends them. Modes are Composite + Over, Multiply, Screen,
-- Overlay, Darken, Lighten, ColorDodge, ColorBurn, HardLight,
-- SoftLight, Difference, Exclusion, Xor, Plus, SrcIn, DstOut, …
Stripes : Point >> Color
    ⇒ LinearGradient ((0, 0), (20, 20)) → RepeatGradient →
      ApplyColorSpans (
          ColorSpan ((1, 0.2, 0.3, 0.9), (1, 0.95, 0.95, 1), 1))

Glow : Point >> Color
    ⇒ RadialGradient ((200, 140), 170) → PadGradient →
      ApplyColorSpans (
          ColorSpan ((1, 1, 0.8, 0.2), (1, 0.8, 0.1, 0.3), 1))

Paint : Point >> Color
    ⇒ CompositeTextures (Stripes, Glow, CompositeDifference)
`,
  },
  {
    name: 'Your own kernel: checkerboard',
    source: `-- A brand-new texture kernel, written in Nile right here.
Checker (s : Real) : Point >> Color
    ∀ P
        Q = ⌊ P / s ⌋
        k = (Q.x + Q.y) % 2
        >> { (1, 0.12, 0.14, 0.20) if k = 0, (1, 0.93, 0.88, 0.75) }

-- Rotate the plane 37° first: TransformPoints applies a matrix.
Paint : Point >> Color
    ⇒ TransformPoints ((0.8, 0.6, -0.6, 0.8, 0, 0)) → Checker (18)
`,
  },
  {
    name: 'Bicubic magnification',
    source: `-- A checkerboard of 1-unit texels, magnified 24×. BicubicFilter
-- reconstructs smooth values between texel centres; swap in
-- BilinearFilter, or remove the filter to see the raw texels.
Checker (s : Real) : Point >> Color
    ∀ P
        Q = ⌊ P / s ⌋
        k = (Q.x + Q.y) % 2
        >> { (1, 0.10, 0.25, 0.45) if k = 0, (1, 0.95, 0.85, 0.40) }

Paint : Point >> Color
    ⇒ TransformPoints ((1/24, 0, 0, 1/24, 0, 0)) → BicubicFilter (Checker (1))
`,
  },
];
