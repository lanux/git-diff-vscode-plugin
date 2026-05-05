export type HunkKind = 'auto' | 'conflict' | 'modified' | 'added' | 'deleted' | 'equal';
export type HunkStatus =
  | 'pending'
  | 'accepted-local'
  | 'accepted-remote'
  | 'accepted-both'
  | 'manual';

export interface Hunk {
  id: number;
  kind: HunkKind;
  localLines: string[];   // for merge: Local; for compare: current
  baseLines: string[];    // merge only
  remoteLines: string[];  // for merge: Remote; for compare: target
  resolvedLines: string[];
  status: HunkStatus;
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
export interface SwitchMergeFileMessage { type: 'switchMergeFile'; direction: 1 | -1; dirty: boolean; }
export interface SaveFileEditMessage { type: 'saveFileEdit'; path: string; content: string; }
export interface RequestFileDiffMessage { type: 'requestFileDiff'; path: string; ignoreWS?: 'none' | 'trim' | 'inner' | 'whole'; }
export interface CancelMessage { type: 'cancel'; }

export interface CancelCheckMessage { type: 'cancelCheck'; }

export interface RefreshCompareMessage { type: 'refreshCompare'; }
export interface ReverseCompareMessage { type: 'reverseCompare'; }

export type WebviewToExt =
  | ReadyMessage
  | SaveMergeMessage
  | SaveFileEditMessage
  | RequestFileDiffMessage
  | CancelMessage
  | CancelCheckMessage
  | RefreshCompareMessage
  | ReverseCompareMessage
  | SwitchMergeFileMessage;
