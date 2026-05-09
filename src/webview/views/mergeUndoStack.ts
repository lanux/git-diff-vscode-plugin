import type { Hunk, HunkKind, HunkStatus } from '../../types';

interface HunkSnapshot {
  id: number;
  kind: HunkKind;
  resolvedLines: string[];
  status: HunkStatus;
  resolved?: [boolean, boolean];
  isOnesideAppliedConflict?: boolean;
  lastAppliedSnapshot?: string[];
  autoResolvedLines?: string[];
  ignored?: boolean;
  userEdited?: boolean;
  isResolvedWithAI?: boolean;
  isImportChange?: boolean;
  semanticResolutionAvailable?: boolean;
}

export interface MergeSnapshot {
  resultText: string;
  dirty: boolean;
  hunks: HunkSnapshot[];
}

export interface MergeHistoryEntry {
  name: string;
  before: MergeSnapshot;
  after: MergeSnapshot;
}

export class MergeUndoStack {
  private readonly undoEntries: MergeHistoryEntry[] = [];
  private readonly redoEntries: MergeHistoryEntry[] = [];

  reset(): void {
    this.undoEntries.length = 0;
    this.redoEntries.length = 0;
  }

  record(name: string, before: MergeSnapshot, after: MergeSnapshot): boolean {
    if (snapshotContentEquals(before, after)) return false;
    this.undoEntries.push({
      name,
      before: cloneSnapshot(before),
      after: cloneSnapshot(after),
    });
    this.redoEntries.length = 0;
    return true;
  }

  undo(): MergeSnapshot | undefined {
    const entry = this.undoEntries.pop();
    if (!entry) return undefined;
    this.redoEntries.push(entry);
    return cloneSnapshot(entry.before);
  }

  redo(): MergeSnapshot | undefined {
    const entry = this.redoEntries.pop();
    if (!entry) return undefined;
    this.undoEntries.push(entry);
    return cloneSnapshot(entry.after);
  }

  get canUndo(): boolean {
    return this.undoEntries.length > 0;
  }

  get canRedo(): boolean {
    return this.redoEntries.length > 0;
  }
}

export function createMergeSnapshot(hunks: readonly Hunk[], resultText: string, dirty: boolean): MergeSnapshot {
  return {
    resultText,
    dirty,
    hunks: hunks.map((hunk) => ({
      id: hunk.id,
      kind: hunk.kind,
      resolvedLines: hunk.resolvedLines.slice(),
      status: hunk.status,
      resolved: cloneResolved(hunk.resolved),
      isOnesideAppliedConflict: hunk.isOnesideAppliedConflict,
      lastAppliedSnapshot: hunk.lastAppliedSnapshot?.slice(),
      autoResolvedLines: hunk.autoResolvedLines?.slice(),
      ignored: hunk.ignored,
      userEdited: hunk.userEdited,
      isResolvedWithAI: hunk.isResolvedWithAI,
      isImportChange: hunk.isImportChange,
      semanticResolutionAvailable: hunk.semanticResolutionAvailable,
    })),
  };
}

export function applyMergeSnapshot(hunks: Hunk[], snapshot: MergeSnapshot): void {
  const byId = new Map(snapshot.hunks.map((hunk) => [hunk.id, hunk]));
  for (const hunk of hunks) {
    const saved = byId.get(hunk.id);
    if (!saved) continue;
    hunk.kind = saved.kind;
    hunk.resolvedLines = saved.resolvedLines.slice();
    hunk.status = saved.status;
    hunk.resolved = cloneResolved(saved.resolved);
    hunk.isOnesideAppliedConflict = saved.isOnesideAppliedConflict;
    hunk.lastAppliedSnapshot = saved.lastAppliedSnapshot?.slice();
    hunk.autoResolvedLines = saved.autoResolvedLines?.slice();
    hunk.ignored = saved.ignored;
    hunk.userEdited = saved.userEdited;
    hunk.isResolvedWithAI = saved.isResolvedWithAI;
    hunk.isImportChange = saved.isImportChange;
    hunk.semanticResolutionAvailable = saved.semanticResolutionAvailable;
  }
}

export function cloneSnapshot(snapshot: MergeSnapshot): MergeSnapshot {
  return {
    resultText: snapshot.resultText,
    dirty: snapshot.dirty,
    hunks: snapshot.hunks.map((hunk) => ({
      ...hunk,
      resolvedLines: hunk.resolvedLines.slice(),
      resolved: cloneResolved(hunk.resolved),
      lastAppliedSnapshot: hunk.lastAppliedSnapshot?.slice(),
      autoResolvedLines: hunk.autoResolvedLines?.slice(),
    })),
  };
}

function snapshotContentEquals(left: MergeSnapshot, right: MergeSnapshot): boolean {
  if (left.resultText !== right.resultText) return false;
  if (left.hunks.length !== right.hunks.length) return false;
  for (let i = 0; i < left.hunks.length; i++) {
    if (!hunkSnapshotEquals(left.hunks[i], right.hunks[i])) return false;
  }
  return true;
}

function hunkSnapshotEquals(left: HunkSnapshot, right: HunkSnapshot): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.status === right.status
    && left.isOnesideAppliedConflict === right.isOnesideAppliedConflict
    && left.ignored === right.ignored
    && left.userEdited === right.userEdited
    && left.isResolvedWithAI === right.isResolvedWithAI
    && left.isImportChange === right.isImportChange
    && left.semanticResolutionAvailable === right.semanticResolutionAvailable
    && linesEqual(left.resolvedLines, right.resolvedLines)
    && resolvedEqual(left.resolved, right.resolved)
    && optionalLinesEqual(left.lastAppliedSnapshot, right.lastAppliedSnapshot)
    && optionalLinesEqual(left.autoResolvedLines, right.autoResolvedLines);
}

function linesEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function optionalLinesEqual(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (!left || !right) return left === right;
  return linesEqual(left, right);
}

function cloneResolved(value: [boolean, boolean] | undefined): [boolean, boolean] | undefined {
  return value ? [value[0], value[1]] : undefined;
}

function resolvedEqual(left: [boolean, boolean] | undefined, right: [boolean, boolean] | undefined): boolean {
  if (!left || !right) return left === right;
  return left[0] === right[0] && left[1] === right[1];
}
