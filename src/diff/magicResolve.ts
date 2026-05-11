import type { MergeChange } from '../types';
import { isChangeRangeModified, MergeConflictModel } from './merge/mergeModel';

/**
 * Magic Resolve — auto-resolve every still-pending conflict hunk that can be
 * resolved. Backs the toolbar "Resolve Simple Conflicts" wand and the per-hunk
 * BASE-column wand (design.md §8). Mirrors IntelliJ's
 * `resolveChangeAutomatically(BASE)` path only; import-only and whitespace-only
 * shortcuts are handled elsewhere in the pipeline rather than being special
 * cases here.
 * Hunks whose result range the user has hand-edited (`isChangeRangeModified`)
 * are skipped. Returns the ids of the hunks that changed.
 */
export function magicResolve(hunks: MergeChange[]): number[] {
  const model = new MergeConflictModel(hunks);
  const changed: number[] = [];
  for (const h of hunks) {
    if (h.kind !== 'conflict' || h.status !== 'pending') continue;
    if (isChangeRangeModified(h)) continue;

    if (model.resolveChangeAutomatically(h, 'base')) changed.push(h.id);
  }
  return changed;
}
