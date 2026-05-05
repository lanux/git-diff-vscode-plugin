export type IgnoreWhitespace = 'none' | 'trim' | 'inner' | 'whole';

export function normalizeLine(line: string, mode: IgnoreWhitespace): string {
  switch (mode) {
    case 'none': return line;
    case 'trim': return line.replace(/[ \t]+$/, '');                  // trailing
    case 'inner': return line.replace(/[ \t]+/g, ' ').trim();         // collapse runs
    case 'whole': return line.replace(/[\s]+/g, '');                  // strip all
  }
}
