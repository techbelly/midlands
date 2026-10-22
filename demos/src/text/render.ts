// Node-side text rendering: drive a compiled text program
// (compileProgramFile('demos/nl/text.program')) via the pure host helpers.
// The web demo does the same with the program its bundle compiled.

import type { CompiledProgram } from '../../../umgeni/src/compile.js';
import { driveTextSpans, textSpansParams, type Driven, type RenderOptions } from './host.js';

export function renderText(program: CompiledProgram, text: string, opts: RenderOptions): Driven {
  const nile = program.api;
  if (!nile.TextSpans) throw new Error('TextSpans did not compile');
  return driveTextSpans(nile, nile.TextSpans(textSpansParams(opts)), text, opts.glyphs);
}
