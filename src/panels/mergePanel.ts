import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { extractThreeVersions, gitAdd } from '../git/show';
import { getRepoRoot } from '../git/exec';
import { listConflictedFiles } from '../git/conflicts';
import { buildThreeWayHunks, hasConflictMarkers } from '../diff/threeWay';
import { detectLanguage } from './language';
import { renderShell } from './htmlShell';
import type { WebviewToExt, InitMergeMessage } from '../types';
import type { IgnoreWhitespace } from '../diff/whitespace';

export class MergePanel {
  private files: string[] = [];   // repo-relative
  private fileIndex = 0;
  private repoRoot = '';
  private ignoreWS: IgnoreWhitespace = 'none';

  private constructor(private readonly panel: vscode.WebviewPanel) {
    panel.webview.onDidReceiveMessage((msg: WebviewToExt) => this.handle(msg));
  }

  private get currentRel(): string { return this.files[this.fileIndex] ?? ''; }

  static async open(context: vscode.ExtensionContext, fileUri: vscode.Uri) {
    const repoRoot = await getRepoRoot(fileUri.fsPath);
    const versions = await extractThreeVersions(fileUri.fsPath, repoRoot);
    if (!versions.base && !versions.local && !versions.remote) {
      vscode.window.showErrorMessage(`Git Diff Fast: ${versions.relPath} is not in a merge conflict.`);
      return undefined;
    }

    const allConflicts = await listConflictedFiles(repoRoot).catch(() => [] as string[]);
    const files = allConflicts.length ? allConflicts : [versions.relPath];
    const idx = files.indexOf(versions.relPath);
    const fileIndex = idx >= 0 ? idx : 0;

    const panel = vscode.window.createWebviewPanel(
      'gitDiff',
      `Merge: ${path.basename(fileUri.fsPath)}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')]
      }
    );
    panel.webview.html = renderShell(panel.webview, context.extensionUri);

    const mp = new MergePanel(panel);
    mp.repoRoot = repoRoot;
    mp.files = files;
    mp.fileIndex = fileIndex;

    await waitForReady(panel);
    await mp.postInit(versions.local, versions.base, versions.remote);
    return mp;
  }

  private async postInit(local: string, base: string, remote: string) {
    const { hunks } = buildThreeWayHunks(local, base, remote, this.ignoreWS);
    const fsPath = path.join(this.repoRoot, this.currentRel);
    this.panel.title = `Merge: ${path.basename(fsPath)}`;
    const init: InitMergeMessage = {
      type: 'init',
      view: 'merge',
      filePath: fsPath,
      language: detectLanguage(fsPath),
      local, base, remote, hunks,
      files: this.files,
      fileIndex: this.fileIndex,
      ignoreWS: this.ignoreWS
    };
    this.panel.webview.postMessage(init);
  }

  private async loadFileAt(index: number) {
    if (index < 0 || index >= this.files.length) return;
    const fsPath = path.join(this.repoRoot, this.files[index]);
    try {
      const versions = await extractThreeVersions(fsPath, this.repoRoot);
      this.fileIndex = index;
      await this.postInit(versions.local, versions.base, versions.remote);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Failed to load ${this.files[index]}: ${(e as Error).message ?? e}`);
    }
  }

  private async saveCurrent(content: string): Promise<boolean> {
    if (hasConflictMarkers(content)) {
      vscode.window.showErrorMessage('Result still contains conflict markers.');
      return false;
    }
    const fsPath = path.join(this.repoRoot, this.currentRel);
    await fs.promises.writeFile(fsPath, content, 'utf8');
    await gitAdd(this.repoRoot, this.currentRel);
    return true;
  }

  private async handle(msg: WebviewToExt) {
    if (msg.type === 'saveMerge') {
      try {
        const savedRel = this.currentRel;
        if (!(await this.saveCurrent(msg.content))) return;
        vscode.window.showInformationMessage(`Merged and staged: ${savedRel}`);
        // Refresh the conflict list and advance to the next remaining file.
        // Prefer the file that was at fileIndex+1 before the save (i.e. the natural "next").
        const remaining = await listConflictedFiles(this.repoRoot).catch(() => [] as string[]);
        if (!remaining.length) { this.panel.dispose(); return; }
        const prevNext = this.files[this.fileIndex + 1];
        const nextIdx = prevNext ? Math.max(0, remaining.indexOf(prevNext)) : 0;
        this.files = remaining;
        await this.loadFileAt(nextIdx);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Save failed: ${(e as Error).message ?? e}`);
      }
    } else if (msg.type === 'setMergeIgnoreWS') {
      if (msg.ignoreWS === this.ignoreWS) return;
      if (msg.dirty) {
        const choice = await vscode.window.showWarningMessage(
          `Changing whitespace mode will discard your edits to ${this.currentRel}.`,
          { modal: true },
          'Discard'
        );
        if (choice !== 'Discard') {
          // Bounce the user's selection back by re-posting current init
          await this.loadFileAt(this.fileIndex);
          return;
        }
      }
      this.ignoreWS = msg.ignoreWS;
      await this.loadFileAt(this.fileIndex);
    } else if (msg.type === 'switchMergeFile') {
      const target = this.fileIndex + msg.direction;
      if (target < 0 || target >= this.files.length) return;
      if (msg.dirty) {
        const choice = await vscode.window.showWarningMessage(
          `Discard unsaved edits to ${this.currentRel}?`,
          { modal: true },
          'Discard'
        );
        if (choice !== 'Discard') return;
      }
      await this.loadFileAt(target);
    } else if (msg.type === 'cancel') {
      this.panel.dispose();
    } else if (msg.type === 'cancelCheck') {
      const choice = await vscode.window.showWarningMessage(
        'You have unsaved merge changes.',
        'Apply Changes', 'Abandon Changes', 'Cancel'
      );
      if (choice === 'Apply Changes') {
        this.panel.webview.postMessage({ type: 'requestResult' });
      } else if (choice === 'Abandon Changes') {
        this.panel.dispose();
      }
    }
  }
}

export function waitForReady(panel: vscode.WebviewPanel): Promise<void> {
  return new Promise((resolve) => {
    const sub = panel.webview.onDidReceiveMessage((m: WebviewToExt) => {
      if (m.type === 'ready') { sub.dispose(); resolve(); }
    });
  });
}
