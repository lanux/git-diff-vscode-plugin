import * as vscode from 'vscode';
import { MergePanel } from './panels/mergePanel';
import { BranchComparePanel } from './panels/branchComparePanel';
import { CompareScmProvider } from './panels/compareScm';

const CONFLICT_RE = /^(<{7}|={7}|>{7})/m;

export function activate(context: vscode.ExtensionContext) {
  const compareScm = new CompareScmProvider();
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
    compareScm,
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
      const uri = await resolveCompareScopeUri(arg);
      if (!uri) { vscode.window.showErrorMessage('Git Compare: no workspace, folder, or file selected.'); return; }
      try { await BranchComparePanel.open(context, uri, compareScm); }
      catch (e: unknown) { vscode.window.showErrorMessage(`Git Compare: ${(e as Error).message ?? e}`); }
    }),
    vscode.commands.registerCommand('gitCompare.compareProject', async () => {
      const uri = await resolveWorkspaceUri();
      if (!uri) { vscode.window.showErrorMessage('Git Compare: no workspace folder selected.'); return; }
      try { await BranchComparePanel.open(context, uri, compareScm); }
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

async function resolveCompareScopeUri(arg: unknown): Promise<vscode.Uri | undefined> {
  const explicit = resolveExplicitUri(arg);
  if (explicit) return explicit;
  return await resolveWorkspaceUri() ?? vscode.window.activeTextEditor?.document.uri;
}

function resolveExplicitUri(arg: unknown): vscode.Uri | undefined {
  if (!arg) return undefined;
  if (arg instanceof vscode.Uri) return arg;
  const a = arg as { resourceUri?: vscode.Uri; fsPath?: string };
  if (a.resourceUri instanceof vscode.Uri) return a.resourceUri;
  if (typeof a.fsPath === 'string') return vscode.Uri.file(a.fsPath);
  return undefined;
}

async function resolveWorkspaceUri(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return undefined;

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri?.scheme === 'file') {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (activeFolder) return activeFolder.uri;
  }

  if (folders.length === 1) return folders[0].uri;

  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder
    })),
    { placeHolder: 'Select workspace folder to compare' }
  );
  return picked?.folder.uri;
}
