import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type {
  InitMergeMessage,
  LineRange,
  MergeActionPane,
  MergeAdditionalActionDescriptor,
  MergeChange
} from '../../types';
import { buildAlignedThree } from '../diff/align';
import { byId, setText, setMode } from '../components/toolbar';
import { Ribbon } from '../components/ribbon';
import type { Granularity } from '../diff/wordDiff';
import { isImportBlock, mergeImportBlocks } from '../../diff/importResolve';
import { magicResolve } from '../../diff/magicResolve';
import { vscode, getVsCodeTheme } from '../api';
import { isResolved } from '../../diff/merge/mergeActions';
import { computeCollapsedUnchangedAreas, type HiddenArea } from '../../diff/merge/collapseUnchanged';
import { MergeLineTracker } from './mergeLineTracker';
import { isChangeRangeModified, isSideChanged, linesEqualArr, MergeConflictModel } from '../../diff/merge/mergeModel';
import { InnerDiffScheduler } from './mergeInnerDiff';
import { closePartialCompare, isPartialCompareOpen, showPartialCompare, showWholeFileCompare } from './mergePartialCompare';
import {
  applyMergeSnapshot,
  createMergeSnapshot,
  MergeUndoStack,
  type MergeSnapshot
} from './mergeUndoStack';

interface PaneCtx {
  editor: monaco.editor.IStandaloneCodeEditor;
  decorations: string[];
}

interface MergeState {
  hunks: MergeChange[];
  local: PaneCtx; result: PaneCtx; remote: PaneCtx;
  ranges: Map<number, { local: LineRange; result: LineRange; remote: LineRange }>;
  localTracker: MergeLineTracker;
  resultTracker: MergeLineTracker;
  remoteTracker: MergeLineTracker;
  model: MergeConflictModel;
  filePath: string;
  language: string;
  localText: string;
  baseText: string;
  remoteText: string;
  files: string[];
  fileIndex: number;
  ignoreWS: 'none' | 'trim' | 'inner' | 'whole';
  additionalActions: MergeAdditionalActionDescriptor[];
}

let merge: MergeState | null = null;
let suppressScroll = false;
let ribbonLR: Ribbon | null = null;
let ribbonRR: Ribbon | null = null;
let dirty = false;
let programmaticEdit = false;
let decorateRaf = 0;
let updateRibbonsFn: (() => void) | null = null;
let mergeGranularity: Granularity = 'char';
let modifierShift = false;
const innerDiffScheduler = new InnerDiffScheduler();
const mergeUndoStack = new MergeUndoStack();
let lastMergeSnapshot: MergeSnapshot | null = null;
// Snapshot of each auto hunk's IDEA auto-merged content. The visible result
// starts from BASE and may opt into these lines during initialization.
let autoResolved: Map<number, string[]> = new Map();
let collapseUnchanged = false;
let autoScrollEnabled = true;

function makeEditor(container: HTMLElement, value: string, language: string, readOnly: boolean) {
  return monaco.editor.create(container, {
    value, language, readOnly,
    automaticLayout: true,
    minimap: { enabled: false },
    glyphMargin: true,
    lineNumbers: 'on',
    renderLineHighlight: 'all',
    scrollBeyondLastLine: false,
    theme: getVsCodeTheme()
  });
}

function decorationFor(range: LineRange, klass: string, glyph?: string): monaco.editor.IModelDeltaDecoration {
  return {
    range: new monaco.Range(range.start, 1, range.start + Math.max(range.length, 1) - 1, 1),
    options: { isWholeLine: true, className: klass, glyphMarginClassName: glyph }
  };
}

function stripeFor(range: LineRange, color: string): monaco.editor.IModelDeltaDecoration {
  return {
    range: new monaco.Range(range.start, 1, range.start + Math.max(range.length, 1) - 1, 1),
    options: {
      isWholeLine: true,
      overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Full }
    }
  };
}

// Per-hunk magic-wand glyphs in the BASE/result column for conflicts whose
// conflictType.resolutionStrategy is TEXT (matches IDEA design.md section 8 inline
// resolveRenderer).
const magicGutterByLine = new Map<number, number>(); // result line -> hunk id

function decorateMerge() {
  if (!merge) return;
  const { hunks } = merge;
  magicGutterByLine.clear();
  const ld: monaco.editor.IModelDeltaDecoration[] = [];
  const rd: monaco.editor.IModelDeltaDecoration[] = [];
  const remd: monaco.editor.IModelDeltaDecoration[] = [];
  for (const h of hunks) {
    const r = getTrackedRanges(h.id);
    if (h.kind === 'auto') {
      const cls = h.ignored ? 'hunk-ignored' : 'hunk-auto';
      const resolved = h.resolved ?? [false, false];
      const leftChanged = isSideChanged(h, 'local');
      const rightChanged = isSideChanged(h, 'remote');
      const leftGlyph = !resolved[0] && leftChanged
        ? (modifierShift ? 'action-glyph revert' : 'action-glyph right')
        : undefined;
      const rightGlyph = !resolved[1] && rightChanged
        ? (modifierShift ? 'action-glyph revert' : 'action-glyph left')
        : undefined;
      ld.push(decorationFor(r.local, cls, leftGlyph));
      rd.push(decorationFor(r.result, cls));
      remd.push(decorationFor(r.remote, cls, rightGlyph));
      const stripeColor = h.ignored ? 'rgba(145,127,179,.24)' : 'rgba(98,150,85,.3)';
      ld.push(stripeFor(r.local, stripeColor));
      remd.push(stripeFor(r.remote, stripeColor));
    } else if (h.kind === 'conflict') {
      // IDEA design.md §7.6: a conflict stays in the "unresolved" color until
      // BOTH sides are resolved — a one-side-applied conflict (Apply Both step 1)
      // is still highlighted as a conflict, only the applied side's glyph is gone.
      const resolved = h.resolved ?? [false, false];
      const fullyResolved = resolved[0] && resolved[1];
      const cls = fullyResolved ? 'hunk-resolved' : 'hunk-conflict-pending';
      // IDEA design.md section 7.6 glyph table:
      //   pending          -> unresolved sides show apply glyphs.
      //   Shift held       -> unresolved sides show ignore glyphs.
      //   one-side applied -> applied side has no glyph; opposite side appends.
      //   fully resolved   -> both sides have no glyph.
      let leftGlyph: string | undefined;
      let rightGlyph: string | undefined;
      if (fullyResolved) {
        leftGlyph = undefined;
        rightGlyph = undefined;
      } else if (modifierShift) {
        leftGlyph = resolved[0] ? undefined : 'action-glyph revert';
        rightGlyph = resolved[1] ? undefined : 'action-glyph revert';
      } else if (h.isOnesideAppliedConflict) {
        // Exactly one side is already applied; the other side's glyph appends.
        if (resolved[0]) {
          leftGlyph = undefined;
          rightGlyph = 'action-glyph append-left';
        } else {
          leftGlyph = 'action-glyph append-right';
          rightGlyph = undefined;
        }
      } else {
        leftGlyph = resolved[0] ? undefined : 'action-glyph right';
        rightGlyph = resolved[1] ? undefined : 'action-glyph left';
      }
      ld.push(decorationFor(r.local, cls, leftGlyph));
      // BASE column: magic wand glyph on the first line, only if pending and auto-resolvable.
      const showMagic = h.status === 'pending'
        && h.conflictType?.resolutionStrategy === 'TEXT'
        && !isChangeRangeModified(h);
      if (showMagic) {
        rd.push(decorationFor(r.result, cls, 'action-glyph magic'));
        magicGutterByLine.set(r.result.start, h.id);
      } else {
        rd.push(decorationFor(r.result, cls));
      }
      remd.push(decorationFor(r.remote, cls, rightGlyph));
      const stripeColor = fullyResolved ? 'rgba(98,150,85,.5)' : 'rgba(232,118,0,.8)';
      ld.push(stripeFor(r.local, stripeColor));
      remd.push(stripeFor(r.remote, stripeColor));
    }
  }
  merge.local.decorations = merge.local.editor.deltaDecorations(merge.local.decorations, ld);
  merge.result.decorations = merge.result.editor.deltaDecorations(merge.result.decorations, rd);
  merge.remote.decorations = merge.remote.editor.deltaDecorations(merge.remote.decorations, remd);
  scheduleInnerDiff();
  applyCollapsedUnchangedAreas();
  updateMergeCounter();
}

function applyCollapsedUnchangedAreas(): void {
  if (!merge) return;

  if (!collapseUnchanged) {
    setEditorHiddenAreas(merge.local.editor, []);
    setEditorHiddenAreas(merge.result.editor, []);
    setEditorHiddenAreas(merge.remote.editor, []);
    updateCollapseToggle();
    return;
  }

  const hidden = computeCollapsedUnchangedAreas(merge.hunks, getTrackedRanges);
  setEditorHiddenAreas(merge.local.editor, toMonacoHiddenAreas(hidden.local));
  setEditorHiddenAreas(merge.result.editor, toMonacoHiddenAreas(hidden.result));
  setEditorHiddenAreas(merge.remote.editor, toMonacoHiddenAreas(hidden.remote));
  updateCollapseToggle();
}

type HiddenAreaCapableEditor = monaco.editor.IStandaloneCodeEditor & {
  setHiddenAreas?: (ranges: monaco.Range[]) => void;
};

function setEditorHiddenAreas(editor: monaco.editor.IStandaloneCodeEditor, ranges: monaco.Range[]): void {
  (editor as HiddenAreaCapableEditor).setHiddenAreas?.(ranges);
}

function toMonacoHiddenAreas(hiddenAreas: readonly HiddenArea[]): monaco.Range[] {
  return hiddenAreas.map((hiddenArea) => new monaco.Range(hiddenArea.startLine, 1, hiddenArea.endLine, 1));
}

function updateCollapseToggle(): void {
  const button = document.getElementById('collapseUnchanged') as HTMLButtonElement | null;
  if (!button) return;
  button.classList.toggle('active', collapseUnchanged);
  button.setAttribute('aria-pressed', String(collapseUnchanged));
  button.title = collapseUnchanged ? 'Expand unchanged sections' : 'Collapse unchanged sections';
}

function updateAutoScrollToggle(): void {
  const button = document.getElementById('autoScroll') as HTMLButtonElement | null;
  if (!button) return;
  button.classList.toggle('active', autoScrollEnabled);
  button.setAttribute('aria-pressed', String(autoScrollEnabled));
  button.title = autoScrollEnabled ? 'Disable synchronized scrolling' : 'Enable synchronized scrolling';
}

function scheduleInnerDiff(): void {
  if (!merge) return;
  innerDiffScheduler.schedule({
    hunks: merge.hunks,
    localEditor: merge.local.editor,
    resultEditor: merge.result.editor,
    remoteEditor: merge.remote.editor,
    getRanges: getTrackedRanges
  }, mergeGranularity);
}

// Once all conflicts are processed for this file we want a one-shot
// completion toast mirroring IDEA's "merge.all.changes.processed" bubble.
// Tracks the previous-pending count so we only fire on the 1->0 transition.
let prevPendingCount = -1;

function updateMergeCounter() {
  if (!merge) return;
  // A conflict is "unresolved" until BOTH sides are resolved — a one-side-applied
  // conflict (Apply Both step 1) still counts (IDEA design.md §7.5–§7.6).
  const pending = merge.hunks.filter((h) => h.kind === 'conflict' && !isResolved(h)).length;
  const changes = merge.hunks.filter((h) => h.kind === 'conflict' || h.kind === 'auto').length;
  setText(
    'counter',
    `${changes} change${changes === 1 ? '' : 's'}. ${pending} conflict${pending === 1 ? '' : 's'}.`
  );
  const acceptBtn = document.getElementById('accept') as HTMLButtonElement;
  if (acceptBtn) {
    // IDEA design.md §5.3/§12: Apply is always available; the host confirms
    // before saving when conflicts are still unresolved.
    acceptBtn.disabled = false;
    acceptBtn.title = pending > 0
      ? `${pending} unresolved conflict${pending === 1 ? '' : 's'} — will be left as-is`
      : 'Accept merge and stage file';
  }
  const prevFileBtn = document.getElementById('prevFile') as HTMLButtonElement | null;
  const nextFileBtn = document.getElementById('nextFile') as HTMLButtonElement | null;
  if (prevFileBtn) prevFileBtn.disabled = merge.fileIndex <= 0;
  if (nextFileBtn) nextFileBtn.disabled = merge.fileIndex >= merge.files.length - 1;

  // Edge-trigger when conflicts go from N>0 to 0 鈥?flash the counter so the
  // user knows they can now Accept.
  const counter = document.getElementById('counter');
  if (counter) {
    if (prevPendingCount > 0 && pending === 0) {
      counter.classList.add('all-resolved');
      counter.textContent = 'All changes processed.';
      setTimeout(() => counter.classList.remove('all-resolved'), 2500);
    }
  }
  prevPendingCount = pending;
}

function getTrackedRanges(hunkId: number) {
  if (!merge) throw new Error('Merge state is not initialized');
  const ranges = merge.ranges.get(hunkId);
  if (!ranges) throw new Error(`Missing aligned range for hunk ${hunkId}`);
  return {
    local: merge.localTracker.getRange(hunkId) ?? ranges.local,
    result: merge.resultTracker.getRange(hunkId) ?? ranges.result,
    remote: merge.remoteTracker.getRange(hunkId) ?? ranges.remote,
  };
}

function extractPaneRanges(
  ranges: Map<number, { local: LineRange; result: LineRange; remote: LineRange }>,
  pane: 'local' | 'result' | 'remote'
) {
  const paneRanges = new Map<number, LineRange>();
  for (const [hunkId, range] of ranges) paneRanges.set(hunkId, range[pane]);
  return paneRanges;
}

function buildPaneBlock(hunk: MergeChange, pane: 'local' | 'result' | 'remote', length: number): string[] {
  const source = pane === 'local' ? hunk.localLines : pane === 'remote' ? hunk.remoteLines : hunk.resolvedLines;
  const out = source.slice();
  while (out.length < length) out.push('');
  return out;
}

function findHunkAtLine(side: 'local' | 'remote', line: number): MergeChange | undefined {
  if (!merge) return;
  for (const h of merge.hunks) {
    if (h.kind !== 'conflict' && !isSideChanged(h, side)) continue;
    const r = merge.ranges.get(h.id)![side];
    if (line >= r.start && line < r.start + Math.max(r.length, 1)) return h;
  }
}

function currentResultLineHunk(): MergeChange | undefined {
  if (!merge) return;
  const line = merge.result.editor.getPosition()?.lineNumber ?? 1;
  for (const h of merge.hunks) {
    if (h.kind !== 'conflict') continue;
    const r = getTrackedRanges(h.id).result;
    if (line >= r.start && line < r.start + Math.max(r.length, 1)) return h;
  }
  return merge.hunks.find((h) => h.kind === 'conflict' && h.status === 'pending');
}

function currentResultChangeHunk(): MergeChange | undefined {
  if (!merge) return;
  const line = merge.result.editor.getPosition()?.lineNumber ?? 1;
  for (const h of merge.hunks) {
    if (h.kind !== 'auto' && h.kind !== 'conflict') continue;
    const r = getTrackedRanges(h.id).result;
    if (line >= r.start && line < r.start + Math.max(r.length, 1)) return h;
  }
}

function showCompareContents(): void {
  if (!merge) return;
  const mode = (document.getElementById('compareContentsMode') as HTMLSelectElement | null)?.value ?? 'change-local-base';
  if (mode.startsWith('file-')) {
    showWholeFileCompare({
      local: merge.localText,
      base: merge.baseText,
      remote: merge.remoteText
    }, merge.language);
    return;
  }

  const hunk = currentResultChangeHunk() ?? currentSideChangeHunk('local') ?? currentSideChangeHunk('remote');
  if (!hunk) return;
  showPartialCompare(hunk, merge.language, { revealMainChange: () => revealMergeHunk(hunk.id) });
}

function revealMergeHunk(hunkId: number): void {
  if (!merge) return;
  const range = getTrackedRanges(hunkId).result;
  merge.result.editor.revealLineInCenter(range.start);
  merge.result.editor.setPosition({ lineNumber: range.start, column: 1 });
  merge.result.editor.focus();
}

function currentSideChangeHunk(side: 'local' | 'remote'): MergeChange | undefined {
  if (!merge) return;
  const editor = side === 'local' ? merge.local.editor : merge.remote.editor;
  const line = editor.getPosition()?.lineNumber ?? 1;
  return findHunkAtLine(side, line);
}

export function getResultContent(): string {
  return merge?.result.editor.getValue() ?? '';
}

export function getUnresolvedConflictCount(): number {
  return merge?.hunks.filter((h) => h.kind === 'conflict' && !isResolved(h)).length ?? 0;
}

function currentMergeSnapshot(dirtyValue = dirty): MergeSnapshot | null {
  if (!merge) return null;
  return createMergeSnapshot(merge.hunks, merge.result.editor.getValue(), dirtyValue);
}

function resetMergeHistory(): void {
  mergeUndoStack.reset();
  lastMergeSnapshot = currentMergeSnapshot(false);
}

function executeMergeCommand(name: string, task: () => void): void {
  if (!merge) return;
  syncResultEditsFromTracker();
  const wasDirty = dirty;
  const before = currentMergeSnapshot(wasDirty);
  if (!before) return;

  task();

  const after = currentMergeSnapshot(true);
  if (!after) return;
  if (mergeUndoStack.record(name, before, after)) {
    dirty = true;
    lastMergeSnapshot = after;
  } else {
    dirty = wasDirty;
    lastMergeSnapshot = currentMergeSnapshot(wasDirty);
  }
}

function restoreMergeSnapshot(snapshot: MergeSnapshot): void {
  if (!merge) return;
  applyMergeSnapshot(merge.hunks, snapshot);
  dirty = snapshot.dirty;
  refreshMergeLayout();
  lastMergeSnapshot = currentMergeSnapshot(snapshot.dirty);
}

function undoMergeCommand(): boolean {
  const snapshot = mergeUndoStack.undo();
  if (!snapshot) return false;
  restoreMergeSnapshot(snapshot);
  return true;
}

function redoMergeCommand(): boolean {
  const snapshot = mergeUndoStack.redo();
  if (!snapshot) return false;
  restoreMergeSnapshot(snapshot);
  return true;
}

function recordManualEdit(): void {
  if (!merge) return;
  const before = lastMergeSnapshot ?? currentMergeSnapshot(false);
  const after = currentMergeSnapshot(true);
  if (!before || !after) return;
  mergeUndoStack.record('Edit Result', before, after);
  lastMergeSnapshot = after;
}

// Click on a side's apply-arrow glyph for a conflict hunk.
// IDEA semantics: MergeConflictModel.replaceChange (design.md section 7.4):
//   1. If THIS side is already resolved, no-op (return). IDEA does NOT
//      support clicking the arrow to revert; revert goes through Undo or
//      a separate Reset action.
//   2. If THIS side has no change vs base (fragment empty), simply mark
//      resolved without modifying the result.
//   3. Conflict + first apply: replace BASE with this side's content,
//      mark this side resolved, set isOnesideAppliedConflict=true so the
//      opposite side's next click triggers an APPEND.
//   4. Conflict + isOnesideAppliedConflict (=Apply Both second step):
//      APPEND this side's content AFTER current result, full-resolve.
//      Append order = click order (first-click content stays on top).
//   5. resolveChange (Ctrl+Click): full-resolve immediately, dropping the
//      opposite side regardless of state.
//   6. After step 3, if the OPPOSITE side's source fragment is empty
//      (e.g. a delete-on-the-other-side conflict), auto full-resolve
//      because there's nothing to append.
function handleConflictClick(hunk: MergeChange, side: 'local' | 'remote', resolveChange: boolean = false) {
  if (!merge || hunk.kind !== 'conflict') return;
  syncResultEditsFromTracker();
  if (merge.model.replaceChange(hunk, side, resolveChange)) refreshMergeLayout([hunk.id]);
}

function handleAutoApplyClick(hunk: MergeChange, side: 'local' | 'remote') {
  if (!merge || hunk.kind !== 'auto' || !isSideChanged(hunk, side)) return;
  syncResultEditsFromTracker();
  if (merge.model.replaceChange(hunk, side)) refreshMergeLayout([hunk.id]);
}

function handleIgnoreClick(hunk: MergeChange, side: 'local' | 'remote', resolveChange: boolean = false) {
  if (!merge) return;
  syncResultEditsFromTracker();
  if (merge.model.ignoreChange(hunk, side, resolveChange)) refreshMergeLayout([hunk.id]);
}

function resolveChangeAutomatically(hunk: MergeChange, side: 'local' | 'remote' | 'base'): boolean {
  return merge?.model.resolveChangeAutomatically(hunk, side) ?? false;
}

function resetResolvedChange(hunk: MergeChange, force = false): boolean {
  if (!merge) return false;
  syncResultEditsFromTracker();
  if (!merge.model.resetResolvedChange(hunk, force)) return false;
  refreshMergeLayout([hunk.id]);
  return true;
}

// IDEA's ApplySelectedChangesAction / IgnoreSelectedChangesAction (design.md §9):
// operate on every change hunk whose pane range overlaps the editor selection
// (a collapsed selection = the cursor line, so this also covers the common
// "right-click on a change" case). Hunk ids are captured up front because each
// apply re-aligns the layout.
function selectedLineRange(editor: monaco.editor.IStandaloneCodeEditor): { start: number; end: number } | null {
  const sel = editor.getSelection();
  if (!sel) return null;
  return {
    start: Math.min(sel.startLineNumber, sel.endLineNumber),
    end: Math.max(sel.startLineNumber, sel.endLineNumber)
  };
}

function hunkOverlapsSelection(hunkId: number, pane: 'local' | 'result' | 'remote', sel: { start: number; end: number }): boolean {
  const r = getTrackedRanges(hunkId)[pane];
  const rStart = r.start;
  const rEnd = r.start + Math.max(r.length, 1) - 1;
  return rStart <= sel.end && sel.start <= rEnd;
}

function hunksInSideSelection(editor: monaco.editor.IStandaloneCodeEditor, side: 'local' | 'remote'): MergeChange[] {
  if (!merge) return [];
  const sel = selectedLineRange(editor);
  if (!sel) return [];
  return merge.hunks.filter((h) =>
    (h.kind === 'conflict' || (h.kind === 'auto' && isSideChanged(h, side)))
    && !isResolved(h)
    && hunkOverlapsSelection(h.id, side, sel)
  );
}

function hunksInResultSelection(): MergeChange[] {
  if (!merge) return [];
  const sel = selectedLineRange(merge.result.editor);
  if (!sel) return [];
  return merge.hunks.filter((h) =>
    (h.kind === 'conflict' || h.kind === 'auto')
    && !isResolved(h)
    && hunkOverlapsSelection(h.id, 'result', sel)
  );
}

function applySelectedSideChanges(editor: monaco.editor.IStandaloneCodeEditor, side: 'local' | 'remote'): void {
  const ids = hunksInSideSelection(editor, side).map((h) => h.id);
  if (!ids.length) return;
  executeMergeCommand(side === 'local' ? 'Apply Selected Local Changes' : 'Apply Selected Remote Changes', () => {
    for (const id of ids) {
      const h = merge?.hunks.find((x) => x.id === id);
      if (!h || isResolved(h)) continue;
      if (h.kind === 'conflict') handleConflictClick(h, side);
      else handleAutoApplyClick(h, side);
    }
  });
}

function ignoreSelectedSideChanges(editor: monaco.editor.IStandaloneCodeEditor, side: 'local' | 'remote'): void {
  const ids = hunksInSideSelection(editor, side).map((h) => h.id);
  if (!ids.length) return;
  executeMergeCommand(side === 'local' ? 'Ignore Selected Local Changes' : 'Ignore Selected Remote Changes', () => {
    for (const id of ids) {
      const h = merge?.hunks.find((x) => x.id === id);
      if (h) handleIgnoreClick(h, side);
    }
  });
}

function ignoreSelectedResultChanges(): void {
  const ids = hunksInResultSelection().map((h) => h.id);
  if (!ids.length) return;
  executeMergeCommand('Ignore Selected Changes', () => {
    for (const id of ids) {
      const h = merge?.hunks.find((x) => x.id === id);
      if (h) handleIgnoreClick(h, 'local', true); // resolveChange=true → ignore the whole hunk
    }
  });
}

function magicResolveSelectedConflicts(): void {
  const ids = hunksInResultSelection()
    .filter((h) => h.kind === 'conflict' && h.status === 'pending')
    .map((h) => h.id);
  if (!ids.length) return;
  executeMergeCommand('Magic Resolve Selected Conflicts', () => {
    syncResultEditsFromTracker();
    const changed: number[] = [];
    for (const id of ids) {
      const h = merge?.hunks.find((x) => x.id === id);
      if (h && h.kind === 'conflict' && h.status === 'pending' && resolveChangeAutomatically(h, 'base')) changed.push(h.id);
    }
    if (changed.length) refreshMergeLayout(changed);
  });
}

// IDEA semantics:
//   Apply All Non-Conflicting -> same as Apply Non-Conflicts From Left
//     (IDEA's BASE toolbar action uses masterSide=LEFT).
//   Apply Left Non-Conflicting -> for auto hunks where local changed vs base, use localLines;
//     hunks that are remote-only changes are left as-is.
//   Apply Right Non-Conflicting -> mirror of left.
function applyNonConflicting(side: 'local' | 'remote' | 'both') {
  if (!merge) return;
  syncResultEditsFromTracker();
  const result = merge.model.applyNonConflicting(side);
  if (result.changed) refreshMergeLayout(result.changedHunkIds);
}

function runMagicResolve() {
  if (!merge) return;
  syncResultEditsFromTracker();
  const changedHunks = magicResolve(merge.hunks);
  if (changedHunks.length > 0) refreshMergeLayout(changedHunks);
}

// MergeModelBase equivalent: keep each hunk's BASE/result block range live via
// tracked decorations, and sync manual edits back into hunk.resolvedLines on
// every content change instead of only right before a full rebuild.
function syncResultEditsFromTracker() {
  if (!merge) return;
  for (const h of merge.hunks) {
    if (h.kind !== 'auto' && h.kind !== 'conflict' && h.kind !== 'equal') continue;
    const range = merge.resultTracker.getRange(h.id);
    if (!range) continue;
    const block = merge.resultTracker.readLines(h.id);
    const expected = buildPaneBlock(h, 'result', range.length);
    if (linesEqualArr(block, expected)) continue;
    // user edited inside this hunk 鈥?strip trailing pad-empties beyond original content
    let last = block.length;
    while (last > h.resolvedLines.length && block[last - 1] === '') last--;
    h.userEdited = true;
    h.resolvedLines = block.slice(0, last);
  }
}

function refreshMergeLayout(changedResultHunks?: readonly number[]) {
  if (!merge) return;
  // Preserve result-pane cursor + scroll across programmatic updates 鈥?without this,
  // every Apply / Ignore / Magic click jumps the user back to (1,1).
  const savedPos = merge.result.editor.getPosition();
  const savedScrollTop = merge.result.editor.getScrollTop();
  const built = buildAlignedThree(merge.hunks);
  programmaticEdit = true;
  try {
    const uniqueChanged = changedResultHunks ? Array.from(new Set(changedResultHunks)) : [];
    const canPatchAll = uniqueChanged.length > 0
      && uniqueChanged.every((hunkId) =>
        merge!.localTracker.getRange(hunkId)
        && merge!.resultTracker.getRange(hunkId)
        && merge!.remoteTracker.getRange(hunkId)
        && built.ranges.get(hunkId)
      );
    const resultModel = merge.result.editor.getModel()!;
    if (canPatchAll) {
      const targets = uniqueChanged
        .map((hunkId) => ({ hunkId, range: merge!.resultTracker.getRange(hunkId)! }))
        .sort((left, right) => right.range.start - left.range.start);
      for (const { hunkId } of targets) {
        const hunk = merge.hunks.find((item) => item.id === hunkId);
        const nextRanges = built.ranges.get(hunkId);
        if (!hunk || !nextRanges) continue;
        merge.localTracker.replaceLines(hunkId, buildPaneBlock(hunk, 'local', nextRanges.local.length));
        merge.resultTracker.replaceLines(hunkId, buildPaneBlock(hunk, 'result', nextRanges.result.length));
        merge.remoteTracker.replaceLines(hunkId, buildPaneBlock(hunk, 'remote', nextRanges.remote.length));
      }
    } else {
      const localModel = merge.local.editor.getModel()!;
      const remoteModel = merge.remote.editor.getModel()!;
      merge.local.editor.executeEdits('git-merge-rebuild', [
        { range: localModel.getFullModelRange(), text: built.local, forceMoveMarkers: true }
      ]);
      merge.result.editor.executeEdits('git-merge-rebuild', [
        { range: resultModel.getFullModelRange(), text: built.result, forceMoveMarkers: true }
      ]);
      merge.remote.editor.executeEdits('git-merge-rebuild', [
        { range: remoteModel.getFullModelRange(), text: built.remote, forceMoveMarkers: true }
      ]);
    }
    merge.ranges = built.ranges;
    // Explicit moveChangesAfterInsertion equivalent: after local edits have
    // changed block heights, re-anchor every pane to the freshly aligned ranges.
    merge.localTracker.reset(extractPaneRanges(built.ranges, 'local'));
    merge.resultTracker.reset(extractPaneRanges(built.ranges, 'result'));
    merge.remoteTracker.reset(extractPaneRanges(built.ranges, 'remote'));
    syncResultRangesIntoHunks();
    if (savedPos) {
      const lineCount = resultModel.getLineCount();
      const targetLine = Math.min(savedPos.lineNumber, lineCount);
      const targetCol = Math.min(savedPos.column, resultModel.getLineMaxColumn(targetLine));
      merge.result.editor.setPosition({ lineNumber: targetLine, column: targetCol });
    }
    merge.result.editor.setScrollTop(savedScrollTop);
  } finally {
    programmaticEdit = false;
  }
  decorateMerge();
  updateRibbonsFn?.();
}

function formatTitle(msg: { filePath: string; files: string[]; fileIndex: number }): string {
  if (msg.files.length > 1) {
    return `${msg.filePath}  (${msg.fileIndex + 1}/${msg.files.length})`;
  }
  return msg.filePath;
}

function requestSwitchFile(direction: 1 | -1) {
  if (!merge) return;
  const target = merge.fileIndex + direction;
  if (target < 0 || target >= merge.files.length) return;
  vscode.postMessage({ type: 'switchMergeFile', direction, dirty });
}

function navigateMerge(dir: 1 | -1) {
  if (!merge) return;
  const conflicts = merge.hunks.filter((h) => h.kind === 'conflict');
  const cur = merge.result.editor.getPosition()?.lineNumber ?? 1;
  const ordered = dir === 1 ? conflicts : conflicts.slice().reverse();
  const next = conflicts.length
    ? ordered.find((h) => {
      const r = getTrackedRanges(h.id).result;
      return dir === 1 ? r.start > cur : r.start < cur;
    })
    : undefined;
  if (next) {
    const r = getTrackedRanges(next.id).result;
    merge.result.editor.revealLineInCenter(r.start);
    merge.result.editor.setPosition({ lineNumber: r.start, column: 1 });
    merge.result.editor.focus();
    return;
  }
  // No more conflicts in this direction: cross to next/prev conflicted file.
  requestSwitchFile(dir);
}

function syncScroll(source: monaco.editor.IStandaloneCodeEditor, others: monaco.editor.IStandaloneCodeEditor[]) {
  source.onDidScrollChange((e) => {
    if (!autoScrollEnabled) return;
    if (suppressScroll) return;
    suppressScroll = true;
    for (const o of others) o.setScrollTop(e.scrollTop);
    suppressScroll = false;
  });
}

function syncIgnoreWSSelect(value: string) {
  const sel = document.getElementById('mergeIgnoreWS') as HTMLSelectElement | null;
  if (sel) sel.value = value;
}

function captureAutoResolved(hunks: MergeChange[]) {
  autoResolved = new Map();
  for (const h of hunks) {
    if (h.kind === 'auto') autoResolved.set(h.id, (h.autoResolvedLines ?? h.resolvedLines).slice());
  }
}

function applyAutoMergedNonConflictsTo(hunks: MergeChange[]) {
  let changed = false;
  for (const h of hunks) {
    if (h.kind !== 'auto') continue;
    const resolved = h.autoResolvedLines ?? autoResolved.get(h.id);
    if (!resolved || linesEqualArr(h.resolvedLines, resolved)) continue;
    h.resolvedLines = resolved.slice();
    h.status = 'manual';
    h.resolved = [true, true];
    h.lastAppliedSnapshot = h.resolvedLines.slice();
    changed = true;
  }
  return changed;
}

function setModifierShift(value: boolean) {
  if (modifierShift === value) return;
  modifierShift = value;
  decorateMerge();
}

function autoResolveImportChangesTo(hunks: MergeChange[]) {
  let changed = false;
  const model = new MergeConflictModel(hunks);
  for (const h of hunks) {
    if (!h.isImportChange || isResolved(h)) continue;
    if (!isImportBlock(h.localLines) && !isImportBlock(h.remoteLines)) continue;
    model.replaceWithNewContent(h, mergeImportBlocks(h.localLines, h.baseLines, h.remoteLines), 'accepted-both');
    model.markChangeResolved(h);
    changed = true;
  }
  return changed;
}

function syncResultRangesIntoHunks(): void {
  if (!merge) return;
  for (const hunk of merge.hunks) {
    hunk.resultRange = getTrackedRanges(hunk.id).result;
  }
}

function currentHunkForPane(pane: MergeActionPane): MergeChange | undefined {
  if (pane === 'result') return currentResultChangeHunk();
  return currentSideChangeHunk(pane);
}

function selectedHunkIdsForPane(pane: MergeActionPane): number[] {
  if (!merge) return [];
  if (pane === 'result') return hunksInResultSelection().map((h) => h.id);
  const editor = pane === 'local' ? merge.local.editor : merge.remote.editor;
  return hunksInSideSelection(editor, pane).map((h) => h.id);
}

function runAdditionalMergeAction(action: MergeAdditionalActionDescriptor, pane: MergeActionPane): void {
  if (!merge) return;
  vscode.postMessage({
    type: 'runAdditionalMergeAction',
    actionId: action.id,
    pane,
    filePath: merge.filePath,
    language: merge.language,
    ignoreWS: merge.ignoreWS,
    selectedHunkIds: selectedHunkIdsForPane(pane),
    currentHunkId: currentHunkForPane(pane)?.id
  });
}

function registerMergeContextActions(
  local: monaco.editor.IStandaloneCodeEditor,
  result: monaco.editor.IStandaloneCodeEditor,
  remote: monaco.editor.IStandaloneCodeEditor,
  additionalActions: readonly MergeAdditionalActionDescriptor[] = []
): void {
  local.addAction({
    id: 'git-diff-fast.apply-local-changes',
    label: 'Apply Local Change(s)',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 1,
    run: () => applySelectedSideChanges(local, 'local')
  });
  local.addAction({
    id: 'git-diff-fast.ignore-local-changes',
    label: 'Ignore Local Change(s)',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 2,
    run: () => ignoreSelectedSideChanges(local, 'local')
  });
  remote.addAction({
    id: 'git-diff-fast.apply-remote-changes',
    label: 'Apply Remote Change(s)',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 1,
    run: () => applySelectedSideChanges(remote, 'remote')
  });
  remote.addAction({
    id: 'git-diff-fast.ignore-remote-changes',
    label: 'Ignore Remote Change(s)',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 2,
    run: () => ignoreSelectedSideChanges(remote, 'remote')
  });
  result.addAction({
    id: 'git-diff-fast.magic-resolve-changes',
    label: 'Magic Resolve Conflict(s)',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 1,
    run: () => magicResolveSelectedConflicts()
  });
  result.addAction({
    id: 'git-diff-fast.ignore-changes',
    label: 'Ignore Change(s)',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 2,
    run: () => ignoreSelectedResultChanges()
  });
  result.addAction({
    id: 'git-diff-fast.reset-change',
    label: 'Reset Change to Base',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 3,
    run: () => {
      const h = currentResultChangeHunk();
      if (h) executeMergeCommand('Reset Change', () => resetResolvedChange(h, true));
    }
  });

  for (const action of additionalActions) {
    const panes = action.pane === 'all' || !action.pane
      ? (['local', 'result', 'remote'] as MergeActionPane[])
      : [action.pane];
    for (const pane of panes) {
      const editor = pane === 'local' ? local : pane === 'result' ? result : remote;
      editor.addAction({
        id: `git-diff-fast.additional.${action.id}.${pane}`,
        label: action.label,
        contextMenuGroupId: action.contextMenuGroupId ?? '2_additional',
        contextMenuOrder: action.contextMenuOrder ?? 1,
        run: () => runAdditionalMergeAction(action, pane)
      });
    }
  }
}

export function initMerge(msg: InitMergeMessage) {
  setMode('merge');

  // Re-init for a different file: reuse existing editors, just swap state.
  if (merge) {
    captureAutoResolved(msg.hunks);
    if (msg.autoApplyNonConflicts) applyAutoMergedNonConflictsTo(msg.hunks);
    if (msg.autoResolveImports) autoResolveImportChangesTo(msg.hunks);
    merge.hunks = msg.hunks;
    merge.model = new MergeConflictModel(msg.hunks);
    merge.filePath = msg.filePath;
    merge.language = msg.language;
    merge.localText = msg.local;
    merge.baseText = msg.base;
    merge.remoteText = msg.remote;
    merge.files = msg.files;
    merge.fileIndex = msg.fileIndex;
    merge.ignoreWS = msg.ignoreWS;
    merge.additionalActions = msg.additionalActions;
    autoScrollEnabled = msg.autoScrollEnabled;
    dirty = false;
    prevPendingCount = -1; // reset so the "all resolved" toast fires correctly per file
    setText('title', formatTitle(msg));
    syncIgnoreWSSelect(msg.ignoreWS);
    updateAutoScrollToggle();
    refreshMergeLayout();
    resetMergeHistory();
    return;
  }

  captureAutoResolved(msg.hunks);
  if (msg.autoApplyNonConflicts) applyAutoMergedNonConflictsTo(msg.hunks);
  if (msg.autoResolveImports) autoResolveImportChangesTo(msg.hunks);
  const built = buildAlignedThree(msg.hunks);
  const local = makeEditor(byId('local'), built.local, msg.language, true);
  const result = makeEditor(byId('result'), built.result, msg.language, false);
  const remote = makeEditor(byId('remote'), built.remote, msg.language, true);
  registerMergeContextActions(local, result, remote, msg.additionalActions);
  const localTracker = new MergeLineTracker(local);
  const resultTracker = new MergeLineTracker(result);
  const remoteTracker = new MergeLineTracker(remote);
  merge = {
    hunks: msg.hunks, filePath: msg.filePath, language: msg.language,
    local: { editor: local, decorations: [] },
    result: { editor: result, decorations: [] },
    remote: { editor: remote, decorations: [] },
    ranges: built.ranges,
    localTracker,
    resultTracker,
    remoteTracker,
    model: new MergeConflictModel(msg.hunks),
    localText: msg.local,
    baseText: msg.base,
    remoteText: msg.remote,
    files: msg.files,
    fileIndex: msg.fileIndex,
    ignoreWS: msg.ignoreWS,
    additionalActions: msg.additionalActions
  };
  merge.localTracker.reset(extractPaneRanges(built.ranges, 'local'));
  merge.resultTracker.reset(extractPaneRanges(built.ranges, 'result'));
  merge.remoteTracker.reset(extractPaneRanges(built.ranges, 'remote'));
  autoScrollEnabled = msg.autoScrollEnabled;
  syncResultRangesIntoHunks();
  setText('title', formatTitle(msg));
  syncScroll(local, [result, remote]);
  syncScroll(result, [local, remote]);
  syncScroll(remote, [local, result]);

  local.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber; if (!line) return;
    const h = findHunkAtLine('local', line);
    if (h) {
      const resolveChange = e.event.ctrlKey || e.event.metaKey;
      if (e.event.shiftKey) executeMergeCommand('Ignore Left Change', () => handleIgnoreClick(h, 'local', resolveChange));
      else if (h.kind === 'conflict') executeMergeCommand('Apply Left Change', () => handleConflictClick(h, 'local', resolveChange));
      else executeMergeCommand('Apply Left Change', () => handleAutoApplyClick(h, 'local'));
    }
  });
  remote.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber; if (!line) return;
    const h = findHunkAtLine('remote', line);
    if (h) {
      const resolveChange = e.event.ctrlKey || e.event.metaKey;
      if (e.event.shiftKey) executeMergeCommand('Ignore Right Change', () => handleIgnoreClick(h, 'remote', resolveChange));
      else if (h.kind === 'conflict') executeMergeCommand('Apply Right Change', () => handleConflictClick(h, 'remote', resolveChange));
      else executeMergeCommand('Apply Right Change', () => handleAutoApplyClick(h, 'remote'));
    }
  });
  // BASE column gutter click: magic-resolve a single conflict.
  result.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber; if (!line) return;
    const hunkId = magicGutterByLine.get(line);
    if (hunkId === undefined || !merge) return;
    executeMergeCommand('Magic Resolve Change', () => {
      const h = merge?.hunks.find((x) => x.id === hunkId);
      if (!h || h.kind !== 'conflict' || h.status !== 'pending') return;
      syncResultEditsFromTracker();
      if (resolveChangeAutomatically(h, 'base')) refreshMergeLayout([h.id]);
    });
  });

  result.getModel()!.onDidChangeContent((event) => {
    if (programmaticEdit) { updateMergeCounter(); return; }
    dirty = true;
    const affected = merge?.resultTracker.applyContentChanges(event.changes.map((change) => ({
      startLineNumber: change.range.startLineNumber,
      endLineNumber: change.range.endLineNumber,
      text: change.text,
    }))) ?? [];
    for (const item of affected) {
      const hunk = merge?.hunks.find((h) => h.id === item.hunkId);
      if (hunk && (item.intersects || item.damaged)) hunk.userEdited = true;
    }
    syncResultEditsFromTracker();
    recordManualEdit();
    updateMergeCounter();
    if (decorateRaf) cancelAnimationFrame(decorateRaf);
    decorateRaf = requestAnimationFrame(() => { decorateRaf = 0; decorateMerge(); });
  });
  decorateMerge();
  resetMergeHistory();

  // Ribbon
  const overlay = byId('ribbonOverlay');
  ribbonLR = new Ribbon(overlay);
  ribbonRR = new Ribbon(overlay);
  const updateRibbons = () => {
    if (!merge) return;
    const localDom = byId('local').querySelector('.editor') as HTMLElement ?? byId('local');
    const resultDom = byId('result').querySelector('.editor') as HTMLElement ?? byId('result');
    const remoteDom = byId('remote').querySelector('.editor') as HTMLElement ?? byId('remote');
    const hunkData = merge.hunks
      .filter((h) => h.kind !== 'equal')
      .map((h) => {
        const r = getTrackedRanges(h.id);
        return { id: h.id, kind: h.kind, left: r.local, right: r.result };
      });
    ribbonLR?.update(localDom, resultDom, hunkData);
    const hunkData2 = merge.hunks
      .filter((h) => h.kind !== 'equal')
      .map((h) => {
        const r = getTrackedRanges(h.id);
        return { id: h.id, kind: h.kind, left: r.result, right: r.remote };
      });
    ribbonRR?.update(resultDom, remoteDom, hunkData2);
  };
  updateRibbonsFn = updateRibbons;
  local.onDidScrollChange(() => updateRibbons());
  result.onDidScrollChange(() => updateRibbons());
  remote.onDidScrollChange(() => updateRibbons());
  window.addEventListener('resize', () => updateRibbons());
  setTimeout(updateRibbons, 100);

  // Keyboard shortcuts (active when webview has focus)
  window.addEventListener('keydown', (e) => {
    if (!merge) return;
    const key = e.key.toLowerCase();
    const commandKey = e.ctrlKey || e.metaKey;
    if (commandKey && !e.altKey && key === 'z') {
      const handled = e.shiftKey ? redoMergeCommand() : undoMergeCommand();
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    } else if (commandKey && !e.altKey && key === 'y') {
      if (redoMergeCommand()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (e.key === 'Escape' && document.getElementById('partialDiffModal')) {
      e.preventDefault();
      closePartialCompare();
      return;
    }
    setModifierShift(e.shiftKey);
    if (e.key === 'F7' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); navigateMerge(1);
    } else if (e.key === 'F7' && e.shiftKey) {
      e.preventDefault(); navigateMerge(-1);
    } else if (e.altKey && e.shiftKey && (e.key === ',' || e.key === '<')) {
      e.preventDefault();
      const cur = currentResultLineHunk();
      if (cur) executeMergeCommand('Apply Left Change', () => handleConflictClick(cur, 'local'));
    } else if (e.altKey && e.shiftKey && (e.key === '.' || e.key === '>')) {
      e.preventDefault();
      const cur = currentResultLineHunk();
      if (cur) executeMergeCommand('Apply Right Change', () => handleConflictClick(cur, 'remote'));
    }
  }, true);
  window.addEventListener('keyup', (e) => setModifierShift(e.shiftKey));
  window.addEventListener('blur', () => setModifierShift(false));

  byId('prev').onclick = () => navigateMerge(-1);
  byId('next').onclick = () => navigateMerge(1);
  const prevFileBtn = document.getElementById('prevFile') as HTMLButtonElement | null;
  const nextFileBtn = document.getElementById('nextFile') as HTMLButtonElement | null;
  if (prevFileBtn) prevFileBtn.onclick = () => requestSwitchFile(-1);
  if (nextFileBtn) nextFileBtn.onclick = () => requestSwitchFile(1);
  byId('applyL').onclick = () => executeMergeCommand('Apply Non-Conflicts From Left', () => applyNonConflicting('local'));
  byId('applyR').onclick = () => executeMergeCommand('Apply Non-Conflicts From Right', () => applyNonConflicting('remote'));
  byId('applyB').onclick = () => executeMergeCommand('Apply Non-Conflicts', () => applyNonConflicting('both'));
  byId('magic').onclick = () => executeMergeCommand('Magic Resolve', () => runMagicResolve());
  byId('compareContents').onclick = () => showCompareContents();
  const collapseBtn = document.getElementById('collapseUnchanged') as HTMLButtonElement | null;
  if (collapseBtn) {
    updateCollapseToggle();
    collapseBtn.onclick = () => {
      collapseUnchanged = !collapseUnchanged;
      applyCollapsedUnchangedAreas();
    };
  }
  const autoScrollBtn = document.getElementById('autoScroll') as HTMLButtonElement | null;
  if (autoScrollBtn) {
    updateAutoScrollToggle();
    autoScrollBtn.onclick = () => {
      autoScrollEnabled = !autoScrollEnabled;
      updateAutoScrollToggle();
    };
  }
  const granSelect = document.getElementById('mergeGranularity') as HTMLSelectElement | null;
  if (granSelect) {
    granSelect.value = mergeGranularity;
    granSelect.onchange = () => {
      mergeGranularity = granSelect.value as Granularity;
      decorateMerge();
    };
  }
  const wsSelect = document.getElementById('mergeIgnoreWS') as HTMLSelectElement | null;
  if (wsSelect) {
    syncIgnoreWSSelect(msg.ignoreWS);
    wsSelect.onchange = () => {
      vscode.postMessage({
        type: 'setMergeIgnoreWS',
        ignoreWS: wsSelect.value as 'none' | 'trim' | 'inner' | 'whole',
        dirty
      });
    };
    const compareModeSelect = document.getElementById('compareContentsMode') as HTMLSelectElement | null;
    if (compareModeSelect) {
      compareModeSelect.onchange = () => {
        if (isPartialCompareOpen()) showCompareContents();
      };
    }
  }
  byId('cancel').onclick = () => {
    vscode.postMessage({ type: 'finishMerge', result: 'CANCEL', dirty });
  };
  byId('accept').onclick = () => {
    if (!merge) return;
    const content = merge.result.editor.getValue();
    const unresolvedCount = merge.hunks.filter((h) => h.kind === 'conflict' && !isResolved(h)).length;
    dirty = false;
    vscode.postMessage({ type: 'finishMerge', result: 'RESOLVED', outputText: content, dirty: false, unresolvedCount });
  };
  const acceptLeftBtn = document.getElementById('acceptLeft');
  if (acceptLeftBtn) acceptLeftBtn.onclick = () => {
    vscode.postMessage({ type: 'finishMerge', result: 'LEFT', dirty });
  };
  const acceptRightBtn = document.getElementById('acceptRight');
  if (acceptRightBtn) acceptRightBtn.onclick = () => {
    vscode.postMessage({ type: 'finishMerge', result: 'RIGHT', dirty });
  };
}

export function getMergeState(): MergeState | null { return merge; }
