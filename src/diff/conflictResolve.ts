// Mirror of IntelliJ MergeResolveUtil.tryResolve / tryResolveConflict
// (see byline.md §4.3, design.md §8). When the word-level changes left-vs-base
// and right-vs-base touch DISJOINT regions of base, we can splice both
// changes onto base and call the conflict auto-resolved. Overlapping regions
// → null (cannot resolve).

interface BaseEdit { baseStart: number; baseEnd: number; newText: string; }
interface Token { text: string; start: number; end: number; }

const TOKEN_RE = /[A-Za-z0-9_]+|[^A-Za-z0-9_]/g;

function tokenize(s: string): Token[] {
  const toks: Token[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(s))) toks.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return toks;
}

/**
 * Compute the minimal list of "replace" edits that turns `base` into `side`,
 * each edit expressed as a contiguous range in base + replacement text from side.
 * Adjacent unmatched tokens on both sides collapse into one edit.
 */
function computeEdits(base: string, side: string): BaseEdit[] | null {
  const A = tokenize(base);
  const B = tokenize(side);
  const N = A.length, M = B.length;
  if (N * M > 200_000) return null; // too big — bail out, treat as unresolvable

  const dp = new Uint32Array((N + 1) * (M + 1));
  const cols = M + 1;
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      if (A[i].text === B[j].text) dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)] + 1;
      else dp[i * cols + j] = Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
    }
  }

  const edits: BaseEdit[] = [];
  let i = 0, j = 0;
  let cur: BaseEdit | null = null;
  const flush = () => { if (cur) { edits.push(cur); cur = null; } };

  while (i < N && j < M) {
    if (A[i].text === B[j].text) {
      flush();
      i++; j++;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
      // delete A[i] from base
      if (!cur) cur = { baseStart: A[i].start, baseEnd: A[i].end, newText: '' };
      else cur.baseEnd = A[i].end;
      i++;
    } else {
      // insert B[j] from side
      if (!cur) cur = { baseStart: i < N ? A[i].start : base.length, baseEnd: i < N ? A[i].start : base.length, newText: B[j].text };
      else cur.newText += B[j].text;
      j++;
    }
  }
  // tails
  while (i < N) {
    if (!cur) cur = { baseStart: A[i].start, baseEnd: A[i].end, newText: '' };
    else cur.baseEnd = A[i].end;
    i++;
  }
  while (j < M) {
    if (!cur) cur = { baseStart: base.length, baseEnd: base.length, newText: B[j].text };
    else cur.newText += B[j].text;
    j++;
  }
  flush();
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
  remote: string[]
): string[] | null {
  const baseText = base.join('\n');
  const localText = local.join('\n');
  const remoteText = remote.join('\n');

  if (baseText === localText && baseText === remoteText) return base.slice();
  if (baseText === localText) return remote.slice();
  if (baseText === remoteText) return local.slice();

  const leftEdits = computeEdits(baseText, localText);
  const rightEdits = computeEdits(baseText, remoteText);
  if (!leftEdits || !rightEdits) return null;
  if (leftEdits.length === 0 && rightEdits.length === 0) return base.slice();

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
        sameOffsetInsertions.add(`${l.baseStart}\u0000${l.newText}`);
      }
    }
  }

  const all = [...leftEdits, ...rightEdits].sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);
  let out = '';
  let cur = 0;
  const emittedInsertions = new Set<string>();
  for (const e of all) {
    if (isInsertion(e)) {
      const key = `${e.baseStart}\u0000${e.newText}`;
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

function isInsertion(edit: BaseEdit): boolean {
  return edit.baseStart === edit.baseEnd;
}
