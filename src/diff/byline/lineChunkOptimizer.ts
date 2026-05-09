import { createUnchanged, fair } from './iterable';
import type { Line } from './line';
import { UNIMPORTANT_LINE_CHAR_COUNT } from './smartCorrector';
import { expandBackward, expandForward } from './trimUtil';
import type { FairDiffIterable, Range } from './types';

type Side = 'left' | 'right';

export function optimizeLineChunks(
  lines1: readonly Line[],
  lines2: readonly Line[],
  iterable: FairDiffIterable
): FairDiffIterable {
  return new LineChunkOptimizer(lines1, lines2, iterable).build();
}

abstract class ChunkOptimizer<T> {
  private readonly ranges: Range[] = [];

  constructor(
    protected readonly data1: readonly T[],
    protected readonly data2: readonly T[],
    private readonly iterable: FairDiffIterable,
    private readonly equals: (left: T, right: T) => boolean
  ) {}

  build(): FairDiffIterable {
    for (const range of this.iterable.unchanged()) {
      this.ranges.push({ start1: range.start1, end1: range.end1, start2: range.start2, end2: range.end2 });
      this.processLastRanges();
    }

    return fair(createUnchanged(this.ranges, this.data1.length, this.data2.length));
  }

  private processLastRanges(): void {
    if (this.ranges.length < 2) return;

    const range1 = this.ranges[this.ranges.length - 2];
    const range2 = this.ranges[this.ranges.length - 1];
    if (range1.end1 !== range2.start1 && range1.end2 !== range2.start2) return;

    const count1 = range1.end1 - range1.start1;
    const count2 = range2.end1 - range2.start1;

    const equalForward = expandForward(this.data1, this.data2, range1.end1, range1.end2, range1.end1 + count2, range1.end2 + count2, this.equals);
    const equalBackward = expandBackward(this.data1, this.data2, range2.start1 - count1, range2.start2 - count1, range2.start1, range2.start2, this.equals);

    if (equalForward === 0 && equalBackward === 0) return;

    if (equalForward === count2) {
      this.ranges.splice(this.ranges.length - 2, 2, {
        start1: range1.start1,
        end1: range1.end1 + count2,
        start2: range1.start2,
        end2: range1.end2 + count2
      });
      this.processLastRanges();
      return;
    }

    if (equalBackward === count1) {
      this.ranges.splice(this.ranges.length - 2, 2, {
        start1: range2.start1 - count1,
        end1: range2.end1,
        start2: range2.start2 - count1,
        end2: range2.end2
      });
      this.processLastRanges();
      return;
    }

    const touchSide: Side = range1.end1 === range2.start1 ? 'left' : 'right';
    const shift = this.getShift(touchSide, equalForward, equalBackward, range1, range2);
    if (shift !== 0) {
      this.ranges.splice(
        this.ranges.length - 2,
        2,
        { start1: range1.start1, end1: range1.end1 + shift, start2: range1.start2, end2: range1.end2 + shift },
        { start1: range2.start1 + shift, end1: range2.end1, start2: range2.start2 + shift, end2: range2.end2 }
      );
    }
  }

  protected abstract getShift(touchSide: Side, equalForward: number, equalBackward: number, range1: Range, range2: Range): number;
}

class LineChunkOptimizer extends ChunkOptimizer<Line> {
  constructor(lines1: readonly Line[], lines2: readonly Line[], iterable: FairDiffIterable) {
    super(lines1, lines2, iterable, (left, right) => left.equals(right));
  }

  protected getShift(touchSide: Side, equalForward: number, equalBackward: number, range1: Range, range2: Range): number {
    let shift = this.getUnchangedBoundaryShift(touchSide, equalForward, equalBackward, range1, range2, 0);
    if (shift !== null) return shift;

    shift = this.getChangedBoundaryShift(touchSide, equalForward, equalBackward, range1, range2, 0);
    if (shift !== null) return shift;

    shift = this.getUnchangedBoundaryShift(touchSide, equalForward, equalBackward, range1, range2, UNIMPORTANT_LINE_CHAR_COUNT);
    if (shift !== null) return shift;

    shift = this.getChangedBoundaryShift(touchSide, equalForward, equalBackward, range1, range2, UNIMPORTANT_LINE_CHAR_COUNT);
    if (shift !== null) return shift;

    return 0;
  }

  private getUnchangedBoundaryShift(
    touchSide: Side,
    equalForward: number,
    equalBackward: number,
    range1: Range,
    range2: Range,
    threshold: number
  ): number | null {
    const touchLines = this.selectData(touchSide);
    const touchStart = this.selectRange(touchSide, range2.start1, range2.start2);

    const shiftForward = findNextUnimportantLine(touchLines, touchStart, equalForward + 1, threshold);
    const shiftBackward = findPrevUnimportantLine(touchLines, touchStart - 1, equalBackward + 1, threshold);
    return chooseShift(shiftForward, shiftBackward);
  }

  private getChangedBoundaryShift(
    touchSide: Side,
    equalForward: number,
    equalBackward: number,
    range1: Range,
    range2: Range,
    threshold: number
  ): number | null {
    const nonTouchSide = otherSide(touchSide);
    const nonTouchLines = this.selectData(nonTouchSide);
    const changeStart = this.selectRange(nonTouchSide, range1.end1, range1.end2);
    const changeEnd = this.selectRange(nonTouchSide, range2.start1, range2.start2);

    const shiftForward = findNextUnimportantLine(nonTouchLines, changeStart, equalForward + 1, threshold);
    const shiftBackward = findPrevUnimportantLine(nonTouchLines, changeEnd - 1, equalBackward + 1, threshold);
    return chooseShift(shiftForward, shiftBackward);
  }

  private selectData(side: Side): readonly Line[] {
    return side === 'left' ? this.data1 : this.data2;
  }

  private selectRange(side: Side, left: number, right: number): number {
    return side === 'left' ? left : right;
  }
}

function otherSide(side: Side): Side {
  return side === 'left' ? 'right' : 'left';
}

function findNextUnimportantLine(lines: readonly Line[], offset: number, count: number, threshold: number): number {
  for (let i = 0; i < count; i++) {
    const line = lines[offset + i];
    if (!line) return -1;
    if (line.nonSpaceChars <= threshold) return i;
  }
  return -1;
}

function findPrevUnimportantLine(lines: readonly Line[], offset: number, count: number, threshold: number): number {
  for (let i = 0; i < count; i++) {
    const line = lines[offset - i];
    if (!line) return -1;
    if (line.nonSpaceChars <= threshold) return i;
  }
  return -1;
}

function chooseShift(shiftForward: number, shiftBackward: number): number | null {
  if (shiftForward === -1 && shiftBackward === -1) return null;
  if (shiftForward === 0 || shiftBackward === 0) return 0;
  return shiftForward !== -1 ? shiftForward : -shiftBackward;
}
