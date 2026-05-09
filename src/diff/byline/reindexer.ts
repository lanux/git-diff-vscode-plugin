import { BitSet } from './bitSet';
import type { LCSBuilder } from './types';

export class Reindexer {
  private readonly oldIndices: [number[] | null, number[] | null] = [null, null];
  private readonly originalLengths: [number, number] = [-1, -1];
  private readonly discardedLengths: [number, number] = [-1, -1];

  discardUnique(ints1: readonly number[], ints2: readonly number[]): [number[], number[]] {
    const discarded1 = this.discard(ints2, ints1, 0);
    return [discarded1, this.discard(discarded1, ints2, 1)];
  }

  idInit(length1: number, length2: number): void {
    this.originalLengths[0] = length1;
    this.originalLengths[1] = length2;
    this.discardedLengths[0] = length1;
    this.discardedLengths[1] = length2;
    this.oldIndices[0] = Array.from({ length: length1 }, (_, i) => i);
    this.oldIndices[1] = Array.from({ length: length2 }, (_, i) => i);
  }

  restoreIndex(index: number, array: 0 | 1): number {
    const indices = this.oldIndices[array];
    if (!indices) throw new Error(`Reindexer array ${array} is not initialized`);
    return indices[index];
  }

  reindex(discardedChanges: readonly [BitSet, BitSet], builder: LCSBuilder): void {
    let changes1: BitSet;
    let changes2: BitSet;

    if (
      this.discardedLengths[0] === this.originalLengths[0]
      && this.discardedLengths[1] === this.originalLengths[1]
    ) {
      changes1 = discardedChanges[0];
      changes2 = discardedChanges[1];
    } else {
      changes1 = new BitSet(this.originalLengths[0]);
      changes2 = new BitSet(this.originalLengths[1]);
      const old1 = this.requireOldIndices(0);
      const old2 = this.requireOldIndices(1);
      let x = 0;
      let y = 0;

      while (x < this.discardedLengths[0] || y < this.discardedLengths[1]) {
        if (
          x < this.discardedLengths[0]
          && y < this.discardedLengths[1]
          && !discardedChanges[0].get(x)
          && !discardedChanges[1].get(y)
        ) {
          x = Reindexer.increment(old1, x, changes1, this.originalLengths[0]);
          y = Reindexer.increment(old2, y, changes2, this.originalLengths[1]);
        } else if (discardedChanges[0].get(x)) {
          changes1.set(Reindexer.getOriginal(old1, x), true);
          x = Reindexer.increment(old1, x, changes1, this.originalLengths[0]);
        } else if (discardedChanges[1].get(y)) {
          changes2.set(Reindexer.getOriginal(old2, y), true);
          y = Reindexer.increment(old2, y, changes2, this.originalLengths[1]);
        } else {
          throw new Error('Invalid discarded LCS changes: unmatched unchanged item');
        }
      }

      if (this.discardedLengths[0] === 0) {
        changes1.set(0, this.originalLengths[0]);
      } else {
        changes1.set(0, old1[0]);
      }
      if (this.discardedLengths[1] === 0) {
        changes2.set(0, this.originalLengths[1]);
      } else {
        changes2.set(0, old2[0]);
      }
    }

    let x = 0;
    let y = 0;
    while (x < this.originalLengths[0] && y < this.originalLengths[1]) {
      const startX = x;
      while (
        x < this.originalLengths[0]
        && y < this.originalLengths[1]
        && !changes1.get(x)
        && !changes2.get(y)
      ) {
        x++;
        y++;
      }
      if (x > startX) builder.addEqual(x - startX);

      let dx = 0;
      let dy = 0;
      while (x < this.originalLengths[0] && changes1.get(x)) {
        dx++;
        x++;
      }
      while (y < this.originalLengths[1] && changes2.get(y)) {
        dy++;
        y++;
      }
      if (dx !== 0 || dy !== 0) builder.addChange(dx, dy);
    }

    if (x !== this.originalLengths[0] || y !== this.originalLengths[1]) {
      builder.addChange(this.originalLengths[0] - x, this.originalLengths[1] - y);
    }
  }

  private discard(needed: readonly number[], toDiscard: readonly number[], arrayIndex: 0 | 1): number[] {
    this.originalLengths[arrayIndex] = toDiscard.length;

    const sorted = Reindexer.createSorted(needed);
    const discarded: number[] = [];
    const oldIndices: number[] = [];

    for (let i = 0; i < toDiscard.length; i++) {
      const value = toDiscard[i];
      if (Reindexer.binarySearch(sorted, value) >= 0) {
        discarded.push(value);
        oldIndices.push(i);
      }
    }

    this.oldIndices[arrayIndex] = oldIndices;
    this.discardedLengths[arrayIndex] = discarded.length;
    return discarded;
  }

  private requireOldIndices(arrayIndex: 0 | 1): number[] {
    const indices = this.oldIndices[arrayIndex];
    if (!indices) throw new Error(`Reindexer array ${arrayIndex} is not initialized`);
    return indices;
  }

  private static createSorted(values: readonly number[]): number[] {
    return [...values].sort((a, b) => a - b);
  }

  private static getOriginal(indices: readonly number[], i: number): number {
    return indices[i];
  }

  private static increment(indices: readonly number[], i: number, set: BitSet, length: number): number {
    if (i + 1 < indices.length) {
      set.set(indices[i] + 1, indices[i + 1]);
    } else {
      set.set(indices[i] + 1, length);
    }
    return i + 1;
  }

  private static binarySearch(values: readonly number[], target: number): number {
    let left = 0;
    let right = values.length - 1;

    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      const value = values[middle];
      if (value < target) left = middle + 1;
      else if (value > target) right = middle - 1;
      else return middle;
    }

    return -(left + 1);
  }
}
