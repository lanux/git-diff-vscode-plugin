import { BitSet } from './bitSet';
import { Enumerator } from './enumerator';
import { Reindexer } from './reindexer';
import type { Change, LCSBuilder, Range } from './types';

export type LcsChangeComputer = (ints1: readonly number[], ints2: readonly number[]) => readonly [BitSet, BitSet];

export interface BuildChangesOptions<T, K = T> {
  equals?: (left: T, right: T) => boolean;
  keyOf?: (value: T) => K;
}

export class ChangeBuilder implements LCSBuilder {
  private index1 = 0;
  private index2 = 0;
  private _firstChange: Change | null = null;
  private lastChange: Change | null = null;

  constructor(startShift = 0) {
    this.skip(startShift, startShift);
  }

  get firstChange(): Change | null {
    return this._firstChange;
  }

  addChange(deleted: number, inserted: number): void {
    const change = { line0: this.index1, line1: this.index2, deleted, inserted, link: null };
    if (this.lastChange) {
      this.lastChange.link = change;
    } else {
      this._firstChange = change;
    }
    this.lastChange = change;
    this.skip(deleted, inserted);
  }

  addEqual(count: number): void {
    this.skip(count, count);
  }

  private skip(first: number, second: number): void {
    this.index1 += first;
    this.index2 += second;
  }
}

export function buildChangesFromObjects<T, K = T>(
  objects1: readonly T[],
  objects2: readonly T[],
  computeLcsChanges: LcsChangeComputer,
  options: BuildChangesOptions<T, K> = {}
): Change | null {
  const equals = options.equals ?? objectIs;
  const startShift = getStartShift(objects1, objects2, equals);
  const endCut = getEndCut(objects1, objects2, startShift, equals);

  const fastChange = doBuildChangesFast(objects1.length, objects2.length, startShift, endCut);
  if (fastChange !== undefined) return fastChange;

  const enumerator = new Enumerator<T, K>(options.keyOf);
  const ints1 = enumerator.enumerate(objects1, startShift, endCut);
  const ints2 = enumerator.enumerate(objects2, startShift, endCut);
  return doBuildChanges(ints1, ints2, new ChangeBuilder(startShift), computeLcsChanges);
}

export function buildChangesFromIntArrays(
  array1: readonly number[],
  array2: readonly number[],
  computeLcsChanges: LcsChangeComputer
): Change | null {
  const startShift = getStartShift(array1, array2, numberEquals);
  const endCut = getEndCut(array1, array2, startShift, numberEquals);

  const fastChange = doBuildChangesFast(array1.length, array2.length, startShift, endCut);
  if (fastChange !== undefined) return fastChange;

  const copyArray = startShift !== 0 || endCut !== 0;
  const ints1 = copyArray ? array1.slice(startShift, array1.length - endCut) : array1;
  const ints2 = copyArray ? array2.slice(startShift, array2.length - endCut) : array2;
  return doBuildChanges(ints1, ints2, new ChangeBuilder(startShift), computeLcsChanges);
}

export function doBuildChanges(
  ints1: readonly number[],
  ints2: readonly number[],
  builder: ChangeBuilder,
  computeLcsChanges: LcsChangeComputer
): Change | null {
  const reindexer = new Reindexer();
  const discarded = reindexer.discardUnique(ints1, ints2);

  if (discarded[0].length === 0 && discarded[1].length === 0) {
    builder.addChange(ints1.length, ints2.length);
    return builder.firstChange;
  }

  const changes = computeLcsChanges(discarded[0], discarded[1]);
  reindexer.reindex(changes, builder);
  return builder.firstChange;
}

export function changesToRanges(change: Change | null): Range[] {
  const ranges: Range[] = [];
  let current = change;
  while (current) {
    ranges.push({
      start1: current.line0,
      end1: current.line0 + current.deleted,
      start2: current.line1,
      end2: current.line1 + current.inserted
    });
    current = current.link;
  }
  return ranges;
}

function doBuildChangesFast(length1: number, length2: number, startShift: number, endCut: number): Change | null | undefined {
  const trimmedLength1 = length1 - startShift - endCut;
  const trimmedLength2 = length2 - startShift - endCut;
  if (trimmedLength1 !== 0 && trimmedLength2 !== 0) return undefined;
  if (trimmedLength1 !== 0 || trimmedLength2 !== 0) {
    return { line0: startShift, line1: startShift, deleted: trimmedLength1, inserted: trimmedLength2, link: null };
  }
  return null;
}

function getStartShift<T>(left: readonly T[], right: readonly T[], equals: (a: T, b: T) => boolean): number {
  const size = Math.min(left.length, right.length);
  let index = 0;
  for (let i = 0; i < size; i++) {
    if (!equals(left[i], right[i])) break;
    index++;
  }
  return index;
}

function getEndCut<T>(left: readonly T[], right: readonly T[], startShift: number, equals: (a: T, b: T) => boolean): number {
  const size = Math.min(left.length, right.length) - startShift;
  let index = 0;
  for (let i = 0; i < size; i++) {
    if (!equals(left[left.length - i - 1], right[right.length - i - 1])) break;
    index++;
  }
  return index;
}

function objectIs<T>(left: T, right: T): boolean {
  return Object.is(left, right);
}

function numberEquals(left: number, right: number): boolean {
  return left === right;
}
