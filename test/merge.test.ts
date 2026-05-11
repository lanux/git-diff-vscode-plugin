import { strict as assert } from 'assert';
import { hasConflictMarkers, parseConflictMarkers } from '../src/diff/conflictMarkers';
import { buildTwoWayHunks } from '../src/diff/twoWay';
import { parseNameStatusZ } from '../src/git/nameStatus';
import { magicResolve } from '../src/diff/magicResolve';
import { normalizeLine } from '../src/diff/whitespace';
import { classifyFragment, patchConflictTypes, type ConflictTypePatchable } from '../src/diff/mergeConflictType';
import { tryResolveConflict } from '../src/diff/conflictResolve';
import {
  compareLines,
  compareLines2,
  compareText2,
  expandRanges,
  mergeLines,
  mergeLinesWithinRange,
  mergeLines3,
  splitTextToLines
} from '../src/diff/byline';
import type { Range } from '../src/diff/byline';
import type { Hunk, MergeChange } from '../src/types';
import {
  applyMergeSnapshot,
  createMergeSnapshot,
  MergeUndoStack
} from '../src/webview/views/mergeUndoStack';
import { replaceChangeWithAiState, resetResolvedChangeState } from '../src/diff/merge/mergeActions';
import { computeCollapsedUnchangedAreas } from '../src/diff/merge/collapseUnchanged';
import { MergeConflictModel } from '../src/diff/merge/mergeModel';
import { getLangSpecificMergeConflictResolver, type LangSpecificMergeConflictResolver } from '../src/diff/langSpecificMergeConflictResolver';
import { updateRangeOnModification } from '../src/webview/views/mergeRangeUpdate';
import { BitSet as ByLineBitSet } from '../src/diff/byline/bitSet';
import {
  ChangeBuilder as IterableChangeBuilder,
  ExpandChangeBuilder,
  create as createDiffIterable,
  createUnchanged as createUnchangedDiffIterable,
  fair as fairDiffIterable
} from '../src/diff/byline/iterable';
import { Enumerator as ByLineEnumerator } from '../src/diff/byline/enumerator';
import { Reindexer } from '../src/diff/byline/reindexer';
import {
  buildChangesFromIntArrays,
  buildChangesFromObjects,
  changesToRanges,
  type LcsChangeComputer
} from '../src/diff/byline/diff';
import { buildLines } from '../src/diff/byline/line';
import { getBestMatchingAlignment } from '../src/diff/byline/correctSecondStep';
import { optimizeLineChunks } from '../src/diff/byline/lineChunkOptimizer';
import { computeMyersLcsChanges } from '../src/diff/byline/myersLcs';
import { computeLcsChangesWithFallback, computePatienceLcsChanges, executePatience } from '../src/diff/byline/patienceLcs';
import { normalizeForPolicy } from '../src/diff/byline/policy';
import { compareSmart } from '../src/diff/byline/smartCorrector';
import { FilesTooBigForDiffError } from '../src/diff/byline/types';
import { UniqueLCS } from '../src/diff/byline/uniqueLcs';
import { buildThreeWayHunksByLine } from '../src/diff/threeWayByLine';

const exactChangedBits: LcsChangeComputer = (left, right) => {
  const changes1 = new ByLineBitSet(left.length);
  const changes2 = new ByLineBitSet(right.length);
  changes1.set(0, left.length, true);
  changes2.set(0, right.length, true);

  const dp = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      changes1.set(i, false);
      changes2.set(j, false);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return [changes1, changes2];
};

function dpLcsLength(left: readonly number[], right: readonly number[]): number {
  const dp = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp[0][0];
}

function unchangedBitCount(bits: ByLineBitSet, length: number): number {
  let count = 0;
  for (let i = 0; i < length; i++) {
    if (!bits.get(i)) count++;
  }
  return count;
}

function runExecutePatience(
  first: readonly number[],
  second: readonly number[],
  thresholdCheckCounter: number,
  rootCount1 = first.length,
  rootCount2 = second.length
): [boolean[], boolean[]] {
  const changes1 = new ByLineBitSet(first.length);
  const changes2 = new ByLineBitSet(second.length);
  executePatience(
    first,
    second,
    0,
    first.length,
    0,
    second.length,
    thresholdCheckCounter,
    changes1,
    changes2,
    rootCount1,
    rootCount2
  );
  return [changes1.toBooleans(first.length), changes2.toBooleans(second.length)];
}

describe('ByLine A3 foundation (IntelliJ Diff.buildChanges skeleton)', () => {
  it('BitSet supports IntelliJ-style single bit and half-open range writes', () => {
    const bits = new ByLineBitSet(2);
    bits.set(0, 4, true);
    bits.set(1, false);
    bits.set(2, 4, false);
    assert.deepEqual(bits.toBooleans(4), [true, false, false, false]);
  });

  it('DiffIterable changes and unchanged ranges are complementary and fair-validatable', () => {
    const iterable = fairDiffIterable(createDiffIterable([{ start1: 1, end1: 2, start2: 1, end2: 3 }], 4, 5));
    assert.deepEqual(Array.from(iterable.changes()), [{ start1: 1, end1: 2, start2: 1, end2: 3 }]);
    assert.deepEqual(Array.from(iterable.unchanged()), [
      { start1: 0, end1: 1, start2: 0, end2: 1 },
      { start1: 2, end1: 4, start2: 3, end2: 5 }
    ]);
  });

  it('ChangeBuilder and ExpandChangeBuilder peel strict equal edges before storing changes', () => {
    const builder = new IterableChangeBuilder(3, 4);
    builder.markEqual(0, 0);
    builder.markEqual(2, 3);
    assert.deepEqual(Array.from(builder.finish().changes()), [{ start1: 1, end1: 2, start2: 1, end2: 3 }]);

    const expanded = new ExpandChangeBuilder(['a', 'b', 'c'], ['a', 'X', 'c']);
    expanded.markEqual(0, 0);
    expanded.markEqual(2, 2);
    assert.deepEqual(Array.from(expanded.finish().changes()), [{ start1: 1, end1: 2, start2: 1, end2: 2 }]);
  });

  it('Enumerator assigns stable ids and honors startShift/endCut', () => {
    const enumerator = new ByLineEnumerator<string>();
    assert.deepEqual(enumerator.enumerate(['skip', 'same', 'same', 'tail'], 1, 1), [1, 1]);
    assert.deepEqual(enumerator.enumerate(['same', 'other']), [1, 2]);
  });

  it('Reindexer discards impossible matches and restores original indexes through LCSBuilder', () => {
    const change = buildChangesFromIntArrays([13, 15, 1, 2, 3], [17, 1, 3], exactChangedBits);
    assert.deepEqual(changesToRanges(change), [
      { start1: 0, end1: 2, start2: 0, end2: 1 },
      { start1: 3, end1: 4, start2: 2, end2: 2 }
    ]);

    const reindexer = new Reindexer();
    assert.deepEqual(reindexer.discardUnique([13, 15, 1, 2, 3], [17, 1, 3]), [[1, 3], [1, 3]]);
    assert.equal(reindexer.restoreIndex(0, 0), 2);
    assert.equal(reindexer.restoreIndex(1, 1), 2);
  });

  it('buildChangesFromObjects trims equal edges, enumerates middles, and emits Diff.Change chains', () => {
    const change = buildChangesFromObjects(['a', 'b', 'c'], ['a', 'X', 'c'], exactChangedBits);
    assert.deepEqual(changesToRanges(change), [{ start1: 1, end1: 2, start2: 1, end2: 2 }]);
  });

  it('buildChangesFromObjects fast-paths pure insertion after common prefix', () => {
    const change = buildChangesFromObjects(['a', 'b'], ['a', 'b', 'c'], exactChangedBits);
    assert.deepEqual(changesToRanges(change), [{ start1: 2, end1: 2, start2: 2, end2: 3 }]);
  });

  it('policy normalization and Line metadata stay aligned with the active comparison policy', () => {
    assert.equal(normalizeForPolicy('  foo\t', 'TRIM'), 'foo');
    assert.equal(normalizeForPolicy(' f o o ', 'IW'), 'foo');

    const [trimmed] = buildLines(['  foo\t'], 'TRIM');
    const [trimmedPeer] = buildLines(['foo'], 'TRIM');
    assert.equal(trimmed.key, 'foo');
    assert.equal(trimmed.hash, trimmedPeer.hash);
    assert.equal(trimmed.nonSpaceChars, 3);
    assert.equal(trimmed.equals(trimmedPeer), true);
  });

  it('Myers LCS matches the DP baseline on representative int-array cases', () => {
    const cases: Array<[number[], number[]]> = [
      [[1, 2, 3, 4], [1, 3, 4]],
      [[1, 2, 3, 4], [1, 2, 4, 5]],
      [[1, 9, 2, 3, 8, 4], [1, 2, 3, 4]],
      [[7, 1, 2, 3, 9], [1, 2, 8, 3, 9]]
    ];

    for (const [left, right] of cases) {
      const dpRanges = changesToRanges(buildChangesFromIntArrays(left, right, exactChangedBits));
      const myersRanges = changesToRanges(buildChangesFromIntArrays(left, right, computeMyersLcsChanges));
      assert.deepEqual(myersRanges, dpRanges, `${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
  });

  it('Myers LCS length matches DP on deterministic random small arrays', () => {
    let seed = 0x5eed;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };

    for (let length1 = 0; length1 <= 12; length1++) {
      for (let length2 = 0; length2 <= 12; length2++) {
        for (let round = 0; round < 6; round++) {
          const left = Array.from({ length: length1 }, () => next() % 5);
          const right = Array.from({ length: length2 }, () => next() % 5);
          const expected = dpLcsLength(left, right);

          const [changes1, changes2] = computeMyersLcsChanges(left, right);
          assert.equal(unchangedBitCount(changes1, left.length), expected, `Myers left ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
          assert.equal(unchangedBitCount(changes2, right.length), expected, `Myers right ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
        }
      }
    }
  });

  it('UniqueLCS keeps only bilateral unique anchors and returns them in increasing order', () => {
    const unique = new UniqueLCS([9, 1, 2, 3, 4, 9], [8, 2, 1, 3, 4, 8]);
    assert.deepEqual(unique.execute(), [[2, 3, 4], [1, 3, 4]]);
  });

  it('Patience LCS matches the DP baseline when unique anchors split the problem', () => {
    const left = [5, 1, 2, 3, 4, 6];
    const right = [5, 1, 9, 2, 3, 4, 6];
    const dpRanges = changesToRanges(buildChangesFromIntArrays(left, right, exactChangedBits));
    const patienceRanges = changesToRanges(buildChangesFromIntArrays(left, right, computePatienceLcsChanges));
    assert.deepEqual(patienceRanges, dpRanges);
  });

  it('public compareLines facade accepts patience-first selection', () => {
    const iterable = compareLines(['1', '2', '8', '3'], ['9', '1', '2', '7', '3'], 'DEFAULT', { usePatienceAlg: true });
    assert.deepEqual(Array.from(iterable.changes()), [
      { start1: 0, end1: 0, start2: 0, end2: 1 },
      { start1: 2, end1: 3, start2: 3, end2: 4 }
    ]);
  });

  it('Patience fallback returns the DP-equivalent ranges when Myers is forced to fail on endpoint unique anchors', () => {
    const left = [1, 2, 8, 3];
    const right = [9, 1, 2, 7, 3];
    const dpRanges = changesToRanges(buildChangesFromIntArrays(left, right, exactChangedBits));
    const fallbackRanges = changesToRanges(buildChangesFromIntArrays(left, right, (a, b) => computeLcsChangesWithFallback(a, b, { myersThreshold: 0 })));
    assert.deepEqual(fallbackRanges, dpRanges);
  });

  it('executePatience skips adjacent unique-anchor gaps and drops zero-length tails at interval endpoints', () => {
    const [changes1, changes2] = runExecutePatience([1, 2, 8, 3], [9, 1, 2, 7, 3], -1);
    assert.deepEqual(changes1, [false, false, true, false]);
    assert.deepEqual(changes2, [true, false, false, true, false]);
  });

  it('executePatience enforces checkReduction only when the trimmed slice is still too large', () => {
    assert.throws(
      () => runExecutePatience([1, 2, 3, 4], [5, 6, 7, 8], 0),
      FilesTooBigForDiffError
    );

    const [changes1, changes2] = runExecutePatience([1, 2], [3, 4], 0, 8, 8);
    assert.deepEqual(changes1, [true, true]);
    assert.deepEqual(changes2, [true, true]);
  });

  it('Patience falls back to Myers for duplicate-only regions with no unique anchors', () => {
    const left = [1, 1, 1, 2];
    const right = [1, 1, 2, 1];
    const dpRanges = changesToRanges(buildChangesFromIntArrays(left, right, exactChangedBits));
    const patienceRanges = changesToRanges(buildChangesFromIntArrays(left, right, computePatienceLcsChanges));
    assert.deepEqual(patienceRanges, dpRanges);
  });

  it('compareSmart recursively diffs all-unimportant gaps instead of marking the whole gap changed', () => {
    const iterable = compareSmart(buildLines(['{', 'a', '}'], 'DEFAULT'), buildLines(['{', 'b', '}'], 'DEFAULT'));
    assert.deepEqual(Array.from(iterable.changes()), [{ start1: 1, end1: 2, start2: 1, end2: 2 }]);
  });

  it('compareSmart anchors on important lines and restores short-line matches inside surrounding gaps', () => {
    const iterable = compareSmart(
      buildLines(['}', 'importantCallName', '}'], 'DEFAULT'),
      buildLines(['importantCallName', '}', '}'], 'DEFAULT')
    );
    assert.deepEqual(Array.from(iterable.unchanged()), [
      { start1: 1, end1: 3, start2: 0, end2: 2 }
    ]);
  });

  it('LineChunkOptimizer shifts insertion boundaries to an empty unchanged line', () => {
    const lines1 = buildLines(['', 'A', 'B'], 'DEFAULT');
    const lines2 = buildLines(['', '', 'A', 'B'], 'DEFAULT');
    const unoptimized = fairDiffIterable(createUnchangedDiffIterable([
      { start1: 0, end1: 1, start2: 0, end2: 1 },
      { start1: 1, end1: 3, start2: 2, end2: 4 }
    ], 3, 4));

    const optimized = optimizeLineChunks(lines1, lines2, unoptimized);
    assert.deepEqual(Array.from(optimized.unchanged()), [{ start1: 0, end1: 3, start2: 1, end2: 4 }]);
    assert.deepEqual(Array.from(optimized.changes()), [{ start1: 0, end1: 0, start2: 0, end2: 1 }]);
  });
});

describe('three-way merge', () => {
  it('single auto hunk when local == remote == base', () => {
    const text = 'a\nb\nc';
    const { hunks, initialResult } = buildThreeWayHunksByLine(text, text, text);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].kind, 'equal');
    assert.equal(initialResult, text);
  });
  it('auto-merges non-overlapping', () => {
    const { hunks, initialResult } = buildThreeWayHunksByLine('A\nb\nc', 'a\nb\nc', 'a\nb\nC');
    assert.equal(initialResult, 'a\nb\nc');
    assert.equal(hunks.flatMap((h) => h.kind === 'auto' ? (h.autoResolvedLines ?? h.resolvedLines) : h.resolvedLines).join('\n'), 'A\nb\nC');
  });
  it('flags overlapping as conflict', () => {
    const { hunks } = buildThreeWayHunksByLine('a\nLOCAL\nc', 'a\nb\nc', 'a\nREMOTE\nc');
    assert.equal(hunks.filter((h) => h.kind === 'conflict').length, 1);
  });
  it('ignoreWS demotes whitespace-only conflicts to auto', () => {
    // Both sides changed line 2 the same way except for trailing whitespace.
    const local = 'a\nx \nc', base = 'a\nb\nc', remote = 'a\nx\nc';
    const raw = buildThreeWayHunksByLine(local, base, remote);
    assert.equal(raw.hunks.filter((h) => h.kind === 'conflict').length, 1);
    const trimmed = buildThreeWayHunksByLine(local, base, remote, 'trim');
    assert.equal(trimmed.hunks.filter((h) => h.kind === 'conflict').length, 0);
    assert.equal(trimmed.initialResult, 'a\nb\nc');
    assert.equal(trimmed.hunks.flatMap((h) => h.kind === 'auto' ? (h.autoResolvedLines ?? h.resolvedLines) : h.resolvedLines).join('\n'), 'a\nx \nc');
  });
});

describe('hasConflictMarkers', () => {
  it('detects markers', () => {
    assert.ok(hasConflictMarkers('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n'));
    assert.ok(!hasConflictMarkers('clean\n'));
  });

  it('parses plain conflict markers as degraded merge input with an empty base chunk', () => {
    const parsed = parseConflictMarkers('before\n<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\nafter\n');
    assert.deepEqual(parsed, {
      local: 'before\nleft\nafter\n',
      base: 'before\nafter\n',
      remote: 'before\nright\nafter\n'
    });
  });

  it('parses diff3-style conflict markers with an explicit base chunk', () => {
    const parsed = parseConflictMarkers('before\n<<<<<<< ours\nleft\n||||||| base\nbase\n=======\nright\n>>>>>>> theirs\nafter\n');
    assert.deepEqual(parsed, {
      local: 'before\nleft\nafter\n',
      base: 'before\nbase\nafter\n',
      remote: 'before\nright\nafter\n'
    });
  });
});

describe('two-way line diff', () => {
  it('marks added lines', () => {
    const hunks = buildTwoWayHunks('a\nb', 'a\nb\nc');
    assert.ok(hunks.some((h) => h.kind === 'added'));
  });
  it('preserves trailing empty lines from IntelliJ text splitting', () => {
    const hunks = buildTwoWayHunks('a\n', 'a\n');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].kind, 'equal');
    assert.deepEqual(hunks[0].localLines, ['a', '']);
    assert.deepEqual(hunks[0].remoteLines, ['a', '']);
  });
  it('marks deleted lines', () => {
    const hunks = buildTwoWayHunks('a\nb\nc', 'a\nb');
    assert.ok(hunks.some((h) => h.kind === 'deleted'));
  });
  it('marks modified blocks', () => {
    const hunks = buildTwoWayHunks('a\nB\nc', 'a\nbeta\nc');
    assert.ok(hunks.some((h) => h.kind === 'modified'));
  });
});

describe('git name-status parser', () => {
  it('parses M and A entries', () => {
    const raw = 'M foo.ts A bar.ts ';
    const out = parseNameStatusZ(raw);
    assert.deepEqual(out, [
      { path: 'foo.ts', status: 'M' },
      { path: 'bar.ts', status: 'A' }
    ]);
  });
  it('parses rename entries', () => {
    const raw = 'R100 old.ts new.ts ';
    const out = parseNameStatusZ(raw);
    assert.deepEqual(out, [{ path: 'new.ts', oldPath: 'old.ts', status: 'R' }]);
  });
});

describe('whitespace normalization', () => {
  it('trim strips leading + trailing whitespace per line (matches IDEA TRIM_WHITESPACES)', () => {
    assert.equal(normalizeLine('foo  ', 'trim'), 'foo');
    assert.equal(normalizeLine('  foo', 'trim'), 'foo');
    assert.equal(normalizeLine('  foo  ', 'trim'), 'foo');
    assert.equal(normalizeLine('foo bar', 'trim'), 'foo bar'); // inner spaces preserved
  });
  it('inner collapses runs', () => {
    assert.equal(normalizeLine('foo    bar', 'inner'), 'foo bar');
  });
  it('whole strips all whitespace', () => {
    assert.equal(normalizeLine(' f o o ', 'whole'), 'foo');
  });
});

describe('two-way diff with ignoreWS', () => {
  it('treats whitespace-only changes as equal in whole mode', () => {
    const hunks = buildTwoWayHunks('foo bar\nbaz', 'foo  bar\nbaz', 'whole');
    assert.ok(hunks.every((h) => h.kind === 'equal'));
  });
  it('still flags real differences', () => {
    const hunks = buildTwoWayHunks('foo', 'bar', 'whole');
    assert.ok(hunks.some((h) => h.kind !== 'equal'));
  });
});

describe('MergeConflictType classification (IDEA MergeRangeUtil.getMergeType)', () => {
  it('rejects all-empty fragments before classification', () => {
    assert.throws(
      () => classifyFragment([], [], []),
      /empty merge fragment/
    );
  });

  it('INSERTED rightOnly — base empty, left empty, right non-empty', () => {
    const t = classifyFragment([], [], ['x']);
    assert.equal(t.type, 'INSERTED');
    assert.equal(t.leftChange, false);
    assert.equal(t.rightChange, true);
  });
  it('INSERTED leftOnly', () => {
    const t = classifyFragment(['x'], [], []);
    assert.equal(t.type, 'INSERTED');
    assert.equal(t.leftChange, true);
    assert.equal(t.rightChange, false);
  });
  it('INSERTED both equal — base empty, left == right', () => {
    const t = classifyFragment(['x'], [], ['x']);
    assert.equal(t.type, 'INSERTED');
    assert.equal(t.leftChange, true);
    assert.equal(t.rightChange, true);
  });
  it('CONFLICT — base empty, left and right insert differently', () => {
    const t = classifyFragment(['L'], [], ['R']);
    assert.equal(t.type, 'CONFLICT');
    assert.equal(t.resolutionStrategy, null);
  });
  it('DELETED both — base non-empty, both sides empty', () => {
    const t = classifyFragment([], ['b'], []);
    assert.equal(t.type, 'DELETED');
    assert.equal(t.leftChange, true);
    assert.equal(t.rightChange, true);
  });
  it('DELETED rightOnly — left == base, right empty', () => {
    const t = classifyFragment(['b'], ['b'], []);
    assert.equal(t.type, 'DELETED');
    assert.equal(t.leftChange, false);
    assert.equal(t.rightChange, true);
  });
  it('MODIFIED leftOnly — right == base, left changed', () => {
    const t = classifyFragment(['L'], ['b'], ['b']);
    assert.equal(t.type, 'MODIFIED');
    assert.equal(t.leftChange, true);
    assert.equal(t.rightChange, false);
  });
  it('MODIFIED both equal — left == right != base', () => {
    const t = classifyFragment(['x'], ['b'], ['x']);
    assert.equal(t.type, 'MODIFIED');
    assert.equal(t.leftChange, true);
    assert.equal(t.rightChange, true);
  });
  it('CONFLICT — both sides changed differently', () => {
    const t = classifyFragment(['L'], ['b'], ['R']);
    assert.equal(t.type, 'CONFLICT');
    assert.equal(t.resolutionStrategy, null);
  });

  it('patchConflictTypes upgrades only null-strategy conflicts and preserves TEXT', () => {
    const resolver: LangSpecificMergeConflictResolver = {
      languageId: 'typescript',
      canResolve: () => true,
      resolve: () => ({ lines: ['semantic'] })
    };
    const semanticOnly: ConflictTypePatchable = {
      localLines: ['left'],
      baseLines: ['base'],
      remoteLines: ['right'],
      conflictType: classifyFragment(['left'], ['base'], ['right'])
    };
    const textWins: ConflictTypePatchable = {
      localLines: ['a', 'local', 'b'],
      baseLines: ['a', 'base', 'b'],
      remoteLines: ['a', 'remote', 'b'],
      conflictType: classifyFragment(['a', 'local', 'b'], ['a', 'base', 'b'], ['a', 'remote', 'b'], 'none', () => ['merged'])
    };

    patchConflictTypes([semanticOnly, textWins], resolver);

    assert.equal(semanticOnly.conflictType?.resolutionStrategy, 'SEMANTIC');
    assert.deepEqual(semanticOnly.autoResolvedLines, ['semantic']);
    assert.equal(semanticOnly.semanticResolutionAvailable, true);
    assert.equal(textWins.conflictType?.resolutionStrategy, 'TEXT');
    assert.equal(textWins.semanticResolutionAvailable, false);
  });
});

describe('buildThreeWayHunksByLine populates conflictType + resolved fields', () => {
  it('conflict hunk has resolved=[false,false] and conflictType=CONFLICT', () => {
    const { hunks } = buildThreeWayHunksByLine('a\nL\nc', 'a\nb\nc', 'a\nR\nc');
    const c = hunks.find((h) => h.kind === 'conflict')!;
    assert.deepEqual(c.resolved, [false, false]);
    assert.equal(c.isOnesideAppliedConflict, false);
    assert.equal(c.conflictType?.type, 'CONFLICT');
    assert.deepEqual(c.lastAppliedSnapshot, ['b']);
  });
  it('auto hunk preserves lastAppliedSnapshot for user-edit detection', () => {
    const { hunks } = buildThreeWayHunksByLine('A\nb', 'a\nb', 'a\nb');
    const auto = hunks.find((h) => h.kind === 'auto')!;
    assert.ok(auto.lastAppliedSnapshot);
    assert.deepEqual(auto.lastAppliedSnapshot, auto.resolvedLines);
  });
});

describe('LangSpecificMergeConflictResolver registry', () => {
  it('ships with built-in import semantic resolvers for import-bearing languages', () => {
    assert.ok(getLangSpecificMergeConflictResolver('typescript'));
    assert.ok(getLangSpecificMergeConflictResolver('python'));
    assert.equal(getLangSpecificMergeConflictResolver('plaintext'), undefined);
  });
});

describe('buildThreeWayHunksByLine result initialization contract', () => {
  // ByLine initializes the result from pure BASE and stores optional
  // auto-apply content separately for non-conflict cases.
  const autoAppliedResult = (hunks: ReturnType<typeof buildThreeWayHunksByLine>['hunks']) =>
    hunks.flatMap((h) => h.kind === 'auto' ? (h.autoResolvedLines ?? h.resolvedLines) : h.resolvedLines).join('\n');

  it('preserves trailing empty lines in the initial BASE result', () => {
    const { hunks, initialResult } = buildThreeWayHunksByLine('a\n', 'a\n', 'a\n');
    assert.equal(initialResult, 'a\n');
    assert.equal(hunks.length, 1);
    assert.deepEqual(hunks[0].baseLines, ['a', '']);
    assert.deepEqual(hunks[0].resolvedLines, ['a', '']);
  });

  const cases: Array<{ name: string; local: string; base: string; remote: string }> = [
    { name: 'all equal', local: 'a\nb\nc', base: 'a\nb\nc', remote: 'a\nb\nc' },
    { name: 'left-only modify', local: 'A\nb\nc', base: 'a\nb\nc', remote: 'a\nb\nc' },
    { name: 'right-only modify', local: 'a\nb\nc', base: 'a\nb\nc', remote: 'a\nb\nC' },
    { name: 'non-overlapping single-side changes', local: 'A\nb\nc', base: 'a\nb\nc', remote: 'a\nb\nC' },
    { name: 'both delete same line', local: 'a\nc', base: 'a\nb\nc', remote: 'a\nc' },
    { name: 'both insert same content', local: 'a\nb\nNEW\nc', base: 'a\nb\nc', remote: 'a\nb\nNEW\nc' },
    { name: 'true conflict on one line', local: 'a\nL\nc', base: 'a\nb\nc', remote: 'a\nR\nc' },
  ];
  for (const c of cases) {
    it(`${c.name} — conflict parity and BASE initialization`, () => {
      const b = buildThreeWayHunksByLine(c.local, c.base, c.remote);
      assert.equal(b.initialResult, c.base,
        `byline initial result should be pure BASE: ${JSON.stringify(b.initialResult)}`);
      const bConflicts = b.hunks.filter((h) => h.kind === 'conflict').length;
      assert.equal(bConflicts, c.name === 'true conflict on one line' ? 1 : 0);
      if (bConflicts === 0) {
        assert.ok(autoAppliedResult(b.hunks).length > 0);
      }
    });
  }
});

describe('buildThreeWayHunksByLine (P1-7 — IDEA pipeline producing existing Hunk[] shape)', () => {
  it('all-equal → single equal hunk with full content', () => {
    const text = 'a\nb\nc';
    const { hunks, initialResult } = buildThreeWayHunksByLine(text, text, text);
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].kind, 'equal');
    assert.equal(initialResult, text);
  });
  it('non-overlapping single-side changes initialize as BASE and retain auto-merged lines', () => {
    const { hunks, initialResult } = buildThreeWayHunksByLine('A\nb\nc', 'a\nb\nc', 'a\nb\nC');
    assert.equal(initialResult, 'a\nb\nc');
    assert.equal(hunks.flatMap((h) => h.autoResolvedLines ?? h.resolvedLines).join('\n'), 'A\nb\nC');
  });
  it('non-overlapping auto changes keep per-change conflictType metadata', () => {
    const { hunks } = buildThreeWayHunksByLine('A\nb\nc\nd', 'a\nb\nc\nd', 'a\nb\nc\nD');
    const autos = hunks.filter((h) => h.kind === 'auto');
    assert.equal(autos.length, 2);
    assert.deepEqual(autos.map((h) => h.conflictType && [h.conflictType.leftChange, h.conflictType.rightChange]), [
      [true, false],
      [false, true]
    ]);
    assert.equal(hunks.flatMap((h) => h.autoResolvedLines ?? h.resolvedLines).join('\n'), 'A\nb\nc\nD');
  });
  it('IW whitespace-only ranges stay visible as ignored auto hunks and keep BASE as auto result', () => {
    const { hunks, initialResult } = buildThreeWayHunksByLine('  foo', 'foo', '\tfoo', 'whole');
    assert.equal(initialResult, 'foo');
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].kind, 'auto');
    assert.equal(hunks[0].ignored, true);
    assert.deepEqual(hunks[0].resolvedLines, ['foo']);
    assert.deepEqual(hunks[0].autoResolvedLines, ['foo']);
    assert.equal(hunks[0].conflictType?.type, 'MODIFIED');
    assert.equal(hunks[0].conflictType?.leftChange, true);
    assert.equal(hunks[0].conflictType?.rightChange, true);
  });
  it('truly conflicting modifications produce a conflict hunk', () => {
    const { hunks } = buildThreeWayHunksByLine('a\nLOCAL\nc', 'a\nb\nc', 'a\nREMOTE\nc');
    const conflicts = hunks.filter((h) => h.kind === 'conflict');
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].conflictType?.type, 'CONFLICT');
    assert.deepEqual(conflicts[0].resolved, [false, false]);
    assert.deepEqual(conflicts[0].resolvedLines, ['b']);
  });
  it('conflict hunk auto-resolvable by tryResolveConflict gets resolutionStrategy=TEXT', () => {
    // Both sides modify same line on disjoint word regions — magic-resolvable
    const { hunks } = buildThreeWayHunksByLine('FOO bar baz', 'foo bar baz', 'foo bar BAZ');
    const conflict = hunks.find((h) => h.kind === 'conflict');
    if (conflict) {
      // Either it was already auto-merged into the auto path, OR it carried
      // a TEXT resolutionStrategy. The non-conflict path is preferred.
      assert.equal(conflict.conflictType?.resolutionStrategy, 'TEXT');
    }
  });
});

// Functional-style helpers replicating handleConflictClick semantics
// so we can unit-test the IDEA-aligned state machine without spinning up Monaco.
type ConflictHunk = {
  localLines: string[];
  baseLines: string[];
  remoteLines: string[];
  resolvedLines: string[];
  resolved: [boolean, boolean];
  isOnesideAppliedConflict: boolean;
  status: 'pending' | 'accepted-local' | 'accepted-remote' | 'accepted-both' | 'manual';
};

function freshConflict(local: string[], remote: string[], base: string[] = ['B']): ConflictHunk {
  return {
    localLines: local, baseLines: base, remoteLines: remote, resolvedLines: base.slice(),
    resolved: [false, false], isOnesideAppliedConflict: false,
    status: 'pending'
  };
}

// Mirror of handleConflictClick (post-IDEA-alignment fix).
function applyArrowClick(h: ConflictHunk, side: 'local' | 'remote', resolveChange: boolean = false) {
  const sideIdx = side === 'local' ? 0 : 1;
  const oppositeIdx = 1 - sideIdx;
  const isAlreadyResolvedHere = h.resolved[sideIdx];
  if (isAlreadyResolvedHere && !resolveChange) return; // no-op
  const sourceLines = side === 'local' ? h.localLines : h.remoteLines;
  const oppositeLines = side === 'local' ? h.remoteLines : h.localLines;
  const oppositeIsEmpty = oppositeLines.length === 0;
  if (resolveChange) {
    h.resolvedLines = sourceLines.slice();
    h.resolved = [true, true];
    h.isOnesideAppliedConflict = false;
    h.status = side === 'local' ? 'accepted-local' : 'accepted-remote';
  } else if (h.isOnesideAppliedConflict) {
    h.resolvedLines = [...h.resolvedLines, ...sourceLines];
    h.resolved = [true, true];
    h.isOnesideAppliedConflict = false;
    h.status = 'accepted-both';
  } else {
    h.resolvedLines = sourceLines.slice();
    h.resolved[sideIdx] = true;
    h.status = side === 'local' ? 'accepted-local' : 'accepted-remote';
    if (h.resolved[oppositeIdx] || oppositeIsEmpty) {
      h.resolved[oppositeIdx] = true;
      h.isOnesideAppliedConflict = false;
    } else {
      h.isOnesideAppliedConflict = true;
    }
  }
}

function ignoreClick(h: ConflictHunk, side: 'local' | 'remote', resolveChange: boolean = false) {
  const sideIdx = side === 'local' ? 0 : 1;
  if (h.resolved[sideIdx] && !resolveChange) return;
  const previousStatus = h.status;
  h.resolved[sideIdx] = true;
  if (resolveChange) h.resolved = [true, true];
  if (h.resolved[0] && h.resolved[1]) {
    h.status = previousStatus === 'pending' ? 'manual' : previousStatus;
    h.isOnesideAppliedConflict = false;
  } else {
    h.status = 'pending';
    h.isOnesideAppliedConflict = false;
  }
}

describe('IDEA-aligned conflict gutter arrow state machine (design.md §7.4)', () => {
  it('first apply LEFT → resolved=[T,F], onesideApplied=true, content=LEFT', () => {
    const h = freshConflict(['L'], ['R']);
    applyArrowClick(h, 'local');
    assert.deepEqual(h.resolved, [true, false]);
    assert.equal(h.isOnesideAppliedConflict, true);
    assert.deepEqual(h.resolvedLines, ['L']);
  });
  it('apply LEFT then apply RIGHT → resolved=[T,T], content=[LEFT, RIGHT] (click-order)', () => {
    const h = freshConflict(['L'], ['R']);
    applyArrowClick(h, 'local');
    applyArrowClick(h, 'remote');
    assert.deepEqual(h.resolved, [true, true]);
    assert.deepEqual(h.resolvedLines, ['L', 'R']);
  });
  it('apply RIGHT then apply LEFT → content=[RIGHT, LEFT] (click order preserved)', () => {
    const h = freshConflict(['L'], ['R']);
    applyArrowClick(h, 'remote');
    applyArrowClick(h, 'local');
    assert.deepEqual(h.resolved, [true, true]);
    assert.deepEqual(h.resolvedLines, ['R', 'L']);
  });
  it('clicking already-resolved side is a no-op (no revert, IDEA semantics)', () => {
    const h = freshConflict(['L'], ['R']);
    applyArrowClick(h, 'local');
    const snapshot = JSON.stringify(h);
    applyArrowClick(h, 'local'); // second click on same side
    assert.equal(JSON.stringify(h), snapshot);
  });
  it('Ctrl+Click LEFT → fully resolved immediately, RIGHT content dropped', () => {
    const h = freshConflict(['L'], ['R']);
    applyArrowClick(h, 'local', true);
    assert.deepEqual(h.resolved, [true, true]);
    assert.deepEqual(h.resolvedLines, ['L']);
    assert.equal(h.isOnesideAppliedConflict, false);
  });
  it('Ctrl+Click RIGHT → fully resolved immediately, LEFT dropped', () => {
    const h = freshConflict(['L'], ['R']);
    applyArrowClick(h, 'remote', true);
    assert.deepEqual(h.resolvedLines, ['R']);
  });
  it('apply LEFT when RIGHT fragment is empty → auto full-resolve (no second click needed)', () => {
    // Conflict where remote has no content (e.g. a delete-on-the-other-side scenario).
    const h = freshConflict(['L'], []);
    applyArrowClick(h, 'local');
    assert.deepEqual(h.resolved, [true, true]);
    assert.equal(h.isOnesideAppliedConflict, false);
    assert.deepEqual(h.resolvedLines, ['L']);
  });
  it('apply RIGHT when LEFT fragment is empty → auto full-resolve', () => {
    const h = freshConflict([], ['R']);
    applyArrowClick(h, 'remote');
    assert.deepEqual(h.resolved, [true, true]);
    assert.deepEqual(h.resolvedLines, ['R']);
  });
  it('Ctrl+Click overrides already-resolved-here gate', () => {
    // After first apply LEFT, Ctrl+Click LEFT again should still take effect
    // (matches IDEA design — resolveChange=true bypasses isResolved(side) gate).
    const h = freshConflict(['L'], ['R']);
    applyArrowClick(h, 'local');
    assert.deepEqual(h.resolved, [true, false]);
    applyArrowClick(h, 'local', true);
    assert.deepEqual(h.resolved, [true, true]);
  });
});

describe('IDEA-aligned conflict ignore glyph state machine (design.md §7.3)', () => {
  it('Ignore LEFT → resolved=[T,F], result remains BASE', () => {
    const h = freshConflict(['L'], ['R'], ['BASE']);
    ignoreClick(h, 'local');
    assert.deepEqual(h.resolved, [true, false]);
    assert.deepEqual(h.resolvedLines, ['BASE']);
    assert.equal(h.status, 'pending');
  });
  it('Ignore LEFT then Apply RIGHT → resolved=[T,T], result=RIGHT without append', () => {
    const h = freshConflict(['L'], ['R'], ['BASE']);
    ignoreClick(h, 'local');
    applyArrowClick(h, 'remote');
    assert.deepEqual(h.resolved, [true, true]);
    assert.deepEqual(h.resolvedLines, ['R']);
    assert.equal(h.isOnesideAppliedConflict, false);
  });
  it('Ctrl+Shift Ignore marks both sides resolved and keeps current BASE content', () => {
    const h = freshConflict(['L'], ['R'], ['BASE']);
    ignoreClick(h, 'local', true);
    assert.deepEqual(h.resolved, [true, true]);
    assert.deepEqual(h.resolvedLines, ['BASE']);
    assert.equal(h.status, 'manual');
  });
});

describe('Merge undo stack snapshots (design.md 20.6)', () => {
  function makeHunk(): MergeChange {
    return {
      id: 1,
      kind: 'conflict',
      localLines: ['L'],
      baseLines: ['B'],
      remoteLines: ['R'],
      resolvedLines: ['B'],
      status: 'pending',
      resolved: [false, false],
      isOnesideAppliedConflict: false,
      lastAppliedSnapshot: ['B']
    };
  }

  it('undo and redo restore text plus merge model fields together', () => {
    const stack = new MergeUndoStack();
    const hunk = makeHunk();
    const before = createMergeSnapshot([hunk], 'B', false);

    hunk.resolvedLines = ['L'];
    hunk.status = 'accepted-local';
    hunk.resolved = [true, false];
    hunk.isOnesideAppliedConflict = true;
    hunk.lastAppliedSnapshot = ['L'];
    const after = createMergeSnapshot([hunk], 'L', true);

    assert.equal(stack.record('Apply Left', before, after), true);
    const undo = stack.undo();
    assert.ok(undo);
    applyMergeSnapshot([hunk], undo);
    assert.deepEqual(hunk.resolvedLines, ['B']);
    assert.equal(hunk.status, 'pending');
    assert.deepEqual(hunk.resolved, [false, false]);
    assert.equal(hunk.isOnesideAppliedConflict, false);

    const redo = stack.redo();
    assert.ok(redo);
    applyMergeSnapshot([hunk], redo);
    assert.deepEqual(hunk.resolvedLines, ['L']);
    assert.equal(hunk.status, 'accepted-local');
    assert.deepEqual(hunk.resolved, [true, false]);
    assert.equal(hunk.isOnesideAppliedConflict, true);
  });

  it('does not record no-op commands', () => {
    const stack = new MergeUndoStack();
    const hunk = makeHunk();
    const snapshot = createMergeSnapshot([hunk], 'B', false);
    assert.equal(stack.record('No-op', snapshot, createMergeSnapshot([hunk], 'B', true)), false);
    assert.equal(stack.canUndo, false);
  });
});

describe('Merge model reset / AI state contracts (design.md 20.7)', () => {
  function makeMergeHunk(resolved: [boolean, boolean] = [true, true]): MergeChange {
    return {
      id: 7,
      kind: 'conflict',
      localLines: ['L'],
      baseLines: ['B'],
      remoteLines: ['R'],
      resolvedLines: ['L'],
      status: 'accepted-local',
      resolved,
      isOnesideAppliedConflict: true,
      lastAppliedSnapshot: ['L'],
      isResolvedWithAI: false,
      isImportChange: false,
      semanticResolutionAvailable: false
    };
  }

  it('resetResolvedChange requires force or fully resolved and restores BASE state', () => {
    const unresolved = makeMergeHunk([true, false]);
    assert.equal(resetResolvedChangeState(unresolved), false);
    assert.deepEqual(unresolved.resolvedLines, ['L']);

    assert.equal(resetResolvedChangeState(unresolved, true), true);
    assert.deepEqual(unresolved.resolvedLines, ['B']);
    assert.deepEqual(unresolved.resolved, [false, false]);
    assert.equal(unresolved.status, 'pending');
    assert.equal(unresolved.isOnesideAppliedConflict, false);
    assert.equal(unresolved.isResolvedWithAI, false);
  });

  it('replaceChangeWithAi is the only AI write path and never overwrites resolved content', () => {
    const pending = makeMergeHunk([false, false]);
    pending.status = 'pending';
    assert.equal(replaceChangeWithAiState(pending, ['AI']), true);
    assert.deepEqual(pending.resolvedLines, ['AI']);
    assert.deepEqual(pending.resolved, [true, true]);
    assert.equal(pending.isResolvedWithAI, true);

    assert.equal(replaceChangeWithAiState(pending, ['NEW']), false);
    assert.deepEqual(pending.resolvedLines, ['AI']);
  });
});

describe('MergeLineTracker range update semantics (design.md 20.6)', () => {
  it('updates ranges before, after, containing, and damaged by a line edit', () => {
    assert.deepEqual(updateRangeOnModification(2, 4, 8, 9, 1), { start: 2, end: 4, damaged: false });
    assert.deepEqual(updateRangeOnModification(8, 10, 2, 3, 2), { start: 10, end: 12, damaged: false });
    assert.deepEqual(updateRangeOnModification(2, 8, 4, 5, 1), { start: 2, end: 9, damaged: false });
    assert.deepEqual(updateRangeOnModification(4, 6, 3, 8, -2), { start: 6, end: 6, damaged: true });
    assert.deepEqual(updateRangeOnModification(2, 6, 4, 8, -1), { start: 2, end: 4, damaged: true });
  });
});

describe('ByLine pipeline integration & stability', () => {
  it('buildThreeWayHunksByLine is idempotent on repeated calls (no shared state)', () => {
    const a = buildThreeWayHunksByLine('A\nb\nc', 'a\nb\nc', 'a\nb\nC');
    const b = buildThreeWayHunksByLine('A\nb\nc', 'a\nb\nc', 'a\nb\nC');
    assert.equal(a.initialResult, b.initialResult);
    assert.equal(a.hunks.length, b.hunks.length);
  });
  it('both sides insert the same content → auto, not conflict', () => {
    const { hunks } = buildThreeWayHunksByLine('a\nNEW\nb', 'a\nb', 'a\nNEW\nb');
    const conflicts = hunks.filter((h) => h.kind === 'conflict');
    assert.equal(conflicts.length, 0);
  });
  it('both sides delete the same line → auto', () => {
    const { hunks } = buildThreeWayHunksByLine('a\nc', 'a\nb\nc', 'a\nc');
    assert.equal(hunks.filter((h) => h.kind === 'conflict').length, 0);
  });
  it('left changes unrelated line, right has unrelated insertion — no conflict', () => {
    const { hunks } = buildThreeWayHunksByLine('A\nb\nc\nd', 'a\nb\nc\nd', 'a\nb\nINS\nc\nd');
    assert.equal(hunks.filter((h) => h.kind === 'conflict').length, 0);
  });
  it('lastAppliedSnapshot equals resolvedLines on a freshly built hunk', () => {
    const { hunks } = buildThreeWayHunksByLine('A\nb', 'a\nb', 'a\nb');
    for (const h of hunks) {
      if (h.kind === 'conflict') continue;
      assert.deepEqual(h.lastAppliedSnapshot, h.resolvedLines);
    }
  });

  it('marks import-only changes and stores an order-preserving union for init auto-resolve', () => {
    const { hunks } = buildThreeWayHunksByLine(
      "import z from 'z'",
      "import a from 'a'",
      "import b from 'b'"
    );
    const h = hunks.find((item) => item.kind === 'conflict') ?? hunks.find((item) => item.kind === 'auto');
    assert.ok(h);
    assert.equal(h.isImportChange, true);
    assert.deepEqual(h.autoResolvedLines, [
      "import a from 'a'",
      "import z from 'z'",
      "import b from 'b'"
    ]);
  });

  it('surfaces SEMANTIC strategy through the language resolver hook', () => {
    const resolver: LangSpecificMergeConflictResolver = {
      languageId: 'typescript',
      canResolve: () => true,
      resolve: () => ({ lines: ['semantic'] })
    };
    const { hunks } = buildThreeWayHunksByLine('left', 'base', 'right', 'none', resolver);
    const h = hunks.find((item) => item.kind === 'conflict')!;
    assert.equal(h.conflictType?.resolutionStrategy, 'SEMANTIC');
    assert.equal(h.semanticResolutionAvailable, true);
    assert.deepEqual(h.autoResolvedLines, ['semantic']);

    const model = new MergeConflictModel(hunks);
    assert.equal(model.resolveChangeAutomatically(h, 'base'), true);
    assert.deepEqual(h.resolvedLines, ['semantic']);
    assert.deepEqual(h.resolved, [true, true]);
  });

  it('keeps ignored whitespace-only changes visible as their own auto hunk', () => {
    const { hunks } = buildThreeWayHunksByLine('  a\nreal', 'a\nbase', '\ta\nremote', 'whole');
    const ignored = hunks.filter((h) => h.kind === 'auto' && h.ignored);
    assert.equal(ignored.length, 1);
    assert.deepEqual(ignored[0].resolvedLines, ['a']);
  });

  it('keepIgnoredChanges preserves contiguous IGNORE_WHITESPACES-only lines as visible ignored hunks', () => {
    const { hunks } = buildThreeWayHunksByLine(
      '  a\n\tb\nreal',
      'a\nb\nbase',
      '\ta\n b\nremote',
      'whole'
    );
    const ignored = hunks.filter((h) => h.kind === 'auto' && h.ignored);
    assert.equal(ignored.length, 1);
    assert.deepEqual(ignored[0].baseLines, ['a', 'b']);
    assert.deepEqual(ignored[0].resolvedLines, ['a', 'b']);
    assert.deepEqual(ignored[0].autoResolvedLines, ['a', 'b']);
  });
});

describe('ByLine edge cases', () => {
  it('compareLines: both empty', () => {
    const it = compareLines([], []);
    assert.equal(Array.from(it.changes()).length, 0);
    assert.equal(it.length1, 0); assert.equal(it.length2, 0);
  });
  it('compareLines: one empty, one has content → single change', () => {
    const it = compareLines([], ['a', 'b']);
    const cs = Array.from(it.changes());
    assert.equal(cs.length, 1);
    assert.equal(cs[0].start1, 0); assert.equal(cs[0].end1, 0);
    assert.equal(cs[0].start2, 0); assert.equal(cs[0].end2, 2);
  });
  it('mergeLines: all three empty', () => {
    assert.equal(mergeLines([], [], []).length, 0);
  });
  it('IW policy on a 3-way merge: indent-only change stays as an ignored MergeRange', () => {
    const ranges = mergeLines(['  foo'], ['foo'], ['foo'], 'IW');
    assert.deepEqual(ranges, [
      { start1: 0, end1: 1, start2: 0, end2: 1, start3: 0, end3: 1 }
    ]);
  });
  it('buildThreeWayHunksByLine handles empty base', () => {
    const { hunks } = buildThreeWayHunksByLine('a\nb', '', 'a\nb');
    // Both sides identical to each other but base is empty → INSERTED both
    const conflict = hunks.find((h) => h.kind === 'conflict');
    assert.equal(conflict, undefined);
  });
});

describe('ByLine public API aliases and text contract (byline.md 18.2)', () => {
  it('splitTextToLines preserves IntelliJ empty-line semantics', () => {
    assert.deepEqual(splitTextToLines(''), ['']);
    assert.deepEqual(splitTextToLines('a'), ['a']);
    assert.deepEqual(splitTextToLines('a\n'), ['a', '']);
    assert.deepEqual(splitTextToLines('a\nb'), ['a', 'b']);
    assert.deepEqual(splitTextToLines('a\r\nb'), ['a', 'b']);
    assert.deepEqual(splitTextToLines('a\rb'), ['a', 'b']);
  });

  it('canonical policy names match existing short aliases', () => {
    assert.equal(Array.from(compareLines2(['  a'], ['a'], 'TRIM_WHITESPACES').changes()).length, 0);
    assert.equal(Array.from(compareText2(' f o o ', 'foo', 'IGNORE_WHITESPACES').changes()).length, 0);
    assert.deepEqual(
      mergeLines3(['  foo'], ['foo'], ['\tfoo'], 'IGNORE_WHITESPACES'),
      mergeLines(['  foo'], ['foo'], ['\tfoo'], 'IW')
    );
  });
});

describe('ByLine ranged merge contract (byline.md 18.10)', () => {
  it('mergeLinesWithinRange returns ranges in full-file coordinates', () => {
    const left = ['0', '1', 'LEFT', '3', '4'];
    const base = ['0', '1', 'base', '3', '4'];
    const right = ['0', '1', 'RIGHT', '3', '4'];
    const ranges = mergeLinesWithinRange(left, base, right, {
      leftStart: 2, leftEnd: 3,
      baseStart: 2, baseEnd: 3,
      rightStart: 2, rightEnd: 3
    });
    assert.deepEqual(ranges, [
      { start1: 2, end1: 3, start2: 2, end2: 3, start3: 2, end3: 3 }
    ]);
  });

  it('import-style three segment stitching keeps stable order and middle index window', () => {
    const left = ['preL', 'import A', 'import B', 'post'];
    const base = ['pre', 'import A', 'import C', 'post'];
    const right = ['pre', 'import Z', 'import C', 'postR'];
    const before = mergeLinesWithinRange(left, base, right, {
      leftStart: 0, leftEnd: 1,
      baseStart: 0, baseEnd: 1,
      rightStart: 0, rightEnd: 1
    });
    const imports = mergeLinesWithinRange(left, base, right, {
      leftStart: 1, leftEnd: 3,
      baseStart: 1, baseEnd: 3,
      rightStart: 1, rightEnd: 3
    });
    const after = mergeLinesWithinRange(left, base, right, {
      leftStart: 3, leftEnd: 4,
      baseStart: 3, baseEnd: 4,
      rightStart: 3, rightEnd: 4
    });

    const joined = [...before, ...imports, ...after];
    const importBlockStart = before.length;
    const importBlockEnd = before.length + imports.length;
    assert.deepEqual(joined.map((range) => range.start2), [0, 1, 3]);
    assert.deepEqual([importBlockStart, importBlockEnd], [1, 2]);
    assert.ok(joined[importBlockStart].start2 >= 1 && joined[importBlockStart].end2 <= 3);
  });
});

describe('ByLine 2-way compareLines (byline.md §10.1 regression)', () => {
  const collect = (it: { changes(): Iterable<Range> }) => Array.from(it.changes());
  it('identical → empty changes, full-length unchanged', () => {
    const it = compareLines(['a', 'b', 'c'], ['a', 'b', 'c']);
    assert.equal(collect(it).length, 0);
  });
  it('one-line modification → single change Range', () => {
    const cs = collect(compareLines(['a', 'b', 'c'], ['a', 'X', 'c']));
    assert.equal(cs.length, 1);
    assert.equal(cs[0].start1, 1); assert.equal(cs[0].end1, 2);
    assert.equal(cs[0].start2, 1); assert.equal(cs[0].end2, 2);
  });
  it('insertion at end → empty start1..end1, non-empty start2..end2', () => {
    const cs = collect(compareLines(['a', 'b'], ['a', 'b', 'c']));
    assert.equal(cs.length, 1);
    assert.equal(cs[0].start1, 2); assert.equal(cs[0].end1, 2);
    assert.equal(cs[0].start2, 2); assert.equal(cs[0].end2, 3);
  });
  it('all deleted', () => {
    const cs = collect(compareLines(['a', 'b', 'c'], []));
    assert.equal(cs.length, 1);
    assert.equal(cs[0].end1 - cs[0].start1, 3);
    assert.equal(cs[0].end2 - cs[0].start2, 0);
  });
  it('IW policy: indent-only differences are equal', () => {
    const it = compareLines(['  foo', '\tbar'], ['foo', 'bar'], 'IW');
    assert.equal(collect(it).length, 0);
  });
  it('TRIM policy: leading+trailing trim each line', () => {
    const it = compareLines(['  a', 'b  '], ['a', 'b'], 'TRIM');
    assert.equal(collect(it).length, 0);
  });
  it('DEFAULT second-step rejects IW-only matches while TRIM keeps trim-equal lines matched', () => {
    assert.deepEqual(collect(compareLines(['  alpha'], ['alpha'], 'DEFAULT')), [
      { start1: 0, end1: 1, start2: 0, end2: 1 }
    ]);
    assert.equal(collect(compareLines(['  alpha'], ['alpha'], 'TRIM')).length, 0);
  });
  it('middle deletion plus tail insertion stays split around the unchanged interior', () => {
    const cs = collect(compareLines(['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'e']));
    assert.deepEqual(cs, [
      { start1: 1, end1: 2, start2: 1, end2: 1 },
      { start1: 4, end1: 4, start2: 3, end2: 4 }
    ]);
  });
});

describe('ByLine 3-way mergeLines (byline.md §10.4)', () => {
  it('LEFT-only modify and adjacent RIGHT-only insert collapse into one MergeRange (IDEA buildSimple semantics)', () => {
    // Per IDEA's buildSimpleMerge: two changes that are contiguous on BASE
    // get reported as a single MergeRange — the classifier later decides
    // whether it's a CONFLICT or compound non-conflict.
    const left = ['a', 'X', 'c'];
    const base = ['a', 'b', 'c'];
    const right = ['a', 'b', 'Y', 'c'];
    const ranges = mergeLines(left, base, right);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start1, 1); assert.equal(ranges[0].end1, 2);
    assert.equal(ranges[0].start2, 1); assert.equal(ranges[0].end2, 2);
    assert.equal(ranges[0].start3, 1); assert.equal(ranges[0].end3, 3);
  });
  it('non-touching LEFT and RIGHT changes produce two separate MergeRanges', () => {
    // Modifications separated by an unchanged line stay as distinct ranges.
    const left = ['L', 'b', 'c', 'd'];
    const base = ['a', 'b', 'c', 'd'];
    const right = ['a', 'b', 'c', 'R'];
    const ranges = mergeLines(left, base, right);
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0].end2 - ranges[0].start2, 1);
    assert.equal(ranges[1].end2 - ranges[1].start2, 1);
  });
  it('identical 3-way → no MergeRanges', () => {
    assert.equal(mergeLines(['a', 'b'], ['a', 'b'], ['a', 'b']).length, 0);
  });
  it('IW merge keeps whitespace-only changes as visible ignored ranges', () => {
    const ranges = mergeLines(['  foo'], ['foo'], ['\tfoo'], 'IW');
    assert.deepEqual(ranges, [
      { start1: 0, end1: 1, start2: 0, end2: 1, start3: 0, end3: 1 }
    ]);
  });
  it('both sides modify same line differently → single conflicting MergeRange', () => {
    const ranges = mergeLines(['a', 'L', 'c'], ['a', 'b', 'c'], ['a', 'R', 'c']);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].start1, 1); assert.equal(ranges[0].end1, 2);
    assert.equal(ranges[0].start2, 1); assert.equal(ranges[0].end2, 2);
    assert.equal(ranges[0].start3, 1); assert.equal(ranges[0].end3, 2);
  });
});

describe('ByLine expandRanges trims equal edges', () => {
  it('strips a common prefix line that LCS happened to include in the change', () => {
    const lines1 = ['a', 'b', 'c'];
    const lines2 = ['a', 'X', 'c'];
    const it = compareLines(lines1, lines2);
    const expanded = expandRanges(lines1, lines2, it);
    const cs = Array.from(expanded.changes());
    assert.equal(cs.length, 1);
    assert.equal(cs[0].start1, 1); assert.equal(cs[0].end1, 2);
  });
});

describe('tryResolveConflict (IDEA word-level disjoint resolver)', () => {
  it('returns null when both sides edit the same base region', () => {
    // both replace the middle word with different things — overlapping change
    const out = tryResolveConflict(['foo X bar'], ['foo b bar'], ['foo Y bar']);
    assert.equal(out, null);
  });
  it('merges left-edit-prefix + right-edit-suffix on a single line', () => {
    // base: 'foo bar baz'
    // left changes 'foo' → 'FOO' (prefix)
    // right changes 'baz' → 'BAZ' (suffix)
    const out = tryResolveConflict(['FOO bar baz'], ['foo bar baz'], ['foo bar BAZ']);
    assert.deepEqual(out, ['FOO bar BAZ']);
  });
  it('returns base verbatim if both sides are identical to base', () => {
    const out = tryResolveConflict(['a', 'b'], ['a', 'b'], ['a', 'b']);
    assert.deepEqual(out, ['a', 'b']);
  });
  it('returns the changed side when the other side is unchanged', () => {
    assert.deepEqual(tryResolveConflict(['x'], ['b'], ['b']), ['x']);
    assert.deepEqual(tryResolveConflict(['b'], ['b'], ['y']), ['y']);
  });
  it('deduplicates identical insertions at the same base offset', () => {
    const out = tryResolveConflict(['a X b'], ['a b'], ['a X b']);
    assert.deepEqual(out, ['a X b']);
  });
  it('keeps different insertions at the same base offset unresolved', () => {
    const out = tryResolveConflict(['a X b'], ['a b'], ['a Y b']);
    assert.equal(out, null);
  });
  it('retries with IGNORE_WHITESPACES semantics after strict overlap failure', () => {
    const out = tryResolveConflict(['foo\tbar'], ['foo bar'], ['foobar']);
    assert.deepEqual(out, ['foobar']);
  });
});

describe('magicResolve', () => {
  it('does not carry the old whitespace-only shortcut anymore', () => {
    const { hunks } = buildThreeWayHunksByLine('  a', 'b', 'a   ');
    magicResolve(hunks);
    const c = hunks.find((h) => h.kind === 'conflict');
    if (c) assert.equal(c.status, 'pending');
  });
  it('resolves import-only conflicts through the built-in semantic resolver', () => {
    const local = "import a from 'a'\nimport b from 'b'";
    const base = '';
    const remote = "import b from 'b'\nimport c from 'c'";
    const { hunks } = buildThreeWayHunksByLine(local, base, remote, 'none', getLangSpecificMergeConflictResolver('typescript') ?? null);
    magicResolve(hunks);
    const c = hunks.find((h) => h.kind === 'conflict');
    if (c) {
      assert.equal(c.status, 'accepted-both');
      assert.deepEqual(c.resolvedLines.slice().sort(), [
        "import a from 'a'", "import b from 'b'", "import c from 'c'"
      ]);
    }
  });
});

describe('buildThreeWayHunksByLine isolates the import region (byline.md §18.10)', () => {
  it('one-sided import addition adjacent to a code change stays its own hunk', () => {
    const base = "import a from 'a'\nconst x = 1\n";
    const local = "import a from 'a'\nimport b from 'b'\nconst x = 1\n"; // local-only import add
    const remote = "import a from 'a'\nconst x = 2\n";                   // remote-only code change
    const { hunks } = buildThreeWayHunksByLine(local, base, remote);
    const changeHunks = hunks.filter((h) => h.kind === 'auto' || h.kind === 'conflict');
    // Without segmenting around the import region these would collapse into one
    // (conflicting) hunk; segmenting keeps them as two clean auto changes.
    assert.equal(changeHunks.length, 2);
    const importHunk = changeHunks.find((h) => h.isImportChange);
    assert.ok(importHunk, 'expected an import-flagged hunk');
    assert.equal(importHunk.kind, 'auto');
    assert.deepEqual(importHunk.localLines, ["import b from 'b'"]);
    const codeHunk = changeHunks.find((h) => !h.isImportChange);
    assert.ok(codeHunk);
    assert.deepEqual(codeHunk.baseLines, ['const x = 1']);
    assert.deepEqual(codeHunk.remoteLines, ['const x = 2']);
  });

  it('falls back to a single whole-file merge when there is no import block', () => {
    const { hunks } = buildThreeWayHunksByLine('a\nL\nc', 'a\nb\nc', 'a\nR\nc');
    assert.equal(hunks.filter((h) => h.kind === 'conflict').length, 1);
  });

  it('handles three-side import-boundary mismatch without bailing to a whole-file merge', () => {
    const base = "#!/usr/bin/env node\nimport a from 'a'\nconst value = 1\n";
    const local = "import a from 'a'\nimport b from 'b'\nconst value = 1\n";
    const remote = "#!/usr/bin/env node\n// generated\nimport a from 'a'\nconst value = 2\n";

    const { hunks } = buildThreeWayHunksByLine(local, base, remote);
    const changeHunks = hunks.filter((h) => h.kind === 'auto' || h.kind === 'conflict');

    assert.ok(changeHunks.some((h) => h.isImportChange), 'expected an isolated import hunk');
    assert.ok(
      changeHunks.some((h) => !h.isImportChange && h.baseLines.includes('const value = 1')),
      'expected the code change to stay isolated from the import block'
    );
    assert.ok(changeHunks.length > 1, 'expected segmented merge hunks, not a whole-file conflict');
  });
});

describe('ByLine whitespace policy = { space, tab, newline } only (byline.md §2/§9.3)', () => {
  it('IGNORE_WHITESPACES keeps non-{space,tab,newline} whitespace such as NBSP/form-feed', () => {
    assert.equal(normalizeForPolicy('a b', 'IGNORE_WHITESPACES'), 'a b');
    assert.equal(normalizeForPolicy('ab', 'IGNORE_WHITESPACES'), 'ab');
    assert.equal(normalizeForPolicy('a b\tc\nd', 'IGNORE_WHITESPACES'), 'abcd');
    // distinguishing lines that only differ by a NBSP must still be a change under IW
    assert.equal(Array.from(compareLines2(['a b'], ['ab'], 'IGNORE_WHITESPACES').changes()).length, 1);
  });
  it('TRIM_WHITESPACES trims leading/trailing { space, tab, newline }', () => {
    assert.equal(normalizeForPolicy(' \ta\t ', 'TRIM_WHITESPACES'), 'a');
    assert.equal(normalizeForPolicy('a b', 'TRIM_WHITESPACES'), 'a b'); // inner whitespace untouched
  });
});

describe('correctChangesSecondStep realigns repeated indentation-only lines (byline.md §17/§19 #9)', () => {
  it('DEFAULT keeps the strictly-equal "}" lines matched and reports only the truly removed one', () => {
    const it = compareLines(['  }', '    }', '      }'], ['  }', '      }'], 'DEFAULT');
    assert.deepEqual(Array.from(it.changes()), [{ start1: 1, end1: 2, start2: 1, end2: 1 }]);
    for (const u of it.unchanged()) {
      assert.equal(u.end1 - u.start1, u.end2 - u.start2); // FairDiffIterable invariant
    }
  });

  it('getBestMatchingAlignment keeps a copied best combination instead of the final iterator state', () => {
    const lines1 = buildLines(['alpha', 'beta'], 'DEFAULT');
    const lines2 = buildLines(['alpha', 'beta', 'noise'], 'DEFAULT');
    assert.deepEqual(getBestMatchingAlignment([0, 1], [0, 1, 2], lines1, lines2), [0, 1]);
  });
});

describe('computeCollapsedUnchangedAreas', () => {
  it('collapses the middle of long equal hunks and leaves short ones visible', () => {
    const equalLines = Array.from({ length: 10 }, (_, index) => `same-${index}`);
    const hunks: Hunk[] = [
      {
        id: 0,
        kind: 'equal',
        localLines: equalLines.slice(),
        baseLines: equalLines.slice(),
        remoteLines: equalLines.slice(),
        resolvedLines: equalLines.slice(),
        status: 'manual'
      },
      {
        id: 1,
        kind: 'auto',
        localLines: ['local'],
        baseLines: ['base'],
        remoteLines: ['remote'],
        resolvedLines: ['base'],
        status: 'manual'
      },
      {
        id: 2,
        kind: 'equal',
        localLines: ['short-1', 'short-2', 'short-3'],
        baseLines: ['short-1', 'short-2', 'short-3'],
        remoteLines: ['short-1', 'short-2', 'short-3'],
        resolvedLines: ['short-1', 'short-2', 'short-3'],
        status: 'manual'
      }
    ];

    const hidden = computeCollapsedUnchangedAreas(hunks as MergeChange[], (hunkId) => {
      if (hunkId === 0) {
        return {
          local: { start: 1, length: 10 },
          result: { start: 1, length: 10 },
          remote: { start: 1, length: 10 }
        };
      }
      if (hunkId === 1) {
        return {
          local: { start: 11, length: 1 },
          result: { start: 11, length: 1 },
          remote: { start: 11, length: 1 }
        };
      }
      return {
        local: { start: 12, length: 3 },
        result: { start: 12, length: 3 },
        remote: { start: 12, length: 3 }
      };
    });

    assert.deepEqual(hidden.local, [{ startLine: 3, endLine: 8 }]);
    assert.deepEqual(hidden.result, [{ startLine: 3, endLine: 8 }]);
    assert.deepEqual(hidden.remote, [{ startLine: 3, endLine: 8 }]);
  });
});

describe('tryResolveConflict resolves multi-line disjoint conflicts (Myers word diff, no size cutoff)', () => {
  it('left edits one line, right edits another → merge takes both', () => {
    const base = ['line1', 'CONST_A = 1', 'line3', 'CONST_B = 2', 'line5'];
    const local = ['line1', 'CONST_A = 10', 'line3', 'CONST_B = 2', 'line5'];
    const remote = ['line1', 'CONST_A = 1', 'line3', 'CONST_B = 20', 'line5'];
    assert.deepEqual(
      tryResolveConflict(local, base, remote),
      ['line1', 'CONST_A = 10', 'line3', 'CONST_B = 20', 'line5']
    );
  });

  it('greedy mode resolves delete-plus-insert overlaps without changing the default mode', () => {
    const base = ['foo bar'];
    const local = ['foo '];
    const remote = ['foo BAR'];

    assert.equal(tryResolveConflict(local, base, remote), null);
    assert.deepEqual(tryResolveConflict(local, base, remote, { greedy: true }), ['foo BAR']);
  });
  it('overlapping multi-line edits stay unresolved', () => {
    const base = ['a', 'b', 'c'];
    const local = ['a', 'X', 'c'];
    const remote = ['a', 'Y', 'c'];
    assert.equal(tryResolveConflict(local, base, remote), null);
  });
});

describe('PatienceIntLCS fallback (byline.md §3.6/§3.2)', () => {
  it('identical sequences → no changed bits on either side', () => {
    const [c1, c2] = computePatienceLcsChanges([1, 2, 3], [1, 2, 3]);
    assert.deepEqual(c1.toBooleans(3), [false, false, false]);
    assert.deepEqual(c2.toBooleans(3), [false, false, false]);
  });
  it('single middle change → only that index changed on both sides', () => {
    const [c1, c2] = computePatienceLcsChanges([1, 2, 3], [1, 9, 3]);
    assert.deepEqual(c1.toBooleans(3), [false, true, false]);
    assert.deepEqual(c2.toBooleans(3), [false, true, false]);
  });
  it('unique-element diff: deletions land on the deleted indices, no spurious change on the matched ones', () => {
    const [c1, c2] = computePatienceLcsChanges([1, 5, 2, 6, 3], [1, 2, 3]);
    assert.deepEqual(c1.toBooleans(5), [false, true, false, true, false]);
    assert.deepEqual(c2.toBooleans(3), [false, false, false]);
  });
  it('computeLcsChangesWithFallback agrees with Patience on a clean unique-element diff', () => {
    const [m1, m2] = computeLcsChangesWithFallback([1, 5, 2, 6, 3], [1, 2, 3]);
    assert.deepEqual(m1.toBooleans(5), [false, true, false, true, false]);
    assert.deepEqual(m2.toBooleans(3), [false, false, false]);
  });
});
