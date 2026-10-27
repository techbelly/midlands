// What the compiler refuses: Nile beyond its reach, or wrong. Anything on
// the way from syntax tree to IR (the value algebra, sugar, the kernel and
// pipeline semantics, substitution, the elaborator) throws an ElabError with
// the reason, and elaboration reports the process as unsupported rather
// than failing the library. A Mooi file fails through elabFail.

export class ElabError extends Error {}

export const elabFail = (msg: string): never => {
  throw new ElabError(msg);
};
