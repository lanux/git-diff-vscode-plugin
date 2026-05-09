import type { Hunk } from '../../types';

export function isResolved(hunk: Hunk): boolean {
  return (hunk.resolved?.[0] ?? false) && (hunk.resolved?.[1] ?? false);
}

export function resetResolvedChangeState(hunk: Hunk, force = false): boolean {
  if (hunk.kind !== 'auto' && hunk.kind !== 'conflict') return false;
  if (!force && !isResolved(hunk)) return false;

  const before = JSON.stringify({
    resolvedLines: hunk.resolvedLines,
    status: hunk.status,
    resolved: hunk.resolved,
    isOnesideAppliedConflict: hunk.isOnesideAppliedConflict,
    isResolvedWithAI: hunk.isResolvedWithAI,
    lastAppliedSnapshot: hunk.lastAppliedSnapshot,
    userEdited: hunk.userEdited,
  });

  hunk.resolvedLines = hunk.baseLines.slice();
  hunk.status = hunk.kind === 'conflict' ? 'pending' : 'manual';
  hunk.resolved = [false, false];
  hunk.isOnesideAppliedConflict = false;
  hunk.isResolvedWithAI = false;
  hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
  hunk.userEdited = false;

  const after = JSON.stringify({
    resolvedLines: hunk.resolvedLines,
    status: hunk.status,
    resolved: hunk.resolved,
    isOnesideAppliedConflict: hunk.isOnesideAppliedConflict,
    isResolvedWithAI: hunk.isResolvedWithAI,
    lastAppliedSnapshot: hunk.lastAppliedSnapshot,
    userEdited: hunk.userEdited,
  });

  return before !== after;
}

export function replaceChangeWithAiState(hunk: Hunk, newContentLines: readonly string[]): boolean {
  if (hunk.kind !== 'auto' && hunk.kind !== 'conflict') return false;
  if (isResolved(hunk)) return false;

  hunk.resolvedLines = newContentLines.slice();
  hunk.status = 'accepted-both';
  hunk.resolved = [true, true];
  hunk.isOnesideAppliedConflict = false;
  hunk.isResolvedWithAI = true;
  hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
  hunk.userEdited = false;
  return true;
}
