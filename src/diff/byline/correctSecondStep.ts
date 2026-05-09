import { fair, ExpandChangeBuilder } from './iterable';
import type { Line } from './line';
import { linesEqual } from './policy';
import type { FairDiffIterable } from './types';

export function correctChangesSecondStep(
  lines1: readonly Line[],
  lines2: readonly Line[],
  changes: FairDiffIterable
): FairDiffIterable {
  const builder = new ExpandChangeBuilder(lines1, lines2, (left, right) => left.equals(right));
  let sample: string | null = null;
  let last1 = 0;
  let last2 = 0;

  const alignExactMatching = (subLines1: readonly number[], subLines2: readonly number[]) => {
    const size = Math.max(subLines1.length, subLines2.length);
    const skipAligning = size > 10 || subLines1.length === subLines2.length;

    if (skipAligning) {
      const count = Math.min(subLines1.length, subLines2.length);
      for (let i = 0; i < count; i++) {
        const index1 = subLines1[i];
        const index2 = subLines2[i];
        if (lines1[index1].equals(lines2[index2])) builder.markEqual(index1, index2);
      }
      return;
    }

    if (subLines1.length < subLines2.length) {
      const matching = getBestMatchingAlignment(subLines1, subLines2, lines1, lines2);
      for (let i = 0; i < subLines1.length; i++) {
        const index1 = subLines1[i];
        const index2 = subLines2[matching[i]];
        if (lines1[index1].equals(lines2[index2])) builder.markEqual(index1, index2);
      }
    } else {
      const matching = getBestMatchingAlignment(subLines2, subLines1, lines2, lines1);
      for (let i = 0; i < subLines2.length; i++) {
        const index1 = subLines1[matching[i]];
        const index2 = subLines2[i];
        if (lines1[index1].equals(lines2[index2])) builder.markEqual(index1, index2);
      }
    }
  };

  const flush = (line1: number, line2: number) => {
    if (sample === null) return;

    const start1 = Math.max(last1, builder.index1);
    const start2 = Math.max(last2, builder.index2);
    const subLines1: number[] = [];
    const subLines2: number[] = [];

    for (let i = start1; i < line1; i++) {
      if (linesEqual(sample, lines1[i].content, 'IW')) {
        subLines1.push(i);
        last1 = i + 1;
      }
    }
    for (let i = start2; i < line2; i++) {
      if (linesEqual(sample, lines2[i].content, 'IW')) {
        subLines2.push(i);
        last2 = i + 1;
      }
    }

    if (subLines1.length === 0 || subLines2.length === 0) {
      throw new Error('Invalid second-step IW matching group');
    }
    alignExactMatching(subLines1, subLines2);
    sample = null;
  };

  for (const range of changes.unchanged()) {
    const count = range.end1 - range.start1;
    for (let i = 0; i < count; i++) {
      const index1 = range.start1 + i;
      const index2 = range.start2 + i;
      const line1 = lines1[index1];
      const line2 = lines2[index2];

      if (sample === null || !linesEqual(sample, line1.content, 'IW')) {
        if (line1.equals(line2)) {
          flush(index1, index2);
          builder.markEqual(index1, index2);
        } else {
          flush(index1, index2);
          sample = line1.content;
        }
      }
    }
  }

  flush(changes.length1, changes.length2);
  return fair(builder.finish());
}

function getBestMatchingAlignment(
  subLines1: readonly number[],
  subLines2: readonly number[],
  lines1: readonly Line[],
  lines2: readonly Line[]
): number[] {
  if (subLines1.length >= subLines2.length) throw new Error('First alignment side must be shorter');

  const size = subLines1.length;
  const comb = new Array<number>(size).fill(0);
  const best = Array.from({ length: size }, (_, i) => i);
  let bestWeight = 0;

  const processCombination = () => {
    let weight = 0;
    for (let i = 0; i < size; i++) {
      const index1 = subLines1[i];
      const index2 = subLines2[comb[i]];
      if (lines1[index1].equals(lines2[index2])) weight++;
    }

    if (weight > bestWeight) {
      bestWeight = weight;
      for (let i = 0; i < size; i++) best[i] = comb[i];
    }
  };

  const combinations = (start: number, n: number, k: number) => {
    if (k === size) {
      processCombination();
      return;
    }

    for (let i = start; i <= n; i++) {
      comb[k] = i;
      combinations(i + 1, n, k + 1);
    }
  };

  combinations(0, subLines2.length - 1, 0);
  return best;
}
