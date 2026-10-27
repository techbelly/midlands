// What the two benchmarks share: the paragraph they set, and a median.
export const PARAGRAPH =
  'THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG. PACK MY BOX WITH FIVE DOZEN JUGS. ' +
  'UMGENI RENDERS THIS PARAGRAPH THROUGH A PIPELINE COMPILED FROM NILE SOURCE, WRAPPING LINES AS IT GOES.';
export const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
