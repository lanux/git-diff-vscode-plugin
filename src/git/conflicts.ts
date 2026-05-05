import { git } from './exec';

export async function listConflictedFiles(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return out.split('\0').filter((s) => s.length > 0);
}
