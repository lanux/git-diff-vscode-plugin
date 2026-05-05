import { git } from './exec';
import * as path from 'path';

export interface ThreeVersions {
  base: string;
  local: string;
  remote: string;
  repoRoot: string;
  relPath: string;
}

async function showStage(repoRoot: string, relPath: string, stage: 1 | 2 | 3): Promise<string> {
  try {
    return await git(repoRoot, ['show', `:${stage}:${relPath}`]);
  } catch {
    return '';
  }
}

export async function extractThreeVersions(filePath: string, repoRoot: string): Promise<ThreeVersions> {
  const relPath = path.relative(repoRoot, filePath).split(path.sep).join('/');
  const [base, local, remote] = await Promise.all([
    showStage(repoRoot, relPath, 1),
    showStage(repoRoot, relPath, 2),
    showStage(repoRoot, relPath, 3)
  ]);
  return { base, local, remote, repoRoot, relPath };
}

export async function showAtRef(repoRoot: string, ref: string, relPath: string): Promise<string> {
  try {
    return await git(repoRoot, ['show', `${ref}:${relPath}`]);
  } catch {
    return '';
  }
}

export async function gitAdd(repoRoot: string, relPath: string): Promise<void> {
  await git(repoRoot, ['add', '--', relPath]);
}
