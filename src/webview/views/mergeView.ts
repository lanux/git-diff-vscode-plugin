import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { Hunk, InitMergeMessage } from '../../types';
import { buildAlignedThree } from '../diff/align';
import type { LineRange } from '../diff/align';
import { byId, setText, setMode } from '../components/toolbar';
import { Ribbon } from '../components/ribbon';
import { wordDiff, wordTokenDiff, type Granularity } from '../diff/wordDiff';
import { vscode, getVsCodeTheme } from '../api';

interface PaneCtx {
  editor: monaco.editor.IStandaloneCodeEditor;
  decorations: string[];
}

interface MergeState {
  hunks: Hunk[];
  local: PaneCtx; result: PaneCtx; remote: PaneCtx;
  ranges: Map<number, { local: LineRange; result: LineRange; remote: LineRange }>;
  filePath: string;
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
// Snapshot of each auto hunk's resolvedLines at init, so "Apply All Non-Conflicting" can restore it.
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

function decorateMerge() {
  if (!merge) return;
  const { hunks, ranges } = merge;
  const ld: monaco.editor.IModelDeltaDecoration[] = [];
  const rd: monaco.editor.IModelDeltaDecoration[] = [];
  const remd: monaco.editor.IModelDeltaDecoration[] = [];
  for (const h of hunks) {
    const r = ranges.get(h.id)!;
    if (h.kind === 'auto') {
      ld.push(decorationFor(r.local, 'hunk-auto'));
      rd.push(decorationFor(r.result, 'hunk-auto'));
      remd.push(decorationFor(r.remote, 'hunk-auto'));
      // Scrollbar stripe for auto hunks
      rd.push({
        range: new monaco.Range(r.result.start, 1, r.result.start + Math.max(r.result.length, 1) - 1, 1),
        options: { isWholeLine: true, overviewRuler: { color: 'rgba(98,150,85,.3)', position: monaco.editor.OverviewRulerLane.Full } }
      });
    } else if (h.kind === 'conflict') {
      const cls = h.status === 'pending' ? 'hunk-conflict-pending' : 'hunk-resolved';
      // IDEA-aligned glyphs:
      //   pending          → both sides show »/« (apply, replaces result)
      //   accepted-local   → local=× (revert), remote=⤓ (append remote after local)
      //   accepted-remote  → local=⤓ (prepend local before remote), remote=× (revert)
      //   accepted-both    → both sides show × (revert)
      let leftGlyph: string;
      let rightGlyph: string;
      switch (h.status) {
        case 'accepted-local':
          leftGlyph = 'action-glyph revert';
          rightGlyph = 'action-glyph append-left';
          break;
        case 'accepted-remote':
          leftGlyph = 'action-glyph append-right';
          rightGlyph = 'action-glyph revert';
          break;
        case 'accepted-both':
          leftGlyph = 'action-glyph revert';
          rightGlyph = 'action-glyph revert';
          break;
        default:
          leftGlyph = 'action-glyph right';
          rightGlyph = 'action-glyph left';
      }
      ld.push(decorationFor(r.local, cls, leftGlyph));
      rd.push(decorationFor(r.result, cls));
      remd.push(decorationFor(r.remote, cls, rightGlyph));
      // Scrollbar stripe for conflict hunks
      const stripeColor = h.status === 'pending' ? 'rgba(232,118,0,.8)' : 'rgba(98,150,85,.5)';
      rd.push({
        range: new monaco.Range(r.result.start, 1, r.result.start + Math.max(r.result.length, 1) - 1, 1),
        options: { isWholeLine: true, overviewRuler: { color: stripeColor, position: monaco.editor.OverviewRulerLane.Full } }
      });
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
}

function findHunkAtLine(side: 'local' | 'remote', line: number): Hunk | undefined {
  if (!merge) return;
  for (const h of merge.hunks) {
    if (h.kind !== 'conflict') continue;
    const r = merge.ranges.get(h.id)![side];
    if (line >= r.start && line < r.start + Math.max(r.length, 1)) return h;
  }
}

function currentResultLineHunk(): Hunk | undefined {
  if (!merge) return;
  const line = merge.result.editor.getPosition()?.lineNumber ?? 1;
  for (const h of merge.hunks) {
    if (h.kind !== 'conflict') continue;
    const r = merge.ranges.get(h.id)!.result;
    if (line >= r.start && line < r.start + Math.max(r.length, 1)) return h;
  }
  return merge.hunks.find((h) => h.kind === 'conflict' && h.status === 'pending');
}

export function getResultContent(): string {
  return merge?.result.editor.getValue() ?? '';
}

// Click on a side's glyph for a conflict hunk. IDEA semantics:
//   - own side already accepted → revert (back to pending, drop resolved)
//   - other side accepted        → append this side (local goes before remote in result)
//   - pending                    → replace result with this side
function handleConflictClick(hunk: Hunk, side: 'local' | 'remote') {
  if (!merge || hunk.kind !== 'conflict') return;
  const ownAccepted =
    (side === 'local' && (hunk.status === 'accepted-local' || hunk.status === 'accepted-both')) ||
    (side === 'remote' && (hunk.status === 'accepted-remote' || hunk.status === 'accepted-both'));
  if (ownAccepted) {
    hunk.resolvedLines = [];
    hunk.status = 'pending';
    rebuildMerge();
    return;
  }
  const lines = side === 'local' ? hunk.localLines : hunk.remoteLines;
  const otherAccepted =
    (side === 'local' && hunk.status === 'accepted-remote') ||
    (side === 'remote' && hunk.status === 'accepted-local');
  if (otherAccepted) {
    // Append, keeping local-before-remote order in the result.
    hunk.resolvedLines = side === 'local'
      ? [...lines, ...hunk.resolvedLines]
      : [...hunk.resolvedLines, ...lines];
    hunk.status = 'accepted-both';
  } else {
    hunk.resolvedLines = lines.slice();
    hunk.status = side === 'local' ? 'accepted-local' : 'accepted-remote';
  }
  rebuildMerge();
}

function linesEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// IDEA semantics:
//   Apply All Non-Conflicting → restore auto-merge for every auto hunk.
//   Apply Left Non-Conflicting → for auto hunks where local changed vs base, use localLines;
//     hunks that are remote-only changes are left as auto-merged.
//   Apply Right Non-Conflicting → mirror of left.
function applyNonConflicting(side: 'local' | 'remote' | 'both') {
  if (!merge) return;
  let changed = false;
  for (const h of merge.hunks) {
    if (h.kind !== 'auto') continue;
    if (side === 'both') {
      const orig = autoResolved.get(h.id);
      if (orig) h.resolvedLines = orig.slice();
      h.status = 'manual';
      changed = true;
    } else {
      const sideChanged = side === 'local'
        ? !linesEqual(h.localLines, h.baseLines)
        : !linesEqual(h.remoteLines, h.baseLines);
      if (!sideChanged) continue;
      h.resolvedLines = (side === 'local' ? h.localLines : h.remoteLines).slice();
      h.status = side === 'local' ? 'accepted-local' : 'accepted-remote';
      changed = true;
    }
  }
  if (changed) rebuildMerge();
}

const IMPORT_LINE = /^\s*(?:import\b|from\s+\S+\s+import\b|#include\b|using\s+\w+\b|require\s*\()/;
const stripWS = (s: string) => s.replace(/\s+/g, '');

function runMagicResolve() {
  if (!merge) return;
  let resolved = 0;
  for (const h of merge.hunks) {
    if (h.kind !== 'conflict' || h.status !== 'pending') continue;
    // Whitespace-only difference → keep local
    const an = h.localLines.map(stripWS).filter((l) => l.length > 0);
    const bn = h.remoteLines.map(stripWS).filter((l) => l.length > 0);
    if (an.length === bn.length && an.every((v, i) => v === bn[i])) {
      h.resolvedLines = h.localLines.slice();
      h.status = 'accepted-local';
      resolved++; continue;
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
      resolved++;
    }
  }
  if (resolved > 0) rebuildMerge();
}

function rebuildMerge() {
  if (!merge) return;
  const built = buildAlignedThree(merge.hunks);
  merge.ranges = built.ranges;
  programmaticEdit = true;
  try {
    merge.local.editor.setValue(built.local);
    merge.remote.editor.setValue(built.remote);
    const model = merge.result.editor.getModel()!;
    merge.result.editor.executeEdits('git-merge-rebuild', [
      { range: model.getFullModelRange(), text: built.result, forceMoveMarkers: true }
    ]);
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
        const r = merge!.ranges.get(h.id)!.result;
        return dir === 1 ? r.start > cur : r.start < cur;
      })
    : undefined;
  if (next) {
    const r = merge.ranges.get(next.id)!.result;
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
    if (h.kind === 'auto') autoResolved.set(h.id, h.resolvedLines.slice());
  }
}

export function initMerge(msg: InitMergeMessage) {
  setMode('merge');

  // Re-init for a different file: reuse existing editors, just swap state.
  if (merge) {
    merge.hunks = msg.hunks;
    merge.filePath = msg.filePath;
    merge.files = msg.files;
    merge.fileIndex = msg.fileIndex;
    captureAutoResolved(msg.hunks);
    dirty = false;
    setText('title', formatTitle(msg));
    syncIgnoreWSSelect(msg.ignoreWS);
    rebuildMerge();
    return;
  }

  const built = buildAlignedThree(msg.hunks);
  const local = makeEditor(byId('local'), built.local, msg.language, true);
  const result = makeEditor(byId('result'), built.result, msg.language, false);
  const remote = makeEditor(byId('remote'), built.remote, msg.language, true);
  merge = {
    hunks: msg.hunks, filePath: msg.filePath,
    local: { editor: local, decorations: [] },
    result: { editor: result, decorations: [] },
    remote: { editor: remote, decorations: [] },
    ranges: built.ranges,
    files: msg.files,
    fileIndex: msg.fileIndex
  };
  captureAutoResolved(msg.hunks);
  setText('title', formatTitle(msg));
  syncScroll(local, [result, remote]);
  syncScroll(result, [local, remote]);
  syncScroll(remote, [local, result]);

  local.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber; if (!line) return;
    const h = findHunkAtLine('local', line); if (h) handleConflictClick(h, 'local');
  });
  remote.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber; if (!line) return;
    const h = findHunkAtLine('remote', line); if (h) handleConflictClick(h, 'remote');
  });

  result.getModel()!.onDidChangeContent(() => {
    if (programmaticEdit) { updateMergeCounter(); return; }
    dirty = true;
    updateMergeCounter();
    if (decorateRaf) cancelAnimationFrame(decorateRaf);
    decorateRaf = requestAnimationFrame(() => { decorateRaf = 0; decorateMerge(); });
  });
  decorateMerge();

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
        const r = merge!.ranges.get(h.id)!;
        return { id: h.id, kind: h.kind, left: r.local, right: r.result };
      });
    ribbonLR?.update(localDom, resultDom, hunkData);
    const hunkData2 = merge.hunks
      .filter((h) => h.kind !== 'equal')
      .map((h) => {
        const r = merge!.ranges.get(h.id)!;
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
    if (e.key === 'F7' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault(); navigateMerge(1);
    } else if (e.key === 'F7' && e.shiftKey) {
      e.preventDefault(); navigateMerge(-1);
    } else if (e.altKey && e.shiftKey && (e.key === ',' || e.key === '<')) {
      e.preventDefault();
      const cur = currentResultLineHunk();
      if (cur) handleConflictClick(cur, 'local');
    } else if (e.altKey && e.shiftKey && (e.key === '.' || e.key === '>')) {
      e.preventDefault();
      const cur = currentResultLineHunk();
      if (cur) handleConflictClick(cur, 'remote');
    }
  });

  byId('prev').onclick = () => navigateMerge(-1);
  byId('next').onclick = () => navigateMerge(1);
  const prevFileBtn = document.getElementById('prevFile') as HTMLButtonElement | null;
  const nextFileBtn = document.getElementById('nextFile') as HTMLButtonElement | null;
  if (prevFileBtn) prevFileBtn.onclick = () => requestSwitchFile(-1);
  if (nextFileBtn) nextFileBtn.onclick = () => requestSwitchFile(1);
  byId('applyL').onclick = () => applyNonConflicting('local');
  byId('applyR').onclick = () => applyNonConflicting('remote');
  byId('applyB').onclick = () => applyNonConflicting('both');
  byId('magic').onclick = () => runMagicResolve();
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
    if (dirty) {
      vscode.postMessage({ type: 'cancelCheck' });
    } else {
      vscode.postMessage({ type: 'cancel' });
    }
  };
  byId('accept').onclick = () => {
    if (!merge) return;
    const content = merge.result.editor.getValue();
    dirty = false;
    vscode.postMessage({ type: 'saveMerge', content });
  };
}

export function getMergeState(): MergeState | null { return merge; }
