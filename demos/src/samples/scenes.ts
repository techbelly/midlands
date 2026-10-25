// Cairo's samples (cairographics.org/samples, by Øyvind Kolås, public
// domain), drawn by Nile: each one's C, verbatim, and the same picture made
// with the Sheet (draw.ts), whose operations are compiled Nile. `nile` names
// the definitions a page quotes beside the C.

import type { Font } from '../text/ttf.js';
import { path, type Path } from './path.js';
import { textExtents, textPath } from './text.js';
import { invert as invertM, multiply, rotate, scale, translate, type Rgba, type Sheet } from './draw.js';
import type { ImgLike } from '../vector/spans.js';

export interface Scene {
  id: string; // the anchor on cairographics.org/samples
  title: string;
  cairo: string;
  nile: string[];
  draw: (s: Sheet, font: Font, image: ImgLike) => void;
}

const D = Math.PI / 180;
const TAU = 2 * Math.PI;
const BLACK: Rgba = [0, 0, 0, 1];
const HELP: Rgba = [1, 0.2, 0.2, 0.6]; // the samples' "helping lines"
const circle = (x: number, y: number, r: number): Path => path().arc(x, y, r, 0, TAU).build();

const STROKE = ['StrokeOutline', 'StrokeBezierPath', 'FillWinding', 'RasterizeParallel', 'PaintSpans'];
const FILL = ['FlattenCubics', 'FillWinding', 'RasterizeParallel', 'PaintSpans'];

// The arc samples share their helping lines.
function arcHelp(s: Sheet, xc: number, yc: number, r: number, a1: number, a2: number): void {
  s.fill(circle(xc, yc, 10), HELP);
  s.stroke(path().arc(xc, yc, r, a1, a1).lineTo(xc, yc).arc(xc, yc, r, a2, a2).lineTo(xc, yc).build(), HELP, { width: 6 });
}
// fill style: a rectangle with two circles cut by opposite windings.
function fillStyle(dy: number): Path {
  return path().rectangle(12, 12 + dy, 232, 70).newSubPath().arc(64, 64 + dy, 40, 0, TAU).newSubPath().arcNegative(192, 64 + dy, 40, 0, -TAU).build();
}
const chevron = (y: number) => path().moveTo(76.8, y).relLineTo(51.2, -51.2).relLineTo(51.2, 51.2).build();

// Cairo's examples index also lists "Bezier gradients": patches of colour
// with curved sides (PDF's type 6 shading, cairo_pattern_create_mesh). A
// twentieth card, in Cairo's own API, since the samples page has none.
export const SCENES: Scene[] = [
  {
    id: 'arc', title: 'arc', nile: STROKE,
    cairo: `double xc = 128.0;
double yc = 128.0;
double radius = 100.0;
double angle1 = 45.0  * (M_PI/180.0);  /* angles are specified */
double angle2 = 180.0 * (M_PI/180.0);  /* in radians           */

cairo_set_line_width (cr, 10.0);
cairo_arc (cr, xc, yc, radius, angle1, angle2);
cairo_stroke (cr);

/* draw helping lines */
cairo_set_source_rgba (cr, 1, 0.2, 0.2, 0.6);
cairo_set_line_width (cr, 6.0);

cairo_arc (cr, xc, yc, 10.0, 0, 2*M_PI);
cairo_fill (cr);

cairo_arc (cr, xc, yc, radius, angle1, angle1);
cairo_line_to (cr, xc, yc);
cairo_arc (cr, xc, yc, radius, angle2, angle2);
cairo_line_to (cr, xc, yc);
cairo_stroke (cr);`,
    draw(s) {
      s.stroke(path().arc(128, 128, 100, 45 * D, 180 * D).build(), BLACK, { width: 10 });
      arcHelp(s, 128, 128, 100, 45 * D, 180 * D);
    },
  },
  {
    id: 'arc_negative', title: 'arc negative', nile: STROKE,
    cairo: `double xc = 128.0;
double yc = 128.0;
double radius = 100.0;
double angle1 = 45.0  * (M_PI/180.0);  /* angles are specified */
double angle2 = 180.0 * (M_PI/180.0);  /* in radians           */

cairo_set_line_width (cr, 10.0);
cairo_arc_negative (cr, xc, yc, radius, angle1, angle2);
cairo_stroke (cr);

/* draw helping lines */
cairo_set_source_rgba (cr, 1, 0.2, 0.2, 0.6);
cairo_set_line_width (cr, 6.0);

cairo_arc (cr, xc, yc, 10.0, 0, 2*M_PI);
cairo_fill (cr);

cairo_arc (cr, xc, yc, radius, angle1, angle1);
cairo_line_to (cr, xc, yc);
cairo_arc (cr, xc, yc, radius, angle2, angle2);
cairo_line_to (cr, xc, yc);
cairo_stroke (cr);`,
    draw(s) {
      s.stroke(path().arcNegative(128, 128, 100, 45 * D, 180 * D).build(), BLACK, { width: 10 });
      arcHelp(s, 128, 128, 100, 45 * D, 180 * D);
    },
  },
  {
    id: 'clip', title: 'clip', nile: ['Intersect', 'ClipPaint', 'FillWinding', 'StrokeOutline'],
    cairo: `cairo_arc (cr, 128.0, 128.0, 76.8, 0, 2 * M_PI);
cairo_clip (cr);

cairo_new_path (cr);  /* current path is not
                         consumed by cairo_clip() */
cairo_rectangle (cr, 0, 0, 256, 256);
cairo_fill (cr);
cairo_set_source_rgb (cr, 0, 1, 0);
cairo_move_to (cr, 0, 0);
cairo_line_to (cr, 256, 256);
cairo_move_to (cr, 256, 0);
cairo_line_to (cr, 0, 256);
cairo_set_line_width (cr, 10.0);
cairo_stroke (cr);`,
    draw(s) {
      s.clip(circle(128, 128, 76.8));
      s.fill(path().rectangle(0, 0, 256, 256).build(), BLACK);
      s.stroke(path().moveTo(0, 0).lineTo(256, 256).moveTo(256, 0).lineTo(0, 256).build(), [0, 1, 0, 1], { width: 10 });
    },
  },
  {
    id: 'clip_image', title: 'clip image', nile: ['Intersect', 'PaintImage', 'ReadImage', 'BilinearFilter', 'ApplyTexture'],
    cairo: `int              w, h;
cairo_surface_t *image;

cairo_arc (cr, 128.0, 128.0, 76.8, 0, 2*M_PI);
cairo_clip (cr);
cairo_new_path (cr); /* path not consumed by clip()*/

image = cairo_image_surface_create_from_png ("data/romedalen.png");
w = cairo_image_surface_get_width (image);
h = cairo_image_surface_get_height (image);

cairo_scale (cr, 256.0/w, 256.0/h);

cairo_set_source_surface (cr, image, 0, 0);
cairo_paint (cr);

cairo_surface_destroy (image);`,
    draw(s, _font, image) {
      s.clip(circle(128, 128, 76.8));
      s.paintImage(image, scale(256 / image.width, 256 / image.height));
    },
  },
  {
    id: 'curve_rectangle', title: 'curve rectangle', nile: [...FILL, 'StrokeOutline'],
    cairo: `/* a custom shape that could be wrapped in a function */
double x0      = 25.6,   /* parameters like cairo_rectangle */
       y0      = 25.6,
       rect_width  = 204.8,
       rect_height = 204.8,
       radius = 102.4;   /* and an approximate curvature radius */

double x1,y1;

x1=x0+rect_width;
y1=y0+rect_height;
if (!rect_width || !rect_height)
    return;
if (rect_width/2<radius) {
    if (rect_height/2<radius) {
        cairo_move_to  (cr, x0, (y0 + y1)/2);
        cairo_curve_to (cr, x0 ,y0, x0, y0, (x0 + x1)/2, y0);
        cairo_curve_to (cr, x1, y0, x1, y0, x1, (y0 + y1)/2);
        cairo_curve_to (cr, x1, y1, x1, y1, (x1 + x0)/2, y1);
        cairo_curve_to (cr, x0, y1, x0, y1, x0, (y0 + y1)/2);
    } else {
        cairo_move_to  (cr, x0, y0 + radius);
        cairo_curve_to (cr, x0 ,y0, x0, y0, (x0 + x1)/2, y0);
        cairo_curve_to (cr, x1, y0, x1, y0, x1, y0 + radius);
        cairo_line_to (cr, x1 , y1 - radius);
        cairo_curve_to (cr, x1, y1, x1, y1, (x1 + x0)/2, y1);
        cairo_curve_to (cr, x0, y1, x0, y1, x0, y1- radius);
    }
} else {
    if (rect_height/2<radius) {
        cairo_move_to  (cr, x0, (y0 + y1)/2);
        cairo_curve_to (cr, x0 , y0, x0 , y0, x0 + radius, y0);
        cairo_line_to (cr, x1 - radius, y0);
        cairo_curve_to (cr, x1, y0, x1, y0, x1, (y0 + y1)/2);
        cairo_curve_to (cr, x1, y1, x1, y1, x1 - radius, y1);
        cairo_line_to (cr, x0 + radius, y1);
        cairo_curve_to (cr, x0, y1, x0, y1, x0, (y0 + y1)/2);
    } else {
        cairo_move_to  (cr, x0, y0 + radius);
        cairo_curve_to (cr, x0 , y0, x0 , y0, x0 + radius, y0);
        cairo_line_to (cr, x1 - radius, y0);
        cairo_curve_to (cr, x1, y0, x1, y0, x1, y0 + radius);
        cairo_line_to (cr, x1 , y1 - radius);
        cairo_curve_to (cr, x1, y1, x1, y1, x1 - radius, y1);
        cairo_line_to (cr, x0 + radius, y1);
        cairo_curve_to (cr, x0, y1, x0, y1, x0, y1- radius);
    }
}
cairo_close_path (cr);

cairo_set_source_rgb (cr, 0.5, 0.5, 1);
cairo_fill_preserve (cr);
cairo_set_source_rgba (cr, 0.5, 0, 0, 0.5);
cairo_set_line_width (cr, 10.0);
cairo_stroke (cr);`,
    draw(s) {
      const x0 = 25.6, y0 = 25.6, x1 = x0 + 204.8, y1 = y0 + 204.8, r = 102.4;
      const p = path().moveTo(x0, y0 + r).curveTo(x0, y0, x0, y0, x0 + r, y0).lineTo(x1 - r, y0).curveTo(x1, y0, x1, y0, x1, y0 + r)
        .lineTo(x1, y1 - r).curveTo(x1, y1, x1, y1, x1 - r, y1).lineTo(x0 + r, y1).curveTo(x0, y1, x0, y1, x0, y1 - r).closePath().build();
      s.fill(p, [0.5, 0.5, 1, 1]);
      s.stroke(p, [0.5, 0, 0, 0.5], { width: 10 });
    },
  },
  {
    id: 'curve_to', title: 'curve to', nile: STROKE,
    cairo: `double x=25.6,  y=128.0;
double x1=102.4, y1=230.4,
       x2=153.6, y2=25.6,
       x3=230.4, y3=128.0;

cairo_move_to (cr, x, y);
cairo_curve_to (cr, x1, y1, x2, y2, x3, y3);

cairo_set_line_width (cr, 10.0);
cairo_stroke (cr);

cairo_set_source_rgba (cr, 1, 0.2, 0.2, 0.6);
cairo_set_line_width (cr, 6.0);
cairo_move_to (cr,x,y);   cairo_line_to (cr,x1,y1);
cairo_move_to (cr,x2,y2); cairo_line_to (cr,x3,y3);
cairo_stroke (cr);`,
    draw(s) {
      s.stroke(path().moveTo(25.6, 128).curveTo(102.4, 230.4, 153.6, 25.6, 230.4, 128).build(), BLACK, { width: 10 });
      s.stroke(path().moveTo(25.6, 128).lineTo(102.4, 230.4).moveTo(153.6, 25.6).lineTo(230.4, 128).build(), HELP, { width: 6 });
    },
  },
  {
    id: 'dash', title: 'dash', nile: ['DashedStroke', 'DashBeziers', 'StrokePieces', 'OffsetAndJoinPieces', 'FillWinding', 'PaintSpans'],
    cairo: `double dashes[] = {50.0,  /* ink */
                   10.0,  /* skip */
                   10.0,  /* ink */
                   10.0   /* skip*/
                  };
int    ndash  = sizeof (dashes)/sizeof(dashes[0]);
double offset = -50.0;

cairo_set_dash (cr, dashes, ndash, offset);
cairo_set_line_width (cr, 10.0);

cairo_move_to (cr, 128.0, 25.6);
cairo_line_to (cr, 230.4, 230.4);
cairo_rel_line_to (cr, -102.4, 0.0);
cairo_curve_to (cr, 51.2, 230.4, 51.2, 128.0, 128.0, 128.0);

cairo_stroke (cr);`,
    draw(s) {
      const p = path().moveTo(128, 25.6).lineTo(230.4, 230.4).relLineTo(-102.4, 0).curveTo(51.2, 230.4, 51.2, 128, 128, 128).build();
      s.stroke(p, BLACK, { width: 10, dash: { pattern: [50, 10, 10, 10], offset: -50 } });
    },
  },
  {
    id: 'fill_and_stroke2', title: 'fill and stroke2', nile: [...FILL, 'StrokeOutline'],
    cairo: `cairo_move_to (cr, 128.0, 25.6);
cairo_line_to (cr, 230.4, 230.4);
cairo_rel_line_to (cr, -102.4, 0.0);
cairo_curve_to (cr, 51.2, 230.4, 51.2, 128.0, 128.0, 128.0);
cairo_close_path (cr);

cairo_move_to (cr, 64.0, 25.6);
cairo_rel_line_to (cr, 51.2, 51.2);
cairo_rel_line_to (cr, -51.2, 51.2);
cairo_rel_line_to (cr, -51.2, -51.2);
cairo_close_path (cr);

cairo_set_line_width (cr, 10.0);
cairo_set_source_rgb (cr, 0, 0, 1);
cairo_fill_preserve (cr);
cairo_set_source_rgb (cr, 0, 0, 0);
cairo_stroke (cr);`,
    draw(s) {
      const p = path().moveTo(128, 25.6).lineTo(230.4, 230.4).relLineTo(-102.4, 0).curveTo(51.2, 230.4, 51.2, 128, 128, 128).closePath()
        .moveTo(64, 25.6).relLineTo(51.2, 51.2).relLineTo(-51.2, 51.2).relLineTo(-51.2, -51.2).closePath().build();
      s.fill(p, [0, 0, 1, 1]);
      s.stroke(p, BLACK, { width: 10 });
    },
  },
  {
    id: 'fill_style', title: 'fill style', nile: ['FillEvenOdd', 'RasterizeEvenOdd', 'SpansOfEvenOdd', 'FillWinding', 'RasterizeParallel', 'SpansOf'],
    cairo: `cairo_set_line_width (cr, 6);

cairo_rectangle (cr, 12, 12, 232, 70);
cairo_new_sub_path (cr); cairo_arc (cr, 64, 64, 40, 0, 2*M_PI);
cairo_new_sub_path (cr); cairo_arc_negative (cr, 192, 64, 40, 0, -2*M_PI);

cairo_set_fill_rule (cr, CAIRO_FILL_RULE_EVEN_ODD);
cairo_set_source_rgb (cr, 0, 0.7, 0); cairo_fill_preserve (cr);
cairo_set_source_rgb (cr, 0, 0, 0); cairo_stroke (cr);

cairo_translate (cr, 0, 128);
cairo_rectangle (cr, 12, 12, 232, 70);
cairo_new_sub_path (cr); cairo_arc (cr, 64, 64, 40, 0, 2*M_PI);
cairo_new_sub_path (cr); cairo_arc_negative (cr, 192, 64, 40, 0, -2*M_PI);

cairo_set_fill_rule (cr, CAIRO_FILL_RULE_WINDING);
cairo_set_source_rgb (cr, 0, 0, 0.9); cairo_fill_preserve (cr);
cairo_set_source_rgb (cr, 0, 0, 0); cairo_stroke (cr);`,
    draw(s) {
      s.fill(fillStyle(0), [0, 0.7, 0, 1], 'evenodd');
      s.stroke(fillStyle(0), BLACK, { width: 6 });
      s.fill(fillStyle(128), [0, 0, 0.9, 1], 'winding');
      s.stroke(fillStyle(128), BLACK, { width: 6 });
    },
  },
  {
    id: 'gradient', title: 'gradient', nile: ['Sky', 'Sun', 'FromInner', 'PaintSky', 'PaintSun', 'ApplyTexture', 'LinearGradient', 'RadialGradient', 'ApplyColorSpans'],
    cairo: `cairo_pattern_t *pat;

pat = cairo_pattern_create_linear (0.0, 0.0,  0.0, 256.0);
cairo_pattern_add_color_stop_rgba (pat, 1, 0, 0, 0, 1);
cairo_pattern_add_color_stop_rgba (pat, 0, 1, 1, 1, 1);
cairo_rectangle (cr, 0, 0, 256, 256);
cairo_set_source (cr, pat);
cairo_fill (cr);
cairo_pattern_destroy (pat);

pat = cairo_pattern_create_radial (115.2, 102.4, 25.6,
                                   102.4,  102.4, 128.0);
cairo_pattern_add_color_stop_rgba (pat, 0, 1, 1, 1, 1);
cairo_pattern_add_color_stop_rgba (pat, 1, 0, 0, 0, 1);
cairo_set_source (cr, pat);
cairo_arc (cr, 128.0, 128.0, 76.8, 0, 2 * M_PI);
cairo_fill (cr);
cairo_pattern_destroy (pat);`,
    draw(s) {
      s.paintTexture('PaintSky', path().rectangle(0, 0, 256, 256).build());
      s.paintTexture('PaintSun', circle(128, 128, 76.8));
    },
  },
  {
    id: 'image', title: 'image', nile: ['PaintImage', 'ReadImage', 'TransformPoints', 'BilinearFilter', 'ApplyTexture'],
    cairo: `int              w, h;
cairo_surface_t *image;

image = cairo_image_surface_create_from_png ("data/romedalen.png");
w = cairo_image_surface_get_width (image);
h = cairo_image_surface_get_height (image);

cairo_translate (cr, 128.0, 128.0);
cairo_rotate (cr, 45* M_PI/180);
cairo_scale  (cr, 256.0/w, 256.0/h);
cairo_translate (cr, -0.5*w, -0.5*h);

cairo_set_source_surface (cr, image, 0, 0);
cairo_paint (cr);
cairo_surface_destroy (image);`,
    draw(s, _font, image) {
      const { width: w, height: h } = image;
      const M = [translate(128, 128), rotate(45 * D), scale(256 / w, 256 / h), translate(-0.5 * w, -0.5 * h)].reduce(multiply);
      s.paintImage(image, M);
    },
  },
  {
    id: 'imagepattern', title: 'imagepattern', nile: ['PaintImageRepeat', 'ReadImage', 'RepeatTexture', 'TransformPoints', 'BilinearFilter', 'ApplyTexture'],
    cairo: `int              w, h;
cairo_surface_t *image;
cairo_pattern_t *pattern;
cairo_matrix_t   matrix;

image = cairo_image_surface_create_from_png ("data/romedalen.png");
w = cairo_image_surface_get_width (image);
h = cairo_image_surface_get_height (image);

pattern = cairo_pattern_create_for_surface (image);
cairo_pattern_set_extend (pattern, CAIRO_EXTEND_REPEAT);

cairo_translate (cr, 128.0, 128.0);
cairo_rotate (cr, M_PI / 4);
cairo_scale (cr, 1 / sqrt (2), 1 / sqrt (2));
cairo_translate (cr, -128.0, -128.0);

cairo_matrix_init_scale (&matrix, w/256.0 * 5.0, h/256.0 * 5.0);
cairo_pattern_set_matrix (pattern, &matrix);

cairo_set_source (cr, pattern);

cairo_rectangle (cr, 0, 0, 256.0, 256.0);
cairo_fill (cr);

cairo_pattern_destroy (pattern);
cairo_surface_destroy (image);`,
    draw(s, _font, image) {
      const { width: w, height: h } = image;
      // The page's transform, and the pattern's matrix (page space → image space).
      const ctm = [translate(128, 128), rotate(Math.PI / 4), scale(1 / Math.SQRT2, 1 / Math.SQRT2), translate(-128, -128)].reduce(multiply);
      const pattern = scale((w / 256) * 5, (h / 256) * 5);
      // paintImage takes image → page: the inverse of (pattern ∘ ctm⁻¹).
      s.paintImage(image, multiply(ctm, invertM(pattern)), 'repeat');
    },
  },
  {
    id: 'multi_segment_caps', title: 'multi segment caps', nile: STROKE,
    cairo: `cairo_move_to (cr, 50.0, 75.0);
cairo_line_to (cr, 200.0, 75.0);

cairo_move_to (cr, 50.0, 125.0);
cairo_line_to (cr, 200.0, 125.0);

cairo_move_to (cr, 50.0, 175.0);
cairo_line_to (cr, 200.0, 175.0);

cairo_set_line_width (cr, 30.0);
cairo_set_line_cap (cr, CAIRO_LINE_CAP_ROUND);
cairo_stroke (cr);`,
    draw(s) {
      s.stroke(path().moveTo(50, 75).lineTo(200, 75).moveTo(50, 125).lineTo(200, 125).moveTo(50, 175).lineTo(200, 175).build(), BLACK, { width: 30, cap: 'round' });
    },
  },
  {
    id: 'rounded_rectangle', title: 'rounded rectangle', nile: [...FILL, 'StrokeOutline'],
    cairo: `/* a custom shape that could be wrapped in a function */
double x         = 25.6,        /* parameters like cairo_rectangle */
       y         = 25.6,
       width         = 204.8,
       height        = 204.8,
       aspect        = 1.0,     /* aspect ratio */
       corner_radius = height / 10.0;   /* and corner curvature radius */

double radius = corner_radius / aspect;
double degrees = M_PI / 180.0;

cairo_new_sub_path (cr);
cairo_arc (cr, x + width - radius, y + radius, radius, -90 * degrees, 0 * degrees);
cairo_arc (cr, x + width - radius, y + height - radius, radius, 0 * degrees, 90 * degrees);
cairo_arc (cr, x + radius, y + height - radius, radius, 90 * degrees, 180 * degrees);
cairo_arc (cr, x + radius, y + radius, radius, 180 * degrees, 270 * degrees);
cairo_close_path (cr);

cairo_set_source_rgb (cr, 0.5, 0.5, 1);
cairo_fill_preserve (cr);
cairo_set_source_rgba (cr, 0.5, 0, 0, 0.5);
cairo_set_line_width (cr, 10.0);
cairo_stroke (cr);`,
    draw(s) {
      const x = 25.6, y = 25.6, w = 204.8, h = 204.8, r = h / 10;
      const p = path().newSubPath().arc(x + w - r, y + r, r, -90 * D, 0).arc(x + w - r, y + h - r, r, 0, 90 * D)
        .arc(x + r, y + h - r, r, 90 * D, 180 * D).arc(x + r, y + r, r, 180 * D, 270 * D).closePath().build();
      s.fill(p, [0.5, 0.5, 1, 1]);
      s.stroke(p, [0.5, 0, 0, 0.5], { width: 10 });
    },
  },
  {
    id: 'set_line_cap', title: 'set line cap', nile: ['StrokeOutline', 'StrokeBezierPath', 'CapBezier', 'FillWinding', 'PaintSpans'],
    cairo: `cairo_set_line_width (cr, 30.0);
cairo_set_line_cap  (cr, CAIRO_LINE_CAP_BUTT); /* default */
cairo_move_to (cr, 64.0, 50.0); cairo_line_to (cr, 64.0, 200.0);
cairo_stroke (cr);
cairo_set_line_cap  (cr, CAIRO_LINE_CAP_ROUND);
cairo_move_to (cr, 128.0, 50.0); cairo_line_to (cr, 128.0, 200.0);
cairo_stroke (cr);
cairo_set_line_cap  (cr, CAIRO_LINE_CAP_SQUARE);
cairo_move_to (cr, 192.0, 50.0); cairo_line_to (cr, 192.0, 200.0);
cairo_stroke (cr);

/* draw helping lines */
cairo_set_source_rgb (cr, 1, 0.2, 0.2);
cairo_set_line_width (cr, 2.56);
cairo_move_to (cr, 64.0, 50.0); cairo_line_to (cr, 64.0, 200.0);
cairo_move_to (cr, 128.0, 50.0);  cairo_line_to (cr, 128.0, 200.0);
cairo_move_to (cr, 192.0, 50.0); cairo_line_to (cr, 192.0, 200.0);
cairo_stroke (cr);`,
    draw(s) {
      const v = (x: number) => path().moveTo(x, 50).lineTo(x, 200).build();
      s.stroke(v(64), BLACK, { width: 30, cap: 'butt' });
      s.stroke(v(128), BLACK, { width: 30, cap: 'round' });
      s.stroke(v(192), BLACK, { width: 30, cap: 'square' });
      s.stroke(path().moveTo(64, 50).lineTo(64, 200).moveTo(128, 50).lineTo(128, 200).moveTo(192, 50).lineTo(192, 200).build(), [1, 0.2, 0.2, 1], { width: 2.56 });
    },
  },
  {
    id: 'set_line_join', title: 'set line join', nile: ['StrokeOutline', 'StrokeBezierPath', 'JoinBeziers', 'MiterJoin', 'RoundJoin', 'FillWinding', 'PaintSpans'],
    cairo: `cairo_set_line_width (cr, 40.96);
cairo_move_to (cr, 76.8, 84.48);
cairo_rel_line_to (cr, 51.2, -51.2);
cairo_rel_line_to (cr, 51.2, 51.2);
cairo_set_line_join (cr, CAIRO_LINE_JOIN_MITER); /* default */
cairo_stroke (cr);

cairo_move_to (cr, 76.8, 161.28);
cairo_rel_line_to (cr, 51.2, -51.2);
cairo_rel_line_to (cr, 51.2, 51.2);
cairo_set_line_join (cr, CAIRO_LINE_JOIN_BEVEL);
cairo_stroke (cr);

cairo_move_to (cr, 76.8, 238.08);
cairo_rel_line_to (cr, 51.2, -51.2);
cairo_rel_line_to (cr, 51.2, 51.2);
cairo_set_line_join (cr, CAIRO_LINE_JOIN_ROUND);
cairo_stroke (cr);`,
    draw(s) {
      s.stroke(chevron(84.48), BLACK, { width: 40.96, join: 'miter' });
      s.stroke(chevron(161.28), BLACK, { width: 40.96, join: 'bevel' });
      s.stroke(chevron(238.08), BLACK, { width: 40.96, join: 'round' });
    },
  },
  {
    id: 'text', title: 'text', nile: [...FILL, 'StrokeOutline'],
    cairo: `cairo_select_font_face (cr, "Sans", CAIRO_FONT_SLANT_NORMAL,
                               CAIRO_FONT_WEIGHT_BOLD);
cairo_set_font_size (cr, 90.0);

cairo_move_to (cr, 10.0, 135.0);
cairo_show_text (cr, "Hello");

cairo_move_to (cr, 70.0, 165.0);
cairo_text_path (cr, "void");
cairo_set_source_rgb (cr, 0.5, 0.5, 1);
cairo_fill_preserve (cr);
cairo_set_source_rgb (cr, 0, 0, 0);
cairo_set_line_width (cr, 2.56);
cairo_stroke (cr);

/* draw helping lines */
cairo_set_source_rgba (cr, 1, 0.2, 0.2, 0.6);
cairo_arc (cr, 10.0, 135.0, 5.12, 0, 2*M_PI);
cairo_close_path (cr);
cairo_arc (cr, 70.0, 165.0, 5.12, 0, 2*M_PI);
cairo_fill (cr);`,
    draw(s, font) {
      s.fill(textPath(font, 'Hello', 90, 10, 135), BLACK);
      const v = textPath(font, 'void', 90, 70, 165);
      s.fill(v, [0.5, 0.5, 1, 1]);
      s.stroke(v, BLACK, { width: 2.56 });
      s.fill(path().arc(10, 135, 5.12, 0, TAU).closePath().arc(70, 165, 5.12, 0, TAU).build(), HELP);
    },
  },
  {
    id: 'text_align_center', title: 'text align center', nile: [...FILL, 'StrokeOutline'],
    cairo: `cairo_text_extents_t extents;

const char *utf8 = "cairo";
double x,y;

cairo_select_font_face (cr, "Sans",
    CAIRO_FONT_SLANT_NORMAL,
    CAIRO_FONT_WEIGHT_NORMAL);

cairo_set_font_size (cr, 52.0);
cairo_text_extents (cr, utf8, &extents);
x = 128.0-(extents.width/2 + extents.x_bearing);
y = 128.0-(extents.height/2 + extents.y_bearing);

cairo_move_to (cr, x, y);
cairo_show_text (cr, utf8);

/* draw helping lines */
cairo_set_source_rgba (cr, 1, 0.2, 0.2, 0.6);
cairo_set_line_width (cr, 6.0);
cairo_arc (cr, x, y, 10.0, 0, 2*M_PI);
cairo_fill (cr);
cairo_move_to (cr, 128.0, 0);
cairo_rel_line_to (cr, 0, 256);
cairo_move_to (cr, 0, 128.0);
cairo_rel_line_to (cr, 256, 0);
cairo_stroke (cr);`,
    draw(s, font) {
      const e = textExtents(font, 'cairo', 52);
      const x = 128 - (e.width / 2 + e.xBearing);
      const y = 128 - (e.height / 2 + e.yBearing);
      s.fill(textPath(font, 'cairo', 52, x, y), BLACK);
      s.fill(circle(x, y, 10), HELP);
      s.stroke(path().moveTo(128, 0).relLineTo(0, 256).moveTo(0, 128).relLineTo(256, 0).build(), HELP, { width: 6 });
    },
  },
  {
    id: 'text_extents', title: 'text extents', nile: [...FILL, 'StrokeOutline'],
    cairo: `cairo_text_extents_t extents;

const char *utf8 = "cairo";
double x,y;

cairo_select_font_face (cr, "Sans",
    CAIRO_FONT_SLANT_NORMAL,
    CAIRO_FONT_WEIGHT_NORMAL);

cairo_set_font_size (cr, 100.0);
cairo_text_extents (cr, utf8, &extents);

x=25.0;
y=150.0;

cairo_move_to (cr, x,y);
cairo_show_text (cr, utf8);

/* draw helping lines */
cairo_set_source_rgba (cr, 1, 0.2, 0.2, 0.6);
cairo_set_line_width (cr, 6.0);
cairo_arc (cr, x, y, 10.0, 0, 2*M_PI);
cairo_fill (cr);
cairo_move_to (cr, x,y);
cairo_rel_line_to (cr, 0, -extents.height);
cairo_rel_line_to (cr, extents.width, 0);
cairo_rel_line_to (cr, extents.x_bearing, -extents.y_bearing);
cairo_stroke (cr);`,
    draw(s, font) {
      const e = textExtents(font, 'cairo', 100);
      const x = 25, y = 150;
      s.fill(textPath(font, 'cairo', 100, x, y), BLACK);
      s.fill(circle(x, y, 10), HELP);
      s.stroke(path().moveTo(x, y).relLineTo(0, -e.height).relLineTo(e.width, 0).relLineTo(e.xBearing, -e.yBearing).build(), HELP, { width: 6 });
    },
  },
  {
    id: 'mesh', title: 'mesh gradient (Bezier gradients)', nile: ['MeshPixels', 'SplitPatches', 'PiecePixels'],
    cairo: `cairo_pattern_t *pat = cairo_pattern_create_mesh ();

/* one Coons patch: four curved sides, a colour at each corner */
cairo_mesh_pattern_begin_patch (pat);
cairo_mesh_pattern_move_to (pat, 25.6, 25.6);
cairo_mesh_pattern_curve_to (pat, 93.6, -34.4, 162.4, 85.6, 230.4, 25.6);
cairo_mesh_pattern_curve_to (pat, 290.4, 93.6, 170.4, 162.4, 230.4, 230.4);
cairo_mesh_pattern_curve_to (pat, 162.4, 290.4, 93.6, 170.4, 25.6, 230.4);
cairo_mesh_pattern_curve_to (pat, -34.4, 162.4, 85.6, 93.6, 25.6, 25.6);
cairo_mesh_pattern_set_corner_color_rgb (pat, 0, 1, 0, 0);
cairo_mesh_pattern_set_corner_color_rgb (pat, 1, 0, 1, 0);
cairo_mesh_pattern_set_corner_color_rgb (pat, 2, 1, 1, 0);
cairo_mesh_pattern_set_corner_color_rgb (pat, 3, 0, 0, 1);
cairo_mesh_pattern_end_patch (pat);

cairo_set_source (cr, pat);
cairo_paint (cr);
cairo_pattern_destroy (pat);`,
    draw(s) {
      // The same patch as its four sides: top and bottom left to right,
      // left and right top to bottom (Cairo's walks round the corners).
      const x0 = 25.6, x1 = 230.4, y0 = 25.6, y1 = 230.4, k = 60, m = 68;
      s.paintMesh([{
        T: [x0, y0, x0 + m, y0 - k, x1 - m, y0 + k, x1, y0],
        B: [x0, y1, x0 + m, y1 + k, x1 - m, y1 - k, x1, y1],
        L: [x0, y0, x0 - k, y0 + m, x0 + k, y1 - m, x0, y1],
        R: [x1, y0, x1 + k, y0 + m, x1 - k, y1 - m, x1, y1],
        colors: [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [1, 1, 0, 1]],
      }]);
    },
  },
];
