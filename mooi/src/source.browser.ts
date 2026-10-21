// Browser twin of source.ts: the grammar embedded at bundle time.
// @ts-expect-error text import resolved by esbuild
import text from './mooi.ohm';

export const mooiGrammarSource: string = text;
