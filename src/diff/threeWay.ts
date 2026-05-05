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
  conflict?: { a: string[]; o: string[]; b: string[] };
}

export function buildThreeWayHunks(local: string, base: string, remote: string): BuildResult {
  const localLines = splitLines(local);
  const baseLines = splitLines(base);
  const remoteLines = splitLines(remote);
  const regions = diff3Merge(localLines, baseLines, remoteLines) as unknown as Diff3Region[];

  const hunks: Hunk[] = [];
  const resultLines: string[] = [];
  let id = 0;
  for (const r of regions) {
    if (r.ok) {
      hunks.push({
        id: id++, kind: 'auto',
        localLines: r.ok.slice(),
        baseLines: r.ok.slice(),
        remoteLines: r.ok.slice(),
        resolvedLines: r.ok.slice(),
        status: 'manual'
      });
      resultLines.push(...r.ok);
    } else if (r.conflict) {
      const c = r.conflict;
      hunks.push({
        id: id++, kind: 'conflict',
        localLines: c.a.slice(),
        baseLines: c.o.slice(),
        remoteLines: c.b.slice(),
        resolvedLines: [],
        status: 'pending'
      });
    }
  }
  return { hunks, initialResult: resultLines.join('\n') };
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
    resolved = [...hunk.localLines, ...hunk.remoteLines];
    status = 'accepted-both';
  }
  return { ...hunk, resolvedLines: resolved, status };
}
