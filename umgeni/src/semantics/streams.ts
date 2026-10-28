// What a process does to a whole stream (streams.mooi), on numbers: the
// literal meaning of a mid-stream ⇒, a process becoming a pipeline, said
// in Mooi rather than in the interpreter's TypeScript (concrete.ts). The
// tests hold the two to each other and to the 2012 runtime.

import type { Token } from '../cpu/runtime.js';
import { load } from '../../../mooi/src/mooi.js';
import { prelude } from '../../../mooi/src/prelude.js';
import { elabFail } from '../unsupported.js';
import { kernelSteps } from './concrete.js';
import type { KernelContext, Program } from './domain.js';
import { streamsSource } from './source.js';

export function interpretProcess(P: Program, resolve: (name: string) => KernelContext | undefined) {
  const start = (st: { name: string; args: number[] }) =>
    kernelSteps(P, resolve(st.name) ?? elabFail(`⇒ to unknown '${st.name}'`), st.args);
  const m = load(streamsSource, { ...prelude(elabFail), start }) as { process: (m: unknown, input: Token[]) => Token[] };
  return (name: string, params: number[], input: Token[]): Token[] => m.process(start({ name, args: params }), input);
}
