export type HunkKind = 'auto' | 'conflict' | 'modified' | 'added' | 'deleted' | 'equal';
export type HunkStatus =
  | 'pending'
  | 'accepted-local'
  | 'accepted-remote'
  | 'accepted-both'
  | 'manual';

// Mirrors IDEA's MergeConflictType (see byline.md / design.md §3.1)
export type ConflictKind = 'INSERTED' | 'DELETED' | 'MODIFIED' | 'CONFLICT';
export type ResolutionStrategy = 'DEFAULT' | 'TEXT' | 'SEMANTIC' | null;
export interface MergeConflictType {
  type: ConflictKind;
  leftChange: boolean;
  rightChange: boolean;
  resolutionStrategy: ResolutionStrategy;
}

export interface Hunk {
  id: number;
  kind: HunkKind;
  localLines: string[];   // for merge: Local; for compare: current
  baseLines: string[];    // merge only
  remoteLines: string[];  // for merge: Remote; for compare: target
  resolvedLines: string[];
  status: HunkStatus;

  // ─── 1:1 IDEA model fields (merge only) ────────────────────────────────
  /** Per-side resolved flags. [LEFT, RIGHT]. Only filled for merge hunks. */
  resolved?: [boolean, boolean];
  /** Set when one side has been applied and we're waiting for the other side
   *  to *append* (Apply Both second-step). Same role as IDEA's
   *  TextMergeChange.isOnesideAppliedConflict. */
  isOnesideAppliedConflict?: boolean;
  /** IDEA-style INSERTED/DELETED/MODIFIED/CONFLICT classification. */
  conflictType?: MergeConflictType;
  /** Snapshot of resolvedLines after the last programmatic apply.
   *  Used by isChangeRangeModified() to skip user-edited hunks in
   *  Apply Non-Conflicts. Undefined ⇒ treat as not-yet-applied. */
  lastAppliedSnapshot?: string[];
  /** IDEA-style auto-merged content for non-conflict hunks. Kept separate
   *  from resolvedLines so the result pane can initialize from pure BASE
   *  while still optionally auto-applying safe changes on load. */
  autoResolvedLines?: string[];
  /** True when the hunk only exists because keepIgnoredChanges preserved a
   *  whitespace-equivalent change under the active ignoreWS mode. */
  ignored?: boolean;
  /** Set true once the user has hand-edited inside this hunk's result range. */
  userEdited?: boolean;
  /** True only when an external AI/semantic resolver wrote this result. */
  isResolvedWithAI?: boolean;
  /** Explicitly false in this VS Code port until PSI/import range support exists. */
  isImportChange?: boolean;
  /** Explicitly false unless a language semantic resolver is actually available. */
  semanticResolutionAvailable?: boolean;
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface InitMergeMessage {
  type: 'init';
  view: 'merge';
  filePath: string;
  language: string;
  local: string;
  base: string;
  remote: string;
  hunks: Hunk[];
  files: string[];   // all conflicted files (repo-relative), for cross-file navigation
  fileIndex: number; // index of current file within files
  ignoreWS: 'none' | 'trim' | 'inner' | 'whole';
  autoApplyNonConflicts: boolean;
}

export interface InitCompareMessage {
  type: 'init';
  view: 'compare';
  rootPath: string;
  current: string;
  target: string;
  files: FileChange[];
}

export interface FileDiffMessage {
  type: 'fileDiff';
  path: string;
  language: string;
  currentText: string;
  targetText: string;
  baselineText?: string; // HEAD content of current side, for true Revert
  status: FileChange['status'];
  hunks: Hunk[];
  editable: boolean;
  binary?: boolean;
}

export type ExtToWebview =
  | InitMergeMessage
  | InitCompareMessage
  | FileDiffMessage;

export interface ReadyMessage { type: 'ready'; }
export interface SaveMergeMessage { type: 'saveMerge'; content: string; }
export interface FinishMergeMessage {
  type: 'finishMerge';
  result: 'CANCEL' | 'LEFT' | 'RIGHT' | 'RESOLVED';
  outputText?: string;
  dirty?: boolean;
}
export interface SwitchMergeFileMessage { type: 'switchMergeFile'; direction: 1 | -1; dirty: boolean; }
export interface SetMergeIgnoreWSMessage { type: 'setMergeIgnoreWS'; ignoreWS: 'none' | 'trim' | 'inner' | 'whole'; dirty: boolean; }
export interface SaveFileEditMessage { type: 'saveFileEdit'; path: string; content: string; }
export interface RequestFileDiffMessage { type: 'requestFileDiff'; path: string; ignoreWS?: 'none' | 'trim' | 'inner' | 'whole'; }
export interface CancelMessage { type: 'cancel'; }
// IDEA's bottom-dialog Accept Left/Right Revision (design.md §5.3):
// take the entire local-or-remote version verbatim, with confirmation.
export interface AcceptRevisionMessage { type: 'acceptRevision'; side: 'local' | 'remote'; dirty: boolean; }

export interface CancelCheckMessage { type: 'cancelCheck'; }

export interface RefreshCompareMessage { type: 'refreshCompare'; }
export interface ReverseCompareMessage { type: 'reverseCompare'; }

export type WebviewToExt =
  | ReadyMessage
  | SaveMergeMessage
  | FinishMergeMessage
  | SaveFileEditMessage
  | RequestFileDiffMessage
  | CancelMessage
  | CancelCheckMessage
  | RefreshCompareMessage
  | ReverseCompareMessage
  | SwitchMergeFileMessage
  | SetMergeIgnoreWSMessage
  | AcceptRevisionMessage;
