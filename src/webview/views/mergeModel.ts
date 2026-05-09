import type { Hunk } from '../../types';
import { tryResolveConflict } from '../../diff/conflictResolve';
import { isResolved, resetResolvedChangeState } from './mergeActions';

export type MergeSide = 'local' | 'remote';
export type MergeCommandResult = { changed: boolean; changedHunkIds: number[] };

export class MergeConflictModel {
  constructor(private readonly hunks: readonly Hunk[]) { }

  replaceChange(hunk: Hunk, side: MergeSide, resolveChange = false): boolean {
    if (hunk.kind === 'auto') return this.replaceAutoChange(hunk, side);
    if (hunk.kind !== 'conflict') return false;

    if (!hunk.resolved) hunk.resolved = [false, false];
    const sideIdx = sideIndex(side);
    const oppositeIdx = 1 - sideIdx;
    if (hunk.resolved[sideIdx] && !resolveChange) return false;

    const sourceLines = getSideLines(hunk, side);
    const oppositeLines = getSideLines(hunk, oppositeSide(side));

    if (resolveChange) {
      this.replaceWithNewContent(hunk, sourceLines, side === 'local' ? 'accepted-local' : 'accepted-remote');
      this.markChangeResolved(hunk);
      return true;
    }

    if (hunk.isOnesideAppliedConflict) {
      return this.appendChange(hunk, side);
    }

    this.replaceWithNewContent(hunk, sourceLines, side === 'local' ? 'accepted-local' : 'accepted-remote');
    hunk.resolved![sideIdx] = true;

    if (hunk.resolved![oppositeIdx] || oppositeLines.length === 0) {
      hunk.resolved![oppositeIdx] = true;
      hunk.isOnesideAppliedConflict = false;
    } else {
      hunk.isOnesideAppliedConflict = true;
    }
    hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
    return true;
  }

  appendChange(hunk: Hunk, side: MergeSide): boolean {
    if (hunk.kind !== 'conflict') return false;
    hunk.resolvedLines = [...hunk.resolvedLines, ...getSideLines(hunk, side)];
    hunk.resolved = [true, true];
    hunk.isOnesideAppliedConflict = false;
    hunk.status = 'accepted-both';
    this.afterProgrammaticWrite(hunk);
    return true;
  }

  ignoreChange(hunk: Hunk, side: MergeSide, resolveChange = false): boolean {
    if (hunk.kind !== 'auto' && hunk.kind !== 'conflict') return false;
    if (!hunk.resolved) hunk.resolved = [false, false];
    const sideIdx = sideIndex(side);
    if (hunk.resolved[sideIdx] && !resolveChange) return false;

    if (hunk.kind !== 'conflict') {
      this.markChangeResolved(hunk);
      hunk.status = 'manual';
      return true;
    }

    const previousStatus = hunk.status;
    hunk.resolved[sideIdx] = true;
    if (resolveChange) hunk.resolved = [true, true];

    if (hunk.resolved[0] && hunk.resolved[1]) {
      hunk.status = previousStatus === 'pending' ? 'manual' : previousStatus;
      hunk.isOnesideAppliedConflict = false;
    } else {
      hunk.status = 'pending';
      hunk.isOnesideAppliedConflict = false;
    }
    hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
    return true;
  }

  replaceWithNewContent(
    hunk: Hunk,
    newContentLines: readonly string[],
    status: Hunk['status'] = 'accepted-both'
  ): boolean {
    if (hunk.kind !== 'auto' && hunk.kind !== 'conflict') return false;
    hunk.resolvedLines = newContentLines.slice();
    hunk.status = status;
    hunk.isOnesideAppliedConflict = false;
    this.afterProgrammaticWrite(hunk);
    return true;
  }

  markChangeResolved(hunk: Hunk): boolean {
    if (hunk.kind !== 'auto' && hunk.kind !== 'conflict') return false;
    hunk.resolved = [true, true];
    hunk.isOnesideAppliedConflict = false;
    hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
    return true;
  }

  resetResolvedChange(hunk: Hunk, force = false): boolean {
    return resetResolvedChangeState(hunk, force);
  }

  resolveChangeAutomatically(hunk: Hunk, side: MergeSide | 'base'): boolean {
    if (!this.canResolveChangeAutomatically(hunk, side)) return false;

    if (hunk.kind === 'conflict') {
      if (hunk.conflictType?.resolutionStrategy === 'SEMANTIC') return false;
      const merged = tryResolveConflict(hunk.localLines, hunk.baseLines, hunk.remoteLines);
      if (!merged) return false;
      this.replaceWithNewContent(hunk, merged, 'accepted-both');
    } else {
      const effectiveSide = side === 'base'
        ? (isSideChanged(hunk, 'local') ? 'local' : 'remote')
        : side;
      this.replaceWithNewContent(
        hunk,
        getSideLines(hunk, effectiveSide).slice(),
        effectiveSide === 'local' ? 'accepted-local' : 'accepted-remote'
      );
    }

    this.markChangeResolved(hunk);
    hunk.isResolvedWithAI = false;
    hunk.userEdited = false;
    return true;
  }

  applyNonConflicting(side: MergeSide | 'both'): MergeCommandResult {
    const effectiveSide = side === 'both' ? 'local' : side;
    const changedHunkIds: number[] = [];
    for (const hunk of this.hunks) {
      if (hunk.kind !== 'auto' || !hunk.conflictType) continue;
      if (isResolved(hunk) || isChangeRangeModified(hunk)) continue;
      const sideChanged = effectiveSide === 'local'
        ? hunk.conflictType.leftChange
        : hunk.conflictType.rightChange;
      if (!sideChanged) continue;
      if (this.resolveChangeAutomatically(hunk, effectiveSide)) changedHunkIds.push(hunk.id);
    }
    return { changed: changedHunkIds.length > 0, changedHunkIds };
  }

  canResolveChangeAutomatically(hunk: Hunk, side: MergeSide | 'base'): boolean {
    if (hunk.kind === 'conflict') {
      return side === 'base'
        && hunk.conflictType?.resolutionStrategy !== null
        && hunk.conflictType?.resolutionStrategy !== undefined
        && !(hunk.resolved?.[0] ?? false)
        && !(hunk.resolved?.[1] ?? false)
        && (hunk.conflictType.resolutionStrategy !== 'TEXT' || !isChangeRangeModified(hunk));
    }

    const effectiveSide = side === 'base' ? 'local' : side;
    return hunk.kind === 'auto'
      && !isResolved(hunk)
      && isSideChanged(hunk, effectiveSide)
      && !isChangeRangeModified(hunk);
  }

  private replaceAutoChange(hunk: Hunk, side: MergeSide): boolean {
    if (hunk.kind !== 'auto' || !isSideChanged(hunk, side) || isResolved(hunk)) return false;
    this.replaceWithNewContent(hunk, getSideLines(hunk, side), side === 'local' ? 'accepted-local' : 'accepted-remote');
    this.markChangeResolved(hunk);
    return true;
  }

  private afterProgrammaticWrite(hunk: Hunk): void {
    hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
    hunk.isResolvedWithAI = false;
    hunk.userEdited = false;
  }
}

export function sideIndex(side: MergeSide): 0 | 1 {
  return side === 'local' ? 0 : 1;
}

export function getSideLines(hunk: Hunk, side: MergeSide): string[] {
  return side === 'local' ? hunk.localLines : hunk.remoteLines;
}

export function isSideChanged(hunk: Hunk, side: MergeSide): boolean {
  if (hunk.kind === 'conflict') return true;
  if (hunk.kind !== 'auto' || !hunk.conflictType) return false;
  return side === 'local' ? hunk.conflictType.leftChange : hunk.conflictType.rightChange;
}

export function isChangeRangeModified(hunk: Hunk): boolean {
  return !linesEqualArr(hunk.resolvedLines, hunk.lastAppliedSnapshot ?? hunk.baseLines);
}

export function linesEqualArr(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function oppositeSide(side: MergeSide): MergeSide {
  return side === 'local' ? 'remote' : 'local';
}
