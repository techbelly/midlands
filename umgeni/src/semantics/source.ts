// Nile's definition, in Mooi, read from disk under node. Browser bundles swap
// in source.browser.ts, which embeds the same files.
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
export const valuesSource = read('./values.mooi');
export const nileSource = read('./nile.mooi');
export const sugarSource = read('./sugar.mooi');
export const pipelinesSource = read('./pipelines.mooi');
