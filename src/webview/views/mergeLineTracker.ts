import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

import type { LineRange } from '../diff/align';
import { updateRangeOnModification } from './mergeRangeUpdate';

export interface LineModification {
  startLineNumber: number;
  endLineNumber: number;
  text: string;
}

export interface AffectedTrackedRange {
  hunkId: number;
  damaged: boolean;
  intersects: boolean;
}

export class MergeLineTracker {
  private decorationIds = new Map<number, string>();
  private ranges = new Map<number, LineRange>();

  constructor(private readonly editor: monaco.editor.IStandaloneCodeEditor) { }

  reset(ranges: Map<number, LineRange>): void {
    const model = this.editor.getModel();
    if (!model) return;

    const hunkIds = Array.from(ranges.keys());
    const decorations = hunkIds.map((hunkId) => ({
      range: toMonacoRange(ranges.get(hunkId)!, model),
      options: {
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      }
    } satisfies monaco.editor.IModelDeltaDecoration));

    const nextIds = model.deltaDecorations(Array.from(this.decorationIds.values()), decorations);
    this.decorationIds.clear();
    this.ranges.clear();
    for (let i = 0; i < hunkIds.length; i++) {
      this.decorationIds.set(hunkIds[i], nextIds[i]);
      this.ranges.set(hunkIds[i], { ...ranges.get(hunkIds[i])! });
    }
  }

  getRange(hunkId: number): LineRange | undefined {
    const model = this.editor.getModel();
    const decorationId = this.decorationIds.get(hunkId);
    if (!model || !decorationId) return undefined;

    const range = model.getDecorationRange(decorationId);
    if (!range) return undefined;

    return {
      start: range.startLineNumber,
      length: range.endLineNumber - range.startLineNumber + 1,
    };
  }

  refreshFromDecorations(): void {
    for (const hunkId of this.decorationIds.keys()) {
      const range = this.getRange(hunkId);
      if (range) this.ranges.set(hunkId, range);
    }
  }

  applyContentChanges(changes: readonly LineModification[]): AffectedTrackedRange[] {
    const affected = new Map<number, AffectedTrackedRange>();

    for (const change of changes) {
      const changeStart = change.startLineNumber;
      const changeEnd = change.endLineNumber + 1;
      const shift = countLineBreaks(change.text) - (change.endLineNumber - change.startLineNumber);
      const nextRanges = new Map<number, LineRange>();

      for (const [hunkId, range] of this.ranges) {
        const start = range.start;
        const end = range.start + Math.max(range.length, 1);
        const intersects = rangesIntersect(start, end, changeStart, changeEnd);
        const updated = updateRangeOnModification(start, end, changeStart, changeEnd, shift);
        nextRanges.set(hunkId, {
          start: updated.start,
          length: Math.max(1, updated.end - updated.start),
        });

        if (intersects || updated.damaged) {
          const previous = affected.get(hunkId);
          affected.set(hunkId, {
            hunkId,
            damaged: (previous?.damaged ?? false) || updated.damaged,
            intersects: (previous?.intersects ?? false) || intersects,
          });
        }
      }

      this.ranges = nextRanges;
    }

    this.refreshFromDecorations();
    return Array.from(affected.values());
  }

  readLines(hunkId: number): string[] {
    const model = this.editor.getModel();
    const range = this.getRange(hunkId);
    if (!model || !range) return [];

    const text = model.getValueInRange(toMonacoRange(range, model));
    return text.length === 0 ? [''] : text.split('\n');
  }

  replaceLines(hunkId: number, lines: readonly string[]): void {
    const model = this.editor.getModel();
    const range = this.getRange(hunkId);
    if (!model || !range) return;

    this.editor.executeEdits('git-merge-line-tracker', [{
      range: toMonacoRange(range, model),
      text: lines.join('\n'),
      forceMoveMarkers: true,
    }]);
    this.refreshFromDecorations();
  }

  dispose(): void {
    const model = this.editor.getModel();
    if (model) model.deltaDecorations(Array.from(this.decorationIds.values()), []);
    this.decorationIds.clear();
    this.ranges.clear();
  }
}

function toMonacoRange(range: LineRange, model: monaco.editor.ITextModel): monaco.Range {
  const startLine = range.start;
  const endLine = range.start + Math.max(range.length, 1) - 1;
  return new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
}

function countLineBreaks(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function rangesIntersect(start: number, end: number, changeStart: number, changeEnd: number): boolean {
  return start < changeEnd && changeStart < end;
}
