// IntelliJ ByLine public facade.
// Current core path: policy-aware Line objects -> Diff.buildChanges
// -> Myers threshold + Patience fallback (or patience-first when requested)
// -> FairDiffIterable
// -> ComparisonMergeUtil.buildSimple equivalent.
//
// Full IntelliJ parity still depends on keeping the surrounding merge model
// behavior aligned with MergeConflictModel/MergeModelBase.

import { correctChangesSecondStep } from './byline/correctSecondStep';
import { create as createDiffIterable, fair as makeFair } from './byline/iterable';
import { buildLines } from './byline/line';
import { optimizeLineChunks } from './byline/lineChunkOptimizer';
import { buildMerge, buildSimpleMerge as buildSimpleMergeImpl } from './byline/mergeUtil';
import { USE_PATIENCE_ALG } from './byline/patienceLcs';
import { linesEqual, toInternalPolicy } from './byline/policy';
import { compareSmart } from './byline/smartCorrector';
import type { ComparisonPolicy, FairDiffIterable, InternalComparisonPolicy, MergeRange, Range } from './byline/types';

export type { ComparisonPolicy, FairDiffIterable, MergeRange, Range } from './byline/types';
export { USE_PATIENCE_ALG } from './byline/patienceLcs';

export interface ByLineOptions {
  usePatienceAlg?: boolean;
}

export interface MergeLineBoundary {
  leftStart: number;
  leftEnd: number;
  baseStart: number;
  baseEnd: number;
  rightStart: number;
  rightEnd: number;
}

/**
 * 2-way line diff. Returns Range[] of *changed* regions; unchanged regions
 * are derived from these (FairDiffIterable invariant).
 */
export function compareLines(
  lines1: string[],
  lines2: string[],
  policy: ComparisonPolicy = 'DEFAULT',
  options: ByLineOptions = {}
): FairDiffIterable {
  return compareLines2(lines1, lines2, policy, options);
}

export function compareLines2(
  lines1: string[],
  lines2: string[],
  policy: ComparisonPolicy = 'DEFAULT',
  options: ByLineOptions = {}
): FairDiffIterable {
  const normalizedPolicy = toInternalPolicy(policy);
  const prepared1 = buildLines(lines1, normalizedPolicy);
  const prepared2 = buildLines(lines2, normalizedPolicy);
  const usePatienceAlg = options.usePatienceAlg ?? USE_PATIENCE_ALG;
  if (normalizedPolicy === 'IW') {
    const iterable = optimizeLineChunks(prepared1, prepared2, compareSmart(prepared1, prepared2, undefined, usePatienceAlg));
    return expandRanges(lines1, lines2, iterable, normalizedPolicy);
  }

  const iwLines1 = buildLines(lines1, 'IW');
  const iwLines2 = buildLines(lines2, 'IW');
  const iwChanges = optimizeLineChunks(prepared1, prepared2, compareSmart(iwLines1, iwLines2, undefined, usePatienceAlg));
  return correctChangesSecondStep(prepared1, prepared2, iwChanges);
}

/**
 * Combine two FairDiffIterables (both with BASE in length1) into the
 * IDEA-style MergeRange[] sequence. Mirrors ComparisonMergeUtil.buildSimple.
 *
 * Invariant: it1 = compare(BASE, LEFT), it2 = compare(BASE, RIGHT)
 * Output:    list of MergeRange covering [LEFT, BASE, RIGHT] differences.
 */
export function buildSimpleMerge(it1: FairDiffIterable, it2: FairDiffIterable): MergeRange[] {
  return buildSimpleMergeImpl(it1, it2);
}

/**
 * 3-way merge: returns MergeRange[] describing each region where at least
 * one side differs from BASE. Mirrors ByLine.merge / ByLine.compare(3-way).
 */
export function mergeLines(
  left: string[], base: string[], right: string[],
  policy: ComparisonPolicy = 'DEFAULT',
  options: ByLineOptions = {}
): MergeRange[] {
  return mergeLines3(left, base, right, policy, options);
}

export function compareLines3(
  left: string[], base: string[], right: string[],
  policy: ComparisonPolicy = 'DEFAULT',
  options: ByLineOptions = {}
): MergeRange[] {
  const it1 = compareMergeSide(base, left, policy, options);
  const it2 = compareMergeSide(base, right, policy, options);
  return buildSimpleMergeImpl(it1, it2);
}

export function mergeLines3(
  left: string[], base: string[], right: string[],
  policy: ComparisonPolicy = 'DEFAULT',
  options: ByLineOptions = {}
): MergeRange[] {
  const normalizedPolicy = toInternalPolicy(policy);
  const it1 = compareMergeSide(base, left, policy, options);
  const it2 = compareMergeSide(base, right, policy, options);
  if (normalizedPolicy === 'DEFAULT') return buildSimpleMergeImpl(it1, it2);
  return buildMerge(it1, it2, (index1, index2, index3) =>
    linesEqual(base[index2], left[index1], 'DEFAULT') && linesEqual(base[index2], right[index3], 'DEFAULT')
  );
}

export function mergeLinesWithinRange(
  left: string[],
  base: string[],
  right: string[],
  boundary: MergeLineBoundary,
  policy: ComparisonPolicy = 'DEFAULT',
  options: ByLineOptions = {}
): MergeRange[] {
  validateBoundary(left.length, boundary.leftStart, boundary.leftEnd, 'left');
  validateBoundary(base.length, boundary.baseStart, boundary.baseEnd, 'base');
  validateBoundary(right.length, boundary.rightStart, boundary.rightEnd, 'right');

  const ranges = mergeLines3(
    left.slice(boundary.leftStart, boundary.leftEnd),
    base.slice(boundary.baseStart, boundary.baseEnd),
    right.slice(boundary.rightStart, boundary.rightEnd),
    policy,
    options
  );

  return ranges.map((range) => ({
    start1: range.start1 + boundary.leftStart,
    end1: range.end1 + boundary.leftStart,
    start2: range.start2 + boundary.baseStart,
    end2: range.end2 + boundary.baseStart,
    start3: range.start3 + boundary.rightStart,
    end3: range.end3 + boundary.rightStart,
  }));
}

function validateBoundary(length: number, start: number, end: number, side: string): void {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > length) {
    throw new RangeError(`Invalid ${side} merge boundary [${start}, ${end}) for length ${length}`);
  }
}

function compareMergeSide(base: string[], side: string[], policy: ComparisonPolicy, options: ByLineOptions): FairDiffIterable {
  const normalizedPolicy = toInternalPolicy(policy);
  const baseLines = buildLines(base, normalizedPolicy);
  const sideLines = buildLines(side, normalizedPolicy);
  const iwBase = buildLines(base, 'IW');
  const iwSide = buildLines(side, 'IW');
  const usePatienceAlg = options.usePatienceAlg ?? USE_PATIENCE_ALG;
  const iwChanges = optimizeLineChunks(baseLines, sideLines, compareSmart(iwBase, iwSide, undefined, usePatienceAlg));
  return correctChangesSecondStep(baseLines, sideLines, iwChanges);
}

// Map our IgnoreWhitespace UI option to the ByLine policy.
import type { IgnoreWhitespace } from './whitespace';
export function policyFromIgnoreWS(mode: IgnoreWhitespace): ComparisonPolicy {
  if (mode === 'whole') return 'IGNORE_WHITESPACES';
  if (mode === 'trim') return 'TRIM_WHITESPACES';
  return 'DEFAULT';
}

export function normalizeLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function splitTextToLines(text: string): string[] {
  const normalized = normalizeLf(text);
  const lines: string[] = [];
  let start = 0;
  while (true) {
    const end = normalized.indexOf('\n', start);
    if (end === -1) {
      lines.push(normalized.slice(start));
      return lines;
    }
    lines.push(normalized.slice(start, end));
    start = end + 1;
  }
}

export function compareText2(
  text1: string,
  text2: string,
  policy: ComparisonPolicy = 'DEFAULT',
  options: ByLineOptions = {}
): FairDiffIterable {
  return compareLines2(splitTextToLines(text1), splitTextToLines(text2), policy, options);
}

export function compareText3(
  left: string,
  base: string,
  right: string,
  policy: ComparisonPolicy = 'DEFAULT',
  options: ByLineOptions = {}
): MergeRange[] {
  return compareLines3(splitTextToLines(left), splitTextToLines(base), splitTextToLines(right), policy, options);
}

export function mergeText3(
  left: string,
  base: string,
  right: string,
  policy: ComparisonPolicy = 'DEFAULT',
  options: ByLineOptions = {}
): MergeRange[] {
  return mergeLines3(splitTextToLines(left), splitTextToLines(base), splitTextToLines(right), policy, options);
}

/**
 * Trim line-equivalent edges from each changed Range, mirroring IDEA's expandRanges.
 * Useful after IGNORE_WHITESPACES diff to drop "edges that are equal under
 * the policy but whose range was widened by surrounding noise".
 */
export function expandRanges(
  lines1: string[], lines2: string[],
  it: FairDiffIterable,
  policy: ComparisonPolicy = 'DEFAULT'
): FairDiffIterable {
  const normalizedPolicy: InternalComparisonPolicy = toInternalPolicy(policy);
  const out: Range[] = [];
  for (const ch of it.changes()) {
    let s1 = ch.start1, e1 = ch.end1, s2 = ch.start2, e2 = ch.end2;
    // expandForward
    while (s1 < e1 && s2 < e2 && linesEqual(lines1[s1], lines2[s2], normalizedPolicy)) { s1++; s2++; }
    // expandBackward
    while (s1 < e1 && s2 < e2 && linesEqual(lines1[e1 - 1], lines2[e2 - 1], normalizedPolicy)) { e1--; e2--; }
    if (s1 < e1 || s2 < e2) out.push({ start1: s1, end1: e1, start2: s2, end2: e2 });
  }
  return makeFair(createDiffIterable(out, it.length1, it.length2));
}
