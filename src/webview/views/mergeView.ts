import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { Hunk, InitMergeMessage } from '../../types';
import { buildAlignedThree } from '../diff/align';
import type { LineRange } from '../diff/align';
import { byId, setText, setMode } from '../components/toolbar';
import { Ribbon } from '../components/ribbon';
import { wordDiff, wordTokenDiff, type Granularity } from '../diff/wordDiff';
import { tryResolveConflict } from '../../diff/conflictResolve';
import { vscode, getVsCodeTheme } from '../api';
import { isResolved, resetResolvedChangeState } from './mergeActions';
import { MergeLineTracker } from './mergeLineTracker';
import { MergeConflictModel } from './mergeModel';
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
  hunks: Hunk[];
  local: PaneCtx; result: PaneCtx; remote: PaneCtx;
  ranges: Map<number, { local: LineRange; result: LineRange; remote: LineRange }>;
  localTracker: MergeLineTracker;
  resultTracker: MergeLineTracker;
  remoteTracker: MergeLineTracker;
  model: MergeConflictModel;
  filePath: string;
  language: string;
  files: string[];
  fileIndex: number;
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
const mergeUndoStack = new MergeUndoStack();
let lastMergeSnapshot: MergeSnapshot | null = null;
// Snapshot of each auto hunk's IDEA auto-merged content. The visible result
// starts from BASE and may opt into these lines during initialization.
let autoResolved: Map<number, string[]> = new Map();

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
// conflictType.resolutionStrategy is TEXT (matches IDEA design.md §8 inline
// resolveRenderer).
const magicGutterByLine = new Map<number, number>(); // result line → hunk id

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
      const cls = h.status === 'pending' ? 'hunk-conflict-pending' : 'hunk-resolved';
      // IDEA design.md §7.6 glyph table:
      //   pending          → unresolved sides show »/« (Apply, replaces result)
      //   Shift held       → unresolved sides show × (Ignore)
      //   one-side applied → applied side has NO glyph; opposite side shows ↓ (Append)
      //   fully resolved   → both sides have NO glyph
      const resolved = h.resolved ?? [false, false];
      const fullyResolved = resolved[0] && resolved[1];
      let leftGlyph: string | undefined;
      let rightGlyph: string | undefined;
      if (fullyResolved) {
        leftGlyph = undefined;
        rightGlyph = undefined;
      } else if (modifierShift) {
        leftGlyph = resolved[0] ? undefined : 'action-glyph revert';
        rightGlyph = resolved[1] ? undefined : 'action-glyph revert';
      } else if (h.isOnesideAppliedConflict) {
        // Exactly one side is already applied — the other side's glyph
        // becomes "↓ append".
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
      const stripeColor = h.status === 'pending' ? 'rgba(232,118,0,.8)' : 'rgba(98,150,85,.5)';
      ld.push(stripeFor(r.local, stripeColor));
      remd.push(stripeFor(r.remote, stripeColor));
      // Intra-line word diff for pending conflicts
      if (h.status === 'pending' && mergeGranularity !== 'line') {
        const max = Math.min(h.localLines.length, h.remoteLines.length);
        const fn = mergeGranularity === 'word' ? wordTokenDiff : wordDiff;
        for (let i = 0; i < max; i++) {
          const wd = fn(h.localLines[i] ?? '', h.remoteLines[i] ?? '');
          for (const cr of wd.left) {
            ld.push({
              range: new monaco.Range(r.local.start + i, cr.start + 1, r.local.start + i, cr.end + 1),
              options: { className: 'word-diff' }
            });
          }
          for (const cr of wd.right) {
            remd.push({
              range: new monaco.Range(r.remote.start + i, cr.start + 1, r.remote.start + i, cr.end + 1),
              options: { className: 'word-diff' }
            });
          }
        }
      }
    }
  }
  merge.local.decorations = merge.local.editor.deltaDecorations(merge.local.decorations, ld);
  merge.result.decorations = merge.result.editor.deltaDecorations(merge.result.decorations, rd);
  merge.remote.decorations = merge.remote.editor.deltaDecorations(merge.remote.decorations, remd);
  updateMergeCounter();
}

// Once all conflicts are processed for this file we want a one-shot
// celebratory toast — mirrors IDEA's "merge.all.changes.processed" bubble
// (design.md §3.5). Tracks the previous-pending count so we only fire on the
// 1→0 transition, not on every re-render.
let prevPendingCount = -1;

function updateMergeCounter() {
  if (!merge) return;
  const pending = merge.hunks.filter((h) => h.kind === 'conflict' && h.status === 'pending').length;
  const changes = merge.hunks.filter((h) => h.kind === 'conflict' || h.kind === 'auto').length;
  setText(
    'counter',
    `${changes} change${changes === 1 ? '' : 's'}. ${pending} conflict${pending === 1 ? '' : 's'}.`
  );
  const acceptBtn = document.getElementById('accept') as HTMLButtonElement;
  if (acceptBtn) {
    acceptBtn.disabled = pending > 0;
    acceptBtn.title = pending > 0 ? `${pending} unresolved conflict${pending === 1 ? '' : 's'} remaining` : 'Accept merge and stage file';
  }
  const prevFileBtn = document.getElementById('prevFile') as HTMLButtonElement | null;
  const nextFileBtn = document.getElementById('nextFile') as HTMLButtonElement | null;
  if (prevFileBtn) prevFileBtn.disabled = merge.fileIndex <= 0;
  if (nextFileBtn) nextFileBtn.disabled = merge.fileIndex >= merge.files.length - 1;

  // Edge-trigger when conflicts go from N>0 to 0 — flash the counter so the
  // user knows they can now Accept.
  const counter = document.getElementById('counter');
  if (counter) {
    if (prevPendingCount > 0 && pending === 0) {
      counter.classList.add('all-resolved');
      counter.textContent = `✓ All changes processed.`;
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

function buildPaneBlock(hunk: Hunk, pane: 'local' | 'result' | 'remote', length: number): string[] {
  const source = pane === 'local' ? hunk.localLines : pane === 'remote' ? hunk.remoteLines : hunk.resolvedLines;
  const out = source.slice();
  while (out.length < length) out.push('');
  return out;
}

function findHunkAtLine(side: 'local' | 'remote', line: number): Hunk | undefined {
  if (!merge) return;
  for (const h of merge.hunks) {
    if (h.kind !== 'conflict' && !isSideChanged(h, side)) continue;
    const r = merge.ranges.get(h.id)![side];
    if (line >= r.start && line < r.start + Math.max(r.length, 1)) return h;
  }
}

function currentResultLineHunk(): Hunk | undefined {
  if (!merge) return;
  const line = merge.result.editor.getPosition()?.lineNumber ?? 1;
  for (const h of merge.hunks) {
    if (h.kind !== 'conflict') continue;
    const r = getTrackedRanges(h.id).result;
    if (line >= r.start && line < r.start + Math.max(r.length, 1)) return h;
  }
  return merge.hunks.find((h) => h.kind === 'conflict' && h.status === 'pending');
}

function currentResultChangeHunk(): Hunk | undefined {
  if (!merge) return;
  const line = merge.result.editor.getPosition()?.lineNumber ?? 1;
  for (const h of merge.hunks) {
    if (h.kind !== 'auto' && h.kind !== 'conflict') continue;
    const r = getTrackedRanges(h.id).result;
    if (line >= r.start && line < r.start + Math.max(r.length, 1)) return h;
  }
}

function currentSideChangeHunk(side: 'local' | 'remote'): Hunk | undefined {
  if (!merge) return;
  const editor = side === 'local' ? merge.local.editor : merge.remote.editor;
  const line = editor.getPosition()?.lineNumber ?? 1;
  return findHunkAtLine(side, line);
}

export function getResultContent(): string {
  return merge?.result.editor.getValue() ?? '';
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
// IDEA semantics — MergeConflictModel.replaceChange (design.md §7.4):
//   1. If THIS side is already resolved → no-op (return). IDEA does NOT
//      support clicking the arrow to revert; revert goes through Undo or
//      a separate Reset action.
//   2. If THIS side has no change vs base (fragment empty) → simply mark
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
function handleConflictClick(hunk: Hunk, side: 'local' | 'remote', resolveChange: boolean = false) {
  if (!merge || hunk.kind !== 'conflict') return;
  syncResultEditsFromTracker();
  if (!hunk.resolved) hunk.resolved = [false, false];
  const sideIdx = side === 'local' ? 0 : 1;
  const oppositeIdx = 1 - sideIdx;
  const isAlreadyResolvedHere = hunk.resolved[sideIdx];

  // (1) Clicking on an already-resolved side: ignore (matches IDEA).
  if (isAlreadyResolvedHere && !resolveChange) return;

  const sourceLines = side === 'local' ? hunk.localLines : hunk.remoteLines;
  const oppositeLines = side === 'local' ? hunk.remoteLines : hunk.localLines;
  const oppositeIsEmpty = oppositeLines.length === 0;

  // (5) Ctrl+Click → replace + full-resolve, drop opposite content.
  if (resolveChange) {
    hunk.resolvedLines = sourceLines.slice();
    hunk.resolved = [true, true];
    hunk.isOnesideAppliedConflict = false;
    hunk.status = side === 'local' ? 'accepted-local' : 'accepted-remote';
  } else if (hunk.isOnesideAppliedConflict) {
    // (4) Apply Both second step: append in click order.
    hunk.resolvedLines = [...hunk.resolvedLines, ...sourceLines];
    hunk.resolved = [true, true];
    hunk.isOnesideAppliedConflict = false;
    hunk.status = 'accepted-both';
  } else {
    // (3) First Apply: replace BASE with this side's content.
    hunk.resolvedLines = sourceLines.slice();
    hunk.resolved[sideIdx] = true;
    hunk.status = side === 'local' ? 'accepted-local' : 'accepted-remote';

    // (6) Opposite side fragment is empty or already ignored/resolved →
    // nothing to append; full-resolve.
    if (hunk.resolved[oppositeIdx] || oppositeIsEmpty) {
      hunk.resolved[oppositeIdx] = true;
      hunk.isOnesideAppliedConflict = false;
    } else {
      hunk.isOnesideAppliedConflict = true;
    }
  }
  hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
  hunk.isResolvedWithAI = false;
  hunk.userEdited = false;
  refreshMergeLayout([hunk.id]);
}

function sideIndex(side: 'local' | 'remote') {
  return side === 'local' ? 0 : 1;
}

function getSideLines(hunk: Hunk, side: 'local' | 'remote') {
  return side === 'local' ? hunk.localLines : hunk.remoteLines;
}

function isSideChanged(hunk: Hunk, side: 'local' | 'remote') {
  if (hunk.kind === 'conflict') return true;
  if (hunk.kind !== 'auto' || !hunk.conflictType) return false;
  return side === 'local' ? hunk.conflictType.leftChange : hunk.conflictType.rightChange;
}

function handleAutoApplyClick(hunk: Hunk, side: 'local' | 'remote') {
  if (!merge || hunk.kind !== 'auto' || !isSideChanged(hunk, side)) return;
  syncResultEditsFromTracker();
  const resolved = hunk.resolved ?? [false, false];
  if (resolved[0] && resolved[1]) return;
  hunk.resolvedLines = getSideLines(hunk, side).slice();
  hunk.resolved = [true, true];
  hunk.isOnesideAppliedConflict = false;
  hunk.status = side === 'local' ? 'accepted-local' : 'accepted-remote';
  hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
  hunk.isResolvedWithAI = false;
  hunk.userEdited = false;
  refreshMergeLayout([hunk.id]);
}

function handleIgnoreClick(hunk: Hunk, side: 'local' | 'remote', resolveChange: boolean = false) {
  if (!merge) return;
  syncResultEditsFromTracker();
  if (!hunk.resolved) hunk.resolved = [false, false];
  const sideIdx = sideIndex(side);
  if (hunk.resolved[sideIdx] && !resolveChange) return;

  if (hunk.kind !== 'conflict') {
    hunk.resolved = [true, true];
    hunk.status = 'manual';
  } else {
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
  }

  hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
  refreshMergeLayout([hunk.id]);
}

function isChangeRangeModified(hunk: Hunk): boolean {
  return !linesEqualArr(hunk.resolvedLines, hunk.baseLines);
}

function canResolveChangeAutomatically(hunk: Hunk, side: 'local' | 'remote' | 'base'): boolean {
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

function resolveChangeAutomatically(hunk: Hunk, side: 'local' | 'remote' | 'base'): boolean {
  if (!canResolveChangeAutomatically(hunk, side)) return false;

  if (hunk.kind === 'conflict') {
    if (hunk.conflictType?.resolutionStrategy === 'SEMANTIC') return false;
    const merged = tryResolveConflict(hunk.localLines, hunk.baseLines, hunk.remoteLines);
    if (!merged) return false;
    hunk.resolvedLines = merged;
    hunk.status = 'accepted-both';
  } else {
    const effectiveSide = side === 'base'
      ? (isSideChanged(hunk, 'local') ? 'local' : 'remote')
      : side;
    hunk.resolvedLines = getSideLines(hunk, effectiveSide).slice();
    hunk.status = effectiveSide === 'local' ? 'accepted-local' : 'accepted-remote';
  }

  hunk.resolved = [true, true];
  hunk.isOnesideAppliedConflict = false;
  hunk.isResolvedWithAI = false;
  hunk.lastAppliedSnapshot = hunk.resolvedLines.slice();
  hunk.userEdited = false;
  return true;
}

function resetResolvedChange(hunk: Hunk, force = false): boolean {
  syncResultEditsFromTracker();
  if (!resetResolvedChangeState(hunk, force)) return false;
  refreshMergeLayout([hunk.id]);
  return true;
}

// IDEA semantics:
//   Apply All Non-Conflicting → same as Apply Non-Conflicts From Left
//     (IDEA's BASE toolbar action uses masterSide=LEFT).
//   Apply Left Non-Conflicting → for auto hunks where local changed vs base, use localLines;
//     hunks that are remote-only changes are left as-is.
//   Apply Right Non-Conflicting → mirror of left.
function applyNonConflicting(side: 'local' | 'remote' | 'both') {
  if (!merge) return;
  const effectiveSide = side === 'both' ? 'local' : side;
  // Capture user edits first so we can skip user-edited hunks per
  // IDEA's canResolveChangeAutomatically (design.md §6.3).
  syncResultEditsFromTracker();
  let changed = false;
  const changedHunks: number[] = [];
  for (const h of merge.hunks) {
    if (h.kind !== 'auto') continue;
    if (!h.conflictType) continue;
    if ((h.resolved?.[0] ?? false) && (h.resolved?.[1] ?? false)) continue;
    if (isChangeRangeModified(h)) continue;
    // IDEA semantics (design.md §6.2): for "Apply Non-Conflicts From Left",
    // pick masterSide=LEFT only when the hunk has a leftChange. Composite auto
    // hunks (built by buildThreeWayHunksByLine) lack a single conflictType
    // — fall back to a per-line content compare against base.
    const ct = h.conflictType;
    const sideChanged = effectiveSide === 'local' ? ct.leftChange : ct.rightChange;
    if (!sideChanged) continue;
    if (resolveChangeAutomatically(h, effectiveSide)) {
      changed = true;
      changedHunks.push(h.id);
    }
  }
  if (changed) refreshMergeLayout(changedHunks);
}

const IMPORT_LINE = /^\s*(?:import\b|from\s+\S+\s+import\b|#include\b|using\s+\w+\b|require\s*\()/;
const stripWS = (s: string) => s.replace(/\s+/g, '');

function runMagicResolve() {
  if (!merge) return;
  syncResultEditsFromTracker();
  let resolved = 0;
  const changedHunks: number[] = [];
  for (const h of merge.hunks) {
    if (h.kind !== 'conflict' || h.status !== 'pending') continue;
    if (isChangeRangeModified(h)) continue;
    // Whitespace-only difference → keep local
    const an = h.localLines.map(stripWS).filter((l) => l.length > 0);
    const bn = h.remoteLines.map(stripWS).filter((l) => l.length > 0);
    if (an.length === bn.length && an.every((v, i) => v === bn[i])) {
      h.resolvedLines = h.localLines.slice();
      h.status = 'accepted-local';
      h.resolved = [true, true];
      h.isOnesideAppliedConflict = false;
      h.isResolvedWithAI = false;
      h.lastAppliedSnapshot = h.resolvedLines.slice();
      h.userEdited = false;
      resolved++;
      changedHunks.push(h.id);
      continue;
    }
    // Pure import-block conflict → sorted union
    const allImport = (lines: string[]) => {
      const m = lines.filter((l) => l.trim().length > 0);
      return m.length > 0 && m.every((l) => IMPORT_LINE.test(l));
    };
    if (allImport(h.localLines) && allImport(h.remoteLines)) {
      h.resolvedLines = Array.from(new Set([...h.localLines, ...h.remoteLines]))
        .filter((l) => l.trim().length > 0)
        .sort();
      h.status = 'accepted-both';
      h.resolved = [true, true];
      h.isOnesideAppliedConflict = false;
      h.lastAppliedSnapshot = h.resolvedLines.slice();
      h.userEdited = false;
      resolved++;
      changedHunks.push(h.id);
      continue;
    }
    if (resolveChangeAutomatically(h, 'base')) {
      resolved++;
      changedHunks.push(h.id);
    }
  }
  if (resolved > 0) refreshMergeLayout(changedHunks);
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
    // user edited inside this hunk — strip trailing pad-empties beyond original content
    let last = block.length;
    while (last > h.resolvedLines.length && block[last - 1] === '') last--;
    h.userEdited = true;
    h.resolvedLines = block.slice(0, last);
  }
}

function linesEqualArr(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function refreshMergeLayout(changedResultHunks?: readonly number[]) {
  if (!merge) return;
  // Preserve result-pane cursor + scroll across programmatic updates — without this,
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
  // No more conflicts in this direction → cross to next/prev conflicted file.
  requestSwitchFile(dir);
}

function syncScroll(source: monaco.editor.IStandaloneCodeEditor, others: monaco.editor.IStandaloneCodeEditor[]) {
  source.onDidScrollChange((e) => {
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

function captureAutoResolved(hunks: Hunk[]) {
  autoResolved = new Map();
  for (const h of hunks) {
    if (h.kind === 'auto') autoResolved.set(h.id, (h.autoResolvedLines ?? h.resolvedLines).slice());
  }
}

function applyAutoMergedNonConflictsTo(hunks: Hunk[]) {
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

function registerMergeContextActions(
  local: monaco.editor.IStandaloneCodeEditor,
  result: monaco.editor.IStandaloneCodeEditor,
  remote: monaco.editor.IStandaloneCodeEditor
): void {
  local.addAction({
    id: 'git-diff-fast.apply-local-change',
    label: 'Apply Local Change',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 1,
    run: () => {
      const h = currentSideChangeHunk('local');
      if (!h) return;
      executeMergeCommand('Apply Left Change', () => {
        if (h.kind === 'conflict') handleConflictClick(h, 'local');
        else handleAutoApplyClick(h, 'local');
      });
    }
  });
  local.addAction({
    id: 'git-diff-fast.ignore-local-change',
    label: 'Ignore Local Change',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 2,
    run: () => {
      const h = currentSideChangeHunk('local');
      if (h) executeMergeCommand('Ignore Left Change', () => handleIgnoreClick(h, 'local'));
    }
  });
  remote.addAction({
    id: 'git-diff-fast.apply-remote-change',
    label: 'Apply Remote Change',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 1,
    run: () => {
      const h = currentSideChangeHunk('remote');
      if (!h) return;
      executeMergeCommand('Apply Right Change', () => {
        if (h.kind === 'conflict') handleConflictClick(h, 'remote');
        else handleAutoApplyClick(h, 'remote');
      });
    }
  });
  remote.addAction({
    id: 'git-diff-fast.ignore-remote-change',
    label: 'Ignore Remote Change',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 2,
    run: () => {
      const h = currentSideChangeHunk('remote');
      if (h) executeMergeCommand('Ignore Right Change', () => handleIgnoreClick(h, 'remote'));
    }
  });
  result.addAction({
    id: 'git-diff-fast.magic-resolve-change',
    label: 'Magic Resolve Change',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 1,
    run: () => {
      const h = currentResultChangeHunk();
      if (h) executeMergeCommand('Magic Resolve Change', () => {
        syncResultEditsFromTracker();
        if (resolveChangeAutomatically(h, 'base')) refreshMergeLayout([h.id]);
      });
    }
  });
  result.addAction({
    id: 'git-diff-fast.reset-change',
    label: 'Reset Change to Base',
    contextMenuGroupId: '1_modification',
    contextMenuOrder: 2,
    run: () => {
      const h = currentResultChangeHunk();
      if (h) executeMergeCommand('Reset Change', () => resetResolvedChange(h, true));
    }
  });
}

export function initMerge(msg: InitMergeMessage) {
  setMode('merge');

  // Re-init for a different file: reuse existing editors, just swap state.
  if (merge) {
    captureAutoResolved(msg.hunks);
    if (msg.autoApplyNonConflicts) applyAutoMergedNonConflictsTo(msg.hunks);
    merge.hunks = msg.hunks;
    merge.model = new MergeConflictModel(msg.hunks);
    merge.filePath = msg.filePath;
    merge.language = msg.language;
    merge.files = msg.files;
    merge.fileIndex = msg.fileIndex;
    dirty = false;
    prevPendingCount = -1; // reset so the "all resolved" toast fires correctly per file
    setText('title', formatTitle(msg));
    syncIgnoreWSSelect(msg.ignoreWS);
    refreshMergeLayout();
    resetMergeHistory();
    return;
  }

  captureAutoResolved(msg.hunks);
  if (msg.autoApplyNonConflicts) applyAutoMergedNonConflictsTo(msg.hunks);
  const built = buildAlignedThree(msg.hunks);
  const local = makeEditor(byId('local'), built.local, msg.language, true);
  const result = makeEditor(byId('result'), built.result, msg.language, false);
  const remote = makeEditor(byId('remote'), built.remote, msg.language, true);
  registerMergeContextActions(local, result, remote);
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
    files: msg.files,
    fileIndex: msg.fileIndex
  };
  merge.localTracker.reset(extractPaneRanges(built.ranges, 'local'));
  merge.resultTracker.reset(extractPaneRanges(built.ranges, 'result'));
  merge.remoteTracker.reset(extractPaneRanges(built.ranges, 'remote'));
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
  // BASE column gutter click → magic-resolve a single conflict (P1-10).
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
  }
  byId('cancel').onclick = () => {
    vscode.postMessage({ type: 'finishMerge', result: 'CANCEL', dirty });
  };
  byId('accept').onclick = () => {
    if (!merge) return;
    const content = merge.result.editor.getValue();
    dirty = false;
    vscode.postMessage({ type: 'finishMerge', result: 'RESOLVED', outputText: content, dirty: false });
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
