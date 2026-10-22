// Node-side text rendering: compile the pipeline sources from disk, then
// drive it via the pure host helpers. The web demo does the same with a
// pre-generated pipeline module instead of the on-disk compiler.

import { compileProgram, type CompiledProgram, type CompileOptions } from '../../../umgeni/src/compile.js';
import { driveTextSpans, textSpansParams, type Driven, type RenderOptions } from './host.js';
import { read, ROOT, TEXT_SOURCES } from '../sources.js';

export function compileTextPipeline(root: URL = ROOT, opts: CompileOptions = {}): CompiledProgram {
  return compileProgram(TEXT_SOURCES.map((p) => read(p, root)), opts);
}

export function renderText(program: CompiledProgram, text: string, opts: RenderOptions): Driven {
  const nile = program.api;
  if (!nile.TextSpans) throw new Error('TextSpans did not compile');
  return driveTextSpans(nile, nile.TextSpans(textSpansParams(opts)), text, opts.glyphs);
}
