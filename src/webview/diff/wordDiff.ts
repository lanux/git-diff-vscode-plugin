export type Granularity = 'char' | 'word' | 'line';
export interface CharRange { start: number; end: number; }
export interface WordDiffResult { left: CharRange[]; right: CharRange[]; }

/**
 * Token-boundary diff. Same algorithm as charDiff but tokens are
 * runs of [A-Za-z0-9_]+ or single non-token chars. Ranges are returned
 * as char offsets (not token offsets) so callers can apply them directly.
 */
export function wordTokenDiff(a: string, b: string): WordDiffResult {
  const at = tokenize(a); const bt = tokenize(b);
  if (at.length === 0 && bt.length === 0) return { left: [], right: [] };
  const N = at.length, M = bt.length;
  if (N * M > 50_000) return { left: [{ start: 0, end: a.length }], right: [{ start: 0, end: b.length }] };
  const dp = new Uint32Array((N + 1) * (M + 1));
  const cols = M + 1;
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      if (at[i].text === bt[j].text) dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)] + 1;
      else dp[i * cols + j] = Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
    }
  }
  const left: CharRange[] = []; const right: CharRange[] = [];
  let lStart = -1, rStart = -1;
  let i = 0, j = 0;
  const flushL = (end: number) => { if (lStart >= 0) { left.push({ start: lStart, end }); lStart = -1; } };
  const flushR = (end: number) => { if (rStart >= 0) { right.push({ start: rStart, end }); rStart = -1; } };
  while (i < N && j < M) {
    if (at[i].text === bt[j].text) {
      flushL(at[i].start); flushR(bt[j].start); i++; j++;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
      if (lStart < 0) lStart = at[i].start;
      i++;
    } else {
      if (rStart < 0) rStart = bt[j].start;
      j++;
    }
  }
  if (i < N) { if (lStart < 0) lStart = at[i].start; i = N; }
  if (j < M) { if (rStart < 0) rStart = bt[j].start; j = M; }
  flushL(a.length); flushR(b.length);
  return { left, right };
}

interface Token { text: string; start: number; end: number; }
function tokenize(s: string): Token[] {
  const toks: Token[] = [];
  const re = /[A-Za-z0-9_]+|[^A-Za-z0-9_]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) toks.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return toks;
}

/** Char-level LCS producing intra-line ranges to highlight. */
export function wordDiff(a: string, b: string): WordDiffResult {
  if (a === b) return { left: [], right: [] };
  const N = a.length, M = b.length;
  if (N * M > 1_000_000) {
    return { left: [{ start: 0, end: N }], right: [{ start: 0, end: M }] };
  }
  const dp = new Uint32Array((N + 1) * (M + 1));
  const cols = M + 1;
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)] + 1;
      else dp[i * cols + j] = Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
    }
  }
  const left: CharRange[] = [];
  const right: CharRange[] = [];
  let i = 0, j = 0;
  let lStart = -1, rStart = -1;
  const flushL = (end: number) => { if (lStart >= 0) { left.push({ start: lStart, end }); lStart = -1; } };
  const flushR = (end: number) => { if (rStart >= 0) { right.push({ start: rStart, end }); rStart = -1; } };
  while (i < N && j < M) {
    if (a[i] === b[j]) {
      flushL(i); flushR(j); i++; j++;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
      if (lStart < 0) lStart = i; i++;
    } else {
      if (rStart < 0) rStart = j; j++;
    }
  }
  if (i < N) { if (lStart < 0) lStart = i; i = N; }
  if (j < M) { if (rStart < 0) rStart = j; j = M; }
  flushL(i); flushR(j);
  return { left, right };
}
