export type IgnoreWhitespace = 'none' | 'trim' | 'inner' | 'whole';

// Mirrors IDEA's ComparisonPolicy normalization (see byline.md §9.3):
//   none  ≈ DEFAULT
//   trim  ≈ TRIM_WHITESPACES          — per-line strip of leading + trailing whitespace
//   inner ≈ (helper) collapse runs    — VSCode-side convenience, not in IDEA
//   whole ≈ IGNORE_WHITESPACES        — strip all whitespace
export function normalizeLine(line: string, mode: IgnoreWhitespace): string {
  switch (mode) {
    case 'none': return line;
    case 'trim': return line.replace(/^[ \t]+|[ \t]+$/g, '');         // per-line trim (leading + trailing)
    case 'inner': return line.replace(/[ \t]+/g, ' ').trim();         // collapse runs
    case 'whole': return line.replace(/[\s]+/g, '');                  // strip all
  }
}
