// Browser twin of source.ts: Nile's definition embedded at bundle time.
// @ts-expect-error text imports resolved by esbuild
import values from './values.mooi';
// @ts-expect-error
import nile from './nile.mooi';
// @ts-expect-error
import sugar from './sugar.mooi';

export const valuesSource: string = values;
export const nileSource: string = nile;
export const sugarSource: string = sugar;
