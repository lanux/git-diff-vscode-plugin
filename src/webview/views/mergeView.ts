import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { Hunk, InitMergeMessage } from '../../types';
import { buildAlignedThree } from '../diff/align';
import type { LineRange } from '../diff/align';
import { byId, setText, setMode } from '../components/toolbar';
import { Ribbon } from '../components/ribbon';
import { wordDiff, wordTokenDiff, type Granularity } from '../diff/wordDiff';
import { vscode } from '../api';

interface PaneCtx {
  editor: monaco.editor.IStandaloneCodeEditor;
  decorations: string[];
}

interface MergeState {
  hunks: Hunk[];
  local: PaneCtx; result: PaneCtx; remote: PaneCtx;
  ranges: Map<number, { local: LineRange; result: LineRange; remote: LineRange }>;
  filePath: string;
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

function makeEditor(container: HTMLElement, value: string, language: string, readOnly: boolean) {
  return monaco.editor.create(container, {
    value, language, readOnly,
    automaticLayout: true,
    minimap: { enabled: false },
    glyphMargin: true,
    lineNumbers: 'on',
    renderLineHighlight: 'all',
    scrollBeyondLastLine: false,
    theme: 'vs-dark'
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
      ld.push(decorationFor(r.local, cls, 'action-glyph right'));
      rd.push(decorationFor(r.result, cls));
      remd.push(decorationFor(r.remote, cls, 'action-glyph left'));
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
  const total = merge.hunks.filter((h) => h.kind === 'conflict').length;
  setText('counter', `${total - pending}/${total} resolved \u00B7 ${pending} conflict${pending === 1 ? '' : 's'}`);
  const acceptBtn = document.getElementById('accept') as HTMLButtonElement;
  if (acceptBtn) {
    acceptBtn.disabled = pending > 0;
    acceptBtn.title = pending > 0 ? `${pending} unresolved conflict${pending === 1 ? '' : 's'} remaining` : 'Accept merge and stage file';
  }
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

function applyMergeHunk(hunk: Hunk, side: 'local' | 'remote' | 'both') {
  if (!merge) return;
  if (side === 'both') hunk.resolvedLines = [...hunk.localLines, ...hunk.remoteLines];
  else hunk.resolvedLines = (side === 'local' ? hunk.localLines : hunk.remoteLines).slice();
  hunk.status = side === 'local' ? 'accepted-local' : side === 'remote' ? 'accepted-remote' : 'accepted-both';
  rebuildMerge();
}

function applyNonConflicting(side: 'local' | 'remote' | 'both') {
  if (!merge) return;
  for (const h of merge.hunks) {
    if (h.kind === 'conflict' && h.status === 'pending') applyMergeHunk(h, side);
  }
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

function navigateMerge(dir: 1 | -1) {
  if (!merge) return;
  const conflicts = merge.hunks.filter((h) => h.kind === 'conflict');
  if (!conflicts.length) return;
  const cur = merge.result.editor.getPosition()?.lineNumber ?? 1;
  const ordered = dir === 1 ? conflicts : conflicts.slice().reverse();
  const next = ordered.find((h) => {
    const r = merge!.ranges.get(h.id)!.result;
    return dir === 1 ? r.start > cur : r.start < cur;
  }) ?? ordered[0];
  const r = merge.ranges.get(next.id)!.result;
  merge.result.editor.revealLineInCenter(r.start);
  merge.result.editor.setPosition({ lineNumber: r.start, column: 1 });
  merge.result.editor.focus();
}

function syncScroll(source: monaco.editor.IStandaloneCodeEditor, others: monaco.editor.IStandaloneCodeEditor[]) {
  source.onDidScrollChange((e) => {
    if (suppressScroll) return;
    suppressScroll = true;
    for (const o of others) o.setScrollTop(e.scrollTop);
    suppressScroll = false;
  });
}

export function initMerge(msg: InitMergeMessage) {
  setMode('merge');
  const built = buildAlignedThree(msg.hunks);
  const local = makeEditor(byId('local'), built.local, msg.language, true);
  const result = makeEditor(byId('result'), built.result, msg.language, false);
  const remote = makeEditor(byId('remote'), built.remote, msg.language, true);
  merge = {
    hunks: msg.hunks, filePath: msg.filePath,
    local: { editor: local, decorations: [] },
    result: { editor: result, decorations: [] },
    remote: { editor: remote, decorations: [] },
    ranges: built.ranges
  };
  setText('title', msg.filePath);
  syncScroll(local, [result, remote]);
  syncScroll(result, [local, remote]);
  syncScroll(remote, [local, result]);

  local.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber; if (!line) return;
    const h = findHunkAtLine('local', line); if (h) applyMergeHunk(h, 'local');
  });
  remote.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const line = e.target.position?.lineNumber; if (!line) return;
    const h = findHunkAtLine('remote', line); if (h) applyMergeHunk(h, 'remote');
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
      if (cur) applyMergeHunk(cur, 'local');
    } else if (e.altKey && e.shiftKey && (e.key === '.' || e.key === '>')) {
      e.preventDefault();
      const cur = currentResultLineHunk();
      if (cur) applyMergeHunk(cur, 'remote');
    }
  });

  byId('prev').onclick = () => navigateMerge(-1);
  byId('next').onclick = () => navigateMerge(1);
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
