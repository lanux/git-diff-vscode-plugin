import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import type { MergeChange } from '../../types';
import type { LineRange } from '../diff/align';
import { wordDiff, wordTokenDiff, type Granularity } from '../diff/wordDiff';
import { isResolved } from '../../diff/merge/mergeActions';
import { isSideChanged } from '../../diff/merge/mergeModel';

export interface InnerDiffState {
  hunks: readonly MergeChange[];
  localEditor: monaco.editor.IStandaloneCodeEditor;
  resultEditor: monaco.editor.IStandaloneCodeEditor;
  remoteEditor: monaco.editor.IStandaloneCodeEditor;
  getRanges(hunkId: number): { local: LineRange; result: LineRange; remote: LineRange };
}

export class InnerDiffScheduler {
  private timer = 0;
  private version = 0;
  private localDecorations: string[] = [];
  private resultDecorations: string[] = [];
  private remoteDecorations: string[] = [];

  schedule(state: InnerDiffState, granularity: Granularity): void {
    this.version++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }

    if (granularity === 'line') {
      this.clear(state);
      return;
    }

    const version = this.version;
    const run = () => {
      if (version !== this.version) return;
      this.render(state, granularity);
    };
    const requestIdle = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (requestIdle) requestIdle(run, { timeout: 80 });
    else this.timer = window.setTimeout(run, 16);
  }

  clear(state: InnerDiffState): void {
    this.localDecorations = state.localEditor.deltaDecorations(this.localDecorations, []);
    this.resultDecorations = state.resultEditor.deltaDecorations(this.resultDecorations, []);
    this.remoteDecorations = state.remoteEditor.deltaDecorations(this.remoteDecorations, []);
  }

  private render(state: InnerDiffState, granularity: Granularity): void {
    const localDecorations: monaco.editor.IModelDeltaDecoration[] = [];
    const resultDecorations: monaco.editor.IModelDeltaDecoration[] = [];
    const remoteDecorations: monaco.editor.IModelDeltaDecoration[] = [];
    const diff = granularity === 'word' ? wordTokenDiff : wordDiff;

    for (const hunk of state.hunks) {
      if (hunk.kind !== 'auto' && hunk.kind !== 'conflict') continue;
      const ranges = state.getRanges(hunk.id);
      const max = Math.max(hunk.localLines.length, hunk.baseLines.length, hunk.remoteLines.length);
      for (let i = 0; i < max; i++) {
        const base = hunk.baseLines[i] ?? '';
        if (hunk.kind === 'conflict' && hunk.status === 'pending') {
          const left = diff(base, hunk.localLines[i] ?? '');
          const right = diff(base, hunk.remoteLines[i] ?? '');
          pushRanges(resultDecorations, ranges.result.start, i, left.left, 'base-word-diff');
          pushRanges(localDecorations, ranges.local.start, i, left.right);
          pushRanges(resultDecorations, ranges.result.start, i, right.left, 'base-word-diff');
          pushRanges(remoteDecorations, ranges.remote.start, i, right.right);
        } else if (hunk.kind === 'auto' && !isResolved(hunk)) {
          if (isSideChanged(hunk, 'local')) {
            const left = diff(base, hunk.localLines[i] ?? '');
            pushRanges(resultDecorations, ranges.result.start, i, left.left, 'base-word-diff');
            pushRanges(localDecorations, ranges.local.start, i, left.right);
          }
          if (isSideChanged(hunk, 'remote')) {
            const right = diff(base, hunk.remoteLines[i] ?? '');
            pushRanges(resultDecorations, ranges.result.start, i, right.left, 'base-word-diff');
            pushRanges(remoteDecorations, ranges.remote.start, i, right.right);
          }
        }
      }
    }

    this.localDecorations = state.localEditor.deltaDecorations(this.localDecorations, localDecorations);
    this.resultDecorations = state.resultEditor.deltaDecorations(this.resultDecorations, resultDecorations);
    this.remoteDecorations = state.remoteEditor.deltaDecorations(this.remoteDecorations, remoteDecorations);
  }
}

function pushRanges(
  out: monaco.editor.IModelDeltaDecoration[],
  startLine: number,
  lineOffset: number,
  ranges: readonly { start: number; end: number }[],
  className = 'word-diff'
): void {
  for (const range of ranges) {
    out.push({
      range: new monaco.Range(startLine + lineOffset, range.start + 1, startLine + lineOffset, range.end + 1),
      options: { className }
    });
  }
}
