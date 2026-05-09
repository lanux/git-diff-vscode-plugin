import type { FairDiffIterable, MergeRange, Range } from './types';

export type SideEquality = (leftIndex: number, baseIndex: number, rightIndex: number) => boolean;

export function buildSimpleMerge(fragments1: FairDiffIterable, fragments2: FairDiffIterable): MergeRange[] {
  if (fragments1.length1 !== fragments2.length1) throw new Error('BASE length mismatch');
  return new FairMergeBuilder().execute(fragments1, fragments2);
}

export function buildMerge(
  fragments1: FairDiffIterable,
  fragments2: FairDiffIterable,
  trueEquality: SideEquality
): MergeRange[] {
  if (fragments1.length1 !== fragments2.length1) throw new Error('BASE length mismatch');
  return new FairMergeBuilder(trueEquality).execute(fragments1, fragments2);
}

class FairMergeBuilder {
  private readonly changesBuilder: MergeChangeBuilder;

  constructor(trueEquality?: SideEquality) {
    this.changesBuilder = trueEquality ? new IgnoringChangeBuilder(trueEquality) : new MergeChangeBuilder();
  }

  execute(fragments1: FairDiffIterable, fragments2: FairDiffIterable): MergeRange[] {
    const unchanged1 = peekable(fragments1.unchanged()[Symbol.iterator]());
    const unchanged2 = peekable(fragments2.unchanged()[Symbol.iterator]());

    while (unchanged1.hasNext() && unchanged2.hasNext()) {
      const side = this.add(unchanged1.peek(), unchanged2.peek());
      if (side === 'left') unchanged1.next();
      else unchanged2.next();
    }

    return this.changesBuilder.finish(fragments1.length2, fragments1.length1, fragments2.length2);
  }

  private add(range1: Range, range2: Range): 'left' | 'right' {
    const start1 = range1.start1;
    const end1 = range1.end1;
    const start2 = range2.start1;
    const end2 = range2.end1;

    if (end1 <= start2) return 'left';
    if (end2 <= start1) return 'right';

    const startBase = Math.max(start1, start2);
    const endBase = Math.min(end1, end2);
    const count = endBase - startBase;
    const startShift1 = startBase - start1;
    const startShift2 = startBase - start2;

    const startLeft = range1.start2 + startShift1;
    const endLeft = startLeft + count;
    const startRight = range2.start2 + startShift2;
    const endRight = startRight + count;

    this.changesBuilder.markEqual(startLeft, startBase, startRight, endLeft, endBase, endRight);
    return end1 <= end2 ? 'left' : 'right';
  }
}

class MergeChangeBuilder {
  protected readonly changes: MergeRange[] = [];
  private index1 = 0;
  private index2 = 0;
  private index3 = 0;

  markEqual(start1: number, start2: number, start3: number, end1: number, end2: number, end3: number): void {
    if (
      this.index1 > start1 || this.index2 > start2 || this.index3 > start3
      || start1 > end1 || start2 > end2 || start3 > end3
    ) {
      throw new Error(`Invalid merge markEqual(${start1}, ${start2}, ${start3}, ${end1}, ${end2}, ${end3})`);
    }

    this.processChange(this.index1, this.index2, this.index3, start1, start2, start3);
    this.index1 = end1;
    this.index2 = end2;
    this.index3 = end3;
  }

  finish(length1: number, length2: number, length3: number): MergeRange[] {
    if (this.index1 > length1 || this.index2 > length2 || this.index3 > length3) {
      throw new Error('MergeChangeBuilder index exceeds length');
    }

    this.processChange(this.index1, this.index2, this.index3, length1, length2, length3);
    return this.changes;
  }

  protected processChange(start1: number, start2: number, start3: number, end1: number, end2: number, end3: number): void {
    this.addChange(start1, start2, start3, end1, end2, end3);
  }

  protected addChange(start1: number, start2: number, start3: number, end1: number, end2: number, end3: number): void {
    if (start1 === end1 && start2 === end2 && start3 === end3) return;
    this.changes.push({ start1, end1, start2, end2, start3, end3 });
  }
}

class IgnoringChangeBuilder extends MergeChangeBuilder {
  constructor(private readonly trueEquality: SideEquality) {
    super();
  }

  protected override processChange(start1: number, start2: number, start3: number, end1: number, end2: number, end3: number): void {
    const lastChange = this.changes.length === 0 ? null : this.changes[this.changes.length - 1];
    const unchangedStart1 = lastChange?.end1 ?? 0;
    const unchangedStart2 = lastChange?.end2 ?? 0;
    const unchangedStart3 = lastChange?.end3 ?? 0;
    this.addIgnoredChanges(unchangedStart1, unchangedStart2, unchangedStart3, start1, start2, start3);

    this.addChange(start1, start2, start3, end1, end2, end3);
  }

  private addIgnoredChanges(start1: number, start2: number, start3: number, end1: number, end2: number, end3: number): void {
    const count = end2 - start2;
    if (end1 - start1 !== count || end3 - start3 !== count) {
      throw new Error('Ignored merge range must have equal side lengths');
    }

    let firstIgnoredCount = -1;
    for (let i = 0; i < count; i++) {
      const isIgnored = !this.trueEquality(start1 + i, start2 + i, start3 + i);
      const previousAreIgnored = firstIgnoredCount !== -1;

      if (isIgnored && !previousAreIgnored) {
        firstIgnoredCount = i;
      }
      if (!isIgnored && previousAreIgnored) {
        this.addChange(
          start1 + firstIgnoredCount,
          start2 + firstIgnoredCount,
          start3 + firstIgnoredCount,
          start1 + i,
          start2 + i,
          start3 + i
        );
        firstIgnoredCount = -1;
      }
    }

    if (firstIgnoredCount !== -1) {
      this.addChange(
        start1 + firstIgnoredCount,
        start2 + firstIgnoredCount,
        start3 + firstIgnoredCount,
        start1 + count,
        start2 + count,
        start3 + count
      );
    }
  }
}

interface Peekable<T> {
  hasNext(): boolean;
  peek(): T;
  next(): T;
}

function peekable<T>(iterator: Iterator<T>): Peekable<T> {
  let cached: T | undefined;
  let has = false;
  const pull = () => {
    if (has) return;
    const result = iterator.next();
    if (!result.done) {
      cached = result.value;
      has = true;
    }
  };
  return {
    hasNext() {
      pull();
      return has;
    },
    peek() {
      pull();
      return cached as T;
    },
    next() {
      pull();
      has = false;
      return cached as T;
    }
  };
}
