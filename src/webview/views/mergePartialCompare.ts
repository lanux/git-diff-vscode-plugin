import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { Hunk } from '../../types';
import { buildTwoWayHunks } from '../../diff/twoWay';
import { buildAlignedTwo, type LineRange } from '../diff/align';
import { byId } from '../components/toolbar';
import { getVsCodeTheme } from '../api';

type CompareSide = 'local' | 'base' | 'remote';
type CompareScope = 'change' | 'file';

interface CompareMode {
  scope: CompareScope;
  leftSide: CompareSide;
  rightSide: CompareSide;
}

interface WholeFileCompareInput {
  local: string;
  base: string;
  remote: string;
}

type CompareState =
  | {
    kind: 'change';
    hunk: Hunk;
    language: string;
    options: { revealMainChange?: () => void };
  }
  | {
    kind: 'file';
    texts: WholeFileCompareInput;
    language: string;
  };

let editors: monaco.editor.IStandaloneCodeEditor[] = [];
let revealMainChange: (() => void) | null = null;
let currentCompareState: CompareState | null = null;

export function closePartialCompare(reveal = false): void {
  const revealMain = reveal ? revealMainChange : null;
  for (const editor of editors) editor.dispose();
  editors = [];
  revealMainChange = null;
  currentCompareState = null;
  document.getElementById('partialDiffModal')?.remove();
  revealMain?.();
}

export function isPartialCompareOpen(): boolean {
  return currentCompareState !== null;
}

export function refreshPartialCompare(): void {
  if (!currentCompareState) return;
  renderCompareModal(currentCompareState);
}

export function showPartialCompare(
  hunk: Hunk,
  language: string,
  options: { revealMainChange?: () => void } = {}
): void {
  currentCompareState = { kind: 'change', hunk, language, options };
  renderCompareModal(currentCompareState);
}

export function showWholeFileCompare(texts: WholeFileCompareInput, language: string): void {
  currentCompareState = { kind: 'file', texts, language };
  renderCompareModal(currentCompareState);
}

function renderCompareModal(state: CompareState): void {
  const mode = readCompareMode();
  const leftText = state.kind === 'change'
    ? linesForSide(state.hunk, mode.leftSide).join('\n')
    : textForSide(state.texts, mode.leftSide);
  const rightText = state.kind === 'change'
    ? linesForSide(state.hunk, mode.rightSide).join('\n')
    : textForSide(state.texts, mode.rightSide);
  const title = state.kind === 'change'
    ? `Change ${state.hunk.id + 1}: ${mode.leftSide.toUpperCase()} vs ${mode.rightSide.toUpperCase()}`
    : `File: ${mode.leftSide.toUpperCase()} vs ${mode.rightSide.toUpperCase()}`;
  const canRevealMain = state.kind === 'change' && Boolean(state.options.revealMainChange);
  const diffHunks = buildTwoWayHunks(leftText, rightText);
  const built = buildAlignedTwo(diffHunks);

  for (const editor of editors) editor.dispose();
  editors = [];
  document.getElementById('partialDiffModal')?.remove();
  revealMainChange = state.kind === 'change' ? state.options.revealMainChange ?? null : null;
  const modal = document.createElement('div');
  modal.id = 'partialDiffModal';
  modal.className = 'partial-diff-modal';
  modal.innerHTML = `
    <div class="partial-diff-title">
      <span></span>
      <span class="spacer"></span>
      ${canRevealMain ? '<button id="partialDiffBack" class="action-btn" title="Back to Change" aria-label="Back to Change"><span class="codicon codicon-location"></span></button>' : ''}
      <button id="partialDiffClose" class="action-btn" title="Close" aria-label="Close"><span class="codicon codicon-close"></span></button>
    </div>
    <div class="partial-diff-panes">
      <div class="pane">
        <div class="pane-header partial-diff-pane-header">
          <span class="partial-diff-pane-label"></span>
          <span class="spacer"></span>
          ${canRevealMain ? '<button class="action-btn partial-diff-jump" title="Back to Change" aria-label="Back to Change"><span class="codicon codicon-location"></span></button>' : ''}
        </div>
        <div id="partialDiffLeft" class="editor"></div>
      </div>
      <div class="pane">
        <div class="pane-header partial-diff-pane-header">
          <span class="partial-diff-pane-label"></span>
          <span class="spacer"></span>
          ${canRevealMain ? '<button class="action-btn partial-diff-jump" title="Back to Change" aria-label="Back to Change"><span class="codicon codicon-location"></span></button>' : ''}
        </div>
        <div id="partialDiffRight" class="editor"></div>
      </div>
    </div>`;
  byId('mergeBody').appendChild(modal);

  modal.querySelector('.partial-diff-title span')!.textContent = title;
  const labels = modal.querySelectorAll('.partial-diff-pane-label');
  labels[0].textContent = mode.leftSide.toUpperCase();
  labels[1].textContent = mode.rightSide.toUpperCase();
  const revealMain = () => closePartialCompare(true);
  const backButton = document.getElementById('partialDiffBack') as HTMLButtonElement | null;
  if (backButton) backButton.onclick = revealMain;
  modal.querySelectorAll('.partial-diff-jump').forEach((button) => {
    (button as HTMLButtonElement).onclick = revealMain;
  });
  (document.getElementById('partialDiffClose') as HTMLButtonElement).onclick = () => closePartialCompare(false);

  const left = createReadonlyEditor(byId('partialDiffLeft'), built.left, state.language);
  const right = createReadonlyEditor(byId('partialDiffRight'), built.right, state.language);
  editors = [left, right];

  const leftDecorations: monaco.editor.IModelDeltaDecoration[] = [];
  const rightDecorations: monaco.editor.IModelDeltaDecoration[] = [];
  for (const item of diffHunks) {
    if (item.kind === 'equal') continue;
    const range = built.ranges.get(item.id);
    if (!range) continue;
    const cls = item.kind === 'added' ? 'hunk-added' : item.kind === 'deleted' ? 'hunk-deleted' : 'hunk-modified';
    leftDecorations.push(decorationFor(range.local, cls));
    rightDecorations.push(decorationFor(range.remote, cls));
  }
  left.deltaDecorations([], leftDecorations);
  right.deltaDecorations([], rightDecorations);
  revealFirstChangedRange(diffHunks, built.ranges, left, right);
  syncScroll(left, right);
}

function readCompareMode(): CompareMode {
  const raw = (document.getElementById('compareContentsMode') as HTMLSelectElement | null)?.value ?? 'change-local-base';
  const [scope, leftSide, rightSide] = raw.split('-') as [CompareScope, CompareSide, CompareSide];
  return { scope, leftSide, rightSide };
}

function linesForSide(hunk: Hunk, side: CompareSide): string[] {
  if (side === 'local') return hunk.localLines;
  if (side === 'remote') return hunk.remoteLines;
  return hunk.baseLines;
}

function textForSide(texts: WholeFileCompareInput, side: CompareSide): string {
  if (side === 'local') return texts.local;
  if (side === 'remote') return texts.remote;
  return texts.base;
}

function createReadonlyEditor(container: HTMLElement, value: string, language: string) {
  return monaco.editor.create(container, {
    value,
    language,
    readOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: 'on',
    renderLineHighlight: 'all',
    scrollBeyondLastLine: false,
    theme: getVsCodeTheme()
  });
}

function decorationFor(range: LineRange, className: string): monaco.editor.IModelDeltaDecoration {
  return {
    range: new monaco.Range(range.start, 1, range.start + Math.max(range.length, 1) - 1, 1),
    options: { isWholeLine: true, className }
  };
}

function revealFirstChangedRange(
  diffHunks: Hunk[],
  ranges: Map<number, { local: LineRange; remote: LineRange }>,
  left: monaco.editor.IStandaloneCodeEditor,
  right: monaco.editor.IStandaloneCodeEditor
): void {
  const first = diffHunks.find((item) => item.kind !== 'equal');
  if (!first) return;
  const range = ranges.get(first.id);
  if (!range) return;
  revealAndSelect(left, range.local);
  revealAndSelect(right, range.remote);
}

function revealAndSelect(editor: monaco.editor.IStandaloneCodeEditor, range: LineRange): void {
  const start = range.start;
  const end = range.start + Math.max(range.length, 1) - 1;
  const endColumn = editor.getModel()?.getLineMaxColumn(end) ?? 1;
  editor.revealLineInCenter(start);
  editor.setSelection(new monaco.Selection(start, 1, end, endColumn));
}

function syncScroll(left: monaco.editor.IStandaloneCodeEditor, right: monaco.editor.IStandaloneCodeEditor): void {
  let syncing = false;
  const mirror = (source: monaco.editor.IStandaloneCodeEditor, target: monaco.editor.IStandaloneCodeEditor) => {
    source.onDidScrollChange((event) => {
      if (syncing) return;
      syncing = true;
      target.setScrollTop(event.scrollTop);
      syncing = false;
    });
  };
  mirror(left, right);
  mirror(right, left);
}
