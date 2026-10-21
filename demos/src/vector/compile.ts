// Node-side: compile the vector pipeline — gezira's own source, unmodified,
// plus demos/nl/vector.nl (cubics in, FillPath / StrokeOutline / FillBeziers out)
// and demos/nl/svg.nl (SVG path commands in, cubics out).

import { compileProgram, type CompiledProgram, type CompileOptions } from '../../../umgeni/src/compile.js';
import { read, ROOT, VECTOR_SOURCES } from '../sources.js';

export function compileVectorPipeline(root: URL = ROOT, opts: CompileOptions = {}): CompiledProgram {
  return compileProgram(VECTOR_SOURCES.map((p) => read(p, root)), opts);
}
