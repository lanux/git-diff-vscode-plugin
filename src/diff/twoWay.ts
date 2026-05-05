import { Hunk } from '../types';
import { splitLines } from './threeWay';
import { IgnoreWhitespace, normalizeLine } from './whitespace';

/** Myers-style line diff producing aligned hunks (equal/modified/added/deleted). */
export function buildTwoWayHunks(
  currentText: string,
  targetText: string,
  ignoreWS: IgnoreWhitespace = 'none'
): Hunk[] {
  const a = splitLines(currentText);
  const b = splitLines(targetText);
  const ops = diffLines(a, b, ignoreWS);

  const hunks: Hunk[] = [];
  let id = 0;
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.kind === 'eq') {
      const lines: string[] = [];
      while (i < ops.length && ops[i].kind === 'eq') { lines.push(ops[i].value); i++; }
      hunks.push({
        id: id++, kind: 'equal',
        localLines: lines.slice(), baseLines: [], remoteLines: lines.slice(),
        resolvedLines: lines.slice(), status: 'manual'
      });
    } else {
      const localLines: string[] = [];
      const remoteLines: string[] = [];
      while (i < ops.length && ops[i].kind !== 'eq') {
        if (ops[i].kind === 'del') localLines.push(ops[i].value);
        else if (ops[i].kind === 'add') remoteLines.push(ops[i].value);
        i++;
      }
      const kind: Hunk['kind'] =
        localLines.length && remoteLines.length ? 'modified'
        : localLines.length ? 'deleted'
        : 'added';
      hunks.push({
        id: id++, kind,
        localLines, baseLines: [], remoteLines,
        resolvedLines: localLines.slice(), status: 'manual'
      });
    }
  }
  return hunks;
}

type Op = { kind: 'eq' | 'del' | 'add'; value: string };

/**
 * Line diff via LCS table. Equality is decided after applying ignoreWS
 * normalization, but the original line is still kept in the op so it
 * renders verbatim.
 */
function diffLines(a: string[], b: string[], ignoreWS: IgnoreWhitespace): Op[] {
  if (a.length === 0) return b.map((v) => ({ kind: 'add', value: v }));
  if (b.length === 0) return a.map((v) => ({ kind: 'del', value: v }));

  const N = a.length, M = b.length;
  if (N * M > 4_000_000) return naiveDiff(a, b);

  const an = ignoreWS === 'none' ? a : a.map((l) => normalizeLine(l, ignoreWS));
  const bn = ignoreWS === 'none' ? b : b.map((l) => normalizeLine(l, ignoreWS));

  const dp: Uint32Array = new Uint32Array((N + 1) * (M + 1));
  const cols = M + 1;
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      if (an[i] === bn[j]) {
        dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)] + 1;
      } else {
        dp[i * cols + j] = Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
      }
    }
  }
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < N && j < M) {
    if (an[i] === bn[j]) { ops.push({ kind: 'eq', value: a[i] }); i++; j++; }
    else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
      ops.push({ kind: 'del', value: a[i] }); i++;
    } else {
      ops.push({ kind: 'add', value: b[j] }); j++;
    }
  }
  while (i < N) { ops.push({ kind: 'del', value: a[i++] }); }
  while (j < M) { ops.push({ kind: 'add', value: b[j++] }); }
  return ops;
}

function naiveDiff(a: string[], b: string[]): Op[] {
  return [
    ...a.map<Op>((v) => ({ kind: 'del', value: v })),
    ...b.map<Op>((v) => ({ kind: 'add', value: v }))
  ];
}
