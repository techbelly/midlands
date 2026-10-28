// The corpus's generated code (corpus-sources.ts says what it is), hashed.
// A refactor of the compiler that should change nothing leaves every hash the
// same; one that should change something shows which libraries moved, marked
// against the recording in tools/corpus.json, which npm test holds the
// compiler to. --record refreshes that recording once a change is meant.
// With --out <dir> the sources are written there too, for diffing two runs.
//
// Run: npm run corpus [-- [--record] [--out <dir>]]

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { corpus, hashOf, RECORD, recorded } from './corpus-sources.js';

const record = process.argv.includes('--record');
const outAt = process.argv.indexOf('--out');
const out = outAt >= 0 ? process.argv[outAt + 1] : null;
if (out) mkdirSync(out, { recursive: true });

const before = existsSync(RECORD) ? recorded() : {};
const hashes: Record<string, string> = {};
let all = createHash('sha256');
let moved = 0;
for (const [name, generate] of corpus()) {
  const source = generate();
  all.update(source);
  if (out) writeFileSync(`${out}/${name.replace(/[^\w.-]+/g, '-')}.js`, source);
  hashes[name] = hashOf(source);
  const mark = hashes[name] === before[name] ? ' ' : '*';
  if (mark === '*') moved++;
  console.log(hashes[name], mark, String(source.length).padStart(8), name);
}
console.log(all.digest('hex').slice(0, 16), ' ', ''.padStart(8), 'all together');
if (record) {
  writeFileSync(RECORD, JSON.stringify(hashes, null, 2) + '\n');
  console.log(`recorded ${Object.keys(hashes).length} hashes in tools/corpus.json`);
} else if (!existsSync(RECORD)) {
  console.log('nothing recorded yet; npm run corpus -- --record');
} else if (moved) {
  console.log(`${moved} moved (*) from tools/corpus.json; npm run corpus -- --record once that is meant`);
}
