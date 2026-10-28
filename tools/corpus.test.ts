// The compiler's output across the corpus is what was recorded: a change to
// the generated code fails here, library by library, until it is meant and
// recorded with npm run corpus -- --record.
import { describe, expect, it } from 'vitest';
import { corpus, hashOf, recorded } from './corpus-sources.js';

describe('the corpus generates what was recorded in tools/corpus.json', () => {
  const hashes = recorded();
  const libraries = corpus();
  it('records exactly the corpus', () => {
    expect(Object.keys(hashes).sort()).toEqual(libraries.map(([name]) => name).sort());
  });
  for (const [name, generate] of libraries) {
    it(name, () => {
      expect(hashOf(generate()), `${name} moved: diff two runs of npm run corpus -- --out <dir> to see how; -- --record once it is meant`).toBe(hashes[name]);
    });
  }
});
