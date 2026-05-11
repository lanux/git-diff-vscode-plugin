import { BitSet } from './bitSet';
import { computeMyersLcsChanges, computeMyersLcsChangesLinear } from './myersLcs';
import { FilesTooBigForDiffError } from './types';
import { UniqueLCS } from './uniqueLcs';
import type { LcsChangeComputer } from './diff';

export interface LcsFallbackOptions {
    myersThreshold?: number;
    failOnSmallReduction?: boolean;
}

// Mirrors IntelliJ DiffConfig.USE_PATIENCE_ALG (default false): when true the
// LCS step uses PatienceIntLCS directly; when false it uses Myers with a
// Patience fallback (the current/IntelliJ-default behavior).
export const USE_PATIENCE_ALG = false;

// The LCS computer the ByLine pipeline (and the word-level resolver) should use
// by default — matches DiffConfig.USE_PATIENCE_ALG. byline.md §3.2.
export function defaultLcsComputer(usePatienceAlg = USE_PATIENCE_ALG): LcsChangeComputer {
    return usePatienceAlg
        ? (ints1, ints2) => computePatienceLcsChanges(ints1, ints2, false)
        : computeLcsChangesWithFallback;
}

export function computeLcsChangesWithFallback(
    ints1: readonly number[],
    ints2: readonly number[],
    options: LcsFallbackOptions = {}
): readonly [BitSet, BitSet] {
    try {
        return computeMyersLcsChanges(ints1, ints2, options.myersThreshold);
    } catch (error) {
        if (!(error instanceof FilesTooBigForDiffError)) throw error;
        return computePatienceLcsChanges(ints1, ints2, options.failOnSmallReduction ?? true);
    }
}

export function computePatienceLcsChanges(
    ints1: readonly number[],
    ints2: readonly number[],
    failOnSmallReduction = false
): readonly [BitSet, BitSet] {
    const changes1 = new BitSet(ints1.length);
    const changes2 = new BitSet(ints2.length);
    executePatience(ints1, ints2, 0, ints1.length, 0, ints2.length, failOnSmallReduction ? 2 : -1, changes1, changes2, ints1.length, ints2.length);
    return [changes1, changes2];
}

export function executePatience(
    first: readonly number[],
    second: readonly number[],
    start1: number,
    count1: number,
    start2: number,
    count2: number,
    thresholdCheckCounter: number,
    changes1: BitSet,
    changes2: BitSet,
    rootCount1: number,
    rootCount2: number
): void {
    if (count1 === 0 && count2 === 0) return;
    if (count1 === 0 || count2 === 0) {
        addChange(changes1, changes2, start1, count1, start2, count2);
        return;
    }

    const startOffset = matchForward(first, second, start1, count1, start2, count2);
    const nextStart1 = start1 + startOffset;
    const nextStart2 = start2 + startOffset;
    const remainingCount1 = count1 - startOffset;
    const remainingCount2 = count2 - startOffset;

    const endOffset = matchBackward(first, second, nextStart1, remainingCount1, nextStart2, remainingCount2);
    const trimmedCount1 = remainingCount1 - endOffset;
    const trimmedCount2 = remainingCount2 - endOffset;

    if (trimmedCount1 === 0 || trimmedCount2 === 0) {
        addChange(changes1, changes2, nextStart1, trimmedCount1, nextStart2, trimmedCount2);
        return;
    }

    let nextThresholdCounter = thresholdCheckCounter;
    if (nextThresholdCounter === 0) {
        checkReduction(trimmedCount1, trimmedCount2, rootCount1, rootCount2);
    }
    nextThresholdCounter = Math.max(-1, nextThresholdCounter - 1);

    const uniqueLcs = new UniqueLCS(first, second, nextStart1, trimmedCount1, nextStart2, trimmedCount2);
    const matching = uniqueLcs.execute();

    if (matching === null) {
        if (nextThresholdCounter >= 0) {
            checkReduction(trimmedCount1, trimmedCount2, rootCount1, rootCount2);
        }
        applyMyersSubrange(first, second, nextStart1, trimmedCount1, nextStart2, trimmedCount2, changes1, changes2);
        return;
    }

    const [firstMatching, secondMatching] = matching;
    let childCount1 = firstMatching[0];
    let childCount2 = secondMatching[0];
    executePatience(first, second, nextStart1, childCount1, nextStart2, childCount2, nextThresholdCounter, changes1, changes2, rootCount1, rootCount2);

    for (let i = 1; i < firstMatching.length; i++) {
        const segmentStart1 = firstMatching[i - 1] + 1;
        const segmentStart2 = secondMatching[i - 1] + 1;
        childCount1 = firstMatching[i] - segmentStart1;
        childCount2 = secondMatching[i] - segmentStart2;
        if (childCount1 > 0 || childCount2 > 0) {
            executePatience(
                first,
                second,
                nextStart1 + segmentStart1,
                childCount1,
                nextStart2 + segmentStart2,
                childCount2,
                nextThresholdCounter,
                changes1,
                changes2,
                rootCount1,
                rootCount2
            );
        }
    }

    const lastIndex = firstMatching.length - 1;
    const tailStart1 = firstMatching[lastIndex] === trimmedCount1 - 1 ? trimmedCount1 - 1 : firstMatching[lastIndex] + 1;
    const tailCount1 = firstMatching[lastIndex] === trimmedCount1 - 1 ? 0 : trimmedCount1 - tailStart1;
    const tailStart2 = secondMatching[lastIndex] === trimmedCount2 - 1 ? trimmedCount2 - 1 : secondMatching[lastIndex] + 1;
    const tailCount2 = secondMatching[lastIndex] === trimmedCount2 - 1 ? 0 : trimmedCount2 - tailStart2;

    executePatience(
        first,
        second,
        nextStart1 + tailStart1,
        tailCount1,
        nextStart2 + tailStart2,
        tailCount2,
        nextThresholdCounter,
        changes1,
        changes2,
        rootCount1,
        rootCount2
    );
}

function matchForward(
    first: readonly number[],
    second: readonly number[],
    start1: number,
    count1: number,
    start2: number,
    count2: number
): number {
    const size = Math.min(count1, count2);
    let index = 0;
    for (let i = 0; i < size; i++) {
        if (first[start1 + i] !== second[start2 + i]) break;
        index++;
    }
    return index;
}

function matchBackward(
    first: readonly number[],
    second: readonly number[],
    start1: number,
    count1: number,
    start2: number,
    count2: number
): number {
    const size = Math.min(count1, count2);
    let index = 0;
    for (let i = 1; i <= size; i++) {
        if (first[start1 + count1 - i] !== second[start2 + count2 - i]) break;
        index++;
    }
    return index;
}

function addChange(
    changes1: BitSet,
    changes2: BitSet,
    start1: number,
    count1: number,
    start2: number,
    count2: number
): void {
    changes1.set(start1, start1 + count1, true);
    changes2.set(start2, start2 + count2, true);
}

function checkReduction(count1: number, count2: number, rootCount1: number, rootCount2: number): void {
    if (count1 * 2 < rootCount1) return;
    if (count2 * 2 < rootCount2) return;
    throw new FilesTooBigForDiffError();
}

function applyMyersSubrange(
    first: readonly number[],
    second: readonly number[],
    start1: number,
    count1: number,
    start2: number,
    count2: number,
    changes1: BitSet,
    changes2: BitSet
): void {
    const [subChanges1, subChanges2] = computeMyersLcsChangesLinear(
        first.slice(start1, start1 + count1),
        second.slice(start2, start2 + count2)
    );

    for (let i = 0; i < count1; i++) {
        if (subChanges1.get(i)) changes1.set(start1 + i, true);
    }
    for (let i = 0; i < count2; i++) {
        if (subChanges2.get(i)) changes2.set(start2 + i, true);
    }
}
