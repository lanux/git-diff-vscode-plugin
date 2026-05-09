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

export function normalizeForPolicy(line: string, policy: ComparisonPolicy): string {
    switch (toInternalPolicy(policy)) {
        case 'DEFAULT':
            return line;
        case 'TRIM':
            return line.replace(/^[ \t]+|[ \t]+$/g, '');
        case 'IW':
            return line.replace(/[\s]+/g, '');
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
    return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}
