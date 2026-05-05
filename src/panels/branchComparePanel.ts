import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { renderShell } from './htmlShell';
import { detectLanguage } from './language';
import { waitForReady } from './mergePanel';
import { getRepoRoot } from '../git/exec';
import { listRefs, currentBranchName } from '../git/branches';
import { diffNameStatus, diffNumStat, relScope } from '../git/nameStatus';
import { showAtRef } from '../git/show';
import { buildTwoWayHunks } from '../diff/twoWay';
import type { IgnoreWhitespace } from '../diff/whitespace';
import type { ExtToWebview, FileChange, WebviewToExt } from '../types';

const RECENT_KEY = 'gitCompare.recentRefs';

export class BranchComparePanel {
  private files: FileChange[] = [];

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    private readonly repoRoot: string,
    private readonly scopeRel: string,
    private target: string,
    private current: string,
    private reversed = false
  ) {
    panel.webview.onDidReceiveMessage((msg: WebviewToExt) => this.handle(msg));
  }

  static async open(context: vscode.ExtensionContext, scopeUri: vscode.Uri) {
    const repoRoot = await getRepoRoot(scopeUri.fsPath);
    const target = await pickBranch(context, repoRoot);
    if (!target) return;

    const scopeRel = relScope(repoRoot, scopeUri.fsPath);
    const current = await currentBranchName(repoRoot);
    const [files, numstat] = await Promise.all([
      diffNameStatus(repoRoot, target, scopeRel),
      diffNumStat(repoRoot, target, scopeRel).catch(() => new Map())
    ]);
    for (const f of files) {
      const ns = numstat.get(f.path);
      if (ns) {
        f.additions = ns.additions ?? undefined;
        f.deletions = ns.deletions ?? undefined;
        if (ns.additions === null && ns.deletions === null) f.binary = true;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      'gitCompare',
      `Compare: ${path.basename(scopeUri.fsPath) || repoRoot} ⇄ ${target}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')]
      }
    );
    panel.webview.html = renderShell(panel.webview, context.extensionUri);

    const inst = new BranchComparePanel(context, panel, repoRoot, scopeRel, target, current);
    inst.files = files;

    await waitForReady(panel);

    const init: ExtToWebview = {
      type: 'init', view: 'compare',
      rootPath: scopeUri.fsPath,
      current, target,
      files
    };
    panel.webview.postMessage(init);
    return inst;
  }

  private async handle(msg: WebviewToExt) {
    if (msg.type === 'requestFileDiff') {
      const file = this.files.find((f) => f.path === msg.path);
      if (!file) return;
      try {
        if (file.binary) {
          const reply: ExtToWebview = {
            type: 'fileDiff',
            path: file.path,
            language: 'plaintext',
            currentText: '',
            targetText: '',
            status: file.status,
            hunks: [],
            editable: false,
            binary: true
          };
          this.panel.webview.postMessage(reply);
          return;
        }
        const targetText = await showAtRef(this.repoRoot, this.target, file.oldPath ?? file.path);
        const absPath = path.join(this.repoRoot, file.path);
        let currentText = '';
        if (file.status !== 'D' && fs.existsSync(absPath)) {
          currentText = await fs.promises.readFile(absPath, 'utf8');
        }
        const ignoreWS: IgnoreWhitespace = msg.ignoreWS ?? 'none';
        const hunks = buildTwoWayHunks(currentText, targetText, ignoreWS);
        // HEAD baseline of the current side, for true Revert
        let baselineText = '';
        try { baselineText = await showAtRef(this.repoRoot, 'HEAD', file.path); } catch { /* untracked */ }
        const reply: ExtToWebview = {
          type: 'fileDiff',
          path: file.path,
          language: detectLanguage(file.path),
          currentText, targetText, baselineText,
          status: file.status, hunks,
          editable: file.status !== 'D'
        };
        this.panel.webview.postMessage(reply);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Diff failed: ${(e as Error).message ?? e}`);
      }
    } else if (msg.type === 'saveFileEdit') {
      const abs = path.join(this.repoRoot, msg.path);
      try {
        await fs.promises.writeFile(abs, msg.content, 'utf8');
        vscode.window.showInformationMessage(`Saved: ${msg.path}`);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Save failed: ${(e as Error).message ?? e}`);
      }
    } else if (msg.type === 'cancel') {
      this.panel.dispose();
    } else if (msg.type === 'refreshCompare') {
      await this.refresh();
    } else if (msg.type === 'reverseCompare') {
      await this.reverse();
    }
  }

  private async refresh() {
    const [from, to] = this.reversed ? ['HEAD', this.current] : [this.target, 'HEAD'];
    const [files, numstat] = await Promise.all([
      diffNameStatus(this.repoRoot, from, this.scopeRel, to),
      diffNumStat(this.repoRoot, from, this.scopeRel, to).catch(() => new Map())
    ]);
    for (const f of files) {
      const ns = numstat.get(f.path);
      if (ns) {
        f.additions = ns.additions ?? undefined;
        f.deletions = ns.deletions ?? undefined;
        if (ns.additions === null && ns.deletions === null) f.binary = true;
      }
    }
    this.files = files;
    this.panel.webview.postMessage({
      type: 'init', view: 'compare',
      rootPath: path.join(this.repoRoot, this.scopeRel === '.' ? '' : this.scopeRel),
      current: this.current, target: this.target, files
    } as ExtToWebview);
  }

  private async reverse() {
    this.reversed = !this.reversed;
    [this.current, this.target] = [this.target, this.current];
    await this.refresh();
  }
}

async function pickBranch(context: vscode.ExtensionContext, repoRoot: string): Promise<string | undefined> {
  const refs = await listRefs(repoRoot);
  const recent: string[] = context.globalState.get<string[]>(RECENT_KEY, []);

  type Item = vscode.QuickPickItem & { ref?: string; freeText?: boolean };
  const items: Item[] = [];
  if (recent.length) {
    items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
    for (const r of recent) {
      const found = refs.find((x) => x.name === r);
      if (found) items.push({ label: found.name, description: found.kind, ref: found.name });
    }
  }
  items.push({ label: 'Branches & Tags', kind: vscode.QuickPickItemKind.Separator });
  for (const r of refs) {
    if (r.isHead) continue;
    items.push({ label: r.name, description: r.kind, ref: r.name });
  }

  return await new Promise<string | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Compare with';
    qp.placeholder = 'Select branch / tag, or type any commit-ish (sha, HEAD~3, …) and press Enter';
    qp.matchOnDescription = true;
    qp.items = items;
    let typed = '';
    qp.onDidChangeValue((v) => {
      typed = v;
      if (v && !refs.find((r) => r.name === v)) {
        const dyn: Item[] = [{ label: `Use \"${v}\"`, description: 'commit-ish', ref: v, freeText: true }];
        qp.items = [...dyn, ...items];
      } else {
        qp.items = items;
      }
    });
    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0];
      qp.hide();
      const ref = picked?.ref ?? (typed ? typed : undefined);
      if (!ref) { resolve(undefined); return; }
      const newRecent = [ref, ...recent.filter((x) => x !== ref)].slice(0, 5);
      context.globalState.update(RECENT_KEY, newRecent);
      resolve(ref);
    });
    qp.onDidHide(() => { qp.dispose(); resolve(undefined); });
    qp.show();
  });
}
