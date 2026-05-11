import type { MergeChange } from '../types';
import {
  mergeLines,
  mergeLinesWithinRange,
  policyFromIgnoreWS,
  splitTextToLines,
  type ComparisonPolicy,
  type MergeLineBoundary,
  type MergeRange
} from './byline';
import { classifyFragment, patchConflictTypes } from './mergeConflictType';
import { tryResolveConflict } from './conflictResolve';
import { normalizeLine, type IgnoreWhitespace } from './whitespace';
import type { BuildResult } from './lines';
import { findImportBlockRange, isImportChange, mergeImportBlocks } from './importResolve';
import type { LangSpecificMergeConflictResolver } from './langSpecificMergeConflictResolver';

/**
 * Compute the 3-way MergeRange list, isolating the import region (see byline.md
 * §18.10 / design.md §4.1). When any side has an import block, the file is
 * split into "before-imports / import-block / after-imports" using each side's
 * own import boundaries, then each segment is merged independently via
 * `mergeLinesWithinRange` (which keeps full-file line numbers). This keeps the
 * import path available even when the three import boundaries do not line up.
 */
function computeMergeRanges(
  localLines: string[],
  baseLines: string[],
  remoteLines: string[],
  policy: ComparisonPolicy
): MergeRange[] {
  const lImp = findImportBlockRange(localLines);
  const bImp = findImportBlockRange(baseLines);
  const rImp = findImportBlockRange(remoteLines);

  const hasImports = lImp.end > lImp.start || bImp.end > bImp.start || rImp.end > rImp.start;
  if (!hasImports) return mergeLines(localLines, baseLines, remoteLines, policy);

  const before: MergeLineBoundary = {
    leftStart: 0, leftEnd: lImp.start,
    baseStart: 0, baseEnd: bImp.start,
    rightStart: 0, rightEnd: rImp.start
  };
  const block: MergeLineBoundary = {
    leftStart: lImp.start, leftEnd: lImp.end,
    baseStart: bImp.start, baseEnd: bImp.end,
    rightStart: rImp.start, rightEnd: rImp.end
  };
  const after: MergeLineBoundary = {
    leftStart: lImp.end, leftEnd: localLines.length,
    baseStart: bImp.end, baseEnd: baseLines.length,
    rightStart: rImp.end, rightEnd: remoteLines.length
  };

  return [
    ...mergeLinesWithinRange(localLines, baseLines, remoteLines, before, policy),
    ...mergeLinesWithinRange(localLines, baseLines, remoteLines, block, policy),
    ...mergeLinesWithinRange(localLines, baseLines, remoteLines, after, policy)
  ];
}

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
 * Build Hunk[] using the IDEA ByLine pipeline:
 * compare(BASE,LEFT) + compare(BASE,RIGHT) + buildSimpleMerge.
 */
export function buildThreeWayHunksByLine(
  local: string,
  base: string,
  remote: string,
  ignoreWS: IgnoreWhitespace = 'none',
  semanticResolver: LangSpecificMergeConflictResolver | null = null
): BuildResult {
  // IntelliJ line model (byline.md §18.1): a trailing newline yields a final
  // empty line, so e.g. "a\n" → ["a", ""]. This keeps the trailing newline
  // through the merge and the join-back, matching design.md §20.3.
  const localLines = splitTextToLines(local);
  const baseLines = splitTextToLines(base);
  const remoteLines = splitTextToLines(remote);
  const ranges: MergeRange[] = computeMergeRanges(
    localLines, baseLines, remoteLines, policyFromIgnoreWS(ignoreWS)
  );

  const hunks: MergeChange[] = [];
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
    const importChange = isImportChange(localSeg, baseSeg, remoteSeg);
    hunks.push({
      id: id++, kind: 'auto',
      localLines: localSeg, baseLines: baseSeg, remoteLines: remoteSeg,
      resolvedLines: baseSeg.slice(), status: 'manual',
      conflictType: ct,
      resolved: [false, false],
      isOnesideAppliedConflict: false,
      lastAppliedSnapshot: baseSeg.slice(),
      autoResolvedLines: (ignored ? baseSeg : importChange ? mergeImportBlocks(localSeg, baseSeg, remoteSeg) : autoResolvedLines).slice(),
      ignored,
      isResolvedWithAI: false,
      isImportChange: importChange,
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
    if (mr.start1 === mr.end1 && mr.start2 === mr.end2 && mr.start3 === mr.end3) {
      li = mr.end1; bi = mr.end2; ri = mr.end3;
      continue;
    }

    const am = autoMergeContent(localSeg, baseSeg, remoteSeg, ignoreWS);

    if (am.isConflict) {
      const ct = classifyFragment(localSeg, baseSeg, remoteSeg, ignoreWS, tryResolveConflict);
      const importChange = isImportChange(localSeg, baseSeg, remoteSeg);
      const importResolution = importChange ? mergeImportBlocks(localSeg, baseSeg, remoteSeg) : undefined;
      hunks.push({
        id: id++, kind: 'conflict',
        localLines: localSeg, baseLines: baseSeg, remoteLines: remoteSeg,
        resolvedLines: baseSeg.slice(), status: 'pending',
        conflictType: ct,
        resolved: [false, false],
        isOnesideAppliedConflict: false,
        lastAppliedSnapshot: baseSeg.slice(),
        autoResolvedLines: importResolution?.slice(),
        isResolvedWithAI: false,
        isImportChange: importChange,
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

  patchConflictTypes(hunks, semanticResolver);

  // Initial result is pure BASE. The webview may then run the optional
  // autoApplyNonConflictedChanges pass using each auto hunk's autoResolvedLines.
  const initialResult = hunks.flatMap((h) => h.resolvedLines).join('\n');
  return { hunks, initialResult };
}
