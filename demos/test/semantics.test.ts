// The demos' libraries through umgeni's interpreter ≡ compiler check
// (umgeni/test/agree.ts): the semantics on numbers against the same
// semantics staged, kernel by kernel, bit for bit.
import { describe } from 'vitest';
import { agree } from '../../umgeni/test/agree.js';
import { librarySourceTexts } from '../src/sources.js';

describe('interpreter ≡ compiler, kernel by kernel: text + RasterizeParallel', () => agree(librarySourceTexts('demos/nl/text.nl-lib')));
// The vector and paint libraries share most of gezira: each source once.
const vectorAndPaint = [...new Set([...librarySourceTexts('demos/nl/vector.nl-lib'), ...librarySourceTexts('demos/nl/paint.nl-lib')])];
describe('interpreter ≡ compiler, kernel by kernel: vector (tiger, strokes, the Cairo samples) + paint', () => agree(vectorAndPaint));
