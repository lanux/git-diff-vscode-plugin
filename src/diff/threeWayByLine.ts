// Adapter that consumes IDEA-style MergeRange[] from byline.ts and produces
// the project's existing Hunk[] shape, so the merge UI can run unchanged.
//
// This path is opt-in (controlled by the caller); the legacy node-diff3 path
// in threeWay.ts remains the default until this is dogfooded enough.
import type { Hunk } from '../types';
import { mergeLines, policyFromIgnoreWS, type MergeRange } from './byline';
import { classifyFragment } from './mergeConflictType';
import { tryResolveConflict } from './conflictResolve';
import { normalizeLine, type IgnoreWhitespace } from './whitespace';
import { splitLines, type BuildResult } from './threeWay';

/**
 * For each MergeRange decide whether it can be auto-merged and what content
 * would be produced by IDEA's optional autoApplyNonConflictedChanges pass.
 * `resolvedLines` itself starts from BASE (see design.md §15.4).
 */
function autoMergeContent(
  localSeg: string[], baseSeg: string[], remoteSeg: string[],
  policy: IgnoreWhitespace
): { resolved: string[]; isConflict: boolean } {
  const ct = classifyFragment(localSeg, baseSeg, remoteSeg, policy, tryResolveConflict);
  if (ct.type === 'CONFLICT') {
    if (ct.resolutionStrategy === 'TEXT') {
      const merged = tryResolveConflict(localSeg, baseSeg, remoteSeg);
      if (merged) return { resolved: merged, isConflict: false };
    }
    return { resolved: [], isConflict: true };
  }
  // Non-conflict cases: pick the side that contains the change
  if (ct.type === 'INSERTED') {
    if (ct.leftChange && !ct.rightChange) return { resolved: localSeg.slice(), isConflict: false };
    if (ct.rightChange && !ct.leftChange) return { resolved: remoteSeg.slice(), isConflict: false };
    return { resolved: localSeg.slice(), isConflict: false }; // both equal
  }
  if (ct.type === 'DELETED') {
    return { resolved: [], isConflict: false };
  }
  // MODIFIED
  if (ct.leftChange && !ct.rightChange) return { resolved: localSeg.slice(), isConflict: false };
  if (ct.rightChange && !ct.leftChange) return { resolved: remoteSeg.slice(), isConflict: false };
  return { resolved: localSeg.slice(), isConflict: false }; // both equal modifications
}

function linesEqualForMode(left: string[], right: string[], mode: IgnoreWhitespace): boolean {
  if (left.length !== right.length) return false;
  if (mode === 'none') {
    return left.every((line, index) => line === right[index]);
  }
  return left.every((line, index) => normalizeLine(line, mode) === normalizeLine(right[index], mode));
}

function isIgnoredAutoChange(
  localSeg: string[],
  baseSeg: string[],
  remoteSeg: string[],
  policy: IgnoreWhitespace,
  leftChange: boolean,
  rightChange: boolean
): boolean {
  if (policy === 'none') return false;
  if (!leftChange && !rightChange) return false;
  return linesEqualForMode(localSeg, baseSeg, policy) && linesEqualForMode(remoteSeg, baseSeg, policy);
}

/**
 * Build Hunk[] using the IDEA ByLine pipeline. Equivalent in shape to
 * `buildThreeWayHunks` in threeWay.ts, but the underlying algorithm is the
 * IDEA-style "compare(BASE,LEFT) + compare(BASE,RIGHT) + buildSimpleMerge".
 */
export function buildThreeWayHunksByLine(
  local: string,
  base: string,
  remote: string,
  ignoreWS: IgnoreWhitespace = 'none'
): BuildResult {
  const localLines = splitLines(local);
  const baseLines = splitLines(base);
  const remoteLines = splitLines(remote);
  const ranges: MergeRange[] = mergeLines(
    localLines, baseLines, remoteLines, policyFromIgnoreWS(ignoreWS)
  );

  const hunks: Hunk[] = [];
  let id = 0;

  // Walk MergeRange[] interleaved with equal stretches between consecutive
  // ranges. Keep every real non-conflict change as its own auto hunk: IDEA's
  // Apply Non-Conflicts actions operate per change, so merging several safe
  // changes into one composite hunk can overwrite the other side accidentally.
  let li = 0, bi = 0, ri = 0;
  const pushEqual = (eqLocal: string[], eqBase: string[], eqRemote: string[]) => {
    if (!eqLocal.length && !eqBase.length && !eqRemote.length) return;
    hunks.push({
      id: id++, kind: 'equal',
      localLines: eqLocal, baseLines: eqBase, remoteLines: eqRemote,
      resolvedLines: eqBase.slice(), status: 'manual',
      resolved: [true, true],
      isOnesideAppliedConflict: false,
      lastAppliedSnapshot: eqBase.slice(),
      isResolvedWithAI: false,
      isImportChange: false,
      semanticResolutionAvailable: false
    });
  };

  const pushAutoChange = (
    localSeg: string[],
    baseSeg: string[],
    remoteSeg: string[],
    autoResolvedLines: string[]
  ) => {
    const ct = classifyFragment(localSeg, baseSeg, remoteSeg, ignoreWS, tryResolveConflict);
    const ignored = isIgnoredAutoChange(localSeg, baseSeg, remoteSeg, ignoreWS, ct.leftChange, ct.rightChange);
    hunks.push({
      id: id++, kind: 'auto',
      localLines: localSeg, baseLines: baseSeg, remoteLines: remoteSeg,
      resolvedLines: baseSeg.slice(), status: 'manual',
      conflictType: ct,
      resolved: [false, false],
      isOnesideAppliedConflict: false,
      lastAppliedSnapshot: baseSeg.slice(),
      autoResolvedLines: (ignored ? baseSeg : autoResolvedLines).slice(),
      ignored,
      isResolvedWithAI: false,
      isImportChange: false,
      semanticResolutionAvailable: false
    });
  };

  for (const mr of ranges) {
    // Equal stretch in BASE: [bi..mr.start2)
    if (mr.start2 > bi || mr.start1 > li || mr.start3 > ri) {
      const eqLocal = localLines.slice(li, mr.start1);
      const eqBase = baseLines.slice(bi, mr.start2);
      const eqRemote = remoteLines.slice(ri, mr.start3);
      pushEqual(eqLocal, eqBase, eqRemote);
    }

    const localSeg = localLines.slice(mr.start1, mr.end1);
    const baseSeg = baseLines.slice(mr.start2, mr.end2);
    const remoteSeg = remoteLines.slice(mr.start3, mr.end3);
    const am = autoMergeContent(localSeg, baseSeg, remoteSeg, ignoreWS);

    if (am.isConflict) {
      const ct = classifyFragment(localSeg, baseSeg, remoteSeg, ignoreWS, tryResolveConflict);
      hunks.push({
        id: id++, kind: 'conflict',
        localLines: localSeg, baseLines: baseSeg, remoteLines: remoteSeg,
        resolvedLines: baseSeg.slice(), status: 'pending',
        conflictType: ct,
        resolved: [false, false],
        isOnesideAppliedConflict: false,
        lastAppliedSnapshot: baseSeg.slice(),
        isResolvedWithAI: false,
        isImportChange: false,
        semanticResolutionAvailable: false
      });
    } else {
      pushAutoChange(localSeg, baseSeg, remoteSeg, am.resolved);
    }

    li = mr.end1; bi = mr.end2; ri = mr.end3;
  }

  // Trailing equal segment
  if (li < localLines.length || bi < baseLines.length || ri < remoteLines.length) {
    pushEqual(
      localLines.slice(li),
      baseLines.slice(bi),
      remoteLines.slice(ri)
    );
  }

  // Initial result is pure BASE. The webview may then run the optional
  // autoApplyNonConflictedChanges pass using each auto hunk's autoResolvedLines.
  const initialResult = hunks.flatMap((h) => h.resolvedLines).join('\n');
  return { hunks, initialResult };
}
