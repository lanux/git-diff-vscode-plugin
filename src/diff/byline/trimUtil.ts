import type { Range } from './types';

export function isEmptyRange(range: Range): boolean {
  return range.start1 === range.end1 && range.start2 === range.end2;
}

export function expandRange<T>(
  objects1: readonly T[],
  objects2: readonly T[],
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (a: T, b: T) => boolean = Object.is
): Range {
  let s1 = start1;
  let s2 = start2;
  let e1 = end1;
  let e2 = end2;

  while (s1 < e1 && s2 < e2 && equals(objects1[s1], objects2[s2])) {
    s1++;
    s2++;
  }
  while (s1 < e1 && s2 < e2 && equals(objects1[e1 - 1], objects2[e2 - 1])) {
    e1--;
    e2--;
  }

  return { start1: s1, end1: e1, start2: s2, end2: e2 };
}

export function expandForward<T>(
  objects1: readonly T[],
  objects2: readonly T[],
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (a: T, b: T) => boolean = Object.is
): number {
  let count = 0;
  while (
    start1 + count < end1
    && start2 + count < end2
    && equals(objects1[start1 + count], objects2[start2 + count])
  ) {
    count++;
  }
  return count;
}

export function expandBackward<T>(
  objects1: readonly T[],
  objects2: readonly T[],
  start1: number,
  start2: number,
  end1: number,
  end2: number,
  equals: (a: T, b: T) => boolean = Object.is
): number {
  let count = 0;
  while (
    end1 - count > start1
    && end2 - count > start2
    && equals(objects1[end1 - count - 1], objects2[end2 - count - 1])
  ) {
    count++;
  }
  return count;
}
