// Mirror of IntelliJ MergeResolveUtil.tryResolve / tryResolveConflict
// (see byline.md §4.3, design.md §8). When the word-level changes left-vs-base
// and right-vs-base touch DISJOINT regions of base, we can splice both
// changes onto base and call the conflict auto-resolved. Overlapping regions
// -> null (cannot resolve).
//
// The word-level diff itself reuses the ByLine LCS pipeline (Myers + Patience
// fallback) over a token stream — same idea as IntelliJ's ByWord — instead of a
// quadratic DP, so large conflict hunks no longer silently bail out.
//
// IntelliJ retries the word merge under IGNORE_WHITESPACES when the strict
// DEFAULT pass cannot prove the edits are disjoint. We mirror that behavior by
// running the same edit extraction twice: first with exact token equality, then
// with whitespace runs canonicalized.

import { buildChangesFromObjects, changesToRanges } from './byline/diff';
import { defaultLcsComputer } from './byline/patienceLcs';
import { FilesTooBigForDiffError } from './byline/types';

interface BaseEdit { baseStart: number; baseEnd: number; newText: string; }
interface Token { text: string; start: number; end: number; }
interface BaseRange { start: number; end: number; }
interface SideOperations { baseTokens: Token[]; deletions: BaseRange[]; insertions: Map<number, string>; }
type TokenCompareMode = 'DEFAULT' | 'IGNORE_WHITESPACES';

export interface ResolveConflictOptions {
  greedy?: boolean;
}

export const USE_GREEDY_MERGE_MAGIC_RESOLVE = false;

const TOKEN_RE = /[A-Za-z0-9_]+|[ \t\n]+|[^ \t\nA-Za-z0-9_]+/g;
const WHITESPACE_RE = /^[ \t\n]+$/;

function tokenize(s: string): Token[] {
  const toks: Token[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(s))) toks.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return toks;
}

function insertionKey(edit: BaseEdit): string {
  return JSON.stringify([edit.baseStart, edit.newText]);
}

function tokenEquals(left: Token, right: Token, mode: TokenCompareMode): boolean {
  if (mode === 'DEFAULT') return left.text === right.text;
  if (isWhitespaceToken(left) && isWhitespaceToken(right)) return true;
  return left.text === right.text;
}

function tokenKey(token: Token, mode: TokenCompareMode): string {
  if (mode === 'IGNORE_WHITESPACES' && isWhitespaceToken(token)) return '<ws>';
  return token.text;
}

function isWhitespaceToken(token: Token): boolean {
  return WHITESPACE_RE.test(token.text);
}

/**
 * Minimal list of "replace" edits turning `base` into `side`, each expressed as
 * a contiguous char range in `base` plus the replacement text from `side`. One
 * edit per maximal LCS change-run; pure insertions have `baseStart === baseEnd`.
 * Returns null only if the underlying diff is too big even for the Patience
 * fallback (extremely rare for a single conflict hunk).
 */
function computeEdits(base: string, side: string, mode: TokenCompareMode): BaseEdit[] | null {
  const A = tokenize(base);
  const B = tokenize(side);

  let ranges;
  try {
    const change = buildChangesFromObjects(A, B, defaultLcsComputer(), {
      equals: (a, b) => tokenEquals(a, b, mode),
      keyOf: (t) => tokenKey(t, mode)
    });
    ranges = changesToRanges(change);
  } catch (error) {
    if (error instanceof FilesTooBigForDiffError) return null;
    throw error;
  }

  const edits: BaseEdit[] = [];
  for (const r of ranges) {
    const baseStart = r.start1 < A.length ? A[r.start1].start : base.length;
    const baseEnd = r.start1 === r.end1 ? baseStart : A[r.end1 - 1].end;
    const newText = r.start2 < r.end2 ? side.substring(B[r.start2].start, B[r.end2 - 1].end) : '';
    edits.push({ baseStart, baseEnd, newText });
  }
  return edits;
}

/**
 * Returns the merged result lines if left/right modifications to base touch
 * disjoint regions; null otherwise. Empty edit lists on one side are OK
 * (but in practice that means it's not really a conflict).
 */
export function tryResolveConflict(
  local: string[],
  base: string[],
  remote: string[],
  options: ResolveConflictOptions = {}
): string[] | null {
  const shortcut = shortCircuitResolve(local, base, remote);
  if (shortcut) return shortcut;

  const greedy = options.greedy ?? USE_GREEDY_MERGE_MAGIC_RESOLVE;
  return greedy ? tryGreedyResolveConflict(local, base, remote) : trySimpleResolveConflict(local, base, remote);
}

export function tryGreedyResolveConflict(
  local: string[],
  base: string[],
  remote: string[]
): string[] | null {
  const shortcut = shortCircuitResolve(local, base, remote);
  if (shortcut) return shortcut;

  const baseText = base.join('\n');
  const localText = local.join('\n');
  const remoteText = remote.join('\n');

  return tryGreedyResolveConflictWithMode(localText, baseText, remoteText, 'DEFAULT')
    ?? tryGreedyResolveConflictWithMode(localText, baseText, remoteText, 'IGNORE_WHITESPACES');
}

function trySimpleResolveConflict(
  local: string[],
  base: string[],
  remote: string[]
): string[] | null {
  const baseText = base.join('\n');
  const localText = local.join('\n');
  const remoteText = remote.join('\n');

  return tryResolveConflictWithMode(localText, baseText, remoteText, 'DEFAULT')
    ?? tryResolveConflictWithMode(localText, baseText, remoteText, 'IGNORE_WHITESPACES');
}

function shortCircuitResolve(
  local: readonly string[],
  base: readonly string[],
  remote: readonly string[]
): string[] | null {
  const baseText = base.join('\n');
  const localText = local.join('\n');
  const remoteText = remote.join('\n');

  if (baseText === localText && baseText === remoteText) return base.slice();
  if (baseText === localText) return remote.slice();
  if (baseText === remoteText) return local.slice();
  return null;
}

function tryResolveConflictWithMode(
  localText: string,
  baseText: string,
  remoteText: string,
  mode: TokenCompareMode
): string[] | null {
  const leftEdits = computeEdits(baseText, localText, mode);
  const rightEdits = computeEdits(baseText, remoteText, mode);
  if (!leftEdits || !rightEdits) return null;
  // Empty edit lists fall through; the splice loop below reproduces baseText.

  // Disjointness check on base — strict open-interval comparison so two
  // adjacent edits (one ends where next begins) are still considered safe.
  const sameOffsetInsertions = new Set<string>();
  for (const l of leftEdits) {
    for (const r of rightEdits) {
      const overlapStart = Math.max(l.baseStart, r.baseStart);
      const overlapEnd = Math.min(l.baseEnd, r.baseEnd);
      if (overlapStart < overlapEnd) return null;
      if (isInsertion(l) && isInsertion(r) && l.baseStart === r.baseStart) {
        if (l.newText !== r.newText) return null;
        sameOffsetInsertions.add(insertionKey(l));
      }
    }
  }

  const all = [...leftEdits, ...rightEdits].sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);
  let out = '';
  let cur = 0;
  const emittedInsertions = new Set<string>();
  for (const e of all) {
    if (isInsertion(e)) {
      const key = insertionKey(e);
      if (sameOffsetInsertions.has(key)) {
        if (emittedInsertions.has(key)) continue;
        emittedInsertions.add(key);
      }
    }
    out += baseText.substring(cur, e.baseStart) + e.newText;
    cur = e.baseEnd;
  }
  out += baseText.substring(cur);
  return out.split('\n');
}

function tryGreedyResolveConflictWithMode(
  localText: string,
  baseText: string,
  remoteText: string,
  mode: TokenCompareMode
): string[] | null {
  const leftOps = computeSideOperations(baseText, localText, mode);
  const rightOps = computeSideOperations(baseText, remoteText, mode);
  if (!leftOps || !rightOps) return null;

  const mergedInsertions = new Map<number, string>();
  const offsets = new Set<number>([
    ...leftOps.insertions.keys(),
    ...rightOps.insertions.keys()
  ]);
  for (const offset of Array.from(offsets).sort((left, right) => left - right)) {
    const insertion = resolveGreedyInsertion(
      leftOps.insertions.get(offset),
      rightOps.insertions.get(offset),
      mode
    );
    if (insertion === null) return null;
    if (insertion.length > 0) mergedInsertions.set(offset, insertion);
  }

  const deletions = mergeBaseRanges([...leftOps.deletions, ...rightOps.deletions]);
  return buildTextFromOperations(leftOps.baseTokens, deletions, mergedInsertions).split('\n');
}

function computeSideOperations(baseText: string, sideText: string, mode: TokenCompareMode): SideOperations | null {
  const baseTokens = tokenize(baseText);
  const sideTokens = tokenize(sideText);

  let ranges;
  try {
    const change = buildChangesFromObjects(baseTokens, sideTokens, defaultLcsComputer(), {
      equals: (left, right) => tokenEquals(left, right, mode),
      keyOf: (token) => tokenKey(token, mode)
    });
    ranges = changesToRanges(change);
  } catch (error) {
    if (error instanceof FilesTooBigForDiffError) return null;
    throw error;
  }

  const deletions: BaseRange[] = [];
  const insertions = new Map<number, string>();
  for (const range of ranges) {
    if (range.start1 < range.end1) {
      deletions.push({ start: range.start1, end: range.end1 });
    }
    if (range.start2 < range.end2) {
      const newText = sideTokens.slice(range.start2, range.end2).map((token) => token.text).join('');
      insertions.set(range.start1, `${insertions.get(range.start1) ?? ''}${newText}`);
    }
  }
  return {
    baseTokens,
    deletions: mergeBaseRanges(deletions),
    insertions
  };
}

function mergeBaseRanges(ranges: BaseRange[]): BaseRange[] {
  if (ranges.length === 0) return [];

  const sorted = ranges.slice().sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: BaseRange[] = [sorted[0]];
  for (let index = 1; index < sorted.length; index++) {
    const current = sorted[index];
    const tail = merged[merged.length - 1];
    if (current.start <= tail.end) {
      tail.end = Math.max(tail.end, current.end);
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}

function resolveGreedyInsertion(
  leftText: string | undefined,
  rightText: string | undefined,
  mode: TokenCompareMode
): string | null {
  if (leftText === undefined) return rightText ?? '';
  if (rightText === undefined) return leftText;
  if (!textsEqualForMode(leftText, rightText, mode)) return null;
  return leftText.length <= rightText.length ? leftText : rightText;
}

function textsEqualForMode(leftText: string, rightText: string, mode: TokenCompareMode): boolean {
  if (mode === 'DEFAULT') return leftText === rightText;
  return leftText.replace(/[ \t\n]/g, '') === rightText.replace(/[ \t\n]/g, '');
}

function buildTextFromOperations(
  baseTokens: readonly Token[],
  deletions: readonly BaseRange[],
  insertions: ReadonlyMap<number, string>
): string {
  let out = '';
  let deletionIndex = 0;

  for (let offset = 0; offset <= baseTokens.length; offset++) {
    const insertion = insertions.get(offset);
    if (insertion) out += insertion;
    if (offset === baseTokens.length) break;

    while (deletionIndex < deletions.length && offset >= deletions[deletionIndex].end) {
      deletionIndex++;
    }
    const deletion = deletions[deletionIndex];
    if (deletion && offset >= deletion.start && offset < deletion.end) {
      continue;
    }
    out += baseTokens[offset].text;
  }

  return out;
}

function isInsertion(edit: BaseEdit): boolean {
  return edit.baseStart === edit.baseEnd;
}
