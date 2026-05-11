import type { Hunk, LineRange, MergeChange } from '../../types';

export type { LineRange } from '../../types';

export function joinLines(lines: string[]): string { return lines.join('\n'); }

export function buildAlignedThree(hunks: MergeChange[]) {
  const localOut: string[] = [];
  const resultOut: string[] = [];
  const remoteOut: string[] = [];
  const ranges = new Map<number, { local: LineRange; result: LineRange; remote: LineRange }>();
  for (const h of hunks) {
    const l = h.localLines.length, r = h.resolvedLines.length, rem = h.remoteLines.length;
    const max = Math.max(l, r, rem, h.kind === 'conflict' ? 1 : 0);
    const lStart = localOut.length + 1, rStart = resultOut.length + 1, remStart = remoteOut.length + 1;
    for (let i = 0; i < max; i++) {
      localOut.push(i < l ? h.localLines[i] : '');
      resultOut.push(i < r ? h.resolvedLines[i] : '');
      remoteOut.push(i < rem ? h.remoteLines[i] : '');
    }
    ranges.set(h.id, {
      local: { start: lStart, length: max },
      result: { start: rStart, length: max },
      remote: { start: remStart, length: max }
    });
  }
  return { local: joinLines(localOut), result: joinLines(resultOut), remote: joinLines(remoteOut), ranges };
}

export function buildAlignedTwo(hunks: Hunk[]) {
  const lOut: string[] = []; const rOut: string[] = [];
  const ranges = new Map<number, { local: LineRange; remote: LineRange }>();
  for (const h of hunks) {
    const l = h.localLines.length, rem = h.remoteLines.length;
    const max = Math.max(l, rem, 1);
    const lStart = lOut.length + 1, rStart = rOut.length + 1;
    if (h.kind === 'equal') {
      for (let i = 0; i < l; i++) { lOut.push(h.localLines[i]); rOut.push(h.localLines[i]); }
      ranges.set(h.id, { local: { start: lStart, length: l }, remote: { start: rStart, length: l } });
    } else {
      for (let i = 0; i < max; i++) {
        lOut.push(i < l ? h.localLines[i] : '');
        rOut.push(i < rem ? h.remoteLines[i] : '');
      }
      ranges.set(h.id, { local: { start: lStart, length: max }, remote: { start: rStart, length: max } });
    }
  }
  return { left: lOut.join('\n'), right: rOut.join('\n'), ranges };
}
