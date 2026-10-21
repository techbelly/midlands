// The Nile a page runs, quoted from its source files (so the page can't
// drift from the code): a pipeline (⇒) in full, a kernel by its signature.

export function quoteNile(sources: string[], names: string[]): string {
  const defs = new Map<string, string[]>();
  for (const src of sources) {
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/^([A-Z]\w*)\b(?!.*<:)/);
      if (!m) return;
      const def = [line];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) def.push(lines[j]);
      defs.set(m[1], def);
    });
  }
  return names
    .map((n) => {
      const def = defs.get(n);
      if (!def) return `-- (${n}: definition not found)`;
      return def[1]?.trim().startsWith('⇒') ? def.join('\n') : def[0];
    })
    .join('\n\n');
}
