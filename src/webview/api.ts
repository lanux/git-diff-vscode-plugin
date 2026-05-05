import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(): Worker {
    const blob = new Blob(['self.onmessage=()=>{};'], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  }
};

export const vscode = acquireVsCodeApi();
export { monaco };

export function getVsCodeTheme(): string {
  const cls = document.body.className;
  if (cls.includes('vscode-high-contrast-light')) return 'hc-light';
  if (cls.includes('vscode-high-contrast')) return 'hc-black';
  if (cls.includes('vscode-dark')) return 'vs-dark';
  return 'vs';
}
