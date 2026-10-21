Stripes : Point >> Color
    ⇒ LinearGradient ((0, 0), (8, 3)) → RepeatGradient →
      ApplyColorSpans (ColorSpan ((1, 0, 0, 0), (1, 1, 1, 1), 0.5) → ColorSpan ((1, 1, 1, 1), (1, 0, 0, 0), 0.5))

Glow : Point >> Color
    ⇒ RadialGradient ((50, 40), 30) → ReflectGradient →
      ApplyColorSpans (ColorSpan ((1, 1, 1, 0), (1, 0, 0.5, 1), 1))

SceneLinearPad : CoverageSpan >> (Color, CoveragePoint)
    ⇒ ApplyTexture (LinearGradient ((10, 10), (90, 60)) → PadGradient →
                    ApplyColorSpans (ColorSpan ((1, 1, 0, 0), (1, 0, 0, 1), 0.5) → ColorSpan ((1, 0, 0, 1), (0.5, 0, 0.5, 0), 0.5)))

SceneRadialMultiply : CoverageSpan >> (Color, CoveragePoint)
    ⇒ ApplyTexture (CompositeTextures (Glow, UniformColor ((0.8, 0.9, 0.3, 0.6)), CompositeMultiply))

SceneBlur : CoverageSpan >> (Color, CoveragePoint)
    ⇒ ApplyTexture (GaussianBlur5x1 (0.5, GaussianBlur1x5 (0.5, Stripes)))

SceneFilters : CoverageSpan >> (Color, CoveragePoint)
    ⇒ ApplyTexture (BilinearFilter (BicubicFilter (TransformPoints ((0.7, 0.3, -0.3, 0.7, 5, 2)) → Stripes)))

SceneSoftLight : CoverageSpan >> (Color, CoveragePoint)
    ⇒ ApplyTexture (CompositeTextures (Stripes, Glow, CompositeSoftLight))
