import type { LineRange, MergeChange } from '../../types';
import { tryResolveConflict } from '../conflictResolve';
import { isResolved, resetResolvedChangeState } from './mergeActions';

export type MergeSide = 'local' | 'remote';
export type MergeCommandResult = { changed: boolean; changedHunkIds: number[] };

export class MergeConflictModel {
  constructor(private readonly hunks: readonly MergeChange[]) { }

  replaceChange(hunk: MergeChange, side: MergeSide, resolveChange = false): LineRange | null {
    if (hunk.kind === 'auto') return this.replaceAutoChange(hunk, side);
    if (hunk.kind !== 'conflict') return null;

    if (!hunk.resolved) hunk.resolved = [false, false];
    const sideIdx = sideIndex(side);
    const oppositeIdx = 1 - sideIdx;
    if (hunk.resolved[sideIdx] && !resolveChange) return null;

    const sourceLines = getSideLines(hunk, side);
    const oppositeLines = getSideLines(hunk, oppositeSide(side));

    if (resolveChange) {
      this.replaceWithNewContent(hunk, sourceLines, side === 'local' ? 'accepted-local' : 'accepted-remote');
      this.markChangeResolved(hunk);
      return this.getResultRange(hunk);
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
    return this.getResultRange(hunk);
  }

  appendChange(hunk: MergeChange, side: MergeSide): LineRange | null {
    if (hunk.kind !== 'conflict') return null;
    hunk.resolvedLines = [...hunk.resolvedLines, ...getSideLines(hunk, side)];
    hunk.resolved = [true, true];
    hunk.isOnesideAppliedConflict = false;
    hunk.status = 'accepted-both';
    this.afterProgrammaticWrite(hunk);
    return this.getResultRange(hunk);
  }

  ignoreChange(hunk: MergeChange, side: MergeSide, resolveChange = false): boolean {
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
    hunk: MergeChange,
    newContentLines: readonly string[],
    status: MergeChange['status'] = 'accepted-both'
  ): boolean {
    if (hunk.kind !== 'auto' && hunk.kind !== 'conflict') return false;
    hunk.resolvedLines = newContentLines.slice();
    hunk.status = status;
    hunk.isOnesideAppliedConflict = false;
    this.afterProgrammaticWrite(hunk);
    return true;
  }

  markChangeResolved(hunk: MergeChange): boolean {
    if (hunk.kind !== 'auto' && hunk.kind !== 'conflict') return false;
    hunk.resolved = [true, true];
    hunk.isOnesideAppliedConflict = false;
    hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
    return true;
  }

  resetResolvedChange(hunk: MergeChange, force = false): boolean {
    return resetResolvedChangeState(hunk, force);
  }

  resolveChangeAutomatically(hunk: MergeChange, side: MergeSide | 'base'): boolean {
    if (!this.canResolveChangeAutomatically(hunk, side)) return false;

    if (hunk.kind === 'conflict') {
      if (hunk.conflictType?.resolutionStrategy === 'SEMANTIC') {
        if (!hunk.autoResolvedLines) return false;
        this.replaceWithNewContent(hunk, hunk.autoResolvedLines, 'accepted-both');
        this.markChangeResolved(hunk);
        hunk.isResolvedWithAI = false;
        hunk.userEdited = false;
        return true;
      }
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

  canResolveChangeAutomatically(hunk: MergeChange, side: MergeSide | 'base'): boolean {
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

  private replaceAutoChange(hunk: MergeChange, side: MergeSide): LineRange | null {
    if (hunk.kind !== 'auto' || isResolved(hunk)) return null;
    // IDEA design.md §7.4: applying a side that has no change vs BASE just marks
    // the change resolved without touching the output (unreachable from the UI
    // today since that side shows no glyph, but kept 1:1 for callers like the
    // selection-batch actions).
    if (!isSideChanged(hunk, side)) {
      this.markChangeResolved(hunk);
      return this.getResultRange(hunk);
    }
    this.replaceWithNewContent(hunk, getSideLines(hunk, side), side === 'local' ? 'accepted-local' : 'accepted-remote');
    this.markChangeResolved(hunk);
    return this.getResultRange(hunk);
  }

  private afterProgrammaticWrite(hunk: MergeChange): void {
    hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
    hunk.isResolvedWithAI = false;
    hunk.userEdited = false;
  }

  private getResultRange(hunk: MergeChange): LineRange {
    return {
      start: hunk.resultRange?.start ?? 1,
      length: Math.max(hunk.localLines.length, hunk.resolvedLines.length, hunk.remoteLines.length, hunk.kind === 'conflict' ? 1 : 0)
    };
  }
}

export function sideIndex(side: MergeSide): 0 | 1 {
  return side === 'local' ? 0 : 1;
}

export function getSideLines(hunk: MergeChange, side: MergeSide): string[] {
  return side === 'local' ? hunk.localLines : hunk.remoteLines;
}

export function isSideChanged(hunk: MergeChange, side: MergeSide): boolean {
  if (hunk.kind === 'conflict') return true;
  if (hunk.kind !== 'auto' || !hunk.conflictType) return false;
  return side === 'local' ? hunk.conflictType.leftChange : hunk.conflictType.rightChange;
}

export function isChangeRangeModified(hunk: MergeChange): boolean {
  // IDEA design.md §20.8: "modified" means the output segment differs from the
  // *original* BASE fragment — not from whatever the last programmatic apply
  // wrote. So editing a hunk and then editing it back to BASE re-enables
  // auto-resolve / magic-resolve for it.
  return !linesEqualArr(hunk.resolvedLines, hunk.baseLines);
}

export function linesEqualArr(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function oppositeSide(side: MergeSide): MergeSide {
  return side === 'local' ? 'remote' : 'local';
}
