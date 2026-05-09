import type { DiffIterable, FairDiffIterable, Range } from './types';
import { expandRange, isEmptyRange } from './trimUtil';

class RangeDiffIterable implements DiffIterable {
  constructor(
    private readonly ranges: Range[],
    public readonly length1: number,
    public readonly length2: number
  ) {
    verifyRanges(ranges, length1, length2);
  }

  *changes(): Iterable<Range> {
    yield* this.ranges;
  }

  *unchanged(): Iterable<Range> {
    let last1 = 0;
    let last2 = 0;
    for (const change of this.ranges) {
      const unchanged = { start1: last1, end1: change.start1, start2: last2, end2: change.start2 };
      if (!isEmptyRange(unchanged)) yield unchanged;
      last1 = change.end1;
      last2 = change.end2;
    }
    const tail = { start1: last1, end1: this.length1, start2: last2, end2: this.length2 };
    if (!isEmptyRange(tail)) yield tail;
  }
}

export function create(changes: readonly Range[], length1: number, length2: number): DiffIterable {
  return new RangeDiffIterable(changes.map(cloneRange), length1, length2);
}

export function createUnchanged(unchanged: readonly Range[], length1: number, length2: number): DiffIterable {
  const changes: Range[] = [];
  let last1 = 0;
  let last2 = 0;
  for (const equal of unchanged) {
    const change = { start1: last1, end1: equal.start1, start2: last2, end2: equal.start2 };
    if (!isEmptyRange(change)) changes.push(change);
    last1 = equal.end1;
    last2 = equal.end2;
  }
  const tail = { start1: last1, end1: length1, start2: last2, end2: length2 };
  if (!isEmptyRange(tail)) changes.push(tail);
  return create(changes, length1, length2);
}

export function fair(iterable: DiffIterable): FairDiffIterable {
  verifyFair(iterable);
  return iterable as FairDiffIterable;
}

export function verifyFair(iterable: DiffIterable): void {
  verifyRanges(Array.from(iterable.changes()), iterable.length1, iterable.length2);
  verifyRanges(Array.from(iterable.unchanged()), iterable.length1, iterable.length2);
  for (const range of iterable.unchanged()) {
    if (range.end1 - range.start1 !== range.end2 - range.start2) {
      throw new Error(`Unfair unchanged range: ${JSON.stringify(range)}`);
    }
  }
}

abstract class ChangeBuilderBase {
  private _index1 = 0;
  private _index2 = 0;

  constructor(public readonly length1: number, public readonly length2: number) {}

  get index1(): number { return this._index1; }
  get index2(): number { return this._index2; }

  markEqual(index1: number, index2: number, count?: number): void;
  markEqual(index1: number, index2: number, end1: number, end2: number): void;
  markEqual(index1: number, index2: number, end1OrCount = 1, end2?: number): void {
    const end1 = end2 === undefined ? index1 + end1OrCount : end1OrCount;
    const finalEnd2 = end2 === undefined ? index2 + end1OrCount : end2;
    if (index1 === end1 && index2 === finalEnd2) return;
    if (this._index1 > index1 || this._index2 > index2 || index1 > end1 || index2 > finalEnd2) {
      throw new Error(`Invalid markEqual(${index1}, ${index2}, ${end1}, ${finalEnd2})`);
    }
    if (this._index1 !== index1 || this._index2 !== index2) {
      this.addChange(this._index1, this._index2, index1, index2);
    }
    this._index1 = end1;
    this._index2 = finalEnd2;
  }

  protected doFinish(): void {
    if (this._index1 > this.length1 || this._index2 > this.length2) {
      throw new Error('ChangeBuilder index exceeds iterable length');
    }
    if (this.length1 !== this._index1 || this.length2 !== this._index2) {
      this.addChange(this._index1, this._index2, this.length1, this.length2);
      this._index1 = this.length1;
      this._index2 = this.length2;
    }
  }

  protected abstract addChange(start1: number, start2: number, end1: number, end2: number): void;
}

export class ChangeBuilder extends ChangeBuilderBase {
  protected readonly changes: Range[] = [];

  protected addChange(start1: number, start2: number, end1: number, end2: number): void {
    const range = { start1, end1, start2, end2 };
    if (!isEmptyRange(range)) this.changes.push(range);
  }

  finish(): DiffIterable {
    this.doFinish();
    return create(this.changes, this.length1, this.length2);
  }
}

export class ExpandChangeBuilder<T> extends ChangeBuilder {
  constructor(
    private readonly objects1: readonly T[],
    private readonly objects2: readonly T[],
    private readonly equals: (a: T, b: T) => boolean = Object.is
  ) {
    super(objects1.length, objects2.length);
  }

  protected override addChange(start1: number, start2: number, end1: number, end2: number): void {
    const range = expandRange(this.objects1, this.objects2, start1, start2, end1, end2, this.equals);
    if (!isEmptyRange(range)) super.addChange(range.start1, range.start2, range.end1, range.end2);
  }
}

function verifyRanges(ranges: readonly Range[], length1: number, length2: number): void {
  let last1 = 0;
  let last2 = 0;
  for (const range of ranges) {
    if (
      range.start1 < last1 || range.start2 < last2
      || range.start1 > range.end1 || range.start2 > range.end2
      || range.end1 > length1 || range.end2 > length2
      || isEmptyRange(range)
    ) {
      throw new Error(`Invalid range ${JSON.stringify(range)} for lengths ${length1}/${length2}`);
    }
    last1 = range.end1;
    last2 = range.end2;
  }
}

function cloneRange(range: Range): Range {
  return { start1: range.start1, end1: range.end1, start2: range.start2, end2: range.end2 };
}
