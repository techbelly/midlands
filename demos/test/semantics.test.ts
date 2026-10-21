// The demos' programs through umgeni's interpreter ≡ compiler check
// (umgeni/test/agree.ts): the semantics on numbers against the same
// semantics staged, kernel by kernel, bit for bit.
import { describe } from 'vitest';
import { agree } from '../../umgeni/test/agree.js';
import { read, TEXT_SOURCES, VECTOR_SOURCES } from '../src/sources.js';

const library = ['types', 'bezier', 'stroke', 'rasterize', 'texture', 'compositor', 'gradient', 'filter'].map((n) => read(`gezira/${n}.nl`));
describe('interpreter ≡ compiler, kernel by kernel: text + Rasterize2', () => agree(TEXT_SOURCES.map((p) => read(p))));
describe('interpreter ≡ compiler, kernel by kernel: vector', () => agree([...library, read('demos/nl/vector.nl')]));
