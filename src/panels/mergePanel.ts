import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { extractThreeVersions, type ThreeVersions, gitAdd } from '../git/show';
import { getRepoRoot } from '../git/exec';
import { listConflictedFiles } from '../git/conflicts';
import { hasConflictMarkers, parseConflictMarkers } from '../diff/conflictMarkers';
import { buildThreeWayHunksByLine } from '../diff/threeWayByLine';
import { getLangSpecificMergeConflictResolver } from '../diff/langSpecificMergeConflictResolver';
import { detectLanguage } from './language';
import { renderShell } from './htmlShell';
import type {
  FinishMergeMessage,
  InitMergeMessage,
  MergeAdditionalActionDescriptor,
  RunAdditionalMergeActionMessage,
  WebviewToExt
} from '../types';
import type { IgnoreWhitespace } from '../diff/whitespace';

interface MergeInputs extends ThreeVersions {
  source: 'git-stages' | 'conflict-markers';
}

export class MergePanel {
  private files: string[] = [];   // repo-relative
  private fileIndex = 0;
  private repoRoot = '';
  private ignoreWS: IgnoreWhitespace = 'none';
  private autoApplyNonConflicts = true;
  private autoResolveImports = true;
  private autoScrollEnabled = true;
  private additionalActions: MergeAdditionalActionDescriptor[] = [];
  private finishing = false;

  private constructor(private readonly panel: vscode.WebviewPanel) {
    panel.webview.onDidReceiveMessage((msg: WebviewToExt) => this.handle(msg));
    panel.onDidDispose(() => { this.finishing = true; });
  }

  private get currentRel(): string { return this.files[this.fileIndex] ?? ''; }

  static async open(context: vscode.ExtensionContext, fileUri: vscode.Uri) {
    const repoRoot = await getRepoRoot(fileUri.fsPath);
    const versions = await resolveMergeInputs(fileUri.fsPath, repoRoot);
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
    mp.autoApplyNonConflicts = vscode.workspace
      .getConfiguration()
      .get<boolean>('gitDiff.merge.autoApplyNonConflicts', true);
    mp.autoResolveImports = vscode.workspace
      .getConfiguration()
      .get<boolean>('gitDiff.merge.autoResolveImports', true);
    mp.autoScrollEnabled = vscode.workspace
      .getConfiguration()
      .get<boolean>('gitDiff.merge.autoScroll', true);
    mp.additionalActions = readAdditionalMergeActions();

    await waitForReady(panel);
    await mp.postInit(versions.local, versions.base, versions.remote);
    return mp;
  }

  private async postInit(local: string, base: string, remote: string) {
    const fsPath = path.join(this.repoRoot, this.currentRel);
    const language = detectLanguage(fsPath);
    const { hunks } = buildThreeWayHunksByLine(
      local,
      base,
      remote,
      this.ignoreWS,
      getLangSpecificMergeConflictResolver(language) ?? null
    );
    this.panel.title = `Merge: ${path.basename(fsPath)}`;
    const init: InitMergeMessage = {
      type: 'init',
      view: 'merge',
      filePath: fsPath,
      language,
      local, base, remote, hunks,
      files: this.files,
      fileIndex: this.fileIndex,
      ignoreWS: this.ignoreWS,
      autoApplyNonConflicts: this.autoApplyNonConflicts,
      autoResolveImports: this.autoResolveImports,
      autoScrollEnabled: this.autoScrollEnabled,
      additionalActions: this.additionalActions
    };
    this.panel.webview.postMessage(init);
  }

  private async loadFileAt(index: number) {
    if (index < 0 || index >= this.files.length) return;
    const fsPath = path.join(this.repoRoot, this.files[index]);
    try {
      const versions = await resolveMergeInputs(fsPath, this.repoRoot);
      this.fileIndex = index;
      this.finishing = false;
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
    if (msg.type === 'finishMerge') {
      await this.finishMerge(msg);
    } else if (msg.type === 'saveMerge') {
      await this.finishMerge({ type: 'finishMerge', result: 'RESOLVED', outputText: msg.content });
    } else if (msg.type === 'acceptRevision') {
      await this.finishMerge({
        type: 'finishMerge',
        result: msg.side === 'local' ? 'LEFT' : 'RIGHT',
        dirty: msg.dirty
      });
    } else if (msg.type === 'cancel') {
      await this.finishMerge({ type: 'finishMerge', result: 'CANCEL' });
    } else if (msg.type === 'setMergeIgnoreWS') {
      await this.setIgnoreWhitespace(msg.ignoreWS, msg.dirty);
    } else if (msg.type === 'switchMergeFile') {
      await this.switchMergeFile(msg.direction, msg.dirty);
    } else if (msg.type === 'runAdditionalMergeAction') {
      await this.runAdditionalMergeAction(msg);
    }
  }

  private async runAdditionalMergeAction(msg: RunAdditionalMergeActionMessage): Promise<void> {
    const action = this.additionalActions.find((item) => item.id === msg.actionId);
    if (!action) return;
    await vscode.commands.executeCommand(action.command, {
      filePath: msg.filePath,
      repoRoot: this.repoRoot,
      relativePath: this.currentRel,
      language: msg.language,
      pane: msg.pane,
      ignoreWS: msg.ignoreWS,
      selectedHunkIds: msg.selectedHunkIds,
      currentHunkId: msg.currentHunkId
    });
  }

  private async finishMerge(msg: FinishMergeMessage): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;

    if (msg.result === 'CANCEL') {
      await this.finishCancel(Boolean(msg.dirty));
      return;
    }

    if (msg.result === 'LEFT' || msg.result === 'RIGHT') {
      await this.finishRevision(msg.result, Boolean(msg.dirty));
      return;
    }

    if (msg.outputText === undefined) {
      this.finishing = false;
      vscode.window.showErrorMessage('Merge result text was not provided.');
      return;
    }

    if (msg.unresolvedCount && msg.unresolvedCount > 0) {
      const n = msg.unresolvedCount;
      const choice = await vscode.window.showWarningMessage(
        `${n} unresolved conflict${n === 1 ? '' : 's'} in ${this.currentRel} will be left as-is. Save anyway?`,
        { modal: true },
        'Save'
      );
      if (choice !== 'Save') { this.finishing = false; return; }
    }

    try {
      const savedRel = this.currentRel;
      if (!(await this.saveCurrent(msg.outputText))) { this.finishing = false; return; }
      vscode.window.showInformationMessage(`Merged and staged: ${savedRel}`);
      await this.advanceAfterFinish();
    } catch (e: unknown) {
      this.finishing = false;
      vscode.window.showErrorMessage(`Save failed: ${(e as Error).message ?? e}`);
    }
  }

  private async finishCancel(dirty: boolean): Promise<void> {
    if (!dirty) {
      this.panel.dispose();
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      'You have unsaved merge changes.',
      'Apply Changes', 'Abandon Changes', 'Cancel'
    );
    if (choice === 'Apply Changes') {
      this.finishing = false;
      this.panel.webview.postMessage({ type: 'requestResult' });
    } else if (choice === 'Abandon Changes') {
      this.panel.dispose();
    } else {
      this.finishing = false;
    }
  }

  private async finishRevision(result: 'LEFT' | 'RIGHT', dirty: boolean): Promise<void> {
    const sideName = result === 'LEFT' ? 'Local (Yours)' : 'Remote (Theirs)';
    const dirtyMsg = dirty ? '\nYour edits will be discarded.' : '';
    const choice = await vscode.window.showWarningMessage(
      `Accept ${sideName} version for ${this.currentRel}?${dirtyMsg}`,
      { modal: true },
      'Accept'
    );
    if (choice !== 'Accept') {
      this.finishing = false;
      return;
    }

    try {
      const fsPath = path.join(this.repoRoot, this.currentRel);
      const versions = await resolveMergeInputs(fsPath, this.repoRoot);
      const content = result === 'LEFT' ? versions.local : versions.remote;
      const savedRel = this.currentRel;
      if (!(await this.saveCurrent(content))) { this.finishing = false; return; }
      vscode.window.showInformationMessage(`Accepted ${sideName} for ${savedRel}.`);
      await this.advanceAfterFinish();
    } catch (e: unknown) {
      this.finishing = false;
      vscode.window.showErrorMessage(`Accept ${sideName} failed: ${(e as Error).message ?? e}`);
    }
  }

  private async advanceAfterFinish(): Promise<void> {
    const remaining = await listConflictedFiles(this.repoRoot).catch(() => [] as string[]);
    if (!remaining.length) {
      this.panel.dispose();
      return;
    }

    const prevNext = this.files[this.fileIndex + 1];
    const nextIdx = prevNext ? Math.max(0, remaining.indexOf(prevNext)) : 0;
    this.files = remaining;
    await this.loadFileAt(nextIdx);
  }

  private async setIgnoreWhitespace(ignoreWS: IgnoreWhitespace, dirty: boolean): Promise<void> {
    if (ignoreWS === this.ignoreWS) return;
    if (dirty) {
      const choice = await vscode.window.showWarningMessage(
        `Changing whitespace mode will discard your edits to ${this.currentRel}.`,
        { modal: true },
        'Discard'
      );
      if (choice !== 'Discard') {
        await this.loadFileAt(this.fileIndex);
        return;
      }
    }
    this.ignoreWS = ignoreWS;
    await this.loadFileAt(this.fileIndex);
  }

  private async switchMergeFile(direction: 1 | -1, dirty: boolean): Promise<void> {
    const target = this.fileIndex + direction;
    if (target < 0 || target >= this.files.length) return;
    if (dirty) {
      const choice = await vscode.window.showWarningMessage(
        `Discard unsaved edits to ${this.currentRel}?`,
        { modal: true },
        'Discard'
      );
      if (choice !== 'Discard') return;
    }
    await this.loadFileAt(target);
  }
}

export function waitForReady(panel: vscode.WebviewPanel): Promise<void> {
  return new Promise((resolve) => {
    const sub = panel.webview.onDidReceiveMessage((m: WebviewToExt) => {
      if (m.type === 'ready') { sub.dispose(); resolve(); }
    });
  });
}

async function resolveMergeInputs(filePath: string, repoRoot: string): Promise<MergeInputs> {
  const versions = await extractThreeVersions(filePath, repoRoot);
  if (versions.base || versions.local || versions.remote) {
    return { ...versions, source: 'git-stages' };
  }

  const output = await fs.promises.readFile(filePath, 'utf8').catch(() => '');
  const parsed = parseConflictMarkers(output);
  if (!parsed) {
    return { ...versions, source: 'git-stages' };
  }

  return {
    ...versions,
    local: parsed.local,
    base: parsed.base,
    remote: parsed.remote,
    source: 'conflict-markers'
  };
}

function readAdditionalMergeActions(): MergeAdditionalActionDescriptor[] {
  const raw = vscode.workspace
    .getConfiguration()
    .get<unknown[]>('gitDiff.merge.additionalActions', []);
  if (!Array.isArray(raw)) return [];

  const actions: MergeAdditionalActionDescriptor[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || typeof candidate.label !== 'string' || typeof candidate.command !== 'string') continue;
    const pane = candidate.pane;
    actions.push({
      id: candidate.id,
      label: candidate.label,
      command: candidate.command,
      pane: pane === 'local' || pane === 'result' || pane === 'remote' || pane === 'all' ? pane : 'result',
      contextMenuGroupId: typeof candidate.contextMenuGroupId === 'string' ? candidate.contextMenuGroupId : undefined,
      contextMenuOrder: typeof candidate.contextMenuOrder === 'number' ? candidate.contextMenuOrder : undefined,
    });
  }
  return actions;
}
