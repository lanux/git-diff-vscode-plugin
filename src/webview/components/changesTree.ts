import type { FileChange } from '../../types';
import { escapeHtml } from './toolbar';

export interface TreeNode {
  name: string; path: string;
  kind: 'dir' | 'file';
  children?: Map<string, TreeNode>;
  file?: FileChange;
}

export function buildTree(files: FileChange[]): TreeNode {
  const root: TreeNode = { name: '', path: '', kind: 'dir', children: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const isLeaf = i === parts.length - 1;
      let child = node.children!.get(p);
      if (!child) {
        child = isLeaf
          ? { name: p, path: f.path, kind: 'file', file: f }
          : { name: p, path: parts.slice(0, i + 1).join('/'), kind: 'dir', children: new Map() };
        node.children!.set(p, child);
      }
      node = child;
    }
  }
  collapseSingleChainDirs(root);
  return root;
}

export function collapseSingleChainDirs(node: TreeNode) {
  if (node.kind !== 'dir' || !node.children) return;
  for (const [, c] of node.children) collapseSingleChainDirs(c);
  let cur = node;
  while (cur.kind === 'dir' && cur.children && cur.children.size === 1) {
    const only = [...cur.children.values()][0];
    if (only.kind !== 'dir') break;
    cur.name = cur.name ? `${cur.name}/${only.name}` : only.name;
    cur.path = only.path;
    cur.children = only.children;
  }
}

export function renderTree(
  container: HTMLElement,
  files: FileChange[],
  onSelect: (path: string) => void,
  mode: 'dir' | 'flat' = 'dir'
) {
  container.innerHTML = '';
  if (mode === 'flat') {
    const sorted = files.slice().sort((a, b) => a.path.localeCompare(b.path));
    for (const f of sorted) renderFlatRow(f, container, onSelect);
    return;
  }
  const root = buildTree(files);
  renderTreeNode(root, container, 0, onSelect);
}

function renderFlatRow(f: FileChange, parent: HTMLElement, onSelect: (path: string) => void) {
  const row = document.createElement('div');
  row.className = 'tree-row tree-file status-' + f.status;
  row.style.paddingLeft = `4px`;
  const statusLetter = f.status;
  let counts = '';
  if (f.binary) counts = '<span class="counts binary">bin</span>';
  else if (f.additions !== undefined || f.deletions !== undefined) {
    const a = f.additions ?? 0, d = f.deletions ?? 0;
    counts = `<span class="counts"><span class="adds">+${a}</span> <span class="dels">-${d}</span></span>`;
  }
  row.innerHTML = `<span class="status-icon">${statusLetter}</span><span class="codicon codicon-file icon"></span><span class="label">${escapeHtml(f.path)}</span>${counts}`;
  row.onclick = () => onSelect(f.path);
  row.dataset.path = f.path;
  parent.appendChild(row);
}

export function renderTreeNode(node: TreeNode, parent: HTMLElement, depth: number, onSelect: (path: string) => void) {
  if (node.kind === 'dir') {
    if (node.name) {
      const row = document.createElement('div');
      row.className = 'tree-row tree-dir';
      row.style.paddingLeft = `${depth * 16 + 4}px`;
      row.innerHTML = `<span class="codicon codicon-chevron-down caret"></span><span class="codicon codicon-folder icon"></span><span class="label">${escapeHtml(node.name)}</span>`;
      parent.appendChild(row);
    }
    if (node.children) {
      const sorted = [...node.children.values()].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const c of sorted) renderTreeNode(c, parent, node.name ? depth + 1 : depth, onSelect);
    }
  } else {
    const f = node.file!;
    const row = document.createElement('div');
    row.className = 'tree-row tree-file status-' + f.status;
    row.style.paddingLeft = `${depth * 16 + 4}px`;
    const statusLetter = f.status;
    let counts = '';
    if (f.binary) counts = '<span class="counts binary">bin</span>';
    else if (f.additions !== undefined || f.deletions !== undefined) {
      const a = f.additions ?? 0, d = f.deletions ?? 0;
      counts = `<span class="counts"><span class="adds">+${a}</span> <span class="dels">-${d}</span></span>`;
    }
    row.innerHTML = `<span class="status-icon">${statusLetter}</span><span class="codicon codicon-file icon"></span><span class="label">${escapeHtml(node.name)}</span>${f.oldPath ? `<span class="rename"> (${escapeHtml(f.oldPath)})</span>` : ''}${counts}`;
    row.onclick = () => onSelect(f.path);
    row.dataset.path = f.path;
    parent.appendChild(row);
  }
}
