// Turns raw Nile source into a form the context-free grammar can parse:
//  - joins physical lines into logical lines (while inside brackets, or when
//    a line ends with a pipeline arrow "→")
//  - encodes indentation with sentinel characters, Python-style
//  - drops `--` comments to end of line (as the original maru grammar does)
//
// Sentinels (also documented in nile.ohm):
export const EOL = '\x01';
export const INDENT = '\x02';
export const DEDENT = '\x03';

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

export class PreprocessError extends Error {
  constructor(message: string, public line: number) {
    super(`line ${line}: ${message}`);
  }
}

interface LogicalLine {
  indent: number;
  text: string;
  line: number; // 1-based physical line where it starts
  // Where each joined physical line begins within `text`, for error positions.
  parts: { at: number; line: number; indent: number }[];
}

function logicalLines(source: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  let current: LogicalLine | null = null;
  let depth = 0;

  const physical = source.split('\n');
  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i].replace(/--.*$/, '').replace(/\s+$/, '');
    if (raw === '' && current === null) continue;
    if (/[\x00-\x03]/.test(raw)) {
      throw new PreprocessError('source contains reserved control characters', i + 1);
    }

    const text = raw.replace(/^\s+/, '');
    const indent = raw.length - text.length;
    if (current === null) {
      current = { indent, text, line: i + 1, parts: [{ at: 0, line: i + 1, indent }] };
    } else {
      current.parts.push({ at: current.text.length + 1, line: i + 1, indent });
      current.text += ' ' + text;
    }

    for (const ch of text) {
      if (OPEN.has(ch)) depth++;
      else if (CLOSE.has(ch)) depth--;
    }
    if (depth < 0) throw new PreprocessError('unbalanced brackets', i + 1);

    const continues = depth > 0 || current.text.endsWith('→');
    if (!continues) {
      if (current.text !== '') out.push(current);
      current = null;
    }
  }
  if (current !== null) {
    if (depth > 0) throw new PreprocessError('unclosed bracket at end of file', current.line);
    out.push(current);
  }
  return out;
}

export function preprocess(source: string): string {
  return preprocessMapped(source).text;
}

// The preprocessed text plus a map back to physical positions: `position`
// turns an offset in the text into the 1-based line and column of the source.
export function preprocessMapped(source: string): { text: string; position(offset: number): { line: number; col: number } } {
  const lines = logicalLines(source);
  const stack = [0];
  const marks: { at: number; line: number; indent: number }[] = [];
  let out = '';
  for (const { indent, text, line, parts } of lines) {
    if (indent > stack[stack.length - 1]) {
      stack.push(indent);
      out += INDENT;
    } else {
      while (indent < stack[stack.length - 1]) {
        stack.pop();
        out += DEDENT;
      }
      if (indent !== stack[stack.length - 1]) {
        throw new PreprocessError(`inconsistent indentation (column ${indent})`, line);
      }
    }
    for (const p of parts) marks.push({ ...p, at: out.length + p.at });
    out += text + EOL;
  }
  while (stack.length > 1) {
    stack.pop();
    out += DEDENT;
  }
  const position = (offset: number) => {
    let m = marks[0] ?? { at: 0, line: 1, indent: 0 };
    for (const k of marks) if (k.at <= offset) m = k;
    return { line: m.line, col: m.indent + Math.max(0, offset - m.at) + 1 };
  };
  return { text: out, position };
}
