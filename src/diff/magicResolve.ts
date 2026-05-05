import { Hunk } from '../types';
import { normalizeLine } from './whitespace';

const IMPORT_LINE = /^\s*(?:import\b|from\s+\S+\s+import\b|#include\b|using\s+\w+\b|require\s*\()/;

/**
 * Heuristically resolve conflicts:
 *  - whitespace-only differences → keep local
 *  - both sides are pure import/require blocks → take sorted union (de-duped)
 * Returns the number of hunks resolved.
 */
export function magicResolve(hunks: Hunk[]): number {
  let resolved = 0;
  for (const h of hunks) {
    if (h.kind !== 'conflict' || h.status !== 'pending') continue;

    if (linesEqualIgnoringWS(h.localLines, h.remoteLines)) {
      h.resolvedLines = h.localLines.slice();
      h.status = 'accepted-local';
      resolved++;
      continue;
    }

    if (allImportLines(h.localLines) && allImportLines(h.remoteLines)) {
      const merged = Array.from(new Set([...h.localLines, ...h.remoteLines]))
        .filter((l) => l.trim().length > 0)
        .sort();
      h.resolvedLines = merged;
      h.status = 'accepted-both';
      resolved++;
    }
  }
  return resolved;
}

function linesEqualIgnoringWS(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    const an = a.map((l) => normalizeLine(l, 'whole')).filter((l) => l.length > 0);
    const bn = b.map((l) => normalizeLine(l, 'whole')).filter((l) => l.length > 0);
    if (an.length !== bn.length) return false;
    for (let i = 0; i < an.length; i++) if (an[i] !== bn[i]) return false;
    return true;
  }
  for (let i = 0; i < a.length; i++) {
    if (normalizeLine(a[i], 'whole') !== normalizeLine(b[i], 'whole')) return false;
  }
  return true;
}

function allImportLines(lines: string[]): boolean {
  const meaningful = lines.filter((l) => l.trim().length > 0);
  if (meaningful.length === 0) return false;
  return meaningful.every((l) => IMPORT_LINE.test(l));
}
