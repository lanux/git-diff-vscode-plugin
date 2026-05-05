import * as vscode from 'vscode';
import { MergePanel } from './panels/mergePanel';
import { BranchComparePanel } from './panels/branchComparePanel';

const CONFLICT_RE = /^(<{7}|={7}|>{7})/m;

export function activate(context: vscode.ExtensionContext) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  status.text = '$(git-merge) Git Diff Fast';
  status.tooltip = 'Open this conflicted file in the three-way merge tool';
  status.command = 'gitDiff.openMergeTool';
  status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

  const refreshStatus = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') { status.hide(); return; }
    const text = editor.document.getText();
    if (CONFLICT_RE.test(text)) status.show();
    else status.hide();
  };

  context.subscriptions.push(
    status,
    vscode.window.onDidChangeActiveTextEditor(refreshStatus),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) refreshStatus();
    }),
    vscode.workspace.onDidOpenTextDocument(refreshStatus),
    vscode.workspace.onDidCloseTextDocument(refreshStatus),
    vscode.commands.registerCommand('gitDiff.openMergeTool', async (arg?: unknown) => {
      const uri = resolveUri(arg);
      if (!uri) { vscode.window.showErrorMessage('Git Diff Fast: no file selected.'); return; }
      try { await MergePanel.open(context, uri); }
      catch (e: unknown) { vscode.window.showErrorMessage(`Git Diff Fast: ${(e as Error).message ?? e}`); }
    }),
    vscode.commands.registerCommand('gitCompare.compare', async (arg?: unknown) => {
      const uri = resolveUri(arg) ?? vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!uri) { vscode.window.showErrorMessage('Git Compare: no folder/file selected.'); return; }
      try { await BranchComparePanel.open(context, uri); }
      catch (e: unknown) { vscode.window.showErrorMessage(`Git Compare: ${(e as Error).message ?? e}`); }
    })
  );

  refreshStatus();
}

export function deactivate() {}

function resolveUri(arg: unknown): vscode.Uri | undefined {
  if (!arg) return vscode.window.activeTextEditor?.document.uri;
  if (arg instanceof vscode.Uri) return arg;
  const a = arg as { resourceUri?: vscode.Uri; fsPath?: string };
  if (a.resourceUri instanceof vscode.Uri) return a.resourceUri;
  if (typeof a.fsPath === 'string') return vscode.Uri.file(a.fsPath);
  return undefined;
}
