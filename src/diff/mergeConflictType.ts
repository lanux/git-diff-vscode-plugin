// Mirror of IntelliJ MergeConflictType + MergeRangeUtil.getMergeType (see byline.md / design.md).
// Pure data — no UI deps.
import { normalizeLine, type IgnoreWhitespace } from './whitespace';

export type ConflictKind = 'INSERTED' | 'DELETED' | 'MODIFIED' | 'CONFLICT';

// Mirrors IDEA's resolutionStrategy. null = not auto-resolvable.
export type ResolutionStrategy = 'DEFAULT' | 'TEXT' | 'SEMANTIC' | null;

export interface MergeConflictType {
  type: ConflictKind;
  /** left side has change vs base */
  leftChange: boolean;
  /** right side has change vs base */
  rightChange: boolean;
  /** null when not auto-resolvable */
  resolutionStrategy: ResolutionStrategy;
}

export function isChange(t: MergeConflictType, side: 'local' | 'remote' | 'base'): boolean {
  if (side === 'base') return true; // BASE always participates per IDEA
  return side === 'local' ? t.leftChange : t.rightChange;
}

export function canBeResolved(t: MergeConflictType): boolean {
  return t.resolutionStrategy !== null;
}

/**
 * IDEA's MergeRangeUtil.getLineMergeType, transcribed.
 *
 * Inputs are the actual line contents on each side for one fragment, plus
 * the active whitespace policy. We pass arrays (not lineOffsets+ranges) since
 * the host already has them in hand.
 *
 * `tryAutoResolve` is the word-level resolver hook (P1-9). If null we set
 * resolutionStrategy=null on CONFLICT so the magic-wand stays hidden.
 */
export function classifyFragment(
  localLines: string[],
  baseLines: string[],
  remoteLines: string[],
  policy: IgnoreWhitespace = 'none',
  tryAutoResolve: ((l: string[], b: string[], r: string[]) => string[] | null) | null = null
): MergeConflictType {
  const isLeftEmpty = localLines.length === 0;
  const isBaseEmpty = baseLines.length === 0;
  const isRightEmpty = remoteLines.length === 0;

  if (isBaseEmpty) {
    if (isLeftEmpty && isRightEmpty) {
      // degenerate empty fragment — not expected in practice
      return { type: 'MODIFIED', leftChange: false, rightChange: false, resolutionStrategy: 'DEFAULT' };
    }
    if (isLeftEmpty) {
      return { type: 'INSERTED', leftChange: false, rightChange: true, resolutionStrategy: 'DEFAULT' };
    }
    if (isRightEmpty) {
      return { type: 'INSERTED', leftChange: true, rightChange: false, resolutionStrategy: 'DEFAULT' };
    }
    if (linesEqual(localLines, remoteLines, policy)) {
      return { type: 'INSERTED', leftChange: true, rightChange: true, resolutionStrategy: 'DEFAULT' };
    }
    // both inserted, different content
    const strat = tryAutoResolve && tryAutoResolve(localLines, baseLines, remoteLines) !== null ? 'TEXT' : null;
    return { type: 'CONFLICT', leftChange: true, rightChange: true, resolutionStrategy: strat };
  }

  // base is non-empty
  if (isLeftEmpty && isRightEmpty) {
    return { type: 'DELETED', leftChange: true, rightChange: true, resolutionStrategy: 'DEFAULT' };
  }

  const unchangedLeft = !isLeftEmpty && linesEqual(localLines, baseLines, policy);
  const unchangedRight = !isRightEmpty && linesEqual(remoteLines, baseLines, policy);

  if (unchangedLeft && unchangedRight) {
    // both equal under policy — flag whichever side is *strictly* different (handles "true equality" subtlety)
    const leftStrict = linesEqual(localLines, baseLines, 'none');
    const rightStrict = linesEqual(remoteLines, baseLines, 'none');
    return { type: 'MODIFIED', leftChange: !leftStrict, rightChange: !rightStrict, resolutionStrategy: 'DEFAULT' };
  }

  if (unchangedLeft) {
    // left == base, right changed
    const type: ConflictKind = isRightEmpty ? 'DELETED' : 'MODIFIED';
    return { type, leftChange: false, rightChange: true, resolutionStrategy: 'DEFAULT' };
  }

  if (unchangedRight) {
    const type: ConflictKind = isLeftEmpty ? 'DELETED' : 'MODIFIED';
    return { type, leftChange: true, rightChange: false, resolutionStrategy: 'DEFAULT' };
  }

  if (linesEqual(localLines, remoteLines, policy)) {
    return { type: 'MODIFIED', leftChange: true, rightChange: true, resolutionStrategy: 'DEFAULT' };
  }

  // genuine CONFLICT
  const canResolve = !isLeftEmpty && !isRightEmpty && tryAutoResolve
    && tryAutoResolve(localLines, baseLines, remoteLines) !== null;
  return {
    type: 'CONFLICT',
    leftChange: true,
    rightChange: true,
    resolutionStrategy: canResolve ? 'TEXT' : null
  };
}

function linesEqual(a: string[], b: string[], policy: IgnoreWhitespace): boolean {
  if (a.length !== b.length) return false;
  if (policy === 'none') {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  for (let i = 0; i < a.length; i++) {
    if (normalizeLine(a[i], policy) !== normalizeLine(b[i], policy)) return false;
  }
  return true;
}
