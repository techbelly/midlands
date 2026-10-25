// Node-side text rendering: drive a compiled text library
// (compileLibraryFile('demos/nl/text.nl-lib')) via the pure host helpers.
// The web demo does the same with the library its bundle compiled.

import type { CompiledLibrary } from '../../../umgeni/src/compile.js';
import { driveTextSpans, textSpansParams, type Driven, type RenderOptions } from './host.js';

export function renderText(library: CompiledLibrary, text: string, opts: RenderOptions): Driven {
  const nile = library.api;
  if (!nile.TextSpans) throw new Error('TextSpans did not compile');
  return driveTextSpans(nile, nile.TextSpans(textSpansParams(opts)), text, opts.glyphs);
}
