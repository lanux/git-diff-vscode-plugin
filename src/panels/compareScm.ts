import * as vscode from 'vscode';
import * as path from 'path';
import type { FileChange } from '../types';

const OPEN_COMPARE_FILE_COMMAND = 'gitCompare.openCompareFile';

export interface CompareScmSnapshot {
  repoRoot: string;
  scopeLabel: string;
  current: string;
  target: string;
  files: FileChange[];
  onSelect: (filePath: string) => void;
}

export class CompareScmProvider implements vscode.Disposable {
  private sourceControl: vscode.SourceControl | undefined;
  private group: vscode.SourceControlResourceGroup | undefined;
  private rootPath: string | undefined;
  private activeOwner: object | undefined;
  private onSelect: ((filePath: string) => void) | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(vscode.commands.registerCommand(OPEN_COMPARE_FILE_COMMAND, (filePath: unknown) => {
      if (typeof filePath === 'string') {
        this.onSelect?.(filePath);
      }
    }));
  }

  update(owner: object, snapshot: CompareScmSnapshot) {
    this.ensureSourceControl(snapshot.repoRoot);
    if (!this.sourceControl || !this.group) return;

    this.activeOwner = owner;
    this.onSelect = snapshot.onSelect;
    this.sourceControl.count = snapshot.files.length;
    this.sourceControl.inputBox.placeholder = `${snapshot.scopeLabel}: ${snapshot.current} <-> ${snapshot.target}`;
    this.group.label = 'COMPARE';
    this.group.resourceStates = snapshot.files
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => this.toResourceState(snapshot.repoRoot, file));
  }

  clear(owner?: object) {
    if (owner && this.activeOwner !== owner) return;
    if (this.sourceControl) {
      this.sourceControl.count = 0;
    }
    if (this.group) {
      this.group.resourceStates = [];
    }
    this.activeOwner = undefined;
    this.onSelect = undefined;
  }

  dispose() {
    for (const disposable of this.disposables) disposable.dispose();
    this.sourceControl?.dispose();
  }

  private ensureSourceControl(repoRoot: string) {
    if (this.sourceControl && this.group && this.rootPath === repoRoot) return;

    this.sourceControl?.dispose();
    this.rootPath = repoRoot;
    this.sourceControl = vscode.scm.createSourceControl('gitCompare', 'Git Compare', vscode.Uri.file(repoRoot));
    this.sourceControl.inputBox.visible = false;
    this.sourceControl.count = 0;
    this.group = this.sourceControl.createResourceGroup('compare', 'COMPARE');
    this.group.hideWhenEmpty = true;
    this.group.contextValue = 'gitCompare.compare';
  }

  private toResourceState(repoRoot: string, file: FileChange): vscode.SourceControlResourceState {
    return {
      resourceUri: vscode.Uri.file(path.join(repoRoot, file.path)),
      command: {
        command: OPEN_COMPARE_FILE_COMMAND,
        title: 'Open Compare File',
        arguments: [file.path]
      },
      contextValue: `gitCompare.${file.status}`,
      decorations: {
        iconPath: iconForStatus(file.status),
        strikeThrough: file.status === 'D',
        faded: file.status === 'D',
        tooltip: tooltipForFile(file)
      }
    };
  }
}

function iconForStatus(status: FileChange['status']): vscode.ThemeIcon {
  switch (status) {
    case 'A': return new vscode.ThemeIcon('diff-added');
    case 'D': return new vscode.ThemeIcon('diff-removed');
    case 'R': return new vscode.ThemeIcon('diff-renamed');
    case 'M':
    default: return new vscode.ThemeIcon('diff-modified');
  }
}

function tooltipForFile(file: FileChange): string {
  const status = statusLabel(file.status);
  const rename = file.oldPath ? `\nRenamed from: ${file.oldPath}` : '';
  const stats = file.binary
    ? '\nBinary file'
    : file.additions !== undefined || file.deletions !== undefined
      ? `\n+${file.additions ?? 0} -${file.deletions ?? 0}`
      : '';
  return `${status}: ${file.path}${rename}${stats}`;
}

function statusLabel(status: FileChange['status']): string {
  switch (status) {
    case 'A': return 'Added';
    case 'D': return 'Deleted';
    case 'R': return 'Renamed';
    case 'M':
    default: return 'Modified';
  }
}
