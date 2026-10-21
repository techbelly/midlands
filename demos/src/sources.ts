// Node-side: where the demos' Nile comes from. gezira's kernels are used
// unmodified; text.nl, vector.nl, svg.nl and spans.nl are the demos' own; rasterize2.nl is
// umgeni's scan-form rasterizer (the one the GPU lowering recognises).

import { readFileSync } from 'node:fs';

// The midlands root; overridable because bundling relocates import.meta.url.
export const ROOT = new URL('../../', import.meta.url);
export const read = (path: string, root: URL = ROOT) => readFileSync(new URL(path, root), 'utf8');

export const TEXT_SOURCES = ['gezira/types.nl', 'gezira/bezier.nl', 'gezira/rasterize.nl', 'gezira/texture.nl', 'demos/nl/text.nl', 'demos/nl/spans.nl', 'umgeni/nl/rasterize2.nl'];
export const VECTOR_SOURCES = ['gezira/types.nl', 'gezira/bezier.nl', 'gezira/stroke.nl', 'gezira/rasterize.nl', 'gezira/texture.nl', 'demos/nl/vector.nl', 'demos/nl/svg.nl', 'demos/nl/spans.nl'];
