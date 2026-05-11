import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { Hunk, InitCompareMessage, FileDiffMessage, FileChange } from '../../types';
import { buildAlignedTwo } from '../diff/align';
import type { LineRange } from '../diff/align';
import { wordDiff, wordTokenDiff, type Granularity } from '../diff/wordDiff';
import { byId, setText, escapeHtml, setMode } from '../components/toolbar';
import { renderTree } from '../components/changesTree';
import { Ribbon } from '../components/ribbon';
import { vscode, getVsCodeTheme } from '../api';

interface PaneCtx {
  editor: monaco.editor.IStandaloneCodeEditor;
  decorations: string[];
}

interface CompareState {
  files: FileChange[];
  current: string;
  target: string;
  rootPath: string;
  scopeLabel?: string;
  selected: string | null;
  left: PaneCtx | null;
  right: PaneCtx | null;
  ranges: Map<number, { local: LineRange; remote: LineRange }> | null;
  hunks: Hunk[] | null;
  editable: boolean;
  currentPath: string | null;
  ignoreWS: 'none' | 'trim' | 'inner' | 'whole';
  granularity: Granularity;
  baselineText: string;
}

let compare: CompareState | null = null;
let suppressScroll = false;
let compareRibbon: Ribbon | null = null;

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

function syncScroll(source: monaco.editor.IStandaloneCodeEditor, others: monaco.editor.IStandaloneCodeEditor[]) {
  source.onDidScrollChange((e) => {
    if (suppressScroll) return;
    suppressScroll = true;
    for (const o of others) o.setScrollTop(e.scrollTop);
    suppressScroll = false;
  });
}

export function initCompare(msg: InitCompareMessage) {
  setMode('compare');
  compare = {
    files: msg.files, current: msg.current, target: msg.target, rootPath: msg.rootPath,
    scopeLabel: msg.scopeLabel,
    selected: null, left: null, right: null, ranges: null, hunks: null,
    editable: false, currentPath: null, ignoreWS: 'none', granularity: 'char',
    baselineText: ''
  };
  const counts: Record<FileChange['status'], number> = { A: 0, M: 0, D: 0, R: 0 };
  for (const f of msg.files) counts[f.status]++;
  const summary = [
    counts.M ? `${counts.M} modified` : '',
    counts.A ? `${counts.A} added` : '',
    counts.D ? `${counts.D} deleted` : '',
    counts.R ? `${counts.R} renamed` : ''
  ].filter(Boolean).join(', ') || 'no changes';
  const scope = msg.scopeLabel ? `${msg.scopeLabel}  |  ` : '';
  setText('compareTitle', `${scope}${msg.current}  \u21C4  ${msg.target}   \u2014   ${summary}`);
  const groupBy = (document.getElementById('cmpGroupBy') as HTMLSelectElement | null)?.value ?? 'dir';
  renderTree(byId('tree'), msg.files, selectFile, groupBy as 'dir' | 'flat');
  if (msg.files.length === 1) selectFile(msg.files[0].path);

  const refresh = document.getElementById('cmpRefresh');
  if (refresh) refresh.onclick = () => vscode.postMessage({ type: 'refreshCompare' });
  const reverse = document.getElementById('cmpReverse');
  if (reverse) reverse.onclick = () => vscode.postMessage({ type: 'reverseCompare' });
  const groupSel = document.getElementById('cmpGroupBy') as HTMLSelectElement | null;
  if (groupSel) groupSel.onchange = () => {
    if (!compare) return;
    renderTree(byId('tree'), compare.files, selectFile, groupSel.value as 'dir' | 'flat');
  };
}

function selectFile(path: string) {
  if (!compare) return;
  compare.selected = path;
  for (const el of document.querySelectorAll('.tree-row.tree-file')) {
    (el as HTMLElement).classList.toggle('selected', (el as HTMLElement).dataset.path === path);
  }
  vscode.postMessage({ type: 'requestFileDiff', path, ignoreWS: compare.ignoreWS });
}

export function selectCompareFile(path: string) {
  selectFile(path);
}

export function showFileDiff(msg: FileDiffMessage) {
  if (!compare) return;
  const wrap = byId('compareDiff');
  if (msg.binary) {
    wrap.innerHTML = `<div class="diff-toolbar"><span id="cmpFile" class="action-label"></span></div>
      <div class="binary-placeholder">Binary file differs (no preview).</div>`;
    setText('cmpFile', msg.path);
    return;
  }
  const editActions = msg.editable
    ? `<div class="actions-group"><button id="cmpApplyTarget" class="action-btn" title="Apply current hunk from Target into Current" aria-label="Apply hunk from target"><span class="codicon codicon-arrow-left"></span></button><button id="cmpRevert" class="action-btn" title="Revert file to HEAD (current branch baseline)" aria-label="Revert file"><span class="codicon codicon-discard"></span></button></div>`
    : '';
  const saveBtn = msg.editable
    ? `<div class="actions-group"><button id="cmpSave" class="action-btn primary" title="Save" aria-label="Save"><span class="codicon codicon-save"></span></button></div>`
    : '';
  wrap.innerHTML = `
    <div class="diff-toolbar">
      <div class="actions-group">
        <button id="cmpPrev" class="action-btn" title="Previous change (F7)" aria-label="Previous change"><span class="codicon codicon-arrow-up"></span></button>
        <button id="cmpNext" class="action-btn" title="Next change (Shift+F7)" aria-label="Next change"><span class="codicon codicon-arrow-down"></span></button>
      </div>
      <span class="spacer"></span>
      <span id="cmpFile" class="action-label"></span>
      <span class="spacer"></span>
      ${editActions}
      <div class="actions-group">
        <select id="cmpIgnoreWS" class="action-select" title="Ignore whitespace mode" aria-label="Ignore whitespace mode">
          <option value="none">WS: None</option>
          <option value="trim">WS: Trim trailing</option>
          <option value="inner">WS: Collapse runs</option>
          <option value="whole">WS: Ignore all</option>
        </select>
        <select id="cmpGranularity" class="action-select" title="Intra-line diff granularity" aria-label="Diff granularity">
          <option value="char">Char</option>
          <option value="word">Word</option>
          <option value="line">Line</option>
        </select>
      </div>
      ${saveBtn}
    </div>
    <div class="diff-panes-wrap">
    <div class="diff-panes">
      <div class="pane"><div class="pane-header">Current (${escapeHtml(compare.current)})</div><div id="cmpLeft" class="editor"></div></div>
      <div class="pane"><div class="pane-header">Target (${escapeHtml(compare.target)})</div><div id="cmpRight" class="editor"></div></div>
    </div>
    <div id="cmpRibbonOverlay" class="ribbon-overlay-container"></div>
    </div>`;
  setText('cmpFile', msg.path);

  const built = buildAlignedTwo(msg.hunks);
  const left = makeEditor(byId('cmpLeft'), built.left, msg.language, !msg.editable);
  const right = makeEditor(byId('cmpRight'), built.right, msg.language, true);
  compare.left = { editor: left, decorations: [] };
  compare.right = { editor: right, decorations: [] };
  compare.ranges = built.ranges;
  compare.hunks = msg.hunks;
  compare.editable = msg.editable;
  compare.currentPath = msg.path;
  compare.baselineText = msg.baselineText ?? '';

  syncScroll(left, [right]);
  syncScroll(right, [left]);

  decorateCompare();

  // Ribbon
  if (compareRibbon) compareRibbon.destroy();
  const overlay = document.getElementById('cmpRibbonOverlay');
  if (overlay) {
    compareRibbon = new Ribbon(overlay);
    const updateCmpRibbon = () => {
      if (!compare || !compare.hunks || !compare.ranges) return;
      const leftDom = byId('cmpLeft');
      const rightDom = byId('cmpRight');
      const hunkData = compare.hunks
        .filter((h) => h.kind !== 'equal')
        .map((h) => {
          const r = compare!.ranges!.get(h.id)!;
          return { id: h.id, kind: h.kind, left: r.local, right: r.remote };
        });
      compareRibbon?.update(leftDom, rightDom, hunkData);
    };
    left.onDidScrollChange(() => updateCmpRibbon());
    right.onDidScrollChange(() => updateCmpRibbon());
    setTimeout(updateCmpRibbon, 100);
  }

  byId('cmpPrev').onclick = () => navigateCompare(-1);
  byId('cmpNext').onclick = () => navigateCompare(1);

  const wsSelect = document.getElementById('cmpIgnoreWS') as HTMLSelectElement | null;
  if (wsSelect) {
    wsSelect.value = compare.ignoreWS;
    wsSelect.onchange = () => {
      if (!compare) return;
      compare.ignoreWS = wsSelect.value as CompareState['ignoreWS'];
      if (compare.currentPath) {
        vscode.postMessage({ type: 'requestFileDiff', path: compare.currentPath, ignoreWS: compare.ignoreWS });
      }
    };
  }
  const granSelect = document.getElementById('cmpGranularity') as HTMLSelectElement | null;
  if (granSelect) {
    granSelect.value = compare.granularity;
    granSelect.onchange = () => {
      if (!compare) return;
      compare.granularity = granSelect.value as Granularity;
      decorateCompare();
    };
  }

  if (msg.editable) {
    const saveBtnEl = document.getElementById('cmpSave');
    if (saveBtnEl) saveBtnEl.onclick = () => {
      if (!compare?.currentPath) return;
      const content = left.getValue();
      vscode.postMessage({ type: 'saveFileEdit', path: compare.currentPath, content });
    };
    const applyBtn = document.getElementById('cmpApplyTarget');
    if (applyBtn) applyBtn.onclick = () => applyCurrentHunkFromTarget();
    const revertBtn = document.getElementById('cmpRevert');
    if (revertBtn) revertBtn.onclick = () => revertCurrentHunk();
  }
}

function currentLeftHunk() {
  if (!compare || !compare.left || !compare.hunks || !compare.ranges) return undefined;
  const line = compare.left.editor.getPosition()?.lineNumber ?? 1;
  return compare.hunks.find((h) => {
    if (h.kind === 'equal') return false;
    const r = compare!.ranges!.get(h.id)!.local;
    return line >= r.start && line < r.start + Math.max(r.length, 1);
  });
}

function applyCurrentHunkFromTarget() {
  if (!compare || !compare.left || !compare.ranges) return;
  const h = currentLeftHunk();
  if (!h) return;
  const r = compare.ranges.get(h.id)!.local;
  const newText = h.remoteLines.filter((l) => l.length > 0 || h.kind === 'modified').join('\n');
  const ml = compare.left.editor.getModel()!;
  const startLine = r.start;
  const endLine = Math.min(r.start + Math.max(r.length, 1) - 1, ml.getLineCount());
  const endCol = ml.getLineMaxColumn(endLine);
  compare.left.editor.executeEdits('git-compare-apply', [{
    range: new monaco.Range(startLine, 1, endLine, endCol),
    text: newText
  }]);
}

function revertCurrentHunk() {
  if (!compare || !compare.left) return;
  const ml = compare.left.editor.getModel()!;
  compare.left.editor.executeEdits('git-compare-revert', [{
    range: ml.getFullModelRange(),
    text: compare.baselineText
  }]);
}

function decorateCompare() {
  if (!compare || !compare.left || !compare.right || !compare.hunks || !compare.ranges) return;
  const ld: monaco.editor.IModelDeltaDecoration[] = [];
  const rd: monaco.editor.IModelDeltaDecoration[] = [];
  for (const h of compare.hunks) {
    const r = compare.ranges.get(h.id)!;
    if (h.kind === 'equal') continue;
    const cls = h.kind === 'added' ? 'hunk-added'
      : h.kind === 'deleted' ? 'hunk-deleted'
      : 'hunk-modified';
    ld.push(decorationFor(r.local, cls));
    rd.push(decorationFor(r.remote, cls));
    const stripeColor = h.kind === 'added' ? 'rgba(98,150,85,.6)'
      : h.kind === 'deleted' ? 'rgba(120,120,120,.6)'
      : 'rgba(70,130,180,.6)';
    ld.push({
      range: new monaco.Range(r.local.start, 1, r.local.start + Math.max(r.local.length, 1) - 1, 1),
      options: { isWholeLine: true, overviewRuler: { color: stripeColor, position: monaco.editor.OverviewRulerLane.Full } }
    });
    if (h.kind === 'modified' && compare.granularity !== 'line') {
      const max = Math.min(h.localLines.length, h.remoteLines.length);
      const fn = compare.granularity === 'word' ? wordTokenDiff : wordDiff;
      for (let i = 0; i < max; i++) {
        const wd = fn(h.localLines[i] ?? '', h.remoteLines[i] ?? '');
        for (const cr of wd.left) {
          ld.push({
            range: new monaco.Range(r.local.start + i, cr.start + 1, r.local.start + i, cr.end + 1),
            options: { className: 'word-diff' }
          });
        }
        for (const cr of wd.right) {
          rd.push({
            range: new monaco.Range(r.remote.start + i, cr.start + 1, r.remote.start + i, cr.end + 1),
            options: { className: 'word-diff' }
          });
        }
      }
    }
  }
  compare.left.decorations = compare.left.editor.deltaDecorations(compare.left.decorations, ld);
  compare.right.decorations = compare.right.editor.deltaDecorations(compare.right.decorations, rd);
}

function navigateCompare(dir: 1 | -1) {
  if (!compare || !compare.left || !compare.hunks || !compare.ranges) return;
  const changes = compare.hunks.filter((h) => h.kind !== 'equal');
  if (!changes.length) return;
  const cur = compare.left.editor.getPosition()?.lineNumber ?? 1;
  const ordered = dir === 1 ? changes : changes.slice().reverse();
  const next = ordered.find((h) => {
    const r = compare!.ranges!.get(h.id)!.local;
    return dir === 1 ? r.start > cur : r.start < cur;
  }) ?? ordered[0];
  const r = compare.ranges.get(next.id)!.local;
  compare.left.editor.revealLineInCenter(r.start);
  compare.left.editor.setPosition({ lineNumber: r.start, column: 1 });
  compare.left.editor.focus();
}

export function getCompareState(): CompareState | null { return compare; }
