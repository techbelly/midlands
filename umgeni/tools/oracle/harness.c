// Oracle harness: run an ORIGINAL gezira process — Amelang's maru-compiled
// gezira.c on the original Nile C runtime — over beziers read from stdin and
// print the output beziers, one per line. Built by tools/oracle/build.sh.
// usage: harness <process> [params...] < beziers   (6 numbers per line)
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include "nile.h"
#include "gezira.h"
#define MEM (64 << 20)
#define MAXOUT (1 << 20)
#define PIPE(...) nile_Process_pipe(__VA_ARGS__, NILE_NULL)

// The paint scenes of test/fixtures/paint-scenes.nl, built the way gezira's
// own C demos build textures: CoverageSpan >> (Color, CoveragePoint).
static nile_Process_t *stripes(nile_Process_t *n) {
  return PIPE(gezira_LinearGradient(n, 0, 0, 8, 3), gezira_RepeatGradient(n),
              gezira_ApplyColorSpans(n, PIPE(gezira_ColorSpan(n, 1, 0, 0, 0, 1, 1, 1, 1, 0.5),
                                             gezira_ColorSpan(n, 1, 1, 1, 1, 1, 0, 0, 0, 0.5))));
}
static nile_Process_t *glow(nile_Process_t *n) {
  return PIPE(gezira_RadialGradient(n, 50, 40, 30), gezira_ReflectGradient(n),
              gezira_ApplyColorSpans(n, gezira_ColorSpan(n, 1, 1, 1, 0, 1, 0, 0.5, 1, 1)));
}
static nile_Process_t *scene(nile_Process_t *n, const char *w) {
  nile_Process_t *t = NULL;
  if (!strcmp(w, "SceneLinearPad"))
    t = PIPE(gezira_LinearGradient(n, 10, 10, 90, 60), gezira_PadGradient(n),
             gezira_ApplyColorSpans(n, PIPE(gezira_ColorSpan(n, 1, 1, 0, 0, 1, 0, 0, 1, 0.5),
                                            gezira_ColorSpan(n, 1, 0, 0, 1, 0.5, 0, 0.5, 0, 0.5))));
  else if (!strcmp(w, "SceneRadialMultiply"))
    t = gezira_CompositeTextures(n, glow(n), gezira_UniformColor(n, 0.8, 0.9, 0.3, 0.6), gezira_CompositeMultiply(n));
  else if (!strcmp(w, "SceneBlur"))
    t = gezira_GaussianBlur5x1(n, 0.5, gezira_GaussianBlur1x5(n, 0.5, stripes(n)));
  else if (!strcmp(w, "SceneFilters"))
    t = gezira_BilinearFilter(n, gezira_BicubicFilter(n, PIPE(gezira_TransformPoints(n, 0.7, 0.3, -0.3, 0.7, 5, 2), stripes(n))));
  else if (!strcmp(w, "SceneSoftLight"))
    t = gezira_CompositeTextures(n, stripes(n), glow(n), gezira_CompositeSoftLight(n));
  return t ? gezira_ApplyTexture(n, t) : NULL;
}
int main(int argc, char **argv) {
  static float in[MAXOUT], out[MAXOUT];
  int nin = 0, nout = 0;
  float p[16]; int np = argc - 2;
  for (int i = 0; i < np; i++) p[i] = atof(argv[i + 2]);
  while (nin < MAXOUT && scanf(sizeof(float) == 8 ? "%lf" : "%f", &in[nin]) == 1) nin++;
  nile_Process_t *init = nile_startup(malloc(MEM), MEM, 1);
  if (!init) { fprintf(stderr, "startup failed\n"); return 1; }
  const char *w = argv[1];
  nile_Process_t *proc;
  int outW = 6;
  if (!strcmp(w, "StrokeBezierPath")) proc = gezira_StrokeBezierPath(init, p[0], p[1], p[2]);
  else if (!strcmp(w, "StrokeOneSide")) proc = gezira_StrokeOneSide(init, p[0], p[1], p[2]);
  else if (!strcmp(w, "SanitizeBezierPath")) proc = gezira_SanitizeBezierPath(init);
  else if (!strcmp(w, "OffsetBezier")) proc = gezira_OffsetBezier(init, p[0], p[1], p[2], p[3], p[4], p[5], p[6]);
  else if (!strcmp(w, "RoundJoin")) proc = gezira_RoundJoin(init, p[0], p[1], p[2], p[3], p[4], p[5], p[6]);
  else if (!strcmp(w, "OffsetAndJoin")) proc = gezira_OffsetAndJoin(init, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11], p[12], p[13], p[14]);
  else if ((proc = scene(init, w))) outW = 8;
  else { fprintf(stderr, "unknown process %s\n", w); return 1; }
  nile_Process_t *pipe = nile_Process_pipe(proc, nile_Capture(init, out, &nout, MAXOUT), NILE_NULL);
  nile_Process_feed(pipe, in, nin);
  nile_sync(init);
  if (nile_error(init)) { fprintf(stderr, "nile_error\n"); return 1; }
  for (int i = 0; i + outW <= nout; i += outW)
    for (int j = 0; j < outW; j++) printf(j + 1 < outW ? "%.17g " : "%.17g\n", out[i + j]);
  free(nile_shutdown(init));
  return 0;
}
