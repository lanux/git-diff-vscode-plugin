import { git } from './exec';

export interface BranchRef {
  name: string;
  kind: 'local' | 'remote' | 'tag';
  isHead?: boolean;
}

export async function listRefs(repoRoot: string): Promise<BranchRef[]> {
  const out = await git(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)\t%(refname)\t%(HEAD)',
    'refs/heads', 'refs/remotes', 'refs/tags'
  ]);
  const refs: BranchRef[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [shortName, fullName, head] = line.split('\t');
    let kind: BranchRef['kind'] = 'local';
    if (fullName.startsWith('refs/remotes')) kind = 'remote';
    else if (fullName.startsWith('refs/tags')) kind = 'tag';
    refs.push({ name: shortName, kind, isHead: head === '*' });
  }
  return refs;
}

export async function currentBranchName(repoRoot: string): Promise<string> {
  try {
    const out = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return out.trim();
  } catch {
    return 'HEAD';
  }
}
