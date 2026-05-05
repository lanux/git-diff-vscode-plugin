import { diff3Merge } from 'node-diff3';
import { Hunk } from '../types';

export interface BuildResult {
  hunks: Hunk[];
  initialResult: string;
}

export function splitLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split(/\r?\n/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

interface Diff3Region {
  ok?: string[];
  conflict?: { a: string[]; o: string[]; b: string[]; aIndex: number; oIndex: number; bIndex: number };
}

export function buildThreeWayHunks(local: string, base: string, remote: string): BuildResult {
  const localLines = splitLines(local);
  const baseLines = splitLines(base);
  const remoteLines = splitLines(remote);
  const regions = diff3Merge(localLines, baseLines, remoteLines) as unknown as Diff3Region[];

  const hunks: Hunk[] = [];
  const allResultLines: string[] = [];
  let id = 0;
  // Track positions in the original arrays
  let li = 0, bi = 0, ri = 0;
  // Track where the current auto hunk's result lines start in allResultLines
  let resultStart = 0;

  for (const r of regions) {
    if (r.ok) {
      allResultLines.push(...r.ok);
    } else if (r.conflict) {
      const c = r.conflict;
      // Extract original lines for the auto hunk preceding this conflict.
      // The conflict's *Index fields tell us where the conflict starts in each original array,
      // so the lines between our current position and the conflict start form the auto hunk.
      const localSlice = localLines.slice(li, c.aIndex);
      const baseSlice = baseLines.slice(bi, c.oIndex);
      const remoteSlice = remoteLines.slice(ri, c.bIndex);

      if (localSlice.length > 0 || baseSlice.length > 0 || remoteSlice.length > 0) {
        hunks.push({
          id: id++, kind: 'auto',
          localLines: localSlice,
          baseLines: baseSlice,
          remoteLines: remoteSlice,
          resolvedLines: allResultLines.slice(resultStart),
          status: 'manual'
        });
      }

      // Conflict hunk
      hunks.push({
        id: id++, kind: 'conflict',
        localLines: c.a.slice(),
        baseLines: c.o.slice(),
        remoteLines: c.b.slice(),
        resolvedLines: [],
        status: 'pending'
      });

      // Advance positions past this conflict
      li = c.aIndex + c.a.length;
      bi = c.oIndex + c.o.length;
      ri = c.bIndex + c.b.length;
      resultStart = allResultLines.length;
    }
  }

  // Remaining lines after the last conflict (or entire file if no conflicts)
  if (li < localLines.length || bi < baseLines.length || ri < remoteLines.length) {
    hunks.push({
      id: id++, kind: 'auto',
      localLines: localLines.slice(li),
      baseLines: baseLines.slice(bi),
      remoteLines: remoteLines.slice(ri),
      resolvedLines: allResultLines.slice(resultStart),
      status: 'manual'
    });
  }

  return { hunks, initialResult: allResultLines.join('\n') };
}

export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})/m.test(text);
}

export function applyHunkSide(hunk: Hunk, side: 'local' | 'remote' | 'both'): Hunk {
  let resolved: string[];
  let status: Hunk['status'];
  if (side === 'local') {
    resolved = hunk.localLines.slice();
    status = 'accepted-local';
  } else if (side === 'remote') {
    resolved = hunk.remoteLines.slice();
    status = 'accepted-remote';
  } else {
    if (hunk.kind === 'auto') {
      // For auto hunks, "both" restores the auto-merged result
      resolved = hunk.resolvedLines.slice();
      status = 'manual';
    } else {
      resolved = [...hunk.localLines, ...hunk.remoteLines];
      status = 'accepted-both';
    }
  }
  return { ...hunk, resolvedLines: resolved, status };
}
