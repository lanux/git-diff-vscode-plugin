export const IMPORT_LINE = /^\s*(?:import\b|from\s+\S+\s+import\b|#include\b|using\s+\w+\b|require\s*\(|export\s+.*\s+from\b)/;

export function isImportBlock(lines: readonly string[]): boolean {
  const meaningful = lines.filter((line) => line.trim().length > 0);
  return meaningful.length > 0 && meaningful.every((line) => IMPORT_LINE.test(line));
}

export function isImportChange(
  localLines: readonly string[],
  baseLines: readonly string[],
  remoteLines: readonly string[]
): boolean {
  const meaningful = [...localLines, ...baseLines, ...remoteLines].filter((line) => line.trim().length > 0);
  return meaningful.length > 0 && meaningful.every((line) => IMPORT_LINE.test(line));
}

/**
 * Heuristic stand-in for IntelliJ's PSI-based import range (see byline.md §18.10,
 * design.md §4.1). Finds the smallest contiguous `[start, end)` line range that
 * covers every import-ish line, allowing blank lines anywhere and arbitrary
 * non-import lines *before* the first import (license headers etc.) but not
 * *between* two import lines. Returns `[0, 0)` when there is no import line.
 *
 * This is a heuristic — unlike IntelliJ we cannot re-parse each side's PSI, so
 * the three sides may disagree on the exact range. Callers that segment a merge
 * around it must tolerate the boundary not lining up perfectly across sides.
 */
export function findImportBlockRange(lines: readonly string[]): { start: number; end: number } {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    if (IMPORT_LINE.test(lines[i])) {
      if (first === -1) first = i;
      last = i;
    } else if (first !== -1) {
      break; // a real (non-blank, non-import) line after we have seen imports → stop
    }
  }
  if (first === -1) return { start: 0, end: 0 };
  return { start: first, end: last + 1 };
}

/**
 * Heuristic import-block merge for auto/magic resolution: an order-preserving,
 * de-duped union — BASE order first (so existing grouping survives), then any
 * imports added only on the LOCAL side, then any added only on the RIGHT side.
 * IntelliJ does a PSI-based import-list merge (per-statement, grouped) which we
 * cannot replicate without parsing; this is the closest deterministic stand-in.
 * Only used as the `autoResolvedLines` for hunks whose content is entirely
 * import lines (and the magic-resolve / auto-resolve-imports shortcuts).
 */
export function mergeImportBlocks(
  localLines: readonly string[],
  baseLines: readonly string[],
  remoteLines: readonly string[]
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of [...baseLines, ...localLines, ...remoteLines]) {
    if (line.trim().length === 0 || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}
