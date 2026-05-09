import { diff3Merge } from 'node-diff3';
import { Hunk } from '../types';
import { IgnoreWhitespace, normalizeLine } from './whitespace';
import { classifyFragment } from './mergeConflictType';
import { tryResolveConflict } from './conflictResolve';

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

export function buildThreeWayHunks(
  local: string,
  base: string,
  remote: string,
  ignoreWS: IgnoreWhitespace = 'none'
): BuildResult {
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
        const autoResolved = allResultLines.slice(resultStart);
        const ct = classifyFragment(localSlice, baseSlice, remoteSlice, ignoreWS);
        hunks.push({
          id: id++, kind: 'auto',
          localLines: localSlice,
          baseLines: baseSlice,
          remoteLines: remoteSlice,
          resolvedLines: autoResolved,
          status: 'manual',
          conflictType: ct,
          resolved: [false, false],
          isOnesideAppliedConflict: false,
          lastAppliedSnapshot: autoResolved.slice()
        });
      }

      // Conflict hunk — pass tryResolveConflict so resolutionStrategy gets set
      // to TEXT when the magic wand can auto-merge it (IDEA design.md §3.2).
      const conflictCT = classifyFragment(c.a, c.o, c.b, ignoreWS, tryResolveConflict);
      hunks.push({
        id: id++, kind: 'conflict',
        localLines: c.a.slice(),
        baseLines: c.o.slice(),
        remoteLines: c.b.slice(),
        resolvedLines: [],
        status: 'pending',
        conflictType: conflictCT,
        resolved: [false, false],
        isOnesideAppliedConflict: false,
        lastAppliedSnapshot: []
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
    const tailLocal = localLines.slice(li);
    const tailBase = baseLines.slice(bi);
    const tailRemote = remoteLines.slice(ri);
    const tailResolved = allResultLines.slice(resultStart);
    const ct = classifyFragment(tailLocal, tailBase, tailRemote, ignoreWS);
    hunks.push({
      id: id++, kind: 'auto',
      localLines: tailLocal,
      baseLines: tailBase,
      remoteLines: tailRemote,
      resolvedLines: tailResolved,
      status: 'manual',
      conflictType: ct,
      resolved: [false, false],
      isOnesideAppliedConflict: false,
      lastAppliedSnapshot: tailResolved.slice()
    });
  }

  // ignoreWS post-process: demote conflicts whose two sides are equal under normalization.
  // Matches IDEA's "Ignore whitespace" behavior (keep the local/left formatting).
  if (ignoreWS !== 'none') {
    for (const h of hunks) {
      if (h.kind !== 'conflict') continue;
      if (linesNormalizedEqual(h.localLines, h.remoteLines, ignoreWS)) {
        h.kind = 'auto';
        h.resolvedLines = h.localLines.slice();
        h.status = 'manual';
      }
    }
  }

  const resultText = hunks.length
    ? rebuildResultFromHunks(hunks)
    : allResultLines.join('\n');
  return { hunks, initialResult: resultText };
}

function linesNormalizedEqual(a: string[], b: string[], mode: IgnoreWhitespace): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (normalizeLine(a[i], mode) !== normalizeLine(b[i], mode)) return false;
  }
  return true;
}

function rebuildResultFromHunks(hunks: Hunk[]): string {
  const out: string[] = [];
  for (const h of hunks) out.push(...h.resolvedLines);
  return out.join('\n');
}

export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})/m.test(text);
}

