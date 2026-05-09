export type InternalComparisonPolicy = 'DEFAULT' | 'TRIM' | 'IW';
export type ComparisonPolicy =
  | InternalComparisonPolicy
  | 'TRIM_WHITESPACES'
  | 'IGNORE_WHITESPACES';

export interface Range {
  start1: number;
  end1: number;
  start2: number;
  end2: number;
}

export interface MergeRange {
  start1: number;
  end1: number;
  start2: number;
  end2: number;
  start3: number;
  end3: number;
}

export interface DiffIterable {
  readonly length1: number;
  readonly length2: number;
  changes(): Iterable<Range>;
  unchanged(): Iterable<Range>;
}

export interface FairDiffIterable extends DiffIterable {}

export interface LCSBuilder {
  addEqual(count: number): void;
  addChange(count1: number, count2: number): void;
}

export interface Change {
  line0: number;
  line1: number;
  deleted: number;
  inserted: number;
  link: Change | null;
}

export class FilesTooBigForDiffError extends Error {
  constructor(message = 'Files too big for diff') {
    super(message);
    this.name = 'FilesTooBigForDiffError';
  }
}
