import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const pexec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: 100 * 1024 * 1024 });
  return stdout;
}

export async function gitBuf(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await pexec('git', args, { cwd, encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 });
  return stdout as Buffer;
}

export async function getRepoRoot(fileOrDir: string): Promise<string> {
  const stat = await fs.promises.stat(fileOrDir).catch(() => undefined);
  const cwd = stat?.isDirectory() ? fileOrDir : path.dirname(fileOrDir);
  const out = await git(cwd, ['rev-parse', '--show-toplevel']);
  return out.trim();
}
