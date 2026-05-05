import { git } from './exec';
import * as path from 'path';
import { FileChange } from '../types';

/**
 * Run `git diff --name-status -z --find-renames <fromRef>...<toRef> -- <relDir>`.
 * Defaults `toRef` to HEAD for "compare with branch" behavior.
 */
export async function diffNameStatus(
  repoRoot: string,
  fromRef: string,
  scopeRelPath?: string,
  toRef: string = 'HEAD'
): Promise<FileChange[]> {
  const args = ['diff', '--name-status', '-z', '--find-renames', `${fromRef}...${toRef}`];
  if (scopeRelPath && scopeRelPath !== '.') {
    args.push('--', scopeRelPath);
  }
  const raw = await git(repoRoot, args);
  return parseNameStatusZ(raw);
}

export function parseNameStatusZ(raw: string): FileChange[] {
  const out: FileChange[] = [];
  const tokens = raw.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i];
    if (!code) { i++; continue; }
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath !== undefined && newPath !== undefined) {
        out.push({ path: newPath, oldPath, status: 'R' });
      }
      i += 3;
    } else if (letter === 'A' || letter === 'M' || letter === 'D' || letter === 'T') {
      const filePath = tokens[i + 1];
      if (filePath !== undefined) {
        const status = (letter === 'T' ? 'M' : letter) as 'A' | 'M' | 'D';
        out.push({ path: filePath, status });
      }
      i += 2;
    } else {
      i++;
    }
  }
  return out;
}

export function relScope(repoRoot: string, fsPath: string): string {
  const r = path.relative(repoRoot, fsPath).split(path.sep).join('/');
  return r === '' ? '.' : r;
}

/**
 * Run `git diff --numstat -z <target>...HEAD -- <scope>` to get +/- line counts
 * per file. Binary files come back as `-\t-\tpath`, encoded as additions=null.
 */
export interface NumStat { path: string; additions: number | null; deletions: number | null; }

export async function diffNumStat(
  repoRoot: string,
  fromRef: string,
  scopeRelPath?: string,
  toRef: string = 'HEAD'
): Promise<Map<string, NumStat>> {
  const args = ['diff', '--numstat', '-z', `${fromRef}...${toRef}`];
  if (scopeRelPath && scopeRelPath !== '.') args.push('--', scopeRelPath);
  const raw = await git(repoRoot, args);
  const out = new Map<string, NumStat>();
  // numstat -z encodes:  "<add>\t<del>\t<path>\0"
  // for renames:         "<add>\t<del>\t\0<oldPath>\0<newPath>\0"
  const tokens = raw.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) { i++; continue; }
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(t);
    if (!m) { i++; continue; }
    const [, addS, delS, rest] = m;
    const additions = addS === '-' ? null : parseInt(addS, 10);
    const deletions = delS === '-' ? null : parseInt(delS, 10);
    let pathStr = rest;
    if (rest === '') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      pathStr = newPath ?? oldPath ?? '';
      i += 3;
    } else {
      i += 1;
    }
    if (pathStr) out.set(pathStr, { path: pathStr, additions, deletions });
  }
  return out;
}

