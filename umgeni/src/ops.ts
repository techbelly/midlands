// User-defined operators. Infix operators need no registration — the grammar
// parses any non-reserved operator-glyph run as infix. Prefix and outfix
// operators are ambiguous without knowing them ahead of use, so opDef headers
// are scanned first and this table generates an Ohm extension grammar
// overriding the placeholder rules in nile.ohm.

export interface OpTable {
  infix: Set<string>;
  prefix: Set<string>;
  outfix: Map<string, string>; // open glyphs -> close glyphs
}

// How an operator is keyed in the operator table and named in a UnOp: an
// infix operator by its glyphs, a prefix one as `op_`, an outfix one as
// `open_close` (ast.ts's UnOp).
export const opKey = (fixity: 'infix' | 'prefix' | 'outfix', op: string, close?: string | null): string =>
  fixity === 'infix' ? op : fixity === 'prefix' ? `${op}_` : `${op}_${close}`;

export function emptyOpTable(): OpTable {
  return { infix: new Set(), prefix: new Set(), outfix: new Map() };
}

function ohmLiteral(s: string): string {
  return JSON.stringify(s);
}

// Grammar-as-data all the way down: the operator table is itself rendered as
// a (generated) Ohm grammar extending the core.
export function opExtensionSource(table: OpTable): string | null {
  const prefixes = [...table.prefix];
  const outfixes = [...table.outfix.entries()];
  if (prefixes.length === 0 && outfixes.length === 0) return null;

  const rules: string[] = [];
  if (prefixes.length > 0) {
    rules.push(`  userPrefixOp := ${prefixes.map(ohmLiteral).join(' | ')}`);
  }
  if (outfixes.length > 0) {
    const alts = outfixes.map(
      ([open, close], i) => `${ohmLiteral(open)} Expr ${ohmLiteral(close)} -- o${i}`,
    );
    rules.push(`  UserOutfix := ${alts.join('\n    | ')}`);
  }
  // Reserve prefix/outfix glyph runs so the generic infix rule cannot swallow
  // an outfix closer (e.g. the second | of |x|) or a prefix operator.
  const reserved = new Set<string>(prefixes);
  for (const [open, close] of outfixes) {
    reserved.add(open);
    reserved.add(close);
  }
  rules.push(`  extraReservedTok := ${[...reserved].map(ohmLiteral).join(' | ')}`);

  return `NileWithOps <: Nile {\n${rules.join('\n')}\n}`;
}
