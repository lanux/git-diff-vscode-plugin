import type { ComparisonPolicy, InternalComparisonPolicy } from './types';

export function toInternalPolicy(policy: ComparisonPolicy): InternalComparisonPolicy {
    switch (policy) {
        case 'DEFAULT':
        case 'TRIM':
        case 'IW':
            return policy;
        case 'TRIM_WHITESPACES':
            return 'TRIM';
        case 'IGNORE_WHITESPACES':
            return 'IW';
    }
}

// IntelliJ's "whitespace" for ByLine policies is exactly { ' ', '\t', '\n' }
// (byline.md §2, §9.3). A line is normally a single line (no '\n') after the
// text→lines split, so the '\n' only matters if a raw line slips through, but we
// keep it exact for 1:1 parity with ComparisonUtil.hashCode / isEqualTexts.
const TRIM_RE = /^[ \t\n]+|[ \t\n]+$/g;
const IW_RE = /[ \t\n]/g;

export function normalizeForPolicy(line: string, policy: ComparisonPolicy): string {
    switch (toInternalPolicy(policy)) {
        case 'DEFAULT':
            return line;
        case 'TRIM':
            return line.replace(TRIM_RE, '');
        case 'IW':
            return line.replace(IW_RE, '');
    }
}

export function linesEqual(left: string, right: string, policy: ComparisonPolicy): boolean {
    return normalizeForPolicy(left, policy) === normalizeForPolicy(right, policy);
}

export function hashForPolicy(line: string, policy: ComparisonPolicy): number {
    return javaStringHash(normalizeForPolicy(line, policy));
}

export function countNonSpaceChars(line: string): number {
    let count = 0;
    for (const char of line) {
        if (!isWhitespace(char)) count++;
    }
    return count;
}

function javaStringHash(text: string): number {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash * 31) + text.charCodeAt(i)) | 0;
    }
    return hash;
}

function isWhitespace(char: string): boolean {
    // IntelliJ's nonSpaceChars counter (byline.md §2) skips exactly ' ', '\t', '\n'.
    return char === ' ' || char === '\t' || char === '\n';
}
