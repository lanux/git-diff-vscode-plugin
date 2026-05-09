import { countNonSpaceChars, hashForPolicy, linesEqual, normalizeForPolicy, toInternalPolicy } from './policy';
import type { ComparisonPolicy, InternalComparisonPolicy } from './types';

export class Line {
    readonly key: string;
    readonly hash: number;
    readonly nonSpaceChars: number;
    readonly policy: InternalComparisonPolicy;

    constructor(
        public readonly content: string,
        policy: ComparisonPolicy
    ) {
        this.policy = toInternalPolicy(policy);
        this.key = normalizeForPolicy(content, this.policy);
        this.hash = hashForPolicy(content, this.policy);
        this.nonSpaceChars = countNonSpaceChars(content);
    }

    equals(other: Line): boolean {
        if (this.policy !== other.policy) return false;
        if (this.hash !== other.hash) return false;
        return this.key === other.key || linesEqual(this.content, other.content, this.policy);
    }
}

export function buildLines(lines: readonly string[], policy: ComparisonPolicy): Line[] {
    return lines.map((line) => new Line(line, policy));
}
