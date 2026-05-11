import { buildChangesFromObjects, changesToRanges } from './diff';
import { ChangeBuilder, create, fair } from './iterable';
import type { Line } from './line';
import { defaultLcsComputer } from './patienceLcs';
import { expandRange } from './trimUtil';
import type { FairDiffIterable } from './types';

export const UNIMPORTANT_LINE_CHAR_COUNT = 3;

export function compareSmart(
  lines1: readonly Line[],
  lines2: readonly Line[],
  threshold = UNIMPORTANT_LINE_CHAR_COUNT,
  usePatienceAlg?: boolean
): FairDiffIterable {
  if (threshold === 0) return diffLines(lines1, lines2, usePatienceAlg);

  const bigLines1 = getBigLines(lines1, threshold);
  const bigLines2 = getBigLines(lines2, threshold);
  const changes = diffLines(bigLines1.lines, bigLines2.lines, usePatienceAlg);
  return new SmartLineChangeCorrector(bigLines1.indexes, bigLines2.indexes, lines1, lines2, changes).build();
}

export function diffLines(lines1: readonly Line[], lines2: readonly Line[], usePatienceAlg?: boolean): FairDiffIterable {
  const change = buildChangesFromObjects(lines1, lines2, defaultLcsComputer(usePatienceAlg), {
    equals: (left, right) => left.equals(right),
    keyOf: (line) => line.key
  });
  return fair(create(changesToRanges(change), lines1.length, lines2.length));
}

function getBigLines(lines: readonly Line[], threshold: number): { lines: Line[]; indexes: number[] } {
  const bigLines: Line[] = [];
  const indexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].nonSpaceChars > threshold) {
      bigLines.push(lines[i]);
      indexes.push(i);
    }
  }
  return { lines: bigLines, indexes };
}

abstract class ChangeCorrector {
  protected readonly builder: ChangeBuilder;

  constructor(
    private readonly length1: number,
    private readonly length2: number,
    private readonly changes: FairDiffIterable
  ) {
    this.builder = new ChangeBuilder(length1, length2);
  }

  build(): FairDiffIterable {
    this.execute();
    return fair(this.builder.finish());
  }

  protected execute(): void {
    let last1 = 0;
    let last2 = 0;

    for (const change of this.changes.unchanged()) {
      const count = change.end1 - change.start1;
      for (let i = 0; i < count; i++) {
        const range1 = this.getOriginalRange1(change.start1 + i);
        const range2 = this.getOriginalRange2(change.start2 + i);

        this.matchGap(last1, range1.start, last2, range2.start);
        this.builder.markEqual(range1.start, range2.start, range1.end, range2.end);

        last1 = range1.end;
        last2 = range2.end;
      }
    }

    this.matchGap(last1, this.length1, last2, this.length2);
  }

  protected abstract matchGap(start1: number, end1: number, start2: number, end2: number): void;
  protected abstract getOriginalRange1(index: number): { start: number; end: number };
  protected abstract getOriginalRange2(index: number): { start: number; end: number };
}

export class SmartLineChangeCorrector extends ChangeCorrector {
  constructor(
    private readonly indexes1: readonly number[],
    private readonly indexes2: readonly number[],
    private readonly lines1: readonly Line[],
    private readonly lines2: readonly Line[],
    changes: FairDiffIterable
  ) {
    super(lines1.length, lines2.length, changes);
  }

  protected matchGap(start1: number, end1: number, start2: number, end2: number): void {
    const expanded = expandRange(this.lines1, this.lines2, start1, start2, end1, end2, (left, right) => left.equals(right));
    const inner1 = this.lines1.slice(expanded.start1, expanded.end1);
    const inner2 = this.lines2.slice(expanded.start2, expanded.end2);
    const innerChanges = diffLines(inner1, inner2);

    this.builder.markEqual(start1, start2, expanded.start1, expanded.start2);

    for (const chunk of innerChanges.unchanged()) {
      this.builder.markEqual(
        expanded.start1 + chunk.start1,
        expanded.start2 + chunk.start2,
        chunk.end1 - chunk.start1
      );
    }

    this.builder.markEqual(expanded.end1, expanded.end2, end1, end2);
  }

  protected getOriginalRange1(index: number): { start: number; end: number } {
    const offset = this.indexes1[index];
    return { start: offset, end: offset + 1 };
  }

  protected getOriginalRange2(index: number): { start: number; end: number } {
    const offset = this.indexes2[index];
    return { start: offset, end: offset + 1 };
  }
}
