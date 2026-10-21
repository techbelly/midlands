// The grammar text, read from disk under node. Browser bundles swap in
// source.browser.ts (tools/build-demo.mjs), which embeds the same file.
import { readFileSync } from 'node:fs';

export const nileGrammarSource = readFileSync(new URL('./nile.ohm', import.meta.url), 'utf8');
