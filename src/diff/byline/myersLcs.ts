import { BitSet } from './bitSet';
import { FilesTooBigForDiffError } from './types';

export const DELTA_THRESHOLD_SIZE = 20_000;

export function defaultMyersThreshold(length1: number, length2: number): number {
  return Math.max(20_000 + (10 * Math.trunc(Math.sqrt(length1 + length2))), DELTA_THRESHOLD_SIZE);
}

export function linearMyersThreshold(length1: number, length2: number): number {
  return 20_000 + (10 * Math.trunc(Math.sqrt(length1 + length2)));
}

export function computeMyersLcsChanges(
  ints1: readonly number[],
  ints2: readonly number[],
  threshold = defaultMyersThreshold(ints1.length, ints2.length)
): readonly [BitSet, BitSet] {
  const lcs = new MyersLCS(ints1, ints2);
  lcs.executeWithThreshold(threshold);
  return lcs.changes;
}

export function computeMyersLcsChangesLinear(
  ints1: readonly number[],
  ints2: readonly number[]
): readonly [BitSet, BitSet] {
  const lcs = new MyersLCS(ints1, ints2);
  lcs.executeLinear();
  return lcs.changes;
}

export class MyersLCS {
  private readonly changes1: BitSet;
  private readonly changes2: BitSet;
  private readonly vForward: Int32Array;
  private readonly vBackward: Int32Array;

  constructor(
    private readonly first: readonly number[],
    private readonly second: readonly number[],
    private readonly start1 = 0,
    private readonly count1 = first.length,
    private readonly start2 = 0,
    private readonly count2 = second.length,
    changes1?: BitSet,
    changes2?: BitSet
  ) {
    this.changes1 = changes1 ?? new BitSet(first.length);
    this.changes2 = changes2 ?? new BitSet(second.length);
    this.changes1.set(this.start1, this.start1 + this.count1);
    this.changes2.set(this.start2, this.start2 + this.count2);

    const totalSequenceLength = this.count1 + this.count2;
    this.vForward = new Int32Array(totalSequenceLength + 1);
    this.vBackward = new Int32Array(totalSequenceLength + 1);
  }

  get changes(): readonly [BitSet, BitSet] {
    return [this.changes1, this.changes2];
  }

  executeLinear(): void {
    const threshold = linearMyersThreshold(this.count1, this.count2);
    this.executeWithEstimate(threshold, false);
  }

  execute(): void {
    this.executeWithEstimate(this.count1 + this.count2, false);
  }

  executeWithThreshold(threshold = defaultMyersThreshold(this.count1, this.count2)): void {
    this.executeWithEstimate(threshold, true);
  }

  private executeWithEstimate(threshold: number, throwException: boolean): void {
    if (this.count1 === 0 || this.count2 === 0) return;
    this.executeRange(0, this.count1, 0, this.count2, Math.min(threshold, this.count1 + this.count2), throwException);
  }

  private executeRange(
    oldStart: number,
    oldEnd: number,
    newStart: number,
    newEnd: number,
    differenceEstimate: number,
    throwException: boolean
  ): void {
    if (oldStart > oldEnd || newStart > newEnd) throw new RangeError('Invalid Myers range');
    if (oldStart >= oldEnd || newStart >= newEnd) return;

    const oldLength = oldEnd - oldStart;
    const newLength = newEnd - newStart;
    this.vForward[newLength + 1] = 0;
    this.vBackward[newLength + 1] = 0;

    const halfD = Math.floor((differenceEstimate + 1) / 2);
    let xx = -1;
    let kk = -1;
    let td = -1;

    outer:
    for (let d = 0; d <= halfD; d++) {
      const left = newLength + Math.max(-d, -newLength + ((d ^ newLength) & 1));
      const right = newLength + Math.min(d, oldLength - ((d ^ oldLength) & 1));

      for (let k = left; k <= right; k += 2) {
        let x = k === left || (k !== right && this.vForward[k - 1] < this.vForward[k + 1])
          ? this.vForward[k + 1]
          : this.vForward[k - 1] + 1;
        const y = x - k + newLength;
        x += this.commonSubsequenceLengthForward(
          oldStart + x,
          newStart + y,
          Math.min(oldEnd - oldStart - x, newEnd - newStart - y)
        );
        this.vForward[k] = x;
      }

      if ((oldLength - newLength) % 2 !== 0) {
        for (let k = left; k <= right; k += 2) {
          if (oldLength - (d - 1) <= k && k <= oldLength + (d - 1)) {
            if (this.vForward[k] + this.vBackward[newLength + oldLength - k] >= oldLength) {
              xx = this.vForward[k];
              kk = k;
              td = (2 * d) - 1;
              break outer;
            }
          }
        }
      }

      for (let k = left; k <= right; k += 2) {
        let x = k === left || (k !== right && this.vBackward[k - 1] < this.vBackward[k + 1])
          ? this.vBackward[k + 1]
          : this.vBackward[k - 1] + 1;
        const y = x - k + newLength;
        x += this.commonSubsequenceLengthBackward(
          oldEnd - 1 - x,
          newEnd - 1 - y,
          Math.min(oldEnd - oldStart - x, newEnd - newStart - y)
        );
        this.vBackward[k] = x;
      }

      if ((oldLength - newLength) % 2 === 0) {
        for (let k = left; k <= right; k += 2) {
          if (oldLength - d <= k && k <= oldLength + d) {
            if (this.vForward[oldLength + newLength - k] + this.vBackward[k] >= oldLength) {
              xx = oldLength - this.vBackward[k];
              kk = oldLength + newLength - k;
              td = 2 * d;
              break outer;
            }
          }
        }
      }
    }

    if (td > 1) {
      const yy = xx - kk + newLength;
      const oldDiff = Math.floor((td + 1) / 2);
      if (0 < xx && 0 < yy) {
        this.executeRange(oldStart, oldStart + xx, newStart, newStart + yy, oldDiff, throwException);
      }
      if (oldStart + xx < oldEnd && newStart + yy < newEnd) {
        this.executeRange(oldStart + xx, oldEnd, newStart + yy, newEnd, td - oldDiff, throwException);
      }
    } else if (td >= 0) {
      let x = oldStart;
      let y = newStart;
      while (x < oldEnd && y < newEnd) {
        const commonLength = this.commonSubsequenceLengthForward(x, y, Math.min(oldEnd - x, newEnd - y));
        if (commonLength > 0) {
          this.addUnchanged(x, y, commonLength);
          x += commonLength;
          y += commonLength;
        } else if (oldEnd - oldStart > newEnd - newStart) {
          x++;
        } else {
          y++;
        }
      }
    } else if (throwException) {
      throw new FilesTooBigForDiffError();
    }
  }

  private addUnchanged(start1: number, start2: number, count: number): void {
    this.changes1.set(this.start1 + start1, this.start1 + start1 + count, false);
    this.changes2.set(this.start2 + start2, this.start2 + start2 + count, false);
  }

  private commonSubsequenceLengthForward(oldIndex: number, newIndex: number, maxLength: number): number {
    let length = Math.min(maxLength, Math.min(this.count1 - oldIndex, this.count2 - newIndex));
    let x = oldIndex;
    let y = newIndex;

    while (x - oldIndex < length && this.first[this.start1 + x] === this.second[this.start2 + y]) {
      x++;
      y++;
    }
    return x - oldIndex;
  }

  private commonSubsequenceLengthBackward(oldIndex: number, newIndex: number, maxLength: number): number {
    let length = Math.min(maxLength, Math.min(oldIndex, newIndex) + 1);
    let x = oldIndex;
    let y = newIndex;

    while (oldIndex - x < length && this.first[this.start1 + x] === this.second[this.start2 + y]) {
      x--;
      y--;
    }
    return oldIndex - x;
  }
}
