// The Mooi grammar text, read from disk under node. Browser bundles swap in
// source.browser.ts, which embeds the same file.
import { readFileSync } from 'node:fs';

export const mooiGrammarSource = readFileSync(new URL('./mooi.ohm', import.meta.url), 'utf8');
