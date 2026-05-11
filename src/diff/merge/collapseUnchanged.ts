import type { MergeChange } from '../../types';

export interface PaneRange {
    start: number;
    length: number;
}

export interface MergePaneRanges {
    local: PaneRange;
    result: PaneRange;
    remote: PaneRange;
}

export interface HiddenArea {
    startLine: number;
    endLine: number;
}

export interface MergeHiddenAreas {
    local: HiddenArea[];
    result: HiddenArea[];
    remote: HiddenArea[];
}

const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MIN_COLLAPSIBLE_LINES = 8;

export function computeCollapsedUnchangedAreas(
    hunks: readonly MergeChange[],
    getRanges: (hunkId: number) => MergePaneRanges,
    options: { contextLines?: number; minLines?: number } = {}
): MergeHiddenAreas {
    const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
    const minLines = options.minLines ?? DEFAULT_MIN_COLLAPSIBLE_LINES;
    const hidden: MergeHiddenAreas = { local: [], result: [], remote: [] };

    for (const hunk of hunks) {
        if (hunk.kind !== 'equal') continue;
        const ranges = getRanges(hunk.id);
        const localHidden = toHiddenArea(ranges.local, contextLines, minLines);
        const resultHidden = toHiddenArea(ranges.result, contextLines, minLines);
        const remoteHidden = toHiddenArea(ranges.remote, contextLines, minLines);
        if (localHidden) hidden.local.push(localHidden);
        if (resultHidden) hidden.result.push(resultHidden);
        if (remoteHidden) hidden.remote.push(remoteHidden);
    }

    return hidden;
}

function toHiddenArea(range: PaneRange, contextLines: number, minLines: number): HiddenArea | null {
    if (range.length < minLines) return null;
    const startLine = range.start + contextLines;
    const endLine = range.start + range.length - contextLines - 1;
    if (startLine > endLine) return null;
    return { startLine, endLine };
}