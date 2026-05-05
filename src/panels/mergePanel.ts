import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { extractThreeVersions, gitAdd } from '../git/show';
import { getRepoRoot } from '../git/exec';
import { buildThreeWayHunks, hasConflictMarkers } from '../diff/threeWay';
import { detectLanguage } from './language';
import { renderShell } from './htmlShell';
import type { ExtToWebview, WebviewToExt } from '../types';

export class MergePanel {
  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly fileUri: vscode.Uri,
    private readonly repoRoot: string,
    private readonly relPath: string
  ) {
    panel.webview.onDidReceiveMessage((msg: WebviewToExt) => this.handle(msg));
  }

  static async open(context: vscode.ExtensionContext, fileUri: vscode.Uri) {
    const repoRoot = await getRepoRoot(fileUri.fsPath);
    const versions = await extractThreeVersions(fileUri.fsPath, repoRoot);
    if (!versions.base && !versions.local && !versions.remote) {
      vscode.window.showErrorMessage(`Git Diff Fast: ${versions.relPath} is not in a merge conflict.`);
      return undefined;
    }
    const { hunks } = buildThreeWayHunks(versions.local, versions.base, versions.remote);

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

    const mp = new MergePanel(panel, fileUri, versions.repoRoot, versions.relPath);

    await waitForReady(panel);

    const init: ExtToWebview = {
      type: 'init',
      view: 'merge',
      filePath: fileUri.fsPath,
      language: detectLanguage(fileUri.fsPath),
      local: versions.local,
      base: versions.base,
      remote: versions.remote,
      hunks
    };
    panel.webview.postMessage(init);
    return mp;
  }

  private async handle(msg: WebviewToExt) {
    if (msg.type === 'saveMerge') {
      if (hasConflictMarkers(msg.content)) {
        vscode.window.showErrorMessage('Result still contains conflict markers.');
        return;
      }
      try {
        await fs.promises.writeFile(this.fileUri.fsPath, msg.content, 'utf8');
        await gitAdd(this.repoRoot, this.relPath);
        vscode.window.showInformationMessage(`Merged and staged: ${this.relPath}`);
        this.panel.dispose();
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Save failed: ${(e as Error).message ?? e}`);
      }
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
      // 'Cancel' or undefined = do nothing, stay open
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
